// LE RADAR — Les médias étudiants du Québec
// Page unique : un syntoniseur radio en haut, un fil d'articles (texte) en dessous.

// Proxy CORS optionnel pour les flux HTTP→HTTPS (déployer proxy/cloudflare-worker.js).
const PROXY_BASE = '';

function safeHttpUrl(url, { allowHttp = false } = {}) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol === 'https:') return u.href;
    if (allowHttp && u.protocol === 'http:') return u.href;
    return null;
  } catch {
    return null;
  }
}

/** Écoute 'change' d'une MediaQueryList avec repli addListener (Safari ≤ 13). */
function onMediaQueryChange(mq, handler) {
  if (!mq) return;
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler);
  else if (typeof mq.addListener === 'function') mq.addListener(handler);
}

function safeCssColor(color) {
  if (!color || typeof color !== 'string') return null;
  const c = color.trim();
  if (c === 'var(--accent)') return c;
  if (/^#[0-9A-Fa-f]{3,8}$/.test(c)) return c;
  return null;
}

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

function isSecurePageUrl(url = '') {
  return !!safeHttpUrl(url);
}

const EXTERNAL_LISTEN_LOAD_MS = 14000;
const EXTERNAL_POPUP_SIZE = 400;

let externalListenTimer = null;
let externalListenPopupWatch = null;

function setExternalListenStatus(mode, text) {
  if (!EXTERNAL_STATUS || !EXTERNAL_STATUS_TEXT) return;
  EXTERNAL_STATUS.classList.remove('is-ready', 'is-error');
  if (mode) EXTERNAL_STATUS.classList.add(mode);
  EXTERNAL_STATUS_TEXT.textContent = text;
}

function clearExternalListenTimers() {
  if (externalListenTimer) {
    clearTimeout(externalListenTimer);
    externalListenTimer = null;
  }
  if (externalListenPopupWatch) {
    clearInterval(externalListenPopupWatch);
    externalListenPopupWatch = null;
  }
}

function closeExternalListen() {
  clearExternalListenTimers();
  if (EXTERNAL_MODAL) {
    EXTERNAL_MODAL.classList.add('hidden');
    EXTERNAL_MODAL.hidden = true;
    EXTERNAL_MODAL.setAttribute('aria-hidden', 'true');
  }
  if (EXTERNAL_FRAME) EXTERNAL_FRAME.removeAttribute('src');
  if (EXTERNAL_FRAME_WRAP) EXTERNAL_FRAME_WRAP.classList.add('hidden');
  document.body.classList.remove('external-listen-open');
}

function bindExternalListen() {
  if (!EXTERNAL_MODAL) return;
  EXTERNAL_MODAL.querySelectorAll('[data-external-close]').forEach((el) => {
    el.addEventListener('click', closeExternalListen);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && EXTERNAL_MODAL && !EXTERNAL_MODAL.hidden) closeExternalListen();
  });
  EXTERNAL_REOPEN?.addEventListener('click', () => {
    if (currentStation && isExternalListen(currentStation)) {
      openExternalListenPopup(currentStation, { focus: true });
    }
  });
}

function openExternalListenPopup(radio, { focus = true } = {}) {
  const url = safeHttpUrl(getListenUrl(radio), { allowHttp: true });
  if (!url) return false;

  const name = `radar-listen-${radio.id}`;
  const features = [
    'popup=yes',
    `width=${EXTERNAL_POPUP_SIZE}`,
    `height=${EXTERNAL_POPUP_SIZE}`,
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
    'scrollbars=yes',
    'resizable=yes',
  ].join(',');

  if (listenWindow && !listenWindow.closed && listenWindowId === radio.id) {
    if (focus) listenWindow.focus();
    setExternalListenStatus('is-ready', 'Fenêtre du lecteur ouverte — appuyez sur ▶ si besoin.');
    return true;
  }

  listenWindow = window.open(url, name, features);
  listenWindowId = radio.id;

  if (!listenWindow) {
    setExternalListenStatus('is-error', 'Fenêtre bloquée par le navigateur. Utilisez le bouton ci-dessous.');
    EXTERNAL_REOPEN?.classList.remove('hidden');
    return false;
  }

  try { listenWindow.opener = null; } catch { /* cross-origin */ }

  setExternalListenStatus('is-ready', 'Fenêtre du lecteur ouverte — appuyez sur ▶ si la lecture ne démarre pas.');
  EXTERNAL_REOPEN?.classList.remove('hidden');

  clearExternalListenTimers();
  externalListenPopupWatch = setInterval(() => {
    if (!listenWindow || listenWindow.closed) {
      clearInterval(externalListenPopupWatch);
      externalListenPopupWatch = null;
      setExternalListenStatus('is-error', 'Fenêtre fermée. Rouvrez le lecteur avec le bouton ci-dessous.');
    }
  }, 800);

  return true;
}

function openExternalListenIframe(radio) {
  const url = safeHttpUrl(getListenUrl(radio));
  if (!url || !EXTERNAL_FRAME || !EXTERNAL_FRAME_WRAP) return;

  EXTERNAL_FRAME_WRAP.classList.remove('hidden');
  EXTERNAL_REOPEN?.classList.add('hidden');
  setExternalListenStatus('', 'Chargement de la page du poste…');

  let settled = false;
  const onReady = () => {
    if (settled) return;
    settled = true;
    clearExternalListenTimers();
    setExternalListenStatus('is-ready', 'Page chargée — appuyez sur ▶ dans le cadre si la lecture ne démarre pas.');
  };
  const onFail = () => {
    if (settled) return;
    settled = true;
    clearExternalListenTimers();
    EXTERNAL_FRAME.removeAttribute('src');
    EXTERNAL_FRAME_WRAP.classList.add('hidden');
    setExternalListenStatus('is-error', 'La page n\'a pas pu se charger ici. Ouvrez le lecteur dans une fenêtre séparée.');
    openExternalListenPopup(radio, { focus: true });
  };

  EXTERNAL_FRAME.onload = onReady;
  EXTERNAL_FRAME.onerror = onFail;
  EXTERNAL_FRAME.src = url;

  externalListenTimer = setTimeout(() => {
    if (!settled) onFail();
  }, EXTERNAL_LISTEN_LOAD_MS);
}

function openListenWindow(radio) {
  const url = getListenUrl(radio);
  if (!url) {
    showToast('Aucun site d\'écoute disponible pour ce poste.');
    return false;
  }

  if (!EXTERNAL_MODAL) {
    return openExternalListenPopup(radio);
  }

  clearExternalListenTimers();

  const hint = radio.listenHint
    || 'Si la lecture ne démarre pas automatiquement, appuyez sur le bouton de lecture (▶) dans le cadre ci-dessus.';
  const inst = shortInstitution(radio.institution, radio.type);

  EXTERNAL_TITLE.textContent = radio.fullName || radio.name;
  EXTERNAL_SUB.textContent = `${radio.frequency || 'Web'} · ${inst}`;
  if (EXTERNAL_HINT) EXTERNAL_HINT.textContent = hint;
  if (EXTERNAL_TAB) EXTERNAL_TAB.href = safeHttpUrl(url, { allowHttp: true }) || '#';

  if (EXTERNAL_LOGO) {
    if (radio.logo) {
      EXTERNAL_LOGO.src = radio.logo;
      EXTERNAL_LOGO.alt = radio.name;
      EXTERNAL_LOGO.classList.remove('hidden');
    } else {
      EXTERNAL_LOGO.classList.add('hidden');
      EXTERNAL_LOGO.removeAttribute('src');
    }
  }

  EXTERNAL_MODAL.classList.remove('hidden');
  EXTERNAL_MODAL.hidden = false;
  EXTERNAL_MODAL.setAttribute('aria-hidden', 'false');
  document.body.classList.add('external-listen-open');

  if (isSecurePageUrl(url)) {
    openExternalListenIframe(radio);
  } else {
    EXTERNAL_FRAME_WRAP?.classList.add('hidden');
    if (EXTERNAL_FRAME) EXTERNAL_FRAME.removeAttribute('src');
    EXTERNAL_REOPEN?.classList.remove('hidden');
    setExternalListenStatus('', 'Ouverture du lecteur dans une fenêtre séparée…');
    const opened = openExternalListenPopup(radio, { focus: true });
    if (!opened) {
      setExternalListenStatus('is-error', 'Impossible d\'ouvrir la fenêtre. Utilisez « Ouvrir dans un onglet ».');
    }
  }

  return true;
}

// ─── DOM refs ────────────────────────────────────────────────────────────────
const IS_TUNER_EMBED = document.documentElement.dataset.embed === 'tuner';
const TUNER          = document.getElementById('tuner');
const TUNER_SELECT   = document.getElementById('tuner-select');
const TUNER_PREV     = document.getElementById('tuner-prev');
const TUNER_NEXT     = document.getElementById('tuner-next');
const TUNER_PLAY     = document.getElementById('tuner-play');
const TUNER_NAME     = document.getElementById('tuner-now-name');
const TUNER_SUB      = document.getElementById('tuner-now-sub');
const TUNER_SUB_AIR  = document.getElementById('tuner-now-sub-air');
const TUNER_SUB_ROTATE_MQ = window.matchMedia?.('(max-width: 1099.98px)');
// < 600 px = vrai téléphone. Demi-écran laptop (≈680–960) reste tablette.
const TUNER_DIAL_PHONE_MQ = window.matchMedia?.('(max-width: 599.98px)');
const TUNER_SUB_ROTATE_NARROW_MQ = window.matchMedia?.('(max-width: 479.98px)');
const TUNER_SUB_ROTATE_VERY_NARROW_MQ = window.matchMedia?.('(max-width: 359.98px)');
const TUNER_VOLUME   = document.getElementById('tuner-volume');
const TUNER_VOL      = document.getElementById('tuner-vol');
const TUNER_VOL_TOGGLE = document.getElementById('tuner-vol-toggle');
const TUNER_VOL_MUTE   = document.getElementById('tuner-vol-mute');
const VOL_COMPACT    = window.matchMedia('(max-width: 1099.98px)');
/** Embed iframe : volume en ligne, icône = mute (pas de popover). */
function isVolCompactMode() {
  if (IS_TUNER_EMBED) return false;
  return VOL_COMPACT.matches;
}
const TUNER_NOWAIR = document.getElementById('tuner-nowair');
const TUNER_NOWAIR_TITLE = document.getElementById('tuner-nowair-title');
const TUNER_NOWAIR_SUB = document.getElementById('tuner-nowair-sub');
const ICO_PLAY       = TUNER_PLAY.querySelector('.ico-play');
const ICO_PAUSE      = TUNER_PLAY.querySelector('.ico-pause');
const ICO_EXTERNAL   = TUNER_PLAY.querySelector('.ico-external');

const NEWS_LIST      = document.getElementById('news-list');
const FILTERS_PANEL  = document.getElementById('news-filters-panel');
const NEWS_FILTERS   = document.getElementById('news-filters');
const FILTERS_TOGGLE = document.getElementById('filters-toggle');
const FILTERS_COMPACT = document.getElementById('filters-compact');
// Aligné sur le CSS : mode filtres « téléphone » seulement < 600 px.
const FILTERS_MOBILE = window.matchMedia('(max-width: 599.98px)');
const NEWS_COUNT     = document.getElementById('news-count');
const NEWS_UPDATED   = document.getElementById('news-updated');
const NEWS_EMPTY     = document.getElementById('news-empty');
const TODAY_DATE     = document.getElementById('today-date');
const TOAST_EL       = document.getElementById('toast');
const THEME_TOGGLE   = document.getElementById('theme-toggle');
const EXTERNAL_MODAL = document.getElementById('external-listen');
const EXTERNAL_TITLE = document.getElementById('external-listen-title');
const EXTERNAL_SUB   = document.getElementById('external-listen-sub');
const EXTERNAL_STATUS = document.getElementById('external-listen-status');
const EXTERNAL_STATUS_TEXT = document.getElementById('external-listen-status-text');
const EXTERNAL_FRAME_WRAP = document.getElementById('external-listen-frame-wrap');
const EXTERNAL_FRAME = document.getElementById('external-listen-frame');
const EXTERNAL_HINT  = document.getElementById('external-listen-hint');
const EXTERNAL_REOPEN = document.getElementById('external-listen-reopen');
const EXTERNAL_TAB   = document.getElementById('external-listen-tab');
const EXTERNAL_LOGO  = document.getElementById('external-listen-logo');

// ─── State ───────────────────────────────────────────────────────────────────
let radios = [];          // ordered list backing the tuner
let news = [];
let newsSourcesByName = {};
let newsSourceFilter = 'all';
let currentStation = null; // radio object selected in tuner
let audio = null;
let suppressAudioError = false;
// Amplification optionnelle via Web Audio : permet de dépasser 100 % pour les
// flux trop faibles (ex. CKUT). Les postes sans en-tête CORS ne peuvent pas être
// amplifiés ; on retombe alors en lecture native plafonnée à 100 %.
let audioCtx = null;
let gainNode = null;
let mediaSource = null;
let boostWired = false;             // graphe Web Audio branché sur l'élément courant
let webAudioSupported = !!(window.AudioContext || window.webkitAudioContext);
// Web Audio suspend l'AudioContext à l'écran verrouillé → lecture native seule sur mobile.
const MOBILE_PLAYBACK = window.matchMedia('(hover: none) and (pointer: coarse)').matches
  || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
let userPaused = false;
let mobilePlayback = null;
const playerListenersAttached = new WeakSet();
const DEFAULT_GAIN = 1;             // 100 % — centre du curseur 0–200 %
let currentGain = DEFAULT_GAIN;
let volumeMuted = false;
let gainBeforeMute = DEFAULT_GAIN;
const MAX_GAIN = 2;                 // jusqu'à 200 %
// Mobile : pas d'amplification (Web Audio suspendu à l'écran verrouillé) —
// le curseur s'arrête à 100 % au lieu d'afficher une zone 100–200 % inerte.
const GAIN_UI_MAX = (webAudioSupported && !MOBILE_PLAYBACK) ? MAX_GAIN : 1;
const VOL_THUMB_PX = 16;
let volumeSliderDragging = false;
const boostUnavailable = new Set(); // ids des postes sans CORS
// Réglages de lecture par poste. CFAK (Sherbrooke) a de petites coupures : on
// précharge davantage et on reconnecte automatiquement quand le flux décroche.
// CHYZ (Centova/Shoutcast) : lecture native seule — Web Audio + crossOrigin casse le flux.
const STATION_PLAYBACK = {
  cfak: { resilient: true },
  chyz: { resilient: true, noBoost: true },
};
let reconnectTries = 0;
let listenWindow = null;
let listenWindowId = null;
let radioNowPlaying = { stations: {}, updatedAt: null };
let radioSchedules = { stations: {}, timezone: 'America/Toronto' };
let nowPlayingPollTimer = null;
let nowAirTick = null;
let nowAirPreviewTimer = null;
let nowAirPreviewRadio = null;
let lastNowAirPreviewId = null;
let lastDialCarouselText = '';
let lastNowAir = { title: null, sub: null, empty: null, previewId: null };
let tunerSubMeta = '';
let tunerSubAirText = '';
let tunerSubRotateTimer = null;
let tunerSubRotateShowAir = false;
const TUNER_SUB_ROTATE_MS = 8000;
const TUNER_SUB_ROTATE_NARROW_MS = 14000;
const TUNER_SUB_ROTATE_VERY_NARROW_MS = 18000;
const NOW_AIR_CROSSFADE_MS = 700;
const PREFERS_REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)');
let sourceColors = {};     // source name → accent colour
let brandColors = { institutions: {}, fallback_palette: ['#003DA5', '#6C2163', '#047857'] };
let filtersExpanded = false;
let volSliderResizeObs = null;
const marqueeTextByEl = new WeakMap();
const marqueeObservedEls = new WeakSet();
let marqueeResizeObs = null;
let marqueeResizeScheduled = false;
let filterMarqueeResyncTimer = null;
const FILTER_MARQUEE_RESYNC_MS = 480;

/** Rangées visibles avant « Plus de sources » — desktop 3 ; tablette/mobile 2. */
const FILTERS_COLLAPSED_ROWS_DESKTOP = 3;
const FILTERS_COLLAPSED_ROWS_COMPACT = 2;
const FILTERS_COMPACT_MQ = window.matchMedia('(max-width: 1099.98px)');
const FILTERS_ROW_CAPACITY = 3;
const FILTERS_COLS_NARROW = 420;
/** Max colonnes bureau (grand écran). */
const FILTERS_DESKTOP_MAX_COLS = 5;
const FILTERS_DESKTOP_WIDE_MIN = 960;
const FILTERS_DESKTOP_DEFAULT_COLS = FILTERS_DESKTOP_MAX_COLS;

const GENERIC_AUTHORS = /^(admin|administrator|administrateur|editor|éditeur|editeur|rédaction|redaction|staff|wordpress|webmaster|collectif|tribune|link|daily|coordinating|exemplaire|quartier libre|zone campus|la pige|le délit|le delit|the link|the tribune|the mcgill daily)$/i;

// ─── Bootstrap ───────────────────────────────────────────────────────────────
init().catch((e) => console.error('init failed', e));

