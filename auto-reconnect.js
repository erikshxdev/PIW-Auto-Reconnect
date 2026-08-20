(() => {
  'use strict';

  // PIW Auto Reconnect — only the reconnect mechanism.
  // Recovery flow follows PIW-QOL 10.1.0, with a deliberate 2-minute hunt timeout.

  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;
  const trackedSockets = new WeakSet();

  const CONFIG = Object.freeze({
    huntSilenceMs: 120_000,
    reentryDelayMs: 500,
    reconnectCooldownMs: 5_000,
    socketReloadDelayMs: 45_000,
    reloadRecoveryDelayMs: 1_500,
    confirmationTimeoutMs: 15_000,
    checkIntervalMs: 1_000,
    stateKey: 'piw_auto_reconnect_state_v10',
    positionKey: 'piw_auto_reconnect_position_v1',
    overlayId: 'piw-auto-reconnect-overlay'
  });

  const HUNT_MESSAGE_TYPES = new Set([
    'field',
    'field-init',
    'field-kill',
    'poke-xp',
    'pending',
    'catch-result'
  ]);

  const STRONG_CONFIRM_TYPES = new Set([
    'field-kill',
    'poke-xp',
    'catch-result'
  ]);

  let gameSocket = null;
  let currentHuntSlug = null;
  let lastHuntSocketActivityAt = Date.now();
  let lastCaptureBarSignature = '';
  let lastAutoReconnectAt = 0;
  let autoReconnectInProgress = false;
  let autoReconnectWasInHunt = false;
  let socketDownSince = 0;
  let reloadScheduled = false;
  let reloadRecoveryPending = false;
  let reloadRecoveryAttempted = false;
  let awaitingConfirmation = false;
  let confirmationDeadline = 0;
  let reconnectCount = 0;

  let overlay = null;
  let dragState = null;

  function now() {
    return Date.now();
  }

  function log(message, warning = false) {
    const prefix = '[PIW Auto Reconnect]';
    (warning ? console.warn : console.info)(prefix, message);
  }

  function readState() {
    try {
      return JSON.parse(sessionStorage.getItem(CONFIG.stateKey) || '{}');
    } catch {
      return {};
    }
  }

  function saveState(extra = {}) {
    try {
      sessionStorage.setItem(CONFIG.stateKey, JSON.stringify({
        slug: currentHuntSlug,
        reconnectCount,
        updatedAt: now(),
        ...extra
      }));
    } catch (error) {
      log(`Falha ao salvar estado: ${error}`, true);
    }
  }

  function restoreState() {
    const state = readState();
    if (typeof state.slug === 'string' && state.slug.trim()) {
      currentHuntSlug = state.slug.trim();
    }
    if (Number.isFinite(state.reconnectCount)) {
      reconnectCount = Math.max(0, state.reconnectCount);
    }
    reloadRecoveryPending = state.reconnectPending === true;
    autoReconnectWasInHunt = state.reconnectPending === true && Boolean(currentHuntSlug);
  }

  function getPosition() {
    try {
      const value = JSON.parse(localStorage.getItem(CONFIG.positionKey) || '{}');
      if (Number.isFinite(value.left) && Number.isFinite(value.top)) return value;
    } catch {}
    return null;
  }

  function savePosition(left, top) {
    try {
      localStorage.setItem(CONFIG.positionKey, JSON.stringify({ left, top }));
    } catch {}
  }

  function isSocketOpen() {
    return Boolean(gameSocket && gameSocket.readyState === NativeWebSocket.OPEN);
  }

  // Primary Hunt selectors match PIW-QOL. The remembered slug is used as a fallback
  // during reconnect/reload before the game's Hunt UI has rendered again.
  function isInHuntContext() {
    if (document.querySelector('[data-guide="capture-bar"], .hunt-ui, .battle-window, .wild-pokemon')) {
      return true;
    }

    if (currentHuntSlug && autoReconnectWasInHunt) {
      const analyzer = document.querySelector('.ha-window:not(.ha-compare-modal)');
      return Boolean(analyzer) || Boolean(reloadRecoveryPending);
    }

    return false;
  }

  function getCaptureBarSignature() {
    return document.querySelector('[data-guide="capture-bar"]')?.innerHTML || '';
  }

  function isHuntProgressMessage(message) {
    const type = String(message?.type || '').toLowerCase();
    if (!type) return false;
    if (/chat|family|friend|ranking|pong|ping|inventory|pokes-get/.test(type)) return false;
    if (/exp|xp|defeat|kill|loot|drop|capture|catch|damage|attack/.test(type)) return true;

    try {
      const payload = JSON.stringify(message).toLowerCase();
      return /"(?:expgained|xpgain|xp|experience|defeated|killed|damage|loot|drops?|reward)"\s*:\s*(?:[1-9]\d*|true|\[|\{)/.test(payload);
    } catch {
      return false;
    }
  }

  function isHuntSocketMessage(message) {
    return HUNT_MESSAGE_TYPES.has(String(message?.type || '').toLowerCase()) || isHuntProgressMessage(message);
  }

  function observeIncoming(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (isHuntSocketMessage(message)) {
      lastHuntSocketActivityAt = now();
    }

    if (
      awaitingConfirmation &&
      now() <= confirmationDeadline &&
      STRONG_CONFIRM_TYPES.has(String(message?.type || '').toLowerCase())
    ) {
      confirmReconnect();
    }
  }

  function observeOutgoing(socket, data) {
    if (!socket || !String(socket.url || '').includes('/ws') || typeof data !== 'string') return;

    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }

    const type = String(message?.type || '').toLowerCase();

    if (type === 'enter-hunt' && message.slug) {
      currentHuntSlug = String(message.slug).trim();
      autoReconnectWasInHunt = true;
      lastHuntSocketActivityAt = now();
      socketDownSince = 0;
      reloadRecoveryPending = false;
      saveState({ reconnectPending: false });
      return;
    }

    if (type === 'leave-hunt' && !autoReconnectInProgress) {
      autoReconnectWasInHunt = false;
      saveState({ reconnectPending: false });
    }
  }

  function trackSocket(socket) {
    if (!socket || !String(socket.url || '').includes('/ws')) return socket;

    gameSocket = socket;

    if (trackedSockets.has(socket)) {
      renderOverlay();
      return socket;
    }

    trackedSockets.add(socket);
    socketDownSince = 0;
    reloadScheduled = false;

    socket.addEventListener('message', observeIncoming);

    socket.addEventListener('open', () => {
      if (gameSocket !== socket) return;
      socketDownSince = 0;
      renderOverlay();

      if (reloadRecoveryPending && !reloadRecoveryAttempted) {
        void recoverAfterReload(socket);
      }
    });

    socket.addEventListener('close', () => {
      if (gameSocket !== socket) return;
      gameSocket = null;
      socketDownSince = now();
      renderOverlay();
      log('WebSocket do jogo caiu.', true);
    });

    socket.addEventListener('error', () => {
      if (gameSocket === socket) renderOverlay();
    });

    if (
      socket.readyState === NativeWebSocket.OPEN &&
      reloadRecoveryPending &&
      !reloadRecoveryAttempted
    ) {
      void recoverAfterReload(socket);
    }

    renderOverlay();
    return socket;
  }

  function TrackedWebSocket(url, protocols) {
    const socket = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);
    return trackSocket(socket);
  }

  TrackedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket);
  window.WebSocket = TrackedWebSocket;

  // Same mechanism PIW-QOL uses to observe the game's enter-hunt message.
  NativeWebSocket.prototype.send = function patchedSend(data) {
    trackSocket(this);
    observeOutgoing(this, data);
    return nativeSend.call(this, data);
  };

  function sendGameMessage(message) {
    if (!isSocketOpen()) return false;
    try {
      gameSocket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log(`Falha ao enviar ${message.type}: ${error}`, true);
      return false;
    }
  }

  async function waitForGameSocket(timeoutMs = 5_000) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (isSocketOpen()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return isSocketOpen();
  }

  async function recoverAfterReload(socket) {
    if (reloadRecoveryAttempted || !reloadRecoveryPending) return false;
    if (!currentHuntSlug || !autoReconnectWasInHunt) return false;
    if (socket.readyState !== NativeWebSocket.OPEN) return false;

    reloadRecoveryAttempted = true;
    autoReconnectInProgress = true;

    try {
      await new Promise(resolve => setTimeout(resolve, CONFIG.reloadRecoveryDelayMs));
      if (!await waitForGameSocket(5_000)) return false;

      const entered = sendGameMessage({ type: 'enter-hunt', slug: currentHuntSlug });
      if (!entered) return false;

      awaitingConfirmation = true;
      confirmationDeadline = now() + CONFIG.confirmationTimeoutMs;
      lastHuntSocketActivityAt = now();
      log(`Recuperação pós-reload iniciada em ${currentHuntSlug}.`);
      return true;
    } catch (error) {
      log(`Falha na recuperação pós-reload: ${error}`, true);
      return false;
    } finally {
      autoReconnectInProgress = false;
      renderOverlay();
    }
  }

  async function rejoinCurrentHunt(reason) {
    if (autoReconnectInProgress || awaitingConfirmation) return false;
    if (!currentHuntSlug || !autoReconnectWasInHunt || !isSocketOpen()) return false;

    const currentTime = now();
    if (currentTime - lastAutoReconnectAt < CONFIG.reconnectCooldownMs) return false;

    autoReconnectInProgress = true;
    lastAutoReconnectAt = currentTime;

    try {
      if (!sendGameMessage({ type: 'leave-hunt' })) return false;

      await new Promise(resolve => setTimeout(resolve, CONFIG.reentryDelayMs));
      if (!await waitForGameSocket(5_000)) return false;

      const entered = sendGameMessage({ type: 'enter-hunt', slug: currentHuntSlug });
      if (!entered) return false;

      awaitingConfirmation = true;
      confirmationDeadline = now() + CONFIG.confirmationTimeoutMs;
      lastHuntSocketActivityAt = now();
      lastCaptureBarSignature = getCaptureBarSignature();

      log(`${reason} Reentrei em ${currentHuntSlug}.`);
      return true;
    } catch (error) {
      log(`Falha na recuperação: ${error}`, true);
      return false;
    } finally {
      autoReconnectInProgress = false;
      renderOverlay();
    }
  }

  function confirmReconnect() {
    awaitingConfirmation = false;
    confirmationDeadline = 0;
    reloadRecoveryPending = false;
    reloadRecoveryAttempted = false;
    reconnectCount += 1;
    saveState({ reconnectPending: false });
    log(`Reconexão confirmada em ${currentHuntSlug}.`);
    renderOverlay();
  }

  function monitor() {
    const t = now();

    if (awaitingConfirmation) {
      if (t > confirmationDeadline) {
        awaitingConfirmation = false;
        confirmationDeadline = 0;
        log('Reconexão não confirmada.', true);
      }
      renderOverlay();
      return;
    }

    // PIW-QOL waits for a long socket-down window before reloading, allowing the
    // game's own reconnect mechanism to recover first.
    if (!isSocketOpen()) {
      if (!socketDownSince) socketDownSince = t;

      if (
        autoReconnectWasInHunt &&
        currentHuntSlug &&
        !reloadScheduled &&
        t - socketDownSince >= CONFIG.socketReloadDelayMs
      ) {
        reloadScheduled = true;
        reloadRecoveryPending = true;
        saveState({ reconnectPending: true });
        log('WebSocket continua fechado; recarregando a página.', true);
        setTimeout(() => {
          if (reloadRecoveryPending) location.reload();
        }, 1_500);
      }

      renderOverlay();
      return;
    }

    socketDownSince = 0;

    const inHunt = isInHuntContext();
    if (!inHunt) {
      autoReconnectWasInHunt = false;
      renderOverlay();
      return;
    }

    if (!autoReconnectWasInHunt) {
      autoReconnectWasInHunt = true;
      lastHuntSocketActivityAt = t;
      lastCaptureBarSignature = getCaptureBarSignature();
      renderOverlay();
      return;
    }

    const captureBarSignature = getCaptureBarSignature();
    if (captureBarSignature && captureBarSignature !== lastCaptureBarSignature) {
      lastCaptureBarSignature = captureBarSignature;
      lastHuntSocketActivityAt = t;
    }

    const silence = t - lastHuntSocketActivityAt;
    if (silence < CONFIG.huntSilenceMs) {
      renderOverlay();
      return;
    }

    void rejoinCurrentHunt(`Hunt sem progresso por ${Math.floor(silence / 1000)}s.`);
    renderOverlay();
  }

  function clampPosition(left, top, el) {
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - el.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - el.offsetHeight - margin);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop)
    };
  }

  function makeOverlayDraggable(el) {
    const startDrag = event => {
      if (event.button !== 0) return;
      const rect = el.getBoundingClientRect();
      dragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      el.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    const moveDrag = event => {
      if (!dragState) return;
      const position = clampPosition(
        event.clientX - dragState.offsetX,
        event.clientY - dragState.offsetY,
        el
      );
      el.style.left = `${position.left}px`;
      el.style.top = `${position.top}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };

    const endDrag = () => {
      if (!dragState) return;
      const rect = el.getBoundingClientRect();
      savePosition(rect.left, rect.top);
      dragState = null;
    };

    el.addEventListener('pointerdown', startDrag);
    el.addEventListener('pointermove', moveDrag);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
  }

  function renderOverlay() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = CONFIG.overlayId;

      Object.assign(overlay.style, {
        position: 'fixed',
        zIndex: '2147483647',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'rgba(15, 23, 42, 0.94)',
        color: '#fff',
        font: '12px/1.35 system-ui, sans-serif',
        minWidth: '125px',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)',
        cursor: 'move',
        userSelect: 'none',
        touchAction: 'none'
      });

      const saved = getPosition();
      if (saved) {
        overlay.style.left = `${saved.left}px`;
        overlay.style.top = `${saved.top}px`;
      } else {
        overlay.style.right = '12px';
        overlay.style.bottom = '12px';
      }

      const host = document.documentElement || document.body;
      if (!host) {
        document.addEventListener('DOMContentLoaded', renderOverlay, { once: true });
        return;
      }

      host.appendChild(overlay);
      makeOverlayDraggable(overlay);
    }

    overlay.textContent = '';

    const status = document.createElement('div');
    status.textContent = isSocketOpen() ? '🟢 CONECTADO' : '🔴 DESCONECTADO';

    const count = document.createElement('div');
    count.textContent = `RECONEXÕES: ${reconnectCount}`;

    overlay.appendChild(status);
    overlay.appendChild(count);
  }

  function bootstrap() {
    restoreState();
    lastCaptureBarSignature = getCaptureBarSignature();

    // Preserve the last hunt across a reload triggered by the reconnect fallback.
    window.addEventListener('beforeunload', () => {
      if (autoReconnectWasInHunt && currentHuntSlug) {
        saveState({ reconnectPending: true });
      }
    });

    renderOverlay();
    setInterval(monitor, CONFIG.checkIntervalMs);
  }

  bootstrap();
})();
