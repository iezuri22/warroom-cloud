/* Lofi mini-player — drop-in module any War Room page can include to keep
 * the same vibe playing across navigation. Reads + writes the same
 * `sprint-music-v1` localStorage key sprint.html uses, so the user's chosen
 * vibe + last-known playback position survive the page swap. The audio
 * still has to re-init on each page (browsers tear down iframes on
 * navigation), but the new player picks up the SAME song at the SAME spot.
 *
 * Usage: just `<script defer src="/lofi-player.js"></script>`. The script
 * self-mounts a small floating control in the corner. To suppress on a
 * given page, set `window.__skipLofiPlayer = true` before the script loads.
 */
(function(){
  if (window.__skipLofiPlayer) return;
  // If the page already has its own #musicFrame (sprint.html), defer to it.
  if (document.getElementById('musicFrame')) return;

  // Keep the vibe list in sync with sprint.html's VIBES.
  const VIBES = [
    { id:'hiphop',    label:'Hip-Hop',        videoId:'jfKfPfyJRdk' },
    { id:'anime',     label:'Anime OPs',      videoId:'leg3dJ4Xl_Q' },
    { id:'ghibli',    label:'OPs Extended',   videoId:'GNWLILeztaI' },
    { id:'animehits', label:'Frieren Lofi',   videoId:'eGCLSr2OyaM' },
    { id:'chillhop',  label:'Chillhop',       videoId:'5yx6BWlEVcY' },
    { id:'jazz',      label:'Jazz Lofi',      videoId:'Dx5qFachd3A' },
    { id:'synthwave', label:'Synthwave',      videoId:'4xDzrJKXOOY' },
  ];
  const MUSIC_KEY = 'sprint-music-v1';

  function load(){
    try {
      const d = JSON.parse(localStorage.getItem(MUSIC_KEY) || '{}') || {};
      return {
        vibe: d.vibe || null,
        customId: d.customId || '',
        playbackSec: Number.isFinite(d.playbackSec) ? d.playbackSec : 0,
        updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : 0,
      };
    } catch { return { vibe:null, customId:'', playbackSec:0, updatedAt:0 }; }
  }
  function save(s){ try { localStorage.setItem(MUSIC_KEY, JSON.stringify(s)); } catch {} }

  const state = load();

  function vibeById(id){ return VIBES.find(v => v.id === id); }
  function nextVibeId(cur){
    const i = VIBES.findIndex(v => v.id === cur);
    if (i < 0) return VIBES[0].id;
    return VIBES[(i + 1) % VIBES.length].id;
  }

  // ---- DOM ----
  const root = document.createElement('div');
  root.id = 'lofiMiniPlayer';
  root.innerHTML = `
    <style>
      #lofiMiniPlayer {
        position: fixed; right: 16px; bottom: 16px; z-index: 9999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
        color: #fff; user-select: none;
      }
      #lofiMiniPlayer .lmp-pill {
        display: inline-flex; align-items: center; gap: 8px;
        background: rgba(20, 20, 26, .92);
        border: 1px solid rgba(255,255,255,.12);
        backdrop-filter: blur(14px);
        border-radius: 999px;
        padding: 6px 14px 6px 10px;
        font-size: 12px; font-weight: 700; letter-spacing: .02em;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(0,0,0,.35);
        transition: border-color .15s, background .15s;
      }
      #lofiMiniPlayer .lmp-pill:hover { border-color: rgba(255,255,255,.24) }
      #lofiMiniPlayer .lmp-eq {
        display: inline-flex; align-items: flex-end; gap: 2px; height: 14px;
        opacity: 0; transition: opacity .15s;
      }
      #lofiMiniPlayer.playing .lmp-eq { opacity: 1 }
      #lofiMiniPlayer .lmp-eq span {
        display: block; width: 3px; background: #FF8A3D;
        border-radius: 1.5px;
        animation: lmpEq .9s ease-in-out infinite;
      }
      #lofiMiniPlayer .lmp-eq span:nth-child(1) { height: 80% }
      #lofiMiniPlayer .lmp-eq span:nth-child(2) { height: 50%; animation-delay: .18s }
      #lofiMiniPlayer .lmp-eq span:nth-child(3) { height: 90%; animation-delay: .36s }
      @keyframes lmpEq { 0%, 100% { transform: scaleY(.4) } 50% { transform: scaleY(1) } }
      #lofiMiniPlayer .lmp-label { color: rgba(255,255,255,.85) }
      #lofiMiniPlayer .lmp-stop {
        background: transparent; border: none; color: rgba(255,255,255,.5);
        font-size: 14px; cursor: pointer; padding: 0; line-height: 1;
      }
      #lofiMiniPlayer .lmp-stop:hover { color: #fff }
      #lofiMiniPlayer .lmp-menu {
        position: absolute; right: 0; bottom: 100%;
        margin-bottom: 8px;
        background: rgba(20, 20, 26, .96);
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 12px;
        padding: 6px; min-width: 180px;
        box-shadow: 0 10px 28px rgba(0,0,0,.5);
        backdrop-filter: blur(14px);
        display: none;
      }
      #lofiMiniPlayer.open .lmp-menu { display: block }
      #lofiMiniPlayer .lmp-menu button {
        display: block; width: 100%; text-align: left;
        background: transparent; border: none; color: rgba(255,255,255,.78);
        font: inherit; font-size: 12px; font-weight: 600;
        padding: 7px 10px; border-radius: 8px; cursor: pointer;
      }
      #lofiMiniPlayer .lmp-menu button:hover {
        background: rgba(255,255,255,.06); color: #fff;
      }
      #lofiMiniPlayer .lmp-menu button.active {
        background: rgba(255,138,61,.16); color: #FF8A3D;
      }
      /* Hidden audio frame — positioned 1x1 offscreen so it actually plays. */
      #lmpFrame {
        position: fixed; left: -9999px; top: -9999px;
        width: 1px; height: 1px; border: 0;
      }
    </style>
    <div class="lmp-pill" id="lmpPill">
      <span class="lmp-eq" aria-hidden="true"><span></span><span></span><span></span></span>
      <span class="lmp-label" id="lmpLabel">🎵 Lofi</span>
      <button class="lmp-stop" id="lmpStop" title="Stop">✕</button>
    </div>
    <div class="lmp-menu" id="lmpMenu" role="menu"></div>
  `;
  document.body.appendChild(root);

  const frame = document.createElement('iframe');
  frame.id = 'lmpFrame';
  frame.allow = 'autoplay; encrypted-media';
  frame.src = 'about:blank';
  document.body.appendChild(frame);

  const pill = root.querySelector('#lmpPill');
  const menu = root.querySelector('#lmpMenu');
  const lblEl = root.querySelector('#lmpLabel');
  const stopBtn = root.querySelector('#lmpStop');

  function renderMenu(){
    menu.innerHTML = VIBES.map(v =>
      `<button data-vibe="${v.id}" class="${state.vibe === v.id ? 'active' : ''}">${v.label}</button>`
    ).join('');
    menu.querySelectorAll('button[data-vibe]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        playVibe(b.dataset.vibe);
        root.classList.remove('open');
      });
    });
  }
  function setLabel(){
    if (state.vibe) {
      const v = vibeById(state.vibe);
      lblEl.textContent = v ? v.label : '🎵 Lofi';
      root.classList.add('playing');
    } else if (state.customId) {
      lblEl.textContent = '🎵 Custom';
      root.classList.add('playing');
    } else {
      lblEl.textContent = '🎵 Lofi';
      root.classList.remove('playing');
    }
    stopBtn.style.display = (state.vibe || state.customId) ? '' : 'none';
  }

  function playVideoId(videoId, vibeId){
    if (!videoId) return;
    const wasSame = (vibeId && state.vibe === vibeId) || (!vibeId && state.customId === videoId);
    state.vibe = vibeId || null;
    state.customId = vibeId ? '' : videoId;
    save(state);
    let startAt;
    if (wasSame && state.playbackSec > 0) {
      const drift = Math.max(0, Math.floor((Date.now() - (state.updatedAt || Date.now())) / 1000));
      startAt = Math.max(0, Math.floor(state.playbackSec + drift));
    } else {
      startAt = 60 + Math.floor(Math.random() * 1440);
      state.playbackSec = startAt;
      state.updatedAt = Date.now();
      save(state);
    }
    const origin = encodeURIComponent(window.location.origin);
    frame.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&modestbranding=1&rel=0&mute=0&start=${startAt}&enablejsapi=1&origin=${origin}`;
    setLabel();
    renderMenu();
  }
  function playVibe(vibeId){
    const v = vibeById(vibeId);
    if (!v) return;
    playVideoId(v.videoId, vibeId);
  }
  function stopMusic(){
    state.vibe = null;
    state.customId = '';
    state.playbackSec = 0;
    state.updatedAt = Date.now();
    save(state);
    frame.src = 'about:blank';
    setLabel();
    renderMenu();
    stopPolling();
  }

  // Position polling — same protocol sprint.html uses, same MUSIC_KEY.
  let poll = null;
  function startPolling(){
    if (poll) clearInterval(poll);
    poll = setInterval(() => {
      try {
        if (!frame.src || frame.src === 'about:blank') return;
        frame.contentWindow && frame.contentWindow.postMessage(
          JSON.stringify({ event:'command', func:'getCurrentTime', args:[] }), '*');
      } catch {}
    }, 5000);
  }
  function stopPolling(){ if (poll) { clearInterval(poll); poll = null; } }

  // Listen for YT API events: ENDED → rotate. infoDelivery.currentTime → persist.
  window.addEventListener('message', (ev) => {
    if (!ev || !ev.data) return;
    let p = ev.data;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return; } }
    if (!p) return;
    if (p.event === 'infoDelivery' && p.info && typeof p.info.currentTime === 'number') {
      const t = p.info.currentTime;
      if (Number.isFinite(t) && t >= 0) {
        state.playbackSec = t;
        state.updatedAt = Date.now();
        save(state);
      }
      return;
    }
    if (p.event === 'onStateChange' && p.info === 0) {
      if (!state.vibe && !state.customId) return;
      state.playbackSec = 0;
      state.updatedAt = Date.now();
      save(state);
      playVibe(nextVibeId(state.vibe));
    }
  });
  frame.addEventListener('load', () => {
    try {
      if (frame.src && frame.src !== 'about:blank' && frame.contentWindow) {
        frame.contentWindow.postMessage(
          JSON.stringify({ event:'listening', id:'lofi-mini' }), '*');
        startPolling();
      } else {
        stopPolling();
      }
    } catch {}
  });

  // Flush position on unload/hide so a navigation captures the latest second.
  function flush(){
    try {
      if (frame.src && frame.src !== 'about:blank' && frame.contentWindow) {
        frame.contentWindow.postMessage(
          JSON.stringify({ event:'command', func:'getCurrentTime', args:[] }), '*');
      }
    } catch {}
  }
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  // Cross-tab updates — another tab swapped vibes or stopped music.
  window.addEventListener('storage', (e) => {
    if (e.key !== MUSIC_KEY) return;
    try {
      const d = JSON.parse(e.newValue || '{}') || {};
      state.vibe = d.vibe || null;
      state.customId = d.customId || '';
      state.playbackSec = Number.isFinite(d.playbackSec) ? d.playbackSec : 0;
      state.updatedAt = Number.isFinite(d.updatedAt) ? d.updatedAt : 0;
      setLabel();
      renderMenu();
    } catch {}
  });

  // Pill click toggles the menu; click outside closes.
  pill.addEventListener('click', (e) => {
    if (e.target === stopBtn) return;
    root.classList.toggle('open');
  });
  stopBtn.addEventListener('click', (e) => { e.stopPropagation(); stopMusic(); });
  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) root.classList.remove('open');
  });

  setLabel();
  renderMenu();

  // Resume on load: if there's a saved vibe, queue it and wait for the first
  // user gesture (browsers block autoplay before interaction). Same pattern
  // sprint.html uses.
  if (state.vibe || state.customId) {
    const resume = () => {
      try {
        if (state.customId) playVideoId(state.customId, null);
        else if (state.vibe) playVibe(state.vibe);
      } catch {}
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      document.removeEventListener('touchstart', resume, true);
    };
    // Try a no-gesture autoplay first — works if the origin already has
    // user-activation persistence; otherwise the gesture listeners catch it.
    try {
      if (state.customId) playVideoId(state.customId, null);
      else if (state.vibe) playVibe(state.vibe);
    } catch {}
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
    document.addEventListener('touchstart', resume, true);
  }
})();