async function init() {
  initTheme();
  initMastheadActions();
  renderTodayDate();
  setupAudio();
  bindTuner();
  bindExternalListen();
  bindFiltersPanel();

  try {
    const brandData = await fetch('./brand-colors.json').then((r) => r.json());
    if (brandData?.institutions) brandColors = brandData;
  } catch (e) {
    console.warn('Failed to load brand-colors.json', e);
  }

  try {
    const sourcesRegistry = await fetch('./news-sources.json')
      .then((r) => r.json())
      .catch(() => ({ active: [] }));
    newsSourcesByName = Object.fromEntries(
      (sourcesRegistry?.active || []).map((s) => [s.name, s]),
    );
  } catch {
    newsSourcesByName = {};
  }

  const [radiosData, nowPlayingData, schedulesData] = await Promise.allSettled([
    fetch('./radios.json').then((r) => r.json()),
    fetch('./radio-nowplaying.json').then((r) => r.json()),
    fetch('./radio-schedules.json').then((r) => r.json()),
    ...(IS_TUNER_EMBED ? [] : [loadNews()]),
  ]);

  radios = radiosData.status === 'fulfilled'
    ? sortRadios(radiosData.value).filter((r) => getPlayableStream(r))
    : [];
  radioNowPlaying = nowPlayingData.status === 'fulfilled' ? nowPlayingData.value : { stations: {} };
  radioSchedules = schedulesData.status === 'fulfilled' && schedulesData.value?.stations
    ? schedulesData.value
    : { stations: {}, timezone: 'America/Toronto' };
  buildTunerOptions();
  tunerSubMeta = TUNER_SUB?.textContent?.trim() || 'Radios étudiantes en direct';
  initTunerSubRotateListeners();
  initMarqueeResizeListeners();
  // API live navigateur (CISM…) avant le premier rendu d'antenne.
  refreshStationLiveApis().finally(() => {
    renderTunerNowAir();
  });
  startNowAirTick();
  restoreVolume();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (IS_TUNER_EMBED || !('serviceWorker' in navigator)) return;
  // Ne jamais recharger pendant une écoute : un déploiement coupait la radio.
  // La nouvelle version s'appliquera à la prochaine navigation / pause.
  const reloadUnlessListening = () => {
    if (!isPlaybackActive()) window.location.reload();
  };
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'activated' && navigator.serviceWorker.controller) {
          reloadUnlessListening();
        }
      });
    });
    if (reg.waiting && navigator.serviceWorker.controller) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  }).catch((e) => {
    console.warn('Service worker registration failed', e);
  });
  navigator.serviceWorker.getRegistrations?.().then((regs) => {
    regs.forEach((reg) => reg.update());
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', reloadUnlessListening);
}

/** Évite que hover/focus laissent un bouton masthead « engagé » après un tap ou clic. */
function initMastheadActions() {
  document.querySelectorAll('.masthead-actions .masthead-icon').forEach((el) => {
    const release = () => {
      requestAnimationFrame(() => {
        if (document.activeElement === el) el.blur();
      });
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('click', release);
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
  if (!TODAY_DATE) return;
  const now = new Date();
  TODAY_DATE.textContent = now.toLocaleDateString('fr-CA', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  TUNER
// ═══════════════════════════════════════════════════════════════════════════
/** Ordre d’affichage dans le menu du syntoniseur (universités en tête). */
const TUNER_STATION_ORDER = ['chyz', 'choq', 'cism', 'ckut'];

function tunerStationRank(radio = {}) {
  const idx = TUNER_STATION_ORDER.indexOf(radio.id);
  return idx >= 0 ? idx : 100 + radioPopularityRank(radio);
}

function sortRadios(list) {
  const order = { universite: 0, cegep: 1 };
  return [...list].sort((a, b) => {
    const t = (order[a.type] ?? 9) - (order[b.type] ?? 9);
    if (t !== 0) return t;
    const aNative = getPlayableStream(a) ? 0 : 1;
    const bNative = getPlayableStream(b) ? 0 : 1;
    if (aNative !== bNative) return aNative - bNative;
    const rankDiff = tunerStationRank(a) - tunerStationRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name, 'fr');
  });
}

/** Mode radio : enchaîner les flux natifs après un poste externe (prev/next ou menu). */
function tunerShouldAutoplayNative(next) {
  if (!next || !getPlayableStream(next)) return false;
  if (isPlaying()) return true;
  return !!(currentStation && isExternalListen(currentStation));
}

function radioPopularityRank(radio = {}) {
  return typeof radio.popularity === 'number' ? radio.popularity : 50;
}

function radioSlogan(radio = {}) {
  return String(radio.slogan || '').trim()
    || String(radio.description || '').split('.')[0]?.trim()
    || '';
}

function nowPlayingEntry(radio) {
  return radio?.id ? radioNowPlaying.stations?.[radio.id] : null;
}

function normLoose(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Émission en cours / à venir : d'abord le bot (radio-nowplaying.json), puis grille locale. */
function botCurrentShow(radio) {
  const entry = nowPlayingEntry(radio);
  const cur = entry?.current;
  if (cur?.title && String(cur.title).trim().length >= 3) return cur;
  const legacy = String(entry?.showTitle || '').trim();
  if (legacy.length >= 3) {
    return {
      title: legacy,
      host: entry?.host || '',
      source: entry?.source || '',
    };
  }
  return null;
}

function botNextShow(radio) {
  const next = nowPlayingEntry(radio)?.next;
  if (next?.title && String(next.title).trim().length >= 3) return next;
  return null;
}

function nowAirShowTitle(radio) {
  return String(botCurrentShow(radio)?.title || '').trim();
}

// ─── Repli grille locale (si bot absent ou incomplet) ───────────────────────────

/** Jour (0-6) + minutes depuis minuit dans le fuseau de la grille. */
function scheduleZonedNow(date = new Date()) {
  const tz = radioNowPlaying.timezone || radioSchedules.timezone || 'America/Toronto';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(map.hour, 10);
  if (hour === 24 || Number.isNaN(hour)) hour = 0;
  const minute = parseInt(map.minute, 10) || 0;
  return { day: wd[map.weekday] ?? 0, minutes: hour * 60 + minute };
}

function scheduleTimeToMin(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Plage horaire couvrant l'instant présent (gère les émissions de nuit). */
function scheduleCurrentSlot(radio) {
  const grid = radio?.id ? radioSchedules.stations?.[radio.id]?.grid : null;
  if (!Array.isArray(grid) || !grid.length) return null;
  const WEEK = 7 * 1440;
  const { day, minutes } = scheduleZonedNow();
  const nowAbs = day * 1440 + minutes;
  for (const slot of grid) {
    const start = scheduleTimeToMin(slot.start);
    const end = scheduleTimeToMin(slot.end);
    if (start == null || end == null || !slot.title) continue;
    const startAbs = slot.day * 1440 + start;
    const endAbs = slot.day * 1440 + (end <= start ? end + 1440 : end);
    if ((nowAbs >= startAbs && nowAbs < endAbs)
      || (nowAbs + WEEK >= startAbs && nowAbs + WEEK < endAbs)) {
      return slot;
    }
  }
  return null;
}

/** Prochaine émission planifiée (utile entre deux créneaux, ex. CHYZ l'après-midi). */
function scheduleNextSlot(radio) {
  const grid = radio?.id ? radioSchedules.stations?.[radio.id]?.grid : null;
  if (!Array.isArray(grid) || !grid.length) return null;
  const WEEK = 7 * 1440;
  const { day, minutes } = scheduleZonedNow();
  const nowAbs = day * 1440 + minutes;
  let best = null;
  let bestDelta = WEEK;
  for (const slot of grid) {
    const start = scheduleTimeToMin(slot.start);
    if (start == null || !slot.title) continue;
    const startAbs = slot.day * 1440 + start;
    let delta = startAbs - nowAbs;
    if (delta <= 0) delta += WEEK;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = slot;
    }
  }
  return best;
}

/** true si le bot a une source « live » fiable (API station). */
function isAuthoritativeLiveShow(radio) {
  const cur = botCurrentShow(radio);
  const src = String(cur?.source || nowPlayingEntry(radio)?.source || '');
  return src === 'api-live';
}

/**
 * Lignes d'antenne pour le syntoniseur.
 * Priorité : bot.current (API/grille/ICY fusionnés) → bot.next → grille locale → slogan.
 */
function nowAirLines(radio) {
  const slogan = radioSlogan(radio);
  const entry = nowPlayingEntry(radio);
  const botCur = botCurrentShow(radio);
  const botNext = botNextShow(radio);
  const schedCur = scheduleCurrentSlot(radio);
  const schedNext = scheduleNextSlot(radio);
  const track = String(entry?.track || '').trim();

  // 1) Émission en cours (bot, déjà fusionné api > schedule > icy)
  if (botCur?.title) {
    const host = String(botCur.host || entry?.host || '').trim();
    const start = botCur.start || schedCur?.start || '';
    const end = botCur.end || schedCur?.end || '';
    const timeRange = start && end ? `${start} – ${end}` : (start || '');
    let sub;
    if (host) sub = `avec ${host}`;
    else if (track && normLoose(track) !== normLoose(botCur.title)) sub = `♪ ${track}`;
    else if (timeRange) sub = timeRange;
    else sub = slogan || `Vous écoutez ${radio.name}`;
    return { title: botCur.title, sub };
  }

  // 2) Repli grille locale (bot pas encore à jour)
  if (schedCur?.title) {
    const timeRange = schedCur.start && schedCur.end
      ? `${schedCur.start} – ${schedCur.end}`
      : '';
    let sub;
    if (track) sub = `♪ ${track}`;
    else if (schedCur.host) sub = `avec ${schedCur.host}`;
    else if (timeRange) sub = timeRange;
    else sub = slogan || `Vous écoutez ${radio.name}`;
    return { title: schedCur.title, sub };
  }

  // 3) À venir (bot puis grille)
  const upcoming = botNext || (schedNext
    ? { title: schedNext.title, start: schedNext.start, end: schedNext.end }
    : null);
  if (upcoming?.title) {
    const timeRange = upcoming.start && upcoming.end
      ? `${upcoming.start} – ${upcoming.end}`
      : (upcoming.start || '');
    return {
      title: upcoming.title,
      sub: timeRange ? `À venir · ${timeRange}` : 'À venir',
    };
  }

  return { title: `Vous écoutez ${radio.name}`, sub: slogan };
}

/** Une seule ligne « À l'antenne » pour la rotation du sous-titre. */
function formatNowAirSubLine(title, sub, empty) {
  if (empty) return 'Les radios étudiantes jouent en direct, 24/7';
  if (sub) return `${title} · ${sub}`;
  return title;
}

function nowAirInterestScore(radio) {
  if (botCurrentShow(radio) && isAuthoritativeLiveShow(radio)) return 4;
  if (botCurrentShow(radio) || scheduleCurrentSlot(radio)?.title) return 3;
  if (botNextShow(radio) || scheduleNextSlot(radio)?.title) return 2;
  if (nowPlayingEntry(radio)?.track) return 1;
  return 0;
}

function nowAirPreviewPool() {
  const interesting = radios.filter((r) => nowAirInterestScore(r) > 0);
  return interesting.length ? interesting : radios;
}

function pickNowAirPreviewRadio() {
  const pool = nowAirPreviewPool();
  if (!pool.length) {
    nowAirPreviewRadio = null;
    return null;
  }
  let pick = pool[Math.floor(Math.random() * pool.length)];
  if (pool.length > 1 && pick.id === lastNowAirPreviewId) {
    const others = pool.filter((r) => r.id !== lastNowAirPreviewId);
    pick = others[Math.floor(Math.random() * others.length)];
  }
  nowAirPreviewRadio = pick;
  lastNowAirPreviewId = pick.id;
  return pick;
}

function formatStationNowAirLabel(radio) {
  const inst = shortInstitution(radio.institution, radio.type);
  return inst ? `${radio.name} · ${inst}` : radio.name;
}

/* ── Synthoniseur uniquement (#tuner-now-name) — pas articles, filtres ni RSS ── */

/** Téléphone (< 600 px) : acronyme dans le titre du syntoniseur seulement. */
function isTunerDialPhoneLayout() {
  return IS_TUNER_EMBED || !!TUNER_DIAL_PHONE_MQ?.matches;
}

/** Institution affichée dans le syntoniseur : abrégée au téléphone, complète en tablette. */
function tunerDialInstitutionLabel(radio) {
  if (!radio) return '';
  if (isTunerDialPhoneLayout()) {
    return shortInstitution(radio.institution, radio.type);
  }
  return tunerInstitutionLabel(radio.institution);
}

/** Ligne 1 du syntoniseur (vue compacte) : « poste · établissement ». */
function tunerDialTitleLine(radio) {
  if (!radio) return tunerSubMeta || 'Radios étudiantes en direct';
  const inst = tunerDialInstitutionLabel(radio);
  return inst ? `${radio.name} · ${inst}` : radio.name;
}

/** Mobile / tablette (< 1100 px) : titre du dial = poste · établissement. */
function isDialCompactLayout() {
  return IS_TUNER_EMBED || !!TUNER_SUB_ROTATE_MQ?.matches;
}

/**
 * Ligne 2 du dial compact : émission en cours, à venir, ou slogan.
 * Réutilise nowAirLines() pour couvrir toutes les stations (grille, ICY, slogan).
 */
function dialCompactSubLineForRadio(radio) {
  if (!radio) return '';
  const { title, sub } = nowAirLines(radio);
  const genericListen = `Vous écoutez ${radio.name}`;

  if (title && title !== genericListen) {
    return formatNowAirSubLine(title, sub, false);
  }

  return radioSlogan(radio) || '';
}

function applyDialCompactSub(radio, crossfade = false) {
  const line = dialCompactSubLineForRadio(radio);
  TUNER_SUB?.parentElement?.classList.toggle('is-empty', !line);
  tunerSubMeta = line;
  if (crossfade) {
    applyDialTextCrossfade(TUNER_SUB, line, true);
  } else {
    applyMarquee(TUNER_SUB, line);
  }
}

function formatPreviewNowAir(radio, { omitStation = false } = {}) {
  const stationLine = formatStationNowAirLabel(radio);
  const { title, sub } = nowAirLines(radio);
  const genericListen = `Vous écoutez ${radio.name}`;
  const slogan = radioSlogan(radio);

  let airDetail = sub || '';
  if (!airDetail || airDetail === genericListen || airDetail === slogan) {
    airDetail = '';
  }

  if (omitStation) {
    if (title === genericListen) {
      const fallback = airDetail || slogan || '';
      return { title: fallback || 'En direct', sub: '' };
    }
    return { title, sub: airDetail || '' };
  }

  if (title === genericListen) {
    return {
      title: stationLine,
      sub: airDetail || slogan || '',
    };
  }

  return {
    title,
    sub: airDetail ? `${stationLine} · ${airDetail}` : stationLine,
  };
}

function stopNowAirPreview() {
  if (nowAirPreviewTimer) {
    clearTimeout(nowAirPreviewTimer);
    nowAirPreviewTimer = null;
  }
}

/** Temps de lecture minimal quand le texte défile (aller-retour + pauses). */
function marqueeReadingTimeMs(el) {
  if (!el?.classList.contains('is-marquee')) return 0;
  const sec = parseFloat(el.style.getPropertyValue('--marquee-duration'));
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.ceil(sec * 1000 * 2.4) + 2500;
}

/** Délai avant la prochaine alternance du sous-titre (plus long si écran étroit / texte long). */
function getTunerSubRotateDelayMs(activeEl) {
  let delay = TUNER_SUB_ROTATE_MS;

  if (TUNER_SUB_ROTATE_MQ?.matches) {
    if (TUNER_SUB_ROTATE_VERY_NARROW_MQ?.matches) {
      delay = TUNER_SUB_ROTATE_VERY_NARROW_MS;
    } else if (TUNER_SUB_ROTATE_NARROW_MQ?.matches) {
      delay = TUNER_SUB_ROTATE_NARROW_MS;
    }
    const readTime = marqueeReadingTimeMs(activeEl);
    if (readTime) delay = Math.max(delay, readTime);
  }

  return delay;
}

function planTunerSubRotateDelay(activeEl, attempt, onReady) {
  const span = activeEl?.querySelector('.tuner-now-sub-text');
  const mightOverflow = span && activeEl?.clientWidth > 0
    && span.scrollWidth > activeEl.clientWidth + 4;

  if (attempt < 4 && mightOverflow && !activeEl?.classList.contains('is-marquee')) {
    requestAnimationFrame(() => planTunerSubRotateDelay(activeEl, attempt + 1, onReady));
    return;
  }

  onReady(getTunerSubRotateDelayMs(activeEl));
}

function isNowAirPanelPreviewMode() {
  return !currentStation && !PREFERS_REDUCED_MOTION?.matches && radios.length > 0;
}

/** Mobile sans poste : le sous-titre du dial affiche uniquement l'aperçu à l'antenne. */
function isMobileIdleDialPreview() {
  return isNowAirPanelPreviewMode() && !!TUNER_SUB_ROTATE_MQ?.matches;
}

/** Bureau sans poste : faire défiler les radios disponibles dans le sous-titre du dial. */
function isDesktopIdleDialCarousel() {
  return !currentStation
    && !PREFERS_REDUCED_MOTION?.matches
    && !TUNER_SUB_ROTATE_MQ?.matches
    && radios.length > 0;
}

function applyDialTextCrossfade(el, text, crossfade = false) {
  if (!el) return;
  if (!crossfade || PREFERS_REDUCED_MOTION?.matches) {
    applyMarquee(el, text);
    return;
  }
  el.classList.add('is-crossfading');
  setTimeout(() => {
    applyMarquee(el, text);
    requestAnimationFrame(() => el.classList.remove('is-crossfading'));
  }, NOW_AIR_CROSSFADE_MS);
}

/** Bureau sans poste : titre fixe + postes qui défilent en bas ; « À l'antenne » reste à part. */
function syncDesktopDialPreview(_airTitle, crossfade = false) {
  if (!isDesktopIdleDialCarousel()) {
    if (!currentStation) setTunerNameText('Syntoniser un poste');
    return;
  }

  if (!nowAirPreviewRadio) {
    setTunerNameText('Syntoniser un poste');
    if (tunerSubMeta) applyMarquee(TUNER_SUB, tunerSubMeta);
    return;
  }

  const stationLine = tunerDialTitleLine(nowAirPreviewRadio);
  const subText = TUNER_SUB?.querySelector('.tuner-now-sub-text')?.textContent;
  if (!crossfade && stationLine === lastDialCarouselText && subText === stationLine) {
    setTunerNameText('Syntoniser un poste');
    return;
  }
  lastDialCarouselText = stationLine;

  setTunerNameText('Syntoniser un poste');
  applyDialTextCrossfade(TUNER_SUB, stationLine, crossfade);
}

function scheduleNowAirPreviewTick() {
  if (nowAirPreviewTimer) {
    clearTimeout(nowAirPreviewTimer);
    nowAirPreviewTimer = null;
  }
  if (currentStation || !isNowAirPanelPreviewMode()) return;

  planTunerSubRotateDelay(TUNER_SUB, 0, (delay) => {
    if (currentStation || !isNowAirPanelPreviewMode()) return;
    nowAirPreviewTimer = setTimeout(() => {
      nowAirPreviewTimer = null;
      if (currentStation || !isNowAirPanelPreviewMode()) return;
      pickNowAirPreviewRadio();
      renderTunerNowAir();
      scheduleNowAirPreviewTick();
    }, delay);
  });
}

function startNowAirPreview() {
  if (nowAirPreviewTimer || currentStation || !isNowAirPanelPreviewMode()) return;
  if (!nowAirPreviewRadio) pickNowAirPreviewRadio();
  scheduleNowAirPreviewTick();
}

function isTunerSubRotateMode() {
  return !PREFERS_REDUCED_MOTION?.matches && !!TUNER_SUB_ROTATE_MQ?.matches;
}

function stopTunerSubRotate() {
  if (tunerSubRotateTimer) {
    clearTimeout(tunerSubRotateTimer);
    tunerSubRotateTimer = null;
  }
  TUNER_SUB?.parentElement?.classList.remove('is-rotating');
}

function scheduleTunerSubRotateTick() {
  if (tunerSubRotateTimer) {
    clearTimeout(tunerSubRotateTimer);
    tunerSubRotateTimer = null;
  }
  if (!isTunerSubRotateMode() || !currentStation) return;

  const activeEl = tunerSubRotateShowAir ? TUNER_SUB_AIR : TUNER_SUB;
  planTunerSubRotateDelay(activeEl, 0, (delay) => {
    if (!isTunerSubRotateMode() || !currentStation) return;
    tunerSubRotateTimer = setTimeout(() => {
      tunerSubRotateTimer = null;
      if (!isTunerSubRotateMode() || !currentStation) return;
      tunerSubRotateShowAir = !tunerSubRotateShowAir;
      setTunerSubRotateActive(tunerSubRotateShowAir);
      scheduleTunerSubRotateTick();
    }, delay);
  });
}

function restartTunerSubRotateTimer() {
  if (TUNER_SUB?.parentElement?.classList.contains('is-rotating') && currentStation) {
    scheduleTunerSubRotateTick();
  }
}

function setTunerSubRotateActive(showAir) {
  if (!TUNER_SUB || !TUNER_SUB_AIR) return;
  TUNER_SUB.classList.toggle('is-active', !showAir);
  TUNER_SUB_AIR.classList.toggle('is-active', showAir);
  TUNER_SUB.setAttribute('aria-hidden', String(showAir));
  TUNER_SUB_AIR.setAttribute('aria-hidden', String(!showAir));
  if (showAir) {
    TUNER_SUB.classList.remove('is-marquee');
    applyMarquee(TUNER_SUB_AIR, tunerSubAirText);
  } else {
    TUNER_SUB_AIR.classList.remove('is-marquee');
    applyMarquee(TUNER_SUB, tunerSubMeta);
  }
  scheduleMarqueeRefresh();
}

/**
 * Compact (< 1100 px) + poste : ligne 1 = poste · institution, ligne 2 = antenne / à venir / slogan.
 * Bureau : ligne 1 = poste, ligne 2 = fréquence · institution ; panneau latéral pour l'antenne.
 */
function updateNowAirSubAirText(text, crossfade = false) {
  if (!TUNER_SUB_AIR) return;
  if (!crossfade || !isTunerSubRotateMode()) {
    applyMarquee(TUNER_SUB_AIR, text);
    return;
  }
  TUNER_SUB_AIR.classList.add('is-crossfading');
  setTimeout(() => {
    applyMarquee(TUNER_SUB_AIR, text);
    requestAnimationFrame(() => TUNER_SUB_AIR.classList.remove('is-crossfading'));
  }, NOW_AIR_CROSSFADE_MS);
}

function updateNowAirPanel(title, sub, crossfade = false) {
  const body = TUNER_NOWAIR?.querySelector('.tuner-nowair-body');
  const write = () => {
    applyMarquee(TUNER_NOWAIR_TITLE, title);
    if (TUNER_NOWAIR_SUB) {
      TUNER_NOWAIR_SUB.classList.toggle('hidden', !sub);
      if (sub) applyMarquee(TUNER_NOWAIR_SUB, sub);
      else TUNER_NOWAIR_SUB.replaceChildren();
    }
  };

  if (crossfade && !PREFERS_REDUCED_MOTION?.matches && body) {
    body.classList.add('is-swapping');
    setTimeout(() => {
      write();
      requestAnimationFrame(() => body.classList.remove('is-swapping'));
    }, NOW_AIR_CROSSFADE_MS);
  } else {
    write();
  }
}

function syncTunerSubRotate(title, sub, empty, crossfade = false) {
  if (!TUNER_SUB || !TUNER_SUB_AIR) return;
  tunerSubAirText = formatNowAirSubLine(title, sub, empty);
  const wrapper = TUNER_SUB.parentElement;

  if (isMobileIdleDialPreview()) {
    stopTunerSubRotate();
    wrapper?.classList.remove('is-rotating');
    TUNER_SUB.classList.add('is-active');
    TUNER_SUB_AIR.classList.remove('is-active');
    TUNER_SUB.setAttribute('aria-hidden', 'false');
    TUNER_SUB_AIR.setAttribute('aria-hidden', 'true');
    applyDialTextCrossfade(TUNER_SUB, tunerSubAirText, crossfade);
    return;
  }

  if (currentStation && isDialCompactLayout()) {
    stopTunerSubRotate();
    wrapper?.classList.remove('is-rotating');
    TUNER_SUB.classList.add('is-active');
    TUNER_SUB_AIR.classList.remove('is-active');
    TUNER_SUB.setAttribute('aria-hidden', 'false');
    TUNER_SUB_AIR.setAttribute('aria-hidden', 'true');
    applyDialCompactSub(currentStation, crossfade);
    setTunerNameText(tunerDialTitleLine(currentStation), crossfade);
    return;
  }

  if (!isTunerSubRotateMode()) {
    stopTunerSubRotate();
    TUNER_SUB.classList.add('is-active');
    TUNER_SUB_AIR.classList.remove('is-active');
    TUNER_SUB.setAttribute('aria-hidden', 'false');
    TUNER_SUB_AIR.setAttribute('aria-hidden', 'true');

    if (isDesktopIdleDialCarousel()) {
      return;
    }

    const showAirInDialSub = currentStation && TUNER_SUB_ROTATE_MQ?.matches;
    if (showAirInDialSub) {
      applyMarquee(TUNER_SUB, tunerSubAirText);
    } else if (tunerSubMeta) {
      applyMarquee(TUNER_SUB, tunerSubMeta);
    }
    return;
  }

  wrapper?.classList.add('is-rotating');
  applyMarquee(TUNER_SUB, tunerSubMeta);
  updateNowAirSubAirText(tunerSubAirText, crossfade);

  if (!tunerSubRotateTimer) {
    tunerSubRotateShowAir = false;
    setTunerSubRotateActive(false);
    scheduleTunerSubRotateTick();
  } else if (tunerSubRotateShowAir) {
    updateNowAirSubAirText(tunerSubAirText, crossfade);
  } else {
    applyMarquee(TUNER_SUB, tunerSubMeta);
  }
  scheduleMarqueeRefresh();
}

function onTunerSubRotateLayoutChange() {
  renderTunerNowAir();
  scheduleMarqueeRefresh();
  restartTunerSubRotateTimer();
  if (!currentStation && isNowAirPanelPreviewMode()) {
    scheduleNowAirPreviewTick();
  }
}

function initTunerSubRotateListeners() {
  onMediaQueryChange(TUNER_SUB_ROTATE_MQ, onTunerSubRotateLayoutChange);
  onMediaQueryChange(TUNER_DIAL_PHONE_MQ, onTunerSubRotateLayoutChange);
  onMediaQueryChange(TUNER_SUB_ROTATE_NARROW_MQ, onTunerSubRotateLayoutChange);
  onMediaQueryChange(TUNER_SUB_ROTATE_VERY_NARROW_MQ, onTunerSubRotateLayoutChange);
  onMediaQueryChange(PREFERS_REDUCED_MOTION, onTunerSubRotateLayoutChange);
}

function renderTunerNowAir() {
  if (!TUNER_NOWAIR) return;

  const previewing = isNowAirPanelPreviewMode();
  let title;
  let sub;

  if (currentStation) {
    ({ title, sub } = nowAirLines(currentStation));
  } else if (previewing) {
    if (!nowAirPreviewRadio) pickNowAirPreviewRadio();
    if (nowAirPreviewRadio) {
      ({ title, sub } = formatPreviewNowAir(nowAirPreviewRadio, {
        omitStation: isDesktopIdleDialCarousel(),
      }));
    } else {
      title = 'Syntoniser un poste';
      sub = 'Les radios étudiantes jouent en direct, 24/7';
    }
  } else {
    title = 'Syntoniser un poste';
    sub = 'Les radios étudiantes jouent en direct, 24/7';
  }

  const empty = !currentStation && !previewing;
  const previewId = previewing ? (nowAirPreviewRadio?.id ?? null) : null;

  // Rien n'a changé : on n'écrase pas le DOM (sinon le défilement repart à zéro
  // à chaque tic d'horloge).
  if (lastNowAir.title === title
    && lastNowAir.sub === sub
    && lastNowAir.empty === empty
    && lastNowAir.previewId === previewId) {
    if (currentStation) stopNowAirPreview();
    else if (previewing) startNowAirPreview();
    else stopNowAirPreview();
    return;
  }
  const crossfadePreview = previewing
    && !PREFERS_REDUCED_MOTION?.matches
    && lastNowAir.previewId != null
    && previewId !== lastNowAir.previewId;

  lastNowAir = { title, sub, empty, previewId };

  TUNER_NOWAIR.classList.remove('hidden');
  TUNER_NOWAIR.classList.toggle('is-empty', empty);
  updateNowAirPanel(title, sub, crossfadePreview);
  syncDesktopDialPreview(title, crossfadePreview);
  syncTunerSubRotate(title, sub, empty, crossfadePreview);
  if (currentStation && isPlaybackActive()) {
    updateMediaSession(currentStation, empty ? {} : { title, sub });
  }

  if (currentStation) {
    stopNowAirPreview();
    nowAirPreviewRadio = null;
    lastNowAirPreviewId = null;
    lastDialCarouselText = '';
    setTunerNameText(
      isDialCompactLayout()
        ? tunerDialTitleLine(currentStation)
        : currentStation.name,
    );
  } else if (previewing) {
    startNowAirPreview();
  } else {
    stopNowAirPreview();
    setTunerNameText('Syntoniser un poste');
  }
}

/**
 * Horloge interne : ré-évalue l'émission en cours chaque minute pour que
 * l'affichage bascule tout seul au changement d'émission, sans recharger la
 * page. Le garde-fou de renderTunerNowAir évite de relancer le défilement
 * quand l'émission n'a pas changé.
 */
function startNowAirTick() {
  if (nowAirTick) return;
  nowAirTick = setInterval(renderTunerNowAir, 30000);
}

async function refreshNowPlayingCache() {
  try {
    radioNowPlaying = await fetch('./radio-nowplaying.json', { cache: 'no-store' }).then((r) => r.json());
  } catch {
    /* ignore */
  }
  // Re-poll navigateur des APIs CORS signalées par le bot (clientPoll).
  await refreshStationLiveApis();
  renderTunerNowAir();
}

/**
 * Parse une réponse live côté navigateur selon le type d'adaptateur du bot.
 * Types CORS connus : cism-v1 (et synonymes). Extensible pour de futurs postes.
 */
function parseClientLivePayload(type, payload) {
  if (!payload) return null;
  if (type === 'cism-v1' || type === 'cism') {
    const cur = payload?.data?.current || payload?.current;
    const up = payload?.data?.upcoming || payload?.data?.next || payload?.upcoming;
    if (!cur?.title) return null;
    return {
      current: {
        title: String(cur.title).trim(),
        host: String(cur.host || cur.artist || '').trim(),
        source: 'api-live',
        slug: String(cur.slug || '').trim(),
      },
      next: up?.title
        ? {
          title: String(up.title).trim(),
          host: String(up.host || up.artist || '').trim(),
          source: 'api-live',
          slug: String(up.slug || '').trim(),
        }
        : null,
    };
  }
  if (type === 'craft-live' || type === 'craft' || type === 'choq') {
    const live = payload.live || payload;
    const title = String(live?.title || live?.name || '').trim();
    if (!title) return null;
    return {
      current: {
        title,
        host: String(live.artist || live.host || '').trim(),
        source: 'api-live',
      },
      next: null,
    };
  }
  return null;
}

async function fetchClientLivePoll(id, poll) {
  if (!poll?.url) return null;
  try {
    const res = await fetch(poll.url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const parsed = parseClientLivePayload(poll.type, payload);
    if (!parsed?.current?.title) return null;
    return { id, ...parsed, checkedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

async function refreshStationLiveApis() {
  const stations = radioNowPlaying.stations || {};
  const jobs = Object.entries(stations)
    .filter(([, st]) => st?.clientPoll?.url)
    .map(([id, st]) => fetchClientLivePoll(id, st.clientPoll));
  if (!jobs.length) return;
  const results = await Promise.all(jobs);
  for (const hit of results) {
    if (!hit?.current?.title) continue;
    const prev = radioNowPlaying.stations[hit.id] || {};
    radioNowPlaying.stations[hit.id] = {
      ...prev,
      id: hit.id,
      name: prev.name || radios.find((r) => r.id === hit.id)?.name || hit.id,
      current: hit.current,
      next: hit.next || prev.next || null,
      showTitle: hit.current.title,
      host: hit.current.host || '',
      source: 'api-live',
      checkedAt: hit.checkedAt,
    };
  }
}

function syncNowPlayingPoll() {
  if (nowPlayingPollTimer) {
    clearInterval(nowPlayingPollTimer);
    nowPlayingPollTimer = null;
  }
  if (currentStation && getPlayableStream(currentStation) && isPlaybackActive()) {
    // 60 s : APIs live CORS + fichier bot, sans attendre le cron 30 min.
    nowPlayingPollTimer = setInterval(refreshNowPlayingCache, 60000);
    refreshNowPlayingCache();
  }
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
    const inGroup = radios.filter((r) => r.type === type);
    if (!inGroup.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    inGroup.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.name} · ${formatInstitutionDisplay(r.institution)}`;
      og.appendChild(opt);
    });
    TUNER_SELECT.appendChild(og);
  });
}

function bindTuner() {
  TUNER_SELECT.addEventListener('change', () => {
    const next = radios.find((r) => r.id === TUNER_SELECT.value);
    selectStation(TUNER_SELECT.value, {
      autoplay: !!getPlayableStream(next),
      openExternal: true,
    });
  });

  TUNER_PREV.addEventListener('click', () => stepStation(-1));
  TUNER_NEXT.addEventListener('click', () => stepStation(1));

  TUNER_PLAY.addEventListener('click', togglePlay);

  TUNER_VOLUME.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    currentGain = Number.isFinite(v) ? v : currentGain;
    if (volumeMuted && currentGain > 0) setVolumeMuted(false);
    applyGain();
    localStorage.setItem('req-player-vol', currentGain);
  });

  initVolumeRangeBounds();
  bindVolumePopover();
  bindVolumePopoverMute();
  bindVolumeSliderLayout();
  bindVolumeSliderDrag();
}

/** Sans amplification (mobile) : range 0–100 %, zone boost et repère 200 % masqués. */
function initVolumeRangeBounds() {
  if (!TUNER_VOLUME || GAIN_UI_MAX >= MAX_GAIN) return;
  TUNER_VOLUME.max = String(GAIN_UI_MAX);
  TUNER_VOLUME.setAttribute('aria-label', 'Volume — 0 % à gauche, 100 % à droite');
  TUNER_VOL?.classList.add('tuner-vol--no-boost');
}

function bindVolumeSliderLayout() {
  const track = TUNER_VOLUME?.closest('.tuner-vol-track');
  if (!track || volSliderResizeObs) return;
  const schedule = () => requestAnimationFrame(() => updateVolumeSliderVisual());
  volSliderResizeObs = new ResizeObserver(schedule);
  volSliderResizeObs.observe(track);
  const inner = track.closest('.tuner-inner');
  if (inner) volSliderResizeObs.observe(inner);
  window.addEventListener('resize', schedule, { passive: true });
  onMediaQueryChange(VOL_COMPACT, schedule);
  schedule();
}

// Sous 1100 px, le curseur est masqué : l'icône ouvre une bulle (libère le synthétiseur).
function bindVolumePopover() {
  if (!TUNER_VOL_TOGGLE) return;
  const close = () => {
    if (!TUNER_VOL.classList.contains('is-open')) return;
    TUNER_VOL.classList.remove('is-open');
    TUNER_VOL_TOGGLE.setAttribute('aria-expanded', 'false');
  };

  TUNER_VOL_TOGGLE.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isVolCompactMode()) {
      const open = TUNER_VOL.classList.toggle('is-open');
      TUNER_VOL_TOGGLE.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        requestAnimationFrame(() => {
          updateVolumeSliderVisual();
          requestAnimationFrame(() => updateVolumeSliderVisual());
        });
      }
      return;
    }
    toggleVolumeMute();
  });

  document.addEventListener('click', (e) => {
    if (volumeSliderDragging) return;
    if (!TUNER_VOL.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  // En repassant en mode large, on referme proprement la bulle.
  const onVolLayoutChange = (e) => {
    if (!e.matches) close();
    updateVolumeUI();
  };
  onMediaQueryChange(VOL_COMPACT, onVolLayoutChange);
}

function bindVolumePopoverMute() {
  if (!TUNER_VOL_MUTE) return;
  TUNER_VOL_MUTE.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleVolumeMute();
  });
}

/** Glissement tactile fiable (le range natif opacity:0 glisse mal au doigt). */
function bindVolumeSliderDrag() {
  const slider = TUNER_VOLUME?.closest('.tuner-vol-slider');
  const track = TUNER_VOLUME?.closest('.tuner-vol-track');
  if (!slider || !track || !TUNER_VOLUME) return;

  const setGainFromClientX = (clientX) => {
    const rect = slider.getBoundingClientRect();
    const thumbPx = getVolThumbPx(track);
    const travel = Math.max(rect.width - thumbPx, 1);
    const x = Math.min(Math.max(clientX - rect.left - thumbPx / 2, 0), travel);
    const ratio = x / travel;
    const stepped = Math.round(ratio * GAIN_UI_MAX / 0.02) * 0.02;
    const clamped = Math.min(GAIN_UI_MAX, Math.max(0, stepped));
    if (Math.abs(parseFloat(TUNER_VOLUME.value) - clamped) < 0.001) return;
    TUNER_VOLUME.value = String(clamped);
    TUNER_VOLUME.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const endDrag = (e) => {
    if (!volumeSliderDragging) return;
    track.classList.remove('is-dragging');
    try { slider.releasePointerCapture(e.pointerId); } catch (_) {}
    // Retarde la fin pour éviter que le clic document referme la bulle.
    setTimeout(() => { volumeSliderDragging = false; }, 80);
  };

  slider.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    volumeSliderDragging = true;
    track.classList.add('is-dragging');
    slider.setPointerCapture(e.pointerId);
    setGainFromClientX(e.clientX);
  }, { passive: false });

  slider.addEventListener('pointermove', (e) => {
    if (!volumeSliderDragging) return;
    setGainFromClientX(e.clientX);
  });

  slider.addEventListener('pointerup', endDrag);
  slider.addEventListener('pointercancel', endDrag);
}

function getVolThumbPx(track) {
  if (!track) return VOL_THUMB_PX;
  const raw = getComputedStyle(track).getPropertyValue('--vol-thumb').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : VOL_THUMB_PX;
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
  selectStation(next.id, { autoplay: tunerShouldAutoplayNative(next) });
}

function getMarqueeAvailableWidth(el) {
  if (!el) return 0;
  const style = getComputedStyle(el);
  const padL = parseFloat(style.paddingLeft) || 0;
  const padR = parseFloat(style.paddingRight) || 0;
  return Math.max(0, el.clientWidth - padL - padR);
}

function ensureMarqueeObserved(el) {
  if (!marqueeResizeObs || !el || marqueeObservedEls.has(el)) return;
  marqueeObservedEls.add(el);
  marqueeResizeObs.observe(el);
}

function registerFilterMarqueeObservers() {
  if (!NEWS_FILTERS) return;
  NEWS_FILTERS.querySelectorAll('.filter-btn').forEach((btn) => {
    ensureMarqueeObserved(btn);
    const inst = btn.querySelector('.filter-btn__inst');
    if (inst) ensureMarqueeObserved(inst);
  });
}

function scheduleFilterMarqueeRefresh() {
  scheduleMarqueeRefresh();
  if (filterMarqueeResyncTimer) clearTimeout(filterMarqueeResyncTimer);
  filterMarqueeResyncTimer = setTimeout(() => {
    filterMarqueeResyncTimer = null;
    scheduleMarqueeRefresh();
  }, FILTER_MARQUEE_RESYNC_MS);
}

function getFilterInstMarqueeElements() {
  return NEWS_FILTERS
    ? [...NEWS_FILTERS.querySelectorAll('.filter-btn__inst')]
    : [];
}

function getMarqueeElements() {
  return [
    TUNER_NAME,
    TUNER_SUB,
    TUNER_SUB_AIR,
    TUNER_NOWAIR_TITLE,
    TUNER_NOWAIR_SUB,
    ...getFilterInstMarqueeElements(),
  ].filter(Boolean);
}

/** Défilement doux sur le libellé d'institution des pastilles sources. */
function applyFilterInstMarquees() {
  if (!NEWS_FILTERS) return;
  NEWS_FILTERS.querySelectorAll('.filter-btn').forEach((btn) => {
    const instEl = btn.querySelector('.filter-btn__inst');
    if (!instEl) return;
    const src = btn.dataset.source;
    if (src === 'all') {
      applyMarquee(instEl, 'Toutes les sources');
      return;
    }
    const { institution, type } = sourceInfo(src);
    const instLabel = filterSourceInstitutionLabel(institution, type, src);
    applyMarquee(instEl, instLabel || '');
  });
}

function measureMarquee(el) {
  if (!el || PREFERS_REDUCED_MOTION?.matches) return;

  const span = el.querySelector('.tuner-now-sub-text');
  if (!span) return;

  const available = getMarqueeAvailableWidth(el);
  if (!available) return;

  const overflow = span.scrollWidth - available;
  if (overflow <= 2) {
    el.classList.remove('is-marquee');
    el.style.removeProperty('--marquee-shift');
    el.style.removeProperty('--marquee-duration');
    return;
  }

  const distance = overflow + 12;
  const duration = Math.max(7, distance / 16);
  el.style.setProperty('--marquee-shift', `-${distance}px`);
  el.style.setProperty('--marquee-duration', `${duration.toFixed(1)}s`);
  el.classList.add('is-marquee');
}

/** Mesure après layout (double rAF) ; réessaie si la largeur n'est pas encore stable. */
function scheduleMarqueeMeasure(el, attempt = 0) {
  if (!el || attempt > 4) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const span = el.querySelector('.tuner-now-sub-text');
      if (!span || PREFERS_REDUCED_MOTION?.matches) return;

      const available = getMarqueeAvailableWidth(el);
      if (!available) {
        scheduleMarqueeMeasure(el, attempt + 1);
        return;
      }

      measureMarquee(el);

      const overflow = span.scrollWidth - available;
      const shouldMarquee = overflow > 2;
      const hasMarquee = el.classList.contains('is-marquee');
      if (attempt < 4 && shouldMarquee !== hasMarquee) {
        scheduleMarqueeMeasure(el, attempt + 1);
      }
    });
  });
}

function refreshAllMarquees() {
  marqueeResizeScheduled = false;
  getMarqueeElements().forEach((el) => {
    const text = marqueeTextByEl.get(el);
    if (text == null) return;
    if (PREFERS_REDUCED_MOTION?.matches) return;
    if (!el.querySelector('.tuner-now-sub-text')) {
      applyMarquee(el, text);
      return;
    }
    scheduleMarqueeMeasure(el);
  });
}

function scheduleMarqueeRefresh() {
  if (marqueeResizeScheduled) return;
  marqueeResizeScheduled = true;
  requestAnimationFrame(refreshAllMarquees);
}

function initMarqueeResizeListeners() {
  if (marqueeResizeObs || typeof ResizeObserver === 'undefined') return;

  marqueeResizeObs = new ResizeObserver(scheduleMarqueeRefresh);

  const observeTargets = new Set(getMarqueeElements());
  [
    TUNER_SUB?.parentElement,
    TUNER_SUB?.closest('.tuner-now'),
    TUNER_SUB?.closest('.tuner-dial'),
    TUNER?.querySelector('.tuner-inner'),
    TUNER_NOWAIR,
    TUNER_NOWAIR?.querySelector('.tuner-nowair-body'),
    NEWS_FILTERS,
    FILTERS_PANEL,
  ].forEach((el) => { if (el) observeTargets.add(el); });

  observeTargets.forEach((el) => ensureMarqueeObserved(el));
  registerFilterMarqueeObservers();

  NEWS_FILTERS?.addEventListener('transitionend', (e) => {
    const t = e.target;
    if (t?.classList?.contains('filter-btn') && e.propertyName === 'flex-basis') {
      scheduleFilterMarqueeRefresh();
    }
  });

  FILTERS_PANEL?.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'max-height') scheduleFilterMarqueeRefresh();
  });

  window.addEventListener('resize', scheduleMarqueeRefresh, { passive: true });
  onMediaQueryChange(PREFERS_REDUCED_MOTION, () => {
    getMarqueeElements().forEach((el) => {
      const text = marqueeTextByEl.get(el);
      if (text != null) applyMarquee(el, text);
    });
  });
}

/**
 * Affiche un texte sur une seule ligne et, s'il dépasse de son conteneur,
 * l'anime en défilement doux droite → gauche (sinon ellipsis). Réutilisé par
 * le sous-titre du syntoniseur et par le module « À l'antenne ».
 */
function applyMarquee(el, text) {
  if (!el) return;
  const value = String(text ?? '').trim();
  el.classList.remove('is-marquee');
  el.style.removeProperty('--marquee-shift');
  el.style.removeProperty('--marquee-duration');

  if (!value) {
    marqueeTextByEl.delete(el);
    el.replaceChildren();
    return;
  }

  marqueeTextByEl.set(el, value);

  if (PREFERS_REDUCED_MOTION?.matches) {
    el.textContent = value;
    return;
  }

  const span = document.createElement('span');
  span.className = 'tuner-now-sub-text';
  span.textContent = value;
  el.replaceChildren(span);

  scheduleMarqueeMeasure(el);
}

function setTunerNameText(text, crossfade = false) {
  if (!TUNER_NAME) return;
  if (!crossfade || PREFERS_REDUCED_MOTION?.matches) {
    applyMarquee(TUNER_NAME, text);
    return;
  }
  TUNER_NAME.classList.add('is-crossfading');
  setTimeout(() => {
    applyMarquee(TUNER_NAME, text);
    requestAnimationFrame(() => TUNER_NAME.classList.remove('is-crossfading'));
  }, NOW_AIR_CROSSFADE_MS);
}

/** Sous-titre du syntoniseur (fréquence · institution au complet). */
function setTunerSubText(text) {
  tunerSubMeta = text;
  applyMarquee(TUNER_SUB, text);
}

function selectStation(id, { autoplay = false, openExternal = false } = {}) {
  const radio = radios.find(r => r.id === id);
  if (!radio) return;
  currentStation = radio;

  const playable = getPlayableStream(radio);
  const external = isExternalListen(radio);

  const inst = tunerInstitutionLabel(radio.institution);
  if (isDialCompactLayout()) {
    setTunerNameText(tunerDialTitleLine(radio));
    const subLine = dialCompactSubLineForRadio(radio);
    tunerSubMeta = subLine;
    TUNER_SUB?.parentElement?.classList.toggle('is-empty', !subLine);
    applyMarquee(TUNER_SUB, subLine);
  } else {
    setTunerNameText(radio.name);
    setTunerSubText(external
      ? `Site externe · ${inst}`
      : `${radio.frequency} · ${inst}`);
  }

  TUNER_PLAY.disabled = !playable && !external;
  TUNER_PLAY.title = playable
    ? 'Écouter'
    : external
      ? 'Écouter sur le site du poste (fenêtre externe)'
      : 'Flux direct indisponible';

  updateMediaSession(radio);

  if (!playable) {
    window.RadarCast?.endSession?.();
    stopPlayback({ keepStation: true });
    updatePlayUI();
    if (external && openExternal) openListenWindow(radio);
    return;
  }

  window.RadarCast?.onStationChange?.();

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
  // Cast actif : pause/reprise distante (ne pas relancer le flux local en double).
  if (window.RadarCast?.isChromecasting?.()) {
    if (window.RadarCast.isRemotePlaying?.()) {
      pauseByUser();
    } else {
      userPaused = false;
      window.RadarCast.resumeRemote?.();
      mobilePlayback?.onPlayStart();
      updatePlayUI();
    }
    return;
  }
  if (isPlaybackActive()) {
    pauseByUser();
  } else {
    userPaused = false;
    play(currentStation);
  }
}

async function play(radio) {
  const url = getPlayableStream(radio);
  if (!url) return;
  userPaused = false;

  // Reprise Cast plutôt que double lecture locale + distante.
  if (window.RadarCast?.isChromecasting?.()) {
    window.RadarCast.resumeRemote?.();
    mobilePlayback?.onPlayStart();
    updatePlayUI();
    return;
  }

  // Branche (ou non) le graphe d'amplification selon le support CORS du poste.
  const tuning = STATION_PLAYBACK[radio.id] || {};
  const wantBoost = wantsAudioBoost()
    && !boostUnavailable.has(radio.id)
    && !tuning.noBoost;
  if (wantBoost !== boostWired) rebuildAudio(wantBoost);
  reconnectTries = 0;
  mobilePlayback?.resetReconnectTries();
  audio.preload = mobilePlayback?.getMobilePreload(!!tuning.resilient)
    ?? (tuning.resilient ? 'auto' : 'none');
  try {
    if (audioCtx && audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch {} }
    if (audio.src !== url) audio.src = url;
    syncMediaSessionPlaybackState();
    syncMediaSessionLivePosition();
    await audio.play();
    mobilePlayback?.onPlayStart();
    syncMediaSessionPlaybackState();
    applyGain();
    updatePlayUI();
  } catch {
    showToast('Appuie de nouveau sur ▶ pour autoriser la lecture.');
  }
}

function stopPlayback({ keepStation = false } = {}) {
  reconnectTries = 0;
  userPaused = false;
  mobilePlayback?.onPlayStop();
  window.RadarCast?.endSession?.();
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

function isCasting() {
  return !!window.RadarCast?.isCasting?.();
}

function isPlaybackActive() {
  // Cast en pause distante : session active mais pas « en lecture ».
  if (window.RadarCast?.isChromecasting?.()) {
    return !!window.RadarCast.isRemotePlaying?.();
  }
  return isPlaying() || isCasting();
}

function updatePlayUI() {
  const active = isPlaybackActive();
  const external = !!currentStation && isExternalListen(currentStation);
  ICO_PLAY.classList.toggle('hidden', active || external);
  ICO_PAUSE.classList.toggle('hidden', !active);
  ICO_EXTERNAL?.classList.toggle('hidden', !external || active);
  TUNER_PLAY.classList.toggle('is-external', external && !active);
  TUNER.classList.toggle('is-playing', active);
  TUNER.classList.toggle('is-external', external && !active);
  renderTunerNowAir();
  syncNowPlayingPoll();
  syncMediaSessionPlaybackState();
  window.RadarCast?.updateButton?.();
}

function wantsAudioBoost() {
  return webAudioSupported && !MOBILE_PLAYBACK;
}

function getPlayerElement() {
  let el = document.getElementById('radar-player');
  if (!el) {
    el = document.createElement('audio');
    el.id = 'radar-player';
    el.preload = 'none';
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    // Android / Chrome : session longue durée (radio live), pas de téléchargement.
    el.setAttribute('x-webkit-airplay', 'allow');
    try { el.disableRemotePlayback = false; } catch {}
    el.controls = false;
    el.classList.add('sr-only');
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}

function pauseForCast() {
  if (!audio) return;
  mobilePlayback?.stopKeepalive();
  suppressAudioError = true;
  try { audio.pause(); } catch {}
  suppressAudioError = false;
  updatePlayUI();
}

function pauseByUser() {
  userPaused = true;
  // Cast : pause distante (ou fin de session si le LIVE ne gère pas pause).
  // Ne pas appeler endSession ici — le bouton Cast sert à arrêter la diffusion.
  if (window.RadarCast?.isChromecasting?.()) {
    window.RadarCast.pauseRemote?.();
  }
  mobilePlayback?.onUserPause();
  if (!audio) { updatePlayUI(); return; }
  suppressAudioError = true;
  try { audio.pause(); } catch {}
  suppressAudioError = false;
  updatePlayUI();
}

function syncMediaSessionPlaybackState() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = isPlaybackActive() ? 'playing' : 'paused';
}

function syncMediaSessionLivePosition() {
  if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
  try {
    navigator.mediaSession.setPositionState({
      duration: Number.POSITIVE_INFINITY,
      playbackRate: 1,
      position: 0,
    });
  } catch {}
}

function initMobilePlayback() {
  if (mobilePlayback || !window.RadarMobilePlayback) return;
  mobilePlayback = RadarMobilePlayback.create({
    getPlayer: () => audio,
    getStation: () => currentStation,
    isUserPaused: () => userPaused,
    isPlaying,
    isExternalListen,
    isCasting,
    isStationResilient: () => !!currentTuning().resilient,
    playStation: play,
    getStreamUrl: getPlayableStream,
    syncMediaSession: () => {
      syncMediaSessionPlaybackState();
      syncMediaSessionLivePosition();
    },
    ensureNativePlayback: () => {
      if (MOBILE_PLAYBACK && boostWired) rebuildAudio(false);
    },
    resumeAudioCtx: () => {
      if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    },
    performReconnect: () => mobilePlayback?.attemptReconnect(),
    setSuppressErrors: (v) => { suppressAudioError = v; },
  });
  mobilePlayback.setupLifecycle();
}

// ─── Audio engine ──────────────────────────────────────────────────────────────
function attachAudioListeners(el) {
  if (playerListenersAttached.has(el)) return;
  playerListenersAttached.add(el);
  el.addEventListener('play',    updatePlayUI);
  el.addEventListener('pause',   updatePlayUI);
  el.addEventListener('ended',   onAudioEnded);
  el.addEventListener('playing', onAudioPlaying);
  el.addEventListener('error',   onAudioError);
  mobilePlayback?.attachToPlayer(el);
}

function currentTuning() {
  return (currentStation && STATION_PLAYBACK[currentStation.id]) || {};
}

function onAudioPlaying() {
  reconnectTries = 0;
  mobilePlayback?.onPlaying();
  updatePlayUI();
}

function onAudioEnded() {
  if (mobilePlayback?.shouldHandleEnded() && mobilePlayback.attemptReconnect()) return;
  updatePlayUI();
}

function reconnectResilient() {
  if (!mobilePlayback?.attemptReconnect() && mobilePlayback?.showReconnectFailed()) {
    showToast('Flux instable — réessaie dans un instant.');
  }
  updatePlayUI();
}

function onAudioError() {
  if (suppressAudioError) { updatePlayUI(); return; }
  // Poste résilient qui jouait déjà : coupure réseau → reconnexion douce
  // (currentTime > 0 distingue une vraie coupure d'un échec CORS au démarrage).
  if (mobilePlayback?.shouldHandleError(audio?.currentTime ?? 0)) {
    reconnectResilient();
    return;
  }
  // En mode amplifié, un flux sans en-tête CORS fait échouer l'élément <audio>
  // « anonymous ». On le note et on retombe une fois en lecture native simple.
  if (boostWired && currentStation && !boostUnavailable.has(currentStation.id)) {
    boostUnavailable.add(currentStation.id);
    rebuildAudio(false);
    play(currentStation);
    return;
  }
  if (audio && audio.currentSrc) showToast('Flux indisponible pour le moment.');
  updatePlayUI();
}

/** Branche un graphe Web Audio (source → gain → sortie) pour l'amplification. */
function wireBoost() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) { webAudioSupported = false; return false; }
  try {
    audio.crossOrigin = 'anonymous';
    audioCtx = audioCtx || new Ctx();
    mediaSource = audioCtx.createMediaElementSource(audio);
    gainNode = audioCtx.createGain();
    mediaSource.connect(gainNode).connect(audioCtx.destination);
    audioCtx.onstatechange = () => {
      if (audioCtx.state === 'suspended' && isPlaying() && !userPaused) {
        audioCtx.resume().catch(() => {});
      }
    };
    boostWired = true;
  } catch {
    boostWired = false;
  }
  return boostWired;
}

/** Recrée l'élément <audio>, avec ou sans graphe d'amplification. */
function rebuildAudio(withBoost) {
  if (audio) {
    suppressAudioError = true;
    try { audio.pause(); } catch {}
    suppressAudioError = false;
    // createMediaElementSource est à usage unique — on remplace l'élément au changement de mode.
    if (boostWired || withBoost || mediaSource) {
      audio.remove();
      audio = null;
    } else {
      audio.removeAttribute('src');
      audio.removeAttribute('crossorigin');
      try { audio.load(); } catch {}
    }
  }
  audio = getPlayerElement();
  audio.preload = 'none';
  if (!withBoost) audio.removeAttribute('crossorigin');
  attachAudioListeners(audio);
  mediaSource = null;
  gainNode = null;
  boostWired = false;
  if (withBoost) wireBoost();
  applyGain();
}

function setVolumeMuted(muted) {
  volumeMuted = muted;
  if (muted) {
    gainBeforeMute = currentGain > 0 ? currentGain : (gainBeforeMute || DEFAULT_GAIN);
  }
  updateVolumeUI();
  applyGain();
}

function toggleVolumeMute() {
  setVolumeMuted(!volumeMuted);
}

function updateVolumeSliderVisual() {
  const track = TUNER_VOLUME?.closest('.tuner-vol-track');
  const slider = track?.querySelector('.tuner-vol-slider');
  if (!track || !slider) return;

  const width = slider.getBoundingClientRect().width || slider.clientWidth || track.clientWidth;
  if (width < 1) return;

  const thumbPx = getVolThumbPx(track);
  const travel = width - thumbPx;
  const xMin = thumbPx / 2;
  const xMid = xMin + travel * 0.5;
  const xMax = xMin + travel;
  const gain = volumeMuted ? 0 : currentGain;
  const ratio = Math.min(Math.max(gain / GAIN_UI_MAX, 0), 1);
  const xThumb = xMin + travel * ratio;

  track.style.setProperty('--vol-x', `${xThumb}px`);
  track.style.setProperty('--vol-x-min', `${xMin}px`);
  track.style.setProperty('--vol-x-mid', `${xMid}px`);
  track.style.setProperty('--vol-x-max', `${xMax}px`);
  track.style.setProperty('--vol-ratio', String(ratio));
  if (GAIN_UI_MAX >= MAX_GAIN) {
    // Deux zones : remplissage bleu 0–100 %, orange 100–200 %.
    track.style.setProperty('--vol-base', `${Math.min(ratio / 0.5, 1) * 100}%`);
    track.style.setProperty('--vol-boost', `${Math.max((ratio - 0.5) / 0.5, 0) * 100}%`);
  } else {
    // Sans amplification : une seule zone pleine largeur.
    track.style.setProperty('--vol-base', `${ratio * 100}%`);
    track.style.setProperty('--vol-boost', '0%');
  }
  track.classList.toggle('is-boost', gain > 1.001);
}

function syncVolumeMuteButton(btn, { pressed = false, icon = 'toggle' } = {}) {
  if (!btn) return;
  const icoVol = btn.querySelector('.ico-vol');
  const icoMute = btn.querySelector('.ico-vol-mute');
  if (icon === 'mute') {
    icoVol?.classList.add('hidden');
    icoMute?.classList.remove('hidden');
  } else if (icon === 'vol') {
    icoVol?.classList.remove('hidden');
    icoMute?.classList.add('hidden');
  } else {
    icoVol?.classList.toggle('hidden', volumeMuted);
    icoMute?.classList.toggle('hidden', !volumeMuted);
  }
  if (pressed) {
    btn.setAttribute('aria-pressed', String(volumeMuted));
    btn.setAttribute(
      'aria-label',
      volumeMuted ? 'Réactiver le son' : 'Couper le son',
    );
    btn.title = volumeMuted ? 'Réactiver le son' : 'Couper le son';
  }
}

function updateVolumeUI() {
  TUNER_VOL?.classList.toggle('is-muted', volumeMuted);
  const compact = isVolCompactMode();
  syncVolumeMuteButton(TUNER_VOL_MUTE, { pressed: true, icon: 'mute' });
  syncVolumeMuteButton(TUNER_VOL_TOGGLE, {
    pressed: !compact,
    icon: compact ? 'vol' : 'toggle',
  });
  if (TUNER_VOL_TOGGLE) {
    if (compact) {
      TUNER_VOL_TOGGLE.removeAttribute('aria-pressed');
      TUNER_VOL_TOGGLE.setAttribute('aria-label', 'Réglages du volume');
      TUNER_VOL_TOGGLE.title = 'Réglages du volume';
    } else {
      TUNER_VOL_TOGGLE.setAttribute(
        'aria-label',
        volumeMuted ? 'Réactiver le son' : 'Couper le son',
      );
      TUNER_VOL_TOGGLE.title = volumeMuted
        ? 'Réactiver le son'
        : 'Couper le son — curseur à droite pour amplifier les flux faibles';
    }
  }
  if (TUNER_VOLUME) {
    const pct = volumeMuted ? 0 : Math.round(currentGain * 100);
    TUNER_VOLUME.setAttribute('aria-valuetext', volumeMuted ? 'Muet' : `${pct} %`);
  }
  updateVolumeSliderVisual();
}

function isOutputSilent() {
  return volumeMuted || currentGain <= 0.001;
}

/** Applique la valeur du curseur : gain Web Audio si amplifiable, sinon volume natif. */
function applyGain() {
  const effective = volumeMuted ? 0 : currentGain;
  const silent = isOutputSilent();

  if (audio) {
    if (boostWired && gainNode) {
      audio.volume = 1;
      try {
        if (audioCtx) gainNode.gain.setValueAtTime(effective, audioCtx.currentTime);
        else gainNode.gain.value = effective;
      } catch {
        try { gainNode.gain.value = effective; } catch {}
      }
      // L'élément peut encore fuiter hors du graphe Web Audio (embed iframe, etc.).
      audio.muted = silent;
    } else {
      audio.muted = silent;
      audio.volume = silent ? 0 : Math.min(1, effective);
    }
  }

  // Keepalive mobile (WAV / oscillateur) : arrêt quand muet ou 0 %.
  if (silent) mobilePlayback?.stopKeepalive();
  else if (isPlaybackActive() && !userPaused) mobilePlayback?.startKeepalive();

  TUNER.classList.toggle('is-boosted', !silent && currentGain > 1.001);
  updateVolumeUI();
}

function setupAudio() {
  if (audio) return;
  initMobilePlayback();
  audio = getPlayerElement();
  audio.preload = 'none';
  attachAudioListeners(audio);

  if ('mediaSession' in navigator) {
    // Les handlers Media Session sont privilégiés par Android pour relancer
    // l'audio depuis l'écran de verrouillage / la notification média.
    navigator.mediaSession.setActionHandler('play', () => {
      userPaused = false;
      mobilePlayback?.onPlayStart();
      if (window.RadarCast?.isChromecasting?.()) {
        window.RadarCast.resumeRemote?.();
        updatePlayUI();
        return;
      }
      if (currentStation) {
        if (audio?.src && audio.paused) {
          audio.play().catch(() => play(currentStation));
        } else {
          play(currentStation);
        }
      }
      syncMediaSessionPlaybackState();
      syncMediaSessionLivePosition();
    });
    navigator.mediaSession.setActionHandler('pause', () => pauseByUser());
    navigator.mediaSession.setActionHandler('stop', () => {
      userPaused = true;
      window.RadarCast?.endSession?.();
      mobilePlayback?.onUserPause();
      if (audio) {
        suppressAudioError = true;
        try { audio.pause(); } catch {}
        suppressAudioError = false;
      }
      updatePlayUI();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => stepStation(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => stepStation(1));
    try {
      navigator.mediaSession.setActionHandler('seekto', null);
    } catch {}
  }

  window.RadarCast?.init?.({
    getPlayer: () => audio,
    getStation: () => currentStation,
    getStreamUrl: getPlayableStream,
    isExternal: isExternalListen,
    isPlaying,
    isUserPaused: () => userPaused,
    playStation: play,
    pauseLocal: pauseForCast,
    assetUrl,
    formatInstitution: formatInstitutionDisplay,
    getNowAirMeta: (radio) => {
      if (!radio || radio.id !== currentStation?.id) return {};
      if (lastNowAir.title) {
        return { title: lastNowAir.title, sub: lastNowAir.sub || '' };
      }
      return {};
    },
    buildMediaSessionMeta: buildStationMediaMeta,
    showToast,
    onCastStateChange: updatePlayUI,
  });
}

function assetUrl(path) {
  try {
    return new URL(String(path).replace(/^\.\//, ''), window.location.href).href;
  } catch {
    return path;
  }
}

/** Métadonnées lock screen / notification : émission en titre, poste en artiste. */
function buildStationMediaMeta(radio, { title, sub } = {}) {
  const stationLine = formatStationNowAirLabel(radio);
  const airTitle = String(title || '').trim();
  const airSub = String(sub || '').trim();
  const genericListen = `Vous écoutez ${radio.name}`;
  const hasShow = airTitle && airTitle !== genericListen;

  if (hasShow) {
    return {
      title: airTitle,
      artist: stationLine,
      album: airSub || tunerInstitutionLabel(radio.institution) || 'Le Radar',
    };
  }

  return {
    title: radio.fullName || radio.name,
    artist: tunerInstitutionLabel(radio.institution),
    album: airSub || radioSlogan(radio) || 'Le Radar',
  };
}

function updateMediaSession(radio, { title, sub } = {}) {
  if (!('mediaSession' in navigator)) return;
  const meta = buildStationMediaMeta(radio, { title, sub });
  navigator.mediaSession.metadata = new MediaMetadata({
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    artwork: [
      { src: assetUrl('assets/icon-192.png'), sizes: '192x192', type: 'image/png' },
      { src: assetUrl('assets/icon-512.png'), sizes: '512x512', type: 'image/png' },
    ],
  });
}

function restoreVolume() {
  const saved = parseFloat(localStorage.getItem('req-player-vol') ?? String(DEFAULT_GAIN));
  currentGain = Number.isFinite(saved) ? Math.min(GAIN_UI_MAX, Math.max(0, saved)) : DEFAULT_GAIN;
  gainBeforeMute = currentGain;
  TUNER_VOLUME.value = currentGain;
  volumeMuted = false;
  applyGain();
}

// ═══════════════════════════════════════════════════════════════════════════
//  NEWS WIRE
// ═══════════════════════════════════════════════════════════════════════════
async function loadNews() {
  if (!NEWS_LIST) return;
  NEWS_LIST.innerHTML = newsSkeleton(6);
  try {
    const res = await fetch('./news.json', { cache: 'no-cache' });
    const data = await res.json();
    news = Array.isArray(data) ? data : (data.items || []);
    news.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    assignSourceColors();
    if (data.updated) {
      // Heure réelle de la dernière écriture de news.json.
      // updatedSlot (passe planifiée) n'est utilisé que s'il est proche de l'heure
      // réelle — sinon on affichait encore « 12 h 00 » à 15 h 48 après un filet
      // ou une passe manuelle plus récente.
      const actual = new Date(data.updated);
      const slot = data.updatedSlot ? new Date(data.updatedSlot) : null;
      const slotOk = slot
        && !Number.isNaN(slot.getTime())
        && actual - slot >= 0
        && actual - slot <= 45 * 60 * 1000;
      const d = slotOk ? slot : actual;
      NEWS_UPDATED.textContent = `mis à jour ${formatStamp(d)}`;
    }
  } catch (e) {
    console.error('Failed to load news.json', e);
    news = [];
  }
  renderNewsFilters();
  renderNews();
}

function normInstitutionKey(name = '') {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function institutionBrandColor(institution = '') {
  if (!institution) return null;
  const table = brandColors.institutions || {};
  if (table[institution]?.color) return table[institution].color;

  const norm = normInstitutionKey(institution);
  for (const [key, entry] of Object.entries(table)) {
    if (key.startsWith('_')) continue;
    if (normInstitutionKey(key) === norm) return entry.color;
  }
  return null;
}

/** Couleur d'accent d'un article : marque de l'établissement (pastilles, « Lire la suite »). */
function sourceAccentColor(item = {}) {
  const raw = institutionBrandColor(item.institution || '')
    || sourceColors[item.source || '']
    || null;
  return safeCssColor(raw);
}

/** Popularité des filtres UI : lue depuis news-sources.json (champ popularity). */
function sourcePopularityRank(name = '') {
  const fromRegistry = newsSourcesByName[name]?.popularity;
  if (typeof fromRegistry === 'number') return fromRegistry;
  return 100;
}

/** FR d'abord, puis EN, puis le reste (lang depuis news-sources.json). */
function sourceLangRank(name = '') {
  const lang = String(newsSourcesByName[name]?.lang || '').toLowerCase();
  if (lang === 'fr') return 0;
  if (lang === 'en') return 1;
  return 2;
}

/**
 * Tri pastilles sources :
 *  1. Français, puis anglais, puis autres
 *  2. Popularité croissante (1 = plus haut) — y compris The Link
 */
function sortSourcesByPopularity(sources) {
  return [...sources].sort((a, b) => {
    const langDiff = sourceLangRank(a) - sourceLangRank(b);
    if (langDiff !== 0) return langDiff;
    const diff = sourcePopularityRank(a) - sourcePopularityRank(b);
    return diff !== 0 ? diff : a.localeCompare(b, 'fr');
  });
}

function filterInstitutionKey(sourceName = '') {
  const { institution } = sourceInfo(sourceName);
  if (!institution) return sourceName;
  const acronym = resolveInstitutionAcronym(institution);
  if (acronym) return acronym.toLowerCase();
  return normInstitutionKey(institution);
}

/**
 * Tri filtres sources : FR par popularité, puis EN par popularité
 * (The Link inclus normalement selon son rang popularity).
 */
function sortSourcesForFilters(sources) {
  return sortSourcesByPopularity(sources);
}

function assignSourceColors() {
  const palette = brandColors.fallback_palette || ['#003DA5', '#6C2163', '#047857'];
  const sources = sortSourcesByPopularity([...new Set(news.map(n => n.source))]);
  sourceColors = {};

  sources.forEach((src, i) => {
    const item = news.find(n => n.source === src);
    sourceColors[src] = safeCssColor(
      institutionBrandColor(item?.institution || '') || palette[i % palette.length],
    ) || '#003DA5';
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

const INSTITUTION_ACRONYMS = {
  'Université de Montréal': 'UdeM',
  UQAM: 'UQAM',
  'Université du Québec à Montréal': 'UQAM',
  'Université du Québec à Montréal (UQAM)': 'UQAM',
  'Université McGill': 'McGill',
  'McGill University': 'McGill',
  'Concordia University': 'Concordia',
  'Université Laval': 'ULaval',
  'Université de Sherbrooke': 'UdeS',
  'Université du Québec à Trois-Rivières': 'UQTR',
  'Université du Québec à Trois-Rivières (UQTR)': 'UQTR',
  'Université du Québec à Chicoutimi': 'UQAC',
  'Université du Québec à Chicoutimi (UQAC)': 'UQAC',
  'Université du Québec à Rimouski': 'UQAR',
  'Université du Québec à Rimouski (UQAR)': 'UQAR',
  'Université du Québec en Outaouais': 'UQO',
  'Université du Québec en Outaouais (UQO)': 'UQO',
  'Université du Québec en Abitibi-Témiscamingue': 'UQAT',
  'Université du Québec en Abitibi-Témiscamingue (UQAT)': 'UQAT',
  'Polytechnique Montréal': 'Poly Montréal',
  "Bishop's University": "Bishop's",
};

const INSTITUTION_FULL_BY_ACRONYM = {};
for (const [full, acr] of Object.entries(INSTITUTION_ACRONYMS)) {
  const clean = full.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const prev = INSTITUTION_FULL_BY_ACRONYM[acr];
  if (!prev || (clean.includes(' ') && clean.length > prev.length)) {
    INSTITUTION_FULL_BY_ACRONYM[acr] = clean;
  }
}

/**
 * Capitalisation affichage des types d'établissement.
 * Les libellés d'institution ne sont pas traduits (voir translate.js) ;
 * ce filet corrige aussi une casse abîmée si un moteur externe intervient
 * (ex. gtx ES : « universidad laval » → Université Laval d'origine, ou
 * « Universidad … » si le nom était déjà hispanisé).
 */
function formatInstitutionDisplay(name = '') {
  if (!name) return '';
  return String(name)
    .replace(/\buniversité\b/giu, 'Université')
    .replace(/\buniversite\b/giu, 'Université')
    .replace(/\buniversity\b/giu, 'University')
    .replace(/\buniversidad\b/giu, 'Universidad')
    .replace(/\buniversidade\b/giu, 'Universidade')
    .replace(/\buniversität\b/giu, 'Universität')
    .replace(/\buniversità\b/giu, 'Università')
    .replace(/\bcégep\b/giu, 'Cégep')
    .replace(/\bcegep\b/giu, 'Cégep')
    .replace(/\bcollege\b/giu, 'College')
    .replace(/\bcollège\b/giu, 'Collège')
    // Noms propres fréquents laissés en minuscules par gtx (Laval, Montréal…)
    .replace(/\blaval\b/giu, 'Laval')
    .replace(/\bmontr[eé]al\b/giu, (m) => (m.includes('é') ? 'Montréal' : 'Montreal'))
    .replace(/\bsherbrooke\b/giu, 'Sherbrooke')
    .replace(/\bmcgill\b/giu, 'McGill')
    .replace(/\bconcordia\b/giu, 'Concordia')
    .replace(/\bdawson\b/giu, 'Dawson')
    .replace(/\bqu[eé]bec\b/giu, (m) => (m.includes('é') ? 'Québec' : 'Quebec'));
}

/** Libellé institution sur les pastilles sources (nom complet, sans suffixe Univ./Cégep). */
function filterSourceInstitutionLabel(institution = '', _type = '', sourceName = '') {
  if (!institution) return '';
  if (sourceName === 'Le Délit') return 'Université McGill';
  return tunerInstitutionLabel(institution);
}

/** Nom d'institution au complet pour le sous-titre du syntoniseur. */
function tunerInstitutionLabel(name = '') {
  if (!name) return '';
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  let label;
  if (/^université|^university|^mcgill|^concordia|^cégep|^collège/i.test(stripped)) {
    label = stripped;
  } else {
    label = INSTITUTION_FULL_BY_ACRONYM[name] || INSTITUTION_FULL_BY_ACRONYM[stripped] || stripped;
  }
  return formatInstitutionDisplay(label);
}

function resolveInstitutionAcronym(name = '') {
  if (!name) return '';
  if (INSTITUTION_ACRONYMS[name]) return INSTITUTION_ACRONYMS[name];

  const norm = normInstitutionKey(name);
  for (const [key, acronym] of Object.entries(INSTITUTION_ACRONYMS)) {
    if (normInstitutionKey(key) === norm) return acronym;
  }

  const paren = name.match(/\((UQ[A-Z]{1,4}|UdeM|ULaval|UdeS|McGill)\)/i);
  if (paren) return paren[1];

  return '';
}

function isQuebecUniversity(name = '', type = '') {
  return type === 'universite'
    || /^université|^university|^mcgill|^concordia$/i.test(name)
    || name === 'UQAM';
}

function stripInstitutionTypePrefix(name = '') {
  return String(name)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/^Cégep (de |du |d'|des )?/i, '')
    .replace(/^Collège (de |du |d'|des )?/i, '')
    .trim();
}

function isCegepInstitution(name = '', type = '') {
  return type === 'cegep' || /^cégep|^collège/i.test(name);
}

/**
 * Développe un acronyme stocké en base (ex. « UQAM ») vers le nom complet
 * (« Université du Québec à Montréal »). Si le nom est déjà long, le garde.
 */
function expandInstitutionFullName(name = '') {
  if (!name) return '';
  // Réutilise la même logique que le syntoniseur (filtre + cartes).
  return tunerInstitutionLabel(name);
}

/**
 * Libellé institution sur les cartes article.
 * @param {'short'|'full'} form
 *   short — acronyme (ULaval, UdeM, UQAM…) pour Suite du fil / mobile
 *   full  — nom complet (tablette+ en À la une / En bref / vedettes)
 */
function articleInstitutionLabel(name = '', type = '', form = 'short') {
  if (!name) return '';
  if (form === 'full') {
    return expandInstitutionFullName(name);
  }
  // Court : acronyme pour les universités ; sinon libellé formaté
  if (isQuebecUniversity(name, type)) {
    const acr = resolveInstitutionAcronym(name);
    if (acr) return acr;
  }
  // Donnée déjà en acronyme seul (institution: "UQAM")
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (INSTITUTION_FULL_BY_ACRONYM[stripped] || INSTITUTION_FULL_BY_ACRONYM[name]) {
    return resolveInstitutionAcronym(name) || stripped;
  }
  return formatInstitutionDisplay(stripped || name);
}

/** HTML meta institution : complet + acronyme pour bascule responsive CSS. */
function articleInstitutionMetaHtml(name = '', type = '', role = 'standard') {
  if (!name) return '';
  const short = articleInstitutionLabel(name, type, 'short');
  const full = articleInstitutionLabel(name, type, 'full');
  const spacious = role === 'lead' || role === 'feature' || role === 'compact';
  // Pas de notranslate : hors FR/EN/Original, translate.js localise les établissements.
  // En Original / FR / EN, ils restent protégés (libellés d’origine).
  if (spacious && full && full !== short) {
    return `<span class="article-inst">`
      + `<span class="article-inst__full">${escapeHtml(full)}</span>`
      + `<span class="article-inst__short">${escapeHtml(short)}</span>`
      + `</span>`;
  }
  // Spacious mais full === short (ex. cégep sans acronyme) : afficher full
  if (spacious && full) {
    return `<span class="article-inst">${escapeHtml(full)}</span>`;
  }
  return `<span class="article-inst">${escapeHtml(short || full)}</span>`;
}

function shortInstitution(name = '', type = '') {
  const acronym = resolveInstitutionAcronym(name);
  if (acronym) return acronym;

  const CEGEP_SHORT = {
    'Cégep du Vieux Montréal': 'Vieux-Montréal',
    'Cégep de Jonquière (ATM – journalisme)': 'Jonquière',
    'Cégep de Jonquière': 'Jonquière',
  };
  if (CEGEP_SHORT[name]) return CEGEP_SHORT[name];

  if (isCegepInstitution(name, type)) {
    const stripped = stripInstitutionTypePrefix(name);
    if (stripped) return stripped.length > 24 ? `${stripped.slice(0, 22)}…` : stripped;
  }

  const paren = name.match(/\(([^)]+)\)/);
  if (paren) {
    const inner = paren[1].split(/[–-]/)[0].trim();
    if (inner.length <= 14) return inner;
  }
  if (isQuebecUniversity(name, type)) return formatInstitutionDisplay(name);
  const trimmed = name.length > 24 ? `${name.slice(0, 22)}…` : name;
  return formatInstitutionDisplay(trimmed);
}

function sourceInfo(src) {
  const item = news.find(n => n.source === src);
  const registry = newsSourcesByName[src];
  return {
    institution: item?.institution || registry?.institution || '',
    type: item?.type || registry?.type || '',
    color: sourceColors[src] || 'var(--accent)',
  };
}

function filtersColumnCount() {
  if (!NEWS_FILTERS) {
    return FILTERS_MOBILE.matches ? FILTERS_ROW_CAPACITY : FILTERS_DESKTOP_DEFAULT_COLS;
  }
  const w = NEWS_FILTERS.clientWidth;
  if (FILTERS_MOBILE.matches) {
    return w < FILTERS_COLS_NARROW ? 2 : 3;
  }
  // Demi-laptop / tablette étroite : 3 colonnes de pastilles (pas le mode compact téléphone).
  if (w < 720) return 3;
  if (w < FILTERS_DESKTOP_WIDE_MIN) return 3;
  return FILTERS_DESKTOP_MAX_COLS;
}

/** Aligné sur style.css --filters-collapsed-rows (2 sous 1100 px, 3 au-delà). */
function filtersCollapsedRows() {
  return FILTERS_COMPACT_MQ.matches
    ? FILTERS_COLLAPSED_ROWS_COMPACT
    : FILTERS_COLLAPSED_ROWS_DESKTOP;
}

function syncFiltersColumns() {
  if (!FILTERS_PANEL) return;
  const cols = filtersColumnCount();
  const rows = filtersCollapsedRows();
  FILTERS_PANEL.style.setProperty('--filters-cols', String(cols));
  FILTERS_PANEL.style.setProperty('--filters-collapsed-rows', String(rows));
}

function filtersOverflow() {
  if (!NEWS_FILTERS) return false;
  const count = NEWS_FILTERS.querySelectorAll('.filter-btn').length;
  return count > filtersCollapsedRows() * filtersColumnCount();
}

function updateFiltersCompactBar() {
  if (!FILTERS_COMPACT) return;
  const dot = FILTERS_COMPACT.querySelector('.filters-compact__dot');
  const text = FILTERS_COMPACT.querySelector('.filters-compact__text');
  if (newsSourceFilter === 'all') return;

  const { institution, type, color } = sourceInfo(newsSourceFilter);
  const instLabel = filterSourceInstitutionLabel(institution, type, newsSourceFilter);
  FILTERS_COMPACT.style.setProperty('--c', color);
  if (dot) dot.style.setProperty('--c', color);
  if (text) {
    // Média protégé ; établissement traduisible (comme les pastilles sources).
    text.classList.remove('notranslate');
    text.removeAttribute('translate');
    text.replaceChildren();
    const nameSpan = document.createElement('span');
    nameSpan.className = 'notranslate';
    nameSpan.setAttribute('translate', 'no');
    nameSpan.textContent = newsSourceFilter;
    text.appendChild(nameSpan);
    if (instLabel) {
      text.appendChild(document.createTextNode(' · '));
      const instSpan = document.createElement('span');
      instSpan.className = 'filters-compact__inst';
      instSpan.textContent = instLabel;
      text.appendChild(instSpan);
    }
  }
}

function syncFiltersPanel() {
  if (!FILTERS_PANEL) return;
  syncFiltersColumns();

  const isSourceView = newsSourceFilter !== 'all';
  const overflow = filtersOverflow();

  if (FILTERS_MOBILE.matches && isSourceView) {
    FILTERS_PANEL.classList.toggle('has-overflow', true);
    if (filtersExpanded) {
      FILTERS_PANEL.classList.remove('is-compact');
      FILTERS_PANEL.classList.add('is-expanded');
      FILTERS_COMPACT?.setAttribute('hidden', '');
      FILTERS_TOGGLE?.removeAttribute('hidden');
      const label = FILTERS_TOGGLE?.querySelector('.filters-toggle__label');
      if (label) label.textContent = 'Réduire';
      FILTERS_TOGGLE?.setAttribute('aria-expanded', 'true');
      FILTERS_COMPACT?.setAttribute('aria-expanded', 'true');
    } else {
      FILTERS_PANEL.classList.add('is-compact');
      FILTERS_PANEL.classList.remove('is-expanded');
      updateFiltersCompactBar();
      FILTERS_COMPACT?.removeAttribute('hidden');
      FILTERS_TOGGLE?.setAttribute('hidden', '');
      FILTERS_COMPACT?.setAttribute('aria-expanded', 'false');
    }
    scheduleFilterMarqueeRefresh();
    return;
  }

  FILTERS_PANEL.classList.remove('is-compact');
  FILTERS_COMPACT?.setAttribute('hidden', '');
  FILTERS_PANEL.classList.toggle('has-overflow', overflow);

  if (overflow) {
    FILTERS_TOGGLE?.removeAttribute('hidden');
    FILTERS_PANEL.classList.toggle('is-expanded', filtersExpanded);
    const label = FILTERS_TOGGLE?.querySelector('.filters-toggle__label');
    if (label) label.textContent = filtersExpanded ? 'Réduire' : 'Plus de sources';
    FILTERS_TOGGLE?.setAttribute('aria-expanded', filtersExpanded ? 'true' : 'false');
  } else {
    filtersExpanded = false;
    FILTERS_PANEL.classList.remove('is-expanded');
    FILTERS_TOGGLE?.setAttribute('hidden', '');
  }

  scheduleFilterMarqueeRefresh();
}

function bindFiltersPanel() {
  FILTERS_TOGGLE?.addEventListener('click', () => {
    if (newsSourceFilter !== 'all' && filtersExpanded) {
      filtersExpanded = false;
    } else {
      filtersExpanded = !filtersExpanded;
    }
    syncFiltersPanel();
  });

  FILTERS_COMPACT?.addEventListener('click', () => {
    filtersExpanded = true;
    syncFiltersPanel();
  });

  const onFiltersLayoutChange = () => {
    syncFiltersPanel();
    scheduleFilterMarqueeRefresh();
  };
  onMediaQueryChange(FILTERS_MOBILE, onFiltersLayoutChange);
  onMediaQueryChange(FILTERS_COMPACT_MQ, onFiltersLayoutChange);

  if (NEWS_FILTERS && typeof ResizeObserver !== 'undefined') {
    const filtersResize = new ResizeObserver(() => {
      syncFiltersPanel();
      scheduleFilterMarqueeRefresh();
    });
    filtersResize.observe(NEWS_FILTERS);
  }
}

function selectNewsSource(source) {
  newsSourceFilter = source;
  NEWS_FILTERS?.querySelectorAll('.filter-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.source === source));
  if (FILTERS_MOBILE.matches && source !== 'all') filtersExpanded = false;
  syncFiltersPanel();
  renderNews();
}

function renderNewsFilters() {
  if (!NEWS_FILTERS) return;
  const sources = sortSourcesForFilters([...new Set(news.map(n => n.source))]);
  [...NEWS_FILTERS.querySelectorAll('[data-source]:not([data-source="all"])')].forEach(b => b.remove());

  sources.forEach(src => {
    const btn = document.createElement('button');
    const { institution, type, color } = sourceInfo(src);
    const instLabel = filterSourceInstitutionLabel(institution, type, src);

    btn.className = 'filter-btn';
    btn.dataset.source = src;
    btn.style.setProperty('--c', color);
    btn.title = institution ? `${src} — ${instLabel || formatInstitutionDisplay(institution)}` : src;
    btn.innerHTML = `
      <span class="filter-btn__row">
        <span class="filter-btn__dot" aria-hidden="true"></span>
        <span class="filter-btn__name notranslate" translate="no">${escapeHtml(src)}</span>
      </span>
      ${instLabel ? '<span class="filter-btn__inst"></span>' : ''}
    `;
    NEWS_FILTERS.appendChild(btn);
  });

  NEWS_FILTERS.querySelectorAll('.filter-btn').forEach(btn => {
    btn.onclick = () => selectNewsSource(btn.dataset.source);
  });

  NEWS_FILTERS.querySelectorAll('.filter-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.source === newsSourceFilter));

  syncFiltersPanel();
  registerFilterMarqueeObservers();
  applyFilterInstMarquees();
  scheduleFilterMarqueeRefresh();
}

function renderNews() {
  if (!NEWS_LIST) return;
  const isSourceView = newsSourceFilter !== 'all';
  const items = isSourceView
    ? news.filter(n => n.source === newsSourceFilter)
    : news;

  NEWS_EMPTY.classList.toggle('hidden', items.length > 0);
  NEWS_COUNT.textContent = `${items.length} article${items.length !== 1 ? 's' : ''}`;
  NEWS_LIST.innerHTML = '';
  if (isSourceView) {
    NEWS_LIST.dataset.mode = 'source';
  } else {
    NEWS_LIST.removeAttribute('data-mode');
  }

  const hero = document.createElement('div');
  hero.className = 'news-hero';
  const compacts = [];
  const tail = [];

  const partition = isSourceView
    ? partitionSourceFeed(items)
    : partitionNewsFeed(items);
  const { heroItems, briefItems, tailItems, contingencyBand } = partition;

  if (contingencyBand > 0) {
    NEWS_LIST.dataset.contingency = String(contingencyBand);
  } else {
    NEWS_LIST.removeAttribute('data-contingency');
  }
  if (!isSourceView && isAutumnGracePeriod()) {
    NEWS_LIST.dataset.autumnGrace = '1';
  } else {
    NEWS_LIST.removeAttribute('data-autumn-grace');
  }

  heroItems.forEach((item, i) => {
    const role = i === 0 ? 'lead' : 'feature';
    const article = safeCreateArticle(item, role);
    if (article) hero.appendChild(article);
  });

  briefItems.forEach((item) => {
    const article = safeCreateArticle(item, 'compact');
    if (article) compacts.push(article);
  });

  tailItems.forEach((item) => {
    const article = safeCreateArticle(item, 'standard');
    if (article) tail.push(article);
  });

  if (hero.childElementCount) {
    NEWS_LIST.appendChild(hero);
  }
  if (compacts.length) {
    const briefRail = document.createElement('div');
    briefRail.className = 'brief-rail';
    briefRail.innerHTML = '<h3 class="brief-rail-title">En bref</h3>';
    compacts.forEach((article) => briefRail.appendChild(article));
    NEWS_LIST.appendChild(briefRail);
  }

  if (tail.length) {
    const section = document.createElement('div');
    section.className = 'news-tail';
    section.innerHTML = '<h3 class="news-tail-title">Suite du fil</h3>';
    tail.forEach(article => section.appendChild(article));
    NEWS_LIST.appendChild(section);
  }

  const briefCount = compacts.length;
  if (briefCount) NEWS_LIST.dataset.briefCount = String(briefCount);
  else NEWS_LIST.removeAttribute('data-brief-count');

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

const HERO_SPOTLIGHT_MAX = 3; /* 1 à la une + 2 vedettes (fil global) */
const BRIEF_SIDEBAR_MAX = 7;
/* Vue source : plus de vedettes intermédiaires (voir partitionSourceFeed). */
/**
 * Fraîcheur universelle : scripts/session-freshness-lib.js
 * (même règle bots + UI — automne/hiver/été + grâce septembre).
 */
const _SF = (typeof RadarSessionFreshness !== 'undefined') ? RadarSessionFreshness : null;
const FRESHNESS_SESSION_COUNT = _SF?.FRESHNESS_SESSION_COUNT ?? 3;
const CONTINGENCY_MAX_SESSIONS_BACK = _SF?.CONTINGENCY_MAX_SESSIONS_BACK
  ?? (FRESHNESS_SESSION_COUNT - 1);
/* Vedettes (feature) = même budget / sources d'extrait que « À la une ». */
const BRIEF_LIMITS = { lead: 720, feature: 720, compact: 400, standard: 260 };
const LEAD_BRIEF_MIN_CHARS = 160;
const BRIEF_COMPACT_MIN_CHARS = 150;
const FEATURE_BRIEF_MIN_CHARS = LEAD_BRIEF_MIN_CHARS;

function articleKey(item) {
  return item.link || `${item.source}::${item.date}::${item.title}`;
}

function institutionKey(item) {
  return item.institution || item.source;
}

function sourceKey(item) {
  return item.source;
}

function latestPerKey(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const k = keyFn(item);
    const cur = map.get(k);
    if (!cur || new Date(item.date || 0) > new Date(cur.date || 0)) {
      map.set(k, item);
    }
  }
  return map;
}

function sortByDateDesc(items) {
  return [...items].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

/* --- Calendrier / fraîcheur : délégué à session-freshness-lib (universel) --- */
function getCurrentUniversitySessionStart(referenceDate = new Date()) {
  return _SF
    ? _SF.getCurrentUniversitySessionStart(referenceDate)
    : (() => {
      const y = referenceDate.getFullYear();
      const m = referenceDate.getMonth();
      if (m >= 8) return new Date(y, 8, 1);
      if (m >= 4) return new Date(y, 4, 1);
      return new Date(y, 0, 1);
    })();
}

function getUniversitySessionStart(referenceDate = new Date(), sessionsBack = 0) {
  return _SF
    ? _SF.getUniversitySessionStart(referenceDate, sessionsBack)
    : getCurrentUniversitySessionStart(referenceDate);
}

function getUniversitySessionBand(referenceDate = new Date(), sessionsBack = 0) {
  return _SF
    ? _SF.getUniversitySessionBand(referenceDate, sessionsBack)
    : { start: getCurrentUniversitySessionStart(referenceDate), end: referenceDate };
}

function isWithinUniversitySessionBand(item, referenceDate = new Date(), sessionsBack = 0) {
  return _SF
    ? _SF.isWithinUniversitySessionBand(item, referenceDate, sessionsBack)
    : false;
}

function sessionBandPool(items, referenceDate = new Date(), sessionsBack = 0) {
  return sortByDateDesc(
    items.filter((i) => isWithinUniversitySessionBand(i, referenceDate, sessionsBack)),
  );
}

function isAutumnGracePeriod(referenceDate = new Date()) {
  return _SF
    ? _SF.isAutumnGracePeriod(referenceDate)
    : referenceDate.getMonth() === 8;
}

function freshnessMaxSessionsBack(referenceDate = new Date()) {
  return _SF
    ? _SF.freshnessMaxSessionsBack(referenceDate)
    : CONTINGENCY_MAX_SESSIONS_BACK + (isAutumnGracePeriod(referenceDate) ? 1 : 0);
}

function isWithinFreshnessWindow(item, referenceDate = new Date()) {
  return _SF
    ? _SF.isWithinFreshnessWindow(item, referenceDate)
    : false;
}

function isPublishedOnOrBefore(item, referenceDate = new Date()) {
  return _SF
    ? _SF.isPublishedOnOrBefore(item, referenceDate)
    : (() => {
      const published = new Date(item.date || 0);
      return Number.isFinite(published.getTime()) && published.getTime() <= referenceDate.getTime();
    })();
}

function filterFreshItems(items, referenceDate = new Date()) {
  return _SF
    ? _SF.filterFreshItems(items, referenceDate)
    : items.filter(
      (item) => isPublishedOnOrBefore(item, referenceDate) && isWithinFreshnessWindow(item, referenceDate),
    );
}

function compareBriefCandidates(a, b) {
  /* À popularité égale : photo d'abord, puis date. */
  const byPop = sourcePopularityRank(a.source) - sourcePopularityRank(b.source);
  if (byPop !== 0) return byPop;
  const imgA = itemHasThumbPhoto(a) ? 0 : 1;
  const imgB = itemHasThumbPhoto(b) ? 0 : 1;
  if (imgA !== imgB) return imgA - imgB;
  return new Date(b.date || 0) - new Date(a.date || 0);
}

function itemHasThumbPhoto(item) {
  return hasUsablePhoto(item, 'feature') || hasStockPhoto(item, 'feature');
}

/** D'abord les plus récents avec photo, puis les plus récents sans. */
function preferPhotoFirst(items) {
  const withPhoto = [];
  const without = [];
  for (const item of items) {
    if (itemHasThumbPhoto(item)) withPhoto.push(item);
    else without.push(item);
  }
  return [...sortByDateDesc(withPhoto), ...sortByDateDesc(without)];
}

/**
 * Remplit jusqu'à max : d'abord 1 article récent par institution (hors excludeInsts),
 * puis complète avec des sources déjà représentées si le pool frais est trop maigre.
 * Les listes passées ici devraient déjà préférer les articles avec photo.
 */
function pickSpotlightSlots(items, max, excludeInsts = new Set()) {
  const picks = [];
  const usedKeys = new Set();
  const usedInsts = new Set(excludeInsts);

  for (const item of items) {
    if (picks.length >= max) break;
    const inst = institutionKey(item);
    if (usedInsts.has(inst)) continue;
    picks.push(item);
    usedKeys.add(articleKey(item));
    usedInsts.add(inst);
  }

  for (const item of items) {
    if (picks.length >= max) break;
    const key = articleKey(item);
    if (usedKeys.has(key)) continue;
    picks.push(item);
    usedKeys.add(key);
  }

  return picks;
}

function isArticlePicked(item, picks) {
  const key = articleKey(item);
  return picks.some((pick) => articleKey(pick) === key);
}

/**
 * Hero : 1 « À la une » = article le plus récent (toujours), puis 2 features
 * d'autres institutions (préférence photos). Session en cours d'abord ;
 * bandes précédentes si slots vides. Ne jamais rétrograder la une pour
 * une photo / un extrait (le rendu gère le repli SVG).
 */
function pickHeroSpotlight(items, referenceDate = new Date()) {
  const sorted = sortByDateDesc(items);
  if (!sorted.length) return { items: [], contingencyBand: 0 };

  const lead = sorted[0];
  const picks = [lead];
  const usedInsts = new Set([institutionKey(lead)]);
  let contingencyBand = 0;
  const autumnGrace = isAutumnGracePeriod(referenceDate);

  const fillFeatures = (pool, band) => {
    if (picks.length >= HERO_SPOTLIGHT_MAX) return;
    /* preferPhotoFirst = récents avec photo d’abord, puis récents sans. */
    const available = preferPhotoFirst(
      pool.filter((item) => !isArticlePicked(item, picks)),
    );
    const batch = pickSpotlightSlots(
      available,
      HERO_SPOTLIGHT_MAX - picks.length,
      usedInsts,
    );
    if (!batch.length) return;
    for (const item of batch) {
      picks.push(item);
      usedInsts.add(institutionKey(item));
    }
    contingencyBand = Math.max(contingencyBand, band);
  };

  for (let band = 0; band <= freshnessMaxSessionsBack(referenceDate); band++) {
    fillFeatures(sessionBandPool(items, referenceDate, band), band);
    if (picks.length >= HERO_SPOTLIGHT_MAX) break;
  }

  if (autumnGrace && picks.length < HERO_SPOTLIGHT_MAX) {
    const representedSources = new Set(picks.map(sourceKey));
    const missingSourcePool = preferPhotoFirst(sorted.filter((item) => {
      if (isArticlePicked(item, picks)) return false;
      if (representedSources.has(sourceKey(item))) return false;
      if (sessionBandPool([item], referenceDate, 0).length) return false;
      return isWithinFreshnessWindow(item, referenceDate);
    }));
    for (const item of missingSourcePool) {
      if (picks.length >= HERO_SPOTLIGHT_MAX) break;
      if (usedInsts.has(institutionKey(item))) continue;
      picks.push(item);
      usedInsts.add(institutionKey(item));
      representedSources.add(sourceKey(item));
      contingencyBand = Math.max(contingencyBand, 1);
    }
  }

  /* Lead figé en [0] ; features triées par date (sans renvoyer la une en bas). */
  const features = sortByDateDesc(picks.slice(1));
  return { items: [picks[0], ...features], contingencyBand };
}

function fillBriefFromSessionPool(eligible, heroSources, state) {
  const { picks, usedKeys, usedSources } = state;

  const add = (item, { allowDuplicateSource = false } = {}) => {
    if (!item || picks.length >= BRIEF_SIDEBAR_MAX) return false;
    const key = articleKey(item);
    const src = sourceKey(item);
    if (usedKeys.has(key)) return false;
    if (!allowDuplicateSource && usedSources.has(src)) return false;
    picks.push(item);
    usedKeys.add(key);
    usedSources.add(src);
    return true;
  };

  const pool = eligible.filter((item) => !usedKeys.has(articleKey(item)));
  const latestBySource = latestPerKey(pool, sourceKey);

  [...latestBySource.entries()]
    .filter(([src]) => !heroSources.has(src))
    .map(([, item]) => item)
    .sort(compareBriefCandidates)
    .forEach((item) => add(item));

  [...latestBySource.entries()]
    .filter(([src]) => heroSources.has(src))
    .map(([, item]) => item)
    .sort(compareBriefCandidates)
    .forEach((item) => add(item));

  for (const item of pool) {
    if (picks.length >= BRIEF_SIDEBAR_MAX) break;
    add(item);
  }

  for (const item of pool) {
    if (picks.length >= BRIEF_SIDEBAR_MAX) break;
    add(item, { allowDuplicateSource: true });
  }
}

/**
 * En bref : mêmes règles de diversité ; exception temporaire par bande
 * de session si la session en cours ne remplit pas les slots.
 */
function pickBriefSidebar(allItems, heroItems = [], referenceDate = new Date()) {
  const heroKeys = new Set(heroItems.map(articleKey));
  const heroSources = new Set(heroItems.map(sourceKey));
  const state = {
    picks: [],
    usedKeys: new Set(),
    usedSources: new Set(),
  };
  let contingencyBand = 0;

  for (let band = 0; band <= freshnessMaxSessionsBack(referenceDate); band++) {
    if (state.picks.length >= BRIEF_SIDEBAR_MAX) break;
    const before = state.picks.length;
    const eligible = sessionBandPool(allItems, referenceDate, band).filter(
      (item) => !heroKeys.has(articleKey(item)),
    );
    fillBriefFromSessionPool(eligible, heroSources, state);
    if (state.picks.length > before) contingencyBand = Math.max(contingencyBand, band);
  }

  if (isAutumnGracePeriod(referenceDate) && state.picks.length < BRIEF_SIDEBAR_MAX) {
    const before = state.picks.length;
    const representedSources = new Set(state.picks.map(sourceKey));
    const gracePool = sortByDateDesc(allItems).filter((item) => {
      if (heroKeys.has(articleKey(item))) return false;
      if (representedSources.has(sourceKey(item))) return false;
      if (sessionBandPool([item], referenceDate, 0).length) return false;
      return isWithinFreshnessWindow(item, referenceDate);
    });
    fillBriefFromSessionPool(gracePool, heroSources, state);
    if (state.picks.length > before) contingencyBand = Math.max(contingencyBand, 1);
  }

  return {
    items: sortByDateDesc(state.picks),
    contingencyBand,
  };
}

function partitionNewsFeed(items, referenceDate = new Date()) {
  const sorted = sortByDateDesc(filterFreshItems(items, referenceDate));
  const { items: rawHero, contingencyBand: heroBand } = pickHeroSpotlight(sorted, referenceDate);
  const heroItems = ensureHeroLeadHasImage(rawHero, sorted);
  const heroKeys = new Set(heroItems.map(articleKey));
  const { items: briefItems, contingencyBand: briefBand } = pickBriefSidebar(
    sorted,
    heroItems,
    referenceDate,
  );
  const briefKeys = new Set(briefItems.map(articleKey));
  const tailItems = sorted.filter(
    (i) => !heroKeys.has(articleKey(i)) && !briefKeys.has(articleKey(i)),
  );
  const contingencyBand = Math.max(heroBand, briefBand);
  return { heroItems, briefItems, tailItems, contingencyBand };
}

/**
 * Pool d'un seul média : articles dans la fenêtre de fraîcheur (3 sessions),
 * alignée sur le fil global et sur fetch-news.js.
 */
function sortSourcePool(items) {
  return sortByDateDesc(items);
}

function collectSourcePool(items, referenceDate = new Date()) {
  const pool = sortSourcePool(
    filterFreshItems(
      items.filter((item) => isPublishedOnOrBefore(item, referenceDate)),
      referenceDate,
    ),
  );
  return { items: pool, contingencyBand: 0 };
}

function leadBriefCharCount(item) {
  const lead = sanitizeBriefBody(String(item.leadExcerpt || ''));
  if (lead.length >= LEAD_BRIEF_MIN_CHARS) return lead.length;
  const excerpt = sanitizeBriefBody(String(item.excerpt || ''));
  if (excerpt.length >= LEAD_BRIEF_MIN_CHARS) return excerpt.length;
  const { body } = splitByline(item);
  return Math.max(lead.length, excerpt.length, sanitizeBriefBody(body).length);
}

function hasSubstantialLeadBrief(item) {
  return leadBriefCharCount(item) >= LEAD_BRIEF_MIN_CHARS;
}

function pickSourceLead(pool) {
  return pool[0] || null;
}

/**
 * Vue d'un seul média (filtre source).
 *
 * Une seule pièce « À la une » (lead), puis le reste en En bref / Suite —
 * pas de vedettes (feature) intermédiaires : sur < 1100 px elles ont
 * quasi le même rendu que les cartes En bref, ce qui donnait l'impression
 * d'un double (ex. The Concordian : 2 « grosses » cartes + EN BREF).
 */
function partitionSourceFeed(items, referenceDate = new Date()) {
  const sorted = sortByDateDesc(items);
  const { items: pool, contingencyBand } = collectSourcePool(sorted, referenceDate);
  const lead = pickSourceLead(pool);
  const heroItems = lead ? [lead] : [];
  const heroKeys = new Set(heroItems.map(articleKey));
  const rest = pool.filter((item) => !heroKeys.has(articleKey(item)));
  const briefItems = rest.slice(0, BRIEF_SIDEBAR_MAX);
  const briefKeys = new Set(briefItems.map(articleKey));
  const tailItems = rest.filter((item) => !briefKeys.has(articleKey(item)));
  const leadHasImage = !!(lead && hasDisplayImage(lead));
  return { heroItems, briefItems, tailItems, contingencyBand, leadHasImage };
}

function safeCreateArticle(item, role = 'standard') {
  try {
    return createArticle(item, role);
  } catch (err) {
    console.error('Le Radar: échec rendu article', item?.source, item?.title, err);
    return null;
  }
}

function createArticle(item, role = 'standard') {
  const link = safeHttpUrl(item.link);
  const a = document.createElement(link ? 'a' : 'div');
  a.className = `article article--${role}`;
  if (link) {
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }

  const color = safeCssColor(sourceAccentColor(item)) || 'var(--accent)';
  a.style.setProperty('--c', color);

  const d = item.date ? new Date(item.date) : null;
  const time = d
    ? formatStampCompact(d, item.lang === 'en' ? 'en' : 'fr')
    : '';
  const fresh = d ? (Date.now() - d) < 120 * 60000 : false;
  const { author: rawAuthor, body } = splitByline(item);
  const displayAuthor = resolveDisplayAuthor(item, rawAuthor);
  /* Vedettes : même règles de contenu que la une (leadExcerpt, longueur, minimum). */
  const isLeadLikeBrief = role === 'lead' || role === 'feature';
  const leadBody = isLeadLikeBrief
    ? (item.leadExcerpt || body || item.excerpt || '')
    : body;
  let { text: brief, truncated: briefTruncated } = resolveBrief(item, leadBody, role);
  if (isLeadLikeBrief && !brief) {
    ({ text: brief, truncated: briefTruncated } = resolveBrief(item, item.excerpt || body, role));
  }
  if (isLeadLikeBrief && brief) {
    ({ text: brief, truncated: briefTruncated } = ensureLeadBriefMinLines(brief, briefTruncated, item));
    const fullSource = sanitizeBriefBody(leadBody);
    if (fullSource.length > brief.length + 12 || (brief.length >= 100 && item.link)) {
      briefTruncated = true;
    }
  }
  if (role === 'compact' && brief) {
    ({ text: brief, truncated: briefTruncated } = ensureCompactBriefMinLines(brief, briefTruncated, item));
  }
  if (rawAuthor && brief) {
    brief = stripLeadingByline(brief, rawAuthor);
  }
  if (item.link) {
    briefTruncated = true;
  }
  const readMore = item.lang === 'en' ? 'Read more →' : 'Lire la suite →';
  const byLabel = item.lang === 'en' ? 'By' : 'Par';
  /* Vignette à droite pour les vedettes et En bref : photo réelle ou banque
     d'images seulement (le repli SVG serait illisible en petit format). */
  const isThumbRole = ['feature', 'compact'].includes(role);
  const canUseImage = role === 'lead' || isThumbRole;
  /* Vignettes : seuils assouplis (forThumb) — beaucoup d’URL WP ~300–500 px
     étaient rejetées alors qu’elles passent bien en object-fit. */
  const hasImageCandidate = role === 'lead'
    || (isThumbRole && (hasUsablePhoto(item, role) || hasStockPhoto(item, role)));
  if (!hasImageCandidate && canUseImage) a.classList.add('article--text');
  if (isThumbRole && hasImageCandidate) a.classList.add('article--thumb');
  const timeHtml = time
    ? `<time class="article-time${fresh ? ' is-fresh' : ''}" datetime="${escapeHtml(item.date)}">${time}</time>`
    : '';
  const instHtml = item.institution
    ? articleInstitutionMetaHtml(item.institution, item.type, role)
    : '';
  const metaLead = (item.source || item.institution)
    ? `<span class="article-meta__lead">
        ${item.source ? `<span class="article-source notranslate" translate="no">${escapeHtml(item.source)}</span>` : ''}
        ${instHtml}
      </span>`
    : '';
  const metaHtml = (metaLead || timeHtml)
    ? `<div class="article-meta">${metaLead}${timeHtml}</div>`
    : '';
  const briefHtml = item.link || brief
    ? `<p class="article-brief${briefTruncated ? ' is-truncated' : ''}"><span class="article-brief-text">${escapeHtml(brief || '')}</span>${briefTruncated ? `<span class="article-more" style="color: ${color}">${readMore}</span>` : ''}</p>`
    : '';
  // Espace garanti en CSS (.article-author) : la traduction du libellé « Par »/« By »
  // mange souvent l'espace final du nœud texte.
  const bylineHtml = `<p class="article-byline"><span class="article-byline__label">${escapeHtml(byLabel)}</span><strong class="article-author notranslate" translate="no">${escapeHtml(displayAuthor)}</strong></p>`;
  const titleHtml = `<h3 class="article-title">${escapeHtml(cleanTitle(item.title))}</h3>`;
  const mediaHtml = hasImageCandidate ? '<figure class="article-media"></figure>' : '';
  if (role === 'lead') {
    a.innerHTML = `
      <span class="article-eyebrow">À la une</span>
      ${metaHtml}
      ${mediaHtml}
      ${titleHtml}
      ${bylineHtml}
      ${briefHtml}
    `;
  } else {
    a.innerHTML = `
      ${metaHtml}
      ${mediaHtml}
      ${titleHtml}
      ${bylineHtml}
      ${briefHtml}
    `;
  }

  if (hasImageCandidate) {
    /* Vignettes (vedettes + En bref) aussi sur mobile, avec crédit photo —
       le CSS adapte la largeur pour éviter l'écrasement du texte. */
    attachArticleImage(a, item, role);
  }
  return a;
}

/** Aligné sur scripts/article-image-lib.js isWeakImageUrl :
 *  ne rejette que les petites vignettes WP (-150x150), pas -930x620. */
const WEAK_IMAGE_PATH = /article-tile|size-article-tile/;

/** Aligné sur scripts/article-image-lib.js GLOBAL_IMAGE_REJECT_RE */
const GLOBAL_IMAGE_REJECT_RE = /(?:logo|avatar|icon|placeholder|default|blank|spacer|profile|author|favicon|gravatar|emoji|smiley|lapige_web|(?:^|\/)article-2\.|campus-logo|campusgraphic|article-tile|size-article-tile|thumbnail|thumb_|recent-posts|wp-block-query|widget|sponsor|banner|social-share|-150x\d+\.|cropped-logo|(?:^|\/)daily\.png$|editorial[_-]|(?:^|\/)editorial(?:s)?(?:[_./-]|$)|画板|%e7%94%bb%e6%9d%bf|_optimized_optimized_optimized|00\.graphics\.csu\.naya_hachwa)/i;

function isFallbackImageUrl(raw = '') {
  const src = String(raw).trim();
  if (!src) return false;
  if (src.startsWith('data:image/svg')) return true;
  return src.startsWith('./assets/lead-fallbacks/') && src.endsWith('.svg');
}

function resizeFromImageQuery(raw = '') {
  try {
    const u = new URL(raw);
    const resize = u.searchParams.get('resize');
    if (resize) {
      const parts = resize.split(/[,%]/).map((n) => parseInt(n, 10));
      return { width: parts[0] || 0, height: parts[1] || 0 };
    }
    const w = parseInt(u.searchParams.get('w'), 10) || 0;
    const h = parseInt(u.searchParams.get('h'), 10) || 0;
    if (w || h) return { width: w, height: h };
    // Transformations dans le chemin (substackcdn/Cloudinary : « ,w_256,c_limit,… »)
    const pw = u.pathname.match(/[,/]w_(\d+)\b/);
    const ph = u.pathname.match(/[,/]h_(\d+)\b/);
    if (pw || ph) {
      return { width: pw ? parseInt(pw[1], 10) : 0, height: ph ? parseInt(ph[1], 10) : 0 };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function isWeakImagePath(path = '', { forThumb = false } = {}) {
  const p = String(path).toLowerCase();
  // Suffixe WP « -{w}x{h}. » : rejeter les vraies miniatures, garder les
  // formats vedette (ex. Campus2-930x620.jpg sur Le Délit).
  // Vignettes feature / En bref : seuils bas (object-fit ~100–180 px).
  const sized = p.match(/-(\d{2,4})x(\d{2,4})(?=\.[a-z]+$)/);
  if (sized) {
    const w = parseInt(sized[1], 10);
    const h = parseInt(sized[2], 10);
    if (w > 0 && h > 0) {
      if (forThumb) {
        if (Math.max(w, h) < 80 || w * h < 8000) return true;
      } else {
        if (Math.max(w, h) < 400) return true;
        if (w < 640 || h < 360 || w * h < 200000) return true;
      }
    }
  }
  return WEAK_IMAGE_PATH.test(p);
}

/**
 * @param {string} src
 * @param {{ forThumb?: boolean }} [opts] — seuils assouplis pour feature / En bref
 */
function getCandidateImage(src = '', { forThumb = false } = {}) {
  const raw = String(src).trim();
  if (!raw) return '';

  if (isFallbackImageUrl(raw)) {
    try {
      return new URL(raw, location.href).href;
    } catch {
      return '';
    }
  }

  let url;
  try {
    url = new URL(raw, location.href);
  } catch {
    return '';
  }

  if (!['http:', 'https:'].includes(url.protocol)) return '';
  const path = decodeURIComponent(url.pathname).toLowerCase();
  if (GLOBAL_IMAGE_REJECT_RE.test(path)) return '';
  if (/(?:^|\/)(?:1x1|pixel)\b/.test(path)) return '';
  const minW = forThumb ? 120 : 640;
  const minH = forThumb ? 100 : 360;
  const minPx = forThumb ? 12_000 : 240_000;
  const resize = resizeFromImageQuery(raw);
  if (resize) {
    const { width = 0, height = 0 } = resize;
    if ((width > 0 && width < minW) || (height > 0 && height < minH)) return '';
    if (width > 0 && height > 0 && width * height < minPx) return '';
  }
  if (isWeakImagePath(path, { forThumb })) return '';
  return url.href;
}

/**
 * Redimensionne les énormes originaux Wikimedia (8K…) pour l'affichage —
 * surtout les vignettes En bref, qui chargeaient l'original et tombaient
 * dans le timeout 2,5 s → plus de photo.
 */
function displaySizedImageUrl(raw = '', role = 'lead') {
  const src = getCandidateImage(raw) || String(raw || '').trim();
  if (!src || isFallbackImageUrl(src)) return src;
  try {
    const u = new URL(src, location.href);
    const host = u.hostname.toLowerCase();
    const isThumb = role === 'feature' || role === 'compact';
    const maxW = role === 'lead' ? 1400 : (isThumb ? 480 : 960);

    // Déjà un dérivé dimensionné (thumb Wikimedia ou ?width=).
    if (/\/commons\/thumb\//i.test(u.pathname) || u.searchParams.has('width')) {
      return src;
    }

    if (host === 'upload.wikimedia.org' || host.endsWith('.wikimedia.org')) {
      const fileMatch = u.pathname.match(/\/([^/]+\.(?:jpe?g|png|webp|gif))$/i);
      if (fileMatch) {
        const file = decodeURIComponent(fileMatch[1]);
        // Special:FilePath redirige vers un JPEG redimensionné (fiable avec accents).
        return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${maxW}`;
      }
    }
  } catch {
    /* keep original */
  }
  return src;
}

function hasUsablePhoto(item, role = 'lead') {
  const forThumb = role === 'feature' || role === 'compact';
  return !!getCandidateImage(item?.image, { forThumb });
}

function hasStockPhoto(item, role = 'lead') {
  const forThumb = role === 'feature' || role === 'compact';
  return !!getCandidateImage(item?.stockImage, { forThumb });
}

function hasDisplayImage(item, role = 'lead') {
  return hasUsablePhoto(item, role) || hasStockPhoto(item, role) || isFallbackImageUrl(item?.fallbackImage);
}

function darkenHex(hex, amount = 0.32) {
  const h = String(hex || '#003DA5').replace('#', '');
  if (h.length !== 6) return '#003DA5';
  const r = Math.max(0, Math.round(parseInt(h.slice(0, 2), 16) * (1 - amount)));
  const g = Math.max(0, Math.round(parseInt(h.slice(2, 4), 16) * (1 - amount)));
  const b = Math.max(0, Math.round(parseInt(h.slice(4, 6), 16) * (1 - amount)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function wrapTitleLines(text = '', max = 36, lines = 4) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > max && line) {
      out.push(line);
      line = w;
    } else {
      line = next;
    }
    if (out.length >= lines) break;
  }
  if (line && out.length < lines) out.push(line);
  return out.slice(0, lines);
}

function buildClientFallbackDataUrl(item) {
  const color = safeCssColor(
    institutionBrandColor(item.institution || '') || sourceColors[item.source],
  ) || '#003DA5';
  const dark = darkenHex(color);
  const title = cleanTitle(item.title || 'Article');
  const source = item.source || 'Le Radar';
  const inst = item.institution ? formatInstitutionDisplay(item.institution) : '';
  const lines = wrapTitleLines(title, 36, 4);
  const tspans = lines.map((ln, i) =>
    `<tspan x="64" dy="${i === 0 ? 0 : 36}">${escapeHtml(ln)}</tspan>`,
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" role="img" aria-label="${escapeHtml(title)}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="${dark}"/></linearGradient></defs>
  <rect width="1280" height="800" fill="url(#bg)"/>
  <text x="64" y="72" fill="rgba(255,255,255,0.92)" font-family="system-ui,sans-serif" font-size="28" font-weight="700">${escapeHtml(source.toUpperCase())}</text>
  ${inst ? `<text x="64" y="108" fill="rgba(255,255,255,0.72)" font-family="system-ui,sans-serif" font-size="20">${escapeHtml(inst)}</text>` : ''}
  <text x="64" y="${inst ? 220 : 200}" fill="#fff" font-family="Georgia,serif" font-size="44" font-weight="700">${tspans}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function shouldPreferStockPhoto(item, role = 'lead') {
  // Jamais remplacer une vraie photo d'article par la banque campus (pavillon).
  if (item.imageProvider === 'campus-bank' && hasUsablePhoto(item)) return false;
  // Source absente / rejetée (logo Daily.png, bannière editorial_…) → stock.
  if (hasStockPhoto(item) && !hasUsablePhoto(item)) return true;
  // Photo source trop faible pour la une, mais stock thématique Openverse déjà trouvé
  // (ex. McGill Daily : Daily.png laissé en image + openverse gentrification).
  if (
    role === 'lead'
    && item.leadImageReady === false
    && hasStockPhoto(item)
    && item.imageProvider
    && item.imageProvider !== 'campus-bank'
  ) {
    return true;
  }
  return false;
}

function resolveDisplayImage(item, { preferPhoto = true, role = 'lead' } = {}) {
  const forThumb = role === 'feature' || role === 'compact';
  if (shouldPreferStockPhoto(item, role)) preferPhoto = false;

  // Photo source d'abord, sauf si on a explicitement préféré le stock thématique.
  if (preferPhoto && hasUsablePhoto(item, role)) {
    return { src: getCandidateImage(item.image, { forThumb }), kind: 'photo' };
  }
  // Banque libre thématique OK ; campus bank seulement sans photo source.
  if (hasStockPhoto(item, role)) {
    if (item.imageProvider === 'campus-bank' && hasUsablePhoto(item, role)) {
      return { src: getCandidateImage(item.image, { forThumb }), kind: 'photo' };
    }
    return { src: getCandidateImage(item.stockImage, { forThumb }), kind: 'stock' };
  }
  if (isFallbackImageUrl(item?.fallbackImage)) {
    return { src: getCandidateImage(item.fallbackImage), kind: 'fallback' };
  }
  if (!preferPhoto && hasUsablePhoto(item, role)) {
    return { src: getCandidateImage(item.image, { forThumb }), kind: 'photo' };
  }
  return { src: '', kind: 'none' };
}

/**
 * La une reste l'article le plus récent. Ne jamais l'échanger contre un plus
 * ancien pour une photo ou un extrait — attachArticleImage génère un repli SVG
 * côté client si besoin. On s'assure seulement que les features ne dupliquent pas la une.
 */
function ensureHeroLeadHasImage(heroItems, allItems) {
  if (!heroItems.length) return heroItems;
  const lead = heroItems[0];
  const leadKey = articleKey(lead);
  const features = heroItems.slice(1).filter((item) => articleKey(item) !== leadKey);
  return [lead, ...features];
}

function cleanCreatorDisplay(raw = '') {
  let s = String(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const attrIdx = s.search(/\s*(?:["'])\s*(?:width|height|srcset|class|style)\s*=/i);
  if (attrIdx > 0) s = s.slice(0, attrIdx);
  const bareAttr = s.search(/\s+(?:width|height|srcset)\s*=\s*["']/i);
  if (bareAttr > 0) s = s.slice(0, bareAttr);
  s = s.replace(/\\+"/g, '"').replace(/\)\s*["']\s*$/g, ')').replace(/["']\s*$/g, '').trim();
  s = s.replace(/\.mw-parser-output[\s\S]*/i, '').trim();
  // Champ dédoublé à la source (« Unknown authorUnknown author ») :
  // ne garder qu'une occurrence.
  s = s.replace(/^(.{3,}?)\s*\1$/u, '$1').trim();
  if (s.length > 72) {
    const cut = s.slice(0, 72);
    const lastSpace = cut.lastIndexOf(' ');
    s = `${(lastSpace > 36 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return s;
}

function parseImageCreditLine(credit = '') {
  const m = String(credit).match(/^Photo\s*:\s*(.+?)\s*\/\s*(.+?)\s*·\s*(.+)$/i);
  if (!m) return null;
  return {
    creator: cleanCreatorDisplay(m[1].trim()),
    license: m[2].trim(),
    via: m[3].trim(),
  };
}

function creditLink(href, label, className = '') {
  const safe = safeHttpUrl(href, { allowHttp: true });
  if (!safe) {
    const span = document.createElement('span');
    span.textContent = label;
    if (className) span.className = className;
    return span;
  }
  const a = document.createElement('a');
  a.href = safe;
  a.target = '_blank';
  a.rel = 'noopener noreferrer license';
  a.textContent = label;
  if (className) a.className = className;
  a.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.open(safe, '_blank', 'noopener,noreferrer');
  });
  return a;
}

function buildSourcePhotoCreditElement(item = {}) {
  const credit = String(item.sourceImageCredit || '').trim();
  if (!credit) return null;

  const cap = document.createElement('figcaption');
  cap.className = 'article-media-credit';
  const url = String(item.sourceImageCreditUrl || item.link || '').trim();
  const en = item.lang === 'en';
  const fromMedia = item.sourceImageCreditFrom === 'media';

  if (fromMedia) {
    // « Crédit photo : The Plant » — le nom du média ne se traduit pas.
    const mediaName = String(item.source || '').trim();
    const prefixMatch = credit.match(/^(Photo credit|Crédit photo|Photo)\s*:\s*(.+)$/i);
    const name = (prefixMatch ? prefixMatch[2] : credit).trim() || mediaName || credit;
    const prefix = prefixMatch
      ? `${prefixMatch[1].replace(/:$/, '')}: `
      : (en ? 'Photo credit: ' : 'Crédit photo : ');
    cap.appendChild(document.createTextNode(prefix));
    if (url) {
      const a = creditLink(url, name, 'article-media-credit__creator notranslate');
      a.setAttribute('translate', 'no');
      cap.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = 'notranslate';
      span.setAttribute('translate', 'no');
      span.textContent = name;
      cap.appendChild(span);
    }
    return cap;
  }

  const creator = cleanCreatorDisplay(item.sourceImageCreator || '');
  const parsed = parseImageCreditLine(credit);
  if (parsed && creator) {
    cap.appendChild(document.createTextNode(en ? 'Photo: ' : 'Photo : '));
    if (url) cap.appendChild(creditLink(url, creator, 'article-media-credit__creator'));
    else cap.appendChild(document.createTextNode(creator));
    if (parsed.license) cap.appendChild(document.createTextNode(` / ${parsed.license}`));
    if (parsed.via) {
      cap.appendChild(document.createTextNode(' · '));
      cap.appendChild(document.createTextNode(parsed.via));
    }
    return cap;
  }

  const inline = credit.match(/^Photo\s*:\s*(.+)$/i);
  if (inline) {
    cap.appendChild(document.createTextNode(en ? 'Photo: ' : 'Photo : '));
    const label = cleanCreatorDisplay(inline[1].trim());
    if (url && label) cap.appendChild(creditLink(url, label, 'article-media-credit__creator'));
    else cap.appendChild(document.createTextNode(label));
    return cap;
  }

  if (url) cap.appendChild(creditLink(url, credit));
  else cap.textContent = credit;
  return cap;
}

function buildMediaCreditElement(item = {}) {
  const sourceUrl = String(item.imageSourceUrl || '').trim();
  const credit = String(item.imageCredit || '').trim();
  if (!credit && !sourceUrl) return null;

  const cap = document.createElement('figcaption');
  cap.className = 'article-media-credit';
  const en = item.lang === 'en';
  const parsed = credit ? parseImageCreditLine(credit) : null;
  const creator = cleanCreatorDisplay(item.imageCreator || parsed?.creator || '')
    || (en ? 'Unknown photographer' : 'Photographe inconnu');

  if (!parsed) {
    if (sourceUrl) {
      cap.appendChild(creditLink(sourceUrl, credit || (en ? 'Photo source' : 'Source de la photo')));
    } else {
      cap.textContent = credit;
    }
    return cap;
  }

  cap.appendChild(document.createTextNode(en ? 'Photo: ' : 'Photo : '));
  if (sourceUrl) {
    cap.appendChild(creditLink(sourceUrl, creator, 'article-media-credit__creator'));
  } else {
    cap.appendChild(document.createTextNode(creator));
  }
  if (parsed.license) {
    cap.appendChild(document.createTextNode(` / ${parsed.license}`));
  }
  if (parsed.via) {
    cap.appendChild(document.createTextNode(' · '));
    if (sourceUrl) {
      cap.appendChild(creditLink(sourceUrl, parsed.via, 'article-media-credit__source'));
    } else {
      cap.appendChild(document.createTextNode(parsed.via));
    }
  }
  return cap;
}

function showArticleImage(article, media, img, kind, item) {
  media.replaceChildren(img);
  let cap = null;
  if (kind === 'photo') {
    if (item?.sourceImageCredit) {
      cap = buildSourcePhotoCreditElement(item);
    } else if (item?.source) {
      // Photo source sans crédit scrapé (ex. La Pige en En bref) :
      // afficher au moins « Crédit photo : [média] » en attendant le bot.
      const en = item.lang === 'en';
      const mediaName = String(item.source).trim();
      cap = buildSourcePhotoCreditElement({
        ...item,
        sourceImageCredit: en ? `Photo credit: ${mediaName}` : `Crédit photo : ${mediaName}`,
        sourceImageCreditFrom: 'media',
        sourceImageCreditUrl: item.link || item.sourceImageCreditUrl || '',
      });
    }
  } else if ((kind === 'stock' || kind === 'fallback') && (item?.imageCredit || item?.imageSourceUrl)) {
    cap = buildMediaCreditElement(item);
  }
  if (cap) {
    media.appendChild(cap);
    media.removeAttribute('aria-hidden');
  }
  article.classList.add('has-image');
  article.classList.remove('article--text');
  if (kind === 'stock') article.classList.add('article--stock-image');
  else if (kind !== 'photo') article.classList.add('article--fallback-image');
  updateNewsLayout();
}

function dropArticleImage(article, media, role, item) {
  if (role === 'lead' && item && hasStockPhoto(item)) {
    const alt = resolveDisplayImage(item, { preferPhoto: false, role });
    if (alt.kind === 'stock' && alt.src) {
      const img = new Image();
      img.decoding = 'async';
      img.loading = 'eager';
      img.alt = '';
      img.onload = () => showArticleImage(article, media, img, 'stock', item);
      img.onerror = () => {
        media.remove();
        article.classList.add('article--text');
        updateNewsLayout();
      };
      img.src = displaySizedImageUrl(alt.src, role);
      return;
    }
  }
  media.remove();
  article.classList.add('article--text');
  updateNewsLayout();
}

function attachArticleImage(article, item, role) {
  const media = article.querySelector('.article-media');
  if (!media) return;
  article.__radarItem = item;

  const failToText = () => dropArticleImage(article, media, role, item);
  const allowFallback = role === 'lead';
  const isThumb = role === 'feature' || role === 'compact';

  const loadImage = (src, kind, allowRetry = true, { forceRaw = false } = {}) => {
    if (!src || (kind === 'fallback' && !allowFallback)) {
      failToText();
      return;
    }

    const displaySrc = forceRaw ? src : displaySizedImageUrl(src, role);
    const img = new Image();
    img.decoding = 'async';
    /* Pas de loading="lazy" ici : une Image() hors du DOM en lazy ne se
       charge jamais — le délai trop court la faisait basculer en mode texte. */
    if (role === 'lead') img.fetchPriority = 'high';
    img.alt = '';
    let settled = false;

    const settleShow = () => {
      if (settled) return;
      settled = true;
      showArticleImage(article, media, img, kind, item);
    };

    img.onload = () => {
      if (kind === 'photo' && !isUsableArticleImage(img, role)) {
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        // Vedette : on accepte une photo imparfaite plutôt que le vide.
        if (role === 'lead' && w >= 200 && h >= 150) {
          settleShow();
          return;
        }
        // En bref / vedettes : object-fit recadre — garder toute photo réelle.
        if (isThumb && w >= 120 && h >= 100) {
          settleShow();
          return;
        }
        if (allowRetry) {
          const alt = resolveDisplayImage(item, { preferPhoto: false, role });
          if (alt.src && alt.kind !== 'photo') {
            settled = true;
            loadImage(alt.src, alt.kind, false);
          } else {
            failToText();
          }
        } else {
          failToText();
        }
        return;
      }
      // Stock / campus / photo OK
      settleShow();
    };

    img.onerror = () => {
      if (settled) return;
      // Si l'URL redimensionnée échoue, retenter l'original une fois.
      if (!forceRaw && displaySrc !== src) {
        settled = true;
        loadImage(src, kind, allowRetry, { forceRaw: true });
        return;
      }
      if (allowRetry && (kind === 'photo' || kind === 'stock')) {
        const alt = resolveDisplayImage(item, { preferPhoto: kind !== 'photo', role });
        if (alt.src && alt.kind !== kind && alt.src !== src) {
          settled = true;
          loadImage(alt.src, alt.kind, false);
        } else {
          failToText();
        }
      } else {
        failToText();
      }
    };

    img.src = displaySrc;

    // Timeout : tenter une alternative, mais ne PAS jeter une image stock
    // encore en cours de chargement (Wikimedia 8K / réseau lent).
    const timeoutMs = isThumb ? 10000 : 6000;
    window.setTimeout(() => {
      if (settled || article.classList.contains('has-image') || !media.isConnected) return;
      if (!allowRetry) return;
      const alt = resolveDisplayImage(item, { preferPhoto: kind === 'photo', role });
      if (alt.src && alt.src !== src && alt.kind !== kind) {
        settled = true;
        loadImage(alt.src, alt.kind, false);
      }
      // Sinon on laisse onload/onerror finir — mieux qu'un vignette vide.
    }, timeoutMs);
  };

  const primary = resolveDisplayImage(item, { preferPhoto: true, role });
  loadImage(primary.src, primary.kind);
}

const LEAD_IMAGE_MIN = { width: 720, height: 405, pixels: 320000 };
const FEATURE_IMAGE_MIN = { width: 640, height: 360, pixels: 240000 };
/* Vignettes (vedettes + En bref) : affichées en ~100 px, on accepte des photos
   plus petites et des cadrages portrait — object-fit recadre de toute façon. */
const THUMB_IMAGE_MIN = { width: 200, height: 150, pixels: 40000 };

function isUsableArticleImage(img, role) {
  const width = img.naturalWidth || 0;
  const height = img.naturalHeight || 0;
  const ratio = width / Math.max(height, 1);
  const isThumb = role === 'feature' || role === 'compact';
  const min = role === 'lead' ? LEAD_IMAGE_MIN : (isThumb ? THUMB_IMAGE_MIN : FEATURE_IMAGE_MIN);
  // Vignettes : très tolérant (object-fit). Stock/campus passent sans ce filtre.
  const [ratioMin, ratioMax] = isThumb ? [0.4, 4.0] : [0.95, 2.6];
  return (
    width >= min.width
    && height >= min.height
    && width * height >= min.pixels
    && ratio >= ratioMin
    && ratio <= ratioMax
  );
}

const BYLINE_ARTICLE_STARTERS = /^(Le|La|Les|L'|L'|Un|Une|The|An|À|A)$/iu;

function editorialFallback(lang = 'fr') {
  return lang === 'en' ? 'The editorial team' : 'La rédaction';
}

function canonicalizeEditorialAuthor(name = '') {
  const a = String(name).replace(/^(?:Par|By)\s+/i, '').replace(/\s+/g, ' ').trim();
  if (/^(?:la\s+|l')\s*rédaction$/i.test(a) || /^redaction$/i.test(a)) return 'La rédaction';
  if (/^editorial\s+(?:team|staff|board)$/i.test(a) || /^the\s+editorial\s+team$/i.test(a)) {
    return 'The editorial team';
  }
  if (/^staff\s+writers?$/i.test(a)) return 'The editorial team';
  return '';
}

function resolveDisplayAuthor(item, rawAuthor = '') {
  return normalizeAuthor(rawAuthor || item.author || '')
    || editorialFallback(item.lang === 'en' ? 'en' : 'fr');
}

const CONTRIBUTOR_BYLINE_RE = /^([\p{Lu}][\p{L}'’.\-]+(?:\s+[\p{Lu}][\p{L}'’.\-]+){0,3})\s*[–—-]\s*(?:Contributor|Staff Writer)\b/iu;

function isJunkAuthorName(name = '') {
  const a = String(name).replace(/\s+/g, ' ').trim();
  if (!a || a.length < 2 || a.length > 80) return true;
  if (/^[,;:.]/.test(a) || /[,;]{2,}/.test(a)) return true;
  if (/\bfunction\s*\(/.test(a) || /[{}\[\]]/.test(a)) return true;
  if (/https?:\/\//i.test(a) || /\.(?:php|js|css)\b/i.test(a)) return true;
  if (/\b(?:wp-content|wp-admin|wp-block|prefetch|selector_matches|splide)\b/i.test(a)) return true;
  if (/\b(?:Recent Posts|Skip to content|Written by|Read more|Lire la suite)\b/i.test(a)) return true;
  if (a.split(/\s+/).length > 6) return true;
  return false;
}

function extractBylineFromExcerpt(excerpt = '') {
  const ex = String(excerpt).trim();
  if (/^(?:Par|By)\s+(?:(?:La|L')\s*)?[Rr]édaction\b/i.test(ex)) {
    return {
      author: 'La rédaction',
      body: ex.replace(/^(?:Par|By)\s+(?:(?:La|L')\s*)?[Rr]édaction\.?\s*/i, '').trim(),
    };
  }
  if (/^(?:Par|By)\s+Editorial\s+(?:team|staff|board)\b/i.test(ex)) {
    return {
      author: 'The editorial team',
      body: ex.replace(/^(?:Par|By)\s+Editorial\s+(?:team|staff|board)\.?\s*/i, '').trim(),
    };
  }

  const contributor = ex.match(CONTRIBUTOR_BYLINE_RE);
  if (contributor) {
    const author = normalizeAuthor(contributor[1]);
    const body = ex.slice(contributor[0].length).trim();
    if (author && body.length >= 8) return { author, body };
  }

  if (!/^(?:Par|By)\s+/i.test(ex)) return { author: '', body: ex };

  const tokens = ex.replace(/^\s*(?:Par|By)\s+/i, '').split(/\s+/);
  const nameParts = [];
  let i = 0;
  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (nameParts.length >= 1 && BYLINE_ARTICLE_STARTERS.test(token)) break;
    if (nameParts.length >= 2) break;
    if (/^[\p{Lu}][\p{L}'’.\-]+$/u.test(token)) nameParts.push(token);
    else break;
  }

  return {
    author: normalizeAuthor(nameParts.join(' ')),
    body: tokens.slice(i).join(' ').trim(),
  };
}

function extractFirstPersonAuthor(excerpt = '') {
  const plain = String(excerpt).trim();
  const m = plain.match(/^(?:Salut,?\s+)?moi,?\s+c['']est\s+([\p{Lu}][\p{L}'’.\-]+)/iu)
    || plain.match(/^je\s+m['']appelle\s+([\p{Lu}][\p{L}'’.\-]+)/iu);
  return m ? normalizeAuthor(m[1]) : '';
}

function splitByline(item) {
  const ex = String(item.excerpt || '');
  const fromExcerpt = extractBylineFromExcerpt(ex);
  let author = normalizeAuthor(item.author);
  let body = ex;

  if (fromExcerpt.author && (CONTRIBUTOR_BYLINE_RE.test(ex) || /^(?:Par|By)\s+/i.test(ex))) {
    author = fromExcerpt.author;
    body = fromExcerpt.body || body;
    return { author, body };
  }

  if (!author) {
    const firstPerson = extractFirstPersonAuthor(ex);
    if (firstPerson) author = firstPerson;
  }

  if (author) {
    const escaped = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const extended = new RegExp(
      `^\\s*(?:Par|By)\\s+${escaped}(?:\\s+[\\p{Lu}][\\p{L}'’.\\-]+)?(?=\\s+(?:Le|La|Les|L'|L’|Un|Une|À|A|The|An)\\s)`,
      'iu',
    );
    const known = new RegExp(`^\\s*(?:Par|By)\\s+${escaped}\\s*`, 'iu');
    if (extended.test(ex)) body = ex.replace(extended, '').trim();
    else if (known.test(ex)) body = ex.replace(known, '').trim();
  }

  return { author, body };
}

function normalizeAuthor(name = '') {
  let a = String(name).replace(/\s+/g, ' ').trim();
  a = a.replace(/^(?:Par|By)\s+/i, '').trim();
  const editorial = canonicalizeEditorialAuthor(a);
  if (editorial) return editorial;
  if (!a || GENERIC_AUTHORS.test(a) || /@/.test(a) || isJunkAuthorName(a)) return '';
  return a;
}

// ─── Date / time formatting (Québec) ────────────────────────────────────────────
function formatTime(d, lang = 'fr') {
  if (isNaN(d)) return '';
  if (lang === 'en') {
    return d.toLocaleTimeString('en-CA', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h} h ${m}`;
}

function formatCompactCalendarDate(d, lang = 'fr') {
  if (isNaN(d)) return '';
  if (lang === 'en') {
    return d.toLocaleDateString('en-CA', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  const months = MONTH_SHORT.fr;
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`.trim();
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

const MONTH_SHORT = {
  fr: ['jan.', 'fév.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
};

/** Date courte pour cartes compactes (En bref, Suite du fil). */
function formatStampCompact(d, lang = 'fr') {
  if (isNaN(d)) return '';
  const now = new Date();
  const diffMin = Math.round((now - d) / 60000);
  const l = lang === 'en' ? 'en' : 'fr';

  if (diffMin < 1) return l === 'en' ? 'just now' : "à l'instant";
  if (diffMin < 60) return l === 'en' ? `${diffMin} min ago` : `il y a ${diffMin} min`;

  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yest.toDateString();
  const clock = formatTime(d, l);

  if (sameDay) {
    if (l === 'en') return clock ? `Today, ${clock}` : 'Today';
    return clock ? `aujourd'hui, ${clock}` : "aujourd'hui";
  }
  if (isYesterday) {
    if (l === 'en') return clock ? `Yesterday, ${clock}` : 'Yesterday';
    return clock ? `hier, ${clock}` : 'hier';
  }

  return formatCompactCalendarDate(d, l);
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

/** Retire puces / symboles en tête, mais garde chiffres et lettres (« 14 bourses… »). */
function stripLeadingNonLetters(title = '') {
  return String(title).replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

/** Aligné sur scripts/html-entities-lib.js — inclut &eacute;, &ccedil;, etc. */
const NAMED_HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00A0', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201D', ldquo: '\u201C',
  laquo: '«', raquo: '»',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ',
  Ccedil: 'Ç', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  Iacute: 'Í', Igrave: 'Ì', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Oacute: 'Ó', Ograve: 'Ò', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Uacute: 'Ú', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
  oelig: 'œ', OElig: 'Œ',
};

function decodeNamedHtmlEntities(str = '') {
  return String(str).replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(NAMED_HTML_ENTITIES, name)
      ? NAMED_HTML_ENTITIES[name]
      : match
  ));
}

/** fromCodePoint sûr : couvre les caractères astraux (émojis) sans lever sur un code invalide. */
function safeFromCodePoint(code, fallback) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

function decodeHtmlEntities(str = '') {
  let s = String(str);
  for (let pass = 0; pass < 3; pass += 1) {
    const prev = s;
    s = s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&#(\d+);/g, (m, n) => safeFromCodePoint(parseInt(n, 10), m))
      .replace(/&#x([0-9a-f]+);/gi, (m, n) => safeFromCodePoint(parseInt(n, 16), m))
      .replace(/&#0?39;/gi, '’');
    s = decodeNamedHtmlEntities(s)
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
    if (s === prev) break;
  }
  return s;
}

function cleanTitle(title = '') {
  let t = decodeHtmlEntities(stripEmbeddedCss(title));
  t = t.replace(/\s+/g, ' ').trim();
  const prefix = t.match(MC_CATEGORY_PREFIX);
  if (prefix) t = t.slice(prefix[0].length).trim();
  t = stripLeadingNonLetters(t);
  // Titres doubles sans ponctuation (ex. « Magazines à potins En papier… »)
  return t.replace(
    /([\p{Ll}àâäéèêëïîôùûüç'’])\s+(En|Le|La|Les|L'|L'|Un|Une|The|A|An)\s+/gu,
    '$1 — $2 ',
  );
}

function stripLeadingByline(text = '', author = '') {
  if (!text || !author) return text;
  const escaped = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).replace(new RegExp(`^(?:Par|By)\\s+${escaped}\\s*`, 'iu'), '').trim();
}

function leadBriefSource(item) {
  const { author, body } = splitByline(item);
  const raw = String(item.leadExcerpt || '').trim()
    || body
    || String(item.excerpt || '');
  return stripLeadingByline(sanitizeBriefBody(raw), author);
}

function compactBriefSource(item) {
  const { author, body } = splitByline(item);
  return stripLeadingByline(sanitizeBriefBody(body || item.excerpt || ''), author);
}

function featureBriefSource(item) {
  /* Aligné sur la une : leadExcerpt en priorité. */
  return leadBriefSource(item);
}

function ensureFeatureBriefMinLines(brief, truncated, item) {
  return ensureLeadBriefMinLines(brief, truncated, item);
}

function ensureCompactBriefMinLines(brief, truncated, item) {
  const { author } = splitByline(item);
  brief = stripLeadingByline(brief, author);

  if (brief.length >= BRIEF_COMPACT_MIN_CHARS) {
    const full = compactBriefSource(item);
    if (full.length > brief.length + 12) truncated = true;
    return { text: brief, truncated };
  }

  const fallback = compactBriefSource(item);
  if (fallback.length > brief.length) {
    const extended = prepareBrief(fallback, 'compact');
    if (extended.text.length > brief.length) {
      brief = stripLeadingByline(extended.text, author);
      truncated = extended.truncated;
    }
  }
  if (fallback.length > brief.length + 12) truncated = true;
  return { text: brief, truncated };
}

function ensureLeadBriefMinLines(brief, truncated, item) {
  const { author } = splitByline(item);
  brief = stripLeadingByline(brief, author);

  if (brief.length >= LEAD_BRIEF_MIN_CHARS) {
    return { text: brief, truncated };
  }

  const fallback = leadBriefSource(item);
  if (fallback.length > brief.length) {
    const extended = prepareBrief(fallback, 'lead');
    if (extended.text.length > brief.length) {
      brief = stripLeadingByline(extended.text, author);
      truncated = extended.truncated;
    }
  }
  if (brief.length >= LEAD_BRIEF_MIN_CHARS) {
    return { text: brief, truncated };
  }

  const title = cleanTitle(item.title);
  const pieces = [];
  if (title.length > 8) pieces.push(title);
  if (fallback && !pieces.some((part) => part.includes(fallback.slice(0, 24)))) pieces.push(fallback);
  const inst = articleInstitutionLabel(item.institution, item.type);
  if (item.source) {
    const ctx = item.lang === 'en'
      ? `From ${item.source}${inst ? ` (${inst})` : ''}.`
      : `Dans ${item.source}${inst ? ` (${inst})` : ''}.`;
    pieces.push(ctx);
  }
  const combined = prepareBrief(pieces.join(' '), 'lead');
  if (combined.text.length > brief.length) {
    return {
      text: stripLeadingByline(combined.text, author),
      truncated: combined.truncated,
    };
  }
  return { text: brief, truncated };
}

function sanitizeBriefBody(raw = '') {
  let s = decodeHtmlEntities(String(raw));
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/\]\]>/g, '');
  s = s.replace(/\s*L['’]article\b[\s\S]*?est apparu en premier sur[\s\S]*$/i, '');
  const li = s.search(/\sL['’]article\s/);
  if (li > 30) s = s.slice(0, li);
  s = s.replace(/\[[^\]]*(?:read more|lire la suite|continue reading)[^\]]*\]/gi, '');
  s = s.replace(/\b(?:read more|lire la suite|continue reading)\b\.?\s*$/i, '');
  s = s.replace(/^(?:Dear Tribune|Dear Editor),?\s*/i, '');
  s = s.replace(/(?:…|\.{3,}|\[…\]|\[\.\.\.\]|\[&hellip;\])/gi, '');
  return s.replace(/\s+/g, ' ').trim();
}

function endsCompleteSentence(text = '') {
  return /[.!?»"')\]]\s*$/.test(String(text).trim());
}

function resolveBrief(item, body, role) {
  for (const raw of [body, String(item.excerpt || '')]) {
    const result = prepareBrief(raw, role);
    if (result.text) {
      if (role === 'compact') {
        const full = sanitizeBriefBody(raw);
        if (full.length > 95 || full.length > result.text.length + 12) {
          result.truncated = true;
        }
      }
      return result;
    }
  }
  return prepareBrief(cleanTitle(item.title), role);
}

function prepareBrief(raw = '', role = 'standard') {
  const limit = BRIEF_LIMITS[role] ?? 170;
  let s = sanitizeBriefBody(raw);
  if (!s || limit === 0 || s.length < 8) return { text: '', truncated: false };

  const minTruncMark = role === 'compact' ? 48 : 80;

  if (s.length <= limit) {
    const truncated = !endsCompleteSentence(s) && s.length >= minTruncMark;
    const text = s.replace(/[,;:\s]+$/u, '').trimEnd() || s;
    return { text, truncated };
  }

  let cut = s.slice(0, limit);
  const sentenceEnd = s.slice(limit).search(/[.!?»"')\]](?:\s|$)/);
  if (sentenceEnd >= 0 && sentenceEnd < 100) {
    cut = s.slice(0, limit + sentenceEnd + 1);
  } else {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > limit * 0.5) cut = cut.slice(0, lastSpace);
  }
  cut = cut.replace(/[,;:\s]+$/u, '').trimEnd();
  if (!cut) return { text: '', truncated: false };

  return { text: cut, truncated: true };
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
