(() => {
  'use strict';

  // PIW Auto Reconnect — independent implementation.
  // Only monitors the game's WebSocket and hunt state.
  // No external requests, analytics, cookies, or credential access.

  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;

  const CONFIG = Object.freeze({
    huntSilenceMs: 120_000,
    reentryDelayMs: 500,
    reconnectCooldownMs: 10_000,
    failedRejoinCooldownMs: 120_000,
    checkIntervalMs: 1_000,
    socketReloadDelayMs: 45_000,
    confirmationTimeoutMs: 15_000,
    reloadRecoveryDelayMs: 1_500,
    overlayId: 'piw-auto-reconnect-overlay',
    stateKey: 'piw_auto_reconnect_state_v7',
    positionKey: 'piw_auto_reconnect_position_v1',
    enabledKey: 'piw_auto_reconnect_enabled_v1'
  });

  const HUNT_MESSAGE_TYPES = new Set(['field', 'field-init', 'field-kill', 'poke-xp', 'pending', 'catch-result']);
  const STRONG_CONFIRM_TYPES = new Set(['field-kill', 'poke-xp', 'catch-result']);
  const trackedSockets = new WeakSet();

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
  let likelyInHunt = false;
  let reconnectCount = 0;
  let enabled = true;
  let overlay = null;
  let dragState = null;
  let lastCaptureBarSignature = '';
  let pendingReloadRecovery = false;
  let reloadRecoveryAttempted = false;

  function now() {
    return Date.now();
  }

  function log(message, level = 'info') {
    const prefix = '[PIW Auto Reconnect]';
    if (level === 'warn') console.warn(prefix, message);
    else console.info(prefix, message);
  }

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
    pendingReloadRecovery = state.reconnectPending === true;
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
      pendingReloadRecovery = false;
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

  function isInHuntContext() {
    return Boolean(document.querySelector('[data-guide="capture-bar"], .hunt-ui, .battle-window, .wild-pokemon'));
  }

  function getCaptureBarSignature() {
    const captureBar = document.querySelector('[data-guide="capture-bar"]');
    return captureBar?.innerHTML || '';
  }

  function isHuntActivityMessage(message) {
    const type = String(message?.type || '').toLowerCase();
    if (!type) return false;
    if (HUNT_MESSAGE_TYPES.has(type)) return true;
    if (/chat|family|friend|ranking|pong|ping|inventory|pokes-get/.test(type)) return false;
    if (/exp|xp|defeat|kill|loot|drop|capture|catch|damage|attack/.test(type)) return true;
    try {
      const payload = JSON.stringify(message).toLowerCase();
      return /"(?:expgained|xpgain|xp|experience|defeated|killed|damage|loot|drops?|reward)"\s*:\s*(?:[1-9]\d*|true|\[|\{)/.test(payload);
    } catch {
      return false;
    }
  }

  function isStrongConfirmationMessage(message) {
    return STRONG_CONFIRM_TYPES.has(String(message?.type || '').toLowerCase());
  }

  function confirmRejoin() {
    if (!awaitingRejoinConfirmation) return;
    awaitingRejoinConfirmation = false;
    rejoinConfirmationDeadline = 0;
    lastFailedRejoinAt = 0;
    reconnectCount += 1;
    pendingReloadRecovery = false;
    saveState({ reconnectPending: false });
    log(`Reconexão confirmada em ${currentHuntSlug}.`);
    renderOverlay();
  }

  function observeIncoming(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (isHuntActivityMessage(message)) lastHuntActivityAt = now();
    if (awaitingRejoinConfirmation && isStrongConfirmationMessage(message) && now() <= rejoinConfirmationDeadline) confirmRejoin();

    const type = String(message?.type || '').toLowerCase();
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

    const type = String(message?.type || '').toLowerCase();
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
      if (pendingReloadRecovery && !reloadRecoveryAttempted) {
        void recoverAfterReload(socket);
      }
    });
    socket.addEventListener('close', () => {
      if (gameSocket !== socket) return;
      gameSocket = null;
      socketDownSince = now();
      renderOverlay();
      log('WebSocket da API do jogo caiu.', 'warn');
    });
    socket.addEventListener('error', () => {
      if (gameSocket === socket) renderOverlay();
    });
    if (socket.readyState === NativeWebSocket.OPEN && pendingReloadRecovery && !reloadRecoveryAttempted) {
      void recoverAfterReload(socket);
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

  async function recoverAfterReload(socket) {
    if (!enabled || reloadRecoveryAttempted || !pendingReloadRecovery) return false;
    if (!currentHuntSlug || !likelyInHunt) return false;
    if (socket.readyState !== NativeWebSocket.OPEN) return false;

    reloadRecoveryAttempted = true;
    reconnectInProgress = true;
    try {
      await new Promise(resolve => setTimeout(resolve, CONFIG.reloadRecoveryDelayMs));
      if (!enabled || socket.readyState !== NativeWebSocket.OPEN) {
        lastFailedRejoinAt = now();
        return false;
      }
      const entered = sendGameMessage({ type: 'enter-hunt', slug: currentHuntSlug });
      if (!entered) {
        lastFailedRejoinAt = now();
        return false;
      }
      awaitingRejoinConfirmation = true;
      rejoinConfirmationDeadline = now() + CONFIG.confirmationTimeoutMs;
      lastHuntActivityAt = now();
      log(`Recuperação pós-reload iniciada em ${currentHuntSlug}; aguardando confirmação.`);
      return true;
    } catch (error) {
      lastFailedRejoinAt = now();
      log(`Falha na recuperação pós-reload: ${error}`, 'warn');
      return false;
    } finally {
      reconnectInProgress = false;
      renderOverlay();
    }
  }

  async function rejoinCurrentHunt(reason) {
    if (!enabled || reconnectInProgress || awaitingRejoinConfirmation) return false;
    if (!currentHuntSlug || !likelyInHunt || !isOpen() || !isInHuntContext()) return false;
    const currentTime = now();
    if (currentTime - lastReconnectAt < CONFIG.reconnectCooldownMs) return false;
    if (currentTime - lastFailedRejoinAt < CONFIG.failedRejoinCooldownMs) return false;

    reconnectInProgress = true;
    lastReconnectAt = currentTime;
    try {
      if (!sendGameMessage({ type: 'leave-hunt' })) {
        lastFailedRejoinAt = now();
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, CONFIG.reentryDelayMs));
      if (!enabled || !isOpen()) {
        lastFailedRejoinAt = now();
        return false;
      }
      const entered = sendGameMessage({ type: 'enter-hunt', slug: currentHuntSlug });
      if (!entered) {
        lastFailedRejoinAt = now();
        return false;
      }
      awaitingRejoinConfirmation = true;
      rejoinConfirmationDeadline = now() + CONFIG.confirmationTimeoutMs;
      lastHuntActivityAt = now();
      log(`${reason} Reentrando em ${currentHuntSlug}; aguardando confirmação.`);
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
      if (t > rejoinConfirmationDeadline) {
        awaitingRejoinConfirmation = false;
        rejoinConfirmationDeadline = 0;
        lastFailedRejoinAt = t;
        log('Reconexão não confirmada; nenhuma reconexão foi contabilizada.', 'warn');
        renderOverlay();
      }
      return;
    }

    if (!isOpen()) {
      if (!socketDownSince) socketDownSince = t;
      if (likelyInHunt && currentHuntSlug && !reloadScheduled && t - socketDownSince >= CONFIG.socketReloadDelayMs) {
        reloadScheduled = true;
        pendingReloadRecovery = true;
        saveState({ reconnectPending: true });
        log('WebSocket continua fechado; recarregando a página para tentar restaurar a Hunt.', 'warn');
        setTimeout(() => {
          if (enabled && pendingReloadRecovery) location.reload();
        }, 1_000);
      }
      renderOverlay();
      return;
    }

    socketDownSince = 0;
    if (!likelyInHunt || !currentHuntSlug || !isInHuntContext()) {
      renderOverlay();
      return;
    }

    const captureBarSignature = getCaptureBarSignature();
    if (captureBarSignature && captureBarSignature !== lastCaptureBarSignature) {
      lastCaptureBarSignature = captureBarSignature;
      lastHuntActivityAt = t;
    }

    const silence = t - lastHuntActivityAt;
    if (silence < CONFIG.huntSilenceMs) {
      renderOverlay();
      return;
    }

    void rejoinCurrentHunt(`Hunt sem atividade por ${Math.floor(silence / 1000)}s.`);
    renderOverlay();
  }

  function clampPosition(left, top, el) {
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - el.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - el.offsetHeight - margin);
    return { left: Math.min(Math.max(margin, left), maxLeft), top: Math.min(Math.max(margin, top), maxTop) };
  }

  function makeOverlayDraggable(el) {
    const startDrag = event => {
      const target = event.target;
      if (event.button !== 0 || (target instanceof Element && target.closest('button'))) return;
      const rect = el.getBoundingClientRect();
      dragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      el.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };
    const moveDrag = event => {
      if (!dragState) return;
      const position = clampPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY, el);
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
      width: '100%', marginTop: '7px', padding: '4px 7px',
      border: '1px solid rgba(255,255,255,.25)', borderRadius: '5px',
      background: 'rgba(255,255,255,.10)', color: '#fff',
      font: '600 10px/1.3 system-ui, sans-serif', cursor: 'pointer', userSelect: 'none'
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
        position: 'fixed', zIndex: '2147483647', padding: '8px 10px',
        borderRadius: '8px', background: 'rgba(15, 23, 42, 0.94)', color: '#fff',
        font: '12px/1.35 system-ui, sans-serif', minWidth: '130px',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)', whiteSpace: 'pre-line',
        cursor: 'move', userSelect: 'none', touchAction: 'none'
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

    window.addEventListener('beforeunload', () => {
      if (enabled && likelyInHunt && currentHuntSlug && (reloadScheduled || socketDownSince > 0 || pendingReloadRecovery)) {
        saveState({ reconnectPending: true });
      } else {
        saveState();
      }
    });

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
