(() => {
  'use strict';

  // PIW Auto Reconnect — independent, minimal implementation.
  // No external requests, no analytics, no access to cookies/tokens.

  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;

  const CONFIG = Object.freeze({
    huntSilenceMs: 10_000,
    reentryDelayMs: 500,
    reconnectCooldownMs: 5_000,
    checkIntervalMs: 1_000,
    socketReloadDelayMs: 45_000,
    overlayId: 'piw-auto-reconnect-overlay',
    storageKey: 'piw_auto_reconnect_state_v1'
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
  let lastStatus = 'Inicializando…';
  let reconnectCount = 0;
  let lastMessageType = '—';

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
  }

  function setStatus(status) {
    lastStatus = status;
    renderOverlay();
  }

  function isOpen() {
    return gameSocket && gameSocket.readyState === NativeWebSocket.OPEN;
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

    lastMessageType = String(message?.type || '—');

    if (isHuntMessage(message)) {
      lastHuntActivityAt = now();
      if (likelyInHunt) setStatus(`Hunt ativa · ${currentHuntSlug || 'slug não identificado'}`);
    }

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
      setStatus(`Hunt ativa · ${currentHuntSlug}`);
      log(`Hunt detectada: ${currentHuntSlug}`);
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
    setStatus(`WebSocket conectado · ${currentHuntSlug || 'aguardando hunt'}`);

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
        setStatus('WebSocket desconectado');
        log('WebSocket da API do jogo caiu.', 'warn');
      }
    });
    socket.addEventListener('error', () => {
      if (gameSocket === socket) setStatus('Erro no WebSocket');
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
    if (reconnectInProgress) return false;
    if (!currentHuntSlug) {
      setStatus('Hunt não identificada · aguardando nova entrada');
      return false;
    }

    reconnectInProgress = true;
    lastReconnectAt = now();
    setStatus(`Recuperando ${currentHuntSlug}…`);

    try {
      const left = sendGameMessage({ type: 'leave-hunt' });
      if (!left) {
        setStatus('Falha: WebSocket ficou indisponível');
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, CONFIG.reentryDelayMs));

      const entered = sendGameMessage({
        type: 'enter-hunt',
        slug: currentHuntSlug
      });

      if (entered) {
        reconnectCount += 1;
        likelyInHunt = true;
        lastHuntActivityAt = now();
        saveState();
        setStatus(`Reconectado · ${currentHuntSlug}`);
        log(`${reason} Reentrei em ${currentHuntSlug}.`);
      } else {
        setStatus('Falha no reenvio de enter-hunt');
      }

      return entered;
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
        setStatus(`WebSocket offline · ${Math.floor(downFor / 1000)}s`);

        if (!reloadScheduled && downFor >= CONFIG.socketReloadDelayMs) {
          reloadScheduled = true;
          saveState({ reconnectPending: true });
          setStatus('Recarregando para recuperar a conexão…');
          log('WebSocket continua fechado; recarregando a página.', 'warn');
          setTimeout(() => location.reload(), 1_000);
        }
      }
      return;
    }

    socketDownSince = 0;

    if (!likelyInHunt || !currentHuntSlug) {
      setStatus(`Conectado · ${currentHuntSlug || 'aguardando hunt'}`);
      return;
    }

    const silence = t - lastHuntActivityAt;
    if (silence < CONFIG.huntSilenceMs) {
      setStatus(`Hunt normal · ${currentHuntSlug}`);
      return;
    }

    if (t - lastReconnectAt < CONFIG.reconnectCooldownMs) return;
    if (reconnectInProgress) return;

    void rejoinCurrentHunt(`Sem atividade há ${Math.floor(silence / 1000)}s.`);
  }

  function renderOverlay() {
    let el = document.getElementById(CONFIG.overlayId);
    if (!el) {
      el = document.createElement('div');
      el.id = CONFIG.overlayId;
      Object.assign(el.style, {
        position: 'fixed',
        right: '12px',
        bottom: '12px',
        zIndex: '2147483647',
        padding: '10px 12px',
        borderRadius: '8px',
        background: 'rgba(15, 23, 42, 0.94)',
        color: '#fff',
        font: '12px/1.4 system-ui, sans-serif',
        minWidth: '220px',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)',
        pointerEvents: 'none',
        whiteSpace: 'pre-line'
      });
      const host = document.documentElement || document.body;
      if (!host) {
        document.addEventListener('DOMContentLoaded', renderOverlay, { once: true });
        return;
      }
      host.appendChild(el);
    }

    const socketState = isOpen() ? '🟢 conectado' : '🔴 desconectado';
    el.textContent = [
      'PIW Auto Reconnect',
      socketState,
      `Hunt: ${currentHuntSlug || '—'}`,
      `Reconexões: ${reconnectCount}`,
      `Último evento: ${lastMessageType}`,
      lastStatus
    ].join('\n');
  }

  function bootstrap() {
    restoreState();
    renderOverlay();
    setStatus(currentHuntSlug ? `Estado restaurado · ${currentHuntSlug}` : 'Aguardando hunt…');

    window.addEventListener('beforeunload', () => saveState());
    setInterval(monitor, CONFIG.checkIntervalMs);
  }

  bootstrap();
})();
