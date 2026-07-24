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
/** Embed : panneau latéral « À l'antenne » masqué (voir embed.css @media max-width 639.98px). */
const TUNER_EMBED_NOWAIR_HIDDEN_MQ = window.matchMedia?.('(max-width: 639.98px)');
const TUNER_VOLUME   = document.getElementById('tuner-volume');
const TUNER_VOL      = document.getElementById('tuner-vol');
const TUNER_VOL_TOGGLE = document.getElementById('tuner-vol-toggle');
const TUNER_VOL_MUTE   = document.getElementById('tuner-vol-mute');
const VOL_COMPACT    = window.matchMedia('(max-width: 1099.98px)');
/** Embed étroit (iPhone) : la barre inline déborde du cadre → popover. */
const EMBED_VOL_POPOVER_MQ = window.matchMedia?.('(max-width: 559.98px)');
/** Embed iframe : volume en ligne, icône = mute (pas de popover) — sauf étroit. */
function isVolCompactMode() {
  if (IS_TUNER_EMBED) return !!EMBED_VOL_POPOVER_MQ?.matches;
  return VOL_COMPACT.matches;
}

/**
 * Embed étroit (pomo/solitaire mobile) : le panneau latéral est display:none,
 * donc l’antenne doit remonter dans la 2ᵉ ligne du dial + marquee.
 */
function isEmbedNowAirInDial() {
  return IS_TUNER_EMBED && !!TUNER_EMBED_NOWAIR_HIDDEN_MQ?.matches;
}
const TUNER_NOWAIR = document.getElementById('tuner-nowair');
const TUNER_NOWAIR_LABEL = TUNER_NOWAIR?.querySelector?.('.tuner-nowair-label') || null;
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
const NEWS_SEARCH       = document.getElementById('news-search');
const NEWS_SEARCH_TOGGLE = document.getElementById('news-search-toggle');
const NEWS_SEARCH_PANEL  = document.getElementById('news-search-panel');
const NEWS_SEARCH_INPUT  = document.getElementById('news-search-input');
const NEWS_SEARCH_CLEAR  = document.getElementById('news-search-clear');
const NEWS_SEARCH_HINT   = document.getElementById('news-search-hint');
const TODAY_DATE     = document.getElementById('today-date');
const MASTHEAD_WEATHER = document.getElementById('masthead-weather');
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
/** Recherche locale (titre / auteur / source / extrait / crédits) — jamais de fetch distant. */
let newsSearchQuery = '';
let newsSearchOpen = false;
let newsSearchDebounce = null;
let currentStation = null; // radio object selected in tuner
/** Another same-origin tab/page owns the real audio (Phase 1 multi-page sync). */
let syncRemotePlaying = false;
let audio = null;
// Lecture demandée, mais aucun son confirmé par l'événement `playing`.
let isBuffering = false;
let bufferingSafetyTimer = null;
let suppressAudioError = false;
// Amplification optionnelle via Web Audio : permet de dépasser 100 % pour les
// flux trop faibles (ex. CKUT). Les postes sans en-tête CORS ne peuvent pas être
// amplifiés ; on retombe alors en lecture native plafonnée à 100 %.
// UI 0–200 % sur tous les appareils qui supportent Web Audio. Sur mobile, le
// graphe n'est branché qu'au-dessus de 100 % afin de garder la lecture native
// (plus fiable à l'écran verrouillé) pour le cas courant ≤ 100 %.
let audioCtx = null;
let gainNode = null;
let compressorNode = null;
let analyserNode = null;
let mediaSource = null;
let boostWired = false;             // graphe Web Audio branché sur l'élément courant
let boostCtxLifecycleBound = false;  // listeners visibility/focus pour reprendre l'AudioContext
let webAudioSupported = !!(window.AudioContext || window.webkitAudioContext);
// Stratégie de persistance d'écoute (Media Session, reconnexion, keepalive iOS).
const MOBILE_PLAYBACK = window.matchMedia('(hover: none) and (pointer: coarse)').matches
  || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
// iOS (y compris iPadOS qui se présente comme macOS) : `audio.volume` est en
// lecture seule — seul le gain Web Audio permet de régler le niveau.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let userPaused = false;
let mobilePlayback = null;
const playerListenersAttached = new WeakSet();
// 100 % est la référence commune : le volume ne doit pas sembler réduit au
// premier chargement, quel que soit le contexte (site, Pomo ou Solitaire).
const DEFAULT_GAIN = 1;
let currentGain = DEFAULT_GAIN;
let volumeMuted = false;
let gainBeforeMute = DEFAULT_GAIN;
const MAX_GAIN = 2;                 // jusqu'à 200 %
const VOLUME_PREF_VERSION_KEY = 'req-player-vol-version';
const VOLUME_PREF_VERSION = '3';
const STATION_TRIMS_KEY = 'req-player-station-trims-v1';
const stationTrims = new Map();
let loudnessProbeTimer = null;
let loudnessProbeStationId = null;
// Curseur 0–200 % dès que Web Audio existe — y compris mobile / tablette.
const GAIN_UI_MAX = webAudioSupported ? MAX_GAIN : 1;
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
let lastNowAir = { title: null, sub: null, empty: null, previewId: null, kind: null, stationId: null };
let tunerSubMeta = '';
let tunerSubAirText = '';
let tunerSubRotateTimer = null;
let tunerSubRotateShowAir = false;
/** CHOQ : alterne piste en cours ↔ émission à venir (musique libre + grille). */
let choqAirRotateTimer = null;
let choqAirRotateShowUpcoming = false;
/** Demander un fondu sur le prochain render (CHOQ ou changement de poste). */
let nowAirCrossfadePending = false;
/** Incrémenté à chaque fondu pour annuler les timeouts obsolètes. */
let nowAirFadeGen = 0;
// L’iframe du Pomodoro est un espace de concentration : laisser chaque
// station / émission lisible plus longtemps avant de passer à la suivante.
// La page Radar conserve son rythme plus vif.
const TUNER_SUB_ROTATE_MS = IS_TUNER_EMBED ? 14000 : 8000;
const TUNER_SUB_ROTATE_NARROW_MS = 14000;
const TUNER_SUB_ROTATE_VERY_NARROW_MS = 18000;
const CHOQ_AIR_ROTATE_MS = 8000;
const NOW_AIR_CROSSFADE_MS = 700;
const PREFERS_REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)');
let sourceColors = {};     // source name → accent colour
let brandColors = { institutions: {}, fallback_palette: ['#003DA5', '#6C2163', '#047857'] };
let filtersExpanded = false;
/** Suite du fil : repli après NEWS_TAIL_VISIBLE articles (toutes plateformes). */
let newsTailExpanded = false;
const NEWS_TAIL_VISIBLE = 10;
/**
 * Rangée « peek » sous le fondu (titres partiels avant « Plus d'articles »).
 * 2 = max colonnes de la grille (.news-tail-body ≥ 600 px) — ces cartes
 * restent en is-tail-overflow (hors max-height) mais doivent être traduites.
 */
const NEWS_TAIL_PEEK_TRANSLATE = 2;
let volSliderResizeObs = null;
const marqueeTextByEl = new WeakMap();
const marqueeObservedEls = new WeakSet();
let marqueeResizeObs = null;
let marqueeResizeScheduled = false;
let filterMarqueeResyncTimer = null;
const FILTER_MARQUEE_RESYNC_MS = 480;

/** Rangées visibles avant « Plus de sources » — desktop 3 ; tablette/mobile 2. */
// Ordinateur + tablette paysage : 1 rangée (le reste via « Plus de sources »).
// Tablette / téléphone en portrait : 2 rangées pour ne pas trop cacher.
const FILTERS_COLLAPSED_ROWS_DESKTOP = 1;
const FILTERS_COLLAPSED_ROWS_COMPACT = 2;
const FILTERS_COMPACT_MQ = window.matchMedia(
  '(max-width: 1099.98px) and (orientation: portrait)',
);
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
  // Les constantes météo sont déclarées plus bas dans ce script : microtask
  // = après l'évaluation complète du fichier, sans retarder le reste du site.
  queueMicrotask(() => { void initMastheadWeather(); });
  setupAudio();
  bindTuner();
  bindExternalListen();
  bindFiltersPanel();
  bindNewsSearch();

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
  // Antenne tout de suite (grilles + nowplaying déjà là) pour stabiliser le
  // layout du synthé — pas d'attente des APIs live, qui ne font qu'affiner.
  renderTunerNowAir();
  // API live navigateur (CISM…) : second passage quand dispo.
  refreshStationLiveApis().finally(() => {
    renderTunerNowAir();
  });
  startNowAirTick();
  restoreVolume();
  initPlayerSync();
  registerServiceWorker();
}

/**
 * Phase 1 — multi-page / multi-tab player sync (same origin).
 * Leader owns <audio>; followers mirror station + play UI and yield on claim.
 */
function initPlayerSync() {
  const Sync = window.RadarPlayerSync;
  if (!Sync) return;

  Sync.init({
    onYield() {
      // Another context is taking the stream — free the audio device here.
      softStopLocalAudio({ clearRemoteFlag: false });
      syncRemotePlaying = true;
      updatePlayUI();
    },
    onRemoteState(state) {
      if (!state || Sync.isApplyingRemote?.()) {
        /* still apply — guard is set by Sync around this call */
      }

      // Volume (shared preference)
      if (Number.isFinite(state.volume) && Math.abs(state.volume - currentGain) > 0.005) {
        currentGain = state.volume;
        if (TUNER_VOLUME) TUNER_VOLUME.value = String(currentGain);
        applyGain();
        updateVolumeSliderVisual?.();
        updateVolumeAria?.();
      }

      // Station UI without starting local audio
      if (state.stationId && state.stationId !== currentStation?.id) {
        const exists = radios.some((r) => r.id === state.stationId);
        if (exists) {
          selectStation(state.stationId, {
            autoplay: false,
            openExternal: false,
            fromSync: true,
          });
        }
      }

      const iAmLeader = Sync.isLeader(state);

      if (state.playing && !iAmLeader) {
        softStopLocalAudio({ clearRemoteFlag: false });
        syncRemotePlaying = true;
        userPaused = false;
        updatePlayUI();
        return;
      }

      if (!state.playing) {
        const wasRemote = syncRemotePlaying;
        syncRemotePlaying = false;
        if (!iAmLeader && wasRemote) {
          // Global pause from another tab — keep station, show ▶
          updatePlayUI();
        } else if (iAmLeader && audio && !audio.paused) {
          // Unusual: we think we're leader but state says paused — trust local
          updatePlayUI();
        } else {
          updatePlayUI();
        }
      } else if (state.playing && iAmLeader) {
        syncRemotePlaying = false;
        // If we just became leader via our own claim, play() is already running.
        // If state was restored and we're leader of a dead tab id, tab ids never match
        // after reload — so this branch is only for live leaders.
        updatePlayUI();
      }
    },
  });

  // Hydrate from last session (other tab or previous page)
  const boot = Sync.readState();
  if (boot) {
    if (Number.isFinite(boot.volume)) {
      currentGain = boot.volume;
      if (TUNER_VOLUME) TUNER_VOLUME.value = String(currentGain);
      applyGain();
    }

    if (boot.stationId && radios.some((r) => r.id === boot.stationId)) {
      selectStation(boot.stationId, {
        autoplay: false,
        openExternal: false,
        fromSync: true,
      });
    }

    if (boot.playing) {
      // Phase 2a: best-effort resume if this tab already had a play gesture (session armed).
      // Otherwise mirror "en lecture ailleurs" until the user hits ▶.
      syncRemotePlaying = true;
      updatePlayUI();
      scheduleSessionResume(boot);
    }
  }

  // bfcache / back-forward: try to continue after page restore
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    const s = Sync.readState();
    if (s?.playing) scheduleSessionResume(s, { fromBfcache: true });
  });
}

const PLAYER_ARMED_KEY = 'req-player-armed';

function isPlayerSessionArmed() {
  try {
    return sessionStorage.getItem(PLAYER_ARMED_KEY) === '1';
  } catch {
    return false;
  }
}

function armPlayerSession() {
  try {
    sessionStorage.setItem(PLAYER_ARMED_KEY, '1');
  } catch { /* private mode */ }
  document.documentElement.dataset.radarPlaying = '1';
}

function disarmPlayerSessionPlayingFlag() {
  document.documentElement.dataset.radarPlaying = '0';
}

/**
 * Phase 2a — try to resume stream after same-tab navigation / bfcache.
 * Only if sessionStorage is armed (user already pressed play in this tab).
 * Never steals from a live peer: brief wait for yield/state, then claim+play.
 */
let sessionResumeTimer = null;
function scheduleSessionResume(boot, { fromBfcache = false } = {}) {
  if (sessionResumeTimer) {
    clearTimeout(sessionResumeTimer);
    sessionResumeTimer = null;
  }
  if (!boot?.playing || !boot.stationId) return;
  if (!isPlayerSessionArmed() && !fromBfcache) {
    // Cold tab (no prior gesture here): stay as follower UI only.
    return;
  }

  // Let BroadcastChannel peers announce themselves first.
  sessionResumeTimer = window.setTimeout(() => {
    sessionResumeTimer = null;
    trySessionResume(boot);
  }, fromBfcache ? 40 : 120);
}

async function trySessionResume(boot) {
  const Sync = window.RadarPlayerSync;
  if (!Sync || !boot?.stationId) return;
  if (userPaused) return;
  // Another live leader already pushed remote state — do not steal.
  if (syncRemotePlaying && isPlaying()) return;
  if (isPlaying()) return;

  const radio = radios.find((r) => r.id === boot.stationId);
  if (!radio || !getPlayableStream(radio)) {
    syncRemotePlaying = true;
    updatePlayUI();
    return;
  }

  // If a peer just claimed leadership after our hello, onRemoteState set syncRemotePlaying.
  // Only resume when we still look like the orphaned "playing" session (dead leader id).
  const live = Sync.readState();
  if (live && live.playing && live.leaderId && live.leaderId !== Sync.getTabId()) {
    // Peer may still be alive — wait: if we never got yield, they might be dead.
    // Attempt resume only when armed (same tab nav) — claimPlay will yield a live peer (OK: user moved here).
    if (!isPlayerSessionArmed()) {
      syncRemotePlaying = true;
      updatePlayUI();
      return;
    }
  }

  syncRemotePlaying = false;
  try {
    await play(radio);
    if (!isPlaying()) {
      syncRemotePlaying = true;
      updatePlayUI();
    }
  } catch {
    syncRemotePlaying = true;
    updatePlayUI();
  }
}

/** Pause local media without publishing pause (used when yielding leadership). */
function softStopLocalAudio({ clearRemoteFlag = true } = {}) {
  mobilePlayback?.onPlayStop?.();
  setBuffering(false);
  if (audio) {
    suppressAudioError = true;
    try { audio.pause(); } catch { /* */ }
    suppressAudioError = false;
  }
  if (clearRemoteFlag) syncRemotePlaying = false;
}

/**
 * Un flux LIVE peut ne jamais répondre (ou une page suiveuse peut recevoir un
 * événement tardif). Le bouton ne doit alors jamais rester en boucle : il
 * redevient un bouton lecture après un court délai, toujours annulable avant.
 */
