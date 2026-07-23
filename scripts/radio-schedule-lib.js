/**
 * Horaires radio — collation multi-sources + résolution de l'émission en cours.
 *
 * Partagé par scripts/fetch-radio-schedules.js (le bot). La logique de
 * résolution (resolveCurrentSlot) est volontairement gardée simple et pure
 * pour pouvoir être dupliquée côté navigateur dans app.js.
 *
 * Conventions :
 *   - Jours : 0 = dimanche, 1 = lundi … 6 = samedi (comme Date.getDay()).
 *   - Heures : chaînes "HH:MM" sur 24 h, en heure locale America/Toronto.
 *   - Une plage dont la fin est <= au début traverse minuit (ex. 23:00→01:00).
 */

const { decodeHtmlEntities } = require('./html-entities-lib');

const WEEK_MIN = 7 * 24 * 60;
const DEFAULT_TZ = 'America/Toronto';

const AIRTIME_DAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// UA de navigateur : plusieurs sites de radios bloquent les agents génériques.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36 LE-RADAR-ScheduleBot/1.0';

// Jours en toutes lettres (FR + EN + schema.org) → index 0-6 (dimanche = 0).
const DAY_INDEX = {
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  'http://schema.org/sunday': 0, 'http://schema.org/monday': 1, 'http://schema.org/tuesday': 2,
  'http://schema.org/wednesday': 3, 'http://schema.org/thursday': 4, 'http://schema.org/friday': 5,
  'http://schema.org/saturday': 6,
};

