// RÉQ — Radios Étudiantes du Québec

// Optional CORS proxy for HTTP→HTTPS streams (deploy proxy/cloudflare-worker.js to Cloudflare).
// Leave '' to use direct streams.
const PROXY_BASE = '';

function getPlayableStream(radio) {
  if (!radio?.stream) return null;
  const url = radio.stream;
  // HTTP stream on HTTPS page → blocked by browser; treat as no stream unless proxy is set
  if (url.startsWith('http:') && location.protocol === 'https:' && !PROXY_BASE) return null;
  if (!PROXY_BASE) return url;
  return `${PROXY_BASE}/?url=${encodeURIComponent(url)}`;
}

// ─── DOM refs ───────────────────────────────────────────────────────────────
const GRID             = document.getElementById('radios-grid');
const TYPE_FILTERS     = document.getElementById('type-filters');
const REGION_CONTAINER = document.getElementById('region-filters');
const RESULTS_COUNT    = document.getElementById('results-count');
const EMPTY            = document.getElementById('empty-state');
const CLEAR_BTN        = document.getElementById('clear-filters');
const RANDOM_BTN       = document.getElementById('random-btn');
const MODAL            = document.getElementById('modal');
const MODAL_PANEL      = document.getElementById('modal-panel');
const INSTALL_BTN      = document.getElementById('install-button');
const TOAST_EL         = document.getElementById('toast');
// Player bar
const PLAYER_BAR       = document.getElementById('player-bar');
const PB_STATION_BTN   = document.getElementById('pb-station-btn');
const PB_LOGO_WRAP     = document.getElementById('pb-logo-wrap');
const PB_NAME          = document.getElementById('pb-name');
const PB_SUB           = document.getElementById('pb-sub');
const PB_PLAY          = document.getElementById('pb-play');
const PB_PAUSE         = document.getElementById('pb-pause');
const PB_BACK          = document.getElementById('pb-back');
const PB_FWD           = document.getElementById('pb-fwd');
const PB_VOLUME        = document.getElementById('pb-volume');
const PB_CLOSE         = document.getElementById('pb-close');
const PB_EQ            = document.getElementById('pb-eq');
// Sections + news
const SECTION_NAV      = document.getElementById('section-nav');
const SECTION_RADIOS   = document.getElementById('section-radios');
const SECTION_NEWS     = document.getElementById('section-news');
const NEWS_GRID        = document.getElementById('news-grid');
const NEWS_FILTERS     = document.getElementById('news-filters');
const NEWS_COUNT       = document.getElementById('news-count');
const NEWS_UPDATED     = document.getElementById('news-updated');
const NEWS_EMPTY       = document.getElementById('news-empty');

// ─── State ──────────────────────────────────────────────────────────────────
let radios = [];
let news = [];
let newsLoaded = false;
let newsSourceFilter = 'all';
let currentFilters = { type: 'all', regions: new Set(), showFavorites: false };
let currentRadio   = null; // radio shown in modal
let playingRadio   = null; // radio currently loaded in audio element
let audio          = null;
let deferredInstallPrompt = null;

// ─── Bootstrap ──────────────────────────────────────────────────────────────
init();

async function init() {
  try {
    const res = await fetch('./radios.json');
    radios = await res.json();
  } catch (e) {
    console.error('Failed to load radios.json', e);
    radios = [];
  }

  renderRegions();
  bindFilters();
  bindGlobalActions();
  bindSectionNav();
  renderGrid();
  bindInstallFlow();
  setupAudio();
  bindPlayerBar();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !MODAL.classList.contains('hidden')) {
      closeModal();
    }
  });

  MODAL.addEventListener('click', (e) => {
    if (e.target === MODAL) closeModal();
  });
}

// ─── Regions ────────────────────────────────────────────────────────────────
function renderRegions() {
  const regions = [...new Set(radios.map(r => r.region))].sort();
  REGION_CONTAINER.innerHTML = '';

  const allPill = createRegionPill('Toutes les régions', true);
  allPill.onclick = () => {
    currentFilters.regions.clear();
    updateRegionPills();
    renderGrid();
  };
  REGION_CONTAINER.appendChild(allPill);

  regions.forEach(region => {
    const pill = createRegionPill(region);
    pill.onclick = () => {
      if (currentFilters.regions.has(region)) {
        currentFilters.regions.delete(region);
      } else {
        currentFilters.regions.add(region);
      }
      updateRegionPills();
      renderGrid();
    };
    REGION_CONTAINER.appendChild(pill);
  });
}

