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
 *  2. Sinon navigateur fr ou en → Original bilingue ; autre langue → auto.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'radar-translate-mode';
  const CACHE_KEY = 'radar-translate-cache-v1';
  const CACHE_MAX = 800;
  const DEFAULT_MODE = 'original';
  const CONCURRENCY = 5;
  const MAX_CHUNK = 450;

  const MODES = {
    original: {
      id: 'original',
      label: 'Original',
      short: 'Original',
      title: 'Ne pas traduire — fil bilingue FR + EN (défaut pour navigateurs français ou anglais)',
      hint: 'Bilingue FR + EN',
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
      goog: 'iu',
      group: 'indigenous',
    },
    /* Cree, Innu, Atikamekw, Anishinaabemowin, Mohawk, Mi'kmaq : absents des
       API de traduction utilisées (gtx / MyMemory) — non listés tant qu'aucun
       moteur fiable n'est disponible. Seul l'inuktitut est offert. */
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

  /** Ordre d’affichage : Original/FR/EN → autochtones QC → régions d’origine étudiantes. */
  const MENU_ORDER = [
    'original', 'fr', 'en',
    'iu', 'iu-latn',
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

  const GROUP_LABELS = {
    indigenous: 'Inuktut · Nunavik',
    americas: 'Amériques',
    asia: 'Asie',
    mena: 'Maghreb & Moyen-Orient',
    africa: 'Afrique',
    europe: 'Europe',
  };

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
  let mediaNamesReady = false;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'PATH', 'MATH', 'IFRAME',
  ]);

  /** Classes / zones où les noms de médias (et établissements) restent intacts. */
  const SKIP_CLASS_RE = /\b(?:notranslate|article-source|article-inst|filter-btn__name|article-media-credit__creator)\b/;

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
    if (mode === 'iu-latn') return 'iu';
    if (mode === 'fil') return 'tl';
    if (isValidLangCode(mode)) return mode;
    return null;
  }

  function gtxLang(code) {
    const map = {
      zh: 'zh-CN',
      'zh-tw': 'zh-TW',
      he: 'iw',
      'iu-latn': 'iu',
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
    return out;
  }

  async function translateText(text, targetLang) {
    const trimmed = String(text || '');
    if (!trimmed.trim()) return trimmed;
    const tl = gtxLang(targetLang);
    const key = cacheKey(trimmed, tl);
    if (translationCache[key]) return translationCache[key];

    // Très longs : découper par phrases approximatives
    if (trimmed.length > MAX_CHUNK) {
      const parts = splitLong(trimmed, MAX_CHUNK);
      const out = [];
      for (const part of parts) {
        out.push(await translateText(part, targetLang));
      }
      const joined = out.join('');
      translationCache[key] = joined;
      return joined;
    }

    const encoded = encodeURIComponent(trimmed);

    // 1) Google gtx (même endpoint qu'Ataraxia)
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encoded}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        const raw = data?.[0]?.map((s) => s?.[0]).filter(Boolean).join('');
        const translated = cleanTranslation(raw);
        if (translated) {
          translationCache[key] = translated;
          return translated;
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
          if (translated && translated !== trimmed.toUpperCase()) {
            translationCache[key] = translated;
            return translated;
          }
        }
      }
    } catch { /* keep original */ }

    return trimmed;
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

  function loadProtectedMediaNames() {
    if (mediaNamesReady) return Promise.resolve();
    return fetch('./news-sources.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        for (const s of data?.active || []) {
          if (s?.name) {
            protectedMediaNames.add(String(s.name).trim());
            // Variantes fréquentes de casse
            protectedMediaNames.add(String(s.name).trim().toLowerCase());
          }
        }
        mediaNamesReady = true;
      })
      .catch(() => {
        mediaNamesReady = true;
      });
  }

  function isProtectedMediaName(text = '') {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    if (protectedMediaNames.has(t) || protectedMediaNames.has(t.toLowerCase())) return true;
    // « The Plant · Dawson » / pastilles compactes
    for (const name of protectedMediaNames) {
      if (!name || name.length < 3) continue;
      if (t === name || t.toLowerCase() === String(name).toLowerCase()) return true;
    }
    return false;
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.translate === false) return true;
    if (el.classList?.contains('notranslate')) return true;
    if (el.getAttribute?.('translate') === 'no') return true;
    if (SKIP_CLASS_RE.test(el.className || '')) return true;
    if (el.closest?.('.notranslate, [translate="no"], .translate-control, .sr-only, .article-source, .filter-btn__name, .article-inst')) {
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
        // Noms de médias (The Plant, Le Délit…) = noms propres
        if (isProtectedMediaName(val)) return NodeFilter.FILTER_REJECT;
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
            const translated = await translateText(orig, targetLang);
            if (translated && translated !== orig) {
              for (const node of list) {
                // Nœud peut avoir été détaché
                if (node.parentNode) node.nodeValue = translated;
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
          ? 'Langue : original bilingue. Ouvrir pour traduire la page.'
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
    const rtl = new Set(['ar', 'fa', 'he', 'ur']);
    if (mode === DEFAULT_MODE) {
      document.documentElement.lang = 'fr-CA';
      document.documentElement.removeAttribute('dir');
    } else if (mode === 'en') {
      document.documentElement.lang = 'en-CA';
      document.documentElement.removeAttribute('dir');
    } else if (mode === 'fr') {
      document.documentElement.lang = 'fr-CA';
      document.documentElement.removeAttribute('dir');
    } else if (mode === 'zh') {
      document.documentElement.lang = 'zh-Hans';
      document.documentElement.removeAttribute('dir');
    } else if (mode === 'zh-tw') {
      document.documentElement.lang = 'zh-Hant';
      document.documentElement.removeAttribute('dir');
    } else if (mode === 'iu' || mode === 'iu-latn') {
      document.documentElement.lang = 'iu';
      document.documentElement.removeAttribute('dir');
    } else if (mode === 'he') {
      document.documentElement.lang = 'he';
      document.documentElement.dir = 'rtl';
    } else {
      const code = googCodeForMode(mode) || mode;
      document.documentElement.lang = code === 'iw' ? 'he' : code;
      if (rtl.has(mode)) document.documentElement.dir = 'rtl';
      else document.documentElement.removeAttribute('dir');
    }
  }

  function closeMenu() {
    const menu = document.getElementById('translate-menu');
    const btn = document.getElementById('translate-toggle');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function openMenu() {
    const menu = document.getElementById('translate-menu');
    const btn = document.getElementById('translate-toggle');
    if (menu) menu.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
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
        + 'pour cette langue autochtone. La page reste en original bilingue.',
      );
      return;
    }

    if (persist) mode = setMode(mode);
    else if (!mode) mode = DEFAULT_MODE;

    activeMode = mode;
    updateUi(mode);

    if (mode === DEFAULT_MODE) {
      restoreOriginals();
      if (fromUserClick) notify('Affichage original bilingue (FR + EN)');
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
    bindUi();
    startObserver();

    const mode = getMode();
    activeMode = mode;
    updateUi(mode);

    // Charger les noms de médias avant toute traduction auto
    const afterMedia = () => {
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
    };
    loadProtectedMediaNames().then(afterMedia);
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