function dayNameToIndex(name) {
  if (name == null) return null;
  const key = String(name).trim().toLowerCase().replace(/^https?:\/\/schema\.org\//, 'http://schema.org/');
  return Object.prototype.hasOwnProperty.call(DAY_INDEX, key) ? DAY_INDEX[key] : null;
}

function stripTags(html = '') {
  return String(html).replace(/<[^>]+>/g, ' ');
}

// ─── Temps ───────────────────────────────────────────────────────────────────
function timeToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

function minutesToTime(total) {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Extrait "HH:MM" d'un timestamp Airtime ("2024-01-01 09:00:00") ou "09:00:00". */
function hhmm(ts) {
  if (!ts) return null;
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?/.exec(String(ts));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// ─── Normalisation des plages ──────────────────────────────────────────────────
function normalizeSlot(slot) {
  if (!slot || typeof slot !== 'object') return null;
  const day = Number(slot.day);
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;

  const start = timeToMinutes(slot.start);
  const end = timeToMinutes(slot.end);
  if (start == null || end == null) return null;

  const title = decodeHtmlEntities(String(slot.title || '')).replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const out = { day, start: minutesToTime(start), end: minutesToTime(end), title };
  const host = decodeHtmlEntities(String(slot.host || '')).replace(/\s+/g, ' ').trim();
  if (host) out.host = host;
  const url = String(slot.url || '').trim();
  if (url) out.url = url;
  return out;
}

function slotKey(s) {
  return `${s.day}|${s.start}|${s.end}|${s.title.toLowerCase()}`;
}

/** Fusionne plusieurs grilles, dédoublonne et trie (jour, début, fin). */
function mergeGrids(...grids) {
  const seen = new Map();
  for (const grid of grids) {
    if (!Array.isArray(grid)) continue;
    for (const raw of grid) {
      const slot = normalizeSlot(raw);
      if (!slot) continue;
      const key = slotKey(slot);
      if (!seen.has(key)) seen.set(key, slot);
    }
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.day - b.day ||
      timeToMinutes(a.start) - timeToMinutes(b.start) ||
      timeToMinutes(a.end) - timeToMinutes(b.end),
  );
}

// ─── Résolution de l'émission en cours ─────────────────────────────────────────
/** Jour (0-6) + minutes depuis minuit dans un fuseau donné. */
function zonedNow(date = new Date(), timeZone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(map.hour, 10);
  if (hour === 24 || Number.isNaN(hour)) hour = 0;
  const minute = parseInt(map.minute, 10) || 0;
  return { day: wd[map.weekday] ?? 0, minutes: hour * 60 + minute };
}

/**
 * Trouve la plage qui couvre l'instant `date` dans une grille hebdomadaire.
 * Gère les émissions de nuit (fin <= début) et le passage samedi → dimanche.
 * Retourne la plage normalisée, ou null.
 */
function resolveCurrentSlot(grid, date = new Date(), timeZone = DEFAULT_TZ) {
  if (!Array.isArray(grid) || !grid.length) return null;
  const { day, minutes } = zonedNow(date, timeZone);
  const nowAbs = day * 1440 + minutes;

  const slots = grid
    .map(normalizeSlot)
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.day - b.day || timeToMinutes(a.start) - timeToMinutes(b.start),
    );

  for (const slot of slots) {
    const start = timeToMinutes(slot.start);
    const end = timeToMinutes(slot.end);
    const startAbs = slot.day * 1440 + start;
    const endAbs = slot.day * 1440 + (end <= start ? end + 1440 : end);
    // On teste l'instant et son équivalent « semaine suivante » pour couvrir
    // une plage qui démarre samedi soir et finit dimanche matin.
    if (
      (nowAbs >= startAbs && nowAbs < endAbs) ||
      (nowAbs + WEEK_MIN >= startAbs && nowAbs + WEEK_MIN < endAbs)
    ) {
      return slot;
    }
  }
  return null;
}

/**
 * Prochaine plage dont le début est strictement après `date`
 * (utile pour « À venir » entre deux créneaux ou en fin d'émission).
 */
function resolveNextSlot(grid, date = new Date(), timeZone = DEFAULT_TZ) {
  if (!Array.isArray(grid) || !grid.length) return null;
  const { day, minutes } = zonedNow(date, timeZone);
  const nowAbs = day * 1440 + minutes;
  let best = null;
  let bestDelta = WEEK_MIN;

  for (const raw of grid) {
    const slot = normalizeSlot(raw);
    if (!slot) continue;
    const start = timeToMinutes(slot.start);
    if (start == null) continue;
    const startAbs = slot.day * 1440 + start;
    let delta = startAbs - nowAbs;
    if (delta <= 0) delta += WEEK_MIN;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = slot;
    }
  }
  return best;
}

// ─── Adaptateurs de sources ─────────────────────────────────────────────────────
async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponible');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'LE-RADAR-ScheduleBot/1.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponible');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Convertit la réponse Airtime/LibreTime `/api/week-info` en grille. */
function airtimeWeekToGrid(week) {
  const grid = [];
  if (!week || typeof week !== 'object') return grid;
  for (const [name, day] of Object.entries(AIRTIME_DAYS)) {
    const list = week[name];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const start = hhmm(item.start_timestamp || item.starts || item.start);
      const end = hhmm(item.end_timestamp || item.ends || item.end);
      const title = String(item.name || item.title || '').trim();
      if (!start || !end || !title) continue;
      grid.push({ day, start, end, title, url: item.url || item.show_url || undefined });
    }
  }
  return grid;
}

async function fetchAirtimeGrid(base, deps = {}) {
  const url = `${String(base).replace(/\/+$/, '')}/api/week-info`;
  const json = await fetchJson(url, deps);
  return airtimeWeekToGrid(json);
}

// ─── Adaptateur générique JSON-LD (schema.org) ──────────────────────────────────
/** Aplati les structures JSON-LD (@graph, tableaux imbriqués) en une liste de nœuds. */
function flattenJsonLd(node, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) flattenJsonLd(n, out);
  } else if (node && typeof node === 'object') {
    out.push(node);
    if (node['@graph']) flattenJsonLd(node['@graph'], out);
  }
  return out;
}

