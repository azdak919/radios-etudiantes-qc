/**
 * Métadonnées « à l'antenne » / « à venir » — bot fetch-radio-nowplaying.js
 *
 * Architecture multi-sources (ordre de priorité pour l'émission en cours) :
 *   1. API live station (adaptateurs déclaratifs, extensibles)
 *   2. Grille hebdo (radio-schedules.json) — current + next
 *   3. Métadonnées ICY du flux (souvent le morceau, parfois l'émission)
 *
 * Config par poste (radios.json), du plus précis au plus auto :
 *   "_nowPlayingSources": [ { "type": "airtime-live", "base": "…" }, … ]
 *   "_nowPlayingApi": "https://…"   // rétrocompat — type inféré depuis l'URL
 *
 * Types d'adaptateurs (LIVE_ADAPTERS) :
 *   - cism-v1      admin.cism893.ca/api/v1/live  → current + upcoming
 *   - craft-live   /api/live (Craft CMS, CHOQ)   → piste (title+artist), pas l'émission
 *   - choq-episodes GraphQL épisodes du jour     → current + next (horaires QC)
 *   - triton-np    Triton Now Playing (CORS *)   → piste, re-poll navigateur
 *   - airtime-live LibreTime/Airtime live-info   → currentShow + nextShow
 *   - icy          StreamTitle ICY               → piste / repli titre (CHOQ = piste only)
 *   - schedule     résolu hors adaptateur (grille colligée)
 *
 * Nouveau poste : soit déclarer _nowPlayingSources, soit laisser
 * inferNowPlayingSources() déduire Airtime / Craft / ICY depuis stream + site.
 */

const https = require('https');
const http = require('http');
const {
  DEFAULT_TZ,
  resolveCurrentSlot,
  resolveNextSlot,
  hhmm,
} = require('./radio-schedule-lib');

const DEFAULT_TIMEOUT = 12000;
const GENERIC_SHOW_RE = /^(?:airtime!?|liquidsoap(?:\s+radio!?)?|no name|unknown|unspecified|\.+|-+|n\/a)$/i;
const GENERIC_FEED_RE = /(?:high quality|low band|backup only|stream\s*#|feed for)/i;
const GENERIC_GEO_RE = /^(?:montréal|montreal|québec|quebec|sherbrooke|laval|canada)$/i;

// ─── Normalisation ─────────────────────────────────────────────────────────────

function normKey(text = '') {
  return normalizeShowTitle(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function normalizeShowTitle(raw = '') {
  return String(raw || '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stationTokens(radio = {}) {
  const bits = [
    radio.id,
    radio.name,
    radio.fullName,
    radio.slogan,
    radio._streamIcyName,
  ].filter(Boolean);
  return bits.map((b) => normalizeShowTitle(b).toLowerCase());
}

function extractShowFromIcyTitle(title = '', radio = {}) {
  let t = normalizeShowTitle(title);
  t = t.replace(/\s*\([^)]*backup[^)]*\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  const parts = t.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const left = parts[0].toLowerCase();
    const slug = String(radio.id || '').toLowerCase();
    const call = String(radio.name || '').split(/\s+/)[0].toLowerCase();
    if ((slug && left.includes(slug)) || (call && left.includes(call))) {
      return parts.slice(1).join(' - ').trim();
    }
  }
  return t;
}

/**
 * @param {string} title
 * @param {object} radio
 * @param {{ fromApi?: boolean }} [opts]  fromApi: titres courts OK (ex. piste CHOQ « Rotten »)
 */
function isUsableShowTitle(title = '', radio = {}, opts = {}) {
  const t = extractShowFromIcyTitle(title, radio);
  if (!t || t.length < 2) return false;
  if (GENERIC_SHOW_RE.test(t)) return false;
  if (GENERIC_FEED_RE.test(t)) return false;
  if (GENERIC_GEO_RE.test(t)) return false;
  // ICY/stream : rejeter les monosyllabes trop courts (bruit). API live : accepter.
  if (!opts.fromApi && t.split(/\s+/).length === 1 && t.length < 8) return false;
  if (opts.fromApi && t.length < 2) return false;
  const low = normKey(t);
  const tokens = stationTokens(radio);
  if (tokens.some((tok) => tok && (low === normKey(tok) || low.startsWith(`${normKey(tok)} -`)))) {
    return false;
  }
  if (radio.slogan && (low === normKey(radio.slogan) || normKey(radio.slogan).includes(low))) {
    return false;
  }
  if (radio.id && low === String(radio.id).toLowerCase()) return false;
  return true;
}

/** Plage d'antenne normalisée (current / next). */
function makeShow({
  title = '',
  host = '',
  start = '',
  end = '',
  source = '',
  url = '',
  slug = '',
} = {}) {
  const t = normalizeShowTitle(title);
  if (!t) return null;
  const out = { title: t, source: source || '' };
  const h = normalizeShowTitle(host);
  if (h) out.host = h;
  if (start) out.start = String(start);
  if (end) out.end = String(end);
  if (url) out.url = String(url);
  if (slug) out.slug = String(slug);
  return out;
}

function parseStreamTitle(meta = '') {
  const m = String(meta).match(/StreamTitle='([^']*)'/i);
  return normalizeShowTitle(m ? m[1] : meta);
}

/** HH:MM dans `timeZone` depuis Unix, ISO-8601 ou horloge naïve Airtime. */
function timeFromStamp(value, timeZone = DEFAULT_TZ) {
  if (value == null || value === '') return '';

  const formatMs = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms));
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    let hour = parseInt(map.hour, 10);
    if (hour === 24 || Number.isNaN(hour)) hour = 0;
    const minute = parseInt(map.minute, 10) || 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };

  if (typeof value === 'number' || /^\d{9,}$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    return formatMs(n > 1e12 ? n : n * 1000);
  }

  const raw = String(value).trim();
  // ISO avec fuseau (CHOQ GraphQL : 2026-07-23T15:00:00+00:00) → convertir
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) || /Z$|[+-]\d{2}:\d{2}$/.test(raw)) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return formatMs(ms);
  }
  // Horloge naïve Airtime "2026-07-09 12:00:00" : déjà en heure locale station
  return hhmm(raw) || '';
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────

