(() => {
  'use strict';

  // PIW Auto Reconnect — independent, minimal implementation.
  // No external requests, no analytics, no access to cookies/tokens.

  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;

  const CONFIG = Object.freeze({
    huntSilenceMs: 60_000,
    reentryDelayMs: 500,
    reconnectCooldownMs: 5_000,
    checkIntervalMs: 1_000,
    socketReloadDelayMs: 45_000,
    overlayId: 'piw-auto-reconnect-overlay',
    storageKey: 'piw_auto_reconnect_state_v2',
    positionKey: 'piw_auto_reconnect_position_v1'
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

  function observeIncoming(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (isHuntMessage(message)) lastHuntActivityAt = now();

    const type = String(message?.type || '').toLowerCase();
    if (/leave-hunt|hunt-left|leavehunt/.test(type)) {
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
      lastHuntActivityAt = now();
      socketDownSince = 0;
      saveState({ reconnectPending: false });
      return;
    }

    if (type === 'leave-hunt') {
      likelyInHunt = false;
      saveState({ reconnectPending: false });
    }
  }

  function trackSocket(socket) {
    if (!socket || !String(socket.url || '').includes('/ws')) return socket;

    gameSocket = socket;
    socketDownSince = 0;
    reloadScheduled = false;

    const state = getState();
    if (state.reconnectPending === true && state.likelyInHunt === true && currentHuntSlug) {
      saveState({ reconnectPending: false });
      setTimeout(() => {
        if (isOpen() && likelyInHunt && currentHuntSlug) {
          void rejoinCurrentHunt('Reload de recuperação concluído.');
        }
      }, 2_000);
    }

    socket.addEventListener('message', observeIncoming);
    socket.addEventListener('close', () => {
      if (gameSocket === socket) {
        gameSocket = null;
        socketDownSince = now();
        if (likelyInHunt && currentHuntSlug) saveState({ reconnectPending: true });
        log('WebSocket da API do jogo caiu.', 'warn');
      }
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
    if (reconnectInProgress || !currentHuntSlug) return false;

    reconnectInProgress = true;
    lastReconnectAt = now();

    try {
      if (!sendGameMessage({ type: 'leave-hunt' })) return false;

      await new Promise(resolve => setTimeout(resolve, CONFIG.reentryDelayMs));

      const entered = sendGameMessage({ type: 'enter-hunt', slug: currentHuntSlug });
      if (!entered) return false;

      reconnectCount += 1;
      likelyInHunt = true;
      lastHuntActivityAt = now();
      saveState();
      log(`${reason} Reentrei em ${currentHuntSlug}.`);
      return true;
    } finally {
      reconnectInProgress = false;
    }
  }

  function monitor() {
    const t = now();

    if (!isOpen()) {
      if (!socketDownSince) socketDownSince = t;

      if (likelyInHunt && currentHuntSlug) {
        const downFor = t - socketDownSince;
        if (!reloadScheduled && downFor >= CONFIG.socketReloadDelayMs) {
          reloadScheduled = true;
          saveState({ reconnectPending: true });
          log('WebSocket continua fechado; recarregando a página.', 'warn');
          setTimeout(() => location.reload(), 1_000);
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
        minWidth: '118px',
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

    overlay.textContent = `${isOpen() ? '🟢 conectado' : '🔴 desconectado'}\nReconexões: ${reconnectCount}`;
  }

  function bootstrap() {
    restoreState();
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