function jsonldNodeToSlots(node) {
  const types = []
    .concat(node['@type'] || [])
    .map((t) => String(t).toLowerCase());
  const isEvent = types.some((t) => t.includes('broadcastevent') || t === 'event' || t.includes('publicationevent'));
  if (!isEvent) return [];

  const title = String(
    node.name
      || node.publishedOn?.name
      || node.workPerformed?.name
      || node.superEvent?.name
      || '',
  ).trim();
  if (!title) return [];

  const url = typeof node.url === 'string' ? node.url : undefined;

  // Cas 1 : startDate/endDate ISO complets (un jour précis).
  const startDate = node.startDate || node.startTime;
  const endDate = node.endDate || node.endTime;
  if (startDate && /\d{4}-\d{2}-\d{2}t/i.test(String(startDate))) {
    const s = new Date(startDate);
    const e = endDate ? new Date(endDate) : null;
    if (!Number.isNaN(s.getTime())) {
      return [{
        day: s.getUTCDay(),
        start: `${String(s.getUTCHours()).padStart(2, '0')}:${String(s.getUTCMinutes()).padStart(2, '0')}`,
        end: e && !Number.isNaN(e.getTime())
          ? `${String(e.getUTCHours()).padStart(2, '0')}:${String(e.getUTCMinutes()).padStart(2, '0')}`
          : `${String(s.getUTCHours()).padStart(2, '0')}:${String(s.getUTCMinutes()).padStart(2, '0')}`,
        title,
        url,
      }];
    }
  }

  // Cas 2 : eventSchedule récurrent (byDay + startTime + endTime).
  const schedules = [].concat(node.eventSchedule || []);
  const slots = [];
  for (const sch of schedules) {
    if (!sch || typeof sch !== 'object') continue;
    const start = hhmm(sch.startTime);
    const end = hhmm(sch.endTime);
    if (!start || !end) continue;
    for (const d of [].concat(sch.byDay || [])) {
      const day = dayNameToIndex(typeof d === 'object' ? d.name || d['@id'] : d);
      if (day == null) continue;
      slots.push({ day, start, end, title, url });
    }
  }
  return slots;
}

function jsonldToGrid(htmlText) {
  const grid = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(htmlText))) {
    let data;
    try {
      data = JSON.parse(m[1].trim().replace(/<!--[\s\S]*?-->/g, ''));
    } catch {
      continue;
    }
    for (const node of flattenJsonLd(data)) {
      grid.push(...jsonldNodeToSlots(node));
    }
  }
  return grid;
}

// ─── Adaptateur Spinitron (API /api/shows) ───────────────────────────────────────
/**
 * Convertit la réponse Spinitron `/api/shows` en grille. Spinitron renvoie des
 * émissions récurrentes avec `start`/`end` ISO ; on en extrait jour + heures.
 */
function spinitronShowsToGrid(payload) {
  const grid = [];
  const items = Array.isArray(payload) ? payload : (payload?.items || []);
  for (const it of items) {
    if (!it || it.one_off) continue;
    const s = it.start ? new Date(it.start) : null;
    const e = it.end ? new Date(it.end) : null;
    const title = String(it.title || it.name || '').trim();
    if (!title || !s || Number.isNaN(s.getTime())) continue;
    const pad = (n) => String(n).padStart(2, '0');
    grid.push({
      day: s.getUTCDay(),
      start: `${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`,
      end: e && !Number.isNaN(e.getTime()) ? `${pad(e.getUTCHours())}:${pad(e.getUTCMinutes())}` : `${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`,
      title,
      url: it.url || undefined,
    });
  }
  return grid;
}

async function fetchSpinitronGrid(src, deps = {}) {
  const base = String(src.base || 'https://spinitron.com').replace(/\/+$/, '');
  const token = src.token || src.accessToken;
  const url = `${base}/api/shows${token ? `?access-token=${encodeURIComponent(token)}&count=200` : '?count=200'}`;
  const json = await fetchJson(url, deps);
  return spinitronShowsToGrid(json);
}