function fetchIcyNowPlaying(url, redirects = 0, timeout = DEFAULT_TIMEOUT) {
  if (!url || redirects > 4) return Promise.resolve(null);

  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'LE-RADAR-NowPlayingBot/1.0',
          'Icy-MetaData': '1',
        },
        timeout,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          resolve(fetchIcyNowPlaying(next, redirects + 1, timeout));
          return;
        }

        if (res.statusCode >= 400) {
          res.resume();
          return resolve(null);
        }

        const icyMetaint = parseInt(res.headers['icy-metaint'] || '0', 10);
        const icyName = res.headers['icy-name'] || res.headers['ice-name'] || '';
        const icyDesc = res.headers['icy-description'] || '';

        if (!icyMetaint) {
          res.resume();
          return resolve({ icyName, icyDesc, streamTitle: '' });
        }

        let audioBytes = 0;
        let metaLen = 0;
        let metaBuf = Buffer.alloc(0);
        let settled = false;

        const finish = (streamTitle = '') => {
          if (settled) return;
          settled = true;
          res.destroy();
          resolve({ icyName, icyDesc, streamTitle: normalizeShowTitle(streamTitle) });
        };

        res.on('data', (chunk) => {
          if (settled) return;
          let offset = 0;

          while (offset < chunk.length) {
            if (metaLen === 0) {
              const need = icyMetaint - audioBytes;
              if (need > 0) {
                const take = Math.min(need, chunk.length - offset);
                audioBytes += take;
                offset += take;
                if (audioBytes < icyMetaint) return;
              }
              if (offset >= chunk.length) return;
              metaLen = chunk[offset] * 16;
              offset += 1;
              if (metaLen === 0) {
                audioBytes = 0;
                continue;
              }
            }

            const take = Math.min(metaLen - metaBuf.length, chunk.length - offset);
            metaBuf = Buffer.concat([metaBuf, chunk.slice(offset, offset + take)]);
            offset += take;
            if (metaBuf.length >= metaLen) {
              finish(parseStreamTitle(metaBuf.slice(0, metaLen).toString('utf8')));
              return;
            }
          }
        });

        res.on('error', () => finish());
        req.on('timeout', () => finish());
        setTimeout(() => finish(), timeout);
      },
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function fetchJsonText(url, timeout = DEFAULT_TIMEOUT) {
  if (!url) return Promise.resolve('');
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'LE-RADAR-NowPlayingBot/1.0',
          Accept: 'application/json',
        },
        timeout,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          resolve(fetchJsonText(next, timeout));
          return;
        }
        if (res.statusCode >= 400) {
          res.resume();
          return resolve('');
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });
}

