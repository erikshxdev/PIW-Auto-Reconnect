(() => {
  'use strict';

  // PIW Auto Reconnect — independent implementation.
  // Only monitors the game's WebSocket and hunt state.
  // No external requests, analytics, cookies, or credential access.

  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;
  const trackedSockets = new WeakSet();

  const CONFIG = Object.freeze({
    huntSilenceMs: 120_000,
    reentryDelayMs: 500,
    reconnectCooldownMs: 10_000,
    checkIntervalMs: 1_000,
    socketReloadDelayMs: 45_000,
    confirmationTimeoutMs: 15_000,
    confirmationGraceMs: 3_000,
    failedRejoinCooldownMs: 120_000,
    overlayId: 'piw-auto-reconnect-overlay',
    stateKey: 'piw_auto_reconnect_state_v5',
    positionKey: 'piw_auto_reconnect_position_v1',
    enabledKey: 'piw_auto_reconnect_enabled_v1'
  });

  const HUNT_MESSAGE_TYPES = new Set([
    'field',
    'field-init',
    'field-kill',
    'poke-xp',
    'pending',
    'catch-result'
  ]);

  const STRONG_HUNT_CONFIRM_TYPES = new Set([
    'field-kill',
    'poke-xp',
    'catch-result'
  ]);

  let gameSocket = null;
  let currentHuntSlug = null;
  let lastHuntActivityAt = Date.now();
  let lastReconnectAt = 0;
  let lastFailedRejoinAt = 0;
  let socketDownSince = 0;
  let reloadScheduled = false;
  let reconnectInProgress = false;
  let awaitingRejoinConfirmation = false;
  let rejoinConfirmationDeadline = 0;
  let rejoinStartedAt = 0;
  let rejoinBaselineCaptureSignature = '';
  let likelyInHunt = false;
  let reconnectCount = 0;
  let enabled = true;
  let overlay = null;
  let dragState = null;
  let lastCaptureBarSignature = '';
  let recoveryAfterReloadPending = false;

  function now() {
    return Date.now();
  }

  function log(message, level = 'info') {
    const prefix = '[PIW Auto Reconnect]';
    if (level === 'warn') console.warn(prefix, message);
    else console.info(prefix, message);
  }

  // Hunt state is per-tab so multiple accounts in the same Chrome profile cannot
  // overwrite each other's slug, counters, or enabled state.
  function getState() {
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
        likelyInHunt,
        reconnectCount,
        updatedAt: now(),
        ...extra
      }));
    } catch (error) {
      log(`Não foi possível salvar estado: ${error}`, 'warn');
    }
  }

  function restoreState() {
    const state = getState();
    if (typeof state.slug === 'string' && state.slug.trim()) currentHuntSlug = state.slug.trim();
    likelyInHunt = state.likelyInHunt === true;
    if (Number.isFinite(state.reconnectCount)) reconnectCount = Math.max(0, state.reconnectCount);
    recoveryAfterReloadPending = state.reconnectPending === true;
  }

  function readEnabled() {
    try {
      return sessionStorage.getItem(CONFIG.enabledKey) !== 'false';
    } catch {
      return true;
    }
  }

  function saveEnabled(value) {
    enabled = Boolean(value);
    try {
      sessionStorage.setItem(CONFIG.enabledKey, String(enabled));
    } catch {}

    if (!enabled) {
      reloadScheduled = false;
      awaitingRejoinConfirmation = false;
      reconnectInProgress = false;
      rejoinConfirmationDeadline = 0;
      recoveryAfterReloadPending = false;
      saveState({ reconnectPending: false });
    }

    renderOverlay();
  }

  function getPosition() {
    try {
      const position = JSON.parse(localStorage.getItem(CONFIG.positionKey) || '{}');
      if (Number.isFinite(position.left) && Number.isFinite(position.top)) return position;
    } catch {}
    return null;
  }

  function savePosition(left, top) {
    try {
      localStorage.setItem(CONFIG.positionKey, JSON.stringify({ left, top }));
    } catch {}
  }

  function isOpen() {
    return Boolean(gameSocket && gameSocket.readyState === NativeWebSocket.OPEN);
  }

  function getCaptureBarSignature() {
    const captureBar = document.querySelector('[data-guide="capture-bar"]');
    return captureBar?.innerHTML || '';
  }

  // Deliberately does not use the Hunt Analyzer alone as proof of Hunt context.
  // The analyzer can remain open while the character is no longer hunting.
  function isInHuntContext() {
    return Boolean(document.querySelector(
      '[data-guide="capture-bar"], .hunt-ui, .battle-window, .wild-pokemon'
    ));
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

  function isHuntMessage(message) {
    const type = String(message?.type || '');
    return HUNT_MESSAGE_TYPES.has(type) || isHuntProgressMessage(message);
  }

  function isStrongConfirmationMessage(message) {
    return STRONG_HUNT_CONFIRM_TYPES.has(String(message?.type || '').toLowerCase());
  }

  function confirmRejoin(reason) {
    if (!awaitingRejoinConfirmation) return;

    awaitingRejoinConfirmation = false;
    rejoinConfirmationDeadline = 0;
    rejoinStartedAt = 0;
    lastFailedRejoinAt = 0;
    reconnectCount += 1;
    saveState();
    log(`Reconexão confirmada em ${currentHuntSlug}. ${reason}`);
    renderOverlay();
  }

  function observeIncoming(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    const type = String(message?.type || '').toLowerCase();

    if (isHuntMessage(message)) {
      lastHuntActivityAt = now();
    }

    if (
      awaitingRejoinConfirmation &&
      isStrongConfirmationMessage(message) &&
      now() - rejoinStartedAt >= CONFIG.confirmationGraceMs &&
      now() <= rejoinConfirmationDeadline
    ) {
      confirmRejoin(`Evento confirmado: ${type}.`);
    }

    if (/leave-hunt|hunt-left|leavehunt/.test(type) && !reconnectInProgress) {
      likelyInHunt = false;
      saveState({ reconnectPending: false });
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

    const type = String(message?.type || '');

    if (type === 'enter-hunt' && message.slug) {
      currentHuntSlug = String(message.slug).trim();
      likelyInHunt = true;
      if (!reconnectInProgress) lastHuntActivityAt = now();
      socketDownSince = 0;
      if (!reconnectInProgress) saveState({ reconnectPending: false });
      return;
    }

    if (type === 'leave-hunt' && !reconnectInProgress) {
      likelyInHunt = false;
      saveState({ reconnectPending: false });
    }
  }

  function trackSocket(socket) {
    if (!socket || !String(socket.url || '').includes('/ws')) return socket;

    gameSocket = socket;
    socketDownSince = 0;
    reloadScheduled = false;
    renderOverlay();

    // Critical: attach listeners only once per WebSocket instance. The patched send()
    // method is called for every game message, so re-attaching here would multiply
    // message/close handlers over time.
    if (trackedSockets.has(socket)) return socket;
    trackedSockets.add(socket);

    const state = getState();
    if (
      recoveryAfterReloadPending &&
      state.reconnectPending === true &&
      state.likelyInHunt === true &&
      currentHuntSlug &&
      enabled
    ) {
      recoveryAfterReloadPending = false;
      saveState({ reconnectPending: false });
      setTimeout(() => {
        if (enabled && isOpen() && currentHuntSlug) {
          void rejoinCurrentHunt('Recuperação após reload.');
        }
      }, 2_000);
    }

    socket.addEventListener('message', observeIncoming);

    socket.addEventListener('close', () => {
      if (gameSocket !== socket) return;
      gameSocket = null;
      socketDownSince = now();
      if (likelyInHunt && enabled) saveState({ reconnectPending: true });
      renderOverlay();
      log('WebSocket da API do jogo caiu.', 'warn');
    });

    socket.addEventListener('error', () => {
      if (gameSocket === socket) renderOverlay();
    });

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

  NativeWebSocket.prototype.send = function patchedSend(data) {
    trackSocket(this);
    observeOutgoing(this, data);
    return nativeSend.call(this, data);
  };

  function sendGameMessage(message) {
    if (!isOpen()) return false;
    try {
      gameSocket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log(`Falha ao enviar ${message.type}: ${error}`, 'warn');
      return false;
    }
  }

  async function rejoinCurrentHunt(reason, allowOutsideContext = false) {
    if (!enabled || reconnectInProgress || awaitingRejoinConfirmation || !currentHuntSlug) return false;
    if (!isOpen() || !likelyInHunt) return false;
    if (!allowOutsideContext && !isInHuntContext()) return false;

    const currentTime = now();
    if (currentTime - lastFailedRejoinAt < CONFIG.failedRejoinCooldownMs) return false;

    reconnectInProgress = true;
    lastReconnectAt = currentTime;

    try {
      rejoinBaselineCaptureSignature = getCaptureBarSignature();

      if (!sendGameMessage({ type: 'leave-hunt' })) return false;

      await new Promise(resolve => setTimeout(resolve, CONFIG.reentryDelayMs));

      if (!enabled || !isOpen()) return false;

      const entered = sendGameMessage({
        type: 'enter-hunt',
        slug: currentHuntSlug
      });
      if (!entered) return false;

      awaitingRejoinConfirmation = true;
      rejoinStartedAt = now();
      rejoinConfirmationDeadline = rejoinStartedAt + CONFIG.confirmationTimeoutMs;
      lastHuntActivityAt = rejoinStartedAt;
      log(`${reason} Reentrando em ${currentHuntSlug}; aguardando confirmação real.`);
      return true;
    } catch (error) {
      lastFailedRejoinAt = now();
      log(`Falha na recuperação: ${error}`, 'warn');
      return false;
    } finally {
      reconnectInProgress = false;
      renderOverlay();
    }
  }

  function monitor() {
    const t = now();

    if (!enabled) {
      renderOverlay();
      return;
    }

    if (awaitingRejoinConfirmation) {
      const currentSignature = getCaptureBarSignature();
      const captureChanged = (
        t - rejoinStartedAt >= CONFIG.confirmationGraceMs &&
        currentSignature &&
        currentSignature !== rejoinBaselineCaptureSignature
      );

      if (captureChanged && t <= rejoinConfirmationDeadline) {
        confirmRejoin('Capture bar voltou a mudar.');
        return;
      }

      if (awaitingRejoinConfirmation && t > rejoinConfirmationDeadline) {
        awaitingRejoinConfirmation = false;
        rejoinConfirmationDeadline = 0;
        rejoinStartedAt = 0;
        lastFailedRejoinAt = t;
        log('A tentativa de reconexão não foi confirmada; contagem mantida.', 'warn');
        renderOverlay();
      }
      return;
    }

    if (!isOpen()) {
      if (!socketDownSince) socketDownSince = t;

      if (likelyInHunt && currentHuntSlug && !reloadScheduled) {
        const downFor = t - socketDownSince;
        if (downFor >= CONFIG.socketReloadDelayMs) {
          reloadScheduled = true;
          saveState({ reconnectPending: true });
          log('WebSocket continua fechado; recarregando a página.', 'warn');
          setTimeout(() => {
            if (enabled) location.reload();
          }, 1_000);
        }
      }
      renderOverlay();
      return;
    }

    socketDownSince = 0;

    if (!likelyInHunt || !currentHuntSlug) {
      renderOverlay();
      return;
    }

    const captureBarSignature = getCaptureBarSignature();
    if (captureBarSignature && captureBarSignature !== lastCaptureBarSignature) {
      lastCaptureBarSignature = captureBarSignature;
      lastHuntActivityAt = t;
    }

    // During the normal operation of the game we require a real Hunt context before
    // initiating leave/enter. This prevents an open analyzer or stale slug from causing
    // an unintended hunt change while the player is elsewhere.
    if (!isInHuntContext()) {
      renderOverlay();
      return;
    }

    if (t - lastHuntActivityAt < CONFIG.huntSilenceMs) {
      renderOverlay();
      return;
    }

    if (t - lastReconnectAt < CONFIG.reconnectCooldownMs || reconnectInProgress) return;

    void rejoinCurrentHunt(
      `Hunt sem atividade por ${Math.floor((t - lastHuntActivityAt) / 1000)}s.`
    );
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
      const target = event.target;
      if (event.button !== 0 || (target instanceof Element && target.closest('button'))) return;

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

  function createToggleButton() {
    const button = document.createElement('button');
    button.type = 'button';
    Object.assign(button.style, {
      width: '100%',
      marginTop: '7px',
      padding: '4px 7px',
      border: '1px solid rgba(255,255,255,.25)',
      borderRadius: '5px',
      background: 'rgba(255,255,255,.10)',
      color: '#fff',
      font: '600 10px/1.3 system-ui, sans-serif',
      cursor: 'pointer',
      userSelect: 'none'
    });

    button.addEventListener('pointerdown', event => event.stopPropagation());
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      saveEnabled(!enabled);
      log(`AUTO RECONNECT ${enabled ? 'LIGADO' : 'DESLIGADO'}.`);
    });

    return button;
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
        minWidth: '130px',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)',
        whiteSpace: 'pre-line',
        cursor: 'move',
        userSelect: 'none',
        touchAction: 'none'
      });

      const savedPosition = getPosition();
      if (savedPosition) {
        const position = clampPosition(savedPosition.left, savedPosition.top, overlay);
        overlay.style.left = `${position.left}px`;
        overlay.style.top = `${position.top}px`;
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
    status.textContent = isOpen() ? '🟢 CONECTADO' : '🔴 DESCONECTADO';

    const count = document.createElement('div');
    count.textContent = `RECONEXÕES: ${reconnectCount}`;

    const toggle = createToggleButton();
    toggle.textContent = enabled ? 'AUTO RECONNECT: ON' : 'AUTO RECONNECT: OFF';

    overlay.appendChild(status);
    overlay.appendChild(count);
    overlay.appendChild(toggle);
  }

  function bootstrap() {
    restoreState();
    enabled = readEnabled();
    lastCaptureBarSignature = getCaptureBarSignature();
    renderOverlay();

    window.addEventListener('beforeunload', () => saveState());

    window.addEventListener('resize', () => {
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const position = clampPosition(rect.left, rect.top, overlay);
      overlay.style.left = `${position.left}px`;
      overlay.style.top = `${position.top}px`;
      overlay.style.right = 'auto';
      overlay.style.bottom = 'auto';
      savePosition(position.left, position.top);
    });

    setInterval(monitor, CONFIG.checkIntervalMs);
  }

  bootstrap();
})();
