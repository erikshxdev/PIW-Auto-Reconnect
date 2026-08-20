(() => {
  'use strict';

  // PIW Auto Reconnect — reconnect only.
  // Hunt stuck -> save current hunt -> F5 -> restore hunt.

  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;
  const trackedSockets = new WeakSet();

  const CONFIG = Object.freeze({
    huntSilenceMs: 60_000,
    socketReloadDelayMs: 45_000,
    reloadRecoveryDelayMs: 1_500,
    confirmationTimeoutMs: 15_000,
    checkIntervalMs: 1_000,
    stateKey: 'piw_auto_reconnect_state_v12',
    positionKey: 'piw_auto_reconnect_position_v1',
    overlayId: 'piw-auto-reconnect-overlay'
  });

  const HUNT_TYPES = new Set(['field', 'field-init', 'field-kill', 'poke-xp', 'pending', 'catch-result']);
  const CONFIRM_TYPES = new Set(['field-kill', 'poke-xp', 'catch-result']);

  let gameSocket = null;
  let currentHuntSlug = null;
  let lastHuntActivityAt = Date.now();
  let lastCaptureBarSignature = '';
  let socketDownSince = 0;
  let reloadScheduled = false;
  let recoveryPending = false;
  let recoveryAttempted = false;
  let awaitingConfirmation = false;
  let confirmationDeadline = 0;
  let reconnectCount = 0;
  let wasInHunt = false;
  let recoveryInProgress = false;
  let overlay = null;
  let dragState = null;

  function now() { return Date.now(); }

  function log(message, warning = false) {
    (warning ? console.warn : console.info)('[PIW Auto Reconnect]', message);
  }

  function loadState() {
    try { return JSON.parse(sessionStorage.getItem(CONFIG.stateKey) || '{}'); }
    catch { return {}; }
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
    const state = loadState();
    if (typeof state.slug === 'string' && state.slug.trim()) currentHuntSlug = state.slug.trim();
    if (Number.isFinite(state.reconnectCount)) reconnectCount = Math.max(0, state.reconnectCount);

    recoveryPending = state.reconnectPending === true;
    wasInHunt = recoveryPending && Boolean(currentHuntSlug);
  }

  function isSocketOpen() {
    return Boolean(gameSocket && gameSocket.readyState === NativeWebSocket.OPEN);
  }

  function inHuntContext() {
    if (document.querySelector('[data-guide="capture-bar"], .hunt-ui, .battle-window, .wild-pokemon')) return true;
    if (currentHuntSlug && wasInHunt && recoveryPending) return true;
    const analyzer = document.querySelector('.ha-window:not(.ha-compare-modal)');
    return Boolean(currentHuntSlug && wasInHunt && analyzer);
  }

  function captureBarSignature() {
    return document.querySelector('[data-guide="capture-bar"]')?.innerHTML || '';
  }

  function isHuntActivity(message) {
    const type = String(message?.type || '').toLowerCase();
    if (!type) return false;
    if (/chat|family|friend|ranking|pong|ping|inventory|pokes-get/.test(type)) return false;
    if (HUNT_TYPES.has(type)) return true;
    if (/exp|xp|defeat|kill|loot|drop|capture|catch|damage|attack/.test(type)) return true;

    try {
      const payload = JSON.stringify(message).toLowerCase();
      return /"(?:expgained|xpgain|xp|experience|defeated|killed|damage|loot|drops?|reward)"\s*:\s*(?:[1-9]\d*|true|\[|\{)/.test(payload);
    } catch {
      return false;
    }
  }

  function observeIncoming(event) {
    let message;
    try { message = JSON.parse(event.data); }
    catch { return; }

    if (isHuntActivity(message)) lastHuntActivityAt = now();

    if (awaitingConfirmation && now() <= confirmationDeadline && CONFIRM_TYPES.has(String(message?.type || '').toLowerCase())) {
      confirmRecovery();
    }
  }

  function observeOutgoing(socket, data) {
    if (!socket || !String(socket.url || '').includes('/ws') || typeof data !== 'string') return;

    let message;
    try { message = JSON.parse(data); }
    catch { return; }

    const type = String(message?.type || '').toLowerCase();

    if (type === 'enter-hunt' && message.slug) {
      currentHuntSlug = String(message.slug).trim();
      wasInHunt = true;
      lastHuntActivityAt = now();
      socketDownSince = 0;
      if (!awaitingConfirmation) {
        recoveryPending = false;
        recoveryAttempted = false;
        saveState({ reconnectPending: false });
      }
      return;
    }

    if (type === 'leave-hunt' && !recoveryInProgress) {
      wasInHunt = false;
      recoveryPending = false;
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
      if (recoveryPending && !recoveryAttempted) void restoreHuntAfterReload(socket);
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

    if (socket.readyState === NativeWebSocket.OPEN && recoveryPending && !recoveryAttempted) {
      void restoreHuntAfterReload(socket);
    }

    renderOverlay();
    return socket;
  }

  function TrackedWebSocket(url, protocols) {
    const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    return trackSocket(socket);
  }

  TrackedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket);
  window.WebSocket = TrackedWebSocket;

  NativeWebSocket.prototype.send = function patchedSend(data) {
    trackSocket(this);
    observeOutgoing(this, data);
    return nativeSend.call(this, data);
  };

  async function waitForSocket(timeoutMs = 5_000) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (isSocketOpen()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return isSocketOpen();
  }

  function scheduleReload(reason) {
    if (reloadScheduled || !currentHuntSlug || !wasInHunt) return;

    reloadScheduled = true;
    recoveryPending = true;
    saveState({ reconnectPending: true });
    log(`${reason} F5 para restaurar a Hunt.`, true);

    setTimeout(() => {
      if (recoveryPending) location.reload();
    }, 250);
  }

  async function restoreHuntAfterReload(socket) {
    if (recoveryAttempted || !recoveryPending || !currentHuntSlug || !wasInHunt) return false;
    if (socket.readyState !== NativeWebSocket.OPEN) return false;

    recoveryAttempted = true;
    recoveryInProgress = true;

    try {
      await new Promise(resolve => setTimeout(resolve, CONFIG.reloadRecoveryDelayMs));
      if (!await waitForSocket()) return false;

      const sent = gameSocket.send(JSON.stringify({ type: 'enter-hunt', slug: currentHuntSlug }));
      if (sent === undefined) {
        awaitingConfirmation = true;
        confirmationDeadline = now() + CONFIG.confirmationTimeoutMs;
        lastHuntActivityAt = now();
        log(`Tentando restaurar a Hunt: ${currentHuntSlug}.`);
        return true;
      }

      return false;
    } catch (error) {
      log(`Falha ao restaurar a Hunt: ${error}`, true);
      return false;
    } finally {
      recoveryInProgress = false;
      renderOverlay();
    }
  }

  function confirmRecovery() {
    awaitingConfirmation = false;
    confirmationDeadline = 0;
    recoveryPending = false;
    recoveryAttempted = false;
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
        log('Reconexão pós-F5 não foi confirmada.', true);
      }
      renderOverlay();
      return;
    }

    if (!isSocketOpen()) {
      if (!socketDownSince) socketDownSince = t;
      if (wasInHunt && currentHuntSlug && !reloadScheduled && t - socketDownSince >= CONFIG.socketReloadDelayMs) {
        scheduleReload('WebSocket permanece fechado.');
      }
      renderOverlay();
      return;
    }

    socketDownSince = 0;

    if (!inHuntContext()) {
      if (!recoveryPending) wasInHunt = false;
      renderOverlay();
      return;
    }

    if (!wasInHunt) {
      wasInHunt = true;
      lastHuntActivityAt = t;
      lastCaptureBarSignature = captureBarSignature();
      renderOverlay();
      return;
    }

    const signature = captureBarSignature();
    if (signature && signature !== lastCaptureBarSignature) {
      lastCaptureBarSignature = signature;
      lastHuntActivityAt = t;
    }

    const silence = t - lastHuntActivityAt;
    if (silence < CONFIG.huntSilenceMs) {
      renderOverlay();
      return;
    }

    scheduleReload(`Hunt sem progresso por ${Math.floor(silence / 1000)} segundos.`);
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
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const rect = el.getBoundingClientRect();
      dragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      el.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    el.addEventListener('pointermove', event => {
      if (!dragState) return;
      const position = clampPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY, el);
      el.style.left = `${position.left}px`;
      el.style.top = `${position.top}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });

    const endDrag = () => {
      if (!dragState) return;
      const rect = el.getBoundingClientRect();
      savePosition(rect.left, rect.top);
      dragState = null;
    };

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

      (document.documentElement || document.body)?.appendChild(overlay);
      makeOverlayDraggable(overlay);
    }

    overlay.textContent = '';
    const status = document.createElement('div');
    const count = document.createElement('div');
    status.textContent = isSocketOpen() ? '🟢 CONECTADO' : '🔴 DESCONECTADO';
    count.textContent = `RECONEXÕES: ${reconnectCount}`;
    overlay.append(status, count);
  }

  function bootstrap() {
    restoreState();
    lastCaptureBarSignature = captureBarSignature();
    renderOverlay();
    setInterval(monitor, CONFIG.checkIntervalMs);
  }

  bootstrap();
})();
