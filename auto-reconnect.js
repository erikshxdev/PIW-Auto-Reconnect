(() => {
  'use strict';

  // PIW Auto Reconnect — independent implementation.
  // No external requests, analytics, cookies, or credential access.

  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;

  const CONFIG = Object.freeze({
    huntSilenceMs: 120_000,
    reentryDelayMs: 500,
    reconnectCooldownMs: 10_000,
    checkIntervalMs: 1_000,
    socketReloadDelayMs: 45_000,
    confirmationTimeoutMs: 15_000,
    overlayId: 'piw-auto-reconnect-overlay',
    storageKey: 'piw_auto_reconnect_state_v3',
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

  let gameSocket = null;
  let currentHuntSlug = null;
  let lastHuntActivityAt = Date.now();
  let lastReconnectAt = 0;
  let socketDownSince = 0;
  let reloadScheduled = false;
  let reconnectInProgress = false;
  let likelyInHunt = false;
  let reconnectCount = 0;
  let overlay = null;
  let dragState = null;
  let enabled = true;
  let awaitingRejoinConfirmation = false;
  let rejoinConfirmationDeadline = 0;

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
      return JSON.parse(localStorage.getItem(CONFIG.storageKey) || '{}');
    } catch {
      return {};
    }
  }

  function saveState(extra = {}) {
    try {
      const state = {
        slug: currentHuntSlug,
        likelyInHunt,
        reconnectCount,
        updatedAt: now(),
        ...extra
      };
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
    } catch (error) {
      log(`Não foi possível salvar estado: ${error}`, 'warn');
    }
  }

  function restoreState() {
    const state = getState();
    if (typeof state.slug === 'string' && state.slug.trim()) currentHuntSlug = state.slug.trim();
    likelyInHunt = state.likelyInHunt === true;
    if (Number.isFinite(state.reconnectCount)) reconnectCount = Math.max(0, state.reconnectCount);
  }

  function readEnabled() {
    try {
      const stored = localStorage.getItem(CONFIG.enabledKey);
      return stored !== 'false';
    } catch {
      return true;
    }
  }

  function saveEnabled(value) {
    enabled = Boolean(value);
    try {
      localStorage.setItem(CONFIG.enabledKey, String(enabled));
    } catch {}
    if (!enabled) {
      reloadScheduled = false;
      awaitingRejoinConfirmation = false;
      reconnectInProgress = false;
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

  function confirmRejoinFromActivity() {
    if (!awaitingRejoinConfirmation) return;
    if (now() > rejoinConfirmationDeadline) return;

    awaitingRejoinConfirmation = false;
    rejoinConfirmationDeadline = 0;
    reconnectCount += 1;
    saveState();
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

    if (isHuntMessage(message)) {
      lastHuntActivityAt = now();
      confirmRejoinFromActivity();
    }

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

    const state = getState();
    if (state.reconnectPending === true && state.likelyInHunt === true && currentHuntSlug && enabled) {
      saveState({ reconnectPending: false });
      setTimeout(() => {
        if (enabled && isOpen() && likelyInHunt && currentHuntSlug) {
          void rejoinCurrentHunt('Reload de recuperação concluído.');
        }
      }, 2_000);
    }

    socket.addEventListener('message', observeIncoming);
    socket.addEventListener('close', () => {
      if (gameSocket === socket) {
        gameSocket = null;
        socketDownSince = now();
        if (likelyInHunt) saveState({ reconnectPending: enabled });
        renderOverlay();
        log('WebSocket da API do jogo caiu.', 'warn');
      }
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

  async function rejoinCurrentHunt(reason) {
    if (!enabled || reconnectInProgress || awaitingRejoinConfirmation || !currentHuntSlug) return false;

    reconnectInProgress = true;
    lastReconnectAt = now();

    try {
      if (!sendGameMessage({ type: 'leave-hunt' })) return false;

      await new Promise(resolve => setTimeout(resolve, CONFIG.reentryDelayMs));

      if (!enabled || !isOpen()) return false;

      const entered = sendGameMessage({
        type: 'enter-hunt',
        slug: currentHuntSlug
      });
      if (!entered) return false;

      // Sending enter-hunt is NOT counted as success. We wait for real hunt activity.
      awaitingRejoinConfirmation = true;
      rejoinConfirmationDeadline = now() + CONFIG.confirmationTimeoutMs;
      lastHuntActivityAt = now();
      log(`${reason} Tentando reentrar em ${currentHuntSlug}; aguardando confirmação.`);
      return true;
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
        log('A tentativa de reconexão não foi confirmada; nenhuma reconexão foi contabilizada.', 'warn');
      }
      renderOverlay();
    }

    if (!isOpen()) {
      if (!socketDownSince) socketDownSince = t;

      if (likelyInHunt && currentHuntSlug) {
        const downFor = t - socketDownSince;
        if (!reloadScheduled && downFor >= CONFIG.socketReloadDelayMs) {
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

    if (awaitingRejoinConfirmation) {
      renderOverlay();
      return;
    }

    const silence = t - lastHuntActivityAt;
    if (silence < CONFIG.huntSilenceMs) {
      renderOverlay();
      return;
    }

    if (t - lastReconnectAt < CONFIG.reconnectCooldownMs || reconnectInProgress) return;
    void rejoinCurrentHunt(`Sem atividade há ${Math.floor(silence / 1000)}s.`);
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
      if (event.button !== 0 || event.target.closest('button')) return;
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
        minWidth: '125px',
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
