/* Lofi player — drop-in script that mounts the SAME music bar sprint.html
 * uses on any other War Room page. Same vibes, same layout (EQ + chips +
 * custom row + stop), same MUSIC_KEY for state, same YT IFrame API plumbing
 * for position tracking + cross-page resume. Self-mounts at the top of
 * <body>; no markup needed in the host page.
 *
 * To suppress on a page that already has its own music bar (sprint.html):
 *   - The host page declares an element with id="musicFrame" (sprint does),
 *     OR
 *   - Sets window.__skipLofiPlayer = true before this script loads.
 */
(function(){
  if (window.__skipLofiPlayer) return;
  if (document.getElementById('musicFrame')) return; // Sprint already has one.
  // Running inside the daily-planner shell? Defer to the shell's persistent
  // engine — the shell keeps a music iframe alive across tab switches so the
  // song doesn't skip a beat. Mounting our own player here would double up.
  try { if (window.self !== window.top) return; } catch { return; }

  // Vibes mirror sprint.html's VIBES (id, label, videoId).
  const VIBES = [
    { id:'hiphop',    label:'Hip-Hop',        videoId:'jfKfPfyJRdk' },
    { id:'anime',     label:'Anime Openings', videoId:'leg3dJ4Xl_Q' },
    { id:'ghibli',    label:'OPs Extended',   videoId:'GNWLILeztaI' },
    { id:'animehits', label:'Frieren Lofi',   videoId:'eGCLSr2OyaM' },
    { id:'chillhop',  label:'Chillhop',       videoId:'5yx6BWlEVcY' },
    { id:'jazz',      label:'Jazz Lofi',      videoId:'Dx5qFachd3A' },
    { id:'synthwave', label:'Synthwave',      videoId:'4xDzrJKXOOY' },
  ];
  const MUSIC_KEY = 'sprint-music-v1';

  const musicState = (function(){
    try {
      const d = JSON.parse(localStorage.getItem(MUSIC_KEY) || '{}') || {};
      return {
        vibe: d.vibe || null,
        customId: d.customId || '',
        playbackSec: Number.isFinite(d.playbackSec) ? d.playbackSec : 0,
        updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : 0,
      };
    } catch { return { vibe:null, customId:'', playbackSec:0, updatedAt:0 }; }
  })();
  function saveMusicState(){ try { localStorage.setItem(MUSIC_KEY, JSON.stringify(musicState)); } catch {} }

  // ---- CSS — explicit colors so it renders identically on any host page,
  // independent of the host's CSS variables. Theme-aware: hosts that declare
  // color-scheme:light (the Soft Light pages) get the light palette; sprint
  // and other dark hosts keep the original dark look. ----
  const WR_LIGHT = /light/i.test((() => { try { return getComputedStyle(document.documentElement).colorScheme || ''; } catch { return ''; } })());
  const P = WR_LIGHT ? {
    wrapBg: 'rgba(246,245,241,.88)', barBg: '#FFFFFF', barBgPlaying: 'rgba(240,126,40,.07)',
    line: 'rgba(33,30,25,.10)', line2: 'rgba(33,30,25,.20)',
    ink: '#211E19', inkMid: 'rgba(33,30,25,.78)', inkDim: 'rgba(33,30,25,.40)',
    accent: '#F07E28', accentSoft: 'rgba(240,126,40,.14)', onAccent: '#FFF7EF',
    field: 'rgba(33,30,25,.05)'
  } : {
    wrapBg: 'rgba(5,5,7,.85)', barBg: '#0E0E13', barBgPlaying: 'rgba(255,138,61,.10)',
    line: 'rgba(255,255,255,.10)', line2: 'rgba(255,255,255,.20)',
    ink: '#fff', inkMid: 'rgba(255,255,255,.78)', inkDim: 'rgba(255,255,255,.36)',
    accent: '#FF8A3D', accentSoft: 'rgba(255,138,61,.18)', onAccent: '#050507',
    field: '#15151B'
  };
  const style = document.createElement('style');
  style.textContent = `
    .wr-music-wrap {
      position: sticky; top: 0; z-index: 50;
      padding: 8px 14px 0;
      background: ${P.wrapBg}; backdrop-filter: blur(14px);
    }
    .wr-music-bar {
      display:flex; align-items:center; gap:10px;
      padding:8px 14px; flex-shrink:0;
      background:${P.barBg}; border:1px solid ${P.line}; border-radius:12px;
    }
    .wr-music-bar.playing {
      border-color:${P.accent}80;
      background:${P.barBgPlaying};
    }
    .wr-music-eq {
      display:inline-flex; align-items:flex-end; gap:2px; height:14px; flex-shrink:0;
      opacity:.5;
    }
    .wr-music-bar.playing .wr-music-eq { opacity:1 }
    .wr-music-eq span {
      width:3px; background:${P.accent}; border-radius:2px; height:30%;
      animation:wrEqBounce .9s ease-in-out infinite;
    }
    .wr-music-eq span:nth-child(2) { animation-delay:.18s; height:60% }
    .wr-music-eq span:nth-child(3) { animation-delay:.36s; height:90% }
    .wr-music-eq span:nth-child(4) { animation-delay:.54s; height:50% }
    @keyframes wrEqBounce { 0%,100% { transform:scaleY(.4) } 50% { transform:scaleY(1) } }
    .wr-music-label {
      font-size:10.5px; font-weight:900; letter-spacing:1.6px; text-transform:uppercase;
      color:${P.inkDim}; flex-shrink:0;
    }
    .wr-music-vibes {
      display:flex; gap:5px; flex-wrap:wrap; flex:1; min-width:0;
    }
    .wr-vibe-chip {
      background:transparent; border:1px solid ${P.line}; border-radius:99px;
      padding:5px 11px; cursor:pointer; font-family:inherit; font-size:11px; font-weight:800;
      letter-spacing:.4px; color:${P.inkMid}; transition:all .12s; white-space:nowrap;
    }
    .wr-vibe-chip:hover { color:${P.ink}; border-color:${P.line2} }
    .wr-vibe-chip.active {
      background:${P.accentSoft}; border-color:${P.accent}; color:${P.accent};
    }
    .wr-music-actions { display:flex; gap:6px; flex-shrink:0 }
    .wr-music-actions button {
      background:${P.field}; border:1px solid ${P.line}; border-radius:8px;
      width:28px; height:28px; cursor:pointer; color:${P.inkMid};
      display:inline-flex; align-items:center; justify-content:center; transition:all .12s;
    }
    .wr-music-actions button:hover { color:${P.ink}; border-color:${P.line2} }
    .wr-music-actions button.active {
      color:${P.accent}; border-color:${P.accent}; background:${P.accentSoft};
    }
    .wr-music-custom {
      display:none; gap:8px; align-items:center;
      margin-top:6px; padding:8px 12px;
      background:${P.barBg}; border:1px solid ${P.line}; border-radius:10px;
    }
    .wr-music-custom.show { display:flex }
    .wr-music-custom label {
      font-size:10px; font-weight:900; letter-spacing:1.4px; text-transform:uppercase;
      color:${P.inkDim}; flex-shrink:0;
    }
    .wr-music-custom input {
      flex:1; min-width:0;
      background:${P.field}; border:1px solid ${P.line};
      border-radius:8px; padding:8px 12px; font-family:inherit; font-size:13px;
      color:${P.ink}; outline:none;
    }
    .wr-music-custom input:focus { border-color:${P.accent} }
    .wr-music-custom button {
      background:${P.accent}; color:${P.onAccent}; border:none; border-radius:8px;
      padding:8px 14px; font-family:inherit; font-size:11.5px; font-weight:900;
      letter-spacing:.6px; text-transform:uppercase; cursor:pointer; transition:opacity .12s;
    }
    .wr-music-custom button:hover { opacity:.9 }
    .wr-music-custom button.clear {
      background:transparent; border:1px solid ${P.line2}; color:${P.inkMid};
    }
    .wr-music-custom button.clear:hover { color:#f87171; border-color:#f87171; opacity:1 }
    @media (max-width:560px) {
      .wr-music-custom label { display:none }
    }
    .wr-music-audio-frame {
      position:fixed; left:-9999px; top:0; width:320px; height:180px;
      border:0; pointer-events:none;
    }
  `;
  document.head.appendChild(style);

  // ---- DOM ----
  const wrap = document.createElement('div');
  wrap.className = 'wr-music-wrap';
  wrap.innerHTML = `
    <div class="wr-music-bar" id="wrMusicBar">
      <span class="wr-music-eq" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
      <span class="wr-music-label">Vibe</span>
      <div class="wr-music-vibes" id="wrMusicVibes"></div>
      <div class="wr-music-actions">
        <button id="wrMusicCustomBtn" title="Custom YouTube ID" aria-label="Toggle custom video ID input">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button id="wrMusicStopBtn" title="Stop music" aria-label="Stop music">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        </button>
      </div>
    </div>
    <div class="wr-music-custom" id="wrMusicCustom">
      <label>Custom</label>
      <input type="text" id="wrMusicCustomInput" placeholder="YouTube URL or video ID" autocomplete="off" spellcheck="false">
      <button id="wrMusicCustomPlayBtn">Play</button>
      <button id="wrMusicCustomClearBtn" class="clear" title="Clear">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <iframe id="wrMusicFrame" class="wr-music-audio-frame" src="about:blank" allow="autoplay; encrypted-media" title="Lofi music"></iframe>
  `;
  document.body.insertBefore(wrap, document.body.firstChild);

  const musicBar          = document.getElementById('wrMusicBar');
  const musicVibesEl      = document.getElementById('wrMusicVibes');
  const musicFrame        = document.getElementById('wrMusicFrame');
  const musicStopBtn      = document.getElementById('wrMusicStopBtn');
  const musicCustomBtn    = document.getElementById('wrMusicCustomBtn');
  const musicCustomEl     = document.getElementById('wrMusicCustom');
  const musicCustomInput  = document.getElementById('wrMusicCustomInput');
  const musicCustomPlayBtn= document.getElementById('wrMusicCustomPlayBtn');
  const musicCustomClearBtn = document.getElementById('wrMusicCustomClearBtn');

  function escapeHtml(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function renderVibeChips(){
    musicVibesEl.innerHTML = VIBES.map(v => `
      <button class="wr-vibe-chip ${musicState.vibe===v.id?'active':''}" data-vibe="${v.id}">${escapeHtml(v.label)}</button>
    `).join('');
    musicVibesEl.querySelectorAll('.wr-vibe-chip').forEach(el => {
      el.addEventListener('click', () => {
        const vid = el.dataset.vibe;
        if (musicState.vibe === vid) { stopMusic(); return; }
        playVibe(vid);
      });
    });
  }
  function applyMusicUI(){
    musicBar.classList.toggle('playing', !!musicState.vibe);
    renderVibeChips();
  }

  function parseYouTubeId(raw){
    const s = (raw || '').trim();
    if (!s) return '';
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    const m = s.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|shorts\/|v\/))([A-Za-z0-9_-]{11})/);
    return m ? m[1] : '';
  }
  function nextVibeId(currentId){
    const i = VIBES.findIndex(v => v.id === currentId);
    if (i === -1) return VIBES[0].id;
    return VIBES[(i + 1) % VIBES.length].id;
  }

  function playVideoId(videoId, vibeId){
    if (!videoId) return;
    const wasSame = (vibeId && musicState.vibe === vibeId) || (!vibeId && musicState.customId === videoId);
    musicState.vibe = vibeId || null;
    musicState.customId = vibeId ? '' : videoId;
    saveMusicState();
    let startAt;
    if (wasSame && musicState.playbackSec > 0) {
      const drift = Math.max(0, Math.floor((Date.now() - (musicState.updatedAt || Date.now())) / 1000));
      startAt = Math.max(0, Math.floor(musicState.playbackSec + drift));
    } else {
      startAt = 60 + Math.floor(Math.random() * 1440);
      musicState.playbackSec = startAt;
      musicState.updatedAt = Date.now();
      saveMusicState();
    }
    const origin = encodeURIComponent(window.location.origin);
    musicFrame.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&modestbranding=1&rel=0&mute=0&start=${startAt}&enablejsapi=1&origin=${origin}`;
    applyMusicUI();
  }
  function playVibe(vibeId){
    const v = VIBES.find(x => x.id === vibeId);
    if (!v) return;
    playVideoId(v.videoId, vibeId);
  }
  function playCustom(){
    const id = parseYouTubeId(musicCustomInput.value || '');
    if (!id) {
      musicCustomInput.style.borderColor = '#f87171';
      setTimeout(() => { musicCustomInput.style.borderColor = ''; }, 1200);
      return;
    }
    playVideoId(id, null);
  }
  function stopMusic(){
    musicState.vibe = null;
    musicState.customId = '';
    musicState.playbackSec = 0;
    musicState.updatedAt = Date.now();
    saveMusicState();
    musicFrame.src = 'about:blank';
    stopPolling();
    applyMusicUI();
  }
  function toggleCustomRow(){
    musicCustomEl.classList.toggle('show');
    musicCustomBtn.classList.toggle('active', musicCustomEl.classList.contains('show'));
    if (musicCustomEl.classList.contains('show')) {
      setTimeout(() => musicCustomInput.focus(), 30);
    }
  }

  // YT API listener: rotate on ENDED, persist on infoDelivery.currentTime.
  window.addEventListener('message', (ev) => {
    if (!ev || !ev.data) return;
    let payload = ev.data;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { return; } }
    if (!payload) return;
    if (payload.event === 'infoDelivery' && payload.info && typeof payload.info.currentTime === 'number') {
      const t = payload.info.currentTime;
      if (Number.isFinite(t) && t >= 0) {
        musicState.playbackSec = t;
        musicState.updatedAt = Date.now();
        saveMusicState();
      }
      return;
    }
    if (payload.event !== 'onStateChange') return;
    if (payload.info !== 0) return;
    if (!musicState.vibe && !musicState.customId) return;
    musicState.playbackSec = 0;
    musicState.updatedAt = Date.now();
    saveMusicState();
    playVibe(nextVibeId(musicState.vibe));
  });

  let pollTimer = null;
  function startPolling(){
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      try {
        if (!musicFrame.src || musicFrame.src === 'about:blank') return;
        musicFrame.contentWindow && musicFrame.contentWindow.postMessage(
          JSON.stringify({ event:'command', func:'getCurrentTime', args:[] }), '*');
      } catch {}
    }, 5000);
  }
  function stopPolling(){ if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function bindYtListening(){
    try {
      if (musicFrame.src && musicFrame.src !== 'about:blank' && musicFrame.contentWindow) {
        musicFrame.contentWindow.postMessage(
          JSON.stringify({ event:'listening', id:'lofi-player' }), '*');
        startPolling();
      } else {
        stopPolling();
      }
    } catch {}
  }
  musicFrame.addEventListener('load', bindYtListening);

  // Flush position on unload / hide / visibility change.
  function flush(){
    try {
      if (musicFrame.src && musicFrame.src !== 'about:blank' && musicFrame.contentWindow) {
        musicFrame.contentWindow.postMessage(
          JSON.stringify({ event:'command', func:'getCurrentTime', args:[] }), '*');
      }
    } catch {}
  }
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  // Cross-tab sync: another tab changed vibe? Reflect it.
  window.addEventListener('storage', (e) => {
    if (e.key !== MUSIC_KEY) return;
    try {
      const d = JSON.parse(e.newValue || '{}') || {};
      musicState.vibe = d.vibe || null;
      musicState.customId = d.customId || '';
      musicState.playbackSec = Number.isFinite(d.playbackSec) ? d.playbackSec : 0;
      musicState.updatedAt = Number.isFinite(d.updatedAt) ? d.updatedAt : 0;
      applyMusicUI();
    } catch {}
  });

  // Wiring
  musicStopBtn.addEventListener('click', stopMusic);
  musicCustomBtn.addEventListener('click', toggleCustomRow);
  musicCustomPlayBtn.addEventListener('click', playCustom);
  musicCustomClearBtn.addEventListener('click', () => {
    musicCustomInput.value = '';
    musicCustomInput.focus();
  });
  musicCustomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); playCustom(); }
  });

  if (musicState.customId && musicCustomInput) musicCustomInput.value = musicState.customId;
  applyMusicUI();

  // Resume on page load: best-effort autoplay (works if browser already trusts
  // the origin), then a one-shot interaction listener to handle the autoplay
  // refusal case. Same pattern sprint.html uses.
  if (musicState.vibe || musicState.customId) {
    const resume = () => {
      try {
        if (musicState.customId) playVideoId(musicState.customId, null);
        else if (musicState.vibe) playVibe(musicState.vibe);
      } catch {}
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      document.removeEventListener('touchstart', resume, true);
    };
    try { resume(); } catch {} // best effort autoplay
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
    document.addEventListener('touchstart', resume, true);
  }
})();