// ─── Adaptateurs HTML spécifiques (sites bespoke) ───────────────────────────────
const TIME_RANGE_RE = /(\d{1,2})\s*[:h]\s*(\d{2})\s*(?:-|–|à|to)\s*(\d{1,2})\s*[:h]\s*(\d{2})/i;
const TIME_RE = /(\d{1,2})\s*[:h]\s*(\d{2})/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** CHYZ (chyz.ca/horaire) : blocs <a.article-horaire data-jour-slug> avec heures + <h3>. */
function parseChyzGrid(htmlText) {
  const grid = [];
  const re = /<a[^>]*class="[^"]*article-horaire[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(htmlText))) {
    const openTag = htmlText.slice(m.index, htmlText.indexOf('>', m.index) + 1);
    const daySlug = /data-jour-slug="([^"]+)"/i.exec(openTag)?.[1];
    const day = dayNameToIndex(daySlug);
    if (day == null) continue;
    const body = m[1];
    const tm = TIME_RANGE_RE.exec(body);
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(body);
    if (!tm || !h3) continue;
    const title = decodeHtmlEntities(stripTags(h3[1])).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const slot = {
      day,
      start: `${pad2(tm[1])}:${tm[2]}`,
      end: `${pad2(tm[3])}:${tm[4]}`,
      title,
    };
    const href = /href="([^"]+)"/i.exec(openTag)?.[1]?.trim();
    if (href) slot.url = href;
    grid.push(slot);
  }
  return grid;
}

/**
 * CFAK (cfak.ca/programmation) : sections <h2>Jour</h2> puis cartes
 * (<p.texteTitre>Titre</p> + heure de début). La fin = début de la carte
 * suivante du jour (la dernière émission boucle jusqu'au premier créneau).
 */
function parseCfakGrid(htmlText) {
  const grid = [];
  const headRe = /<h2[^>]*class="[^"]*uppercase[^"]*"[^>]*>\s*(dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)\s*<\/h2>/gi;
  const heads = [];
  let hm;
  while ((hm = headRe.exec(htmlText))) {
    heads.push({ day: dayNameToIndex(hm[1]), from: headRe.lastIndex });
  }
  for (let i = 0; i < heads.length; i += 1) {
    if (heads[i].day == null) continue;
    const chunk = htmlText.slice(heads[i].from, i + 1 < heads.length ? heads[i + 1].from : htmlText.length);
    const cardRe = /<p[^>]*class="[^"]*texteTitre[^"]*"[^>]*>([\s\S]*?)<\/p>[\s\S]*?<div[^>]*class="[^"]*texteTitre[^"]*"[^>]*>\s*(\d{1,2})\s*[:h]\s*(\d{2})\s*<\/div>/gi;
    const cards = [];
    let cm;
    while ((cm = cardRe.exec(chunk))) {
      const title = decodeHtmlEntities(stripTags(cm[1])).replace(/\s+/g, ' ').trim();
      if (!title) continue;
      cards.push({ title, start: `${pad2(cm[2])}:${cm[3]}` });
    }
    if (!cards.length) continue;
    cards.sort((a, b) => a.start.localeCompare(b.start));
    for (let j = 0; j < cards.length; j += 1) {
      let end = j + 1 < cards.length ? cards[j + 1].start : cards[0].start;
      // Un seul créneau à minuit (ex. samedi « Les nuits CFAK ») : éviter 00:00→00:00
      // qui couvrirait toute la journée ; la nuit CFAK se termine vers 07:00 comme les autres jours.
      if (end === cards[j].start && /^00:0[01]$/.test(cards[j].start)) {
        end = '07:00';
      }
      grid.push({ day: heads[i].day, start: cards[j].start, end, title: cards[j].title });
    }
  }
  return grid;
}

const CISM_DAY_INDEX = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

