(() => {
  'use strict';

  const OVERLAY_ID = 'piw-auto-reconnect-overlay';

  function attachExistingOverlay() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || overlay.isConnected) return;

    const host = document.documentElement || document.body;
    if (host) host.appendChild(overlay);
  }

  function ensurePanelAttached() {
    attachExistingOverlay();

    if (document.documentElement || document.body) return;
    document.addEventListener('DOMContentLoaded', attachExistingOverlay, { once: true });
  }

  ensurePanelAttached();
})();
