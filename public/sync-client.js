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
    'pd-collapsed',      // banner expand/collapse is a per-device preference
    // Google Calendar payload cache (~540KB). Purely derived: calendar.html
    // refetches it from /api/calendar on every open, and that endpoint is
    // server-side, so a second device rebuilds it identically without our
    // help. Syncing it bought nothing and cost a lot — 540KB uploaded on
    // every calendar sync, and 540KB of /api/load response on all twelve
    // pages that load this file. It also exceeded the per-row cap, so it
    // was already being dropped by /api/load and never actually synced.
    // The user data that DOES need to travel — calendar-gcal-priority-v1,
    // calendar-gcal-titles-v1, calendar-gcal-notes-v1 — are small id-keyed
    // maps and still sync normally.
    'calendar-gcal-cache-v1',
    // Internal sync-client bookkeeping. Must never be sent to the cloud —
    // otherwise the poison list itself gets poisoned (yes, this happened).
    '__sync_poisoned_keys',
    '__sync_poison_v2_migrated'
  ]);

  const pending = new Map();   // key -> value (latest pending write)
  let syncTimer = null;        // single shared timer for both debounce + retry
  let lastSyncedAt = null;
  let lastSkipped = [];        // keys the last /api/load refused to return
  // Exponential-backoff retry state. retryAttempt starts at 0 and increments
  // each time flushSync hits a transient error (503, network). On success it
  // resets to 0. While > 0 we're in a backoff window — queueSync stops
  // scheduling 800ms debounce flushes so the backoff timer is the only thing
  // that can fire a sync. Cap delay at 5 minutes so we don't strand writes
  // indefinitely.
  let retryAttempt = 0;
  const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 180_000, 300_000];

  function scheduleFlush(ms) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncTimer = null; flushSync(); }, ms);
  }
  function scheduleRetry(reason) {
    retryAttempt++;
    const delay = RETRY_DELAYS_MS[Math.min(retryAttempt - 1, RETRY_DELAYS_MS.length - 1)];
    console.warn('[sync] backing off ' + Math.round(delay/1000) + 's (attempt ' + retryAttempt + ', ' + reason + ')');
    scheduleFlush(delay);
  }

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
    // One-timer rule: if a flush is already pending (whether debounce or
    // backoff retry), don't reschedule — let the existing timer fire when
    // it does. This prevents the parallel-timers cascade that used to make
    // /api/sync get hit dozens of times per minute during a Neon outage.
    if (syncTimer) return;
    // If we know the backend is unhappy (retryAttempt was pre-seated by
    // bootstrap, or a prior sync failed but no timer is currently pending),
    // schedule using the backoff curve instead of the snappy 800ms debounce.
    if (retryAttempt > 0) {
      const delay = RETRY_DELAYS_MS[Math.min(retryAttempt - 1, RETRY_DELAYS_MS.length - 1)];
      scheduleFlush(delay);
      return;
    }
    scheduleFlush(800);
  }

  // Keys we've decided to permanently stop syncing because the server keeps
  // rejecting them for a STRUCTURAL reason (value too large for jsonb,
  // malformed payload, etc). Stored in localStorage so the ban persists
  // across reloads. Transient errors (Neon quota / 5xx / network) explicitly
  // do NOT land here — otherwise a one-day quota blip silently disables sync
  // for critical keys forever.
  const POISON_KEY = '__sync_poisoned_keys';
  // One-time migration flag. The pre-fix poison logic banned keys on ANY
  // server-side failure — including transient Neon quota errors — which
  // silently disabled sync for critical keys (ui-state, todos-cache, etc.).
  // On first load after this fix, clear the legacy list once so those keys
  // get a fresh chance. Anything that's truly structurally broken will get
  // re-poisoned by the new logic on its next sync attempt.
  const POISON_MIGRATION_FLAG = '__sync_poison_v2_migrated';
  function migrateLegacyPoisonList() {
    try {
      if (localStorage.getItem(POISON_MIGRATION_FLAG)) return;
      const existing = localStorage.getItem(POISON_KEY);
      if (existing) {
        const arr = JSON.parse(existing);
        if (Array.isArray(arr) && arr.length) {
          console.warn('[sync] clearing legacy poison list (pre-fix entries likely included transient Neon quota failures):', arr);
        }
      }
      localStorage.removeItem(POISON_KEY);
      localStorage.setItem(POISON_MIGRATION_FLAG, '1');
    } catch {}
  }
  migrateLegacyPoisonList();
  function loadPoisoned(){
    try { return new Set(JSON.parse(localStorage.getItem(POISON_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function savePoisoned(s){
    try { localStorage.setItem(POISON_KEY, JSON.stringify([...s])); } catch {}
  }
  // Mirror of the server-side classifier in api/_db-errors.js. We trust the
  // server's `transient` flag when present, but old responses (or the bootstrap
  // load endpoint surfacing raw error text) may only give us a string — so we
  // pattern-match as a fallback.
  function looksTransient(errMsg) {
    if (!errMsg) return false;
    return /quota|HTTP status (?:402|408|5\d\d)|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|network|timeout/i.test(errMsg);
  }
  async function flushSync() {
    if (pending.size === 0) return;
    // Drop any keys we've previously banned from syncing.
    const poisoned = loadPoisoned();
    if (poisoned.size) {
      for (const k of [...pending.keys()]) {
        if (poisoned.has(k)) pending.delete(k);
      }
      if (pending.size === 0) return;
    }
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
      // 503 = backend temporarily unavailable (Neon quota, 5xx). Re-queue
      // everything and retry with exponential backoff — do NOT poison.
      if (res.status === 503) {
        let body = null; try { body = await res.json(); } catch {}
        if (body && body.quotaExceeded) {
          console.warn('[sync] Neon compute quota exceeded — will retry with backoff. Resolve the quota in Neon or wait for reset.');
        } else {
          console.warn('[sync] backend unavailable (503), will retry with backoff');
        }
        for (const u of updates) {
          if (!pending.has(u.key)) pending.set(u.key, u.value);
        }
        updateSyncIndicator('error');
        scheduleRetry(body && body.quotaExceeded ? 'quota' : '503');
        return;
      }
      if (!res.ok) throw new Error('Sync failed: ' + res.status);
      // Server returns { ok, applied, failed: [{key, error, transient}, ...] }.
      // Split failures into transient (re-queue, retry) and structural (poison).
      let body = null;
      try { body = await res.json(); } catch {}
      if (body && body.quotaExceeded) {
        console.warn('[sync] Neon compute quota exceeded for part of this batch.');
      }
      if (body && Array.isArray(body.failed) && body.failed.length) {
        const poisonedNow = loadPoisoned();
        const updatesByKey = new Map(updates.map(u => [u.key, u.value]));
        let poisonedCount = 0;
        let requeuedCount = 0;
        const structuralFailures = [];
        body.failed.forEach(f => {
          if (!f || !f.key) return;
          const transient = f.transient === true || looksTransient(f.error);
          if (transient) {
            // Don't ban — put it back in the queue so the next flush retries.
            if (!pending.has(f.key) && updatesByKey.has(f.key)) {
              pending.set(f.key, updatesByKey.get(f.key));
            }
            requeuedCount++;
          } else {
            poisonedNow.add(f.key);
            poisonedCount++;
            structuralFailures.push(f);
            console.warn('[sync] poisoning key (structural failure):', f.key, f.error);
          }
        });
        if (poisonedCount) savePoisoned(poisonedNow);
        // A key we just permanently stopped syncing is exactly the thing the
        // user needs told about — /api/sync now rejects oversize writes here.
        if (structuralFailures.length) notifySkipped(structuralFailures);
        if (requeuedCount) {
          console.warn('[sync] ' + requeuedCount + ' key(s) failed transiently — will retry with backoff');
          updateSyncIndicator('error');
          scheduleRetry('partial-transient');
          return;
        }
      }
      // Full success — clear the backoff counter so the next user write
      // syncs with the normal 800ms debounce instead of a stale backoff.
      retryAttempt = 0;
      lastSyncedAt = Date.now();
      updateSyncIndicator('synced');
    } catch (e) {
      console.warn('[sync] failed, will retry with backoff', e);
      for (const u of updates) {
        if (!pending.has(u.key)) pending.set(u.key, u.value);
      }
      updateSyncIndicator('error');
      scheduleRetry('network');
    }
  }
  // When the page returns to the foreground, give sync one immediate retry.
  // Lets the user "wake" the sync sooner than the backoff if e.g. they
  // resolved the Neon quota in another tab and came back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (retryAttempt === 0) return;
    if (pending.size === 0) return;
    console.log('[sync] page visible — resetting backoff and trying once');
    retryAttempt = 0;
    scheduleFlush(0);
  });
  // Debug helpers for the sync poison list.
  window.warroomSyncSkipped = () => lastSkipped;
  window.warroomSyncPoisoned = () => [...loadPoisoned()];
  window.warroomSyncUnpoison = (key) => {
    const s = loadPoisoned();
    if (key) s.delete(key); else s.clear();
    savePoisoned(s);
    console.log('[sync] poisoned now:', [...s]);
  };

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
      if (!res.ok) {
        // Try to read the body so the user gets a useful console message
        // instead of a bare 500/503. Quota errors in particular are easy to
        // miss and lead to mysterious sync silence.
        let detail = null;
        try { detail = await res.json(); } catch {}
        if (detail && detail.quotaExceeded) {
          console.error('[sync] Neon compute quota exceeded — bootstrap aborted. Upgrade the plan or wait for reset; the app will use the last-known localStorage state until sync recovers.');
          // Pre-seat the backoff counter so we don't hammer /api/sync with
          // pre-bootstrap writes immediately. retryAttempt=3 puts the first
          // attempt at the 60s tier of RETRY_DELAYS_MS — visibility-change
          // still lets the user manually wake sync sooner if they resolve
          // the quota and come back to the tab.
          retryAttempt = 3;
        } else if (detail) {
          console.error('[sync] load failed (' + res.status + ')', detail);
        }
        throw new Error('Load failed: ' + res.status);
      }
      const body = await res.json();
      const state = body.state || {};
      // The server reports any keys it refused to return. These are keys the
      // user believes are synced and are NOT — so they get a visible signal,
      // not just a console line nobody reads.
      //
      // Only STRUCTURAL skips get poisoned. This used to poison every skipped
      // key indiscriminately, which is the same class of bug c7e5aa3 fixed on
      // the sync path: a `total-cap` skip is a property of the whole response,
      // not of the key, and load.js orders rows size-ASC so the keys dropped
      // by that cap are the LARGEST ones — the user's real data. Banning those
      // would have silently disabled sync for exactly the keys that matter,
      // permanently, with no way back short of warroomSyncUnpoison().
      lastSkipped = Array.isArray(body.skipped) ? body.skipped : [];
      if (lastSkipped.length) {
        const structural = lastSkipped.filter(s => s && s.key && (s.structural === true || s.reason === 'oversize'));
        const transient  = lastSkipped.filter(s => s && s.key && !(s.structural === true || s.reason === 'oversize'));
        if (structural.length) {
          console.warn('[sync] server refused to return these keys — they are NOT syncing:', structural);
          try {
            const poisonedNow = loadPoisoned();
            structural.forEach(s => poisonedNow.add(s.key));
            savePoisoned(poisonedNow);
          } catch {}
        }
        if (transient.length) {
          console.warn('[sync] keys dropped from this load for response-budget reasons ' +
                       '(NOT poisoned — they should return on the next load):', transient);
        }
        notifySkipped(lastSkipped);
      }

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
      font-family:'Inter',system-ui,sans-serif;font-size:10px;font-weight:700;
      padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;
      opacity:0;transition:opacity .2s ease;pointer-events:none;letter-spacing:.5px;
    `;
    el.textContent = 'SYNCED';
    document.body.appendChild(el);
  }

  function updateSyncIndicator(status) {
    const el = document.getElementById('wr-sync-indicator');
    if (!el) return;
    // Once we know specific keys aren't syncing, routine success must not
    // repaint the badge green. bootstrap() calls updateSyncIndicator('synced')
    // a few lines after reporting skips — without this the user gets a
    // reassuring SYNCED badge while their data silently fails to travel,
    // which is the exact failure this whole change exists to end.
    if (skippedNoticeActive && (status === 'synced' || status === 'syncing')) return;
    const colors = {
      synced:  { bg: 'rgba(22,163,74,.85)',  text: 'SYNCED' },
      syncing: { bg: 'rgba(37,99,235,.85)',  text: 'SYNCING' },
      error:   { bg: 'rgba(220,38,38,.85)',  text: 'SYNC ERR' },
      offline: { bg: 'rgba(107,114,128,.85)',text: 'OFFLINE' },
      partial: { bg: 'rgba(217,119,6,.92)',  text: 'SYNC PARTIAL' }
    };
    const c = colors[status] || colors.synced;
    el.style.background = c.bg;
    el.textContent = c.text;
    el.style.opacity = '1';
    // 'partial' means specific keys are silently not syncing. That's a
    // standing condition, not a moment — leave it on screen and clickable
    // instead of fading it away like a routine status blip.
    if (status === 'partial') {
      el.style.pointerEvents = 'auto';
      el.style.cursor = 'pointer';
      return;
    }
    // Only 'error'/'offline' reach here while a skip notice is up. Show them
    // — they're real — but keep the badge pinned and clickable so the skip
    // details stay reachable rather than fading out behind a transient error.
    if (skippedNoticeActive) return;
    el.style.pointerEvents = 'none';
    el.style.cursor = '';
    setTimeout(() => { el.style.opacity = '0'; }, 1500);
  }

  // ----- Surfacing keys that aren't syncing -----
  // Before this, an oversized key was dropped by /api/load with nothing but a
  // server-side console.warn. The client got no signal at all, so the user saw
  // a green SYNCED badge while a key quietly failed to reach their other
  // devices. Anything the backend refuses now shows up in the UI.
  let skippedNoticeActive = false;
  function describeSkip(s) {
    if (!s || !s.key) return '(unknown key)';
    if (s.reason === 'oversize') {
      const kb = s.bytes ? Math.round(s.bytes / 1024) + 'KB' : 'too large';
      const cap = s.max ? ', cap ' + Math.round(s.max / 1024) + 'KB' : '';
      return s.key + ' — ' + kb + cap;
    }
    if (s.reason === 'total-cap') return s.key + ' — dropped for response size (should return next load)';
    return s.key + ' — ' + (s.reason || s.error || 'refused');
  }
  function notifySkipped(list) {
    if (!Array.isArray(list) || !list.length) return;
    skippedNoticeActive = true;
    const el = document.getElementById('wr-sync-indicator');
    if (el) {
      el.title = 'These keys are NOT syncing across devices:\n' +
                 list.map(s => '• ' + describeSkip(s)).join('\n') +
                 '\n\nClick for details.';
      el.onclick = () => {
        console.group('[sync] keys not syncing');
        list.forEach(s => console.warn(describeSkip(s), s));
        console.groupEnd();
        alert('These keys are not syncing across devices:\n\n' +
              list.map(s => '• ' + describeSkip(s)).join('\n'));
      };
    }
    updateSyncIndicator('partial');
    // Let pages render their own affordance if they want one.
    try {
      document.dispatchEvent(new CustomEvent('warroom:sync-skipped', { detail: { skipped: list } }));
    } catch {}
  }

  // Expose manual logout for UI
  window.warroomLogout = async function() {
    // Logout lives on the login endpoint as DELETE (api/logout.js was folded
    // in to stay under Vercel's function cap).
    await fetch('/api/login', { method: 'DELETE', credentials: 'same-origin' });
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
