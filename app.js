// RADAR — Les médias étudiants du Québec
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

function getListenUrl(radio) {
  return radio?.listenUrl || radio?.website || null;
}

function isExternalListen(radio) {
  return !!radio && !getPlayableStream(radio) && !!getListenUrl(radio);
}

function openListenWindow(radio) {
  const url = getListenUrl(radio);
  if (!url) {
    showToast('Aucun site d\'écoute disponible pour ce poste.');
    return false;
  }

  const name = `radar-listen-${radio.id}`;
  const features = 'popup=yes,width=440,height=720,menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes';

  if (listenWindow && !listenWindow.closed && listenWindowId === radio.id) {
    listenWindow.focus();
    return true;
  }

  listenWindow = window.open(url, name, features);
  listenWindowId = radio.id;

  if (!listenWindow) {
    window.open(url, '_blank', 'noopener');
    showToast('Écoute ouverte dans un nouvel onglet.');
    return true;
  }

  listenWindow.opener = null;
  return true;
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
const TUNER_STATIONS = document.getElementById('tuner-stations');
const ICO_PLAY       = TUNER_PLAY.querySelector('.ico-play');
const ICO_PAUSE      = TUNER_PLAY.querySelector('.ico-pause');
const ICO_EXTERNAL   = TUNER_PLAY.querySelector('.ico-external');

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
let listenWindow = null;
let listenWindowId = null;
let sourceColors = {};     // source name → accent colour
let brandColors = { institutions: {}, fallback_palette: ['#003DA5', '#6C2163', '#047857'] };

const GENERIC_AUTHORS = /^(admin|administrator|administrateur|editor|éditeur|editeur|rédaction|redaction|staff|wordpress|webmaster|collectif|tribune|link|daily|exemplaire|quartier libre|zone campus|la pige|le délit|le delit|the link|the tribune|the mcgill daily)$/i;

// ─── Bootstrap ───────────────────────────────────────────────────────────────
init();

async function init() {
  initTheme();
  renderTodayDate();
  setupAudio();
  bindTuner();

  const [radiosData, newsLoaded, brandLoaded] = await Promise.allSettled([
    fetch('./radios.json').then(r => r.json()),
    loadNews(),
    fetch('./brand-colors.json').then(r => r.json()),
  ]);

  if (brandLoaded.status === 'fulfilled' && brandLoaded.value?.institutions) {
    brandColors = brandLoaded.value;
  }

  radios = radiosData.status === 'fulfilled' ? sortRadios(radiosData.value) : [];
  buildTunerOptions();
  buildTunerStations();
  restoreVolume();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch((e) => {
    console.warn('Service worker registration failed', e);
  });
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

function buildTunerStations() {
  if (!TUNER_STATIONS) return;
  const playable = radios.filter(r => getPlayableStream(r));
  if (!playable.length) {
    TUNER_STATIONS.innerHTML = '';
    return;
  }

  TUNER_STATIONS.innerHTML = `
    <span class="tuner-stations-label">Sur RADAR</span>
    <div class="tuner-stations-list" role="group" aria-label="Écoute directe">
      ${playable.map(r => `
        <button type="button" class="tuner-station-btn" data-id="${escapeHtml(r.id)}"
          title="${escapeHtml(r.fullName || r.name)} · ${escapeHtml(r.institution)}">
          <span class="tuner-station-call">${escapeHtml(r.name.replace(/\s+FM.*/i, '').trim())}</span>
          <span class="tuner-station-inst">${escapeHtml(shortInstitution(r.institution, r.type))}</span>
        </button>
      `).join('')}
    </div>
  `;

  TUNER_STATIONS.querySelectorAll('.tuner-station-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      TUNER_SELECT.value = btn.dataset.id;
      selectStation(btn.dataset.id, { autoplay: true });
    });
  });
  updateTunerStationsUI();
}

