// RÉQ — Le fil étudiant du Québec
// Page unique : un syntoniseur radio en haut, un fil d'articles (texte) en dessous.

// Proxy CORS optionnel pour les flux HTTP→HTTPS (déployer proxy/cloudflare-worker.js).
const PROXY_BASE = '';

function getPlayableStream(radio) {
  if (!radio?.stream) return null;
  const url = radio.stream;
  if (url.startsWith('http:') && location.protocol === 'https:' && !PROXY_BASE) return null;
  if (!PROXY_BASE) return url;
  return `${PROXY_BASE}/?url=${encodeURIComponent(url)}`;
}

// ─── DOM refs ────────────────────────────────────────────────────────────────
const TUNER          = document.getElementById('tuner');
const TUNER_SELECT   = document.getElementById('tuner-select');
const TUNER_PREV     = document.getElementById('tuner-prev');
const TUNER_NEXT     = document.getElementById('tuner-next');
const TUNER_PLAY     = document.getElementById('tuner-play');
const TUNER_NAME     = document.getElementById('tuner-now-name');
const TUNER_SUB      = document.getElementById('tuner-now-sub');
const TUNER_VOLUME   = document.getElementById('tuner-volume');
const TUNER_SITE     = document.getElementById('tuner-site');
const ICO_PLAY       = TUNER_PLAY.querySelector('.ico-play');
const ICO_PAUSE      = TUNER_PLAY.querySelector('.ico-pause');

const NEWS_LIST      = document.getElementById('news-list');
const NEWS_FILTERS   = document.getElementById('news-filters');
const NEWS_COUNT     = document.getElementById('news-count');
const NEWS_UPDATED   = document.getElementById('news-updated');
const NEWS_EMPTY     = document.getElementById('news-empty');
const TODAY_DATE     = document.getElementById('today-date');
const TOAST_EL       = document.getElementById('toast');
const THEME_TOGGLE   = document.getElementById('theme-toggle');

// ─── State ───────────────────────────────────────────────────────────────────
let radios = [];          // ordered list backing the tuner
let news = [];
let newsSourceFilter = 'all';
let currentStation = null; // radio object selected in tuner
let audio = null;
let suppressAudioError = false;
let sourceColors = {};     // source name → accent colour

// Curated, tasteful palette mapped deterministically to each source.
const SOURCE_PALETTE = [
  '#c8102e', '#1d4ed8', '#047857', '#b45309', '#7c3aed',
  '#db2777', '#0891b2', '#ea580c', '#4338ca', '#15803d',
  '#be123c', '#0d9488',
];

// ─── Bootstrap ───────────────────────────────────────────────────────────────
init();

async function init() {
  initTheme();
  renderTodayDate();
  setupAudio();
  bindTuner();

  const [radiosData, newsLoaded] = await Promise.allSettled([
    fetch('./radios.json').then(r => r.json()),
    loadNews(),
  ]);

  radios = radiosData.status === 'fulfilled' ? sortRadios(radiosData.value) : [];
  buildTunerOptions();
  restoreVolume();
}

// ─── Theme (clair / sombre) ────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('req-theme');
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme(theme);
  THEME_TOGGLE?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('req-theme', next);
    applyTheme(next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  THEME_TOGGLE?.querySelector('.ico-sun')?.classList.toggle('hidden', isDark);
  THEME_TOGGLE?.querySelector('.ico-moon')?.classList.toggle('hidden', !isDark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark ? '#0e0f12' : '#ffffff');
}

// ─── Today date (masthead) ─────────────────────────────────────────────────────
function renderTodayDate() {
  const now = new Date();
  TODAY_DATE.textContent = now.toLocaleDateString('fr-CA', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  TUNER
// ═══════════════════════════════════════════════════════════════════════════
function sortRadios(list) {
  const order = { universite: 0, cegep: 1 };
  return [...list].sort((a, b) => {
    const t = (order[a.type] ?? 9) - (order[b.type] ?? 9);
    if (t !== 0) return t;
    return a.name.localeCompare(b.name, 'fr');
  });
}

function buildTunerOptions() {
  TUNER_SELECT.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Syntoniser un poste…';
  placeholder.disabled = true;
  placeholder.selected = true;
  TUNER_SELECT.appendChild(placeholder);

  const groups = [
    { type: 'universite', label: 'Universités' },
    { type: 'cegep', label: 'Cégeps' },
  ];

  groups.forEach(({ type, label }) => {
    const inGroup = radios.filter(r => r.type === type);
    if (!inGroup.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    inGroup.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      const playable = getPlayableStream(r) ? '' : ' — site';
      opt.textContent = `${r.name} · ${r.city}${playable}`;
      og.appendChild(opt);
    });
    TUNER_SELECT.appendChild(og);
  });
}

function bindTuner() {
  TUNER_SELECT.addEventListener('change', () => {
    const wasPlaying = isPlaying();
    selectStation(TUNER_SELECT.value, { autoplay: wasPlaying });
  });

  TUNER_PREV.addEventListener('click', () => stepStation(-1));
  TUNER_NEXT.addEventListener('click', () => stepStation(1));

  TUNER_PLAY.addEventListener('click', togglePlay);

  TUNER_VOLUME.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (audio) audio.volume = v;
    localStorage.setItem('req-player-vol', v);
  });
}