async function fetchJson(url, timeout = DEFAULT_TIMEOUT) {
  const text = await fetchJsonText(url, timeout);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── Adaptateurs live ──────────────────────────────────────────────────────────
// Chaque adaptateur renvoie { current?, next?, track?, cors? } ou null.
// cors: true si le navigateur peut re-poller (Access-Control-Allow-Origin).

/** CISM admin API v1 — current + upcoming (+ following). */
async function adaptCismV1(src = {}, radio = {}, ctx = {}) {
  const url = src.url || 'https://admin.cism893.ca/api/v1/live';
  const payload = await fetchJson(url);
  if (!payload) return null;
  const data = payload.data || payload;
  const cur = data.current;
  const up = data.upcoming || data.next;
  const tz = ctx.timeZone || DEFAULT_TZ;
  const current = cur?.title
    ? makeShow({
      title: cur.title,
      host: cur.host || cur.artist || '',
      start: timeFromStamp(cur.datetime ?? cur.starts ?? cur.start, tz),
      end: timeFromStamp(cur.end ?? cur.ends, tz),
      source: 'api-live',
      url: cur.url || '',
      slug: cur.slug || '',
    })
    : null;
  const next = up?.title
    ? makeShow({
      title: up.title,
      host: up.host || up.artist || '',
      start: timeFromStamp(up.datetime ?? up.starts ?? up.start, tz),
      end: timeFromStamp(up.end ?? up.ends, tz),
      source: 'api-live',
      url: up.url || '',
      slug: up.slug || '',
    })
    : null;
  if (!current && !next) return null;
  return { current, next, cors: true, endpoint: url };
}

/**
 * Formate une piste « Artiste — Titre » (ou l'un des deux).
 * CHOQ /api/live et Triton renvoient des morceaux, pas des émissions.
 */
function formatTrackLine(title = '', artist = '') {
  const t = normalizeShowTitle(title);
  const a = normalizeShowTitle(artist);
  if (t && a && normKey(t) !== normKey(a)) return `${a} — ${t}`;
  return t || a || '';
}

/**
 * Craft CMS /api/live (CHOQ) — **piste en cours**, pas l'émission.
 * Structure réelle : { live: { title, artist, picture } }.
 * Ne jamais promouvoir title/artist en « current » show (sinon « pastel peaks
 * avec devan » masque la grille / l'émission à venir).
 */
async function adaptCraftLive(src = {}, radio = {}) {
  let url = src.url || src.base || '';
  if (!url) return null;
  if (!/\/api\/live\/?$/i.test(url)) {
    try {
      url = new URL('/api/live', url).toString();
    } catch {
      return null;
    }
  }
  const payload = await fetchJson(url);
  if (!payload) return null;
  const live = payload.live || payload;
  // Champs « show » explicites seulement si l'API en fournit un jour
  const showTitle = live.show || live.program || live.emission || '';
  const showHost = live.host || live.dj || '';
  const trackTitle = live.title || live.name || live.cue_title || '';
  const trackArtist = live.artist || live.track_artist_name || '';
  const track = formatTrackLine(trackTitle, trackArtist);

  const current = showTitle
    ? makeShow({
      title: showTitle,
      host: showHost,
      source: 'api-live',
      url: live.picture || live.image || '',
    })
    : null;

  if (!current && !track) return null;
  // CORS fermé sur choq.ca — le navigateur ne re-pollera pas cette URL.
  return {
    current,
    next: null,
    track: track || '',
    cors: false,
    endpoint: url,
  };
}

/**
 * CHOQ — émissions du jour via GraphQL (queryEpisodesOfDay).
 * Fournit current + next avec horaires (heure de Québec) pour l'antenne
 * et la bascule client sans attendre le prochain run du bot.
 */
async function adaptChoqEpisodes(src = {}, radio = {}, ctx = {}) {
  const endpoint = src.url || 'https://www.choq.ca/api/graphql';
  const tz = ctx.timeZone || DEFAULT_TZ;
  const now = ctx.now instanceof Date ? ctx.now : new Date();

  const ymdParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const map = {};
  for (const p of ymdParts) map[p.type] = p.value;
  const today = `${map.year}-${map.month}-${map.day}`;
  // Lendemain civil (Toronto) pour les émissions après minuit UTC affichées le jour J
  const tomorrowDate = new Date(now.getTime() + 36 * 3600 * 1000);
  const tParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(tomorrowDate);
  const tmap = {};
  for (const p of tParts) tmap[p.type] = p.value;
  const tomorrow = `${tmap.year}-${tmap.month}-${tmap.day}`;

  const query = `query queryEpisodesOfDay($date: [QueryArgument]) {
    entries(
      section: "episodes"
      dateTime1: $date
      orderBy: "dateTime1 ASC"
      limit: 40
      status: null
    ) {
      ... on episodes_default_Entry {
        title
        subtitle: text2
        timestamp_start: dateTime1
        timestamp_end: dateTime2
        parent: emissionListeUnique {
          ... on emissions_default_Entry {
            title
            slug
          }
        }
      }
    }
  }`;

  const fetchDay = async (dayYmd, nextYmd) => {
    const body = JSON.stringify({
      query,
      variables: { date: ['and', `>= ${dayYmd}`, `< ${nextYmd}`] },
    });
    const text = await new Promise((resolve) => {
      const lib = endpoint.startsWith('https') ? https : http;
      const u = new URL(endpoint);
      const req = lib.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'LE-RADAR-NowPlayingBot/1.0',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: DEFAULT_TIMEOUT,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        },
      );
      req.on('error', () => resolve(''));
      req.on('timeout', () => {
        req.destroy();
        resolve('');
      });
      req.write(body);
      req.end();
    });
    if (!text) return [];
    try {
      const json = JSON.parse(text);
      return Array.isArray(json?.data?.entries) ? json.data.entries : [];
    } catch {
      return [];
    }
  };

  // Jour civil suivant pour la borne haute « < demain »
  const dayAfter = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + 1));
    return dt.toISOString().slice(0, 10);
  };

  const entries = [
    ...(await fetchDay(today, dayAfter(today))),
    ...(await fetchDay(tomorrow, dayAfter(tomorrow))),
  ];

  const slots = [];
  for (const e of entries) {
    if (!e) continue;
    const parent = Array.isArray(e.parent) ? e.parent[0] : e.parent;
    const title = normalizeShowTitle(parent?.title || e.title || '');
    if (!title) continue;
    const startMs = e.timestamp_start ? Date.parse(e.timestamp_start) : NaN;
    const endMs = e.timestamp_end ? Date.parse(e.timestamp_end) : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    slots.push({
      title,
      startMs,
      endMs,
      start: timeFromStamp(e.timestamp_start, tz),
      end: timeFromStamp(e.timestamp_end, tz),
      slug: parent?.slug || '',
      subtitle: normalizeShowTitle(e.subtitle || ''),
    });
  }
  slots.sort((a, b) => a.startMs - b.startMs);

  // Dédupliquer (today+tomorrow overlap)
  const seen = new Set();
  const unique = [];
  for (const s of slots) {
    const key = `${s.startMs}|${normKey(s.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }

  const nowMs = now.getTime();
  let currentRaw = null;
  let nextRaw = null;
  for (const s of unique) {
    if (nowMs >= s.startMs && nowMs < s.endMs) {
      currentRaw = s;
    } else if (s.startMs > nowMs && !nextRaw) {
      nextRaw = s;
    }
  }

  const toShow = (s) => (s
    ? makeShow({
      title: s.title,
      start: s.start,
      end: s.end,
      source: 'api-live',
      slug: s.slug || '',
    })
    : null);

  const current = toShow(currentRaw);
  const next = toShow(nextRaw);
  if (!current && !next) return null;
  return { current, next, cors: false, endpoint };
}

/**
 * Triton / StreamTheWorld Now Playing (XML) — piste en cours, CORS *.
 * Ex. CHOQ mount SP_R4799664. Permet un re-poll navigateur (clientPoll).
 */
async function adaptTritonNowPlaying(src = {}, radio = {}) {
  const mount = String(src.mount || src.mountName || '').trim();
  if (!mount) return null;
  const url = src.url
    || `https://np.tritondigital.com/public/nowplaying?mountName=${encodeURIComponent(mount)}&numberToFetch=1&eventType=track`;
  const text = await fetchJsonText(url);
  if (!text || !text.includes('nowplaying-info')) return null;

  const prop = (name) => {
    const re = new RegExp(
      `name="${name}"\\s*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</property>`,
      'i',
    );
    const m = re.exec(text);
    return m ? normalizeShowTitle(m[1]) : '';
  };

  const title = prop('cue_title') || prop('track_title') || prop('title');
  const artist = prop('track_artist_name') || prop('artist_name') || prop('artist');
  const track = formatTrackLine(title, artist);
  if (!track) return null;
  return {
    current: null,
    next: null,
    track,
    cors: true,
    endpoint: url,
  };
}