function updateTunerStationsUI() {
  if (!TUNER_STATIONS) return;
  TUNER_STATIONS.querySelectorAll('.tuner-station-btn').forEach(btn => {
    const active = currentStation?.id === btn.dataset.id;
    btn.classList.toggle('is-active', active);
    btn.classList.toggle('is-playing', active && isPlaying());
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
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
      const suffix = getPlayableStream(r) ? '' : ' — écoute sur site externe ↗';
      opt.textContent = `${r.name} · ${r.city}${suffix}`;
      og.appendChild(opt);
    });
    TUNER_SELECT.appendChild(og);
  });
}

function bindTuner() {
  TUNER_SELECT.addEventListener('change', () => {
    const wasPlaying = isPlaying();
    selectStation(TUNER_SELECT.value, { autoplay: wasPlaying, openExternal: true });
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

function selectStation(id, { autoplay = false, openExternal = false } = {}) {
  const radio = radios.find(r => r.id === id);
  if (!radio) return;
  currentStation = radio;

  const playable = getPlayableStream(radio);
  const external = isExternalListen(radio);

  const inst = shortInstitution(radio.institution, radio.type);
  TUNER_NAME.textContent = radio.name;
  TUNER_SUB.textContent = external
    ? `Site externe · ${inst}`
    : `${radio.frequency} · ${inst}`;

  TUNER_PLAY.disabled = !playable && !external;
  TUNER_PLAY.title = playable
    ? 'Écouter'
    : external
      ? 'Écouter sur le site du poste (fenêtre externe)'
      : 'Flux direct indisponible';

  updateMediaSession(radio);

  if (!playable) {
    stopPlayback({ keepStation: true });
    updatePlayUI();
    if (external && openExternal) openListenWindow(radio);
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
    const first = radios.find(r => getPlayableStream(r)) || radios[0];
    if (!first) return;
    TUNER_SELECT.value = first.id;
    selectStation(first.id, { autoplay: !isExternalListen(first), openExternal: isExternalListen(first) });
    return;
  }
  if (isExternalListen(currentStation)) {
    openListenWindow(currentStation);
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
  const external = !!currentStation && isExternalListen(currentStation);
  ICO_PLAY.classList.toggle('hidden', playing || external);
  ICO_PAUSE.classList.toggle('hidden', !playing);
  ICO_EXTERNAL?.classList.toggle('hidden', !external || playing);
  TUNER_PLAY.classList.toggle('is-external', external && !playing);
  TUNER.classList.toggle('is-playing', playing);
  TUNER.classList.toggle('is-external', external && !playing);
  updateTunerStationsUI();
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
    album: 'RADAR — Les médias étudiants du Québec',
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
  const palette = brandColors.fallback_palette || ['#003DA5', '#6C2163', '#047857'];
  const byInstitution = brandColors.institutions || {};
  const sources = [...new Set(news.map(n => n.source))].sort((a, b) => a.localeCompare(b, 'fr'));
  sourceColors = {};

  sources.forEach((src, i) => {
    const item = news.find(n => n.source === src);
    const inst = item?.institution || '';
    const brand = byInstitution[inst];
    sourceColors[src] = brand?.color || palette[i % palette.length];
  });
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

function shortInstitution(name = '', type = '') {
  const SHORT = {
    'Université de Montréal': 'UdeM',
    'UQAM': 'UQAM',
    'Université du Québec à Montréal (UQAM)': 'UQAM',
    'Université McGill': 'McGill',
    'McGill University': 'McGill',
    'Concordia University': 'Concordia',
    'Université Laval': 'ULaval',
    'Université de Sherbrooke': 'UdeS',
    'Université du Québec à Trois-Rivières': 'UQTR',
    'Cégep du Vieux Montréal': 'CVM',
    'Cégep de Jonquière (ATM – journalisme)': 'Cégep Jonquière',
  };
  if (SHORT[name]) return SHORT[name];

  const paren = name.match(/\(([^)]+)\)/);
  if (paren) {
    const inner = paren[1].split(/[–-]/)[0].trim();
    if (inner.length <= 14) return inner;
  }
  if (/^cégep/i.test(name)) return name.replace(/\s*\(.*$/, '').replace(/^Cégep (de |du )?/i, 'Cégep ');
  if (/^université/i.test(name)) {
    return name
      .replace(/\s*\(.*$/, '')
      .replace(/^Université du Québec à /i, 'UQ ')
      .replace(/^Université de /i, '')
      .replace(/^Université /i, '')
      .trim();
  }
  return type === 'cegep' ? 'Cégep' : name.length > 24 ? name.slice(0, 22) + '…' : name;
}

function sourceInfo(src) {
  const item = news.find(n => n.source === src);
  return {
    institution: item?.institution || '',
    type: item?.type || '',
    color: sourceColors[src] || 'var(--accent)',
  };
}

function renderNewsFilters() {
  const sources = [...new Set(news.map(n => n.source))].sort((a, b) => a.localeCompare(b, 'fr'));
  [...NEWS_FILTERS.querySelectorAll('[data-source]:not([data-source="all"])')].forEach(b => b.remove());

  sources.forEach(src => {
    const btn = document.createElement('button');
    const { institution, type, color } = sourceInfo(src);
    const instShort = institution ? shortInstitution(institution, type) : '';
    const typeLabel = type === 'cegep' ? 'Cégep' : type === 'universite' ? 'Univ.' : '';

    btn.className = 'filter-btn';
    btn.dataset.source = src;
    btn.style.setProperty('--c', color);
    btn.title = institution ? `${src} — ${institution}` : src;
    btn.innerHTML = `
      <span class="filter-btn__row">
        <span class="filter-btn__dot" aria-hidden="true"></span>
        <span class="filter-btn__name">${escapeHtml(src)}</span>
      </span>
      ${instShort ? `<span class="filter-btn__inst">${escapeHtml(instShort)}${typeLabel ? ` <span class="filter-btn__type">${typeLabel}</span>` : ''}</span>` : ''}
    `;
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

  const tail = [];
  items.forEach((item, i) => {
    const role = getArticleRole(i);
    const article = createArticle(item, role);
    if (role === 'standard') tail.push(article);
    else NEWS_LIST.appendChild(article);
  });

  if (tail.length) {
    const section = document.createElement('div');
    section.className = 'news-tail';
    section.innerHTML = '<h3 class="news-tail-title">Suite du fil</h3>';
    tail.forEach(article => section.appendChild(article));
    NEWS_LIST.appendChild(section);
  }

  updateNewsLayout();
}

function updateNewsLayout() {
  const lead = NEWS_LIST.querySelector('.article--lead');
  if (!lead) {
    NEWS_LIST.removeAttribute('data-hero');
    return;
  }
  NEWS_LIST.dataset.hero = lead.classList.contains('has-image') ? 'image' : 'text';
}

function getArticleRole(index) {
  if (index === 0) return 'lead';
  if (index <= 2) return 'feature';
  if (index <= 14) return 'compact';
  return 'standard';
}

function createArticle(item, role = 'standard') {
  const a = document.createElement('a');
  a.className = `article article--${role}`;
  a.href = item.link;
  a.target = '_blank';
  a.rel = 'noopener';

  const color = sourceColors[item.source] || 'var(--accent)';
  a.style.setProperty('--c', color);

  const d = item.date ? new Date(item.date) : null;
  const time = d ? formatStamp(d) : '';
  const fresh = d ? (Date.now() - d) < 120 * 60000 : false;
  const { author, body } = splitByline(item);
  const { text: brief, truncated: briefTruncated } = prepareBrief(body, role, item.lang);
  const readMore = item.lang === 'en' ? 'Read more →' : 'Lire la suite →';
  const byLabel = item.lang === 'en' ? 'By' : 'Par';
  const canUseImage = ['lead', 'feature'].includes(role);
  const hasImageCandidate = canUseImage && !!getCandidateImage(item.image);
  if (!hasImageCandidate && canUseImage) a.classList.add('article--text');

  a.innerHTML = `
    ${role === 'lead' ? '<span class="article-eyebrow">À la une</span>' : ''}
    <div class="article-meta">
      <span class="article-source">${escapeHtml(item.source)}</span>
      ${item.institution ? `<span class="article-inst">${escapeHtml(item.institution)}</span>` : ''}
      ${time ? `<time class="article-time${fresh ? ' is-fresh' : ''}" datetime="${escapeHtml(item.date)}">${time}</time>` : ''}
    </div>
    ${canUseImage ? '<figure class="article-media" aria-hidden="true"></figure>' : ''}
    <h3 class="article-title">${escapeHtml(cleanTitle(item.title))}</h3>
    ${author ? `<p class="article-byline">${byLabel} <strong>${escapeHtml(author)}</strong></p>` : ''}
    ${brief ? `<p class="article-brief">${escapeHtml(brief)}${briefTruncated ? `<span class="article-more">${readMore}</span>` : ''}</p>` : ''}
  `;

  if (canUseImage) attachArticleImage(a, item, role);
  return a;
}

function attachArticleImage(article, item, role) {
  const src = getCandidateImage(item.image);
  const media = article.querySelector('.article-media');
  if (!src || !media) {
    media?.remove();
    article.classList.add('article--text');
    updateNewsLayout();
    return;
  }

  const img = new Image();
  img.decoding = 'async';
  img.loading = role === 'lead' ? 'eager' : 'lazy';
  img.alt = '';

  img.onload = () => {
    if (!isUsableArticleImage(img, role)) {
      media.remove();
      article.classList.add('article--text');
      updateNewsLayout();
      return;
    }
    media.appendChild(img);
    article.classList.add('has-image');
    article.classList.remove('article--text');
    updateNewsLayout();
  };

  img.onerror = () => {
    media.remove();
    article.classList.add('article--text');
    updateNewsLayout();
  };

  img.src = src;

  window.setTimeout(() => {
    if (!article.classList.contains('has-image') && media.isConnected) {
      media.remove();
      article.classList.add('article--text');
      updateNewsLayout();
    }
  }, 2500);
}

function getCandidateImage(src = '') {
  const raw = String(src).trim();
  if (!raw) return '';

  let url;
  try {
    url = new URL(raw, location.href);
  } catch {
    return '';
  }

  if (!['http:', 'https:'].includes(url.protocol)) return '';
  const path = decodeURIComponent(url.pathname).toLowerCase();
  if (/(logo|avatar|icon|placeholder|default|blank|spacer|profile|author|favicon)/.test(path)) return '';
  return url.href;
}

function isUsableArticleImage(img, role) {
  const width = img.naturalWidth || 0;
  const height = img.naturalHeight || 0;
  const ratio = width / Math.max(height, 1);
  const minWidth = role === 'lead' ? 640 : 520;
  const minHeight = role === 'lead' ? 320 : 260;
  return width >= minWidth && height >= minHeight && ratio >= 1.05 && ratio <= 2.4;
}

// Pull the byline out of the data (preferred) or the "Par/By …" prefix of the excerpt,
// returning the author plus the remaining body text for the brief.
function splitByline(item) {
  const ex = String(item.excerpt || '');
  let author = normalizeAuthor(item.author);
  let body = ex;

  if (author) {
    const escaped = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const extended = new RegExp(
      `^\\s*(?:Par|By)\\s+${escaped}(?:\\s+[\\p{Lu}][\\p{L}'’.\\-]+)?(?=\\s+(?:Le|La|Les|L'|L’|Un|Une|À|A|The|An)\\s)`,
      'iu',
    );
    const known = new RegExp(`^\\s*(?:Par|By)\\s+${escaped}\\s*`, 'iu');
    if (extended.test(ex)) body = ex.replace(extended, '').trim();
    else if (known.test(ex)) body = ex.replace(known, '').trim();
  } else if (/^(?:Par|By)\s+/i.test(ex)) {
    for (let maxExtra = 0; maxExtra <= 2; maxExtra += 1) {
      const re = new RegExp(`^(\\s*(?:Par|By)\\s+([\\p{Lu}][\\p{L}'’.\\-]+(?:\\s+[\\p{Lu}][\\p{L}'’.\\-]+){0,${maxExtra}}))`, 'u');
      const m = ex.match(re);
      if (!m) continue;
      const next = ex.slice(m[0].length).trim();
      if (!next || !/^[\p{Lu}0-9«"']/u.test(next)) continue;
      author = normalizeAuthor(m[2]);
      body = next;
      break;
    }
  }

  return { author, body };
}

function normalizeAuthor(name = '') {
  let a = String(name).replace(/\s+/g, ' ').trim();
  a = a.replace(/^(?:Par|By)\s+/i, '').trim();
  if (!a || GENERIC_AUTHORS.test(a) || /@/.test(a)) return '';
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

// ─── Title / brief cleanup ───────────────────────────────────────────────────────
const MC_CATEGORY_PREFIX = /^(?:Photoreportage|Marché aux puces|Cobaye|Incursion|Reportage|Opinion|Entrevue|Critique|Chronique)/;

function stripEmbeddedCss(title = '') {
  let t = String(title).trim();
  if (!/^\.[\w-]+\s*\{/.test(t) && !/@media/i.test(t)) return t;
  const start = t.indexOf('{');
  if (start === -1) return t;
  let depth = 0;
  for (let i = start; i < t.length; i += 1) {
    if (t[i] === '{') depth += 1;
    else if (t[i] === '}') {
      depth -= 1;
      if (depth === 0) return t.slice(i + 1).trim();
    }
  }
  return t;
}

function cleanTitle(title = '') {
  let t = stripEmbeddedCss(title);
  t = t.replace(/\s+/g, ' ').trim();
  const prefix = t.match(MC_CATEGORY_PREFIX);
  if (prefix) t = t.slice(prefix[0].length).trim();
  return t;
}

const BRIEF_LIMITS = { lead: 300, feature: 210, standard: 170, compact: 0 };

function sanitizeBriefBody(raw = '') {
  let s = String(raw);
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/\]\]>/g, '');
  s = s.replace(/\s*L['’]article\b[\s\S]*?est apparu en premier sur[\s\S]*$/i, '');
  const li = s.search(/\sL['’]article\s/);
  if (li > 30) s = s.slice(0, li);
  s = s.replace(/\[[^\]]*(?:read more|lire la suite|continue reading)[^\]]*\]/gi, '');
  s = s.replace(/\b(?:read more|lire la suite|continue reading)\b\.?\s*$/i, '');
  s = s.replace(/^(?:Dear Tribune|Dear Editor),?\s*/i, '');
  s = s.replace(/(?:…|\.{3,}|\[…\]|\[\.\.\.\])/g, '');
  s = s.replace(/&(?:nbsp|#160);/gi, ' ');
  s = s.replace(/&amp;/gi, '&');
  return s.replace(/\s+/g, ' ').trim();
}

function endsCompleteSentence(text = '') {
  return /[.!?»"')\]]\s*$/.test(String(text).trim());
}

function prepareBrief(raw = '', role = 'standard') {
  const limit = BRIEF_LIMITS[role] ?? 170;
  let s = sanitizeBriefBody(raw);
  if (!s || limit === 0 || s.length < 12) return { text: '', truncated: false };

  if (s.length <= limit) {
    const truncated = !endsCompleteSentence(s) && s.length >= 80;
    const text = truncated ? `${s.replace(/[,;:\s]+$/u, '')}...` : s;
    return { text, truncated };
  }

  let cut = s.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > limit * 0.5) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[,;:\s]+$/u, '').trimEnd();
  if (!cut) return { text: '', truncated: false };

  return { text: `${cut}...`, truncated: true };
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