function currentIndex() {
  if (!currentStation) return -1;
  return radios.findIndex(r => r.id === currentStation.id);
}

function stepStation(dir) {
  if (!radios.length) return;
  let idx = currentIndex();
  idx = idx === -1 ? (dir > 0 ? 0 : radios.length - 1) : (idx + dir + radios.length) % radios.length;
  const next = radios[idx];
  TUNER_SELECT.value = next.id;
  selectStation(next.id, { autoplay: isPlaying() });
}

function selectStation(id, { autoplay = false } = {}) {
  const radio = radios.find(r => r.id === id);
  if (!radio) return;
  currentStation = radio;

  const playable = getPlayableStream(radio);
  TUNER_NAME.textContent = radio.fullName || radio.name;
  TUNER_SUB.textContent  = `${radio.frequency} · ${radio.institution}`;

  // Site link (always available; emphasised when no direct stream)
  if (radio.website) {
    TUNER_SITE.href = radio.website;
    TUNER_SITE.classList.toggle('hidden', !!playable);
  } else {
    TUNER_SITE.classList.add('hidden');
  }

  TUNER_PLAY.disabled = !playable;
  TUNER_PLAY.title = playable ? 'Écouter' : 'Flux direct indisponible — voir le site';

  updateMediaSession(radio);

  if (!playable) {
    stopPlayback({ keepStation: true });
    return;
  }

  if (autoplay) {
    play(radio);
  } else {
    updatePlayUI();
  }
}

function togglePlay() {
  if (!currentStation) {
    // Nothing chosen yet → tune the first station and play it.
    const first = radios.find(r => getPlayableStream(r)) || radios[0];
    if (!first) return;
    TUNER_SELECT.value = first.id;
    selectStation(first.id, { autoplay: true });
    return;
  }
  if (isPlaying()) {
    audio.pause();
  } else {
    play(currentStation);
  }
}

async function play(radio) {
  const url = getPlayableStream(radio);
  if (!url) return;
  try {
    if (audio.src !== url) audio.src = url;
    await audio.play();
    updatePlayUI();
  } catch {
    showToast('Appuie de nouveau sur ▶ pour autoriser la lecture.');
  }
}

function stopPlayback({ keepStation = false } = {}) {
  if (audio) {
    suppressAudioError = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    suppressAudioError = false;
  }
  if (!keepStation) currentStation = null;
  updatePlayUI();
}

function isPlaying() {
  return audio && !audio.paused && !!audio.src;
}

function updatePlayUI() {
  const playing = isPlaying();
  ICO_PLAY.classList.toggle('hidden', playing);
  ICO_PAUSE.classList.toggle('hidden', !playing);
  TUNER.classList.toggle('is-playing', playing);
}

// ─── Audio engine ──────────────────────────────────────────────────────────────
function setupAudio() {
  if (audio) return;
  audio = new Audio();
  audio.preload = 'none';
  if (PROXY_BASE) audio.crossOrigin = 'anonymous';

  audio.addEventListener('play',  updatePlayUI);
  audio.addEventListener('pause', updatePlayUI);
  audio.addEventListener('ended', updatePlayUI);
  audio.addEventListener('error', () => {
    if (!suppressAudioError && audio.currentSrc) showToast('Flux indisponible pour le moment.');
    updatePlayUI();
  });

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play',  () => currentStation && play(currentStation));
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => stepStation(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => stepStation(1));
  }
}

function updateMediaSession(radio) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: radio.fullName || radio.name,
    artist: radio.institution,
    album: 'RÉQ — Radios Étudiantes du Québec',
  });
}

function restoreVolume() {
  const saved = parseFloat(localStorage.getItem('req-player-vol') ?? '0.8');
  if (audio) audio.volume = saved;
  TUNER_VOLUME.value = saved;
}

// ═══════════════════════════════════════════════════════════════════════════
//  NEWS WIRE
// ═══════════════════════════════════════════════════════════════════════════
async function loadNews() {
  NEWS_LIST.innerHTML = newsSkeleton(6);
  try {
    const res = await fetch('./news.json', { cache: 'no-cache' });
    const data = await res.json();
    news = Array.isArray(data) ? data : (data.items || []);
    news.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    assignSourceColors();
    if (data.updated) {
      const d = new Date(data.updated);
      NEWS_UPDATED.textContent = `mis à jour ${formatStamp(d)}`;
    }
  } catch (e) {
    console.error('Failed to load news.json', e);
    news = [];
  }
  renderNewsFilters();
  renderNews();
}

