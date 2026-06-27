/**
 * Métadonnées « à l'antenne » — partagé par fetch-radio-nowplaying.js
 */

const https = require('https');
const http = require('http');

const DEFAULT_TIMEOUT = 12000;
const GENERIC_SHOW_RE = /^(?:airtime!?|liquidsoap(?:\s+radio!?)?|no name|unknown|unspecified|\.+|-+|n\/a)$/i;
const GENERIC_FEED_RE = /(?:high quality|low band|backup only|stream\s*#|feed for)/i;
const GENERIC_GEO_RE = /^(?:montréal|montreal|québec|quebec|sherbrooke|laval|canada)$/i;

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

function isUsableShowTitle(title = '', radio = {}) {
  const t = extractShowFromIcyTitle(title, radio);
  if (!t || t.length < 3) return false;
  if (GENERIC_SHOW_RE.test(t)) return false;
  if (GENERIC_FEED_RE.test(t)) return false;
  if (GENERIC_GEO_RE.test(t)) return false;
  if (t.split(/\s+/).length === 1 && t.length < 8) return false;
  const low = normKey(t);
  const tokens = stationTokens(radio);
  if (tokens.some((tok) => tok && (low === normKey(tok) || low.startsWith(`${normKey(tok)} -`)))) return false;
  if (radio.slogan && (low === normKey(radio.slogan) || normKey(radio.slogan).includes(low))) return false;
  if (radio.id && low === String(radio.id).toLowerCase()) return false;
  return true;
}

function parseStreamTitle(meta = '') {
  const m = String(meta).match(/StreamTitle='([^']*)'/i);
  return normalizeShowTitle(m ? m[1] : meta);
}

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

async function probeNowPlaying(radio = {}) {
  const stream = radio.stream;
  if (!stream) return { showTitle: '', source: 'none' };

  const icy = await fetchIcyNowPlaying(stream);
  if (!icy) return { showTitle: '', source: 'stream', icyName: '', icyDesc: '' };

  const candidates = [icy.streamTitle, icy.icyName, icy.icyDesc];
  for (const c of candidates) {
    const parsed = extractShowFromIcyTitle(c, radio);
    if (isUsableShowTitle(parsed, radio)) {
      return {
        showTitle: parsed,
        source: 'stream',
        icyName: icy.icyName || '',
        icyDesc: icy.icyDesc || '',
      };
    }
  }

  return {
    showTitle: '',
    source: 'stream',
    icyName: icy.icyName || '',
    icyDesc: icy.icyDesc || '',
  };
}

module.exports = {
  fetchIcyNowPlaying,
  probeNowPlaying,
  isUsableShowTitle,
  extractShowFromIcyTitle,
  normalizeShowTitle,
};