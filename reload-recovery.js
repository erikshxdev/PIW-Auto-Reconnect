(() => {
  'use strict';

  const NativeWebSocket = window.WebSocket;
  const STATE_KEY = 'piw_auto_reconnect_state_v6';
  const RECOVERY_FLAG = 'piw_auto_reconnect_reload_recovery_v1';

  function getState() {
    try {
      return JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  const navigation = performance.getEntriesByType('navigation')[0];
  const isReload = navigation?.type === 'reload';
  if (!isReload) return;

  const state = getState();
  if (state.reconnectPending !== true || state.likelyInHunt !== true || typeof state.slug !== 'string' || !state.slug.trim()) return;
  if (sessionStorage.getItem(RECOVERY_FLAG) === 'done') return;
  sessionStorage.setItem(RECOVERY_FLAG, 'done');

  let socket = null;
  let recovered = false;

  function recover() {
    if (recovered || !socket || socket.readyState !== NativeWebSocket.OPEN) return;
    recovered = true;
    const slug = state.slug.trim();

    setTimeout(() => {
      try {
        if (socket?.readyState !== NativeWebSocket.OPEN) {
          recovered = false;
          return;
        }
        socket.send(JSON.stringify({ type: 'enter-hunt', slug }));
        sessionStorage.removeItem(RECOVERY_FLAG);
      } catch {
        recovered = false;
      }
    }, 1500);
  }

  function TrackedWebSocket(url, protocols) {
    const candidate = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);
    if (String(candidate.url || '').includes('/ws')) {
      socket = candidate;
      if (candidate.readyState === NativeWebSocket.OPEN) recover();
      else candidate.addEventListener('open', recover, { once: true });
    }
    return candidate;
  }

  TrackedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket);
  window.WebSocket = TrackedWebSocket;
})();
