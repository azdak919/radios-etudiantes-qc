/**
 * LE RADAR — traduction de page (moteur type Ataraxia).
 *
 * Pas de widget Google Website Translator (cookies googtrans souvent cassés
 * sur GitHub Pages). On traduit le DOM via des API libres :
 *   1. Google gtx (translate.googleapis.com, sans clé — comme Ataraxia)
 *   2. MyMemory (repli)
 *
 * Règles d'activation :
 *  1. Préférence utilisateur (localStorage) si elle existe — y compris « Original ».
 *  2. Sinon navigateur fr ou en → Original (aucune traduction) ; autre langue → auto.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'radar-translate-mode';
  // v6 : glossaire UI élargi + lazy suite du fil (ne pas MT l’overflow replié)
  const CACHE_KEY = 'radar-translate-cache-v6';
  const CACHE_MAX = 900;
  const DEFAULT_MODE = 'original';
  const CONCURRENCY = 6;
  const MAX_CHUNK = 450;

  const MODES = {
    original: {
      id: 'original',
      label: 'Original',
      short: 'Original',
      title: 'Ne pas traduire — chaque article reste dans sa langue d’origine',
      hint: 'Sans traduction',
      group: 'core',
    },
    fr: {
      id: 'fr',
      label: 'Français',
      short: 'FR',
      title: 'Traduire toute la page en français',
      hint: 'Toute la page',
      goog: 'fr',
      group: 'core',
    },
    en: {
      id: 'en',
      label: 'English',
      short: 'EN',
      title: 'Translate the whole page into English',
      hint: 'Whole page',
      goog: 'en',
      group: 'core',
    },
    /* Langues autochtones : catalogue dynamique dans indigenous-mt.json
       (sondage mensuel scripts/probe-indigenous-mt.js). Repli statique : */
    iu: {
      id: 'iu',
      label: 'ᐃᓄᒃᑎᑐᑦ',
      short: 'IU',
      title: 'Inuktitut (syllabiques) — Inuktut, Nunavik et Inuit du Canada',
      hint: 'Inuktitut · syllabiques',
      goog: 'iu',
      group: 'indigenous',
    },
    'iu-latn': {
      id: 'iu-latn',
      label: 'Inuktut',
      short: 'IU',
      title: 'Inuktut (alphabet latin) — Inuit du Canada',
      hint: 'Inuktitut · latin',
      // Code gtx sensible à la casse : iu-Latn = alphabet latin ; iu = syllabiques.
      goog: 'iu-Latn',
      group: 'indigenous',
    },
    /* —— Population étudiante internationale au Québec / Canada ——
       Priorité : Inde, Chine, Nigeria, Philippines, Iran, Vietnam, Corée,
       Maghreb, Amérique latine, Europe de l’Est, etc. (IRCC / campus QC). */
    es: {
      id: 'es',
      label: 'Español',
      short: 'ES',
      title: 'Traducir toda la página al español',
      hint: 'América latina · España',
      goog: 'es',
      group: 'americas',
    },
    pt: {
      id: 'pt',
      label: 'Português',
      short: 'PT',
      title: 'Traduzir a página inteira para português',
      hint: 'Brasil · Portugal',
      goog: 'pt',
      group: 'americas',
    },
    ht: {
      id: 'ht',
      label: 'Kreyòl',
      short: 'HT',
      title: 'Tradui tout paj la an kreyòl ayisyen',
      hint: 'Haïti · diaspora',
      goog: 'ht',
      group: 'americas',
    },
    zh: {
      id: 'zh',
      label: '中文',
      short: '中文',
      title: '将整页翻译成中文（简体）',
      hint: 'Chine · simplifié',
      goog: 'zh-CN',
      group: 'asia',
    },
    'zh-tw': {
      id: 'zh-tw',
      label: '繁體中文',
      short: '繁中',
      title: '將整頁翻譯成繁體中文',
      hint: 'Taïwan · Hong Kong',
      goog: 'zh-TW',
      group: 'asia',
    },
    hi: {
      id: 'hi',
      label: 'हिन्दी',
      short: 'HI',
      title: 'पूरे पृष्ठ का हिंदी में अनुवाद करें',
      hint: 'Inde · Hindi',
      goog: 'hi',
      group: 'asia',
    },
    pa: {
      id: 'pa',
      label: 'ਪੰਜਾਬੀ',
      short: 'PA',
      title: 'ਸਾਰੇ ਸਫ਼ੇ ਦਾ ਪੰਜਾਬੀ ਵਿੱਚ ਅਨੁਵਾਦ',
      hint: 'Inde · Pendjab',
      goog: 'pa',
      group: 'asia',
    },
    ur: {
      id: 'ur',
      label: 'اردو',
      short: 'UR',
      title: 'پورے صفحے کا اردو ترجمہ',
      hint: 'Pakistan · Inde',
      goog: 'ur',
      group: 'asia',
    },
    bn: {
      id: 'bn',
      label: 'বাংলা',
      short: 'BN',
      title: 'সম্পূর্ণ পৃষ্ঠা বাংলায় অনুবাদ করুন',
      hint: 'Bangladesh · Inde',
      goog: 'bn',
      group: 'asia',
    },
    ta: {
      id: 'ta',
      label: 'தமிழ்',
      short: 'TA',
      title: 'முழு பக்கத்தையும் தமிழில் மொழிபெயர்க்கவும்',
      hint: 'Inde · Sri Lanka',
      goog: 'ta',
      group: 'asia',
    },
    te: {
      id: 'te',
      label: 'తెలుగు',
      short: 'TE',
      title: 'మొత్తం పేజీని తెలుగులోకి అనువదించండి',
      hint: 'Inde · Telugu',
      goog: 'te',
      group: 'asia',
    },
    mr: {
      id: 'mr',
      label: 'मराठी',
      short: 'MR',
      title: 'संपूर्ण पृष्ठ मराठीत भाषांतरित करा',
      hint: 'Inde · Marathi',
      goog: 'mr',
      group: 'asia',
    },
    gu: {
      id: 'gu',
      label: 'ગુજરાતી',
      short: 'GU',
      title: 'સમગ્ર પૃષ્ઠનું ગુજરાતીમાં ભાષાંતર',
      hint: 'Inde · Gujarati',
      goog: 'gu',
      group: 'asia',
    },
    kn: {
      id: 'kn',
      label: 'ಕನ್ನಡ',
      short: 'KN',
      title: 'ಸಂಪೂರ್ಣ ಪುಟವನ್ನು ಕನ್ನಡಕ್ಕೆ ಅನುವಾದಿಸಿ',
      hint: 'Inde · Kannada',
      goog: 'kn',
      group: 'asia',
    },
    ml: {
      id: 'ml',
      label: 'മലയാളം',
      short: 'ML',
      title: 'മുഴുവൻ പേജും മലയാളത്തിലേക്ക് വിവർത്തനം ചെയ്യുക',
      hint: 'Inde · Malayalam',
      goog: 'ml',
      group: 'asia',
    },
    vi: {
      id: 'vi',
      label: 'Tiếng Việt',
      short: 'VI',
      title: 'Dịch toàn bộ trang sang tiếng Việt',
      hint: 'Vietnam',
      goog: 'vi',
      group: 'asia',
    },
    tl: {
      id: 'tl',
      label: 'Tagalog',
      short: 'TL',
      title: 'Isalin ang buong pahina sa Tagalog',
      hint: 'Philippines',
      goog: 'tl',
      group: 'asia',
    },
    ko: {
      id: 'ko',
      label: '한국어',
      short: 'KO',
      title: '전체 페이지를 한국어로 번역',
      hint: 'Corée',
      goog: 'ko',
      group: 'asia',
    },
    ja: {
      id: 'ja',
      label: '日本語',
      short: 'JA',
      title: 'ページ全体を日本語に翻訳',
      hint: 'Japon',
      goog: 'ja',
      group: 'asia',
    },
    th: {
      id: 'th',
      label: 'ไทย',
      short: 'TH',
      title: 'แปลทั้งหน้าเป็นภาษาไทย',
      hint: 'Thaïlande',
      goog: 'th',
      group: 'asia',
    },
    id: {
      id: 'id',
      label: 'Bahasa Indonesia',
      short: 'ID',
      title: 'Terjemahkan seluruh halaman ke bahasa Indonesia',
      hint: 'Indonésie',
      goog: 'id',
      group: 'asia',
    },
    ms: {
      id: 'ms',
      label: 'Bahasa Melayu',
      short: 'MS',
      title: 'Terjemah seluruh halaman ke Bahasa Melayu',
      hint: 'Malaisie',
      goog: 'ms',
      group: 'asia',
    },
    ar: {
      id: 'ar',
      label: 'العربية',
      short: 'AR',
      title: 'ترجمة الصفحة كاملة إلى العربية',
      hint: 'Maghreb · Moyen-Orient',
      goog: 'ar',
      group: 'mena',
    },
    fa: {
      id: 'fa',
      label: 'فارسی',
      short: 'FA',
      title: 'ترجمهٔ کل صفحه به فارسی',
      hint: 'Iran · Afghanistan',
      goog: 'fa',
      group: 'mena',
    },
    tr: {
      id: 'tr',
      label: 'Türkçe',
      short: 'TR',
      title: 'Tüm sayfayı Türkçeye çevir',
      hint: 'Turquie',
      goog: 'tr',
      group: 'mena',
    },
    he: {
      id: 'he',
      label: 'עברית',
      short: 'HE',
      title: 'תרגם את כל העמוד לעברית',
      hint: 'Israël',
      goog: 'iw',
      group: 'mena',
    },
    sw: {
      id: 'sw',
      label: 'Kiswahili',
      short: 'SW',
      title: 'Tafsiri ukurasa mzima kwa Kiswahili',
      hint: 'Afrique de l’Est',
      goog: 'sw',
      group: 'africa',
    },
    yo: {
      id: 'yo',
      label: 'Yorùbá',
      short: 'YO',
      title: 'Túmọ̀ gbogbo ojú-ìwé sí èdè Yorùbá',
      hint: 'Nigeria · Bénin',
      goog: 'yo',
      group: 'africa',
    },
    ig: {
      id: 'ig',
      label: 'Igbo',
      short: 'IG',
      title: 'Tụgharịa ibe dum gaa n’Igbo',
      hint: 'Nigeria',
      goog: 'ig',
      group: 'africa',
    },
    ha: {
      id: 'ha',
      label: 'Hausa',
      short: 'HA',
      title: 'Fassara dukkan shafin zuwa Hausa',
      hint: 'Nigeria · Sahel',
      goog: 'ha',
      group: 'africa',
    },
    am: {
      id: 'am',
      label: 'አማርኛ',
      short: 'AM',
      title: 'ሙሉ ገጹን ወደ አማርኛ ተርጉም',
      hint: 'Éthiopie',
      goog: 'am',
      group: 'africa',
    },
    de: {
      id: 'de',
      label: 'Deutsch',
      short: 'DE',
      title: 'Ganze Seite auf Deutsch übersetzen',
      hint: 'Allemagne · Suisse · Autriche',
      goog: 'de',
      group: 'europe',
    },
    it: {
      id: 'it',
      label: 'Italiano',
      short: 'IT',
      title: 'Traduci l’intera pagina in italiano',
      hint: 'Italie',
      goog: 'it',
      group: 'europe',
    },
    ru: {
      id: 'ru',
      label: 'Русский',
      short: 'RU',
      title: 'Перевести всю страницу на русский',
      hint: 'Russie · CEI',
      goog: 'ru',
      group: 'europe',
    },
    uk: {
      id: 'uk',
      label: 'Українська',
      short: 'UK',
      title: 'Перекласти всю сторінку українською',
      hint: 'Ukraine · diaspora',
      goog: 'uk',
      group: 'europe',
    },
    pl: {
      id: 'pl',
      label: 'Polski',
      short: 'PL',
      title: 'Przetłumacz całą stronę na polski',
      hint: 'Pologne',
      goog: 'pl',
      group: 'europe',
    },
    ro: {
      id: 'ro',
      label: 'Română',
      short: 'RO',
      title: 'Traduce întreaga pagină în română',
      hint: 'Roumanie · Moldova',
      goog: 'ro',
      group: 'europe',
    },
    nl: {
      id: 'nl',
      label: 'Nederlands',
      short: 'NL',
      title: 'Vertaal de hele pagina naar het Nederlands',
      hint: 'Pays-Bas · Belgique',
      goog: 'nl',
      group: 'europe',
    },
    el: {
      id: 'el',
      label: 'Ελληνικά',
      short: 'EL',
      title: 'Μετάφραση ολόκληρης της σελίδας στα ελληνικά',
      hint: 'Grèce · Chypre',
      goog: 'el',
      group: 'europe',
    },
    sv: {
      id: 'sv',
      label: 'Svenska',
      short: 'SV',
      title: 'Översätt hela sidan till svenska',
      hint: 'Suède',
      goog: 'sv',
      group: 'europe',
    },
  };

  /** Ordre d’affichage : Original/FR/EN → autochtones QC → régions d’origine étudiantes.
   *  Les IDs autochtones sont injectés depuis indigenous-mt.json (voir applyIndigenousRegistry). */
  const MENU_ORDER_CORE = ['original', 'fr', 'en'];
  const MENU_ORDER_TAIL = [
    // Amériques
    'es', 'pt', 'ht',
    // Asie (Inde en tête des permis d’études au Canada)
    'zh', 'zh-tw', 'hi', 'pa', 'ur', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml',
    'vi', 'tl', 'ko', 'ja', 'th', 'id', 'ms',
    // Maghreb / Moyen-Orient
    'ar', 'fa', 'tr', 'he',
    // Afrique subsaharienne (Nigeria, etc.)
    'yo', 'ig', 'ha', 'sw', 'am',
    // Europe
    'de', 'it', 'ru', 'uk', 'pl', 'ro', 'nl', 'el', 'sv',
  ];
  let MENU_ORDER = [...MENU_ORDER_CORE, 'iu', 'iu-latn', ...MENU_ORDER_TAIL];

  const GROUP_LABELS = {
    indigenous: 'Langues autochtones du Québec',
    americas: 'Amériques',
    asia: 'Asie',
    mena: 'Maghreb & Moyen-Orient',
    africa: 'Afrique',
    europe: 'Europe',
  };

  let indigenousRegistryReady = false;

  /** Fusionne indigenous-mt.json → MODES + MENU_ORDER (active + bientôt). */
  function applyIndigenousRegistry(reg) {
    if (!reg || !Array.isArray(reg.languages)) return;
    const indigenousIds = [];
    for (const lang of reg.languages) {
      if (!lang?.id) continue;
      const enabled = !!lang.enabled && !lang.unavailable && lang.goog;
      MODES[lang.id] = {
        id: lang.id,
        label: lang.label || lang.id,
        short: lang.short || String(lang.id).toUpperCase(),
        title: lang.title || lang.label || lang.id,
        hint: lang.hint || (enabled ? 'Auto' : 'bientôt'),
        group: 'indigenous',
        goog: enabled ? lang.goog : undefined,
        unavailable: !enabled,
      };
      indigenousIds.push(lang.id);
    }
    if (indigenousIds.length) {
      MENU_ORDER = [...MENU_ORDER_CORE, ...indigenousIds, ...MENU_ORDER_TAIL];
    }
  }

  function loadIndigenousRegistry() {
    if (indigenousRegistryReady) return Promise.resolve();
    return fetch('./indigenous-mt.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) applyIndigenousRegistry(data);
        indigenousRegistryReady = true;
      })
      .catch(() => {
        indigenousRegistryReady = true;
      });
  }

  /** textNode → original string (avant toute traduction) */
  const originalByNode = new WeakMap();
  /** cache localStorage : key → translated */
  let translationCache = {};
  let activeMode = DEFAULT_MODE;
  let translating = false;
  let mutateTimer = 0;
  let mutateObserver = null;
  /** Noms de médias étudiants (propres) — ne jamais traduire. */
  const protectedMediaNames = new Set(['Le Radar', 'LE RADAR', 'Le radar']);
  /**
   * Noms d'établissements (propres) — ne jamais traduire.
   * gtx casse souvent la casse (ex. ES : « Université Laval » → « universidad laval »)
   * ou déforme le sens (EN « Bishop's University » → « Universidad del Obispo »).
   */
  const protectedInstitutionNames = new Set([
    'ULaval', 'UdeM', 'UQAM', 'UQTR', 'UQAC', 'UQAR', 'UQO', 'UQAT',
    'UdeS', 'McGill', 'Concordia', "Bishop's", 'Poly Montréal', 'Polytechnique Montréal',
    'CVM', 'Dawson', 'Jonquière', 'Vieux-Montréal',
    'Université Laval', 'Université de Montréal', 'Université de Sherbrooke',
    'Université McGill', 'McGill University', 'Concordia University',
    "Bishop's University", 'Dawson College', 'Collège Dawson',
    'Université du Québec à Montréal', 'Université du Québec à Trois-Rivières',
    'Université du Québec à Chicoutimi', 'Cégep du Vieux Montréal',
    'Cégep de Jonquière', 'Cégep de Jonquière (ATM – journalisme)',
  ]);
  let mediaNamesReady = false;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'PATH', 'MATH', 'IFRAME',
  ]);

  /**
   * Politique de traduction des noms propres (Le Radar) :
   *  - Noms de **sources** (médias) → jamais (filter-btn__name, article-source)
   *  - **Auteurs** d’articles → jamais (article-author)
   *  - **Crédits photo** (photographes, « Crédit photo : … ») → jamais
   *  - **Institutions** (article-inst, filter-btn__inst) → localisées hors FR/EN/Original
   *  - Libellés UI (« Par », « À la une », « Toutes les sources ») → traduits
   */
  const SKIP_CLASS_RE = /\b(?:notranslate|article-source|article-author|filter-btn__name|article-media-credit(?:__creator)?)\b/;

  function hasUserPreference() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  function isValidLangCode(code) {
    return typeof code === 'string' && /^[a-z]{2}(?:-[A-Za-z]{2,8})?$/.test(code);
  }

  function normalizeBrowserLang(tag) {
    const raw = String(tag || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw === 'zh-tw' || raw === 'zh-hk' || raw === 'zh-hant' || raw.startsWith('zh-hant')) return 'zh-tw';
    if (raw.startsWith('zh')) return 'zh';
    if (raw === 'fil' || raw === 'fil-ph') return 'tl';
    if (raw === 'iw') return 'he';
    if (raw === 'nb' || raw === 'nn') return 'no';
    return raw.split('-')[0] || '';
  }

  function googCodeForMode(mode) {
    if (!mode || mode === DEFAULT_MODE) return null;
    if (MODES[mode]?.unavailable) return null;
    if (MODES[mode]?.goog) return MODES[mode].goog;
    if (mode === 'zh') return 'zh-CN';
    if (mode === 'zh-tw') return 'zh-TW';
    if (mode === 'he') return 'iw';
    // iu-Latn (L majuscule) = orthographe latine ; iu = syllabaires canadiens
    if (mode === 'iu-latn') return 'iu-Latn';
    if (mode === 'iu') return 'iu';
    if (mode === 'fil') return 'tl';
    if (isValidLangCode(mode)) return mode;
    return null;
  }

  function gtxLang(code) {
    const map = {
      zh: 'zh-CN',
      'zh-tw': 'zh-TW',
      he: 'iw',
      // Conserver la casse exacte exigée par gtx
      'iu-latn': 'iu-Latn',
      'iu-Latn': 'iu-Latn',
      iu: 'iu',
      tl: 'tl', // Tagalog / Filipino
      fil: 'tl',
    };
    return map[code] || code;
  }

  function notify(msg) {
    const el = document.getElementById('toast');
    if (el) {
      el.textContent = msg;
      el.classList.remove('hidden');
      clearTimeout(el._radarTranslateT);
      el._radarTranslateT = setTimeout(() => el.classList.add('hidden'), 4200);
      return;
    }
    console.info(msg);
  }

  function labelForMode(mode) {
    if (MODES[mode]) return MODES[mode];
    if (mode && mode !== DEFAULT_MODE) {
      return {
        id: mode,
        label: mode.toUpperCase(),
        short: mode.toUpperCase(),
        title: `Translate page to ${mode}`,
        hint: 'Auto',
        goog: googCodeForMode(mode),
      };
    }
    return MODES.original;
  }

  function detectBrowserAutoMode() {
    let tags = [];
    try {
      if (Array.isArray(navigator.languages) && navigator.languages.length) {
        tags = navigator.languages.slice();
      } else if (navigator.language) {
        tags = [navigator.language];
      }
    } catch {
      tags = [];
    }

    for (const tag of tags) {
      const lower = String(tag || '').toLowerCase();
      const primary = normalizeBrowserLang(tag);
      if (!primary) continue;
      if (primary === 'fr' || primary === 'en') return DEFAULT_MODE;
      if (primary === 'iu' || primary === 'ike' || lower.startsWith('iu')) {
        return lower.includes('latn') ? 'iu-latn' : 'iu';
      }
      if (MODES[primary]?.unavailable) continue;
      if (MODES[primary]?.goog) return primary;
      if (isValidLangCode(primary)) return primary;
    }
    return DEFAULT_MODE;
  }

  function getMode() {
    if (hasUserPreference()) {
      try {
        const raw = (localStorage.getItem(STORAGE_KEY) || '').toLowerCase().trim();
        if (raw === DEFAULT_MODE) return DEFAULT_MODE;
        if (raw === 'iu-latn' || raw === 'zh-tw') return raw;
        if (MODES[raw] && !MODES[raw].unavailable) return raw;
        if (raw === 'fil') return 'tl';
        if (raw === 'iw') return 'he';
        if (isValidLangCode(raw) && raw !== 'fr' && raw !== 'en') return raw;
        // fr/en stockés manuellement restent valides
        if (raw === 'fr' || raw === 'en') return raw;
      } catch { /* fall through */ }
    }
    return detectBrowserAutoMode();
  }

  function setMode(mode) {
    if (MODES[mode]?.unavailable) return getMode();
    if (mode !== DEFAULT_MODE && !MODES[mode] && !isValidLangCode(mode) && mode !== 'iu-latn') {
      mode = DEFAULT_MODE;
    }
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch { /* private mode */ }
    return mode;
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) translationCache = JSON.parse(raw) || {};
    } catch {
      translationCache = {};
    }
  }

  function saveCache() {
    try {
      const keys = Object.keys(translationCache);
      if (keys.length > CACHE_MAX) {
        keys.slice(0, keys.length - CACHE_MAX).forEach((k) => {
          delete translationCache[k];
        });
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(translationCache));
    } catch { /* quota */ }
  }

  function cacheKey(text, tl) {
    return `auto|${tl}|${text}`;
  }

  function cleanTranslation(str) {
    if (typeof str !== 'string' || !str) return str;
    let out = str.replace(/<g[^>]*>([\s\S]*?)<\/g>/gi, '$1');
    out = out.replace(/<[^>]+>/g, '');
    out = out
      .replace(/&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return fixInternalTranslationSpacing(out);
  }

  /**
   * gtx mange souvent les espaces de bord (« sous licence » + lien →
   * « na licencjiPowszechna ») et après « Photo: ».
   */
  function fixInternalTranslationSpacing(str = '') {
    let out = String(str);
    // Crédits / libellés « Mot:Texte » → « Mot: Texte »
    out = out.replace(
      /(^|[\s(])((?:Photo|Crédit(?:\s+photo)?|Credit(?:\s+photo)?|Zdjęcie|Foto|Fotografía|Fotoğraf))\s*:(?=\S)/giu,
      '$1$2: ',
    );
    // Deux-points collés avant une lettre (pas les URL https:// ni 12:30) :
    out = out.replace(/:(?!\/\/)(?=[\p{L}])/gu, ': ');
    // Mot collé en camel accidentel : licencjiPowszechna
    out = out.replace(/(\p{Ll}{2,})(\p{Lu}\p{L})/gu, '$1 $2');
    // Ne PAS appeler fixInstitutionMistranslations ici avec original vide :
    // ça réécrivait des phrases hors établissement (régressions de traduction).
    // Les corrections collège/université passent par polishInstitutionTranslation
    // uniquement dans les zones .article-inst / pastilles.
    // Espaces doubles éventuels
    out = out.replace(/ {2,}/g, ' ');
    return out;
  }

  /** Réapplique les espaces de début/fin de l’original (gtx les retire). */
  function reapplyEdgeWhitespace(original, translated) {
    const orig = String(original ?? '');
    let out = String(translated ?? '');
    if (!orig.trim()) return orig;
    const hadLead = /^\s/.test(orig);
    const hadTrail = /\s$/.test(orig);
    out = fixInternalTranslationSpacing(out.replace(/^\s+|\s+$/g, ''));
    if (hadLead) out = ` ${out}`;
    if (hadTrail) out = `${out} `;
    return out;
  }

  /**
   * Phrases UI courtes — gtx invente souvent des contresens (ex. IU sur
   * « Toutes les sources »). On force des libellés fiables (endonymes).
   * Clés = texte source affiché en FR dans le shell.
   */
  const UI_PHRASES = {
    'Toutes les sources': {
      en: 'All sources', es: 'Todas las fuentes', pt: 'Todas as fontes',
      de: 'Alle Quellen', it: 'Tutte le fonti', ht: 'Tout sous',
      zh: '全部来源', 'zh-tw': '全部來源', ar: 'كل المصادر', hi: 'सभी स्रोत',
      ru: 'Все источники', uk: 'Усі джерела', ko: '모든 출처', ja: 'すべての情報源',
      vi: 'Tất cả nguồn', tl: 'Lahat ng pinagmulan', tr: 'Tüm kaynaklar',
      pl: 'Wszystkie źródła', nl: 'Alle bronnen', ro: 'Toate sursele',
      iu: 'Toutes les sources', 'iu-latn': 'Toutes les sources',
    },
    'Plus de sources': {
      en: 'More sources', es: 'Más fuentes', pt: 'Mais fontes',
      de: 'Weitere Quellen', it: 'Altre fonti', zh: '更多来源', 'zh-tw': '更多來源',
      ar: 'المزيد من المصادر', ru: 'Ещё источники', ko: '출처 더보기',
      iu: 'Plus de sources', 'iu-latn': 'Plus de sources',
    },
    'Moins de sources': {
      en: 'Fewer sources', es: 'Menos fuentes', pt: 'Menos fontes',
      de: 'Weniger Quellen', it: 'Meno fonti',
      iu: 'Moins de sources', 'iu-latn': 'Moins de sources',
    },
    "Plus d'articles": {
      en: 'More articles', es: 'Más artículos', pt: 'Mais artigos',
      de: 'Weitere Artikel', it: 'Altri articoli', zh: '更多文章', 'zh-tw': '更多文章',
      ar: 'المزيد من المقالات', ru: 'Ещё статьи', ko: '기사 더보기', ja: '記事をもっと見る',
      vi: 'Thêm bài viết', tl: 'Higit pang mga artikulo', hi: 'और लेख',
      pl: 'Więcej artykułów', nl: 'Meer artikelen', tr: 'Daha fazla makale',
      iu: "Plus d'articles", 'iu-latn': "Plus d'articles",
    },
    'Réduire': {
      en: 'Show less', es: 'Mostrar menos', pt: 'Mostrar menos',
      de: 'Weniger anzeigen', it: 'Mostra meno', zh: '收起', 'zh-tw': '收起',
      ar: 'عرض أقل', ru: 'Свернуть', ko: '접기', ja: '閉じる',
      iu: 'Réduire', 'iu-latn': 'Réduire',
    },
    'À la une': {
      en: 'Top story', es: 'Portada', pt: 'Destaque', de: 'Titelgeschichte',
      it: 'In evidenza', zh: '头条', 'zh-tw': '頭條', ar: 'أبرز الأخبار',
      ru: 'Главное', ko: '헤드라인', ja: 'トップ', hi: 'मुख्य समाचार',
      vi: 'Tin nổi bật', tl: 'Pangunahing balita', tr: 'Manşet',
      pl: 'Na okładce', nl: 'Voorpagina', ht: 'Alain',
      iu: 'À la une', 'iu-latn': 'À la une',
    },
    'En bref': {
      en: 'In brief', es: 'En breve', pt: 'Em breve', de: 'Kurz gemeldet',
      it: 'In breve', zh: '简讯', 'zh-tw': '簡訊', ar: 'باختصار',
      ru: 'Коротко', ko: '한눈에', ja: '手短に', hi: 'संक्षेप में',
      vi: 'Tóm tắt', tl: 'Sa madaling salita', tr: 'Kısaca',
      pl: 'W skrócie', nl: 'In het kort', ht: 'An rezime',
      iu: 'En bref', 'iu-latn': 'En bref',
    },
    'Suite du fil': {
      en: 'More stories', es: 'Más noticias', pt: 'Mais notícias', de: 'Weitere Meldungen',
      it: 'Altre notizie', zh: '更多报道', 'zh-tw': '更多報導', ar: 'المزيد من الأخبار',
      ru: 'Ещё новости', ko: '더 많은 소식', ja: 'その他の記事', hi: 'और समाचार',
      vi: 'Tin khác', tl: 'Iba pang balita', tr: 'Diğer haberler',
      pl: 'Więcej wiadomości', nl: 'Meer berichten', ht: 'Plis nouvèl',
      iu: 'Suite du fil', 'iu-latn': 'Suite du fil',
    },
    'Le fil étudiant': {
      en: 'Student wire', es: 'Hilo estudiantil', pt: 'Fio estudantil',
      de: 'Studierenden-Ticker', it: 'Filo studentesco', zh: '学生资讯',
      ar: 'الخيط الطلابي', ru: 'Студенческая лента',
      iu: 'Le fil étudiant', 'iu-latn': 'Le fil étudiant',
    },
    Par: {
      en: 'By', es: 'Por', pt: 'Por', de: 'Von', it: 'Di', zh: '作者',
      ar: 'بقلم', ru: 'Автор', ko: '글', ja: '執筆', hi: 'लेखक',
      vi: 'Bởi', tl: 'Ni', tr: 'Yazan', pl: 'Autor', nl: 'Door', ht: 'Pa',
      fr: 'Par',
    },
    By: {
      fr: 'Par', es: 'Por', pt: 'Por', de: 'Von', it: 'Di', zh: '作者',
      en: 'By',
    },
    'Lire la suite →': {
      en: 'Read more →', es: 'Leer más →', pt: 'Ler mais →', de: 'Weiterlesen →',
      it: 'Continua →', zh: '阅读全文 →', 'zh-tw': '閱讀全文 →', ar: 'اقرأ المزيد →',
      ru: 'Читать далее →', ko: '더 읽기 →', ja: '続きを読む →', hi: 'और पढ़ें →',
      vi: 'Đọc tiếp →', tl: 'Magbasa pa →', tr: 'Devamını oku →',
      pl: 'Czytaj dalej →', nl: 'Lees verder →', ht: 'Li plis →',
    },
    'Read more →': {
      fr: 'Lire la suite →', es: 'Leer más →', pt: 'Ler mais →', de: 'Weiterlesen →',
      en: 'Read more →',
    },
    'Lire la suite': {
      en: 'Read more', es: 'Leer más', pt: 'Ler mais', de: 'Weiterlesen',
      it: 'Continua', zh: '阅读全文', ar: 'اقرأ المزيد',
    },
    'Read more': {
      fr: 'Lire la suite', es: 'Leer más', pt: 'Ler mais', en: 'Read more',
    },
    Rechercher: {
      en: 'Search', es: 'Buscar', pt: 'Pesquisar', de: 'Suchen', it: 'Cerca',
      zh: '搜索', ar: 'بحث', ru: 'Поиск',
    },
    Search: {
      fr: 'Rechercher', es: 'Buscar', en: 'Search',
    },
  };

  /** Langues où un calque FR figé n’aide pas — laisser gtx tenter. */
  function prefersMachineUi(lang = '') {
    const l = institutionLangKey(lang);
    return /^(iu|ar|fa|he|ur|zh|hi|pa|bn|ta|te|mr|gu|kn|ml|ko|ja|th|am|hy|ka|my|km|lo|si|ne|bo)$/.test(l);
  }

  function uiPhraseLookup(core = '', targetLang = '') {
    const entry = UI_PHRASES[core];
    if (!entry) return null;
    const lang = institutionLangKey(targetLang);
    if (entry[lang] != null) {
      // Ancien filet « garder le FR en IU » : équivaut à ne pas traduire.
      // Pour les scripts lointains, on laisse plutôt le MT travailler.
      if (prefersMachineUi(lang) && entry[lang] === core) return null;
      return entry[lang];
    }
    if (entry.default != null) return entry.default;
    return null;
  }

  function preferredUiPhrase(text = '', targetLang = '') {
    const core = String(text || '').replace(/\s+/g, ' ').trim();
    if (!core) return null;

    const direct = uiPhraseLookup(core, targetLang);
    if (direct != null) return direct;

    // « Plus d'articles (12) » / « More articles (12) »
    const moreFr = core.match(/^Plus d['’]articles\s*\((\d+)\)\s*$/i);
    if (moreFr) {
      const stem = uiPhraseLookup("Plus d'articles", targetLang) || 'More articles';
      return `${stem} (${moreFr[1]})`;
    }
    const moreEn = core.match(/^More articles\s*\((\d+)\)\s*$/i);
    if (moreEn) {
      const stem = uiPhraseLookup('More articles', targetLang)
        || uiPhraseLookup("Plus d'articles", targetLang)
        || 'More articles';
      return `${stem} (${moreEn[1]})`;
    }

    // Compteurs dynamiques « 185 articles » / « 12 sources »
    const countArticles = core.match(/^(\d+)\s+articles?\s*$/i);
    if (countArticles) {
      const n = countArticles[1];
      const lang = institutionLangKey(targetLang);
      if (lang === 'en') return `${n} article${n === '1' ? '' : 's'}`;
      if (lang === 'es') return `${n} artículo${n === '1' ? '' : 's'}`;
      if (lang === 'pt') return `${n} artigo${n === '1' ? '' : 's'}`;
      if (lang === 'de') return `${n} Artikel`;
      if (lang === 'it') return `${n} articol${n === '1' ? 'o' : 'i'}`;
      if (lang === 'zh' || lang === 'zh-tw') return `${n} 篇文章`;
      if (lang === 'ar') return `${n} مقالة`;
      if (lang === 'ru') return `${n} статей`;
      if (lang === 'ko') return `기사 ${n}개`;
      if (lang === 'ja') return `${n}本の記事`;
      if (lang === 'fr') return `${n} article${n === '1' ? '' : 's'}`;
    }

    return null;
  }

  async function translateText(text, targetLang) {
    const original = String(text || '');
    if (!original.trim()) return original;
    // Traduire le cœur sans espaces de bord (clé de cache stable)
    const core = original.replace(/^\s+|\s+$/g, '');
    const tl = gtxLang(targetLang);
    const key = cacheKey(core, tl);

    const finish = (translatedCore) => reapplyEdgeWhitespace(original, translatedCore);

    if (translationCache[key]) return finish(translationCache[key]);

    // Phrases UI connues : pas de MT (évite les contresens)
    const uiHit = preferredUiPhrase(core, targetLang);
    if (uiHit != null) {
      translationCache[key] = uiHit;
      return finish(uiHit);
    }

    // Très longs : découper par phrases approximatives
    if (core.length > MAX_CHUNK) {
      const parts = splitLong(core, MAX_CHUNK);
      const out = [];
      for (const part of parts) {
        out.push(await translateText(part, targetLang));
      }
      const joined = fixInternalTranslationSpacing(out.join(''));
      translationCache[key] = joined.replace(/^\s+|\s+$/g, '');
      return finish(translationCache[key]);
    }

    const encoded = encodeURIComponent(core);

    // 1) Google gtx (même endpoint qu'Ataraxia)
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encoded}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        const raw = data?.[0]?.map((s) => s?.[0]).filter(Boolean).join('');
        const translated = cleanTranslation(raw);
        if (translated) {
          translationCache[key] = translated.replace(/^\s+|\s+$/g, '');
          return finish(translationCache[key]);
        }
      }
    } catch { /* next */ }

    // 2) MyMemory
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=auto|${encodeURIComponent(tl)}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (data.responseStatus === 200 && data.responseData?.translatedText) {
          const translated = cleanTranslation(data.responseData.translatedText);
          if (translated && translated !== core.toUpperCase()) {
            translationCache[key] = translated.replace(/^\s+|\s+$/g, '');
            return finish(translationCache[key]);
          }
        }
      }
    } catch { /* keep original */ }

    return original;
  }

  function splitLong(text, max) {
    const parts = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max);
      if (cut < max * 0.5) cut = max;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) parts.push(rest);
    return parts;
  }

  function addProtectedName(set, raw) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2) return;
    set.add(t);
    set.add(t.toLowerCase());
    // Sans parenthèse finale « (ATM – journalisme) »
    const stripped = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (stripped && stripped !== t) {
      set.add(stripped);
      set.add(stripped.toLowerCase());
    }
  }

  function loadProtectedMediaNames() {
    if (mediaNamesReady) return Promise.resolve();
    return fetch('./news-sources.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        for (const s of data?.active || []) {
          if (s?.name) addProtectedName(protectedMediaNames, s.name);
          if (s?.institution) addProtectedName(protectedInstitutionNames, s.institution);
        }
        for (const s of data?.candidates || []) {
          if (s?.name) addProtectedName(protectedMediaNames, s.name);
          if (s?.institution) addProtectedName(protectedInstitutionNames, s.institution);
        }
        mediaNamesReady = true;
      })
      .catch(() => {
        mediaNamesReady = true;
      });
  }

  function nameInSet(set, text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    if (set.has(t) || set.has(t.toLowerCase())) return true;
    for (const name of set) {
      if (!name || name.length < 2) continue;
      if (t === name || t.toLowerCase() === String(name).toLowerCase()) return true;
    }
    return false;
  }

  function isProtectedMediaName(text = '') {
    return nameInSet(protectedMediaNames, text);
  }

  function isProtectedInstitutionName(text = '') {
    return nameInSet(protectedInstitutionNames, text);
  }

  /** Langue cible du passage de traduction en cours (null hors translateDom). */
  let translateTargetLang = null;

  /**
   * Localiser les noms d’établissements seulement hors Original / FR / EN.
   * (Original = pas de traduction ; FR/EN = libellés d’origine tels quels.)
   */
  function shouldLocalizeInstitutions(targetLang = translateTargetLang) {
    if (!targetLang) return false;
    const lang = institutionLangKey(targetLang);
    if (!lang || lang === 'fr' || lang === 'en') return false;
    return true;
  }

  /** Pastilles sources, barre compacte, meta article (institution). */
  function isInstitutionLabelZone(node) {
    const el = node && node.nodeType === 3 ? node.parentElement : node;
    if (!el || el.nodeType !== 1) return false;
    // Sous-titre « Toutes les sources » : copie UI, pas un nom d’établissement.
    if (el.closest?.('.filter-btn--all')) return false;
    return !!(el.closest?.('.filter-btn__inst, .filters-compact__inst, .article-inst'));
  }

  /** Zone institution ET langue où la localisation est autorisée. */
  function isTranslatableInstitutionZone(node) {
    if (!shouldLocalizeInstitutions()) return false;
    return isInstitutionLabelZone(node);
  }

  /**
   * Noms propres à ne pas traduire (média, établissement hors localisation,
   * ou libellé composé « poste · institution » dans le tuner).
   */
  function isProtectedProperName(text = '', node = null) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    if (isProtectedMediaName(t)) return true;

    // FR / EN / Original : jamais toucher aux libellés d’établissement
    if (isInstitutionLabelZone(node) && !shouldLocalizeInstitutions()) {
      return true;
    }

    // Autres langues : autoriser la trad dans les zones institution
    if (isProtectedInstitutionName(t)) {
      if (isTranslatableInstitutionZone(node)) return false;
      return true;
    }
    // Segments séparés par point médian / barre (tuner, etc.)
    const parts = t.split(/\s*[·|•]\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      if (isTranslatableInstitutionZone(node)) {
        if (parts.some((p) => isProtectedMediaName(p))) return true;
        return false;
      }
      if (parts.some((p) => isProtectedInstitutionName(p) || isProtectedMediaName(p))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Libellés d’établissements fiables par langue.
   *
   * Cégeps : n’existent qu’au Québec — comme Dawson, on mappe le *type* vers
   * College / Colegio / Colégio / Collège et on garde le toponyme (pas de MT
   * libre qui invente « Universidad … »).
   */
  const INSTITUTION_LABELS = {
    'Dawson College': {
      fr: 'Collège Dawson',
      en: 'Dawson College',
      es: 'Colegio Dawson',
      pt: 'Colégio Dawson',
      de: 'Dawson College',
      it: 'Dawson College',
      pl: 'Dawson College',
      default: 'Dawson College',
    },
    "Bishop's University": {
      fr: "Université Bishop's",
      en: "Bishop's University",
      es: "Universidad Bishop's",
      pt: "Universidade Bishop's",
      de: "Bishop's University",
      default: "Bishop's University",
    },
    'Polytechnique Montréal': {
      fr: 'Polytechnique Montréal',
      en: 'Polytechnique Montréal',
      es: 'Polytechnique Montréal',
      default: 'Polytechnique Montréal',
    },
    'Université de Montréal': {
      fr: 'Université de Montréal',
      en: 'Université de Montréal',
      es: 'Universidad de Montréal',
      pt: 'Universidade de Montréal',
      default: 'Université de Montréal',
    },
    'Université Laval': {
      fr: 'Université Laval',
      en: 'Université Laval',
      es: 'Universidad Laval',
      pt: 'Universidade Laval',
      default: 'Université Laval',
    },
    'Université de Sherbrooke': {
      fr: 'Université de Sherbrooke',
      en: 'Université de Sherbrooke',
      es: 'Universidad de Sherbrooke',
      pt: 'Universidade de Sherbrooke',
      default: 'Université de Sherbrooke',
    },
    'Université McGill': {
      fr: 'Université McGill',
      en: 'McGill University',
      es: 'Universidad McGill',
      pt: 'Universidade McGill',
      default: 'Université McGill',
    },
    'McGill University': {
      fr: 'Université McGill',
      en: 'McGill University',
      es: 'Universidad McGill',
      pt: 'Universidade McGill',
      default: 'McGill University',
    },
    'Concordia University': {
      fr: 'Université Concordia',
      en: 'Concordia University',
      es: 'Universidad Concordia',
      pt: 'Universidade Concordia',
      default: 'Concordia University',
    },
    'Université du Québec à Montréal': {
      fr: 'Université du Québec à Montréal',
      en: 'Université du Québec à Montréal',
      es: 'Universidad de Quebec en Montréal',
      pt: 'Universidade de Quebec em Montréal',
      default: 'Université du Québec à Montréal',
    },
    UQAM: {
      fr: 'Université du Québec à Montréal',
      en: 'Université du Québec à Montréal',
      es: 'Universidad de Quebec en Montréal',
      pt: 'Universidade de Quebec em Montréal',
      default: 'Université du Québec à Montréal',
    },
    'Université du Québec à Trois-Rivières': {
      fr: 'Université du Québec à Trois-Rivières',
      en: 'Université du Québec à Trois-Rivières',
      es: 'Universidad de Quebec en Trois-Rivières',
      pt: 'Universidade de Quebec em Trois-Rivières',
      default: 'Université du Québec à Trois-Rivières',
    },
  };

  /** Langues où l’on adapte le *type* (Universidad / Universidade…). */
  const INSTITUTION_TYPE_LOCALIZE = new Set([
    'es', 'pt', 'de', 'it', 'pl', 'nl', 'ro', 'ca',
  ]);

  function institutionLangKey(targetLang = '') {
    const raw = String(targetLang || '').toLowerCase();
    if (raw.startsWith('zh')) return raw.includes('tw') || raw.includes('hant') ? 'zh-tw' : 'zh';
    if (raw === 'iw') return 'he';
    if (raw === 'fil') return 'tl';
    return raw.split(/[-_]/)[0] || raw;
  }

  /**
   * Cégeps et collèges du Québec ≠ universités.
   * Un cégep / college préuniversitaire ne doit jamais être libellé
   * « University / Universidad / Universidade / … ».
   */
  const QC_COLLEGE_PLACE_RE = new RegExp(
    [
      'Dawson',
      'Vieux[\\s-]?Montr[eé]al',
      'Jonqui[eè]re',
      'Maisonneuve',
      'Lionel[\\s-]?Groulx',
      'Ahuntsic',
      'Bois[\\s-]?de[\\s-]?Boulogne',
      'Édouard[\\s-]?Montpetit',
      'Edouard[\\s-]?Montpetit',
      'Garneau',
      'Limoilou',
      'Ste?[\\s-]?Foy',
      'Marie[\\s-]?Victorin',
      'Montmorency',
      'André[\\s-]?Laurendeau',
      'Andre[\\s-]?Laurendeau',
      'Saint[\\s-]?Laurent',
      'Rosemont',
      'Gérald[\\s-]?Godin',
      'Gerald[\\s-]?Godin',
      'John\\s+Abbott',
      'Vanier',
      'Champlain',
    ].join('|'),
    'i',
  );

  function isCegepInstitutionName(name = '') {
    return /^c[eé]gep\b/i.test(String(name || '').replace(/\s+/g, ' ').trim());
  }

  function isCollegeInstitutionName(name = '') {
    const t = String(name || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    // Préfixe Collège / College / Colegio…
    if (/^(?:coll[eè]ge|college|colegio|col[eé]gio|col·legi)\b/i.test(t)) return true;
    // Dawson College et collèges anglo du réseau collégial québécois
    if (/^dawson\s+college$/i.test(t)) return true;
    // Formes localisées « Jonquière College », « Vieux Montréal College » (cégep → College)
    // ou collèges CEGEP-network : jamais des universités.
    if (/\bcollege$/i.test(t) && QC_COLLEGE_PLACE_RE.test(t)) return true;
    return false;
  }

  /** Cégep ou collège québécois (préuniversitaire / technique) — pas une université. */
  function isCegepOrCollegeInstitution(name = '') {
    return isCegepInstitutionName(name) || isCollegeInstitutionName(name);
  }

  /**
   * Frontière de mot compatible accents : en JS, `\b` après `é` échoue
   * (é n’est pas un « word char » ASCII) — d’où « Université » non détectée.
   */
  function uniTypePrefixRe() {
    // Université | University | Universidad | Universidade | Universität | …
    return /^(?:universit(?:é|e|y|ad|ade|ät|à|eit|atea|at)|university)(?=\s|$|[^A-Za-z])/i;
  }

  function isUniversityInstitutionName(name = '') {
    const t = String(name || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    // Garde-fou : un cégep / collège n’est jamais une université
    if (isCegepOrCollegeInstitution(t)) return false;
    if (/^(?:UQAM|UdeM|ULaval|UdeS|UQTR|UQAC|UQAR|UQO|UQAT)$/i.test(t)) return true;
    if (uniTypePrefixRe().test(t)) return true;
    if (/\buniversity$/i.test(t)) return true;
    if (/^(?:mcgill|concordia)\b/i.test(t) && !/\bcollege\b/i.test(t)) return true;
    return false;
  }

  /**
   * Si l’original est un cégep/collège, retire tout libellé de type université
   * introduit par MT ou une mauvaise localisation.
   */
  function demoteUniversityLabelIfCollege(original = '', translated = '', lang = '') {
    if (!isCegepOrCollegeInstitution(original)) return translated;
    let t = String(translated || '');
    if (!t) return t;

    const L = institutionLangKey(lang || translateTargetLang || '');

    // Remplacer les mots-type « université » par l’équivalent collège selon la langue
    const collegeType = ({
      fr: 'Collège',
      es: 'Colegio',
      pt: 'Colégio',
      it: 'College',
      de: 'College',
      pl: 'College',
      nl: 'College',
      ro: 'Colegiul',
      ca: 'Col·legi',
      en: 'College',
    })[L] || 'College';

    // Remplace tout type « université / university / universidad… » (accents inclus).
    // Pas de `\b` après `é` : en JS ça ne matche pas « Université ».
    t = t
      .replace(/(?<![A-Za-z])Universidades?(?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])Universidad(?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])Universidade(?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])Universität(?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])Università(?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])Uniwersytet(?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])Universiteit(?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])Universitatea(?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])Universitat(?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])Universit[eé](?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])University(?![A-Za-z])/giu, collegeType)
      .replace(/(?<![A-Za-z])univ\.(?![A-Za-z])/giu, collegeType);

    // « College of Dawson » / calques inutiles → nom propre + College
    if (/\bdawson\b/i.test(original) || /\bdawson\b/i.test(t)) {
      if (L === 'es') t = t.replace(/\b(?:Colegio|College|Collège)\s+(?:de\s+|del\s+)?Dawson\b/giu, 'Colegio Dawson')
        .replace(/\bDawson\s+(?:Colegio|College|Collège|University|Universidad)\b/giu, 'Colegio Dawson');
      else if (L === 'pt') t = t.replace(/\b(?:Colégio|College|Collège)\s+(?:de\s+|do\s+)?Dawson\b/giu, 'Colégio Dawson')
        .replace(/\bDawson\s+(?:Colégio|College|Collège|University|Universidade)\b/giu, 'Colégio Dawson');
      else if (L === 'fr') t = t.replace(/\b(?:Collège|College)\s+(?:de\s+)?Dawson\b/giu, 'Collège Dawson')
        .replace(/\bDawson\s+(?:Collège|College|Université|University)\b/giu, 'Collège Dawson');
      else t = t.replace(/\b(?:College|Collège|Colegio|Colégio)\s+(?:de\s+|of\s+)?Dawson\b/giu, 'Dawson College')
        .replace(/\bDawson\s+(?:College|Collège|University|Universidad|Université)\b/giu, 'Dawson College');
    }

    // Cégep : si le type a été perdu, préférer un libellé collège stable
    if (isCegepInstitutionName(original) && /\buniversit/i.test(t)) {
      const preferred = preferredInstitutionLabel(original, L || lang);
      if (preferred) return preferred;
    }

    return t;
  }

  /**
   * Universités : pas de MT libre (gtx invente des syllabiques / casse les
   * noms propres). Glossaire d’abord ; sinon adaptation du type pour es/pt/…
   * ou conservation du nom officiel.
   */
  function formatUniversityLabel(name = '', lang = 'fr') {
    const key = String(name || '').replace(/\s+/g, ' ').trim();
    if (!key) return null;

    // Acronymes → forme longue officielle (FR) avant localisation du type
    const expanded = INSTITUTION_LABELS[key]?.fr
      || INSTITUTION_LABELS[key]?.default
      || key;

    // Glossaire exact (y compris entrée acronyme)
    const entry = INSTITUTION_LABELS[key]
      || INSTITUTION_LABELS[expanded]
      || Object.entries(INSTITUTION_LABELS).find(
        ([k]) => k.toLowerCase() === key.toLowerCase()
          || k.toLowerCase() === expanded.toLowerCase(),
      )?.[1];
    if (entry) return entry[lang] || entry.default || expanded;

    // Hors langues à type localisable : conserver le nom officiel
    if (!INSTITUTION_TYPE_LOCALIZE.has(lang)) {
      return expanded;
    }

    const typeWord = {
      es: 'Universidad',
      pt: 'Universidade',
      de: 'Universität',
      it: 'Università',
      pl: 'Uniwersytet',
      nl: 'Universiteit',
      ro: 'Universitatea',
      ca: 'Universitat',
    }[lang] || 'University';

    // « McGill University », « Concordia University »
    let m = expanded.match(/^(.+?)\s+University$/i);
    if (m) {
      const place = m[1].trim();
      if (lang === 'de') return `${place}-${typeWord}`;
      return `${typeWord} ${place}`;
    }

    // « Université de Montréal », « Université du Québec à … », « Université Laval »
    m = expanded.match(/^Universit[eé]\s+(de\s+|du\s+|des\s+|d['’]\s*)?(.+)$/i);
    if (m) {
      const particle = (m[1] || '').toLowerCase().trim();
      const rest = m[2].trim();
      if (lang === 'es') {
        if (!particle) return `${typeWord} ${rest}`;
        if (particle.startsWith('du')) return `${typeWord} del ${rest}`;
        return `${typeWord} de ${rest}`;
      }
      if (lang === 'pt') {
        if (!particle) return `${typeWord} ${rest}`;
        if (particle.startsWith('du')) return `${typeWord} do ${rest}`;
        return `${typeWord} de ${rest}`;
      }
      if (lang === 'de') {
        const place = rest.replace(/^(de|du|des|d['’])\s+/i, '').trim();
        return `${typeWord} ${place}`;
      }
      if (lang === 'it') {
        if (!particle) return `${typeWord} ${rest}`;
        return `${typeWord} di ${rest.replace(/^(de|du|des)\s+/i, '')}`;
      }
      if (lang === 'pl') {
        const place = rest.replace(/^(de|du|des|d['’])\s+/i, '').trim();
        return `${typeWord} ${place}`;
      }
      if (lang === 'nl' || lang === 'ca' || lang === 'ro') {
        if (!particle) return `${typeWord} ${rest}`;
        return `${typeWord} de ${rest.replace(/^(de|du|des)\s+/i, '')}`;
      }
      return expanded;
    }

    return expanded;
  }

  /**
   * Sépare « Cégep de Jonquière (ATM – journalisme) »
   * → particle « de », place « Jonquière », note « (ATM – journalisme) ».
   */
  function parseCegepParts(name = '') {
    const raw = String(name).replace(/\s+/g, ' ').trim()
      .replace(/^c[eé]gep\b/i, 'Cégep');
    const m = raw.match(
      /^Cégep\s+(de|du|des|d')\s+(.+?)(?:\s*(\([^)]*\)))?\s*$/i,
    );
    if (!m) {
      const loose = raw.match(/^Cégep\s+(.+?)(?:\s*(\([^)]*\)))?\s*$/i);
      if (!loose) return null;
      return { particle: '', place: loose[1].trim(), note: (loose[2] || '').trim() };
    }
    return {
      particle: m[1].toLowerCase().replace(/^d'$/i, "d'"),
      place: m[2].trim(),
      note: (m[3] || '').trim(),
    };
  }

  function localizeCegepNote(note = '', lang = 'fr') {
    if (!note) return '';
    if (lang === 'en') {
      return note
        .replace(/\bjournalisme\b/gi, 'journalism')
        .replace(/\barts?\s+et\s+lettres\b/gi, 'arts and letters');
    }
    return note;
  }

  /**
   * Cégep → équivalent « college » hors FR (comme Dawson College → Colegio Dawson).
   * FR : on garde le mot officiel « Cégep ».
   */
  function formatCegepLabel(name = '', lang = 'fr') {
    const parts = parseCegepParts(name);
    if (!parts) {
      return String(name).replace(/\s+/g, ' ').trim().replace(/^c[eé]gep\b/i, 'Cégep');
    }
    const { particle, place, note } = parts;
    const noteLoc = localizeCegepNote(note, lang);
    const noteSuffix = noteLoc ? ` ${noteLoc}` : '';

    // Français : libellé institutionnel officiel
    if (lang === 'fr') {
      const p = particle === "d'" ? "d'" : (particle ? `${particle} ` : '');
      return `Cégep ${p}${place}${noteSuffix}`.replace(/\s+/g, ' ').trim();
    }

    // Anglais : « Jonquière College », « Vieux Montréal College » (style Dawson)
    if (lang === 'en') {
      return `${place} College${noteSuffix}`.replace(/\s+/g, ' ').trim();
    }

    // Espagnol / portugais : Colegio/Colégio + particule adaptée
    if (lang === 'es') {
      let p = particle;
      if (p === 'du') p = 'del';
      else if (p === "d'") p = 'de';
      else if (p === 'des') p = 'de';
      else if (!p) p = 'de';
      const join = p === 'de' || p === 'del' ? `${p} ` : `${p} `;
      return `Colegio ${join}${place}${noteSuffix}`.replace(/\s+/g, ' ').trim();
    }
    if (lang === 'pt') {
      let p = particle;
      if (p === 'du') p = 'do';
      else if (p === "d'") p = 'de';
      else if (p === 'des') p = 'de';
      else if (!p) p = 'de';
      return `Colégio ${p} ${place}${noteSuffix}`.replace(/\s+/g, ' ').trim();
    }

    // Autres langues : même schéma qu’en anglais (toponyme + College)
    return `${place} College${noteSuffix}`.replace(/\s+/g, ' ').trim();
  }

  /**
   * Collège Lionel-Groulx, Collège de Maisonneuve, Dawson College…
   * Type adapté à la langue ; nom propre intact (modèle Dawson).
   */
  function formatCollegeLabel(name = '', lang = 'fr') {
    const raw = String(name).replace(/\s+/g, ' ').trim();
    if (/^dawson\s+college$/i.test(raw)) {
      const entry = INSTITUTION_LABELS['Dawson College'];
      return (entry && (entry[lang] || entry.default)) || 'Dawson College';
    }
    const rest = raw
      .replace(/^(?:coll[eè]ge|college)\b\s*/i, '')
      .trim();
    if (!rest) return raw;
    // EN : « Maisonneuve College » si « de Maisonneuve », sinon « Lionel-Groulx College »
    if (lang === 'en') {
      const place = rest.replace(/^(de|du|des|d')\s+/i, '').trim();
      return `${place} College`;
    }
    if (lang === 'es') {
      let r = rest.replace(/^du\s+/i, 'del ').replace(/^d'\s*/i, 'de ');
      if (!/^(de|del)\s/i.test(r)) r = `de ${r}`;
      return `Colegio ${r}`;
    }
    if (lang === 'pt') {
      let r = rest.replace(/^du\s+/i, 'do ').replace(/^d'\s*/i, 'de ');
      if (!/^(de|do)\s/i.test(r)) r = `de ${r}`;
      return `Colégio ${r}`;
    }
    if (lang === 'de' || lang === 'it' || lang === 'pl') {
      const place = rest.replace(/^(de|du|des|d')\s+/i, '').trim();
      return `${place} College`;
    }
    return `Collège ${rest}`;
  }

  function preferredInstitutionLabel(original = '', targetLang = '') {
    // Pas de glossaire / mapping en FR, EN ou Original
    if (!shouldLocalizeInstitutions(targetLang)) return null;

    const key = String(original || '').replace(/\s+/g, ' ').trim();
    if (!key) return null;
    const lang = institutionLangKey(targetLang);

    // Ordre critique : cégep/collège AVANT université, pour ne jamais
    // promouvoir un collège québécois en « University / Universidad ».

    // 1) Cégeps → College / Colegio… (jamais Universidad)
    if (isCegepInstitutionName(key)) {
      return formatCegepLabel(key, lang);
    }

    // 2) Collèges / colleges (Dawson, formes « X College », etc.)
    if (isCollegeInstitutionName(key)) {
      return formatCollegeLabel(key, lang);
    }

    // 3) Glossaire exact (Bishop's = univ, Polytechnique, UdeM…)
    //    Dawson est aussi dans le glossaire, mais déjà traité en (2).
    const entry = INSTITUTION_LABELS[key]
      || Object.entries(INSTITUTION_LABELS).find(
        ([k]) => k.toLowerCase() === key.toLowerCase(),
      )?.[1];
    if (entry) {
      const label = entry[lang] || entry.default || null;
      // Cegep/college glissés dans le glossaire : filet anti-université
      if (label && isCegepOrCollegeInstitution(key)) {
        return demoteUniversityLabelIfCollege(key, label, lang);
      }
      return label;
    }

    // 4) Universités — mapping type (Universidad / University…) sans MT
    if (isUniversityInstitutionName(key)) {
      const mapped = formatUniversityLabel(key, lang);
      // Si le mapping n’a rien changé (ex. IU, hi, ar) → null pour laisser gtx
      // dans les zones pastilles / meta (sinon les Sources restent en français).
      if (mapped && mapped !== key) return mapped;
      if (prefersMachineUi(lang) || !INSTITUTION_TYPE_LOCALIZE.has(lang)) return null;
      return mapped || key;
    }

    // 5) Non reconnu : MT autorisé hors FR/EN (null = appel gtx côté translateDom)
    return null;
  }

  /** Filet de casse après gtx (ex. ES : « universidad laval »). */
  function fixInstitutionTranslationCasing(str = '') {
    // Lookarounds ASCII : `\b` casse sur les accents (é, è, ç…).
    let s = String(str);
    s = s.replace(/(?<![A-Za-z])université(?![A-Za-z])/giu, 'Université');
    s = s.replace(/(?<![A-Za-z])universite(?![A-Za-z])/giu, 'Université');
    s = s.replace(/(?<![A-Za-z])university(?![A-Za-z])/giu, 'University');
    s = s.replace(/(?<![A-Za-z])universidad(?![A-Za-z])/giu, 'Universidad');
    s = s.replace(/(?<![A-Za-z])universidade(?![A-Za-z])/giu, 'Universidade');
    s = s.replace(/(?<![A-Za-z])universität(?![A-Za-z])/giu, 'Universität');
    s = s.replace(/(?<![A-Za-z])università(?![A-Za-z])/giu, 'Università');
    s = s.replace(/(?<![A-Za-z])cégep(?![A-Za-z])/giu, 'Cégep');
    s = s.replace(/(?<![A-Za-z])cegep(?![A-Za-z])/giu, 'Cégep');
    s = s.replace(/(?<![A-Za-z])college(?![A-Za-z])/giu, 'College');
    s = s.replace(/(?<![A-Za-z])collège(?![A-Za-z])/giu, 'Collège');
    s = s.replace(/(?<![A-Za-z])colegio(?![A-Za-z])/giu, 'Colegio');
    s = s.replace(/(?<![A-Za-z])colégio(?![A-Za-z])/giu, 'Colégio');
    s = s.replace(/(?<![A-Za-z])laval(?![A-Za-z])/giu, 'Laval');
    s = s.replace(/(?<![A-Za-z])montr[eé]al(?![A-Za-z])/giu, (m) => (m.includes('é') ? 'Montréal' : 'Montreal'));
    s = s.replace(/(?<![A-Za-z])sherbrooke(?![A-Za-z])/giu, 'Sherbrooke');
    s = s.replace(/(?<![A-Za-z])mcgill(?![A-Za-z])/giu, 'McGill');
    s = s.replace(/(?<![A-Za-z])concordia(?![A-Za-z])/giu, 'Concordia');
    s = s.replace(/(?<![A-Za-z])dawson(?![A-Za-z])/giu, 'Dawson');
    s = s.replace(/(?<![A-Za-z])qu[eé]bec(?![A-Za-z])/giu, (m) => (m.includes('é') ? 'Québec' : 'Quebec'));
    return s;
  }

  /**
   * Corrige les contresens gtx sur les établissements connus
   * (Dawson / cégeps ≠ universidad ; Bishop’s ≠ Obispo).
   */
  function fixInstitutionMistranslations(original = '', translated = '', targetLang = '') {
    let t = String(translated || '');
    const o = String(original || '').toLowerCase();
    const lang = institutionLangKey(targetLang || translateTargetLang || '');

    // ── Cégeps & collèges QC : JAMAIS une université ──────────────────────
    if (isCegepOrCollegeInstitution(original) || /\bc[eé]gep\b/i.test(original)) {
      // Réappliquer le libellé collégial fiable si dispo
      const preferred = preferredInstitutionLabel(original, lang || targetLang);
      if (preferred && !/\buniversit/i.test(preferred)) {
        t = preferred;
      } else {
        t = demoteUniversityLabelIfCollege(original, t, lang);
        // Calques gtx fréquents : Universidad de Vieux / University of Jonquière…
        t = t
          .replace(
            /\b(?:Universidad|Universidade|University|Université|Universität|Università|Uniwersytet)\s+(?:de\s+|del\s+|do\s+|di\s+|of\s+|du\s+)?(?=Vieux|Jonqui|Maisonneuve|Lionel|Dawson|Ahuntsic|Garneau|Vanier|Champlain|Abbott|Montpetit|Laurendeau|Montmorency|Rosemont|Godin)/giu,
            lang === 'es' ? 'Colegio de ' : lang === 'pt' ? 'Colégio de ' : lang === 'fr' ? 'Collège ' : '',
          );
        // Si on a vidé le type, reconstruire « Place College »
        if (lang !== 'es' && lang !== 'pt' && lang !== 'fr') {
          t = t
            .replace(/\bDawson\b(?:\s+(?:College|University))?/giu, 'Dawson College')
            .replace(/\b(Vieux\s*Montr[eé]al)\b(?:\s+(?:College|University))?/giu, 'Vieux Montréal College')
            .replace(/\b(Jonqui[eè]re)\b(?:\s+(?:College|University))?/giu, 'Jonquière College');
        }
        t = t.replace(/\bcegep\b/giu, 'Cégep');
      }
      // Filet final : plus aucun mot « universit* » sur un collège
      t = demoteUniversityLabelIfCollege(original, t, lang);
      return t;
    }

    // Dawson mentionné hors détection stricte
    if (/\bdawson\b/.test(o) || /\bdawson\b/i.test(t)) {
      t = t
        .replace(/\bUniversidad(?:\s+de)?\s+Dawson\b/giu, 'Colegio Dawson')
        .replace(/\bUniversidade(?:\s+de)?\s+Dawson\b/giu, 'Colégio Dawson')
        .replace(/\bUniversità(?:\s+di)?\s+Dawson\b/giu, 'Dawson College')
        .replace(/\bUniwersytet\s+Dawsona?\b/giu, 'Dawson College')
        .replace(/\b(?:The\s+)?University\s+of\s+Dawson\b/giu, 'Dawson College')
        .replace(/\bDawson\s+University\b/giu, 'Dawson College')
        .replace(/\bUniversité\s+Dawson\b/giu, 'Collège Dawson')
        .replace(/\bDawson-Universität\b/giu, 'Dawson College')
        .replace(/\bUniversität\s+Dawson\b/giu, 'Dawson College');
    }

    // Bishop's University — ne pas traduire Bishop → Obispo / Bispo
    // (c’est bien une université ; on garde le type University / Universidad)
    if (/bishop/.test(o) || /obispo|bispo|biskup/i.test(t)) {
      t = t
        .replace(/\bUniversidad del Obispo\b/giu, "Universidad Bishop's")
        .replace(/\bUniversidade do Bispo\b/giu, "Universidade Bishop's")
        .replace(/\bUniwersytet Biskupi\b/giu, "Bishop's University")
        .replace(/\bUniversité de l['’]Évêque\b/giu, "Université Bishop's")
        .replace(/\bUniversity of the Bishop\b/giu, "Bishop's University")
        // Ne jamais rétrograder Bishop's en college
        .replace(/\bColegio(?:\s+de)?\s+Bishop'?s?\b/giu, "Universidad Bishop's")
        .replace(/\bColégio(?:\s+de)?\s+Bishop'?s?\b/giu, "Universidade Bishop's")
        .replace(/\bBishop'?s?\s+College\b/giu, "Bishop's University");
    }

    return t;
  }

  function polishInstitutionTranslation(original, translated, targetLang) {
    const preferred = preferredInstitutionLabel(original, targetLang);
    if (preferred) {
      // Même un glossaire ne doit pas coller « University » sur un cégep
      return demoteUniversityLabelIfCollege(original, preferred, targetLang);
    }
    let out = fixInstitutionTranslationCasing(translated);
    out = fixInstitutionMistranslations(original, out, targetLang);
    out = demoteUniversityLabelIfCollege(original, out, targetLang);
    return out;
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.translate === false) return true;
    if (el.classList?.contains('notranslate')) return true;
    if (el.getAttribute?.('translate') === 'no') return true;
    if (SKIP_CLASS_RE.test(el.className || '')) return true;
    if (el.closest?.('.notranslate, [translate="no"], .translate-control, .sr-only, .article-source, .article-author, .filter-btn__name, .article-media-credit')) {
      return true;
    }
    return false;
  }

  /**
   * Articles de la suite du fil encore repliés (sous le pli « Plus d'articles »).
   * On ne les envoie pas au MT tant que l’utilisateur n’a pas déplié —
   * gain net de latence (souvent 50–150 chaînes en moins).
   */
  function isInCollapsedTailOverflow(node) {
    const el = node && node.nodeType === 3 ? node.parentElement : node;
    if (!el || el.nodeType !== 1) return false;
    if (el.closest?.('.is-tail-overflow, [data-translate-skip="1"]')) return true;
    const tail = el.closest?.('.news-tail');
    if (!tail || !tail.classList.contains('has-overflow') || tail.classList.contains('is-expanded')) {
      return false;
    }
    const article = el.closest?.('.article, a.article');
    if (!article || !tail.contains(article)) return false;
    const body = tail.querySelector('.news-tail-body');
    if (!body) return false;
    const cards = [...body.querySelectorAll(':scope > .article, :scope > a.article')];
    const idx = cards.indexOf(article);
    if (idx < 0) return false;
    const visible = parseInt(tail.dataset.tailVisible || '10', 10) || 10;
    return idx >= visible;
  }

  function collectTextNodes(root = document.body, { includeCollapsedTail = false } = {}) {
    if (!root) return [];
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const val = node.nodeValue;
        if (!val || !val.trim()) return NodeFilter.FILTER_REJECT;
        // Ignorer purement numérique / ponctuation
        if (!/[\p{L}]/u.test(val)) return NodeFilter.FILTER_REJECT;
        // Suite du fil repliée : ignorer les cartes hors écran
        if (!includeCollapsedTail && isInCollapsedTailOverflow(node)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Noms de médias (toujours) / établissements hors pastilles sources
        if (isProtectedProperName(val, node)) return NodeFilter.FILTER_REJECT;
        let p = node.parentElement;
        while (p) {
          if (shouldSkipElement(p)) return NodeFilter.FILTER_REJECT;
          // Ne pas remonter hors de root
          if (p === root) break;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function rememberOriginal(node) {
    if (!originalByNode.has(node)) {
      originalByNode.set(node, node.nodeValue);
    }
    return originalByNode.get(node);
  }

  function restoreOriginals(root = document.body) {
    const nodes = collectTextNodes(root);
    for (const node of nodes) {
      if (originalByNode.has(node)) {
        node.nodeValue = originalByNode.get(node);
      }
    }
  }

  async function translateDom(targetLang, {
    quiet = false,
    root = document.body,
    /** Si true : ne réécrit que les nœuds encore à l’original (dépliage suite du fil). */
    onlyUntranslated = false,
    includeCollapsedTail = false,
  } = {}) {
    if (!targetLang || translating) return;
    translating = true;
    translateTargetLang = targetLang;
    document.documentElement.dataset.translateBusy = '1';
    if (!quiet) {
      notify(`Traduction en cours… (${labelForMode(activeMode).short || targetLang})`);
    }

    try {
      const nodes = collectTextNodes(root, { includeCollapsedTail });
      // Grouper par texte original (dédup) — une requête MT par chaîne unique
      const byText = new Map(); // original → [nodes]
      for (const node of nodes) {
        const orig = rememberOriginal(node);
        if (onlyUntranslated && node.nodeValue !== orig) continue;
        if (!byText.has(orig)) byText.set(orig, []);
        byText.get(orig).push(node);
      }

      const entries = [...byText.entries()];
      let ok = 0;
      let fail = 0;

      for (let i = 0; i < entries.length; i += CONCURRENCY) {
        const batch = entries.slice(i, i + CONCURRENCY);
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(batch.map(async ([orig, list]) => {
          try {
            const instNodes = list.filter((n) => isTranslatableInstitutionZone(n));
            // Noms d’établissements : glossaire / mapping type d’abord ;
            // si pas de mapping (IU, ar, …) → MT + filet collège/université.
            if (instNodes.length && instNodes.length === list.length) {
              let preferred = preferredInstitutionLabel(orig, targetLang);
              if (preferred) {
                preferred = demoteUniversityLabelIfCollege(orig, preferred, targetLang);
                for (const node of list) {
                  if (node.parentNode) {
                    node.nodeValue = reapplyEdgeWhitespace(orig, preferred);
                  }
                }
                ok += 1;
                return;
              }
              // Fall through to MT for script languages / unmapped labels
            }

            // Glossaire UI avant MT (À la une, En bref, Par, Plus d'articles…)
            const uiHit = preferredUiPhrase(String(orig).replace(/^\s+|\s+$/g, ''), targetLang);
            let translated = uiHit != null
              ? reapplyEdgeWhitespace(orig, uiHit)
              : await translateText(orig, targetLang);

            if (translated && translated !== orig) {
              for (const node of list) {
                if (!node.parentNode) continue;
                if (onlyUntranslated && node.nodeValue !== orig) continue;
                // Filet institution seulement dans les zones dédiées — pas sur le corps
                const out = isTranslatableInstitutionZone(node)
                  ? polishInstitutionTranslation(orig, translated, targetLang)
                  : (
                    isInstitutionLabelZone(node)
                      ? fixInstitutionMistranslations(orig, translated, targetLang)
                      : translated
                  );
                node.nodeValue = out;
              }
              ok += 1;
            } else {
              fail += 1;
            }
          } catch {
            fail += 1;
          }
        }));
      }

      saveCache();

      if (!quiet) {
        const m = labelForMode(activeMode);
        if (ok === 0 && entries.length > 0) {
          notify('Traduction indisponible pour le moment. Réessayez dans quelques secondes.');
        } else {
          notify(`Page affichée en ${m.label}`);
        }
      }
    } finally {
      translating = false;
      translateTargetLang = null;
      document.documentElement.removeAttribute('data-translate-busy');
    }
  }

  /** Dépliage Suite du fil : MT uniquement les cartes nouvellement visibles. */
  function onNewsTailExpand() {
    if (activeMode === DEFAULT_MODE || translating) return;
    const target = googCodeForMode(activeMode);
    if (!target) return;
    const tail = document.querySelector('.news-tail');
    if (!tail) return;
    // Traduire le corps entier du tail en onlyUntranslated (cartes déjà faites = skip)
    const body = tail.querySelector('.news-tail-body') || tail;
    translateDom(target, {
      quiet: true,
      root: body,
      onlyUntranslated: true,
      includeCollapsedTail: true,
    });
  }

  function updateUi(mode) {
    const m = labelForMode(mode);
    const label = document.getElementById('translate-label');
    const btn = document.getElementById('translate-toggle');
    const menu = document.getElementById('translate-menu');
    if (label) {
      label.textContent = mode === DEFAULT_MODE ? m.label : m.short;
    }
    if (btn) {
      btn.title = m.title;
      btn.setAttribute(
        'aria-label',
        mode === DEFAULT_MODE
          ? 'Langue : original — aucune traduction. Ouvrir pour traduire la page.'
          : `Langue d'affichage : ${m.label}. Changer la langue.`,
      );
      btn.dataset.mode = mode;
    }
    if (menu) {
      menu.querySelectorAll('[data-mode]').forEach((opt) => {
        const active = opt.dataset.mode === mode;
        opt.setAttribute('aria-selected', active ? 'true' : 'false');
        opt.classList.toggle('is-active', active);
      });
    }
    document.documentElement.dataset.translate = mode;
    // Ne jamais poser dir=rtl sur <html> : le chrome (tuner, filtres, masthead)
    // est conçu en LTR et bascule en overflow horizontal (scroll vers la gauche).
    // On marque seulement le contenu éditorial via data-script-dir.
    const rtl = new Set(['ar', 'fa', 'he', 'ur']);
    document.documentElement.removeAttribute('dir');
    if (mode === DEFAULT_MODE) {
      document.documentElement.lang = 'fr-CA';
      document.documentElement.removeAttribute('data-script-dir');
    } else if (mode === 'en') {
      document.documentElement.lang = 'en-CA';
      document.documentElement.removeAttribute('data-script-dir');
    } else if (mode === 'fr') {
      document.documentElement.lang = 'fr-CA';
      document.documentElement.removeAttribute('data-script-dir');
    } else if (mode === 'zh') {
      document.documentElement.lang = 'zh-Hans';
      document.documentElement.removeAttribute('data-script-dir');
    } else if (mode === 'zh-tw') {
      document.documentElement.lang = 'zh-Hant';
      document.documentElement.removeAttribute('data-script-dir');
    } else if (mode === 'iu' || mode === 'iu-latn') {
      document.documentElement.lang = 'iu';
      document.documentElement.removeAttribute('data-script-dir');
    } else if (mode === 'he') {
      document.documentElement.lang = 'he';
      document.documentElement.dataset.scriptDir = 'rtl';
    } else {
      const code = googCodeForMode(mode) || mode;
      document.documentElement.lang = code === 'iw' ? 'he' : code;
      if (rtl.has(mode)) document.documentElement.dataset.scriptDir = 'rtl';
      else document.documentElement.removeAttribute('data-script-dir');
    }
  }

  let menuPositionBound = false;

  /**
   * Place le menu en fixed sous le bouton, entièrement dans le viewport.
   * Évite le clipping à droite (overflow-x:clip + titres longs après traduction).
   */
  function positionMenu() {
    const menu = document.getElementById('translate-menu');
    const btn = document.getElementById('translate-toggle');
    if (!menu || !btn || menu.hidden) return;

    const pad = 12;
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const btnRect = btn.getBoundingClientRect();

    // Largeur cible : au moins 240, au plus 320, jamais hors écran
    const maxW = Math.min(320, Math.max(160, vw - pad * 2));
    menu.style.width = '';
    menu.style.maxWidth = `${maxW}px`;
    menu.style.maxHeight = '';

    // Mesure après affichage (menu non hidden)
    let menuW = Math.min(Math.max(menu.offsetWidth || 240, 240), maxW);
    let menuH = menu.offsetHeight || 200;
    const maxH = Math.min(vh * 0.75, 560, Math.max(120, vh - pad * 2));
    if (menuH > maxH) {
      menu.style.maxHeight = `${maxH}px`;
      menuH = maxH;
    }

    // Préférer l’alignement droit du bouton (ouvre vers la gauche) ;
    // si ça sort à gauche, basculer ; toujours clamper dans le viewport.
    let left = btnRect.right - menuW;
    if (left < pad) left = btnRect.left;
    if (left + menuW > vw - pad) left = Math.max(pad, vw - pad - menuW);
    if (left < pad) left = pad;

    let top = btnRect.bottom + gap;
    if (top + menuH > vh - pad) {
      // Ouvrir au-dessus du bouton si pas assez de place en bas
      const above = btnRect.top - gap - menuH;
      if (above >= pad) top = above;
      else {
        top = Math.max(pad, vh - pad - menuH);
        menu.style.maxHeight = `${Math.max(120, vh - top - pad)}px`;
      }
    }

    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
  }

  function onMenuViewportChange() {
    positionMenu();
  }

  function bindMenuPositioning() {
    if (menuPositionBound) return;
    menuPositionBound = true;
    window.addEventListener('resize', onMenuViewportChange, { passive: true });
    window.addEventListener('scroll', onMenuViewportChange, { passive: true, capture: true });
  }

  function unbindMenuPositioning() {
    if (!menuPositionBound) return;
    menuPositionBound = false;
    window.removeEventListener('resize', onMenuViewportChange);
    window.removeEventListener('scroll', onMenuViewportChange, true);
  }

  function closeMenu() {
    const menu = document.getElementById('translate-menu');
    const btn = document.getElementById('translate-toggle');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    unbindMenuPositioning();
  }

  function openMenu() {
    const menu = document.getElementById('translate-menu');
    const btn = document.getElementById('translate-toggle');
    if (!menu || !btn) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    // Réinitialiser le filtre à l’ouverture
    const filter = menu.querySelector('#translate-menu-filter');
    if (filter) {
      filter.value = '';
      filterMenuOptions(menu, '');
    }
    // Double rAF : laisser le layout peindre le menu avant mesure
    requestAnimationFrame(() => {
      positionMenu();
      requestAnimationFrame(() => {
        positionMenu();
        // Focus filtre (liste longue) ou option active — pratique accessibilité
        const active = menu.querySelector('.translate-menu__opt.is-active');
        if (filter && window.innerWidth >= 480) {
          filter.focus({ preventScroll: true });
        } else {
          active?.scrollIntoView({ block: 'nearest' });
        }
        active?.scrollIntoView({ block: 'nearest' });
      });
    });
    bindMenuPositioning();
  }

  function toggleMenu() {
    const menu = document.getElementById('translate-menu');
    if (!menu) return;
    if (menu.hidden) openMenu();
    else closeMenu();
  }

  async function applyMode(mode, { persist = true, fromUserClick = false } = {}) {
    if (MODES[mode]?.unavailable) {
      notify(
        `${MODES[mode].label} : la traduction automatique n’est pas encore offerte `
        + 'pour cette langue autochtone. La page reste en original (sans traduction).',
      );
      return;
    }

    if (persist) mode = setMode(mode);
    else if (!mode) mode = DEFAULT_MODE;

    activeMode = mode;
    updateUi(mode);

    if (mode === DEFAULT_MODE) {
      restoreOriginals();
      notifyDisplayRefresh();
      if (fromUserClick) notify('Original — articles dans leur langue, sans traduction');
      return;
    }

    const target = googCodeForMode(mode);
    if (!target) {
      notify('Code de langue inconnu.');
      return;
    }

    await loadProtectedMediaNames();
    // Toujours repartir des originaux avant de re-traduire
    restoreOriginals();
    // Réaligner pastilles sources (marquees) sur les originaux avant MT
    notifyDisplayRefresh();
    await translateDom(target, { quiet: !fromUserClick && !hasUserPreference() });
    // Marquees / libellés « Plus de sources » : reposer les originaux localisés
    // puis laisser un second passage MT pour ce qui n’a pas de glossaire.
    notifyDisplayRefresh();
    await translateDom(target, {
      quiet: true,
      onlyUntranslated: true,
      includeCollapsedTail: false,
    });
  }

  function scheduleRetranslate() {
    if (activeMode === DEFAULT_MODE || translating) return;
    clearTimeout(mutateTimer);
    mutateTimer = window.setTimeout(() => {
      const target = googCodeForMode(activeMode);
      // Re-render news : ne retraduire que ce qui est encore à l’original
      // (et hors overflow replié) — cache + glossaire UI font le reste.
      if (target) {
        translateDom(target, {
          quiet: true,
          onlyUntranslated: true,
          includeCollapsedTail: false,
        });
      }
    }, 400);
  }

  function startObserver() {
    if (mutateObserver || !document.body) return;
    // childList seulement : le fil d'articles se re-rend souvent.
    // Pas de characterData — nos propres nodeValue déclencheraient une boucle.
    mutateObserver = new MutationObserver((mutations) => {
      if (activeMode === DEFAULT_MODE || translating) return;
      for (const m of mutations) {
        if (m.type !== 'childList' || !m.addedNodes?.length) continue;
        // Ignorer le menu de traduction et les nœuds purement techniques
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.closest?.('.translate-control, .notranslate')) continue;
          if (node.nodeType === 1 || node.nodeType === 3) {
            scheduleRetranslate();
            return;
          }
        }
      }
    });
    mutateObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildMenu() {
    const menu = document.getElementById('translate-menu');
    if (!menu) return;

    const frag = document.createDocumentFragment();

    // Filtre (liste longue) — loupe plutôt que placeholder « Filtrer… »
    const searchWrap = document.createElement('div');
    searchWrap.className = 'translate-menu__search-wrap';
    searchWrap.setAttribute('role', 'presentation');
    searchWrap.innerHTML = ''
      + '<label class="translate-menu__search-label" for="translate-menu-filter">'
      + '<span class="sr-only">Filtrer les langues</span>'
      + '</label>'
      + '<div class="translate-menu__search-field">'
      + '<svg class="translate-menu__search-icon" viewBox="0 0 24 24" width="16" height="16" '
      + 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
      + 'stroke-linejoin="round" aria-hidden="true">'
      + '<circle cx="11" cy="11" r="7"/>'
      + '<path d="M20 20l-3.5-3.5"/>'
      + '</svg>'
      + '<input type="search" id="translate-menu-filter" class="translate-menu__search" '
      + 'placeholder="" autocomplete="off" spellcheck="false" '
      + 'aria-label="Filtrer les langues" enterkeyhint="search" />'
      + '</div>';
    frag.appendChild(searchWrap);

    let lastGroup = '';
    let groupEl = null;

    for (const id of MENU_ORDER) {
      const m = MODES[id];
      if (!m) continue;
      const group = m.group || 'other';

      if (group !== lastGroup) {
        const groupLabel = GROUP_LABELS[group];
        if (groupLabel) {
          groupEl = document.createElement('div');
          groupEl.className = 'translate-menu__group';
          groupEl.setAttribute('role', 'group');
          groupEl.setAttribute('aria-label', groupLabel);
          groupEl.dataset.group = group;
          const sep = document.createElement('div');
          sep.className = 'translate-menu__sep';
          sep.setAttribute('role', 'presentation');
          sep.innerHTML = `<span class="translate-menu__sep-label">${escapeHtml(groupLabel)}</span>`;
          groupEl.appendChild(sep);
          frag.appendChild(groupEl);
        } else {
          groupEl = null;
        }
        lastGroup = group;
      }

      const opt = document.createElement('button');
      opt.type = 'button';
      opt.setAttribute('role', 'option');
      opt.id = `translate-opt-${id}`;
      opt.className = 'translate-menu__opt'
        + (id === DEFAULT_MODE ? ' is-active' : '')
        + (m.unavailable ? ' is-unavailable' : '');
      opt.dataset.mode = id;
      opt.dataset.search = `${m.label} ${m.short || ''} ${m.hint || ''} ${id}`.toLowerCase();
      opt.setAttribute('aria-selected', id === DEFAULT_MODE ? 'true' : 'false');
      if (m.unavailable) {
        opt.setAttribute('aria-disabled', 'true');
        opt.title = m.title;
      } else {
        opt.title = m.title;
      }
      // Endonyme (label) + code court en pastille + hint régional
      const code = escapeHtml(m.short || id.toUpperCase());
      opt.innerHTML = `<span class="translate-menu__row">`
        + `<span class="translate-menu__name">${escapeHtml(m.label)}</span>`
        + `<span class="translate-menu__code" aria-hidden="true">${code}</span>`
        + `</span>`
        + `<span class="translate-menu__hint">${escapeHtml(m.hint || '')}</span>`;
      (groupEl || frag).appendChild(opt);
    }

    menu.replaceChildren(frag);

    const filter = menu.querySelector('#translate-menu-filter');
    if (filter) {
      filter.addEventListener('input', () => filterMenuOptions(menu, filter.value));
      filter.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusMenuOption(menu, 1);
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          closeMenu();
          document.getElementById('translate-toggle')?.focus();
        }
      });
    }
  }

  function filterMenuOptions(menu, query = '') {
    const q = String(query || '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const opts = menu.querySelectorAll('.translate-menu__opt');
    let visibleCount = 0;
    opts.forEach((opt) => {
      const hay = (opt.dataset.search || '').normalize('NFD').replace(/\p{M}/gu, '');
      const show = !q || hay.includes(q);
      opt.hidden = !show;
      if (show) visibleCount += 1;
    });
    // Masquer les groupes vides
    menu.querySelectorAll('.translate-menu__group').forEach((g) => {
      const any = g.querySelector('.translate-menu__opt:not([hidden])');
      g.hidden = !any;
    });
    menu.dataset.filterEmpty = visibleCount === 0 ? '1' : '0';
  }

  function visibleMenuOptions(menu) {
    return [...menu.querySelectorAll('.translate-menu__opt:not([hidden]):not([aria-disabled="true"])')];
  }

  function focusMenuOption(menu, delta = 1) {
    const opts = visibleMenuOptions(menu);
    if (!opts.length) return;
    const active = document.activeElement;
    let idx = opts.indexOf(active);
    if (idx < 0) idx = opts.findIndex((o) => o.classList.contains('is-active'));
    if (idx < 0) idx = 0;
    else idx = (idx + delta + opts.length) % opts.length;
    opts[idx].focus();
  }

  function bindUi() {
    const btn = document.getElementById('translate-toggle');
    const menu = document.getElementById('translate-menu');
    const control = document.getElementById('translate-control');
    if (control) {
      control.classList.add('notranslate');
      control.setAttribute('translate', 'no');
    }
    if (!btn || !menu) return;

    buildMenu();

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });

    menu.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-mode]');
      if (!opt || !menu.contains(opt) || opt.getAttribute('aria-disabled') === 'true') return;
      e.stopPropagation();
      const mode = opt.dataset.mode;
      closeMenu();
      if (mode) applyMode(mode, { persist: true, fromUserClick: true });
    });

    // Navigation clavier listbox (WAI-ARIA)
    menu.addEventListener('keydown', (e) => {
      if (menu.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusMenuOption(menu, 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusMenuOption(menu, -1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        visibleMenuOptions(menu)[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        const opts = visibleMenuOptions(menu);
        opts[opts.length - 1]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        const opt = e.target.closest?.('[data-mode]');
        if (opt && menu.contains(opt) && opt.getAttribute('aria-disabled') !== 'true') {
          e.preventDefault();
          const mode = opt.dataset.mode;
          closeMenu();
          if (mode) applyMode(mode, { persist: true, fromUserClick: true });
        }
      }
    });

    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        closeMenu();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
  }

  function init() {
    loadCache();
    startObserver();

    // Catalogue autochtones + noms de médias, puis UI (menu à jour) + auto-traduction
    Promise.all([loadIndigenousRegistry(), loadProtectedMediaNames()]).then(() => {
      bindUi();

      const mode = getMode();
      activeMode = mode;
      updateUi(mode);

      if (mode === DEFAULT_MODE) return;
      const run = () => applyMode(mode, {
        persist: hasUserPreference(),
        fromUserClick: false,
      });
      if (document.readyState === 'complete') {
        window.setTimeout(run, 200);
      } else {
        window.addEventListener('load', () => window.setTimeout(run, 200), { once: true });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /**
   * Libellés à poser depuis app.js (marquees pastilles, « Plus de sources »…)
   * pour rester alignés avec la langue active sans écraser le MT ensuite.
   */
  function displayUiText(original = '') {
    const raw = String(original ?? '');
    const tl = activeMode === DEFAULT_MODE ? null : googCodeForMode(activeMode);
    if (!tl) return raw;
    const hit = preferredUiPhrase(raw.replace(/\s+/g, ' ').trim(), tl);
    return hit != null ? hit : raw;
  }

  function displayInstitutionLabel(original = '') {
    const raw = String(original ?? '').replace(/\s+/g, ' ').trim();
    if (!raw) return raw;
    const tl = activeMode === DEFAULT_MODE ? null : googCodeForMode(activeMode);
    if (!tl || !shouldLocalizeInstitutions(tl)) return raw;
    const hit = preferredInstitutionLabel(raw, tl);
    return hit != null ? hit : raw;
  }

  function notifyDisplayRefresh() {
    try {
      window.dispatchEvent(new CustomEvent('radar:translate-mode', {
        detail: { mode: activeMode, lang: googCodeForMode(activeMode) },
      }));
    } catch { /* ignore */ }
  }

  window.RadarTranslate = {
    getMode,
    applyMode,
    detectBrowserAutoMode,
    hasUserPreference,
    translateText,
    onNewsTailExpand,
    scheduleRetranslate,
    displayUiText,
    displayInstitutionLabel,
    notifyDisplayRefresh,
    DEFAULT_MODE,
    MODES,
  };
})();
