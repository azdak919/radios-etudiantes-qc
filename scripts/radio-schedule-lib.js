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
  const re = /<a[^>]*class="[^"]*article-horaire[^"]*"[^>]*data-jour-slug="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(htmlText))) {
    const day = dayNameToIndex(m[1]);
    if (day == null) continue;
    const body = m[2];
    const tm = TIME_RANGE_RE.exec(body);
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(body);
    if (!tm || !h3) continue;
    const title = decodeHtmlEntities(stripTags(h3[1])).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    grid.push({ day, start: `${pad2(tm[1])}:${tm[2]}`, end: `${pad2(tm[3])}:${tm[4]}`, title });
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
      const end = j + 1 < cards.length ? cards[j + 1].start : cards[0].start;
      grid.push({ day: heads[i].day, start: cards[j].start, end, title: cards[j].title });
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
  ADAPTERS,
  sourceLabel,
  runAdapter,
  collateStationGrid,
};
