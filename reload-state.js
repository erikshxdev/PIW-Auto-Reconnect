(() => {
  'use strict';

  const STATE_KEY = 'piw_auto_reconnect_state_v6';

  window.addEventListener('beforeunload', () => {
    try {
      const state = JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}');
      if (state.likelyInHunt === true && typeof state.slug === 'string' && state.slug.trim()) {
        sessionStorage.setItem(STATE_KEY, JSON.stringify({
          ...state,
          reconnectPending: true,
          updatedAt: Date.now()
        }));
      }
    } catch {}
  });
})();