function createRegionPill(label, isAll = false) {
  const el = document.createElement('div');
  el.className = `region-pill ${isAll ? 'active' : ''}`;
  el.textContent = label;
  el.dataset.region = isAll ? 'all' : label;
  return el;
}

function updateRegionPills() {
  [...REGION_CONTAINER.children].forEach(pill => {
    const r = pill.dataset.region;
    if (r === 'all') {
      pill.classList.toggle('active', currentFilters.regions.size === 0);
    } else {
      pill.classList.toggle('active', currentFilters.regions.has(r));
    }
  });
}

// ─── Filters ────────────────────────────────────────────────────────────────
function bindFilters() {
  TYPE_FILTERS.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.id === 'fav-filter-btn') {
        currentFilters.showFavorites = !currentFilters.showFavorites;
        btn.classList.toggle('active', currentFilters.showFavorites);
        renderGrid();
        return;
      }
      TYPE_FILTERS.querySelectorAll('button').forEach(b => {
        if (b.id !== 'fav-filter-btn') b.classList.remove('active');
      });
      btn.classList.add('active');
      currentFilters.type = btn.dataset.type;
      currentFilters.showFavorites = false;
      document.getElementById('fav-filter-btn')?.classList.remove('active');
      renderGrid();
    });
  });

  CLEAR_BTN?.addEventListener('click', resetFilters);
}

function resetFilters() {
  currentFilters = { type: 'all', regions: new Set(), showFavorites: false };
  TYPE_FILTERS.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  TYPE_FILTERS.querySelector('[data-type="all"]').classList.add('active');
  document.getElementById('fav-filter-btn')?.classList.remove('active');
  updateRegionPills();
  renderGrid();
}

// ─── Filtering logic ─────────────────────────────────────────────────────────
function getFilteredRadios() {
  const favs = getFavorites();
  return radios.filter(r => {
    const matchesType = currentFilters.type === 'all' || r.type === currentFilters.type;
    const matchesRegion = currentFilters.regions.size === 0 || currentFilters.regions.has(r.region);
    const matchesFav = !currentFilters.showFavorites || favs.includes(r.id);
    return matchesType && matchesRegion && matchesFav;
  });
}

// ─── Grid ───────────────────────────────────────────────────────────────────
function renderGrid() {
  const filtered = getFilteredRadios();
  GRID.innerHTML = '';
  EMPTY.classList.toggle('hidden', filtered.length > 0);
  RESULTS_COUNT.textContent = `${filtered.length} radio${filtered.length !== 1 ? 's' : ''}`;
  filtered.forEach(radio => GRID.appendChild(createRadioCard(radio)));
}