/** Extrait le plus gros bloc JSON (payload Nuxt SSR) d'une page HTML. */
function pickLargestJsonScript(htmlText = '') {
  const re = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const scripts = [];
  let m;
  while ((m = re.exec(htmlText))) scripts.push(m[1].trim());
  return scripts.sort((a, b) => b.length - a.length)[0] || '';
}

/** Réhydrate un nœud du payload déshydraté Nuxt 3 (références par index). */
function reviveNuxt(value, payload, seen = new Set()) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < payload.length) {
    if (seen.has(value)) return payload[value];
    seen.add(value);
    return reviveNuxt(payload[value], payload, seen);
  }
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
      return reviveNuxt(payload[value[1]], payload, new Set(seen));
    }
    return value.map((v) => reviveNuxt(v, payload, new Set(seen)));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = reviveNuxt(v, payload, new Set(seen));
    return out;
  }
  return value;
}

/**
 * Résout une référence Nuxt (index) en valeur scalaire sans redescendre
 * dans les arbres d'images (sinon OOM sur le payload grille CISM ~200 ko).
 */
function reviveNuxtScalar(value, payload, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < payload.length) {
    return reviveNuxtScalar(payload[value], payload, depth + 1);
  }
  if (Array.isArray(value)
    && value.length === 2
    && typeof value[0] === 'string'
    && typeof value[1] === 'number') {
    return reviveNuxtScalar(payload[value[1]], payload, depth + 1);
  }
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

/** Liste d'émissions CISM : ne tire que slug/title/start/end. */
function reviveCismShowList(ref, payload) {
  let list = ref;
  if (typeof list === 'number') list = payload[list];
  if (!Array.isArray(list)) return [];
  const shows = [];
  for (const item of list) {
    let show = item;
    if (typeof show === 'number') show = payload[show];
    if (!show || typeof show !== 'object' || Array.isArray(show)) continue;
    shows.push({
      slug: reviveNuxtScalar(show.slug, payload),
      title: reviveNuxtScalar(show.title, payload),
      start: reviveNuxtScalar(show.start, payload),
      end: reviveNuxtScalar(show.end, payload),
    });
  }
  return shows;
}

/**
 * Extrait timeTable.content sans réhydrater tout le payload Nuxt
 * (images, podcasts, catégories → explosion mémoire).
 */
