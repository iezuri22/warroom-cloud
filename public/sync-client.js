// War Room Cloud Sync Client
// Intercepts localStorage so existing code writes to both local (fast) and cloud (persistent)
(function() {
  'use strict';

  const SYNC_ENDPOINT = '/api/sync';
  const LOAD_ENDPOINT = '/api/load';
  const LOGIN_CHECK   = '/api/me';

  // Keys we don't sync (UI state, caches that don't matter across devices)
  const SKIP_SYNC = new Set([
    'cal-last-synced',   // ephemeral timestamp
    'active-task',       // running timer state is device-specific, shouldn't sync
    'carry-collapsed',   // UI toggle
    'cal-alerts-setting' // per-device setting
  ]);

  const pending = new Map();   // key -> value (latest pending write)
  let syncTimer = null;
  let lastSyncedAt = null;

  const origSetItem    = Storage.prototype.setItem;
  const origRemoveItem = Storage.prototype.removeItem;
  const origClear      = Storage.prototype.clear;

  function queueSync(key, value) {
    if (SKIP_SYNC.has(key)) return;
    pending.set(key, value);
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSync, 800); // debounce 800ms
  }

  async function flushSync() {
    if (pending.size === 0) return;
    const updates = [...pending.entries()].map(([key, value]) => ({ key, value }));
    pending.clear();
    try {
      const res = await fetch(SYNC_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });
      if (res.status === 401) {
        window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname);
        return;
      }
      if (!res.ok) throw new Error('Sync failed: ' + res.status);
      lastSyncedAt = Date.now();
      updateSyncIndicator('synced');
    } catch (e) {
      console.warn('[sync] failed, will retry', e);
      // Put items back into pending to retry
      for (const u of updates) {
        if (!pending.has(u.key)) pending.set(u.key, u.value);
      }
      updateSyncIndicator('error');
      setTimeout(flushSync, 5000);
    }
  }

  // Override localStorage methods
  Storage.prototype.setItem = function(key, value) {
    origSetItem.call(this, key, value);
    if (this === window.localStorage) queueSync(key, value);
  };
  Storage.prototype.removeItem = function(key) {
    origRemoveItem.call(this, key);
    if (this === window.localStorage) queueSync(key, null);
  };
  Storage.prototype.clear = function() {
    if (this === window.localStorage) {
      // Sync clear by queuing null for every known key
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) queueSync(k, null);
      }
    }
    origClear.call(this);
  };

  // Flush on page hide (good for mobile where tab switch loses state)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pending.size > 0) {
      // Use sendBeacon for reliability when page is closing
      const updates = [...pending.entries()].map(([key, value]) => ({ key, value }));
      pending.clear();
      try {
        navigator.sendBeacon(SYNC_ENDPOINT, new Blob(
          [JSON.stringify({ updates })],
          { type: 'application/json' }
        ));
      } catch {}
    }
  });

  // ----- Initial load: pull cloud state into localStorage before app code runs -----
  async function bootstrap() {
    try {
      const authRes = await fetch(LOGIN_CHECK, { credentials: 'same-origin' });
      if (authRes.status !== 200) {
        window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname);
        return;
      }

      const res = await fetch(LOAD_ENDPOINT, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Load failed: ' + res.status);
      const { state } = await res.json();

      // Merge cloud state into localStorage (cloud wins for now - last-write-wins policy)
      for (const [key, entry] of Object.entries(state || {})) {
        if (SKIP_SYNC.has(key)) continue; // don't pull ephemeral state from cloud
        const val = typeof entry.value === 'string'
          ? entry.value
          : JSON.stringify(entry.value);
        origSetItem.call(localStorage, key, val);
      }
      // Always clear any local active-task on fresh page load (stale timer prevention)
      origRemoveItem.call(localStorage, 'active-task');
      lastSyncedAt = Date.now();
      updateSyncIndicator('synced');
      window.__warroomCloudReady = true;
      document.dispatchEvent(new Event('warroom:cloud-ready'));
    } catch (e) {
      console.error('[sync] bootstrap failed', e);
      updateSyncIndicator('offline');
      // Still let the app load - localStorage is the fallback
      window.__warroomCloudReady = true;
      document.dispatchEvent(new Event('warroom:cloud-ready'));
    }
  }

  // ----- Visual sync indicator -----
  function injectIndicator() {
    if (document.getElementById('wr-sync-indicator')) return;
    const el = document.createElement('div');
    el.id = 'wr-sync-indicator';
    el.style.cssText = `
      position:fixed;bottom:12px;right:12px;z-index:9999;
      font-family:'Outfit',system-ui,sans-serif;font-size:10px;font-weight:700;
      padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;
      opacity:0;transition:opacity .2s ease;pointer-events:none;letter-spacing:.5px;
    `;
    el.textContent = 'SYNCED';
    document.body.appendChild(el);
  }

  function updateSyncIndicator(status) {
    const el = document.getElementById('wr-sync-indicator');
    if (!el) return;
    const colors = {
      synced:  { bg: 'rgba(22,163,74,.85)',  text: 'SYNCED' },
      syncing: { bg: 'rgba(37,99,235,.85)',  text: 'SYNCING' },
      error:   { bg: 'rgba(220,38,38,.85)',  text: 'SYNC ERR' },
      offline: { bg: 'rgba(107,114,128,.85)',text: 'OFFLINE' }
    };
    const c = colors[status] || colors.synced;
    el.style.background = c.bg;
    el.textContent = c.text;
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 1500);
  }

  // Expose manual logout for UI
  window.warroomLogout = async function() {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/login.html';
  };

  // Expose manual force-sync
  window.warroomForceSync = flushSync;

  // Inject indicator and kick off bootstrap
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectIndicator);
  } else {
    injectIndicator();
  }
  bootstrap();
})();