function setBuffering(next) {
  isBuffering = !!next;
  if (bufferingSafetyTimer) {
    clearTimeout(bufferingSafetyTimer);
    bufferingSafetyTimer = null;
  }
  if (isBuffering) {
    bufferingSafetyTimer = setTimeout(() => {
      bufferingSafetyTimer = null;
      if (!isBuffering) return;
      isBuffering = false;
      updatePlayUI();
    }, 12_000);
  }
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
  // Icône = action (ce qu’on active au clic), pas l’état courant :
  // sombre → soleil (passer en clair) ; clair → lune (passer en sombre).
  THEME_TOGGLE?.querySelector('.ico-sun')?.classList.toggle('hidden', !isDark);
  THEME_TOGGLE?.querySelector('.ico-moon')?.classList.toggle('hidden', isDark);
  if (THEME_TOGGLE) {
    const label = isDark ? 'Passer en mode clair' : 'Passer en mode sombre';
    THEME_TOGGLE.setAttribute('aria-label', label);
    THEME_TOGGLE.setAttribute('title', label);
  }
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

// ─── Météo des principaux campus (desktop / tablette) ────────────────────────
const WEATHER_CACHE_KEY = 'le_radar_masthead_weather_v2';
const WEATHER_CACHE_MS = 15 * 60 * 1000;
const WEATHER_CITIES = [
  { id: 'montreal', name: 'Montréal', compactName: 'MTL', lat: 45.5017, lon: -73.5673 },
  { id: 'quebec', name: 'Québec', compactName: 'QC', lat: 46.8139, lon: -71.2080 },
  { id: 'sherbrooke', name: 'Sherbrooke', lat: 45.4000, lon: -71.9000 },
  { id: 'trois-rivieres', name: 'Trois-Rivières', lat: 46.3432, lon: -72.5430 },
  { id: 'saguenay', name: 'Saguenay', lat: 48.4284, lon: -71.0680 },
  // Saguenay–Lac-Saint-Jean : la météo de Chicoutimi ne résume pas le Lac.
  { id: 'alma', name: 'Alma', region: 'Saguenay–Lac-Saint-Jean', lat: 48.5500, lon: -71.6500 },
  { id: 'roberval', name: 'Roberval', region: 'Saguenay–Lac-Saint-Jean', lat: 48.5200, lon: -72.2300 },
  { id: 'dolbeau-mistassini', name: 'Dolbeau-Mistassini', region: 'Saguenay–Lac-Saint-Jean', lat: 48.8800, lon: -72.2300 },
  { id: 'saint-felicien', name: 'Saint-Félicien', region: 'Saguenay–Lac-Saint-Jean', lat: 48.6500, lon: -72.4500 },
  { id: 'rimouski', name: 'Rimouski', lat: 48.4488, lon: -68.5230 },
  { id: 'riviere-du-loup', name: 'Rivière-du-Loup', region: 'Bas-Saint-Laurent', lat: 47.8300, lon: -69.5300 },
  { id: 'matane', name: 'Matane', region: 'Bas-Saint-Laurent', lat: 48.8500, lon: -67.5300 },
  { id: 'baie-comeau', name: 'Baie-Comeau', region: 'Côte-Nord', lat: 49.2200, lon: -68.1500 },
  { id: 'sept-iles', name: 'Sept-Îles', region: 'Côte-Nord', lat: 50.2000, lon: -66.3800 },
  { id: 'fermont', name: 'Fermont', region: 'Côte-Nord', lat: 52.7900, lon: -67.0800 },
  { id: 'gaspe', name: 'Gaspé', region: 'Gaspésie–Îles-de-la-Madeleine', lat: 48.8300, lon: -64.4800 },
  { id: 'carleton-sur-mer', name: 'Carleton-sur-Mer', region: 'Gaspésie–Îles-de-la-Madeleine', lat: 48.1000, lon: -66.1300 },
  { id: 'sainte-anne-des-monts', name: 'Sainte-Anne-des-Monts', region: 'Gaspésie–Îles-de-la-Madeleine', lat: 49.1200, lon: -66.4900 },
  { id: 'cap-aux-meules', name: 'Cap-aux-Meules', region: 'Gaspésie–Îles-de-la-Madeleine', lat: 47.3800, lon: -61.8600 },
  { id: 'shawinigan', name: 'Shawinigan', region: 'Mauricie', lat: 46.5400, lon: -72.7500 },
  { id: 'la-tuque', name: 'La Tuque', region: 'Mauricie', lat: 47.4400, lon: -72.7800 },
  { id: 'drummondville', name: 'Drummondville', region: 'Centre-du-Québec', lat: 45.8800, lon: -72.4800 },
  { id: 'victoriaville', name: 'Victoriaville', region: 'Centre-du-Québec', lat: 46.0500, lon: -71.9600 },
  { id: 'saint-georges', name: 'Saint-Georges', region: 'Chaudière-Appalaches', lat: 46.1200, lon: -70.6700 },
  { id: 'thetford-mines', name: 'Thetford Mines', region: 'Chaudière-Appalaches', lat: 46.0900, lon: -71.3000 },
  { id: 'maniwaki', name: 'Maniwaki', region: 'Outaouais', lat: 46.3800, lon: -75.9700 },
  { id: 'chibougamau', name: 'Chibougamau', region: 'Nord-du-Québec', lat: 49.9200, lon: -74.3700 },
  { id: 'gatineau', name: 'Gatineau', lat: 45.4765, lon: -75.7013 },
  { id: 'rouyn-noranda', name: 'Rouyn-Noranda', lat: 48.2366, lon: -79.0231 },
  // Abitibi–Témiscamingue : plusieurs pôles distincts plutôt qu'une seule ville.
  { id: 'val-dor', name: 'Val-d’Or', region: 'Abitibi–Témiscamingue', lat: 48.1000, lon: -77.7800 },
  { id: 'amos', name: 'Amos', region: 'Abitibi–Témiscamingue', lat: 48.5700, lon: -78.1200 },
  { id: 'la-sarre', name: 'La Sarre', region: 'Abitibi–Témiscamingue', lat: 48.8000, lon: -79.2000 },
  { id: 'ville-marie', name: 'Ville-Marie', region: 'Abitibi–Témiscamingue', lat: 47.3300, lon: -79.4300 },
  { id: 'levis', name: 'Lévis', lat: 46.8033, lon: -71.1779 },
  // Vaudreuil–Soulanges est représentée par la ville centre sur MétéoMédia.
  { id: 'vaudreuil-soulanges', name: 'Vaudreuil–Soulanges', region: 'Vaudreuil–Soulanges', lat: 45.4000, lon: -74.0300, weatherSlug: 'vaudreuil-dorion' },
  { id: 'saint-ignace-de-loyola', name: 'Saint-Ignace-de-Loyola', region: 'Lanaudière', lat: 46.0800, lon: -73.0200 },
  // Une collectivité représentative par nation : il n'existe pas de capitale
  // unique pour les nations composées de plusieurs communautés.
  { id: 'odanak', name: 'Odanak', nation: 'Abénakis', lat: 46.0723, lon: -72.8181, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/odanak-12/actuelle' },
  { id: 'kitigan-zibi', name: 'Kitigan Zibi', nation: 'Anicinabeg', lat: 46.3825, lon: -75.9879, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/kitigan-zibi/actuelle' },
  { id: 'manawan', name: 'Manawan', nation: 'Atikamekw', lat: 47.2203, lon: -74.3822, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/manouane/actuelle' },
  { id: 'nemaska', name: 'Nemaska', nation: 'Eeyou', lat: 51.2022, lon: -76.1906, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/nemaska/actuelle' },
  { id: 'wendake', name: 'Wendake', nation: 'Wendat', lat: 46.8550, lon: -71.3567, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/wendake/actuelle' },
  { id: 'uashat', name: 'Uashat mak Mani-Utenam', nation: 'Innu', lat: 50.2300, lon: -66.3800, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/uashat/actuelle' },
  { id: 'kuujjuaq', name: 'Kuujjuaq', nation: 'Inuit · Nunavik', lat: 58.1000, lon: -68.4200, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/kuujjuaq/actuelle' },
  { id: 'cacouna', name: 'Cacouna', nation: 'Wolastoqiyik', lat: 47.9204, lon: -69.5147, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/cacouna/actuelle' },
  { id: 'gesgapegiag', name: 'Gesgapegiag', nation: 'Mi’gmaq', lat: 48.2125, lon: -65.9961, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/gesgapegiag-2/actuelle' },
  { id: 'kahnawake', name: 'Kahnawà:ke', nation: 'Kanien’kehà:ka', lat: 45.4000, lon: -73.7500, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/kahnawake-14/actuelle' },
  { id: 'kawawachikamach', name: 'Kawawachikamach', nation: 'Naskapi', lat: 55.3400, lon: -66.8500, weatherUrl: 'https://www.meteomedia.com/fr/ville/ca/quebec/kawawachikamach/actuelle' },
];

// Radar principal : variante remplie et animée. Le Pomo pointe explicitement
// vers /assets/meteocons/ pour rester statique et discret.
const METEOCONS_BASE = '/assets/meteocons/animated/';
function weatherIcon(code, isDay = 1) {
  const day = !!isDay;
  let name = day ? 'overcast-day' : 'overcast-night';
  if (code === 0) name = day ? 'clear-day' : 'clear-night';
  else if ([1, 2].includes(code)) name = day ? 'partly-cloudy-day' : 'partly-cloudy-night';
  else if ([45, 48].includes(code)) name = day ? 'fog-day' : 'fog-night';
  else if ([51, 53, 55, 56, 57].includes(code)) name = 'drizzle';
  else if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) name = 'rain';
  else if ([71, 73, 75, 77, 85, 86].includes(code)) name = 'snow';
  else if ([95, 96, 99].includes(code)) name = day ? 'thunderstorms-day' : 'thunderstorms-night';
  return `<img class="weather-icon-meteocon" src="${METEOCONS_BASE}${name}.svg" alt="" aria-hidden="true">`;
}

function weatherTone(code) {
  if (code === 0 || [1, 2].includes(code)) return 'sun';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([95, 96, 99].includes(code)) return 'storm';
  return 'cloud';
}

let mastheadWeatherTimer = null;
const mastheadWeatherDecks = { campus: [], nation: [] };
let mastheadWeatherSlots = [];
let mastheadWeatherNextSlot = 0;
// La carte principale reste exclusivement réservée à Montréal et Québec.
const MASTHEAD_WEATHER_PRIMARY_SEQUENCE = ["montreal", "quebec"];
const MASTHEAD_WEATHER_PRIMARY_IDS = new Set(MASTHEAD_WEATHER_PRIMARY_SEQUENCE);
// Les cartes régionales suivent l’importance démographique universitaire.
const MASTHEAD_WEATHER_REGIONAL_PRIORITY = [
  "sherbrooke", "trois-rivieres", "gatineau", "saguenay",
  "rimouski", "rouyn-noranda",
];
const MASTHEAD_WEATHER_REGIONAL_RANK = new Map(
  MASTHEAD_WEATHER_REGIONAL_PRIORITY.map((id, index) => [id, index]),
);
let mastheadWeatherPrimaryIndex = 0;
let mastheadWeatherCompactSecondaryIndex = 0;
let mastheadWeatherNationSlot = 1;
let mastheadWeatherLastBoardCount = 0;
let mastheadWeatherFitCount = null;
let mastheadWeatherTooNarrow = false;
let mastheadWeatherResizeFrame = 0;

function weatherLocationSlug(city) {
  return String(city.weatherSlug || city.name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2019\u0027`]/g, "")
    .replace(/[–—]/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-").filter(Boolean).join("-");
}

function weatherForecastUrl(city) {
  if (city.weatherUrl) return city.weatherUrl;
  return "https://www.meteomedia.com/fr/ville/ca/quebec/" + weatherLocationSlug(city) + "/actuelle";
}

function weatherForecastProvider() {
  return "MétéoMédia";
}

function refreshMastheadWeatherLinks() {
  if (!MASTHEAD_WEATHER) return;
  WEATHER_CITIES.forEach((city) => {
    const el = MASTHEAD_WEATHER.querySelector(`[data-weather-city="${city.id}"]`);
    if (el) el.href = weatherForecastUrl(city);
  });
}

function buildMastheadWeatherBoard() {
  const board = MASTHEAD_WEATHER?.querySelector('.masthead-weather__board');
  if (!board || board.children.length) return;
  const fragment = document.createDocumentFragment();
  WEATHER_CITIES.forEach((city) => {
    const el = document.createElement('a');
    el.className = 'masthead-weather__city';
    el.dataset.weatherCity = city.id;
    el.dataset.weatherGroup = city.nation ? 'nation' : 'campus';
    el.setAttribute('aria-hidden', 'true');
    const context = city.nation ? `${city.name} — ${city.nation}` : city.name;
    el.href = weatherForecastUrl(city);
    el.target = '_blank';
    el.rel = 'noopener noreferrer';
    const provider = weatherForecastProvider(city);
    el.title = `Prévisions de ${provider} — ${context}`;
    el.setAttribute("aria-label", `Prévisions de ${provider} pour ${context}`);
    el.innerHTML = '<span class="masthead-weather__icon" aria-hidden="true">·</span><span class="masthead-weather__name"><span class="masthead-weather__name-text"><span class="masthead-weather__name-full"></span><span class="masthead-weather__name-compact" aria-hidden="true"></span></span></span><span class="masthead-weather__temp">—</span>';
    el.querySelector('.masthead-weather__name-full').textContent = city.name;
    el.querySelector('.masthead-weather__name-compact').textContent = city.compactName || city.name;
    fragment.append(el);
  });
  board.append(fragment);
}

function weatherBoardCount() {
  const width = MASTHEAD_WEATHER?.querySelector('.masthead-weather__board')?.clientWidth || 0;
  let count = 1;
  if (width >= 600) count = 4;
  else if (width >= 500) count = 3;
  // Sur téléphone, la première carte reste exclusivement Montréal/Québec.
  // La seconde disparaît avant que cette carte principale doive défiler.
  else if (width >= 280) count = 2;
  return mastheadWeatherFitCount === null ? count : Math.min(count, mastheadWeatherFitCount);
}

function nextWeatherCity(group, usedIds) {
  const eligible = WEATHER_CITIES.filter((city) => {
    if (usedIds.has(city.id)) return false;
    if (group === 'nation') return !!city.nation;
    return !city.nation && !MASTHEAD_WEATHER_PRIMARY_IDS.has(city.id);
  });
  if (!eligible.length) return null;
  let deck = mastheadWeatherDecks[group];
  deck = deck.filter((city) => eligible.some((candidate) => candidate.id === city.id));
  if (!deck.length) {
    if (group === 'nation') {
      deck = shuffleWeatherCities(eligible);
    } else {
      const priority = eligible
        .filter((city) => MASTHEAD_WEATHER_REGIONAL_RANK.has(city.id))
        .sort((a, b) => MASTHEAD_WEATHER_REGIONAL_RANK.get(a.id) - MASTHEAD_WEATHER_REGIONAL_RANK.get(b.id));
      const remaining = eligible.filter((city) => !MASTHEAD_WEATHER_REGIONAL_RANK.has(city.id));
      // Les deux premiers pôles universitaires restent prioritaires; ensuite,
      // les villes régionales sont brassées pour éviter une séquence figée.
      deck = [...priority.slice(0, 2), ...shuffleWeatherCities([...priority.slice(2), ...remaining])];
    }
  }
  const city = deck.shift();
  mastheadWeatherDecks[group] = deck;
  return city;
}

function shuffleWeatherCities(cities) {
  const shuffled = [...cities];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function weatherSecondaryGroup(slot, count) {
  if (count > 2) return slot === mastheadWeatherNationSlot ? 'nation' : 'campus';
  if (slot !== 1) return 'campus';
  return mastheadWeatherCompactSecondaryIndex % 3 === 2 ? 'nation' : 'campus';
}

function showMastheadWeatherBoard() {
  if (!MASTHEAD_WEATHER) return;
  if (mastheadWeatherTooNarrow) {
    MASTHEAD_WEATHER.classList.add('is-too-narrow');
    return;
  }
  MASTHEAD_WEATHER.classList.remove('is-too-narrow');
  const cities = [...MASTHEAD_WEATHER.querySelectorAll('.masthead-weather__city')];
  if (!cities.length) return;
  const count = Math.min(weatherBoardCount(), cities.length);
  if (count !== mastheadWeatherLastBoardCount) {
    mastheadWeatherNationSlot = count > 2 ? 1 + Math.floor(Math.random() * (count - 1)) : 1;
    // Les groupes de cartes changent avec la largeur : on conserve l'ancre
    // Montréal/Québec, puis on remplit les autres positions selon la nouvelle règle.
    mastheadWeatherSlots = mastheadWeatherSlots.slice(0, 1);
    mastheadWeatherLastBoardCount = count;
  }
  MASTHEAD_WEATHER.querySelector('.masthead-weather__board')?.setAttribute('data-weather-count', String(count));
  mastheadWeatherSlots = mastheadWeatherSlots.slice(0, count);
  const anchor = WEATHER_CITIES.find(
    (city) => city.id === MASTHEAD_WEATHER_PRIMARY_SEQUENCE[mastheadWeatherPrimaryIndex],
  );
  if (anchor && mastheadWeatherSlots[0]?.id !== anchor.id) mastheadWeatherSlots[0] = anchor;
  const usedIds = new Set(mastheadWeatherSlots.map((city) => city.id));
  while (mastheadWeatherSlots.length < count) {
    const slot = mastheadWeatherSlots.length;
    const city = slot === 0
      ? anchor
      : nextWeatherCity(weatherSecondaryGroup(slot, count), usedIds);
    if (!city) break;
    usedIds.add(city.id);
    mastheadWeatherSlots.push(city);
  }
  cities.forEach((city) => {
    city.classList.remove('is-active');
    city.setAttribute('aria-hidden', 'true');
  });
  mastheadWeatherSlots.forEach((selectedCity, slot) => {
    const city = MASTHEAD_WEATHER.querySelector(`[data-weather-city="${selectedCity.id}"]`);
    city?.classList.add('is-active');
    if (city) city.style.order = String(slot);
    city?.setAttribute('aria-hidden', 'false');
  });
  refreshWeatherNameScroll();
  const primary = MASTHEAD_WEATHER.querySelector('.masthead-weather__city.is-active[data-weather-city="montreal"], .masthead-weather__city.is-active[data-weather-city="quebec"]');
  const primaryViewport = primary?.querySelector('.masthead-weather__name');
  if (!primary || !primaryViewport || primary.clientWidth < 1 || primaryViewport.clientWidth < 1) return;
  primary.classList.remove('is-compact');
  let primaryOverflows = primaryViewport.scrollWidth > primaryViewport.clientWidth + 2;
  if (primaryOverflows) {
    // Le seuil dépend de l'espace réel entre date et actions, pas du viewport.
    // MTL/QC est la dernière forme compacte avant de retirer le bandeau.
    primary.classList.add('is-compact');
    primaryOverflows = primaryViewport.scrollWidth > primaryViewport.clientWidth + 2;
  }
  if (!primaryOverflows) return;
  if (count > 1) {
    // Retirer une carte secondaire et réévaluer la carte prioritaire à sa taille réelle.
    mastheadWeatherFitCount = count - 1;
    mastheadWeatherLastBoardCount = 0;
    mastheadWeatherSlots = [];
    showMastheadWeatherBoard();
    return;
  }
  // Même seule, la carte ne peut pas afficher ville, icône et température proprement.
  mastheadWeatherTooNarrow = true;
  MASTHEAD_WEATHER.classList.add('is-too-narrow');
}

function refreshWeatherNameScroll() {
  MASTHEAD_WEATHER?.querySelectorAll('.masthead-weather__city.is-active').forEach((el) => {
    const viewport = el.querySelector('.masthead-weather__name');
    const name = el.querySelector('.masthead-weather__name-text');
    const overflow = Math.max(0, name.scrollWidth - viewport.clientWidth);
    const isPrimary = MASTHEAD_WEATHER_PRIMARY_IDS.has(el.dataset.weatherCity);
    // Montréal et Québec ne défilent jamais : la grille réduit plutôt le nombre
    // de cartes quand l'espace devient insuffisant.
    el.classList.toggle('is-overflowing', !isPrimary && overflow > 2);
    el.style.setProperty('--weather-scroll', `${overflow}px`);
  });
}

function rotateOneMastheadWeatherCard() {
  if (!mastheadWeatherSlots.length) return;
  const slot = mastheadWeatherNextSlot % mastheadWeatherSlots.length;
  const previous = mastheadWeatherSlots[slot];
  const usedIds = new Set(mastheadWeatherSlots.filter((_, index) => index !== slot).map((city) => city.id));
  let replacement;
  if (slot === 0) {
    mastheadWeatherPrimaryIndex = (mastheadWeatherPrimaryIndex + 1)
      % MASTHEAD_WEATHER_PRIMARY_SEQUENCE.length;
    replacement = WEATHER_CITIES.find(
      (city) => city.id === MASTHEAD_WEATHER_PRIMARY_SEQUENCE[mastheadWeatherPrimaryIndex],
    );
  } else {
    if (slot === 1 && mastheadWeatherSlots.length <= 2) {
      mastheadWeatherCompactSecondaryIndex = (mastheadWeatherCompactSecondaryIndex + 1) % 3;
    }
    replacement = nextWeatherCity(weatherSecondaryGroup(slot, mastheadWeatherSlots.length), usedIds);
  }
  if (!replacement) return;
  mastheadWeatherSlots[slot] = replacement;
  mastheadWeatherNextSlot = (slot + 1) % mastheadWeatherSlots.length;
  showMastheadWeatherBoard();
  const arriving = MASTHEAD_WEATHER?.querySelector(`[data-weather-city="${replacement.id}"]`);
  arriving?.classList.add('is-arriving');
  window.setTimeout(() => arriving?.classList.remove('is-arriving'), 500);
}

function scheduleMastheadWeatherLayout() {
  window.cancelAnimationFrame(mastheadWeatherResizeFrame);
  mastheadWeatherResizeFrame = window.requestAnimationFrame(() => {
    mastheadWeatherFitCount = null;
    mastheadWeatherTooNarrow = false;
    MASTHEAD_WEATHER?.classList.remove('is-too-narrow');
    mastheadWeatherResizeFrame = window.requestAnimationFrame(showMastheadWeatherBoard);
  });
}

function startMastheadWeatherBoard() {
  if (!MASTHEAD_WEATHER || mastheadWeatherTimer) return;
  showMastheadWeatherBoard();
  mastheadWeatherTimer = window.setInterval(() => {
    rotateOneMastheadWeatherCard();
  }, 5200);
  window.addEventListener('resize', scheduleMastheadWeatherLayout, { passive: true });
}

function renderMastheadWeather(entries) {
  if (!MASTHEAD_WEATHER || !Array.isArray(entries)) return;
  buildMastheadWeatherBoard();
  WEATHER_CITIES.forEach((city, index) => {
    const current = entries[index]?.current;
    const el = MASTHEAD_WEATHER.querySelector(`[data-weather-city="${city.id}"]`);
    if (!el || !current || !Number.isFinite(current.temperature_2m)) return;
    el.querySelector('.masthead-weather__icon').innerHTML = weatherIcon(current.weather_code, current.is_day);
    el.querySelector('.masthead-weather__temp').textContent = `${Math.round(current.temperature_2m)}°`;
    el.dataset.weatherTone = weatherTone(current.weather_code);
  });
  MASTHEAD_WEATHER.classList.remove('hidden');
  startMastheadWeatherBoard();
}

window.addEventListener('radar:translate-mode', refreshMastheadWeatherLinks);

function readWeatherCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) || 'null');
    if (cached?.at && Date.now() - cached.at < WEATHER_CACHE_MS && Array.isArray(cached.entries)) return cached.entries;
  } catch { /* cache absent ou invalide */ }
  return null;
}

async function initMastheadWeather() {
  // Le CSS compacte le bandeau jusqu'à 360 px ; ne pas empêcher le chargement
  // sur téléphone, où une seule ville prioritaire reste affichée.
  if (!MASTHEAD_WEATHER || window.innerWidth < 360) return;
  const cached = readWeatherCache();
  if (cached) renderMastheadWeather(cached);
  try {
    const params = new URLSearchParams({
      latitude: WEATHER_CITIES.map((city) => city.lat).join(','),
      longitude: WEATHER_CITIES.map((city) => city.lon).join(','),
      current: 'temperature_2m,weather_code,is_day',
      temperature_unit: 'celsius',
      timezone: 'America/Toronto',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    const data = await response.json();
    const entries = Array.isArray(data) ? data : [data];
    if (entries.length !== WEATHER_CITIES.length) return;
    try { localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ at: Date.now(), entries })); } catch { /* quota */ }
    renderMastheadWeather(entries);
  } catch { /* module discret : absent si la météo est indisponible */ }
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

/**
 * true / false si la plage start–end (fuseau grille) couvre l'instant présent ;
 * null si aucune horloge exploitable (on fait confiance au bot).
 * end exclusive — à 15:00 pile, l'émission 14:00–15:00 est terminée.
 */
function airSlotIsLive(slot) {
  if (!slot) return null;
  const start = scheduleTimeToMin(slot.start);
  const end = scheduleTimeToMin(slot.end);
  if (start == null && end == null) return null;
  const { minutes: now } = scheduleZonedNow();
  if (start != null && end != null) {
    // Nuit : end <= start (ex. 22:00 → 02:00)
    if (end <= start) return now >= start || now < end;
    return now >= start && now < end;
  }
  if (end != null) return now < end;
  // start seul : en cours dès le début (le bot next / la grille corrigeront la fin)
  return now >= start;
}

/** true si le créneau a un start dans le futur (pas encore commencé aujourd'hui). */
function airSlotIsFuture(slot) {
  if (!slot) return false;
  const start = scheduleTimeToMin(slot.start);
  if (start == null) return false;
  const { minutes: now } = scheduleZonedNow();
  const end = scheduleTimeToMin(slot.end);
  // Nuit 22:00→02:00 : « futur » seulement avant le début le soir
  if (end != null && end <= start) return now < start && now >= end;
  return now < start;
}

/** Émission en cours / à venir : d'abord le bot (radio-nowplaying.json), puis grille locale. */
function botCurrentShow(radio) {
  const entry = nowPlayingEntry(radio);
  const cur = entry?.current;
  if (cur?.title && String(cur.title).trim().length >= 3) {
    const live = airSlotIsLive(cur);
    if (live === true) {
      // Une entrée issue de la grille peut être dépassée par une émission
      // spéciale : la grille locale résout alors le créneau le plus récent.
      if (cur.source === 'schedule') return scheduleCurrentSlot(radio) || cur;
      return cur;
    }
    if (live === false) {
      // Créneau pas commencé ou déjà fini — ne jamais l'afficher comme « en ondes »
    } else {
      // live === null : pas d'horaire exploitable
      // Ne pas traiter comme live si un next est clairement en cours
      const next = entry?.next;
      if (!(next?.title && airSlotIsLive(next) === true)) return cur;
    }
  } else {
    // Repli legacy showTitle seulement s'il n'y a pas de current horodaté expiré
    const legacy = String(entry?.showTitle || '').trim();
    if (legacy.length >= 3) {
      return {
        title: legacy,
        host: entry?.host || '',
        source: entry?.source || '',
      };
    }
  }
  // Promouvoir next quand son créneau a commencé (bot pas encore rafraîchi)
  const next = entry?.next;
  if (next?.title && String(next.title).trim().length >= 3 && airSlotIsLive(next) === true) {
    return next;
  }
  return null;
}

function botNextShow(radio) {
  const entry = nowPlayingEntry(radio);
  // current futur (bot a mis l'émission dans current trop tôt) → à venir
  const cur = entry?.current;
  if (cur?.title && String(cur.title).trim().length >= 3) {
    if (airSlotIsLive(cur) === false && airSlotIsFuture(cur)) return cur;
  }
  const next = entry?.next;
  if (!next?.title || String(next.title).trim().length < 3) return null;
  // Déjà en ondes (promu current) ou terminé (bot retardataire) : ce n'est
  // plus « à venir ». Dans ce dernier cas, le repli de grille trouvera le
  // prochain vrai créneau au lieu de conserver l'émission expirée.
  const nextLive = airSlotIsLive(next);
  if (nextLive === true || (nextLive === false && !airSlotIsFuture(next))) return null;
  return next;
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
  let current = null;
  let currentStartAbs = -Infinity;
  for (const slot of grid) {
    const start = scheduleTimeToMin(slot.start);
    const end = scheduleTimeToMin(slot.end);
    if (start == null || end == null || !slot.title) continue;
    const startAbs = slot.day * 1440 + start;
    const endAbs = slot.day * 1440 + (end <= start ? end + 1440 : end);
    const isLive = (nowAbs >= startAbs && nowAbs < endAbs)
      || (nowAbs + WEEK >= startAbs && nowAbs + WEEK < endAbs);
    if (!isLive) continue;

    // En cas de chevauchement, la diffusion commencée le plus récemment
    // prévaut (ex. une émission spéciale remplace la grille régulière).
    const effectiveStart = startAbs > nowAbs ? startAbs - WEEK : startAbs;
    if (effectiveStart > currentStartAbs) {
      current = slot;
      currentStartAbs = effectiveStart;
    }
  }
  return current;
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

/** Créneau horaire « HH:MM – HH:MM ». */
function upcomingTimeRange(upcoming) {
  if (!upcoming) return '';
  if (upcoming.start && upcoming.end) return `${upcoming.start} – ${upcoming.end}`;
  return upcoming.start || '';
}

/**
 * Piste CHOQ « aberrante » (slug fichier, épisode collé, etc.)
 * Ex. « S1 — E6intervenir-ensemble28-novAmv1 » → ignorer, garder l’émission.
 */
function isGarbageChoqTrack(track, relatedTitles = []) {
  let raw = String(track || '').replace(/^♪\s*/, '').trim();
  if (raw.length < 2) return true;

  const compact = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '');

  // Codes épisode / saison collés au texte (S1 E6…, E6intervenir…)
  if (/\bs\d+\b/i.test(raw) && /\be\d+/i.test(raw)) return true;
  if (/e\d+[a-z]{4,}/i.test(compact)) return true;

  // Extensions / masters / versions fichier
  if (/(^|[^a-z])(amv|wav|mp3|flac|aiff|master|mixdown|edit)\d*$/i.test(compact)) return true;
  if (/\d{1,2}[a-z]{3,4}\d*/i.test(compact) && /v\d|amv|nov|jan|fev|mar|avr|mai|jun|jul|aou|sep|oct|dec/i.test(compact)) {
    return true;
  }

  // Peu d’espaces + tirets/underscores → nom de fichier
  const spaces = (raw.match(/\s/g) || []).length;
  if (raw.length >= 18 && spaces <= 2 && /[-_]/.test(raw) && /[a-z]\d|\d[a-z]/i.test(raw)) {
    return true;
  }

  // Contient le slug d’une émission liée sans espaces (intervenirensemble…)
  for (const title of relatedTitles) {
    const slug = String(title || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9]+/g, '');
    if (slug.length >= 8 && compact.includes(slug) && compact !== slug) return true;
  }

  return false;
}

/**
 * CHOQ — phases d’affichage alternées (cas particuliers) :
 *  A) Hors créneau : piste live ↔ prochaine émission (À venir)
 *  B) Émission en direct + piste différente : émission ↔ piste
 *  Piste « fichier » → null (affichage simple de l’émission seulement).
 * @returns {{ live: object, alt: object } | null}
 */
function choqHybridAirPhases(radio) {
  if (!radio || radio.id !== 'choq') return null;
  const entry = nowPlayingEntry(radio);
  const trackRaw = String(entry?.track || '').trim();
  const slogan = radioSlogan(radio);
  const botCur = botCurrentShow(radio);
  const schedCur = scheduleCurrentSlot(radio);
  const liveShow = (botCur?.title && botCur) || (schedCur?.title && schedCur) || null;
  const upcoming = botNextShow(radio) || scheduleNextSlot(radio);

  const related = [liveShow?.title, upcoming?.title].filter(Boolean);
  const trackOk = trackRaw
    && !isGarbageChoqTrack(trackRaw, related)
    && (!liveShow?.title || normLoose(trackRaw) !== normLoose(liveShow.title));

  // B) Émission en ondes + morceau distinct et « propre »
  if (liveShow?.title && trackOk) {
    const start = liveShow.start || schedCur?.start || botCur?.start || '';
    const end = liveShow.end || schedCur?.end || botCur?.end || '';
    const timeRange = start && end ? `${start} – ${end}` : (start || '');
    return {
      live: {
        title: liveShow.title,
        sub: timeRange || slogan || radio.name || '',
        kind: 'live',
      },
      alt: {
        title: `♪ ${trackRaw}`,
        sub: liveShow.title,
        kind: 'live',
      },
    };
  }

  // A) Musique libre + émission à venir (piste propre seulement)
  if (!liveShow && trackOk && upcoming?.title) {
    const upTime = upcomingTimeRange(upcoming);
    return {
      live: {
        title: `♪ ${trackRaw}`,
        sub: slogan || radio.name || '',
        kind: 'live',
      },
      alt: {
        title: upcoming.title,
        sub: upTime || slogan || '',
        kind: 'upcoming',
      },
    };
  }

  return null;
}

function stopChoqAirRotate() {
  if (choqAirRotateTimer) {
    clearInterval(choqAirRotateTimer);
    choqAirRotateTimer = null;
  }
}

/** Alterne les deux phases CHOQ (live ↔ alt) avec fondu. */
function syncChoqAirRotate(radio) {
  const hybrid = choqHybridAirPhases(radio);
  if (!hybrid) {
    stopChoqAirRotate();
    return;
  }
  if (choqAirRotateTimer) return;
  choqAirRotateTimer = setInterval(() => {
    if (!choqHybridAirPhases(currentStation || nowAirPreviewRadio)) {
      stopChoqAirRotate();
      return;
    }
    choqAirRotateShowUpcoming = !choqAirRotateShowUpcoming;
    nowAirCrossfadePending = true;
    lastNowAir = { title: null, sub: null, empty: null, previewId: null, kind: null, stationId: null };
    renderTunerNowAir();
  }, CHOQ_AIR_ROTATE_MS);
}

/**
 * Piste affichable (CHOQ : ignore les slugs fichier / métadonnées pourries).
 */
function trackForAirDisplay(radio, track, relatedTitles = []) {
  const t = String(track || '').replace(/^♪\s*/, '').trim();
  if (!t) return '';
  if (radio?.id === 'choq' && isGarbageChoqTrack(t, relatedTitles)) return '';
  return t;
}

/**
 * Lignes d'antenne pour le syntoniseur.
 * Priorité : CHOQ hybride → émission en cours → à venir → piste → idle.
 * @returns {{ title: string, sub: string, kind: 'live'|'upcoming'|'idle' }}
 */
function nowAirLines(radio) {
  const slogan = radioSlogan(radio);
  const entry = nowPlayingEntry(radio);
  const botCur = botCurrentShow(radio);
  const botNext = botNextShow(radio);
  const schedCur = scheduleCurrentSlot(radio);
  const schedNext = scheduleNextSlot(radio);
  const trackRaw = String(entry?.track || '').trim();
  const relatedTitles = [
    botCur?.title,
    schedCur?.title,
    botNext?.title,
    schedNext?.title,
  ].filter(Boolean);
  // CHOQ : ne jamais afficher une piste « fichier » (titre ni sous-titre)
  const track = trackForAirDisplay(radio, trackRaw, relatedTitles);

  // 0) CHOQ hybride (émission+piste OU piste+à venir) — avant le rendu simple
  const hybrid = choqHybridAirPhases(radio);
  if (hybrid) {
    return choqAirRotateShowUpcoming ? hybrid.alt : hybrid.live;
  }

  // 1) Émission en cours (bot, déjà fusionné api > schedule)
  if (botCur?.title) {
    const host = String(botCur.host || entry?.host || '').trim();
    const start = botCur.start || schedCur?.start || '';
    const end = botCur.end || schedCur?.end || '';
    const timeRange = start && end ? `${start} – ${end}` : (start || '');
    let sub;
    if (track && normLoose(track) !== normLoose(botCur.title)) sub = `♪ ${track}`;
    else if (host && normLoose(host) !== normLoose(botCur.title)) sub = `avec ${host}`;
    else if (timeRange) sub = timeRange;
    else sub = slogan || `Vous écoutez ${radio.name}`;
    return { title: botCur.title, sub, kind: 'live' };
  }

  // 2) Repli grille locale (bot pas encore à jour)
  if (schedCur?.title) {
    const timeRange = schedCur.start && schedCur.end
      ? `${schedCur.start} – ${schedCur.end}`
      : '';
    let sub;
    if (track && normLoose(track) !== normLoose(schedCur.title)) sub = `♪ ${track}`;
    else if (schedCur.host) sub = `avec ${schedCur.host}`;
    else if (timeRange) sub = timeRange;
    else sub = slogan || `Vous écoutez ${radio.name}`;
    return { title: schedCur.title, sub, kind: 'live' };
  }

  // 3) Hors créneau (autres postes) : prochaine émission
  const upcoming = botNext || (schedNext
    ? { title: schedNext.title, start: schedNext.start, end: schedNext.end }
    : null);
  const upTime = upcomingTimeRange(upcoming);

  if (upcoming?.title) {
    const bits = [];
    if (upTime) bits.push(upTime);
    if (track && normLoose(track) !== normLoose(upcoming.title)) {
      bits.push(`♪ ${track}`);
    }
    return {
      title: upcoming.title,
      sub: bits.join(' · ') || slogan || '',
      kind: 'upcoming',
    };
  }

  // 4) Piste seule (musique libre sans grille) — déjà filtrée pour CHOQ
  if (track) {
    return {
      title: `♪ ${track}`,
      sub: slogan || `Vous écoutez ${radio.name}`,
      kind: 'live',
    };
  }

  return { title: `Vous écoutez ${radio.name}`, sub: slogan, kind: 'idle' };
}

/** Libellé du panneau bureau : « À l'antenne » (live/idle) ou « À venir ». */
function nowAirPanelLabel(kind = 'idle') {
  return kind === 'upcoming' ? 'À venir' : "À l'antenne";
}

/**
 * Une seule ligne pour la rotation du sous-titre du dial (mobile / compact).
 * Sur bureau le libellé panneau porte déjà « À venir » ; ici on le préfixe
 * quand kind === upcoming (le panneau est masqué sous 1100px).
 */
function formatNowAirSubLine(title, sub, empty, kind = 'idle') {
  if (empty) return 'Les radios étudiantes jouent en direct, 24/7';
  const core = sub ? `${title} · ${sub}` : (title || '');
  if (!core) return '';
  if (kind === 'upcoming') return `À venir · ${core}`;
  return core;
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

/**
 * Téléphone (< 600 px) ou embed étroit (pomo/solitaire mobile) :
 * acronyme d’institution dans le titre du syntoniseur.
 */
function isTunerDialPhoneLayout() {
  if (IS_TUNER_EMBED) return isEmbedNowAirInDial();
  return !!TUNER_DIAL_PHONE_MQ?.matches;
}

/** Institution affichée dans le syntoniseur : abrégée au téléphone / embed étroit. */
function tunerDialInstitutionLabel(radio) {
  if (!radio) return '';
  const raw = isTunerDialPhoneLayout()
    ? shortInstitution(radio.institution, radio.type)
    : tunerInstitutionLabel(radio.institution);
  // Forme longue localisable (EN/ES…) ; acronymes restent neutres.
  return adaptRadarInstitutionLabel(raw);
}

/**
 * Suffixe « FM » / « AM » depuis frequency, si absent du nom
 * (ex. name « CISM 89,3 » + frequency « 89,3 FM » → « CISM 89,3 FM »).
 * Web / sans bande → chaîne vide.
 */
function stationOnAirBandLabel(radio = {}) {
  const name = String(radio.name || '');
  if (/\bFM\b/i.test(name) || /\bAM\b/i.test(name)) return '';
  // 1690AM collé sans espace
  if (/\dAM\b/i.test(name) || /\dFM\b/i.test(name)) return '';
  const freq = String(radio.frequency || '').trim();
  if (/\bFM\b/i.test(freq)) return ' FM';
  if (/\bAM\b/i.test(freq)) return ' AM';
  return '';
}

/** Nom d’antenne affiché : « CISM 89,3 FM », « CJLO 1690AM », « CHOQ.ca ». */
function stationDisplayName(radio = {}) {
  const name = String(radio.name || '').trim();
  if (!name) return '';
  return `${name}${stationOnAirBandLabel(radio)}`;
}

/** Ligne 1 du syntoniseur (vue compacte) : « poste · établissement ». */
function tunerDialTitleLine(radio) {
  if (!radio) return tunerSubMeta || 'Radios étudiantes en direct';
  const inst = tunerDialInstitutionLabel(radio);
  const name = stationDisplayName(radio) || radio.name;
  return inst ? `${name} · ${inst}` : name;
}

/**
 * Ligne 1 du syntoniseur (bureau) : « poste FM · acronyme ».
 * Ex. CISM 89,3 FM · UdeM
 */
function tunerDesktopTitleLine(radio) {
  if (!radio) return 'Syntoniser un poste';
  const name = stationDisplayName(radio) || String(radio.name || '').trim() || 'Syntoniser un poste';
  const inst = shortInstitution(radio.institution, radio.type)
    || adaptRadarInstitutionLabel(tunerInstitutionLabel(radio.institution));
  return inst ? `${name} · ${inst}` : name;
}

/**
 * Ligne 2 du syntoniseur (bureau) : slogan (sinon fréquence / site externe).
 */
function tunerDesktopSubLine(radio, { external = false } = {}) {
  if (!radio) return '';
  const slogan = radioSlogan(radio);
  if (slogan) return slogan;
  if (external) return adaptRadarUiText('Site externe');
  return String(radio.frequency || '').trim();
}

/**
 * Mobile / tablette (< 1100 px) sur le site principal.
 * Embed large : logique « bureau » (panneau latéral À l'antenne).
 * Embed étroit (≤640 px) : même logique compacte que le site mobile
 * (ligne 2 = antenne / à venir + marquee) car le panneau est masqué en CSS.
 */
function isDialCompactLayout() {
  if (IS_TUNER_EMBED) return isEmbedNowAirInDial();
  return !!TUNER_SUB_ROTATE_MQ?.matches;
}

/**
 * Titre ligne 1 en layout compact.
 * Mobile / embed étroit : toujours acronyme (ULaval, UdeM…), jamais le nom long.
 */
function compactDialTitleLine(radio) {
  if (!radio) return tunerSubMeta || 'Radios étudiantes en direct';
  const name = stationDisplayName(radio) || radio.name || '';
  // Acronyme sur téléphone + embed étroit ; tablette site peut garder le long.
  const inst = isTunerDialPhoneLayout() || isEmbedNowAirInDial()
    ? (shortInstitution(radio.institution, radio.type)
      || adaptRadarInstitutionLabel(tunerInstitutionLabel(radio.institution)))
    : tunerDialInstitutionLabel(radio);
  if (!name) return inst || '';
  return inst ? `${name} · ${inst}` : name;
}

/**
 * Ligne « méta » du dial compact (sous le titre poste · établissement) :
 * slogan (langue principale de l’institution, sans MT) — alterne avec l’antenne.
 * Fréquence seulement en dernier recours.
 */
function dialCompactMetaLineForRadio(radio) {
  if (!radio) return '';
  if (isExternalListen(radio)) return adaptRadarUiText('Site externe');
  // Slogan original (pas de traduction) = langue principale de l’institution
  const slogan = radioSlogan(radio);
  if (slogan) return slogan;
  return String(radio.frequency || '').trim() || 'Web';
}

/**
 * Ligne antenne pour le bas du dial compact (mobile / tablette).
 * Réutilise nowAirLines() (grille, ICY, slogan) + préfixe « À venir » si besoin.
 */
function dialCompactAirLineForRadio(radio) {
  if (!radio) return '';
  const { title, sub, kind } = nowAirLines(radio);
  const genericListen = `Vous écoutez ${radio.name}`;
  if (title && title !== genericListen) {
    return formatNowAirSubLine(title, sub, false, kind);
  }
  return radioSlogan(radio) || '';
}

/** @deprecated — préférer dialCompactMetaLineForRadio + rotation */
function dialCompactSubLineForRadio(radio) {
  return dialCompactAirLineForRadio(radio) || dialCompactMetaLineForRadio(radio);
}

function applyDialCompactSub(radio, crossfade = false) {
  // Utilisé hors rotation uniquement (repli).
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
  const { title, sub, kind } = nowAirLines(radio);
  const genericListen = `Vous écoutez ${radio.name}`;
  const slogan = radioSlogan(radio);

  let airDetail = sub || '';
  if (!airDetail || airDetail === genericListen || airDetail === slogan) {
    airDetail = '';
  }

  if (omitStation) {
    if (title === genericListen) {
      const fallback = airDetail || slogan || '';
      return { title: fallback || 'En direct', sub: '', kind: kind || 'idle' };
    }
    return { title, sub: airDetail || '', kind };
  }

  if (title === genericListen) {
    return {
      title: stationLine,
      sub: airDetail || slogan || '',
      kind: kind || 'idle',
    };
  }

  return {
    title,
    sub: airDetail ? `${stationLine} · ${airDetail}` : stationLine,
    kind,
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
  // Embed : l’aperçu va dans le module « À l'antenne » (colonne droite), pas dans le dial.
  if (IS_TUNER_EMBED) return false;
  return isNowAirPanelPreviewMode() && !!TUNER_SUB_ROTATE_MQ?.matches;
}

/** Bureau sans poste : faire défiler les radios disponibles dans le sous-titre du dial. */
function isDesktopIdleDialCarousel() {
  return !currentStation
    && !PREFERS_REDUCED_MOTION?.matches
    && (IS_TUNER_EMBED || !TUNER_SUB_ROTATE_MQ?.matches)
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

  // Dans l'iframe, le sous-titre du dial est volontairement étroit et peut
  // défiler longtemps. Ne pas faire dépendre l'aperçu des postes de cette
  // durée : le panneau « À l'antenne » doit continuer à alterner comme la
  // page Radar au repos.
  if (IS_TUNER_EMBED) {
    nowAirPreviewTimer = setTimeout(() => {
      nowAirPreviewTimer = null;
      if (currentStation || !isNowAirPanelPreviewMode()) return;
      pickNowAirPreviewRadio();
      renderTunerNowAir();
      scheduleNowAirPreviewTick();
    }, TUNER_SUB_ROTATE_MS);
    return;
  }

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
  if (PREFERS_REDUCED_MOTION?.matches) return false;
  // Embed étroit : alternance slogan/fréquence ↔ à l'antenne / à venir dans le dial.
  if (IS_TUNER_EMBED) return isEmbedNowAirInDial();
  return !!TUNER_SUB_ROTATE_MQ?.matches;
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

/** Texte du panneau antenne : marquee doux seulement en cas de débordement. */
function applyNowAirPanelText(el, text) {
  if (!el) return;
  const value = String(text ?? '').trim();
  el.classList.remove('hidden');
  if (!value) {
    applyMarquee(el, '');
    el.removeAttribute('title');
    return;
  }
  applyMarquee(el, value);
  el.setAttribute('title', value);
}

/**
 * @param {string} title
 * @param {string} sub
 * @param {{ crossfade?: boolean, panelLabel?: string }} [opts]
 */
function updateNowAirPanel(title, sub, opts = {}) {
  const crossfade = !!opts.crossfade;
  const panelLabel = opts.panelLabel;
  const onWritten = typeof opts.onWritten === 'function' ? opts.onWritten : null;
  const panel = TUNER_NOWAIR;
  if (!panel) return;

  const write = () => {
    if (panelLabel != null) {
      const labelEl = panel.querySelector('.tuner-nowair-label') || TUNER_NOWAIR_LABEL;
      if (labelEl) labelEl.textContent = panelLabel;
      panel.setAttribute('aria-label', panelLabel);
    }
    applyNowAirPanelText(TUNER_NOWAIR_TITLE, title);
    if (TUNER_NOWAIR_SUB) {
      if (sub) {
        TUNER_NOWAIR_SUB.classList.remove('hidden');
        applyNowAirPanelText(TUNER_NOWAIR_SUB, sub);
      } else {
        TUNER_NOWAIR_SUB.textContent = '';
        TUNER_NOWAIR_SUB.classList.add('hidden');
        TUNER_NOWAIR_SUB.removeAttribute('title');
      }
    }
    onWritten?.();
  };

  const useFade = crossfade && !PREFERS_REDUCED_MOTION?.matches;
  if (!useFade) {
    nowAirFadeGen += 1;
    panel.classList.remove('is-swapping');
    write();
    return;
  }

  // Fondu : fade out → swap contenu → fade in. gen annule les bascules concurrentes.
  const gen = ++nowAirFadeGen;
  panel.classList.add('is-swapping');
  window.setTimeout(() => {
    if (gen !== nowAirFadeGen) return;
    write();
    requestAnimationFrame(() => {
      if (gen !== nowAirFadeGen) return;
      panel.classList.remove('is-swapping');
    });
  }, 280);
}

function syncTunerSubRotate(title, sub, empty, crossfade = false, kind = 'idle') {
  if (!TUNER_SUB || !TUNER_SUB_AIR) return;
  const wrapper = TUNER_SUB.parentElement;

  if (isMobileIdleDialPreview()) {
    stopTunerSubRotate();
    wrapper?.classList.remove('is-rotating');
    TUNER_SUB.classList.add('is-active');
    TUNER_SUB_AIR.classList.remove('is-active');
    TUNER_SUB.setAttribute('aria-hidden', 'false');
    TUNER_SUB_AIR.setAttribute('aria-hidden', 'true');
    tunerSubAirText = formatNowAirSubLine(title, sub, empty, kind);
    applyDialTextCrossfade(TUNER_SUB, tunerSubAirText, crossfade);
    return;
  }

  /*
   * Compact mobile / embed étroit + poste sélectionné :
   *  ligne 1 = poste · acronyme (ULaval, UdeM…)
   *  ligne 2 = alternance slogan (langue principale) ↔ à l'antenne / à venir
   *            (+ marquee si overflow)
   */
  if (currentStation && isDialCompactLayout()) {
    setTunerNameText(compactDialTitleLine(currentStation), crossfade);
    tunerSubMeta = dialCompactMetaLineForRadio(currentStation);
    tunerSubAirText = dialCompactAirLineForRadio(currentStation)
      || formatNowAirSubLine(title, sub, empty, kind);
    // Ne pas « tourner » si la ligne air n’est que le slogan (déjà en bas)
    const hasAir = !!(tunerSubAirText && tunerSubAirText !== tunerSubMeta);

    if (!isTunerSubRotateMode() || !hasAir) {
      // Pas d’émission distincte : bas = slogan (méta) en priorité
      stopTunerSubRotate();
      wrapper?.classList.remove('is-rotating');
      TUNER_SUB.classList.add('is-active');
      TUNER_SUB_AIR.classList.remove('is-active');
      TUNER_SUB.setAttribute('aria-hidden', 'false');
      TUNER_SUB_AIR.setAttribute('aria-hidden', 'true');
      const line = hasAir ? tunerSubAirText : tunerSubMeta;
      TUNER_SUB?.parentElement?.classList.toggle('is-empty', !line);
      if (crossfade) applyDialTextCrossfade(TUNER_SUB, line, true);
      else applyMarquee(TUNER_SUB, line);
      scheduleMarqueeRefresh();
      return;
    }

    wrapper?.classList.add('is-rotating');
    TUNER_SUB?.parentElement?.classList.remove('is-empty');
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
    return;
  }

  tunerSubAirText = formatNowAirSubLine(title, sub, empty, kind);

  if (!isTunerSubRotateMode()) {
    stopTunerSubRotate();
    TUNER_SUB.classList.add('is-active');
    TUNER_SUB_AIR.classList.remove('is-active');
    TUNER_SUB.setAttribute('aria-hidden', 'false');
    TUNER_SUB_AIR.setAttribute('aria-hidden', 'true');

    if (isDesktopIdleDialCarousel()) {
      return;
    }

    // Compact (site ou embed étroit) : préférer la ligne antenne si dispo.
    const showAirInDialSub = currentStation && (isEmbedNowAirInDial() || (!IS_TUNER_EMBED && TUNER_SUB_ROTATE_MQ?.matches));
    if (showAirInDialSub && tunerSubAirText) {
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
  onMediaQueryChange(TUNER_EMBED_NOWAIR_HIDDEN_MQ, onTunerSubRotateLayoutChange);
  onMediaQueryChange(PREFERS_REDUCED_MOTION, onTunerSubRotateLayoutChange);
}

function renderTunerNowAir() {
  if (!TUNER_NOWAIR) return;

  const previewing = isNowAirPanelPreviewMode();
  let title;
  let sub;
  /** @type {'live'|'upcoming'|'idle'} */
  let kind = 'idle';

  if (currentStation) {
    ({ title, sub, kind } = nowAirLines(currentStation));
  } else if (previewing) {
    if (!nowAirPreviewRadio) pickNowAirPreviewRadio();
    if (nowAirPreviewRadio) {
      ({ title, sub, kind } = formatPreviewNowAir(nowAirPreviewRadio, {
        omitStation: isDesktopIdleDialCarousel(),
      }));
    } else {
      title = 'Syntoniser un poste';
      sub = 'Les radios étudiantes jouent en direct, 24/7';
      kind = 'idle';
    }
  } else {
    title = 'Syntoniser un poste';
    sub = 'Les radios étudiantes jouent en direct, 24/7';
    kind = 'idle';
  }

  const empty = !currentStation && !previewing;
  const previewId = previewing ? (nowAirPreviewRadio?.id ?? null) : null;
  if (empty) kind = 'idle';

  const stationId = currentStation?.id
    || (previewing ? nowAirPreviewRadio?.id : null)
    || null;

  // Rien n'a changé : on n'écrase pas le DOM.
  if (lastNowAir.title === title
    && lastNowAir.sub === sub
    && lastNowAir.empty === empty
    && lastNowAir.previewId === previewId
    && lastNowAir.kind === kind
    && lastNowAir.stationId === stationId
    && !nowAirCrossfadePending) {
    if (currentStation) stopNowAirPreview();
    else if (previewing) startNowAirPreview();
    else stopNowAirPreview();
    // Timer CHOQ peut encore être démarré
    if (currentStation) syncChoqAirRotate(currentStation);
    else if (previewing) syncChoqAirRotate(nowAirPreviewRadio);
    return;
  }

  const stationChanged = lastNowAir.stationId != null
    && stationId != null
    && lastNowAir.stationId !== stationId;
  const crossfadePreview = previewing
    && !PREFERS_REDUCED_MOTION?.matches
    && lastNowAir.previewId != null
    && previewId !== lastNowAir.previewId;

  // Fondu uniquement : changement de poste ou bascule CHOQ (pas chaque MAJ de piste)
  const shouldFade = nowAirCrossfadePending || stationChanged;
  nowAirCrossfadePending = false;

  lastNowAir = { title, sub, empty, previewId, kind, stationId };

  // Toujours visible sur bureau (placeholder HTML dès le paint).
  TUNER_NOWAIR.classList.remove('hidden');
  TUNER_NOWAIR.removeAttribute('aria-hidden');
  TUNER_NOWAIR.classList.toggle('is-empty', empty);
  // Couleurs live/upcoming appliquées après le swap (pendant le fade out
  // on garde l’ancienne teinte un instant — OK).
  const applyKindClasses = () => {
    TUNER_NOWAIR.classList.toggle('is-live', kind === 'live');
    TUNER_NOWAIR.classList.toggle('is-upcoming', kind === 'upcoming');
    TUNER_NOWAIR.dataset.airKind = kind;
  };
  if (!shouldFade || PREFERS_REDUCED_MOTION?.matches) applyKindClasses();

  const panelLabel = empty ? "À l'antenne" : nowAirPanelLabel(kind);

  updateNowAirPanel(title, sub, {
    crossfade: shouldFade && !empty,
    panelLabel,
    onWritten: applyKindClasses,
  });

  syncDesktopDialPreview(title, crossfadePreview);
  syncTunerSubRotate(title, sub, empty, crossfadePreview, kind);
  if (currentStation && isPlaybackActive()) {
    updateMediaSession(currentStation, empty ? {} : { title, sub });
  }

  if (currentStation) {
    stopNowAirPreview();
    nowAirPreviewRadio = null;
    lastNowAirPreviewId = null;
    lastDialCarouselText = '';
    // Ne pas réécrire le nom ici si selectStation l’a déjà posé (évite double flash)
    if (!isDialCompactLayout()) {
      /* nom déjà posé par selectStation ; re-sync si besoin */
    }
    setTunerNameText(
      isDialCompactLayout()
        ? compactDialTitleLine(currentStation)
        : tunerDesktopTitleLine(currentStation),
    );
    syncChoqAirRotate(currentStation);
  } else if (previewing) {
    startNowAirPreview();
    syncChoqAirRotate(nowAirPreviewRadio);
  } else {
    stopNowAirPreview();
    stopChoqAirRotate();
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
 * Types CORS : cism-v1 (émissions), triton-np (piste). Craft/CHOQ /api/live
 * n'a pas de CORS — ne pas l'utiliser ici comme « émission ».
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
        host: String(cur.host || '').trim(),
        source: 'api-live',
        slug: String(cur.slug || '').trim(),
        start: cur.start || cur.starts || '',
        end: cur.end || cur.ends || '',
      },
      next: up?.title
        ? {
          title: String(up.title).trim(),
          host: String(up.host || '').trim(),
          source: 'api-live',
          slug: String(up.slug || '').trim(),
          start: up.start || up.starts || '',
          end: up.end || up.ends || '',
        }
        : null,
    };
  }
  // CHOQ / Craft /api/live : title+artist = PISTE uniquement
  if (type === 'craft-live' || type === 'craft' || type === 'choq') {
    const live = payload.live || payload;
    const showTitle = String(live?.show || live?.program || live?.emission || '').trim();
    const trackTitle = String(live?.title || live?.name || '').trim();
    const trackArtist = String(live?.artist || '').trim();
    let track = '';
    if (trackTitle && trackArtist && trackTitle.toLowerCase() !== trackArtist.toLowerCase()) {
      track = `${trackArtist} — ${trackTitle}`;
    } else {
      track = trackTitle || trackArtist;
    }
    if (showTitle) {
      return {
        current: {
          title: showTitle,
          host: String(live.host || live.dj || '').trim(),
          source: 'api-live',
        },
        next: null,
        track: track || '',
      };
    }
    if (!track) return null;
    return { current: null, next: null, track };
  }
  // Triton XML (souvent déjà parsé en texte si fetch renvoie xml — voir ci-dessous)
  if (type === 'triton-np' || type === 'triton') {
    return null; // géré dans fetchClientLivePoll (XML)
  }
  return null;
}

function parseTritonNowPlayingXml(xmlText = '') {
  const text = String(xmlText || '');
  if (!text.includes('nowplaying-info')) return null;
  const prop = (name) => {
    const re = new RegExp(
      `name="${name}"\\s*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</property>`,
      'i',
    );
    const m = re.exec(text);
    return m ? String(m[1]).replace(/\s+/g, ' ').trim() : '';
  };
  const title = prop('cue_title') || prop('track_title') || prop('title');
  const artist = prop('track_artist_name') || prop('artist_name') || prop('artist');
  let track = '';
  if (title && artist && title.toLowerCase() !== artist.toLowerCase()) {
    track = `${artist} — ${title}`;
  } else {
    track = title || artist;
  }
  if (!track) return null;
  return { current: null, next: null, track };
}

async function fetchClientLivePoll(id, poll) {
  if (!poll?.url) return null;
  try {
    const isTriton = poll.type === 'triton-np' || poll.type === 'triton'
      || /tritondigital\.com|nowplaying/i.test(poll.url);
    const res = await fetch(poll.url, {
      cache: 'no-store',
      headers: { Accept: isTriton ? 'application/xml, text/xml, */*' : 'application/json' },
    });
    if (!res.ok) return null;

    let parsed = null;
    if (isTriton) {
      parsed = parseTritonNowPlayingXml(await res.text());
    } else {
      parsed = parseClientLivePayload(poll.type, await res.json());
    }
    if (!parsed) return null;
    if (!parsed.current?.title && !parsed.track) return null;
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
    if (!hit) continue;
    const prev = radioNowPlaying.stations[hit.id] || {};
    const nextCurrent = hit.current?.title ? hit.current : (prev.current || null);
    const nextNext = hit.next?.title ? hit.next : (prev.next || null);
    const nextTrack = hit.track != null && hit.track !== ''
      ? hit.track
      : (prev.track || '');
    // Ne pas écraser une émission valide avec un poll piste-only
    radioNowPlaying.stations[hit.id] = {
      ...prev,
      id: hit.id,
      name: prev.name || radios.find((r) => r.id === hit.id)?.name || hit.id,
      current: nextCurrent,
      next: nextNext,
      track: nextTrack,
      showTitle: nextCurrent?.title || prev.showTitle || '',
      host: nextCurrent?.host || prev.host || '',
      source: nextCurrent?.source || prev.source || 'api-live',
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
    // 15 s : aligné sur CHOQ (REFRESHRATE 15s) pour la piste Triton CORS ;
    // le fichier bot reste le filet (émissions / grilles).
    nowPlayingPollTimer = setInterval(refreshNowPlayingCache, 15000);
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
    // Au passage au-dessus de 100 %, brancher le graphe d'amplification.
    syncBoostWiring();
    applyGain();
    localStorage.setItem('req-player-vol', currentGain);
    try {
      window.RadarPlayerSync?.publishVolume?.(currentGain);
    } catch { /* */ }
  });

  initVolumeRangeBounds();
  bindVolumePopover();
  bindVolumePopoverMute();
  bindVolumeSliderLayout();
  bindVolumeSliderDrag();
}

/**
 * Sans Web Audio : range 0–100 %, zone boost et repère 200 % masqués.
 * Avec Web Audio (y compris mobile) : curseur 0–200 % toujours visible.
 */
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
  onMediaQueryChange(IS_TUNER_EMBED ? EMBED_VOL_POPOVER_MQ : VOL_COMPACT, onVolLayoutChange);
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

/** Adapte un libellé UI à la langue Radar active (glossaire / MT déjà posé). */
function adaptRadarUiText(text = '') {
  if (window.RadarTranslate?.displayUiText) {
    return RadarTranslate.displayUiText(text);
  }
  return text;
}

function adaptRadarInstitutionLabel(text = '') {
  if (window.RadarTranslate?.displayInstitutionLabel) {
    return RadarTranslate.displayInstitutionLabel(text);
  }
  return text;
}

/** Défilement doux sur le libellé d'institution des pastilles sources. */
function applyFilterInstMarquees() {
  if (!NEWS_FILTERS) return;
  NEWS_FILTERS.querySelectorAll('.filter-btn').forEach((btn) => {
    const instEl = btn.querySelector('.filter-btn__inst');
    if (!instEl) return;
    const src = btn.dataset.source;
    if (src === 'all') {
      // UI — se traduit avec la langue active (ne pas figer le FR)
      applyMarquee(instEl, adaptRadarUiText('Toutes les sources'));
      return;
    }
    const { institution, type } = sourceInfo(src);
    const instLabel = filterSourceInstitutionLabel(institution, type, src);
    // Établissement : localisable hors Original/FR/EN ; médias restent notranslate.
    applyMarquee(instEl, adaptRadarInstitutionLabel(instLabel || ''));
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

function selectStation(id, { autoplay = false, openExternal = false, fromSync = false } = {}) {
  const radio = radios.find(r => r.id === id);
  if (!radio) return;

  const prevId = currentStation?.id || null;
  currentStation = radio;

  // Changement de poste : reset CHOQ + fondu antenne (évite l’hésitation visuelle)
  stopChoqAirRotate();
  choqAirRotateShowUpcoming = false;
  if (prevId !== radio.id) {
    cancelLoudnessProbe();
    nowAirCrossfadePending = true;
  }

  const playable = getPlayableStream(radio);
  const external = isExternalListen(radio);

  if (isDialCompactLayout()) {
    // Mobile / embed étroit : L1 = poste · acronyme ; L2 = slogan (ou antenne en rotation)
    setTunerNameText(compactDialTitleLine(radio));
    const metaLine = dialCompactMetaLineForRadio(radio);
    tunerSubMeta = metaLine;
    TUNER_SUB?.parentElement?.classList.toggle('is-empty', !metaLine);
    applyMarquee(TUNER_SUB, metaLine);
  } else {
    // Bureau (+ embed large) : L1 = poste FM · acronyme ; L2 = slogan
    setTunerNameText(tunerDesktopTitleLine(radio));
    setTunerSubText(tunerDesktopSubLine(radio, { external }));
  }

  // Mettre à jour l’antenne tout de suite (avant play async / métadonnées)
  renderTunerNowAir();

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

  // Keep shared station id in sync when the user picks a post (not remote apply).
  if (!fromSync && !window.RadarPlayerSync?.isApplyingRemote?.()) {
    try {
      const s = window.RadarPlayerSync?.readState?.();
      if (!s?.playing) {
        window.RadarPlayerSync?.writeState?.({
          stationId: radio.id,
          playing: false,
          volume: currentGain,
          leaderId: window.RadarPlayerSync.getTabId(),
        });
      }
    } catch { /* */ }
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
  // Pendant la connexion, un second appui annule nettement la tentative.
  if (isBuffering) {
    stopPlayback({ keepStation: true });
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
  // Another tab owns audio: ▶/⏸ control the shared session.
  if (syncRemotePlaying && !window.RadarPlayerSync?.isLeader?.()) {
    if (isPlaybackActive()) {
      // Pause globally (leader will yield / state says paused)
      pauseByUser();
    } else {
      userPaused = false;
      play(currentStation);
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
  syncRemotePlaying = false;

  // Claim leadership first so other same-origin players mute immediately.
  try {
    window.RadarPlayerSync?.claimPlay?.(radio.id, currentGain);
  } catch { /* */ }

  // Reprise Cast plutôt que double lecture locale + distante.
  if (window.RadarCast?.isChromecasting?.()) {
    window.RadarCast.resumeRemote?.();
    mobilePlayback?.onPlayStart();
    updatePlayUI();
    return;
  }

  // Branche (ou non) le graphe d'amplification selon le gain demandé et le poste.
  const tuning = STATION_PLAYBACK[radio.id] || {};
  syncBoostWiring({ station: radio, allowUnwire: true });
  reconnectTries = 0;
  mobilePlayback?.resetReconnectTries();
  audio.preload = mobilePlayback?.getMobilePreload(!!tuning.resilient)
    ?? (tuning.resilient ? 'auto' : 'none');
  try {
    if (audioCtx && audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch {} }
    if (audio.src !== url) audio.src = url;
    setBuffering(true);
    updatePlayUI();
    syncMediaSessionPlaybackState();
    syncMediaSessionLivePosition();
    await audio.play();
    mobilePlayback?.onPlayStart();
    syncMediaSessionPlaybackState();
    applyGain();
    armPlayerSession();
    updatePlayUI();
    try {
      window.RadarPlayerSync?.claimPlay?.(radio.id, currentGain);
    } catch { /* */ }
  } catch {
    // Autoplay / gesture refusée : l’UI play reste inactive ; pas de toast (bruit inutile).
    setBuffering(false);
    updatePlayUI();
  }
}

function stopPlayback({ keepStation = false } = {}) {
  reconnectTries = 0;
  cancelLoudnessProbe();
  userPaused = false;
  setBuffering(false);
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
  // Follower tab: show as playing while another Le Radar context owns the stream.
  if (syncRemotePlaying && !isPlaying()) return true;
  return isPlaying() || isCasting();
}

function updatePlayUI() {
  const active = isPlaybackActive();
  const audible = active && !isBuffering;
  const external = !!currentStation && isExternalListen(currentStation);
  ICO_PLAY.classList.toggle('hidden', audible || external || isBuffering);
  ICO_PAUSE.classList.toggle('hidden', !audible || isBuffering);
  ICO_EXTERNAL?.classList.toggle('hidden', !external || audible || isBuffering);
  TUNER_PLAY.classList.toggle('is-buffering', isBuffering);
  TUNER_PLAY.classList.toggle('is-external', external && !audible && !isBuffering);
  TUNER.classList.toggle('is-playing', audible);
  TUNER.classList.toggle('is-buffering', isBuffering);
  TUNER.classList.toggle('is-external', external && !audible && !isBuffering);
  if (isBuffering) {
    TUNER_PLAY.title = 'Connexion au flux — appuyer pour annuler';
    TUNER_PLAY.setAttribute('aria-label', 'Connexion au flux — appuyer pour annuler');
  } else {
    const actionLabel = audible ? 'Mettre en pause' : (external ? 'Écouter sur le site du poste' : 'Écouter');
    TUNER_PLAY.title = actionLabel;
    TUNER_PLAY.setAttribute('aria-label', actionLabel);
  }
  // Signal for nav-shell (Phase 2b): local stream actually playing on this page.
  if (isPlaying()) {
    document.documentElement.dataset.radarPlaying = '1';
  } else if (!syncRemotePlaying) {
    disarmPlayerSessionPlayingFlag();
  } else {
    document.documentElement.dataset.radarPlaying = '0';
  }
  renderTunerNowAir();
  syncNowPlayingPoll();
  syncMediaSessionPlaybackState();
  window.RadarCast?.updateButton?.();
}

/**
 * Faut-il brancher le graphe Web Audio (gain > 1 possible) ?
 * - Bureau : oui dès que Web Audio existe (CORS testé au premier play).
 * - Mobile : seulement si le curseur dépasse 100 % — évite de forcer
 *   crossOrigin + AudioContext pour une écoute « normale », tout en
 *   permettant le 200 % sur téléphone / tablette quand l'utilisateur le demande.
 */
function wantsAudioBoost() {
  if (!webAudioSupported) return false;
  // iOS : audio.volume est en lecture seule — l'atténuation (< 100 %) doit
  // aussi passer par le gain Web Audio, sinon le curseur n'a aucun effet.
  if (IS_IOS) return Math.abs(currentGain - 1) > 0.001;
  if (MOBILE_PLAYBACK) return currentGain > 1.001;
  return true;
}

/**
 * Aligne le graphe d'amplification sur le gain / poste courants.
 * Sur mobile, une fois branché on évite de démonter juste parce que le gain
 * redescend ≤ 100 % (rebuild de l'<audio> = perte de session Android).
 */
function syncBoostWiring({ station = currentStation, allowUnwire = false } = {}) {
  if (!station) return;
  const tuning = STATION_PLAYBACK[station.id] || {};
  const wantBoost = wantsAudioBoost()
    && !boostUnavailable.has(station.id)
    && !tuning.noBoost;

  if (wantBoost === boostWired) return;
  // Garder le graphe si on est déjà amplifié et que le démontage n'est pas
  // explicitement autorisé (changement de poste / play()).
  if (boostWired && !wantBoost && !allowUnwire) return;

  const wasPlaying = !!(audio && !audio.paused && audio.src);
  const url = (audio && audio.src)
    || getPlayableStream(station)
    || '';

  rebuildAudio(wantBoost);

  if (!url || !audio) return;
  try {
    if (audio.src !== url) audio.src = url;
    if (wasPlaying) {
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch {}
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
  setBuffering(false);
  syncRemotePlaying = false;
  // Cast : pause distante (ou fin de session si le LIVE ne gère pas pause).
  // Ne pas appeler endSession ici — le bouton Cast sert à arrêter la diffusion.
  if (window.RadarCast?.isChromecasting?.()) {
    window.RadarCast.pauseRemote?.();
  }
  mobilePlayback?.onUserPause();
  if (audio) {
    suppressAudioError = true;
    try { audio.pause(); } catch {}
    suppressAudioError = false;
  }
  try {
    window.RadarPlayerSync?.publishPause?.(currentStation?.id, currentGain);
  } catch { /* */ }
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
      // Ne plus démonter le graphe d'amplification ici : rebuildAudio() recréait
      // l'<audio>, tuait la Media Session Android et coupait le 200 %.
      // On se contente de relancer l'AudioContext si besoin.
      if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
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
  const enterBuffering = () => {
    // Ces événements ne proviennent d'un <audio> que lorsqu'un flux est en
    // cours de préparation; `currentStation` couvre aussi l'instant où le
    // navigateur normalise l'URL de src.
    if (!userPaused && !syncRemotePlaying && (el.src || currentStation)) {
      setBuffering(true);
      updatePlayUI();
    }
  };
  el.addEventListener('loadstart', enterBuffering);
  el.addEventListener('waiting', enterBuffering);
  el.addEventListener('stalled', enterBuffering);
  el.addEventListener('play',    updatePlayUI);
  el.addEventListener('pause',   () => {
    setBuffering(false);
    updatePlayUI();
  });
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
  setBuffering(false);
  scheduleLoudnessProbe();
  mobilePlayback?.onPlaying();
  updatePlayUI();
}

function onAudioEnded() {
  setBuffering(false);
  if (mobilePlayback?.shouldHandleEnded() && mobilePlayback.attemptReconnect()) return;
  updatePlayUI();
}

function reconnectResilient() {
  // Reconnexion silencieuse — les toasts « flux instable » étaient des faux positifs.
  mobilePlayback?.attemptReconnect();
  updatePlayUI();
}

function onAudioError() {
  setBuffering(false);
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
    if (currentGain > 1.001) {
      showToast('Amplification indisponible pour ce poste — volume plafonné à 100 %.');
    } else if (IS_IOS && currentGain < 0.999) {
      // Sans Web Audio, iOS ignore audio.volume : le niveau reste à 100 %.
      showToast('Volume non réglable pour ce poste sur iPhone/iPad — utilise les boutons physiques.');
    }
    rebuildAudio(false);
    play(currentStation);
    return;
  }
  // Erreur audio : UI mise à jour sans toast — le flux reprend souvent tout seul.
  updatePlayUI();
}

/** Niveau correctif propre à un poste (1 = aucun changement). */
function stationTrim(station = currentStation) {
  if (!station?.id) return 1;
  const value = stationTrims.get(station.id);
  return Number.isFinite(value) ? Math.min(1, Math.max(0.55, value)) : 1;
}

function saveStationTrims() {
  try {
    localStorage.setItem(STATION_TRIMS_KEY, JSON.stringify(Object.fromEntries(stationTrims)));
  } catch { /* stockage indisponible : le réglage reste valable pour la session */ }
}

function loadStationTrims() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATION_TRIMS_KEY) || '{}');
    if (!saved || typeof saved !== 'object') return;
    Object.entries(saved).forEach(([id, value]) => {
      if (Number.isFinite(value) && value >= 0.55 && value <= 1) stationTrims.set(id, value);
    });
  } catch { /* valeur ancienne/corrompue : ignorer */ }
}

function cancelLoudnessProbe() {
  if (loudnessProbeTimer) clearInterval(loudnessProbeTimer);
  loudnessProbeTimer = null;
  loudnessProbeStationId = null;
}

function averageRmsDb(samples) {
  if (!samples.length) return null;
  const meanSquare = samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
  return meanSquare > 0 ? 10 * Math.log10(meanSquare) : null;
}

/**
 * Mesure courte, une seule fois par poste et par session de lecture.
 * On ne fait jamais d'AGC qui pompe : un flux vraiment fort reçoit seulement
 * une réduction durable. Les flux CORS incompatibles restent en lecture native.
 */
function scheduleLoudnessProbe() {
  cancelLoudnessProbe();
  if (!boostWired || !analyserNode || !currentStation?.id || !audio || audio.paused) return;

  const stationId = currentStation.id;
  const values = [];
  const buffer = new Float32Array(analyserNode.fftSize);
  let ticks = 0;
  loudnessProbeStationId = stationId;
  loudnessProbeTimer = setInterval(() => {
    if (!audio || audio.paused || currentStation?.id !== stationId || !analyserNode) {
      cancelLoudnessProbe();
      return;
    }
    analyserNode.getFloatTimeDomainData(buffer);
    let squareSum = 0;
    for (let i = 0; i < buffer.length; i += 1) squareSum += buffer[i] * buffer[i];
    values.push(squareSum / buffer.length);
    ticks += 1;
    // Ne garder qu'une courte fenêtre, après que le flux se soit stabilisé.
    if (ticks < 18) return;
    cancelLoudnessProbe();

    const db = averageRmsDb(values);
    if (!Number.isFinite(db)) return;
    // -16 dBFS et plus fort est déjà très dense. La réduction est graduelle,
    // plafonnée à 45 %, et seulement vers le bas pour respecter l'intention.
    const target = db > -11 ? 0.68 : db > -16 ? 0.80 : db > -20 ? 0.90 : 1;
    const existing = stationTrim(currentStation);
    if (target < existing - 0.015) {
      stationTrims.set(stationId, target);
      saveStationTrims();
      applyGain({ smooth: true });
    }
  }, 350);
}

/** Branche un graphe Web Audio (analyse → limiteur → gain → sortie). */
function wireBoost() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) { webAudioSupported = false; return false; }
  try {
    if (!audio) return false;
    audio.crossOrigin = 'anonymous';
    audioCtx = audioCtx || new Ctx();
    mediaSource = audioCtx.createMediaElementSource(audio);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;
    compressorNode = audioCtx.createDynamicsCompressor();
    // Limiteur léger des crêtes : aucune "remontée" automatique des passages calmes.
    compressorNode.threshold.setValueAtTime(-10, audioCtx.currentTime);
    compressorNode.knee.setValueAtTime(2, audioCtx.currentTime);
    compressorNode.ratio.setValueAtTime(12, audioCtx.currentTime);
    compressorNode.attack.setValueAtTime(0.003, audioCtx.currentTime);
    compressorNode.release.setValueAtTime(0.2, audioCtx.currentTime);
    gainNode = audioCtx.createGain();
    mediaSource.connect(analyserNode).connect(compressorNode).connect(gainNode).connect(audioCtx.destination);
    const resumeIfNeeded = () => {
      if (audioCtx && audioCtx.state === 'suspended' && isPlaying() && !userPaused) {
        audioCtx.resume().catch(() => {});
      }
    };
    audioCtx.onstatechange = resumeIfNeeded;
    // Mobile : l'AudioContext est souvent suspendu en arrière-plan — on reprend
    // dès que la page redevient visible pour que le 200 % continue de sonner.
    if (!boostCtxLifecycleBound) {
      boostCtxLifecycleBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') resumeIfNeeded();
      });
      window.addEventListener('pageshow', resumeIfNeeded);
      window.addEventListener('focus', resumeIfNeeded);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    boostWired = true;
  } catch {
    boostWired = false;
  }
  return boostWired;
}

/** Recrée l'élément <audio>, avec ou sans graphe d'amplification. */
function rebuildAudio(withBoost) {
  cancelLoudnessProbe();
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
  // Élément recréé : re-brancher les écouteurs AirPlay (sinon le bouton cast
  // perd la détection de disponibilité après un passage par le mode amplifié).
  window.RadarCast?.attachPlayer?.(audio);
  mediaSource = null;
  gainNode = null;
  compressorNode = null;
  analyserNode = null;
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

/** Applique le curseur maître et l'éventuelle correction prudente du poste. */
function applyGain({ smooth = false } = {}) {
  const effective = volumeMuted ? 0 : currentGain * stationTrim();
  const silent = isOutputSilent();

  if (audio) {
    if (boostWired && gainNode) {
      audio.volume = 1;
      try {
        if (audioCtx && smooth) {
          gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
          gainNode.gain.setTargetAtTime(effective, audioCtx.currentTime, 0.35);
        } else if (audioCtx) {
          gainNode.gain.setValueAtTime(effective, audioCtx.currentTime);
        }
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
  loadStationTrims();
  const raw = localStorage.getItem('req-player-vol');
  const saved = parseFloat(raw ?? String(DEFAULT_GAIN));
  // Migration douce : 72 % était l'ancien défaut automatique. On ne touche
  // jamais aux personnes qui avaient déjà choisi une autre valeur.
  const oldDefault = localStorage.getItem(VOLUME_PREF_VERSION_KEY) !== VOLUME_PREF_VERSION
    && (raw === null || Math.abs(saved - 0.72) < 0.005 || Math.abs(saved - 1) < 0.005);
  if (oldDefault) localStorage.setItem('req-player-vol', String(DEFAULT_GAIN));
  try { localStorage.setItem(VOLUME_PREF_VERSION_KEY, VOLUME_PREF_VERSION); } catch {}
  currentGain = oldDefault
    ? DEFAULT_GAIN
    : (Number.isFinite(saved) ? Math.min(GAIN_UI_MAX, Math.max(0, saved)) : DEFAULT_GAIN);
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
 * Institutions : original en Original/FR/EN ; localisées hors de ces modes
 * (translate.js). Ce filet corrige aussi une casse abîmée (gtx).
 */
function formatInstitutionDisplay(name = '') {
  if (!name) return '';
  // Lookarounds ASCII : `\b` après `é` échoue en JS (é ≠ word char).
  return String(name)
    .replace(/(?<![A-Za-z])université(?![A-Za-z])/giu, 'Université')
    .replace(/(?<![A-Za-z])universite(?![A-Za-z])/giu, 'Université')
    .replace(/(?<![A-Za-z])university(?![A-Za-z])/giu, 'University')
    .replace(/(?<![A-Za-z])universidad(?![A-Za-z])/giu, 'Universidad')
    .replace(/(?<![A-Za-z])universidade(?![A-Za-z])/giu, 'Universidade')
    .replace(/(?<![A-Za-z])universität(?![A-Za-z])/giu, 'Universität')
    .replace(/(?<![A-Za-z])università(?![A-Za-z])/giu, 'Università')
    .replace(/(?<![A-Za-z])cégep(?![A-Za-z])/giu, 'Cégep')
    .replace(/(?<![A-Za-z])cegep(?![A-Za-z])/giu, 'Cégep')
    .replace(/(?<![A-Za-z])college(?![A-Za-z])/giu, 'College')
    .replace(/(?<![A-Za-z])collège(?![A-Za-z])/giu, 'Collège')
    .replace(/(?<![A-Za-z])colegio(?![A-Za-z])/giu, 'Colegio')
    .replace(/(?<![A-Za-z])colégio(?![A-Za-z])/giu, 'Colégio')
    // Noms propres fréquents laissés en minuscules par gtx (Laval, Montréal…)
    .replace(/(?<![A-Za-z])laval(?![A-Za-z])/giu, 'Laval')
    .replace(/(?<![A-Za-z])montr[eé]al(?![A-Za-z])/giu, (m) => (m.includes('é') ? 'Montréal' : 'Montreal'))
    .replace(/(?<![A-Za-z])sherbrooke(?![A-Za-z])/giu, 'Sherbrooke')
    .replace(/(?<![A-Za-z])mcgill(?![A-Za-z])/giu, 'McGill')
    .replace(/(?<![A-Za-z])concordia(?![A-Za-z])/giu, 'Concordia')
    .replace(/(?<![A-Za-z])dawson(?![A-Za-z])/giu, 'Dawson')
    .replace(/(?<![A-Za-z])qu[eé]bec(?![A-Za-z])/giu, (m) => (m.includes('é') ? 'Québec' : 'Quebec'));
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
 *   short — acronyme (ULaval, UdeM, McGill…) pour En bref + Suite du fil
 *   full  — nom complet (À la une + vedettes, tablette+)
 */
function articleInstitutionLabel(name = '', type = '', form = 'short') {
  if (!name) return '';
  if (form === 'full') {
    return expandInstitutionFullName(name);
  }
  // Court : acronyme institutionnel, sinon libellé compact (cégeps, collèges).
  return shortInstitution(name, type)
    || formatInstitutionDisplay(String(name).replace(/\s*\([^)]*\)\s*$/, '').trim());
}

/** HTML meta institution : complet + acronyme pour bascule responsive CSS. */
function articleInstitutionMetaHtml(name = '', type = '', role = 'standard') {
  if (!name) return '';
  const short = articleInstitutionLabel(name, type, 'short');
  const full = articleInstitutionLabel(name, type, 'full');
  // Nom complet seulement pour la une et les vedettes (plus d’espace).
  // En bref + Suite du fil : toujours acronyme / forme courte.
  const spacious = role === 'lead' || role === 'feature';
  // Pas de notranslate : hors Original/FR/EN, translate.js localise (ES/PT…).
  // En Original / FR / EN : libellés d’origine intacts.
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
    'Cégep du Vieux Montréal': 'Cégep Vieux-Montréal',
    'Cégep de Jonquière (ATM – journalisme)': 'Jonquière',
    'Cégep de Jonquière': 'Jonquière',
    'Dawson College': 'Dawson',
    'Collège Dawson': 'Dawson',
  };
  if (CEGEP_SHORT[name]) return CEGEP_SHORT[name];
  const strippedName = String(name).replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (CEGEP_SHORT[strippedName]) return CEGEP_SHORT[strippedName];

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

/** Aligné sur style.css --filters-collapsed-rows (1 bureau/paysage, 2 portrait). */
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
      instSpan.textContent = adaptRadarInstitutionLabel(instLabel);
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
      if (label) label.textContent = adaptRadarUiText('Réduire');
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
    if (label) {
      label.textContent = adaptRadarUiText(filtersExpanded ? 'Réduire' : 'Plus de sources');
    }
    FILTERS_TOGGLE?.setAttribute('aria-expanded', filtersExpanded ? 'true' : 'false');
  } else {
    filtersExpanded = false;
    FILTERS_PANEL.classList.remove('is-expanded');
    FILTERS_TOGGLE?.setAttribute('hidden', '');
  }

  scheduleFilterMarqueeRefresh();
}

/** Après changement de langue : reposer les libellés sources / boutons. */
function onRadarTranslateModeChange() {
  applyFilterInstMarquees();
  syncFiltersPanel();
  scheduleFilterMarqueeRefresh();
  // Reposer l’institution du syntoniseur dans la langue active
  if (currentStation) {
    const radio = currentStation;
    const external = isExternalListen(radio);
    if (isDialCompactLayout()) {
      setTunerNameText(compactDialTitleLine(radio));
      const metaLine = dialCompactMetaLineForRadio(radio);
      tunerSubMeta = metaLine;
      TUNER_SUB?.parentElement?.classList.toggle('is-empty', !metaLine);
      if (!tunerSubRotateShowAir) applyMarquee(TUNER_SUB, metaLine);
    } else {
      setTunerNameText(tunerDesktopTitleLine(radio));
      setTunerSubText(tunerDesktopSubLine(radio, { external }));
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('radar:translate-mode', onRadarTranslateModeChange);
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

// ─── Recherche locale (loupe) ─────────────────────────────────────────────────
/** Normalise pour comparaison insensible aux accents / casse. */
function normalizeSearchText(str = '') {
  return String(str)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    // Apostrophes typographiques (Bishop’s) → espace / lettre adjacente
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Jetons de requête (ET) — chaîne vide → aucun filtre. */
function searchTokens(query = '') {
  const q = normalizeSearchText(query);
  if (!q) return [];
  return q.split(' ').filter((t) => t.length >= 1);
}

/**
 * Variantes légères d'un jeton (pluriel EN/FR simple) pour coller
 * « dancer » ↔ « dancers », « danseur » ↔ « danseurs ».
 */
function searchTokenVariants(token = '') {
  const t = String(token || '');
  if (t.length < 3) return [t];
  const out = new Set([t]);
  if (t.endsWith('ies') && t.length > 4) out.add(`${t.slice(0, -3)}y`);
  if (t.endsWith('y') && t.length > 3) out.add(`${t.slice(0, -1)}ies`);
  if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) out.add(t.slice(0, -1));
  else if (!t.endsWith('s')) out.add(`${t}s`);
  // FR : -eur / -eurs, -euse / -euses (approximation)
  if (t.endsWith('eurs') && t.length > 5) out.add(t.slice(0, -1));
  if (t.endsWith('eur') && t.length > 4) out.add(`${t}s`);
  if (t.endsWith('euses') && t.length > 6) out.add(t.slice(0, -1));
  if (t.endsWith('euse') && t.length > 5) out.add(`${t}s`);
  return [...out];
}

function haystackIncludesToken(hay = '', token = '') {
  if (!token) return true;
  if (hay.includes(token)) return true;
  return searchTokenVariants(token).some((v) => v !== token && hay.includes(v));
}

/**
 * Champs locaux indexés pour la recherche (aucun fetch distant) :
 * titre, auteur, source, établissement, région, extraits, crédits photo.
 */
function articleSearchFields(item = {}) {
  const { author: bylineAuthor, body } = splitByline(item);
  const author = resolveDisplayAuthor(item, bylineAuthor) || item.author || bylineAuthor || '';
  return {
    title: normalizeSearchText(cleanTitle(item.title || '')),
    author: normalizeSearchText(author),
    meta: normalizeSearchText([
      item.source || '',
      item.institution || '',
      item.region || '',
      item.type || '',
    ].join(' ')),
    body: normalizeSearchText([
      item.excerpt || '',
      item.leadExcerpt || '',
      body || '',
    ].join(' ')),
    credits: normalizeSearchText([
      item.imageCreator || '',
      item.sourceImageCreator || '',
      item.imageCredit || '',
      item.sourceImageCredit || '',
      item.imageTitle || '',
    ].join(' ')),
  };
}

function articleSearchHaystack(item = {}) {
  const f = articleSearchFields(item);
  return [f.title, f.author, f.meta, f.body, f.credits].filter(Boolean).join(' ');
}

function articleMatchesSearch(item, tokens) {
  if (!tokens.length) return true;
  const hay = articleSearchHaystack(item);
  return tokens.every((t) => haystackIncludesToken(hay, t));
}

/**
 * Score de pertinence : titre > auteur > source/inst. > extrait > crédits.
 * Utilisé pour classer les résultats (puis date décroissante en filet).
 */
function articleSearchScore(item, tokens) {
  if (!tokens.length) return 0;
  const f = articleSearchFields(item);
  let score = 0;
  for (const t of tokens) {
    if (haystackIncludesToken(f.title, t)) score += 100;
    else if (haystackIncludesToken(f.author, t)) score += 60;
    else if (haystackIncludesToken(f.meta, t)) score += 40;
    else if (haystackIncludesToken(f.body, t)) score += 20;
    else if (haystackIncludesToken(f.credits, t)) score += 10;
    else return 0;
  }
  const ts = Date.parse(item.date || '') || 0;
  // Bonus de fraîcheur très faible pour départager à score égal.
  score += Math.min(ts / 1e15, 0.99);
  return score;
}

function sortSearchResults(items, tokens) {
  return [...items].sort((a, b) => {
    const sb = articleSearchScore(b, tokens);
    const sa = articleSearchScore(a, tokens);
    if (sb !== sa) return sb - sa;
    return (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0);
  });
}

function getNewsSearchQuery() {
  return newsSearchQuery;
}

/*
 * Clavier virtuel : les éléments fixed ancrés en bas restent derrière le
 * clavier quand seul le viewport visuel rétrécit. On mesure la zone occluse
 * via visualViewport et on remonte le panneau d'autant (--vk-inset).
 */
function updateNewsSearchKeyboardInset() {
  if (!NEWS_SEARCH) return;
  const vv = window.visualViewport;
  if (!vv || !newsSearchOpen) {
    NEWS_SEARCH.style.removeProperty('--vk-inset');
    return;
  }
  const occluded = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  if (occluded > 1) {
    NEWS_SEARCH.style.setProperty('--vk-inset', `${Math.round(occluded)}px`);
  } else {
    NEWS_SEARCH.style.removeProperty('--vk-inset');
  }
}

function setNewsSearchOpen(open) {
  newsSearchOpen = !!open;
  if (!NEWS_SEARCH || !NEWS_SEARCH_TOGGLE || !NEWS_SEARCH_PANEL) return;

  NEWS_SEARCH.classList.toggle('is-open', newsSearchOpen);
  NEWS_SEARCH_TOGGLE.setAttribute('aria-expanded', newsSearchOpen ? 'true' : 'false');
  NEWS_SEARCH_PANEL.hidden = !newsSearchOpen;
  NEWS_SEARCH_PANEL.setAttribute('aria-hidden', newsSearchOpen ? 'false' : 'true');

  const loupe = NEWS_SEARCH_TOGGLE.querySelector('.news-search__fab-loupe');
  const close = NEWS_SEARCH_TOGGLE.querySelector('.news-search__fab-close');
  loupe?.classList.toggle('hidden', newsSearchOpen);
  close?.classList.toggle('hidden', !newsSearchOpen);

  if (newsSearchOpen) {
    // Focus après paint pour clavier mobile / lecteurs d'écran.
    requestAnimationFrame(() => {
      NEWS_SEARCH_INPUT?.focus({ preventScroll: true });
      NEWS_SEARCH_INPUT?.select?.();
    });
  }
  updateNewsSearchKeyboardInset();
}

function syncNewsSearchChrome() {
  const hasQuery = !!newsSearchQuery;
  NEWS_SEARCH?.classList.toggle('has-query', hasQuery);
  NEWS_SEARCH_CLEAR?.classList.toggle('hidden', !hasQuery);
  NEWS_SEARCH_TOGGLE?.classList.toggle('is-active', hasQuery);
  if (NEWS_SEARCH_HINT) {
    NEWS_SEARCH_HINT.textContent = hasQuery
      ? 'Filtre actif : titres, auteurs, sources, extraits et crédits (données déjà chargées).'
      : 'Recherche locale : titres, auteurs, sources, établissements, extraits et crédits photo.';
  }
}

function setNewsSearchQuery(raw, { render = true } = {}) {
  const next = String(raw || '').trim();
  if (next === newsSearchQuery) {
    syncNewsSearchChrome();
    return;
  }
  newsSearchQuery = next;
  syncNewsSearchChrome();
  if (render) renderNews();
}

/**
 * Efface la requête et restaure le fil complet (sans recharger la page).
 * — Bouton × du champ
 * — Icône X de la loupe quand une recherche est active
 * — Escape
 */
function clearNewsSearch({ keepOpen = true } = {}) {
  // Annuler un debounce encore en vol (sinon l'ancienne requête reviendrait).
  clearTimeout(newsSearchDebounce);
  newsSearchDebounce = null;
  if (NEWS_SEARCH_INPUT) NEWS_SEARCH_INPUT.value = '';
  const hadQuery = !!newsSearchQuery;
  newsSearchQuery = '';
  syncNewsSearchChrome();
  // Toujours re-rendre si on sort d'une recherche (layout une / en bref / suite).
  if (hadQuery) renderNews();
  if (keepOpen) {
    NEWS_SEARCH_INPUT?.focus({ preventScroll: true });
  } else {
    setNewsSearchOpen(false);
  }
}

function bindNewsSearch() {
  if (!NEWS_SEARCH_TOGGLE || !NEWS_SEARCH_INPUT) return;

  NEWS_SEARCH_TOGGLE.addEventListener('click', (e) => {
    e.stopPropagation();
    if (newsSearchOpen) {
      // X de la loupe : effacer la requête (= fin de recherche) + fermer le panneau.
      const hasQuery = !!(newsSearchQuery || String(NEWS_SEARCH_INPUT.value || '').trim());
      if (hasQuery) clearNewsSearch({ keepOpen: false });
      else setNewsSearchOpen(false);
    } else {
      setNewsSearchOpen(true);
    }
  });

  NEWS_SEARCH_INPUT.addEventListener('input', () => {
    const value = NEWS_SEARCH_INPUT.value;
    // Chrome immédiat (bouton ×) ; re-rendu filtré avec léger debounce.
    const trimmed = String(value || '').trim();
    NEWS_SEARCH_CLEAR?.classList.toggle('hidden', !trimmed);
    NEWS_SEARCH?.classList.toggle('has-query', !!trimmed);
    NEWS_SEARCH_TOGGLE?.classList.toggle('is-active', !!trimmed);
    clearTimeout(newsSearchDebounce);
    // Champ vidé à la main (ou via × natif type=search) → clear immédiat.
    if (!trimmed) {
      newsSearchDebounce = null;
      if (newsSearchQuery) {
        newsSearchQuery = '';
        syncNewsSearchChrome();
        renderNews();
      }
      return;
    }
    newsSearchDebounce = setTimeout(() => {
      setNewsSearchQuery(value, { render: true });
    }, 120);
  });

  NEWS_SEARCH_INPUT.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (newsSearchQuery || String(NEWS_SEARCH_INPUT.value || '').trim()) {
        clearNewsSearch({ keepOpen: true });
      } else {
        setNewsSearchOpen(false);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Appliquer tout de suite (sans attendre le debounce).
      clearTimeout(newsSearchDebounce);
      setNewsSearchQuery(NEWS_SEARCH_INPUT.value, { render: true });
      NEWS_SEARCH_INPUT.blur();
    }
  });

  // × dans le champ : effacer la requête, fil complet, panneau reste ouvert.
  NEWS_SEARCH_CLEAR?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearNewsSearch({ keepOpen: true });
  });

  // Clic extérieur : ferme le panneau loupe.
  // Important : un clic sur un résultat (dans #news-list) ne doit PAS effacer la
  // recherche au pointerdown — sinon le nœud <a.article> est détruit avant le click
  // et l'utilisateur n'atteint jamais l'article source.
  document.addEventListener('pointerdown', (e) => {
    if (!newsSearchOpen) return;
    if (NEWS_SEARCH?.contains(e.target)) return;
    // Résultat du fil : laisser le lien s'ouvrir ; on referme seulement le panneau.
    if (NEWS_LIST?.contains(e.target)) {
      setNewsSearchOpen(false);
      return;
    }
    const hasQuery = !!(newsSearchQuery || String(NEWS_SEARCH_INPUT?.value || '').trim());
    if (hasQuery) clearNewsSearch({ keepOpen: false });
    else setNewsSearchOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !newsSearchOpen) return;
    if (e.target === NEWS_SEARCH_INPUT) return; // géré sur l'input
    const hasQuery = !!(newsSearchQuery || String(NEWS_SEARCH_INPUT?.value || '').trim());
    if (hasQuery) clearNewsSearch({ keepOpen: false });
    else setNewsSearchOpen(false);
  });

  // Suivre l'apparition/disparition du clavier virtuel (mobile).
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateNewsSearchKeyboardInset);
    window.visualViewport.addEventListener('scroll', updateNewsSearchKeyboardInset);
  }

  // Raccourci « / » (comme beaucoup de docs) — hors champs de saisie.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
    if (!NEWS_LIST) return; // page sans fil
    e.preventDefault();
    setNewsSearchOpen(true);
  });

  syncNewsSearchChrome();
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
  const tokens = searchTokens(newsSearchQuery);
  const isSearchView = tokens.length > 0;

  let items = isSourceView
    ? news.filter(n => n.source === newsSourceFilter)
    : news;
  if (isSearchView) {
    items = items.filter((n) => articleMatchesSearch(n, tokens));
  }

  NEWS_EMPTY.classList.toggle('hidden', items.length > 0);
  if (NEWS_EMPTY) {
    const emptyP = NEWS_EMPTY.querySelector('p');
    if (emptyP) {
      if (isSearchView && !items.length) {
        emptyP.textContent = `Aucun résultat pour « ${newsSearchQuery} ».`;
      } else {
        emptyP.textContent = 'Aucun article pour le moment.';
      }
    }
  }

  const countLabel = isSearchView
    ? `${items.length} résultat${items.length !== 1 ? 's' : ''}`
    : `${items.length} article${items.length !== 1 ? 's' : ''}`;
  NEWS_COUNT.textContent = countLabel;

  NEWS_LIST.innerHTML = '';
  if (isSearchView) {
    NEWS_LIST.dataset.mode = 'search';
  } else if (isSourceView) {
    NEWS_LIST.dataset.mode = 'source';
  } else {
    NEWS_LIST.removeAttribute('data-mode');
  }

  // Mode recherche (loupe) : liste plate, tous les résultats visibles.
  // Pas de suite du fil ni de « Plus d'articles » — le repli ne s'applique pas.
  if (isSearchView) {
    NEWS_LIST.removeAttribute('data-contingency');
    NEWS_LIST.removeAttribute('data-autumn-grace');
    NEWS_LIST.removeAttribute('data-brief-count');
    NEWS_LIST.removeAttribute('data-hero');
    newsTailExpanded = false;

    if (items.length) {
      const section = document.createElement('div');
      section.className = 'news-search-results';
      const qEsc = escapeHtml(newsSearchQuery);
      section.innerHTML = `<h3 class="news-search-results__title">Résultats pour « ${qEsc} »</h3>`;
      sortSearchResults(items, tokens).forEach((item) => {
        const article = safeCreateArticle(item, 'standard');
        if (article) section.appendChild(article);
      });
      NEWS_LIST.appendChild(section);
    }
    return;
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
    section.innerHTML = '<h3 class="news-tail-title">Suite du fil</h3><div class="news-tail-body"></div>';
    const body = section.querySelector('.news-tail-body');
    tail.forEach((article) => body.appendChild(article));
    NEWS_LIST.appendChild(section);
  }

  const briefCount = compacts.length;
  if (briefCount) NEWS_LIST.dataset.briefCount = String(briefCount);
  else NEWS_LIST.removeAttribute('data-brief-count');

  // Nouveau rendu : replier la suite sauf si l'utilisateur l'avait déjà ouverte
  // (conservé via newsTailExpanded entre rebalances, reset sur filtre/recherche).
  syncNewsTailCollapse({ preserveExpanded: false });

  updateNewsLayout();
  // Équilibre magazine : combler le vide sous vedettes et/ou sous En bref.
  scheduleMagazineColumnBalance();
}

/** Aperçu de la rangée suivante (titres lisibles), comme --filters-peek. */
const NEWS_TAIL_PEEK_PX = 34;

function ensureNewsTailBody(tail) {
  if (!tail) return null;
  let body = tail.querySelector('.news-tail-body');
  if (body) return body;
  body = document.createElement('div');
  body.className = 'news-tail-body';
  const title = tail.querySelector('.news-tail-title');
  const toggle = tail.querySelector('.news-tail-toggle');
  const loose = [...tail.querySelectorAll(':scope > .article, :scope > a.article')];
  loose.forEach((el) => body.appendChild(el));
  if (toggle) tail.insertBefore(body, toggle);
  else if (title) title.insertAdjacentElement('afterend', body);
  else tail.appendChild(body);
  return body;
}

function getNewsTailCards(tail) {
  const body = ensureNewsTailBody(tail);
  if (!body) return [];
  return [...body.querySelectorAll(':scope > .article, :scope > a.article')];
}

/**
 * Hauteur repliée = bas du 10e article + peek (titres de la rangée d’après).
 */
function measureNewsTailCollapsedHeight(body, cards, visibleCount, peekPx) {
  if (!body || !cards.length) return 0;
  const lastIdx = Math.min(visibleCount, cards.length) - 1;
  const last = cards[lastIdx];
  if (!last) return 0;
  const bodyTop = body.getBoundingClientRect().top;
  const lastBottom = last.getBoundingClientRect().bottom;
  const h = lastBottom - bodyTop + peekPx;
  return Math.max(0, Math.ceil(h));
}

function applyNewsTailCollapsedHeight(tail) {
  const body = tail?.querySelector('.news-tail-body');
  if (!body || !tail.classList.contains('has-overflow') || tail.classList.contains('is-expanded')) {
    body?.style.removeProperty('--news-tail-collapsed-h');
    body?.style.removeProperty('max-height');
    return;
  }
  const cards = getNewsTailCards(tail);
  // Mesure avec tous les articles en layout (pas display:none)
  const h = measureNewsTailCollapsedHeight(body, cards, NEWS_TAIL_VISIBLE, NEWS_TAIL_PEEK_PX);
  if (h > 0) {
    body.style.setProperty('--news-tail-collapsed-h', `${h}px`);
    body.style.maxHeight = `${h}px`;
  }
}

/**
 * Replie la Suite du fil après NEWS_TAIL_VISIBLE articles (comme « Plus de sources »).
 * Aperçu des titres de la rangée suivante + fondu, puis bouton.
 * Ne s'applique jamais à la recherche (liste plate, pas de .news-tail).
 */
function syncNewsTailCollapse({ preserveExpanded = true } = {}) {
  // Recherche loupe : résultats plats, aucun repli.
  if (NEWS_LIST?.dataset.mode === 'search') return;

  const tail = NEWS_LIST?.querySelector('.news-tail');
  if (!tail) return;

  const body = ensureNewsTailBody(tail);
  const cards = getNewsTailCards(tail);
  const overflow = cards.length > NEWS_TAIL_VISIBLE;

  // Overflow : pas de display:none (peek des titres). Marque pour le module
  // de traduction : ne pas MT les cartes *entièrement* hors écran, mais
  // traduire la rangée peek (titres partiels visibles sous le fondu).
  cards.forEach((el, i) => {
    el.classList.remove('news-tail-article--overflow');
    const pastFull = overflow && !newsTailExpanded && i >= NEWS_TAIL_VISIBLE;
    const pastPeek = overflow && !newsTailExpanded
      && i >= NEWS_TAIL_VISIBLE + NEWS_TAIL_PEEK_TRANSLATE;
    el.classList.toggle('is-tail-overflow', pastFull);
    // data-translate-skip = hors zone visible + peek uniquement
    if (pastPeek) el.setAttribute('data-translate-skip', '1');
    else el.removeAttribute('data-translate-skip');
  });

  let toggle = tail.querySelector('.news-tail-toggle');
  if (overflow) {
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'news-tail-toggle';
      toggle.innerHTML = '<span class="news-tail-toggle__label">Plus d\'articles</span>';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        const willExpand = !newsTailExpanded;
        // Mémoriser la position du bouton : à l’ouverture le body s’allonge
        // *au-dessus* du bouton et le navigateur scrolle pour le garder focusé
        // → bas de page. On fige le scroll viewport.
        const yBefore = window.scrollY || window.pageYOffset || 0;
        const toggleTopBefore = toggle.getBoundingClientRect().top;

        newsTailExpanded = willExpand;
        syncNewsTailCollapse({ preserveExpanded: true });

        // Traduire les cartes nouvellement visibles seulement au dépliage
        // (évite de MT toute la suite du fil au choix de langue).
        if (willExpand && typeof window.RadarTranslate?.onNewsTailExpand === 'function') {
          window.setTimeout(() => window.RadarTranslate.onNewsTailExpand(), 0);
        }

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (willExpand) {
              // Contenu s’ouvre vers le bas : rester où on était (ne pas suivre le bouton)
              window.scrollTo({ top: yBefore, left: 0, behavior: 'auto' });
            } else {
              // Repli : garder le bouton à la même place à l’écran
              const delta = toggle.getBoundingClientRect().top - toggleTopBefore;
              if (Math.abs(delta) > 1) {
                window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
              }
            }
          });
        });
      });
      tail.appendChild(toggle);
    }
    tail.classList.add('has-overflow');
    if (!preserveExpanded) newsTailExpanded = false;
    tail.classList.toggle('is-expanded', newsTailExpanded);
    tail.dataset.tailVisible = String(NEWS_TAIL_VISIBLE);
    tail.dataset.tailPeekTranslate = String(NEWS_TAIL_PEEK_TRANSLATE);
    const label = toggle.querySelector('.news-tail-toggle__label');
    const hidden = cards.length - NEWS_TAIL_VISIBLE;
    if (label) {
      label.textContent = newsTailExpanded
        ? 'Réduire'
        : `Plus d'articles (${hidden})`;
    }
    toggle.setAttribute('aria-expanded', newsTailExpanded ? 'true' : 'false');

    // max-height après paint (grille 1 ou 2 colonnes)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (newsTailExpanded) {
          body.style.maxHeight = 'none';
          body.style.removeProperty('--news-tail-collapsed-h');
        } else {
          applyNewsTailCollapsedHeight(tail);
        }
      });
    });
  } else {
    tail.classList.remove('has-overflow', 'is-expanded');
    body.style.maxHeight = 'none';
    body.style.removeProperty('--news-tail-collapsed-h');
    toggle?.remove();
    if (!preserveExpanded) newsTailExpanded = false;
  }
}

function updateNewsLayout() {
  const lead = NEWS_LIST.querySelector('.article--lead');
  if (!lead) {
    NEWS_LIST.removeAttribute('data-hero');
    return;
  }
  NEWS_LIST.dataset.hero = lead.classList.contains('has-image') ? 'image' : 'text';
}

/*
 * Partition magazine — anti « chaise musicale » :
 *
 *  A) SNAPSHOT figé :
 *     - Une + vedettes = toujours les 5 plus frais (1+4) — *jamais* touché au fill
 *     - En bref = graine ~ hauteur estimée du hero (1 / institution)
 *     - Suite = le reste
 *
 *  B) ÉQUILIBRE (≥1100px) — *seulement* la colonne En bref :
 *     1) TRIM si trop haute (→ suite)
 *     2) FILL si trop basse (depuis réserve, sans dépasser)
 *     Le spacer absorbe le reste (tolérance large). Pas de promote vedette,
 *     pas d’allers-retours entre colonnes.
 */
const HERO_FEATURE_MIN = 4; /* 4 vedettes + 1 une = 5 */
const HERO_FEATURE_MAX = 4;
const HERO_SPOTLIGHT_MAX = 1 + HERO_FEATURE_MIN; /* 5 au total */
const BRIEF_SIDEBAR_SEED_MIN = 4;
const BRIEF_SIDEBAR_SEED_MAX = 12;
const BRIEF_SIDEBAR_MAX = 18;
const BRIEF_SIDEBAR_HARD_MIN = 2; /* plancher trim — au-dessous on accepte le vide */
const BRIEF_SIDEBAR_MIN = BRIEF_SIDEBAR_SEED_MIN;
const AVG_LEAD_CARD_H = 400;
const AVG_FEATURE_CARD_H = 148;
const AVG_BRIEF_CARD_H = 108;
const AVG_BRIEF_TITLE_H = 42;
/* Marge volontaire : mieux un petit spacer qu’une chaise musicale. */
const COLUMN_HEIGHT_TOL = 96;
/* Vue source : 1 une + jusqu’à 2 vedettes (fraîcheur), puis En bref / suite. */
const SOURCE_FEATURE_MAX = 2;
const SOURCE_HERO_SPOTLIGHT_MAX = 1 + SOURCE_FEATURE_MAX;

function estimateHeroSeedHeight(heroCount) {
  if (heroCount <= 0) return 0;
  return AVG_LEAD_CARD_H + Math.max(0, heroCount - 1) * AVG_FEATURE_CARD_H;
}

/**
 * Graine En bref ≈ hauteur hero estimée.
 * @param {number} heroCount
 * @param {{ sourceMode?: boolean }} [opts] — vue source : une image + vedettes
 *   sous-estiment souvent la hauteur réelle → graine un peu plus haute.
 */
function briefSeedCountForHero(heroCount, opts = {}) {
  const sourceMode = !!opts.sourceMode;
  const target = Math.max(0, estimateHeroSeedHeight(heroCount) - AVG_BRIEF_TITLE_H);
  // Source : un peu au-dessus de l’estimé (images), sans graine trop haute
  // (sinon 1 carte de trop en En bref après paint).
  const mult = sourceMode ? 1.45 : 1;
  const n = Math.round((target * mult) / AVG_BRIEF_CARD_H);
  const min = sourceMode
    ? Math.max(BRIEF_SIDEBAR_SEED_MIN, 5)
    : BRIEF_SIDEBAR_SEED_MIN;
  const max = sourceMode
    ? Math.min(BRIEF_SIDEBAR_MAX, BRIEF_SIDEBAR_SEED_MAX + 2)
    : BRIEF_SIDEBAR_SEED_MAX;
  return Math.min(max, Math.max(min, n));
}

/** Réserve = suite du fil (date desc) pour le fill B uniquement. */
let magazineReserve = [];
let magazineBalanceTimer = 0;
let magazineBalanceBusy = false;
/** True si un rebalance a été demandé pendant qu'un fill tournait. */
let magazineBalanceQueued = false;
const magazineMeta = {
  heroKeys: new Set(),
  heroSources: new Set(),
  heroInsts: new Set(),
  briefKeys: new Set(),
  briefSources: new Set(),
  briefInsts: new Set(),
};
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

function itemHasThumbPhoto(item) {
  return hasUsablePhoto(item, 'feature') || hasStockPhoto(item, 'feature');
}

function isArticlePicked(item, picks) {
  const key = articleKey(item);
  return picks.some((pick) => articleKey(pick) === key);
}

/**
 * À la une + vedettes — **strictement par date** sur le pool déjà filtré frais.
 * (filterFreshItems a déjà appliqué la fenêtre 3 sessions ; pas de bande
 * intermédiaire qui re-trierait autrement.)
 * - Une = sorted[0] (le plus récent de tout le fil)
 * - Vedettes = sorted[1..n] (même source OK)
 * Ainsi on n'aura jamais un 12 mai en une/vedette tant qu'un 10 juil. reste
 * dans la suite du fil.
 */
function pickHeroSpotlight(items, _referenceDate = new Date()) {
  const sorted = sortByDateDesc(items);
  if (!sorted.length) {
    return { items: [], contingencyBand: 0 };
  }
  const n = Math.min(HERO_SPOTLIGHT_MAX, sorted.length);
  // Tranche contiguë des n plus frais — pas de saut d'institution.
  return {
    items: sorted.slice(0, n),
    contingencyBand: 0,
  };
}

/**
 * En bref : 1 article le plus frais par *institution*, hors hero.
 *
 * Règle multi-sources : si une institution a déjà un article à la une ou
 * en vedette (featured), elle n’entre pas en En bref — la place est laissée
 * aux autres campus. L’ordre des picks reste la fraîcheur (date desc).
 *
 * Limité au haut du fil restant (pool cap) pour éviter de hisser un billet
 * de mai (seule pub d’une institution) au-dessus de juillet via un trim
 * En bref → tête de suite.
 * @param {number} [maxSlots] — graine estimée ou plafond fill
 */
function pickBriefSidebar(allItems, heroItems = [], _referenceDate = new Date(), maxSlots = null) {
  const heroKeys = new Set(heroItems.map(articleKey));
  // Institutions déjà représentées en une / vedettes → absentes d’En bref
  const heroInsts = new Set(heroItems.map(institutionKey).filter(Boolean));
  const sorted = sortByDateDesc(allItems);
  const remaining = sorted.filter((item) => !heroKeys.has(articleKey(item)));
  // Si non précisé : caler le nombre sur la hauteur estimée du hero.
  const limit = Math.max(
    1,
    maxSlots == null ? briefSeedCountForHero(heroItems.length) : maxSlots,
  );
  // Candidats = haut du reste du fil seulement (pas tout l’historique frais).
  // Cap un peu plus large : l’exclusion d’institutions hero réduit le pool utile.
  const poolCap = Math.max(limit * 10, 48);
  const pool = remaining.slice(0, poolCap);

  const picks = [];
  const usedInsts = new Set();

  for (const item of pool) {
    if (picks.length >= limit) break;
    const inst = institutionKey(item);
    if (!inst) continue;
    if (heroInsts.has(inst)) continue;
    if (usedInsts.has(inst)) continue;
    picks.push(item);
    usedInsts.add(inst);
  }

  // Fraîcheur : re-trier les picks retenus (le parcours pool est déjà date desc,
  // mais on garantit l’ordre d’affichage).
  return {
    items: sortByDateDesc(picks),
    contingencyBand: 0,
  };
}

/**
 * Filet d'invariants après partition / fill :
 * - la une = article le plus frais du pool global
 * - aucune vedette plus ancienne qu'un article encore en suite du fil
 *   qui pourrait la remplacer dans le top-N hero
 * (réordonne hero en tranche contiguë des |hero| plus frais du pool).
 */
function enforceHeroDateOrder(heroItems, allSorted) {
  if (!heroItems?.length || !allSorted?.length) return heroItems || [];
  const n = Math.min(Math.max(heroItems.length, HERO_SPOTLIGHT_MAX), allSorted.length);
  // Toujours les n plus frais du fil pour le bloc une+vedettes.
  return allSorted.slice(0, n);
}

function resetMagazineMeta(heroItems = [], briefItems = []) {
  magazineMeta.heroKeys = new Set(heroItems.map(articleKey));
  magazineMeta.heroSources = new Set(heroItems.map(sourceKey));
  magazineMeta.heroInsts = new Set(heroItems.map(institutionKey));
  magazineMeta.briefKeys = new Set(briefItems.map(articleKey));
  magazineMeta.briefSources = new Set(briefItems.map(sourceKey));
  magazineMeta.briefInsts = new Set(briefItems.map(institutionKey));
}

function partitionNewsFeed(items, referenceDate = new Date()) {
  // Pool unique, date desc — seule source de vérité pour l'ordre de fraîcheur.
  const sorted = sortByDateDesc(filterFreshItems(items, referenceDate));
  const { items: rawHero, contingencyBand: heroBand } = pickHeroSpotlight(sorted, referenceDate);
  // Filet : une + vedettes = toujours les |n| plus frais du pool.
  const heroItems = enforceHeroDateOrder(
    ensureHeroLeadHasImage(rawHero, sorted),
    sorted,
  );
  // Graine En bref ≈ hauteur estimée du hero ; le fill ne touche qu'à En bref.
  const briefSeed = briefSeedCountForHero(heroItems.length);
  const { items: briefItems, contingencyBand: briefBand } = pickBriefSidebar(
    sorted,
    heroItems,
    referenceDate,
    briefSeed,
  );
  const heroKeys = new Set(heroItems.map(articleKey));
  const briefClean = briefItems.filter((i) => !heroKeys.has(articleKey(i)));
  const briefKeysClean = new Set(briefClean.map(articleKey));
  const tailItems = sorted.filter(
    (i) => !heroKeys.has(articleKey(i)) && !briefKeysClean.has(articleKey(i)),
  );
  // Réserve pour le fill magazine (phase B)
  magazineReserve = tailItems.slice();
  resetMagazineMeta(heroItems, briefClean);
  const contingencyBand = Math.max(heroBand, briefBand);
  return { heroItems, briefItems: briefClean, tailItems, contingencyBand };
}

/**
 * Bureau magazine ≥1100px : fil global *et* vue source.
 * (Recherche = liste plate — pas d’équilibre colonnes.)
 */
function canBalanceMagazineColumns() {
  if (!NEWS_LIST) return false;
  if (NEWS_LIST.dataset.mode === 'search') return false;
  return window.matchMedia('(min-width: 1100px)').matches;
}

function removeTailArticleForItem(item) {
  const tail = NEWS_LIST?.querySelector('.news-tail');
  if (!tail || !item) return;
  const link = safeHttpUrl(item.link);
  const title = cleanTitle(item.title || '');
  const body = ensureNewsTailBody(tail);
  const nodes = body
    ? [...body.querySelectorAll('.article')]
    : [...tail.querySelectorAll('.article')];
  for (const node of nodes) {
    const href = node.getAttribute?.('href') || node.href || '';
    const nodeTitle = node.querySelector('.article-title')?.textContent?.trim() || '';
    if ((link && href === link) || (title && nodeTitle === title)) {
      node.remove();
      break;
    }
  }
  const remaining = (body || tail).querySelectorAll('.article');
  if (!remaining.length) {
    tail.remove();
  } else {
    syncNewsTailCollapse({ preserveExpanded: true });
  }
}

/**
 * Prochain En bref depuis la réserve (date desc) :
 *  1) nouvelle institution, **hors** institutions déjà en une / vedette
 *  2) filet anti-vide (allowExtra) : encore hors une/vedette, même si l’institution
 *     est déjà en En bref — jamais une institution hero (place aux autres campus)
 */
function takeNextBriefFromReserve({ allowExtra = false } = {}) {
  if (!magazineReserve.length) return null;

  const notHeroInst = (item) => {
    const inst = institutionKey(item);
    return !inst || !magazineMeta.heroInsts.has(inst);
  };

  const tryPick = (pred) => {
    const idx = magazineReserve.findIndex((item) => {
      const key = articleKey(item);
      if (magazineMeta.heroKeys.has(key) || magazineMeta.briefKeys.has(key)) return false;
      if (!notHeroInst(item)) return false;
      return pred(item);
    });
    if (idx < 0) return null;
    return magazineReserve.splice(idx, 1)[0];
  };

  // 1) Nouvelle institution (pas encore en En bref, pas en une/vedette)
  const freshInst = tryPick((item) => !magazineMeta.briefInsts.has(institutionKey(item)));
  if (freshInst) return freshInst;

  // 2) Filet hauteur : d’autres articles d’institutions non-hero seulement
  if (allowExtra) {
    return tryPick(() => true);
  }
  return null;
}

/**
 * Prochain vedette : le plus frais de la réserve (même source OK).
 * La réserve est triée date desc → index 0 = plus frais restant.
 */
function takeNextFeatureFromReserve() {
  if (!magazineReserve.length) return null;
  // Toujours le plus frais restant (tête de file).
  while (magazineReserve.length) {
    const item = magazineReserve.shift();
    const key = articleKey(item);
    if (magazineMeta.heroKeys.has(key) || magazineMeta.briefKeys.has(key)) continue;
    return item;
  }
  return null;
}

function markPromotedToHero(item) {
  magazineMeta.heroKeys.add(articleKey(item));
  magazineMeta.heroSources.add(sourceKey(item));
  magazineMeta.heroInsts.add(institutionKey(item));
}

function markPromotedToBrief(item) {
  magazineMeta.briefKeys.add(articleKey(item));
  magazineMeta.briefSources.add(sourceKey(item));
  magazineMeta.briefInsts.add(institutionKey(item));
}

function rebuildBriefMetaFromDom(brief) {
  magazineMeta.briefKeys = new Set();
  magazineMeta.briefSources = new Set();
  magazineMeta.briefInsts = new Set();
  brief?.querySelectorAll('.article--compact').forEach((el) => {
    const item = el.__radarItem;
    if (!item) return;
    magazineMeta.briefKeys.add(articleKey(item));
    magazineMeta.briefSources.add(sourceKey(item));
    magazineMeta.briefInsts.add(institutionKey(item));
  });
}

function clearMagazineSpacers(root) {
  root?.querySelectorAll('.news-hero-spacer, .brief-rail-spacer').forEach((n) => n.remove());
}

function ensureMagazineColumnSpacers(hero, brief) {
  clearMagazineSpacers(hero);
  clearMagazineSpacers(brief);
  const hs = document.createElement('div');
  hs.className = 'news-hero-spacer';
  hs.setAttribute('aria-hidden', 'true');
  hero.appendChild(hs);
  const bs = document.createElement('div');
  bs.className = 'brief-rail-spacer';
  bs.setAttribute('aria-hidden', 'true');
  brief.appendChild(bs);
}

function appendBeforeMagazineSpacer(column, el) {
  if (!column || !el) return;
  const spacer = column.querySelector('.news-hero-spacer, .brief-rail-spacer');
  if (spacer) column.insertBefore(el, spacer);
  else column.appendChild(el);
}

/**
 * Hauteur du *contenu* (hors spacer). Pas offsetHeight de la cellule stretchée.
 */
function magazineColumnContentHeight(col) {
  if (!col) return 0;
  let h = 0;
  for (const child of col.children) {
    if (
      child.classList?.contains('news-hero-spacer')
      || child.classList?.contains('brief-rail-spacer')
    ) {
      continue;
    }
    const style = getComputedStyle(child);
    const mt = parseFloat(style.marginTop) || 0;
    const mb = parseFloat(style.marginBottom) || 0;
    h += child.offsetHeight + mt + mb;
  }
  const cs = getComputedStyle(col);
  h += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return h;
}

/** Retrouve un item news depuis une carte DOM (href / titre). */
function resolveItemFromCard(cardEl) {
  if (!cardEl) return null;
  if (cardEl.__radarItem) return cardEl.__radarItem;
  const href = cardEl.getAttribute?.('href') || cardEl.href || '';
  const title = cardEl.querySelector?.('.article-title')?.textContent?.trim() || '';
  const match = (it) => {
    const link = safeHttpUrl(it.link) || it.link || '';
    return (href && link && href === link)
      || (title && cleanTitle(it.title || '') === title);
  };
  const fromReserve = magazineReserve.find(match);
  if (fromReserve) return fromReserve;
  if (Array.isArray(news)) {
    const fromNews = news.find(match);
    if (fromNews) return fromNews;
  }
  return null;
}

/**
 * Insère une carte dans la suite du fil en respectant l’ordre date desc.
 * (Ne jamais prepend : un trim En bref d’un vieux billet UQTR/mai se
 * retrouvait sinon en tête de suite, au-dessus de juillet.)
 */
function insertTailArticleByDate(body, el, item) {
  if (!body || !el) return;
  const itemTs = Date.parse(item?.date || '') || 0;
  const cards = [...body.querySelectorAll(':scope > .article, :scope > a.article')];
  for (const card of cards) {
    const other = card.__radarItem;
    const otherTs = Date.parse(other?.date || '') || 0;
    if (itemTs > otherTs) {
      body.insertBefore(el, card);
      return;
    }
  }
  body.appendChild(el);
}

/** Réordonne le corps de la suite du fil (date desc) — filet anti-dérive. */
function sortNewsTailBodyByDate(tail) {
  const body = ensureNewsTailBody(tail);
  if (!body) return;
  const cards = [...body.querySelectorAll(':scope > .article, :scope > a.article')];
  if (cards.length < 2) return;
  cards.sort((a, b) => {
    const da = Date.parse(a.__radarItem?.date || '') || 0;
    const db = Date.parse(b.__radarItem?.date || '') || 0;
    if (db !== da) return db - da;
    // Stable-ish : titre en filet
    const ta = a.querySelector?.('.article-title')?.textContent || '';
    const tb = b.querySelector?.('.article-title')?.textContent || '';
    return ta.localeCompare(tb, 'fr');
  });
  cards.forEach((c) => body.appendChild(c));
}

/**
 * Remet un article En bref dans la suite du fil + réserve.
 */
function demoteBriefCardToTail(brief, cardEl) {
  if (!cardEl || !brief) return false;
  const item = resolveItemFromCard(cardEl);
  if (!item) return false;

  cardEl.remove();
  magazineMeta.briefKeys.delete(articleKey(item));
  rebuildBriefMetaFromDom(brief);
  magazineReserve.push(item);
  magazineReserve = sortByDateDesc(magazineReserve);

  let tail = NEWS_LIST.querySelector('.news-tail');
  if (!tail) {
    tail = document.createElement('div');
    tail.className = 'news-tail';
    tail.innerHTML = '<h3 class="news-tail-title">Suite du fil</h3>';
    NEWS_LIST.appendChild(tail);
  }
  removeTailArticleForItem(item);
  const el = safeCreateArticle(item, 'standard');
  if (el) {
    const body = ensureNewsTailBody(tail);
    insertTailArticleByDate(body, el, item);
  }
  sortNewsTailBodyByDate(tail);
  syncNewsTailCollapse({ preserveExpanded: true });
  return true;
}

/**
 * Équilibre magazine — uniquement En bref (hero figé snapshot).
 * Ordre strict : TRIM d’abord, puis FILL. Jamais les deux en boucle croisée.
 * Vue source : fill agressif (même institution) pour coller à la une+vedettes.
 */
function balanceMagazineColumns() {
  if (!canBalanceMagazineColumns()) return;
  if (magazineBalanceBusy) {
    magazineBalanceQueued = true;
    return;
  }

  const hero = NEWS_LIST.querySelector('.news-hero');
  const brief = NEWS_LIST.querySelector('.brief-rail');
  if (!hero || !brief) return;

  magazineBalanceBusy = true;
  magazineBalanceQueued = false;
  const isSourceMode = NEWS_LIST.dataset.mode === 'source';
  // Tolérance : petit spacer OK ; 1 carte de trop (overshoot) non.
  const tol = isSourceMode ? 56 : COLUMN_HEIGHT_TOL;
  const hardMin = isSourceMode ? 2 : BRIEF_SIDEBAR_HARD_MIN;

  const trimBriefIfTaller = () => {
    let guard = 0;
    while (guard < 28) {
      guard += 1;
      const hH = magazineColumnContentHeight(hero);
      const bH = magazineColumnContentHeight(brief);
      if (bH <= hH + tol) break;
      const cards = brief.querySelectorAll('.article--compact');
      if (cards.length <= hardMin) break;
      if (!demoteBriefCardToTail(brief, cards[cards.length - 1])) break;
    }
  };

  try {
    clearMagazineSpacers(hero);
    clearMagazineSpacers(brief);

    // --- 1) TRIM : En bref trop haute → retirer la dernière carte ---
    trimBriefIfTaller();

    // --- 2) FILL : En bref trop basse → ajouter (sans dépasser) ---
    // Vue source : allowExtra (une seule institution / source).
    let fillGuard = 0;
    const maxFill = isSourceMode ? 40 : 24;
    while (fillGuard < maxFill) {
      fillGuard += 1;
      const hH = magazineColumnContentHeight(hero);
      const bH = magazineColumnContentHeight(brief);
      const gap = hH - bH;
      if (gap <= tol) break;

      const briefCount = brief.querySelectorAll('.article--compact').length;
      if (briefCount >= BRIEF_SIDEBAR_MAX || !magazineReserve.length) break;

      let item = takeNextBriefFromReserve({ allowExtra: isSourceMode });
      if (!item) item = takeNextBriefFromReserve({ allowExtra: true });
      if (!item) break;

      const el = safeCreateArticle(item, 'compact');
      if (!el) break;
      appendBeforeMagazineSpacer(brief, el);

      const afterBrief = magazineColumnContentHeight(brief);
      const afterHero = magazineColumnContentHeight(hero);
      const overshoot = afterBrief - afterHero;

      if (overshoot > tol) {
        // Uniquement garder si le dépassement est *plus petit* que le trou
        // qu’on comblait (net gain). Sinon → suite (évite 1 carte de trop).
        if (gap > overshoot) {
          markPromotedToBrief(item);
          removeTailArticleForItem(item);
        } else {
          demoteBriefCardToTail(brief, el);
        }
        break;
      }
      markPromotedToBrief(item);
      removeTailArticleForItem(item);
    }

    // --- 3) TRIM final (images / fill ont pu dépasser d’une carte) ---
    trimBriefIfTaller();

    ensureMagazineColumnSpacers(hero, brief);
  } finally {
    window.setTimeout(() => {
      magazineBalanceBusy = false;
      if (magazineBalanceQueued) {
        magazineBalanceQueued = false;
        balanceMagazineColumns();
      }
    }, 120);
  }

  const briefCount = brief.querySelectorAll('.article--compact').length;
  if (briefCount) NEWS_LIST.dataset.briefCount = String(briefCount);
  else NEWS_LIST.removeAttribute('data-brief-count');
  // Filet : après trim/fill, la suite doit rester en date décroissante.
  const tail = NEWS_LIST.querySelector('.news-tail');
  if (tail) sortNewsTailBodyByDate(tail);
  syncNewsTailCollapse({ preserveExpanded: true });
  updateNewsLayout();
  bindMagazineImageBalanceOnce();
}

/** Compteur de passes post-rendu (évite rebalance infini). */
let magazineBalancePasses = 0;
const MAGAZINE_BALANCE_PASS_CAP = 4;

function scheduleMagazineColumnBalance() {
  clearTimeout(magazineBalanceTimer);
  magazineBalancePasses = 0;
  magazineBalanceTimer = window.setTimeout(() => {
    magazineBalancePasses = 1;
    balanceMagazineColumns();
    // Passes retardées : layout puis images (vue source = colonnes à coller).
    window.setTimeout(() => {
      magazineBalancePasses = Math.max(magazineBalancePasses, 2);
      balanceMagazineColumns();
    }, 450);
    window.setTimeout(() => {
      magazineBalancePasses = Math.max(magazineBalancePasses, 3);
      balanceMagazineColumns();
    }, 1100);
    // 4e passe tardive : images une/vedettes souvent lentes en vue source.
    window.setTimeout(() => {
      magazineBalancePasses = Math.max(magazineBalancePasses, 4);
      balanceMagazineColumns();
    }, 2200);
  }, 80);
}

function bindMagazineImageBalanceOnce() {
  if (!NEWS_LIST) return;
  NEWS_LIST.querySelectorAll('.news-hero img, .brief-rail img').forEach((img) => {
    if (img.dataset.magazineBalanceBound) return;
    img.dataset.magazineBalanceBound = '1';
    if (img.complete) return;
    const once = () => {
      img.removeEventListener('load', once);
      img.removeEventListener('error', once);
      if (magazineBalancePasses >= MAGAZINE_BALANCE_PASS_CAP) return;
      clearTimeout(magazineBalanceTimer);
      magazineBalanceTimer = window.setTimeout(() => {
        magazineBalancePasses = Math.min(
          MAGAZINE_BALANCE_PASS_CAP,
          Math.max(magazineBalancePasses + 1, 2),
        );
        balanceMagazineColumns();
      }, 180);
    };
    img.addEventListener('load', once);
    img.addEventListener('error', once);
  });
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
 * Ordre de fraîcheur strict dans chaque section (pool déjà date desc) :
 *  - Une + vedettes = tranche contiguë des plus frais (1 une + ≤2 vedettes)
 *  - En bref = suite chronologique (graine ≈ hauteur hero)
 *  - Suite du fil = le reste
 * Pas de 4 vedettes comme le fil global (évite le « double look » vs En bref
 * sur mobile) ; 1–2 features suffisent sous la une d’un seul média.
 */
function partitionSourceFeed(items, referenceDate = new Date()) {
  const sorted = sortByDateDesc(items);
  const { items: pool, contingencyBand } = collectSourcePool(sorted, referenceDate);
  // Tranche contiguë des plus frais → une = pool[0], vedettes = pool[1..n]
  const heroN = Math.min(SOURCE_HERO_SPOTLIGHT_MAX, pool.length);
  const heroItems = pool.slice(0, heroN);
  const heroKeys = new Set(heroItems.map(articleKey));
  const rest = pool.filter((item) => !heroKeys.has(articleKey(item)));
  // Graine En bref calée sur la hauteur hero (une+vedettes), un peu plus
  // généreuse en vue source pour coller dès le snapshot.
  const briefSeed = briefSeedCountForHero(Math.max(1, heroItems.length), {
    sourceMode: true,
  });
  const briefItems = rest.slice(0, briefSeed);
  const briefKeys = new Set(briefItems.map(articleKey));
  const tailItems = rest.filter((item) => !briefKeys.has(articleKey(item)));
  // Réserve + meta pour le fill/trim En bref (balanceMagazineColumns).
  magazineReserve = tailItems.slice();
  resetMagazineMeta(heroItems, briefItems);
  const lead = heroItems[0] || null;
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
  // Référence pour promote/demote magazine (fill / trim En bref)
  a.__radarItem = item;
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
  // « Par »/« By » se traduit (UI) ; le nom d’auteur reste en original (notranslate).
  // Espace garanti en CSS (.article-author) : la trad du libellé mange l’espace final.
  const bylineHtml = `<p class="article-byline"><span class="article-byline__label">${escapeHtml(byLabel)}</span><strong class="article-author notranslate" translate="no">${escapeHtml(displayAuthor)}</strong></p>`;
  const titleHtml = `<h3 class="article-title">${escapeHtml(cleanTitle(item.title))}</h3>`;
  const mediaHtml = hasImageCandidate ? '<figure class="article-media"></figure>' : '';
  if (role === 'lead') {
    // Titre au-dessus de l'image : eyebrow → meta → titre → photo → byline → extrait
    a.innerHTML = `
      <span class="article-eyebrow">À la une</span>
      ${metaHtml}
      ${titleHtml}
      ${mediaHtml}
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

  // Filet : garantir titre avant photo même si un attach restructure le DOM.
  if (role === 'lead') ensureLeadTitleAboveMedia(a);

  return a;
}

/** Place .article-title juste avant .article-media (une uniquement). */
function ensureLeadTitleAboveMedia(article) {
  if (!article) return;
  const title = article.querySelector(':scope > .article-title');
  const media = article.querySelector(':scope > .article-media');
  if (!title || !media) return;
  // Si le media précède le titre dans le DOM, on remonte le titre.
  if (
    title.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_PRECEDING
  ) {
    media.parentNode.insertBefore(title, media);
  }
}

/** Aligné sur scripts/article-image-lib.js isWeakImageUrl :
 *  ne rejette que les petites vignettes WP (-150x150), pas -930x620. */
const WEAK_IMAGE_PATH = /article-tile|size-article-tile/;

/** Aligné sur scripts/article-image-lib.js GLOBAL_IMAGE_REJECT_RE */
const GLOBAL_IMAGE_REJECT_RE = /(?:logo|avatar|icon|placeholder|default|blank|spacer|profile|author|favicon|gravatar|emoji|smiley|lapige_web|(?:^|\/)article-2\.|campus-logo|campusgraphic|article-tile|size-article-tile|thumbnail|thumb_|recent-posts|wp-block-query|widget|sponsor|banner|social-share|-150x\d+\.|cropped-logo|logoexile|121330814_121456603062023_8783413434532337259_n|(?:^|\/)daily\.png$|editorial[_-]|(?:^|\/)editorial(?:s)?(?:[_./-]|$)|画板|%e7%94%bb%e6%9d%bf|_optimized_optimized_optimized|00\.graphics\.csu\.naya_hachwa)/i;

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
  if (item.imageProvider === 'campus-bank' && hasUsablePhoto(item, role)) return false;
  // Source absente / rejetée (logo Daily.png, logo Exil, bannière editorial_…) → stock.
  // Le rejet path (GLOBAL_IMAGE_REJECT_RE) fait basculer hasUsablePhoto à false.
  if (hasStockPhoto(item, role) && !hasUsablePhoto(item, role)) return true;
  // Une image source réelle garde priorité, même si le bot l'a jugée un peu
  // sous le seuil de grande vedette. Le navigateur accepte cette photo pour la
  // une dès 200 × 150; cela évite qu'un ancien lien Openverse la remplace par
  // une image cassée ou hors sujet.
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

/** Return the other usable source after an image request failed.
 * A stale Openverse URL must never cause us to retry itself and then discard
 * an otherwise valid image supplied by the publication. */
function alternateDisplayImage(item, failedKind, role = 'lead') {
  const forThumb = role === 'feature' || role === 'compact';
  if (failedKind === 'stock' && hasUsablePhoto(item, role)) {
    return { src: getCandidateImage(item.image, { forThumb }), kind: 'photo' };
  }
  if (failedKind === 'photo' && hasStockPhoto(item, role)) {
    return { src: getCandidateImage(item.stockImage, { forThumb }), kind: 'stock' };
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
  // Crédit photo entier en original (photographe + libellé) — pas de MT.
  cap.className = 'article-media-credit notranslate';
  cap.setAttribute('translate', 'no');
  const url = String(item.sourceImageCreditUrl || item.link || '').trim();
  const en = item.lang === 'en';
  const fromMedia = item.sourceImageCreditFrom === 'media';

  if (fromMedia) {
    // « Crédit photo : The Plant » — média + crédit restent en langue d’origine.
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
    if (url) {
      const a = creditLink(url, creator, 'article-media-credit__creator notranslate');
      a.setAttribute('translate', 'no');
      cap.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = 'article-media-credit__creator notranslate';
      span.setAttribute('translate', 'no');
      span.textContent = creator;
      cap.appendChild(span);
    }
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
    if (url && label) {
      const a = creditLink(url, label, 'article-media-credit__creator notranslate');
      a.setAttribute('translate', 'no');
      cap.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = 'article-media-credit__creator notranslate';
      span.setAttribute('translate', 'no');
      span.textContent = label;
      cap.appendChild(span);
    }
    return cap;
  }

  if (url) {
    const a = creditLink(url, credit, 'article-media-credit__creator notranslate');
    a.setAttribute('translate', 'no');
    cap.appendChild(a);
  } else {
    cap.textContent = credit;
  }
  return cap;
}

function buildMediaCreditElement(item = {}) {
  const sourceUrl = String(item.imageSourceUrl || '').trim();
  const credit = String(item.imageCredit || '').trim();
  if (!credit && !sourceUrl) return null;

  const cap = document.createElement('figcaption');
  // Crédit banque libre / Openverse : photographe + licence en original.
  cap.className = 'article-media-credit notranslate';
  cap.setAttribute('translate', 'no');
  const en = item.lang === 'en';
  const parsed = credit ? parseImageCreditLine(credit) : null;
  const creator = cleanCreatorDisplay(item.imageCreator || parsed?.creator || '')
    || (en ? 'Unknown photographer' : 'Photographe inconnu');

  if (!parsed) {
    if (sourceUrl) {
      const a = creditLink(
        sourceUrl,
        credit || (en ? 'Photo source' : 'Source de la photo'),
        'article-media-credit__creator notranslate',
      );
      a.setAttribute('translate', 'no');
      cap.appendChild(a);
    } else {
      cap.textContent = credit;
    }
    return cap;
  }

  cap.appendChild(document.createTextNode(en ? 'Photo: ' : 'Photo : '));
  if (sourceUrl) {
    const a = creditLink(sourceUrl, creator, 'article-media-credit__creator notranslate');
    a.setAttribute('translate', 'no');
    cap.appendChild(a);
  } else {
    const span = document.createElement('span');
    span.className = 'article-media-credit__creator notranslate';
    span.setAttribute('translate', 'no');
    span.textContent = creator;
    cap.appendChild(span);
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
      if (role === 'lead') ensureLeadTitleAboveMedia(article);
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
          const alt = alternateDisplayImage(item, kind, role);
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
        const alt = alternateDisplayImage(item, kind, role);
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
    // encore en cours de chargement (Wikimedia 8K / réseau lent). Même règle
    // pour une photo source : une réponse lente reste préférable à un stock
    // incertain; seul son vrai onerror déclenche le repli.
    const timeoutMs = isThumb ? 10000 : 6000;
    window.setTimeout(() => {
      if (settled || article.classList.contains('has-image') || !media.isConnected) return;
      if (!allowRetry || kind === 'photo') return;
      const alt = alternateDisplayImage(item, kind, role);
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
  // Suffixes SEO collés aux og:title (Rank Math) — déjà stripés côté bot, mais
  // on nettoie aussi les news.json déjà en cache.
  t = t.replace(/\s*[–—|-]\s*Montréal\s+Campus\s*$/i, '').trim();
  t = t.replace(/\s*[–—|-]\s*Quartier\s+Libre\s*$/i, '').trim();
  t = t.replace(/\s*[–—|-]\s*Le\s+D[eé]lit\s*$/i, '').trim();
  t = t.replace(/\bUde\s+M\b/g, 'UdeM').replace(/\bUde\s+S\b/g, 'UdeS');
  t = t.replace(/\bMc\s+Gill\b/g, 'McGill');
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
  s = s.replace(/\s*The\s+post\b[\s\S]*?appeared first on[\s\S]*$/i, '');
  const li = s.search(/\sL['’]article\s/);
  if (li > 30) s = s.slice(0, li);
  s = s.replace(/\[[^\]]*(?:read more|lire la suite|continue reading)[^\]]*\]/gi, '');
  s = s.replace(/\b(?:read more|lire la suite|continue reading)\b\.?\s*$/i, '');
  s = s.replace(/^(?:Dear Tribune|Dear Editor),?\s*/i, '');
  s = s.replace(/(?:…|\.{3,}|\[…\]|\[\.\.\.\]|\[&hellip;\])/gi, '');
  s = s.replace(/\s+/g, ' ').trim();
  // WP has-drop-cap dans le flux : « L e 18… » / « L 'identité »
  s = s.replace(/^([\p{Lu}])\s+([''’])/u, '$1$2').replace(/^([\p{Lu}])\s+([\p{Ll}])/u, '$1$2');
  return s;
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