/** LibreTime / Airtime — shows.current + shows.next (v2) ou currentShow (v1). */
async function adaptAirtimeLive(src = {}, radio = {}, ctx = {}) {
  const base = String(src.base || src.url || '').replace(/\/+$/, '');
  if (!base) return null;
  const tz = ctx.timeZone || DEFAULT_TZ;

  // Préférer v2 (structure shows.*)
  let payload = await fetchJson(`${base}/api/live-info-v2/format/json`);
  let currentRaw = null;
  let nextRaw = null;

  if (payload?.shows) {
    currentRaw = payload.shows.current || null;
    const n = payload.shows.next;
    nextRaw = Array.isArray(n) ? n[0] : n;
  } else {
    payload = await fetchJson(`${base}/api/live-info`);
    if (!payload) return null;
    const cs = payload.currentShow;
    const ns = payload.nextShow;
    currentRaw = Array.isArray(cs) ? cs[0] : cs;
    nextRaw = Array.isArray(ns) ? ns[0] : ns;
  }

  const showFrom = (raw, source = 'api-live') => {
    if (!raw) return null;
    const title = raw.name || raw.title || '';
    return makeShow({
      title,
      host: raw.host || raw.genre || '',
      start: timeFromStamp(raw.starts || raw.start_timestamp || raw.start, tz),
      end: timeFromStamp(raw.ends || raw.end_timestamp || raw.end, tz),
      source,
      url: raw.url || '',
    });
  };

  const current = showFrom(currentRaw);
  const next = showFrom(nextRaw);
  if (!current && !next) return null;
  return {
    current,
    next,
    cors: false,
    endpoint: `${base}/api/live-info-v2/format/json`,
  };
}