function createRadioCard(radio) {
  const el = document.createElement('div');
  const hasStream = !!getPlayableStream(radio);
  const isFav = getFavorites().includes(radio.id);
  const isCurrentlyPlaying = playingRadio?.id === radio.id && audio && !audio.paused;

  el.className = `radio-card glass flex flex-col gap-3 rounded-3xl p-4 cursor-pointer border border-white/10 ${isCurrentlyPlaying ? 'is-playing-card' : ''}`;
  el.dataset.radioId = radio.id;

  const logoHtml = radio.logo
    ? `<img src="${radio.logo}" alt="${radio.name}" class="station-logo" loading="lazy" onerror="this.replaceWith(makeBadge('${radio.id}','${getInitials(radio.name)}'))">`
    : `<div class="logo-badge ${radio.id} h-[52px] w-[52px] text-base">${getInitials(radio.name)}</div>`;

  el.innerHTML = `
    <div class="flex items-start gap-3">
      ${logoHtml}
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="font-semibold text-[17px] leading-tight tracking-tight">${radio.name}</div>
            <div class="mt-0.5 text-xs text-white/55">${radio.frequency} · ${radio.city}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0 mt-0.5">
            ${hasStream ? `<div class="live-pill">DIRECT</div>` : ''}
            <span class="fav-star text-base leading-none transition-colors ${isFav ? 'text-rose-400' : 'text-white/25 hover:text-white/50'}">♥</span>
          </div>
        </div>
        <div class="mt-1.5 text-xs text-white/65 line-clamp-1 leading-snug">${radio.institution}</div>
      </div>
    </div>

    <div class="flex items-center justify-between pt-0.5">
      <span class="rounded-full bg-white/[0.06] border border-white/[0.07] px-2.5 py-0.5 text-[11px] text-white/55">
        ${radio.type === 'universite' ? 'Université' : 'Cégep'}
      </span>
      <div class="flex items-center gap-1.5">
        <button class="listen-btn px-3 py-1.5 text-xs font-semibold rounded-2xl border border-white/15 bg-white/[0.06] hover:bg-white/[0.1] active:scale-95 transition"
                data-action="listen">
          ${hasStream ? '▶ Écouter' : 'Site →'}
        </button>
        <button class="px-2.5 py-1.5 text-xs font-medium rounded-2xl border border-white/10 hover:bg-white/[0.06] active:scale-95 transition" data-action="details">
          Infos
        </button>
      </div>
    </div>
  `;

  // Card body → open modal
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-action]') || e.target.closest('.fav-star')) return;
    openModal(radio);
  });

  // Favorite star on card
  el.querySelector('.fav-star').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(radio.id);
    renderGrid();
  });

  // Listen / site button
  el.querySelector('[data-action="listen"]').addEventListener('click', (e) => {
    e.stopPropagation();
    const playable = getPlayableStream(radio);
    if (playable) {
      openModal(radio, true);
    } else {
      window.open(radio.website, '_blank');
    }
  });

  // Details button
  el.querySelector('[data-action="details"]').addEventListener('click', (e) => {
    e.stopPropagation();
    openModal(radio);
  });

  return el;
}