function extractCismTimeTableContent(payload) {
  if (!Array.isArray(payload)) return null;

  // 1) Objet jour → listes (Monday…Sunday) directement dans le tableau.
  for (let i = 0; i < payload.length; i++) {
    const item = payload[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (!Object.prototype.hasOwnProperty.call(item, 'Monday')) continue;
    if (!Object.prototype.hasOwnProperty.call(item, 'Thursday')) continue;
    const content = {};
    let hits = 0;
    for (const dayName of Object.keys(CISM_DAY_INDEX)) {
      if (!Object.prototype.hasOwnProperty.call(item, dayName)) continue;
      content[dayName] = reviveCismShowList(item[dayName], payload);
      if (content[dayName].length) hits += 1;
    }
    if (hits >= 3) return content;
  }

  // 2) Ancien chemin (payload[1].data['grille-horaire']…) — shallow.
  try {
    const root = payload[1];
    const rootObj = typeof root === 'number' ? payload[root] : root;
    if (rootObj && typeof rootObj === 'object') {
      const candidates = [
        rootObj?.['grille-horaire'],
        rootObj?.data?.['grille-horaire'],
      ];
      for (const ghRef of candidates) {
        if (ghRef == null) continue;
        let gh = ghRef;
        if (typeof gh === 'number') gh = payload[gh];
        let data = gh?.data ?? gh;
        if (typeof data === 'number') data = payload[data];
        let timeTable = data?.timeTable;
        if (typeof timeTable === 'number') timeTable = payload[timeTable];
        let content = timeTable?.content;
        if (typeof content === 'number') content = payload[content];
        if (content && typeof content === 'object' && content.Monday != null) {
          const out = {};
          for (const dayName of Object.keys(CISM_DAY_INDEX)) {
            if (!Object.prototype.hasOwnProperty.call(content, dayName)) continue;
            out[dayName] = reviveCismShowList(content[dayName], payload);
          }
          if (Object.values(out).some((arr) => arr.length)) return out;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function unixTsToHHMM(ts, timeZone = DEFAULT_TZ) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(n * 1000));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = parseInt(map.hour, 10);
  if (hour === 24 || Number.isNaN(hour)) hour = 0;
  const minute = parseInt(map.minute, 10) || 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Convertit timeTable.content (CISM) en grille { day, start, end, title }. */
function cismTimeTableToGrid(content = {}) {
  const grid = [];
  for (const [dayName, shows] of Object.entries(content)) {
    const day = CISM_DAY_INDEX[dayName];
    if (day == null || !Array.isArray(shows)) continue;
    for (const show of shows) {
      const title = decodeHtmlEntities(stripTags(String(show?.title || ''))).replace(/\s+/g, ' ').trim();
      const start = unixTsToHHMM(show?.start);
      const end = unixTsToHHMM(show?.end);
      const slug = String(show?.slug || '').trim();
      if (!title || !start || !end) continue;
      const slot = { day, start, end, title };
      if (slug) slot.url = `https://cism893.ca/emissions/${slug}`;
      grid.push(slot);
    }
  }
  return grid;
}

/**
 * CISM (cism893.ca/grille-horaire) : site Nuxt dont la grille est embarquée
 * dans le payload SSR (timeTable.content → Monday…Sunday + timestamps Unix).
 * Extraction ciblée : pas de reviveNuxt complet (OOM sur images/podcasts).
 */
function parseCismNuxtPayload(raw = '') {
  if (!raw) return [];
  const payload = JSON.parse(raw);
  if (!Array.isArray(payload) || payload.length < 2) return [];
  const content = extractCismTimeTableContent(payload);
  return cismTimeTableToGrid(content || {});
}

async function parseCismGrid(htmlText) {
  return parseCismNuxtPayload(pickLargestJsonScript(htmlText));
}

/** Préfère /_payload.json (plus stable) puis HTML SSR. */
async function fetchCismGrid(src = {}, deps = {}) {
  const pageUrl = src.url || 'https://cism893.ca/grille-horaire/';
  try {
    const payloadUrl = new URL('_payload.json', pageUrl.endsWith('/') ? pageUrl : `${pageUrl}/`).toString();
    const raw = await fetchText(payloadUrl, deps);
    const grid = parseCismNuxtPayload(raw);
    if (grid.length) return grid;
  } catch (err) {
    if (typeof deps.onError === 'function') deps.onError({ type: 'cism-payload', url: pageUrl }, err);
  }
  return parseCismGrid(await fetchText(pageUrl, deps));
}

/** Colonnes jour → index (Sun=0) sur la grille visuelle CJLO (left en px). */
const CJLO_LEFT_TO_DAY = [
  [31, 0],
  [107.6, 1],
  [184.2, 2],
  [260.8, 3],
  [337.4, 4],
  [414, 5],
  [490.6, 6],
];

function cjloLeftToDay(leftPx) {
  const left = parseFloat(leftPx);
  if (!Number.isFinite(left)) return null;
  let bestDay = null;
  let bestDist = Infinity;
  for (const [lx, day] of CJLO_LEFT_TO_DAY) {
    const dist = Math.abs(left - lx);
    if (dist < bestDist) {
      bestDist = dist;
      bestDay = day;
    }
  }
  return bestDist <= 6 ? bestDay : null;
}

function parseCjloClockToken(token = '') {
  const raw = String(token).trim();
  const low = raw.toLowerCase();
  if (low === 'midnight') return '00:00';
  if (low === 'noon') return '12:00';
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(raw);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3].toLowerCase();
  if (ap === 'pm' && hour !== 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseCjloTimeRange(text = '') {
  const raw = decodeHtmlEntities(String(text)).replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s*-\s*(.+)$/i.exec(raw);
  if (!m) return null;
  const start = parseCjloClockToken(m[1]);
  const end = parseCjloClockToken(m[2]);
  if (!start || !end) return null;
  return { start, end };
}

function normalizeCjloShowUrl(href = '') {
  let url = String(href).trim();
  if (!url) return '';
  if (url.startsWith('/?q=')) url = url.replace('/?q=', '/');
  if (url.startsWith('/')) url = `http://www.cjlo.com${url}`;
  return url;
}

/**
 * CJLO (cjlo.com/schedule) : grille Drupal 7 en HTML (Daytime + Late Night).
 * Chaque bloc .show-sched a une colonne (left) et une plage AM/PM dans <b>.
 */
function parseCjloGrid(htmlText) {
  const grid = [];
  const showRe = /<div class='show-sched[^']*'[^>]*style='[^']*left:([\d.]+)px[\s\S]*?<div class='show-title'><a[^>]*href='([^']*)'[^>]*>([\s\S]*?)<\/a><\/div>[\s\S]*?<b>([\s\S]*?)<\/b>/gi;
  let m;
  while ((m = showRe.exec(htmlText))) {
    const day = cjloLeftToDay(m[1]);
    const title = decodeHtmlEntities(stripTags(m[3])).replace(/\s+/g, ' ').trim();
    const range = parseCjloTimeRange(stripTags(m[4]));
    if (day == null || !title || !range) continue;
    const slot = { day, start: range.start, end: range.end, title };
    const url = normalizeCjloShowUrl(m[2]);
    if (url) slot.url = url;
    grid.push(slot);
  }
  return grid;
}

/**
 * CHOQ — grille via GraphQL (épisodes planifiés, 14 jours).
 * Les plages sont des occurrences datées (pas une grille type « chaque jeudi ») :
 * on les projette sur day 0–6 + HH:MM America/Toronto pour resolveCurrentSlot.
 */
async function fetchChoqGrid(src = {}, deps = {}) {
  const endpoint = src.url || 'https://www.choq.ca/api/graphql';
  const tz = src.timeZone || DEFAULT_TZ;
  const daysAhead = Math.min(21, Math.max(7, Number(src.days) || 14));
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponible');

  const query = `query queryEpisodesOfDay($date: [QueryArgument]) {
    entries(
      section: "episodes"
      dateTime1: $date
      orderBy: "dateTime1 ASC"
      limit: 50
      status: null
    ) {
      ... on episodes_default_Entry {
        title
        timestamp_start: dateTime1
        timestamp_end: dateTime2
        parent: emissionListeUnique {
          ... on emissions_default_Entry { title slug }
        }
      }
    }
  }`;

  const ymdInTz = (date) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day}`;
  };

  const addDaysYmd = (ymd, n) => {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
  };

  const hhmmInTz = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    let hour = parseInt(map.hour, 10);
    if (hour === 24 || Number.isNaN(hour)) hour = 0;
    const minute = parseInt(map.minute, 10) || 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };

  const dayIndexInTz = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
      .format(d);
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? null;
  };

  const today = ymdInTz(new Date());
  const grid = [];
  const seen = new Set();

  for (let i = 0; i < daysAhead; i++) {
    const day = addDaysYmd(today, i);
    const next = addDaysYmd(today, i + 1);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let entries = [];
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': BROWSER_UA,
        },
        body: JSON.stringify({
          query,
          variables: { date: ['and', `>= ${day}`, `< ${next}`] },
        }),
      });
      if (res.ok) {
        const json = await res.json();
        entries = Array.isArray(json?.data?.entries) ? json.data.entries : [];
      }
    } catch {
      entries = [];
    } finally {
      clearTimeout(timer);
    }

    for (const e of entries) {
      if (!e?.timestamp_start || !e?.timestamp_end) continue;
      const parent = Array.isArray(e.parent) ? e.parent[0] : e.parent;
      const title = decodeHtmlEntities(String(parent?.title || e.title || ''))
        .replace(/\s+/g, ' ')
        .trim();
      if (!title) continue;
      const start = hhmmInTz(e.timestamp_start);
      const end = hhmmInTz(e.timestamp_end);
      const dow = dayIndexInTz(e.timestamp_start);
      if (start == null || end == null || dow == null) continue;
      const key = `${dow}|${start}|${end}|${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const slot = { day: dow, start, end, title };
      if (parent?.slug) slot.url = `https://www.choq.ca/emissions/${parent.slug}`;
      grid.push(slot);
    }
  }

  return grid;
}

// ─── Registre d'adaptateurs ──────────────────────────────────────────────────────
const ADAPTERS = {
  airtime: (src, deps) => fetchAirtimeGrid(src.base || src.url, deps),
  spinitron: (src, deps) => fetchSpinitronGrid(src, deps),
  jsonld: async (src, deps) => jsonldToGrid(await fetchText(src.url, deps)),
  chyz: async (src, deps) => parseChyzGrid(await fetchText(src.url, deps)),
  cfak: async (src, deps) => parseCfakGrid(await fetchText(src.url, deps)),
  cism: (src, deps) => fetchCismGrid(src, deps),
  cjlo: async (src, deps) => parseCjloGrid(await fetchText(src.url || 'http://www.cjlo.com/schedule', deps)),
  choq: (src, deps) => fetchChoqGrid(src, deps),
  'choq-episodes': (src, deps) => fetchChoqGrid(src, deps),
};

/** Étiquette lisible d'une source pour le journal/diagnostic. */
function sourceLabel(src) {
  return src.type + (src.base || src.url ? `:${src.base || src.url}` : '');
}

async function runAdapter(src, deps = {}) {
  const fn = ADAPTERS[src.type];
  if (typeof fn !== 'function') return null;
  const grid = await fn(src, deps);
  return Array.isArray(grid) ? grid : null;
}

/**
 * Collige la grille d'un poste à partir de ses sources dynamiques + de sa
 * grille manuelle (seed). Les sources injoignables sont ignorées sans erreur.
 * Retourne { grid, sources: [étiquettes utilisées] }.
 */
async function collateStationGrid(cfg = {}, deps = {}) {
  const sources = Array.isArray(cfg.sources) ? cfg.sources : [];
  const collected = [];
  const used = [];

  for (const src of sources) {
    if (!src || !src.type) continue;
    try {
      const grid = await runAdapter(src, deps);
      if (grid && grid.length) {
        collected.push(grid);
        used.push(sourceLabel(src));
      }
    } catch (err) {
      if (typeof deps.onError === 'function') deps.onError(src, err);
    }
  }

  if (Array.isArray(cfg.grid) && cfg.grid.length) {
    collected.push(cfg.grid);
    used.push('manual');
  }

  return { grid: mergeGrids(...collected), sources: used };
}

module.exports = {
  WEEK_MIN,
  DEFAULT_TZ,
  BROWSER_UA,
  timeToMinutes,
  minutesToTime,
  hhmm,
  dayNameToIndex,
  normalizeSlot,
  mergeGrids,
  zonedNow,
  resolveCurrentSlot,
  resolveNextSlot,
  fetchJson,
  fetchText,
  airtimeWeekToGrid,
  fetchAirtimeGrid,
  flattenJsonLd,
  jsonldToGrid,
  spinitronShowsToGrid,
  fetchSpinitronGrid,
  parseChyzGrid,
  parseCfakGrid,
  pickLargestJsonScript,
  reviveNuxt,
  unixTsToHHMM,
  cismTimeTableToGrid,
  extractCismTimeTableContent,
  parseCismNuxtPayload,
  parseCismGrid,
  fetchCismGrid,
  parseCjloGrid,
  parseCjloTimeRange,
  ADAPTERS,
  sourceLabel,
  runAdapter,
  collateStationGrid,
};