/** ICY StreamTitle — souvent le morceau ; parfois le nom d'émission. */
async function adaptIcy(src = {}, radio = {}) {
  const stream = src.url || radio.stream;
  if (!stream) return null;
  const icy = await fetchIcyNowPlaying(stream);
  if (!icy) return null;

  // track = StreamTitle (piste). Toujours renseigné si présent.
  const trackRaw = extractShowFromIcyTitle(icy.streamTitle, radio);
  const track = trackRaw && trackRaw.length >= 2 ? trackRaw : '';

  // CHOQ (et sources trackOnly) : le StreamTitle est la musique, jamais l'émission.
  // Sinon on affiche « Status/Non-Status - Tom Climate » comme titre À L'ANTENNE.
  const trackOnly = src.trackOnly === true
    || radio.id === 'choq'
    || (Array.isArray(radio._nowPlayingSources)
      && radio._nowPlayingSources.some((s) => s && (s.type === 'choq-episodes' || s.type === 'triton-np')));

  let current = null;
  if (!trackOnly) {
    const candidates = [icy.streamTitle, icy.icyName, icy.icyDesc];
    for (const c of candidates) {
      const parsed = extractShowFromIcyTitle(c, radio);
      if (isUsableShowTitle(parsed, radio)) {
        current = makeShow({ title: parsed, source: 'stream' });
        break;
      }
    }
  }

  return {
    current,
    next: null,
    track: track && (!current || normKey(track) !== normKey(current.title)) ? track : (track || ''),
    icyName: icy.icyName || '',
    icyDesc: icy.icyDesc || '',
    cors: false,
    endpoint: stream,
  };
}