function getInitials(name) {
  return name.split(/[\s.-]+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

// For onerror fallback in img tags (must be global)
window.makeBadge = (id, initials) => {
  const div = document.createElement('div');
  div.className = `logo-badge ${id} h-[52px] w-[52px] text-base`;
  div.textContent = initials;
  return div;
};

// ─── Global actions ──────────────────────────────────────────────────────────
function bindGlobalActions() {
  RANDOM_BTN.addEventListener('click', () => {
    if (!radios.length) return;
    const filtered = getFilteredRadios();
    const pool = filtered.length ? filtered : radios;
    openModal(pool[Math.floor(Math.random() * pool.length)]);
  });
}

// ─── Section navigation (Radios / Actualités) ─────────────────────────────────
function bindSectionNav() {
  SECTION_NAV?.querySelectorAll('.section-tab').forEach(tab => {
    tab.addEventListener('click', () => switchSection(tab.dataset.section));
  });
}

function switchSection(section) {
  SECTION_NAV.querySelectorAll('.section-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.section === section)
  );
  SECTION_RADIOS.classList.toggle('hidden', section !== 'radios');
  SECTION_NEWS.classList.toggle('hidden', section !== 'news');

  if (section === 'news' && !newsLoaded) loadNews();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── News feed ────────────────────────────────────────────────────────────────
async function loadNews() {
  newsLoaded = true;
  NEWS_GRID.innerHTML = newsSkeleton(6);
  try {
    const res = await fetch('./news.json', { cache: 'no-cache' });
    const data = await res.json();
    news = Array.isArray(data) ? data : (data.items || []);
    if (data.updated) {
      const d = new Date(data.updated);
      NEWS_UPDATED.textContent = `mis à jour le ${d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'long' })}`;
    }
  } catch (e) {
    console.error('Failed to load news.json', e);
    news = [];
  }
  renderNewsFilters();
  renderNews();
}

function newsSkeleton(n) {
  return Array.from({ length: n }).map(() => `
    <div class="news-card news-skeleton">
      <div class="news-thumb skel"></div>
      <div class="news-body">
        <div class="skel-line w-1/3"></div>
        <div class="skel-line w-full"></div>
        <div class="skel-line w-4/5"></div>
      </div>
    </div>`).join('');
}

function renderNewsFilters() {
  const sources = [...new Set(news.map(n => n.source))];
  // Remove any previously injected source pills (keep the "all" button)
  [...NEWS_FILTERS.querySelectorAll('[data-source]:not([data-source="all"])')].forEach(b => b.remove());

  sources.forEach(src => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.dataset.source = src;
    btn.textContent = src;
    NEWS_FILTERS.appendChild(btn);
  });

  NEWS_FILTERS.querySelectorAll('.filter-btn').forEach(btn => {
    btn.onclick = () => {
      newsSourceFilter = btn.dataset.source;
      NEWS_FILTERS.querySelectorAll('.filter-btn').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      renderNews();
    };
  });
}

function renderNews() {
  const items = newsSourceFilter === 'all'
    ? news
    : news.filter(n => n.source === newsSourceFilter);

  NEWS_EMPTY.classList.toggle('hidden', items.length > 0);
  NEWS_COUNT.textContent = `${items.length} article${items.length !== 1 ? 's' : ''}`;
  NEWS_GRID.innerHTML = '';
  items.forEach(item => NEWS_GRID.appendChild(createNewsCard(item)));
}

function createNewsCard(item) {
  const a = document.createElement('a');
  a.className = 'news-card glass';
  a.href = item.link;
  a.target = '_blank';
  a.rel = 'noopener';

  const dateStr = item.date
    ? new Date(item.date).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  const thumb = item.image
    ? `<div class="news-thumb"><img src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.closest('.news-thumb').classList.add('news-thumb--empty')"></div>`
    : `<div class="news-thumb news-thumb--empty"></div>`;

  a.innerHTML = `
    ${thumb}
    <div class="news-body">
      <div class="news-meta">
        <span class="news-source">${escapeHtml(item.source)}</span>
        ${dateStr ? `<span class="news-date">${dateStr}</span>` : ''}
      </div>
      <h3 class="news-title">${escapeHtml(item.title)}</h3>
      <p class="news-excerpt">${escapeHtml(item.excerpt || '')}</p>
      <div class="news-foot">${escapeHtml(item.institution || '')} <span class="news-arrow">→</span></div>
    </div>
  `;
  return a;
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Modal ───────────────────────────────────────────────────────────────────
function openModal(radio, autoPlay = false) {
  currentRadio = radio;
  const hasStream = !!getPlayableStream(radio);

  const socials = [];
  if (radio.instagram) socials.push(`<a href="${radio.instagram}" target="_blank" rel="noopener" class="modal-btn flex-1 text-sm border border-white/10 rounded-2xl hover:bg-white/5 transition">Instagram</a>`);
  if (radio.facebook)  socials.push(`<a href="${radio.facebook}"  target="_blank" rel="noopener" class="modal-btn flex-1 text-sm border border-white/10 rounded-2xl hover:bg-white/5 transition">Facebook</a>`);
  if (radio.website)   socials.push(`<a href="${radio.website}"   target="_blank" rel="noopener" class="modal-btn flex-1 text-sm border border-white/10 rounded-2xl hover:bg-white/5 transition">Site web</a>`);

  const logoHtml = radio.logo
    ? `<img src="${radio.logo}" alt="${radio.name}" class="station-logo-modal">`
    : `<div class="logo-badge ${radio.id} h-[68px] w-[68px] text-2xl">${getInitials(radio.name)}</div>`;

  MODAL_PANEL.innerHTML = `
    <div class="p-5 sm:p-7">
      <!-- Header -->
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-4 min-w-0">
          ${logoHtml}
          <div class="min-w-0">
            <div class="font-display text-2xl sm:text-3xl font-semibold tracking-[-1px] leading-tight">${radio.fullName}</div>
            <div class="text-white/60 mt-0.5 text-sm">${radio.institution} · ${radio.city}</div>
            <div class="mt-1.5 flex items-center flex-wrap gap-1.5 text-xs">
              <span class="rounded-full bg-white/[0.07] border border-white/[0.08] px-2.5 py-[2px] text-white/70">${radio.frequency}</span>
              <span class="rounded-full bg-white/[0.07] border border-white/[0.08] px-2.5 py-[2px] text-white/70">${radio.type === 'universite' ? 'Université' : 'Cégep'}</span>
              ${hasStream ? `<span class="live-pill">EN DIRECT</span>` : ''}
            </div>
          </div>
        </div>
        <button id="modal-close" class="text-2xl leading-none text-white/35 hover:text-white transition-colors p-1.5 -mr-1 shrink-0">×</button>
      </div>

      <!-- Description -->
      <p class="mt-5 text-[14px] sm:text-[15px] leading-relaxed text-white/75">${radio.description || 'Radio étudiante du Québec.'}</p>

      <!-- Player -->
      <div class="mt-5 rounded-2xl border border-white/15 bg-black/50 p-4">
        <div class="mb-3 flex items-center justify-between px-1">
          <div>
            <div class="text-[10px] uppercase tracking-[1.5px] text-white/40">Écoute</div>
            <div class="text-sm font-medium mt-0.5">${hasStream ? 'Lecteur intégré' : 'Via le site officiel'}</div>
          </div>
          ${hasStream ? `<div id="modal-status" class="text-[11px] px-3 py-1 rounded-full bg-white/[0.06] border border-white/[0.08] text-white/55">Prêt</div>` : ''}
        </div>

        ${hasStream ? `
          <div id="modal-player">
            <div class="flex items-center gap-1.5 mb-3">
              <span class="text-emerald-400 flex items-center gap-1.5 text-xs">
                <span class="inline-block w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
                Flux direct
              </span>
              <span class="text-white/30 text-[10px] ml-auto">${PROXY_BASE ? 'via proxy' : ''}</span>
            </div>

            <div class="flex items-center gap-2 mb-3">
              <button id="modal-play"  class="player-button player-button--primary flex-1">▶ LIRE</button>
              <button id="modal-pause" class="player-button flex-1 hidden">⏸ PAUSE</button>
              <button id="modal-seek-back" class="player-button w-14 text-xs">−15s</button>
              <button id="modal-seek-fwd"  class="player-button w-14 text-xs">+15s</button>
            </div>

            <div id="modal-visualizer" class="visualizer mb-3 mx-auto w-full max-w-[240px]">
              ${Array.from({length: 9}).map(() => `<span class="bar"></span>`).join('')}
            </div>

            <div class="flex items-center gap-3 px-1">
              <span class="text-xs text-white/45 w-7">Vol</span>
              <input id="modal-volume" type="range" min="0" max="1" step="0.01" value="0.8" class="volume-slider flex-1">
              <span id="modal-vol-value" class="w-8 text-right text-xs text-white/55">80 %</span>
            </div>
          </div>
        ` : `
          <div class="text-center py-2">
            <button onclick="window.open('${radio.website}', '_blank')"
                    class="modal-btn w-full border border-accent/40 bg-accent/10 hover:bg-accent/20 py-3.5 font-semibold text-accentSoft">
              Ouvrir le lecteur officiel →
            </button>
            <p class="text-[11px] text-white/40 mt-2.5 leading-relaxed">
              Le flux de cette radio n'est pas disponible directement.<br>Écoute via le site officiel.
            </p>
          </div>
        `}
      </div>

      <!-- Social links -->
      ${socials.length ? `<div class="mt-3 flex gap-2">${socials.join('')}</div>` : ''}

      <!-- Schedule info -->
      <div class="mt-4 rounded-2xl border border-white/[0.07] bg-white/[0.015] p-4 text-sm">
        <div class="font-medium mb-1 text-white/80">Horaires et émissions</div>
        <p class="text-white/50 text-[13px] leading-relaxed">
          Consulte le site officiel pour la grille de programmation complète et les balados.
        </p>
        <a href="${radio.website}" target="_blank" rel="noopener" class="inline-block mt-2 text-xs text-accentSoft underline decoration-accent/30 hover:decoration-accent/60 transition-all">
          Voir la programmation →
        </a>
      </div>

      <!-- Footer row -->
      <div class="mt-4 flex justify-between items-center text-[11px] text-white/35 px-1">
        <div>${radio.region}</div>
        <button id="fav-btn" class="flex items-center gap-1.5 hover:text-white/80 transition-colors">
          <span id="fav-icon">♡</span>
          <span id="fav-text">Ajouter aux favoris</span>
        </button>
      </div>
    </div>
  `;

  MODAL.classList.remove('hidden');
  MODAL.classList.add('flex');

  document.getElementById('modal-close').onclick = closeModal;

  if (hasStream) setupModalPlayer(radio, autoPlay);
  setupFavoritesButton(radio);
}

function setupModalPlayer(radio, autoPlay = false) {
  const playBtn   = document.getElementById('modal-play');
  const pauseBtn  = document.getElementById('modal-pause');
  const backBtn   = document.getElementById('modal-seek-back');
  const fwdBtn    = document.getElementById('modal-seek-fwd');
  const volSlider = document.getElementById('modal-volume');
  const volValue  = document.getElementById('modal-vol-value');
  const visual    = document.getElementById('modal-visualizer');
  const status    = document.getElementById('modal-status');

  if (!audio) setupAudio();

  const saved = parseFloat(localStorage.getItem('req-player-vol') ?? '0.8');
  audio.volume = saved;
  if (volSlider) {
    volSlider.value = saved;
    volValue.textContent = Math.round(saved * 100) + ' %';
  }

  const updateUI = () => {
    const playing = !audio.paused && playingRadio?.id === radio.id;
    playBtn?.classList.toggle('hidden', playing);
    pauseBtn?.classList.toggle('hidden', !playing);
    visual?.classList.toggle('is-playing', playing);
    if (status) status.textContent = playing ? '🔴 En direct' : 'Prêt';
  };

  const playableUrl = getPlayableStream(radio);

  const doPlay = async () => {
    try {
      if (audio.src !== playableUrl) {
        audio.src = playableUrl;
      }
      await audio.play();
      playingRadio = radio;
      updateUI();
      showPlayerBar(radio);
      updateMediaSession(radio);
    } catch {
      showToast('Appuie sur ▶ pour autoriser la lecture.');
    }
  };

  playBtn.onclick  = doPlay;
  pauseBtn.onclick = () => { audio.pause(); updateUI(); updatePlayerBarUI(); };
  backBtn.onclick  = () => seek(-15);
  fwdBtn.onclick   = () => seek(15);

  volSlider.oninput = (e) => {
    const v = parseFloat(e.target.value);
    audio.volume = v;
    if (PB_VOLUME) PB_VOLUME.value = v;
    localStorage.setItem('req-player-vol', v);
    volValue.textContent = Math.round(v * 100) + ' %';
  };

  // Sync audio events with this modal
  audio._modalAbort?.abort();
  const ac = new AbortController();
  audio._modalAbort = ac;
  const { signal } = ac;
  audio.addEventListener('play',  updateUI, { signal });
  audio.addEventListener('pause', updateUI, { signal });
  audio.addEventListener('ended', updateUI, { signal });

  updateUI();

  if (autoPlay) doPlay();
}

function setupFavoritesButton(radio) {
  const favBtn  = document.getElementById('fav-btn');
  const favIcon = document.getElementById('fav-icon');
  const favText = document.getElementById('fav-text');

  const updateFavUI = () => {
    const isFav = getFavorites().includes(radio.id);
    favIcon.textContent = isFav ? '♥' : '♡';
    favIcon.style.color = isFav ? '#f43f5e' : '';
    favText.textContent = isFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
  };

  favBtn.onclick = () => {
    toggleFavorite(radio.id);
    updateFavUI();
    renderGrid();
  };

  updateFavUI();
}

// ─── Seek ────────────────────────────────────────────────────────────────────
function seek(seconds) {
  if (!audio || !audio.seekable?.length) return;
  const end = audio.seekable.end(audio.seekable.length - 1);
  const start = audio.seekable.start(0);
  audio.currentTime = Math.min(end, Math.max(start, audio.currentTime + seconds));
}

// ─── Audio setup ─────────────────────────────────────────────────────────────
function setupAudio() {
  if (audio) return;
  audio = new Audio();
  audio.preload = 'none';
  if (PROXY_BASE) audio.crossOrigin = 'anonymous';

  audio.addEventListener('error', () => {
    showToast('Flux indisponible pour le moment.');
    updatePlayerBarUI();
  });

  audio.addEventListener('play',  () => updatePlayerBarUI());
  audio.addEventListener('pause', () => updatePlayerBarUI());
  audio.addEventListener('ended', () => updatePlayerBarUI());

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play',  () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => seek(-15));
    navigator.mediaSession.setActionHandler('seekforward',  () => seek(15));
  }
}

function updateMediaSession(radio) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: radio.fullName,
    artist: radio.institution,
    album: 'RÉQ — Radios Étudiantes QC',
  });
}

