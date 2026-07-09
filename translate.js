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
  // v2 : espaces de bord / après « : » mieux préservés (crédits, pied de page licence)
  const CACHE_KEY = 'radar-translate-cache-v2';
  const CACHE_MAX = 800;
  const DEFAULT_MODE = 'original';
  const CONCURRENCY = 5;
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
    'Université Laval', 'Université de Montréal', 'Université de Sherbrooke',
    'Université McGill', 'McGill University', 'Concordia University',
    "Bishop's University", 'Dawson College',
    'Université du Québec à Montréal', 'Université du Québec à Trois-Rivières',
    'Université du Québec à Chicoutimi', 'Cégep du Vieux Montréal',
    'Cégep de Jonquière', 'Cégep de Jonquière (ATM – journalisme)',
  ]);
  let mediaNamesReady = false;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'PATH', 'MATH', 'IFRAME',
  ]);

  /** Classes / zones où les noms propres restent intacts (médias, auteurs…).
   *  filter-btn__inst : établissements traduisibles dans la liste de sources. */
  const SKIP_CLASS_RE = /\b(?:notranslate|article-source|article-inst|article-author|filter-btn__name|article-media-credit__creator)\b/;

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
    // Dawson n’est pas une université (corrige aussi le corps de page)
    out = fixInstitutionMistranslations('Dawson College', out);
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

  async function translateText(text, targetLang) {
    const original = String(text || '');
    if (!original.trim()) return original;
    // Traduire le cœur sans espaces de bord (clé de cache stable)
    const core = original.replace(/^\s+|\s+$/g, '');
    const tl = gtxLang(targetLang);
    const key = cacheKey(core, tl);

    const finish = (translatedCore) => reapplyEdgeWhitespace(original, translatedCore);

    if (translationCache[key]) return finish(translationCache[key]);

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

  /** Pastilles sources / barre compacte : établissements peuvent être traduits. */
  function isTranslatableInstitutionZone(node) {
    const el = node && node.nodeType === 3 ? node.parentElement : node;
    if (!el || el.nodeType !== 1) return false;
    return !!(el.closest?.('.filter-btn__inst, .filters-compact__inst'));
  }

  /**
   * Noms propres à ne pas traduire (média, établissement hors pastilles sources,
   * ou libellé composé « poste · institution » dans le tuner).
   */
  function isProtectedProperName(text = '', node = null) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    if (isProtectedMediaName(t)) return true;
    // Liste de sources en haut : traduire les noms d'université / cégep
    if (isProtectedInstitutionName(t)) {
      if (isTranslatableInstitutionZone(node)) return false;
      return true;
    }
    // Segments séparés par point médian / barre (tuner, etc.)
    const parts = t.split(/\s*[·|•]\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      if (isTranslatableInstitutionZone(node)) {
        // Dans une pastille, ne bloquer que si un segment est un nom de média
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
  };

  function institutionLangKey(targetLang = '') {
    const raw = String(targetLang || '').toLowerCase();
    if (raw.startsWith('zh')) return raw.includes('tw') || raw.includes('hant') ? 'zh-tw' : 'zh';
    if (raw === 'iw') return 'he';
    if (raw === 'fil') return 'tl';
    return raw.split(/[-_]/)[0] || raw;
  }

  function isCegepInstitutionName(name = '') {
    return /^c[eé]gep\b/i.test(String(name).trim());
  }

  function isCollegeInstitutionName(name = '') {
    return /^(?:coll[eè]ge|college)\b/i.test(String(name).trim())
      || /^dawson\s+college$/i.test(String(name).trim());
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
    const key = String(original || '').replace(/\s+/g, ' ').trim();
    if (!key) return null;
    const lang = institutionLangKey(targetLang);

    // 1) Glossaire exact (Bishop's, Polytechnique, Dawson…)
    const entry = INSTITUTION_LABELS[key]
      || Object.entries(INSTITUTION_LABELS).find(
        ([k]) => k.toLowerCase() === key.toLowerCase(),
      )?.[1];
    if (entry) return entry[lang] || entry.default || null;

    // 2) Cégeps → College / Colegio… (équivalent élégant hors Québec)
    if (isCegepInstitutionName(key)) {
      return formatCegepLabel(key, lang);
    }

    // 3) Collèges / colleges
    if (isCollegeInstitutionName(key)) {
      return formatCollegeLabel(key, lang);
    }

    return null;
  }

  /** Filet de casse après gtx (ex. ES : « universidad laval »). */
  function fixInstitutionTranslationCasing(str = '') {
    return String(str)
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
      .replace(/\blaval\b/giu, 'Laval')
      .replace(/\bmontr[eé]al\b/giu, (m) => (m.includes('é') ? 'Montréal' : 'Montreal'))
      .replace(/\bsherbrooke\b/giu, 'Sherbrooke')
      .replace(/\bmcgill\b/giu, 'McGill')
      .replace(/\bconcordia\b/giu, 'Concordia')
      .replace(/\bdawson\b/giu, 'Dawson')
      .replace(/\bqu[eé]bec\b/giu, (m) => (m.includes('é') ? 'Québec' : 'Quebec'));
  }

  /**
   * Corrige les contresens gtx sur les établissements connus
   * (Dawson / cégeps ≠ universidad ; Bishop’s ≠ Obispo).
   */
  function fixInstitutionMistranslations(original = '', translated = '') {
    let t = String(translated || '');
    const o = String(original || '').toLowerCase();

    // Dawson College — jamais une université
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

    // Cégep / collège QC : gtx transforme parfois en « Universidad de … »
    if (
      isCegepInstitutionName(original)
      || isCollegeInstitutionName(original)
      || /\bc[eé]gep\b/i.test(t)
    ) {
      t = t
        .replace(/\bUniversidad(?:\s+(?:de|del|du))?\s+(?=Vieux|Jonqui|Chicoutimi|Rimouski|Maisonneuve|Lionel|Dawson)/giu, 'Cégep ')
        .replace(/\bUniversidade(?:\s+(?:de|do))?\s+(?=Vieux|Jonqui|Chicoutimi|Rimouski|Maisonneuve|Lionel|Dawson)/giu, 'Cégep ')
        .replace(/\bUniversity\s+of\s+(?=Vieux|Jonqui|Chicoutimi|Rimouski|Maisonneuve|Lionel|Dawson)/giu, 'Cégep ')
        .replace(/\bcegep\b/giu, 'Cégep');
    }

    // Bishop's University — ne pas traduire Bishop → Obispo / Bispo
    if (/bishop/.test(o) || /obispo|bispo|biskup/i.test(t)) {
      t = t
        .replace(/\bUniversidad del Obispo\b/giu, "Universidad Bishop's")
        .replace(/\bUniversidade do Bispo\b/giu, "Universidade Bishop's")
        .replace(/\bUniwersytet Biskupi\b/giu, "Bishop's University")
        .replace(/\bUniversité de l['’]Évêque\b/giu, "Université Bishop's")
        .replace(/\bUniversity of the Bishop\b/giu, "Bishop's University");
    }

    return t;
  }

  function polishInstitutionTranslation(original, translated, targetLang) {
    const preferred = preferredInstitutionLabel(original, targetLang);
    if (preferred) return preferred;
    let out = fixInstitutionTranslationCasing(translated);
    out = fixInstitutionMistranslations(original, out);
    return out;
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.translate === false) return true;
    if (el.classList?.contains('notranslate')) return true;
    if (el.getAttribute?.('translate') === 'no') return true;
    if (SKIP_CLASS_RE.test(el.className || '')) return true;
    if (el.closest?.('.notranslate, [translate="no"], .translate-control, .sr-only, .article-source, .article-author, .filter-btn__name, .article-inst')) {
      return true;
    }
    return false;
  }

  function collectTextNodes(root = document.body) {
    if (!root) return [];
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const val = node.nodeValue;
        if (!val || !val.trim()) return NodeFilter.FILTER_REJECT;
        // Ignorer purement numérique / ponctuation
        if (!/[\p{L}]/u.test(val)) return NodeFilter.FILTER_REJECT;
        // Noms de médias (toujours) / établissements hors pastilles sources
        if (isProtectedProperName(val, node)) return NodeFilter.FILTER_REJECT;
        let p = node.parentElement;
        while (p) {
          if (shouldSkipElement(p)) return NodeFilter.FILTER_REJECT;
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

  async function translateDom(targetLang, { quiet = false } = {}) {
    if (!targetLang || translating) return;
    translating = true;
    document.documentElement.dataset.translateBusy = '1';
    if (!quiet) {
      notify(`Traduction en cours… (${labelForMode(activeMode).short || targetLang})`);
    }

    try {
      const nodes = collectTextNodes(document.body);
      // Grouper par texte original (dédup)
      const byText = new Map(); // original → [nodes]
      for (const node of nodes) {
        const orig = rememberOriginal(node);
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
            // Cégeps / collèges / glossaire : pas d’appel MT (nom officiel fiable)
            if (instNodes.length && instNodes.length === list.length) {
              const preferred = preferredInstitutionLabel(orig, targetLang);
              if (preferred) {
                for (const node of list) {
                  if (node.parentNode) {
                    node.nodeValue = reapplyEdgeWhitespace(orig, preferred);
                  }
                }
                ok += 1;
                return;
              }
            }

            let translated = await translateText(orig, targetLang);
            if (translated && translated !== orig) {
              for (const node of list) {
                if (!node.parentNode) continue;
                const out = isTranslatableInstitutionZone(node)
                  ? polishInstitutionTranslation(orig, translated, targetLang)
                  : fixInstitutionMistranslations(orig, translated);
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
      document.documentElement.removeAttribute('data-translate-busy');
    }
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
    // Double rAF : laisser le layout peindre le menu avant mesure
    requestAnimationFrame(() => {
      positionMenu();
      requestAnimationFrame(positionMenu);
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
    await translateDom(target, { quiet: !fromUserClick && !hasUserPreference() });
  }

  function scheduleRetranslate() {
    if (activeMode === DEFAULT_MODE || translating) return;
    clearTimeout(mutateTimer);
    mutateTimer = window.setTimeout(() => {
      const target = googCodeForMode(activeMode);
      if (target) translateDom(target, { quiet: true });
    }, 450);
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
    let lastGroup = '';

    for (const id of MENU_ORDER) {
      const m = MODES[id];
      if (!m) continue;
      const group = m.group || 'other';

      if (group !== lastGroup) {
        const groupLabel = GROUP_LABELS[group];
        if (groupLabel) {
          const sep = document.createElement('div');
          sep.className = 'translate-menu__sep';
          sep.setAttribute('role', 'presentation');
          sep.innerHTML = `<span class="translate-menu__sep-label">${escapeHtml(groupLabel)}</span>`;
          frag.appendChild(sep);
        }
        lastGroup = group;
      }

      const opt = document.createElement('button');
      opt.type = 'button';
      opt.setAttribute('role', 'option');
      opt.className = 'translate-menu__opt'
        + (id === DEFAULT_MODE ? ' is-active' : '')
        + (m.unavailable ? ' is-unavailable' : '');
      opt.dataset.mode = id;
      opt.setAttribute('aria-selected', id === DEFAULT_MODE ? 'true' : 'false');
      if (m.unavailable) {
        opt.setAttribute('aria-disabled', 'true');
        opt.title = m.title;
      }
      opt.innerHTML = `<span class="translate-menu__name">${escapeHtml(m.label)}</span>`
        + `<span class="translate-menu__hint">${escapeHtml(m.hint || '')}</span>`;
      frag.appendChild(opt);
    }

    menu.replaceChildren(frag);
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
      if (!opt || !menu.contains(opt)) return;
      e.stopPropagation();
      const mode = opt.dataset.mode;
      closeMenu();
      if (mode) applyMode(mode, { persist: true, fromUserClick: true });
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

  window.RadarTranslate = {
    getMode,
    applyMode,
    detectBrowserAutoMode,
    hasUserPreference,
    translateText,
    DEFAULT_MODE,
    MODES,
  };
})();
