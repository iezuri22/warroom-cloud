// War Room Cloud Sync Client
// Cloud is the source of truth. localStorage is just a cache. App code can
// read/write localStorage normally — but writes that happen BEFORE the cloud
// has finished hydrating are held back from the cloud sync queue. After
// hydration, any pre-bootstrap write whose key was authoritative in the
// cloud is dropped (cloud wins). This prevents the empty-defaults-clobber-cloud
// race that wiped priority lists before.
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
    'cal-alerts-setting', // per-device setting
    // Phone Down live state lives in Firestore (phone_down_state/me) with its
    // own onSnapshot listener. Routing it through here too would restore
    // stale values on bootstrap and fight the live listener.
    'pd-active',
    'pd-collapsed'       // banner expand/collapse is a per-device preference
  ]);

  const pending = new Map();   // key -> value (latest pending write)
  let syncTimer = null;
  let lastSyncedAt = null;

  // Race-protection state. Until bootstrap finishes, app writes are queued
  // into _preBootstrapWrites instead of being pushed to the cloud immediately.
  // After bootstrap: any key the cloud already hydrated is treated as "cloud
  // wins" and the pre-bootstrap write is silently dropped from the cloud
  // sync queue (the local read-after-write still worked because we DID
  // write to localStorage). Any key NOT in the cloud falls through to a
  // normal sync.
  let _bootstrapped = false;
  const _preBootstrapWrites = new Map(); // key -> value
  const _hydratedKeys = new Set();       // keys the cloud authoritatively wrote during bootstrap

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

  // Override localStorage methods.
  //
  // The interceptor ALWAYS writes to localStorage (so read-after-write keeps
  // working for app code). The difference is the cloud-sync queue: before
  // bootstrap, writes go into a holding pen. After bootstrap, if the cloud
  // hydrated the same key, the holding-pen entry is discarded (cloud wins).
  // Otherwise it's pushed to the regular sync queue.
  Storage.prototype.setItem = function(key, value) {
    origSetItem.call(this, key, value);
    if (this !== window.localStorage) return;
    if (!_bootstrapped) {
      _preBootstrapWrites.set(key, value);
      return;
    }
    queueSync(key, value);
  };
  Storage.prototype.removeItem = function(key) {
    origRemoveItem.call(this, key);
    if (this !== window.localStorage) return;
    if (!_bootstrapped) {
      _preBootstrapWrites.set(key, null);
      return;
    }
    queueSync(key, null);
  };
  Storage.prototype.clear = function() {
    if (this === window.localStorage) {
      // Sync clear by queuing null for every known key
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) {
          if (_bootstrapped) queueSync(k, null);
          else _preBootstrapWrites.set(k, null);
        }
      }
    }
    origClear.call(this);
  };

  // Flush on page hide (good for mobile where tab switch loses state).
  // Only flushes post-bootstrap writes — pre-bootstrap writes are still
  // in the holding pen and we don't want to push them up if cloud is the
  // source of truth.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pending.size > 0 && _bootstrapped) {
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

  // After bootstrap finishes (success OR fail), flip the gate, then decide
  // what to do with any pre-bootstrap writes that piled up.
  //   - If the cloud authoritatively hydrated a key, drop the pre-bootstrap
  //     write entirely (cloud wins; the app's empty defaults / stale value
  //     never makes it to the cloud).
  //   - If the cloud had no data for that key (new account, or key isn't
  //     synced), push the pre-bootstrap write up as a normal sync.
  function finalizePreBootstrapWrites() {
    for (const [key, value] of _preBootstrapWrites) {
      if (_hydratedKeys.has(key)) {
        // Cloud was authoritative for this key. The pre-bootstrap localStorage
        // write was already overwritten by the cloud hydration step (which
        // used origSetItem to clobber localStorage with the cloud value). So
        // localStorage is consistent. We just need to NOT push the stale
        // value back up.
        continue;
      }
      // Cloud doesn't have data for this key → app's pre-bootstrap value
      // is the latest. Push it.
      queueSync(key, value);
    }
    _preBootstrapWrites.clear();
  }

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

      // Merge cloud state into localStorage. Cloud always wins — track which
      // keys the cloud authoritatively wrote so we can drop matching
      // pre-bootstrap writes from the sync queue.
      for (const [key, entry] of Object.entries(state || {})) {
        if (SKIP_SYNC.has(key)) continue; // don't pull ephemeral state from cloud
        const val = typeof entry.value === 'string'
          ? entry.value
          : JSON.stringify(entry.value);
        origSetItem.call(localStorage, key, val);
        _hydratedKeys.add(key);
      }
      // Always clear any local active-task on fresh page load (stale timer prevention)
      origRemoveItem.call(localStorage, 'active-task');
      lastSyncedAt = Date.now();
      updateSyncIndicator('synced');
      _bootstrapped = true;
      finalizePreBootstrapWrites();
      window.__warroomCloudReady = true;
      document.dispatchEvent(new Event('warroom:cloud-ready'));
    } catch (e) {
      console.error('[sync] bootstrap failed', e);
      updateSyncIndicator('offline');
      // Offline / bootstrap failed: don't lose the user's work. Promote any
      // pre-bootstrap writes to the normal sync queue (they'll retry once
      // the network recovers). Cloud-ready still fires so the app proceeds.
      _bootstrapped = true;
      for (const [key, value] of _preBootstrapWrites) {
        queueSync(key, value);
      }
      _preBootstrapWrites.clear();
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