// ─── Close modal ─────────────────────────────────────────────────────────────
function closeModal() {
  MODAL.classList.remove('flex');
  MODAL.classList.add('hidden');
  audio?._modalAbort?.abort();
  currentRadio = null;
  // Audio keeps playing — mini-player bar remains visible
}

// ─── Persistent player bar ───────────────────────────────────────────────────
function bindPlayerBar() {
  PB_PLAY.addEventListener('click', async () => {
    if (!audio || !playingRadio) return;
    try {
      await audio.play();
    } catch {
      showToast('Lecture bloquée par le navigateur.');
    }
  });

  PB_PAUSE.addEventListener('click', () => audio?.pause());

  PB_BACK.addEventListener('click', () => seek(-15));
  PB_FWD.addEventListener('click',  () => seek(15));

  PB_VOLUME.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (audio) audio.volume = v;
    localStorage.setItem('req-player-vol', v);
    const modalVol = document.getElementById('modal-volume');
    const modalVolVal = document.getElementById('modal-vol-value');
    if (modalVol) modalVol.value = v;
    if (modalVolVal) modalVolVal.textContent = Math.round(v * 100) + ' %';
  });

  PB_CLOSE.addEventListener('click', () => {
    audio?.pause();
    if (audio) { audio.src = ''; }
    playingRadio = null;
    PLAYER_BAR.classList.add('hidden');
    renderGrid();
  });

  PB_STATION_BTN.addEventListener('click', () => {
    if (playingRadio) openModal(playingRadio);
  });

  // Restore volume from storage
  const saved = parseFloat(localStorage.getItem('req-player-vol') ?? '0.8');
  PB_VOLUME.value = saved;
}