function assignSourceColors() {
  const sources = [...new Set(news.map(n => n.source))].sort((a, b) => a.localeCompare(b, 'fr'));
  sourceColors = {};
  sources.forEach((src, i) => { sourceColors[src] = SOURCE_PALETTE[i % SOURCE_PALETTE.length]; });
}

function newsSkeleton(n) {
  return Array.from({ length: n }).map(() => `
    <div class="article skeleton">
      <div class="sk sk-meta"></div>
      <div class="sk sk-title"></div>
      <div class="sk sk-title2"></div>
      <div class="sk sk-brief"></div>
      <div class="sk sk-brief2"></div>
    </div>`).join('');
}

function renderNewsFilters() {
  const sources = [...new Set(news.map(n => n.source))].sort((a, b) => a.localeCompare(b, 'fr'));
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
        b.classList.toggle('active', b === btn));
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
  NEWS_LIST.innerHTML = '';
  items.forEach((item, i) => NEWS_LIST.appendChild(createArticle(item, i === 0)));
}

function createArticle(item, lead = false) {
  const a = document.createElement('a');
  a.className = lead ? 'article article--lead' : 'article';
  a.href = item.link;
  a.target = '_blank';
  a.rel = 'noopener';

  const color = sourceColors[item.source] || 'var(--accent)';
  a.style.setProperty('--c', color);

  const d = item.date ? new Date(item.date) : null;
  const time = d ? formatStamp(d) : '';
  const fresh = d ? (Date.now() - d) < 120 * 60000 : false;
  const brief = cleanBrief(item.excerpt);

  a.innerHTML = `
    ${lead ? '<span class="article-eyebrow">À la une</span>' : ''}
    <div class="article-meta">
      <span class="article-source">${escapeHtml(item.source)}</span>
      ${item.institution ? `<span class="article-inst">${escapeHtml(item.institution)}</span>` : ''}
      ${time ? `<time class="article-time${fresh ? ' is-fresh' : ''}" datetime="${escapeHtml(item.date)}">${time}</time>` : ''}
    </div>
    <h3 class="article-title">${escapeHtml(item.title)}</h3>
    ${brief ? `<p class="article-brief">${escapeHtml(brief)}</p>` : ''}
  `;
  return a;
}

// ─── Date / time formatting (Québec) ────────────────────────────────────────────
function formatTime(d) {
  // "16 h 18" — heure de publication
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h} h ${m}`;
}

function formatStamp(d) {
  if (isNaN(d)) return '';
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.round(diffMs / 60000);

  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return `il y a ${diffMin} min`;

  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yest.toDateString();
  const time = formatTime(d);

  if (sameDay) return `aujourd'hui, ${time}`;
  if (isYesterday) return `hier, ${time}`;

  const sameYear = d.getFullYear() === now.getFullYear();
  const dateStr = d.toLocaleDateString('fr-CA', {
    day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${dateStr}, ${time}`;
}

// ─── Brief / excerpt cleanup ─────────────────────────────────────────────────────
function cleanBrief(raw = '') {
  let s = String(raw);
  s = s.replace(/<[^>]*>/g, ' ');                       // strip HTML tags
  s = s.replace(/\]\]>/g, '');                          // CDATA leftovers
  s = s.replace(/\s*L['’]article\b[\s\S]*?est apparu en premier sur[\s\S]*$/i, ''); // WordPress boilerplate
  s = s.replace(/\[[^\]]*(?:read more|lire la suite|continue reading)[^\]]*\]/gi, ''); // "[Read More…]"
  s = s.replace(/\[\s*(?:…|\.{2,})\s*\]/g, '');        // bare "[…]" / "[...]"
  s = s.replace(/\b(?:read more|lire la suite|continue reading)\b\.?\s*$/i, '');
  s = s.replace(/\[(?:…|\.\.\.)\]/g, '…');
  s = s.replace(/&(?:nbsp|#160);/gi, ' ');
  s = s.replace(/&amp;/gi, '&');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[\s…,–-]+$/u, '');                     // tidy trailing punctuation
  if (s.length < 12) return '';                          // too thin to be a real brief
  return s + '…';
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg) {
  if (!TOAST_EL) return;
  TOAST_EL.textContent = msg;
  TOAST_EL.classList.remove('hidden');
  clearTimeout(TOAST_EL._t);
  TOAST_EL._t = setTimeout(() => TOAST_EL.classList.add('hidden'), 2800);
}