const LIVE_ADAPTERS = {
  'cism-v1': adaptCismV1,
  cism: adaptCismV1,
  'craft-live': adaptCraftLive,
  craft: adaptCraftLive,
  // « choq » historique pointait sur craft-live (piste) — garder pour rétrocompat,
  // mais préférer choq-episodes (émissions) + triton-np (piste CORS) dans radios.json.
  choq: adaptCraftLive,
  'choq-episodes': adaptChoqEpisodes,
  'choq-schedule': adaptChoqEpisodes,
  'triton-np': adaptTritonNowPlaying,
  triton: adaptTritonNowPlaying,
  'airtime-live': adaptAirtimeLive,
  airtime: adaptAirtimeLive,
  icy: adaptIcy,
  stream: adaptIcy,
};

/** Infère le type d'adaptateur depuis une URL d'API. */
function detectAdapterTypeFromUrl(url = '') {
  const u = String(url || '').toLowerCase();
  if (!u) return null;
  if (u.includes('admin.cism893.ca') || /\/api\/v1\/live/.test(u)) return 'cism-v1';
  if (u.includes('airtime.pro') || u.includes('live-info')) return 'airtime-live';
  if (u.includes('/api/live') || u.includes('choq.ca')) return 'craft-live';
  return null;
}

function airtimeBaseFromStream(stream) {
  try {
    const host = new URL(stream).host;
    const m = /^([a-z0-9-]+)\.out\.airtime\.pro$/i.exec(host);
    if (m) return `https://${m[1]}.airtime.pro`;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Construit la liste ordonnée des sources live pour un poste.
 * Déclaratif (_nowPlayingSources) > rétrocompat (_nowPlayingApi) > auto.
 */
function inferNowPlayingSources(radio = {}) {
  const out = [];
  const push = (src) => {
    if (!src || !src.type) return;
    const key = `${src.type}|${(src.base || src.url || '').replace(/\/+$/, '')}`;
    if (out.some((s) => `${s.type}|${(s.base || s.url || '').replace(/\/+$/, '')}` === key)) {
      return;
    }
    out.push(src);
  };

  // 1. Sources explicites
  if (Array.isArray(radio._nowPlayingSources)) {
    for (const s of radio._nowPlayingSources) {
      if (s && s.type) push({ ...s });
    }
  }

  // CHOQ : toujours tenter émissions GraphQL + Triton (piste CORS) si absents
  if (radio.id === 'choq' || /choq\.ca/i.test(String(radio.website || ''))) {
    push({ type: 'choq-episodes', url: 'https://www.choq.ca/api/graphql' });
    const mountMatch = String(radio.stream || '').match(/\/(SP_[A-Z0-9]+)/i);
    if (mountMatch) {
      push({ type: 'triton-np', mount: mountMatch[1].replace(/_SC$/i, '') });
    }
  }

  // 2. Rétrocompat _nowPlayingApi
  if (radio._nowPlayingApi) {
    const type = detectAdapterTypeFromUrl(radio._nowPlayingApi)
      || (radio.id === 'cism' ? 'cism-v1' : null)
      || (radio.id === 'choq' ? 'craft-live' : null)
      || 'craft-live';
    push({ type, url: radio._nowPlayingApi, base: radio._nowPlayingApi });
  }

  // 3. Auto-détection Airtime depuis le flux
  const airBase = radio.stream ? airtimeBaseFromStream(radio.stream) : null;
  if (airBase) push({ type: 'airtime-live', base: airBase });

  // 4. Heuristiques site (Craft /api/live) — seulement si rien d'API encore
  const hasApi = out.some((s) => s.type !== 'icy' && s.type !== 'stream');
  if (!hasApi && radio.website) {
    // CHOQ-like Craft is rare ; on ne sonde pas en live ici (trop lent).
    // Les stations ajoutent _nowPlayingSources ou _nowPlayingApi.
  }

  // 5. ICY toujours en dernier (piste / repli) — sauf si déjà déclaré
  if (radio.stream && !out.some((s) => s.type === 'icy' || s.type === 'stream')) {
    push({ type: 'icy', url: radio.stream });
  }

  // Compléter url manquante sur icy déclaratif
  for (const s of out) {
    if ((s.type === 'icy' || s.type === 'stream') && !s.url && radio.stream) {
      s.url = radio.stream;
    }
  }

  return out;
}

async function runLiveAdapter(src, radio, ctx = {}) {
  const fn = LIVE_ADAPTERS[src.type];
  if (typeof fn !== 'function') return null;
  try {
    return await fn(src, radio, ctx);
  } catch {
    return null;
  }
}

function sourceRank(show) {
  const src = show?.source || '';
  if (src === 'api-live') return 3;
  if (src === 'schedule') return 2;
  if (src === 'stream') return 1;
  return 0;
}

/** Garde le show de rang le plus élevé (premier arrivé en cas d'égalité). */
function pickBetterShow(current, candidate, radio) {
  if (!candidate?.title) return current;
  const fromApi = candidate.source === 'api-live';
  if (!isUsableShowTitle(candidate.title, radio, { fromApi })) return current;
  if (!current) return candidate;
  return sourceRank(candidate) > sourceRank(current) ? candidate : current;
}

/**
 * Fusionne les hits d'adaptateurs + grille horaire.
 * Priorité current : api-live > schedule > icy/stream.
 * Priorité next    : api-live > schedule.
 */
function mergeOnAirResults(hits, scheduleHit, radio) {
  let current = null;
  let next = null;
  let track = '';
  const sourcesUsed = [];

  for (const hit of hits) {
    if (!hit) continue;
    if (hit.current?.source) sourcesUsed.push(hit.current.source);
    if (hit.next?.source) sourcesUsed.push(hit.next.source);
    current = pickBetterShow(current, hit.current, radio);
    next = pickBetterShow(next, hit.next, radio);
    if (hit.track) track = hit.track;
  }

  // Grille : comble les trous ; enrichit les horaires si titres alignés.
  if (scheduleHit?.current) {
    if (!current) {
      current = scheduleHit.current;
      sourcesUsed.push('schedule');
    } else if (current.source === 'api-live'
      && !current.start
      && scheduleHit.current.start
      && normKey(current.title) === normKey(scheduleHit.current.title)) {
      current = {
        ...current,
        start: scheduleHit.current.start,
        end: scheduleHit.current.end || current.end || '',
      };
    } else if (sourceRank(scheduleHit.current) > sourceRank(current)) {
      // schedule > stream : le nom d'émission de la grille bat l'ICY morceau
      if (current.source === 'stream' && !track) track = current.title;
      current = scheduleHit.current;
      sourcesUsed.push('schedule');
    }
  }

  if (scheduleHit?.next) {
    if (!next) {
      next = scheduleHit.next;
      sourcesUsed.push('schedule');
    } else if (sourceRank(scheduleHit.next) > sourceRank(next)) {
      next = scheduleHit.next;
    }
  }

  // Éviter next === current
  if (current && next && normKey(current.title) === normKey(next.title)) {
    next = (scheduleHit?.next && normKey(scheduleHit.next.title) !== normKey(current.title))
      ? scheduleHit.next
      : null;
  }

  if (track && current && normKey(track) === normKey(current.title)) track = '';

  return { current, next, track, sourcesUsed: [...new Set(sourcesUsed)] };
}

function scheduleToHit(schedules, radioId, timeZone = DEFAULT_TZ) {
  const grid = schedules?.stations?.[radioId]?.grid;
  if (!Array.isArray(grid) || !grid.length) return null;
  const cur = resolveCurrentSlot(grid, new Date(), timeZone);
  const nxt = resolveNextSlot(grid, new Date(), timeZone);
  return {
    current: cur
      ? makeShow({
        title: cur.title,
        host: cur.host || '',
        start: cur.start,
        end: cur.end,
        source: 'schedule',
        url: cur.url || '',
      })
      : null,
    next: nxt
      ? makeShow({
        title: nxt.title,
        host: nxt.host || '',
        start: nxt.start,
        end: nxt.end,
        source: 'schedule',
        url: nxt.url || '',
      })
      : null,
  };
}

/**
 * Sonde complète d'un poste : APIs live + grille + ICY.
 * @returns {{ current, next, track, source, showTitle, host, sources, checkedAt, clientPoll? }}
 */
async function probeStationOnAir(radio = {}, {
  schedules = null,
  timeZone = DEFAULT_TZ,
} = {}) {
  const sources = inferNowPlayingSources(radio);
  const ctx = { timeZone };
  const hits = [];
  let clientPoll = null;

  for (const src of sources) {
    // ICY en dernier : on le fait après les APIs
    if (src.type === 'icy' || src.type === 'stream') continue;
    const hit = await runLiveAdapter(src, radio, ctx);
    if (hit) {
      hits.push(hit);
      // Préférer un clientPoll qui rafraîchit la piste (triton CORS) ;
      // ne pas écraser par une API sans CORS (craft-live).
      if (hit.cors && hit.endpoint) {
        const isTrackPoll = src.type === 'triton-np' || src.type === 'triton'
          || Boolean(hit.track && !hit.current);
        if (!clientPoll || isTrackPoll) {
          clientPoll = { type: src.type, url: hit.endpoint };
        }
      }
    }
  }

  // ICY
  const icySrc = sources.find((s) => s.type === 'icy' || s.type === 'stream');
  if (icySrc) {
    const hit = await runLiveAdapter(icySrc, radio, ctx);
    if (hit) hits.push(hit);
  }

  const scheduleHit = scheduleToHit(schedules, radio.id, timeZone);
  const merged = mergeOnAirResults(hits, scheduleHit, radio);

  const current = merged.current;
  const next = merged.next;
  const primarySource = current?.source
    || next?.source
    || (radio.stream ? 'stream' : 'none');

  return {
    id: radio.id,
    name: radio.name,
    // Schéma riche
    current: current || null,
    next: next || null,
    track: merged.track || '',
    // Rétrocompat app / anciens lecteurs
    showTitle: current?.title || '',
    host: current?.host || '',
    source: primarySource,
    sources: merged.sourcesUsed,
    clientPoll: clientPoll || null,
    checkedAt: new Date().toISOString(),
  };
}

/** @deprecated — préférer probeStationOnAir */
async function probeNowPlaying(radio = {}, opts = {}) {
  const full = await probeStationOnAir(radio, opts);
  return {
    showTitle: full.showTitle,
    host: full.host,
    source: full.source,
    current: full.current,
    next: full.next,
    track: full.track,
  };
}

/** @deprecated wrappers conservés pour tests / scripts ad hoc */
async function fetchCraftLiveShow(apiBase = '') {
  const hit = await adaptCraftLive({ url: apiBase }, {});
  if (!hit?.current) return null;
  return {
    showTitle: hit.current.title,
    host: hit.current.host || '',
    source: 'api-live',
  };
}

async function fetchCismLiveShow(apiUrl = 'https://admin.cism893.ca/api/v1/live') {
  const hit = await adaptCismV1({ url: apiUrl }, {});
  if (!hit?.current) return null;
  return {
    showTitle: hit.current.title,
    host: hit.current.host || '',
    source: 'api-live',
    slug: hit.current.slug || '',
  };
}

async function fetchStationLiveApi(radio = {}) {
  const sources = inferNowPlayingSources(radio).filter((s) => s.type !== 'icy' && s.type !== 'stream');
  for (const src of sources) {
    const hit = await runLiveAdapter(src, radio, {});
    if (hit?.current?.title && isUsableShowTitle(hit.current.title, radio)) {
      return {
        showTitle: hit.current.title,
        host: hit.current.host || '',
        source: 'api-live',
        slug: hit.current.slug || '',
      };
    }
  }
  return null;
}

module.exports = {
  DEFAULT_TZ,
  LIVE_ADAPTERS,
  normalizeShowTitle,
  isUsableShowTitle,
  extractShowFromIcyTitle,
  formatTrackLine,
  makeShow,
  fetchIcyNowPlaying,
  fetchJsonText,
  fetchJson,
  fetchCraftLiveShow,
  fetchCismLiveShow,
  fetchStationLiveApi,
  detectAdapterTypeFromUrl,
  airtimeBaseFromStream,
  inferNowPlayingSources,
  runLiveAdapter,
  mergeOnAirResults,
  scheduleToHit,
  probeStationOnAir,
  probeNowPlaying,
};