function showPlayerBar(radio) {
  // Logo
  if (radio.logo) {
    PB_LOGO_WRAP.innerHTML = `<img src="${radio.logo}" alt="${radio.name}" class="w-full h-full object-cover">`;
  } else {
    PB_LOGO_WRAP.innerHTML = `<div class="logo-badge ${radio.id}" style="width:40px;height:40px;font-size:12px;border-radius:9px;">${getInitials(radio.name)}</div>`;
  }
  PB_NAME.textContent = radio.name;
  PB_SUB.textContent  = radio.institution;

  if (PLAYER_BAR.classList.contains('hidden')) {
    PLAYER_BAR.classList.remove('hidden');
    PLAYER_BAR.classList.add('player-bar-enter');
    PLAYER_BAR.addEventListener('animationend', () => PLAYER_BAR.classList.remove('player-bar-enter'), { once: true });
  }

  updatePlayerBarUI();
  renderGrid();
}

function updatePlayerBarUI() {
  if (!audio) return;
  const playing = !audio.paused;
  PB_PLAY.classList.toggle('hidden', playing);
  PB_PAUSE.classList.toggle('hidden', !playing);
  PB_EQ.classList.toggle('is-playing', playing);
  // Update card highlights
  document.querySelectorAll('.radio-card').forEach(card => {
    const isThisOne = playingRadio && card.dataset.radioId === playingRadio.id && playing;
    card.classList.toggle('is-playing-card', isThisOne);
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg) {
  if (!TOAST_EL) return;
  TOAST_EL.textContent = msg;
  TOAST_EL.classList.remove('hidden');
  clearTimeout(TOAST_EL._t);
  TOAST_EL._t = setTimeout(() => TOAST_EL.classList.add('hidden'), 2800);
}

// ─── Favorites ────────────────────────────────────────────────────────────────
function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem('req-favorites') || '[]');
  } catch {
    return [];
  }
}

function toggleFavorite(id) {
  const favs = getFavorites();
  const idx = favs.indexOf(id);
  if (idx === -1) favs.push(id);
  else favs.splice(idx, 1);
  localStorage.setItem('req-favorites', JSON.stringify(favs));
}

// ─── PWA install ──────────────────────────────────────────────────────────────
function bindInstallFlow() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    INSTALL_BTN?.classList.remove('hidden');
    if (INSTALL_BTN) {
      INSTALL_BTN.onclick = async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        INSTALL_BTN.classList.add('hidden');
      };
    }
  });

  window.addEventListener('appinstalled', () => {
    INSTALL_BTN?.classList.add('hidden');
    showToast('RÉQ installée. Merci !');
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────
window.REQ = {
  openRadio: (id) => {
    const r = radios.find(x => x.id === id);
    if (r) openModal(r);
  },
};
