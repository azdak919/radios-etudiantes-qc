/**
 * Recherche de photos libres de droit (Openverse + Wikimedia Commons).
 * Dernier recours quand la page source n'a pas de visuel vedette utilisable.
 */

const https = require('https');
const { meetsLeadDisplaySize, probeRemoteImageSize, sleep } = require('./article-image-lib');

const USER_AGENT = 'RADAR-NewsBot/1.0 (student media aggregator; contact: radios-etudiantes-qc)';

const STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l', 'à', 'au', 'aux', 'en', 'et', 'ou',
  'pour', 'par', 'sur', 'dans', 'son', 'sa', 'ses', 'leur', 'leurs', 'ce', 'cette', 'ces', 'qui',
  'que', 'quoi', 'dont', 'est', 'sont', 'avec', 'sans', 'plus', 'moins', 'tout', 'tous', 'toute',
  'comment', 'pourquoi', 'quand', 'vers', 'chez', 'entre', 'après', 'avant', 'depuis', 'the', 'and',
  'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'has', 'have', 'into', 'about',
  'read', 'more', 'lire', 'suite', 'hellip', 'utm', 'source', 'medium', 'campaign', 'rss',
]);

/** Faux-amis à exclure des requêtes (résumé ≠ resume anglais, etc.) */
const FALSE_FRIENDS = new Set([
  'resume', 'résumé', 'opinion', 'chronique', 'entrevue', 'critique', 'reportage', 'editorial',
  'feature', 'features', 'news', 'article', 'journal', 'campus', 'etudiant', 'étudiant',
]);

function stripHtml(text = '') {
  return String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text = '') {
  return normalizeText(text)
    .split(' ')
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !FALSE_FRIENDS.has(w) && !/^\d+$/.test(w));
}

function extractProperNouns(title = '') {
  const raw = String(title);
  const acronyms = raw.match(/\b[A-Z0-9]{2,}\b|\bG\d+\b/g) || [];
  const words = raw.match(/\b[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]+(?:['’-][A-ZÀ-ÖØ-Þa-zà-öø-ÿ]+)*/g) || [];
  return [...new Set([...acronyms, ...words]
    .map((w) => normalizeText(w))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !FALSE_FRIENDS.has(w)))];
}

function extractSearchQueries(item) {
  const proper = extractProperNouns(item.title || '');
  const titleTokens = tokenize(item.title || '');
  const excerptTokens = tokenize(stripHtml(item.excerpt || '')).slice(0, 10);
  const merged = [...new Set([...proper, ...titleTokens, ...excerptTokens])];

  const queries = [];
  if (proper.length >= 2) queries.push(proper.join(' '));
  if (proper.length >= 1 && titleTokens.length >= 1) {
    queries.push(`${proper[0]} ${titleTokens[0]}`);
  }
  if (/g7/i.test(item.title || '') || proper.includes('g7')) {
    queries.push('G7 summit leaders');
    queries.push('G7 Evian');
  }
  if (merged.length >= 2) queries.push(merged.slice(0, 4).join(' '));
  if (titleTokens.length >= 2) queries.push(titleTokens.slice(0, 3).join(' '));
  if (proper.length >= 1) queries.push(proper[0]);

  return [...new Set(queries.filter(Boolean))];
}

function fetchJson(url, timeout = 12000) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchJson(new URL(res.headers.location, url).toString(), timeout));
        }
        if (res.statusCode >= 400) {
          res.resume();
          return resolve(null);
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function licenseLabel(code = '') {
  const map = {
    cc0: 'CC0',
    pdm: 'Domaine public',
    by: 'CC BY',
    'by-sa': 'CC BY-SA',
    'by-nc': 'CC BY-NC',
    'by-nd': 'CC BY-ND',
    'by-nc-sa': 'CC BY-NC-SA',
    'by-nc-nd': 'CC BY-NC-SA',
  };
  return map[String(code).toLowerCase()] || String(code).toUpperCase();
}

function formatAttribution(hit) {
  const creator = stripHtml(hit.creator || hit.artist || '').trim() || 'Auteur·e inconnu·e';
  const license = licenseLabel(hit.license || hit.licenseShort || 'CC');
  const via = hit.provider === 'wikimedia' ? 'Wikimedia Commons' : 'Openverse';
  return `Photo : ${creator} / ${license} · ${via}`;
}

function scoreCandidate(hit, queryTokens) {
  let score = 0;
  const w = hit.width || 0;
  const h = hit.height || 0;
  if (meetsLeadDisplaySize(w, h)) score += 80;
  else if (w >= 400 && h >= 250) score += 40;
  else if (w >= 300 && h >= 200) score += 15;
  else return -1;

  const ratio = w / Math.max(h, 1);
  if (ratio >= 1.1 && ratio <= 2.2) score += 20;
  score += Math.min(w, 2000) / 40;

  const hay = normalizeText(`${hit.title || ''} ${hit.tags || ''}`);
  const important = queryTokens.filter((t) => !FALSE_FRIENDS.has(t) && t.length > 2);
  let matched = 0;
  for (const tok of important) {
    if (hay.includes(tok)) {
      matched += 1;
      score += 14;
    }
  }
  if (important.length >= 2 && matched === 0) return -1;
  if (important.length >= 1 && matched === 0 && important.some((t) => t.length >= 4)) return -1;

  if (hit.provider === 'wikimedia') score += 5;
  if (hit.license === 'cc0' || hit.license === 'pdm') score += 3;

  return score;
}

async function searchOpenverse(query, queryTokens) {
  const q = encodeURIComponent(query);
  const url = `https://api.openverse.org/v1/images/?q=${q}&page_size=12&license=cc0,by,by-sa,pdm&format=json`;
  const data = await fetchJson(url);
  if (!data?.results?.length) return [];

  return data.results
    .filter((r) => r.url && (r.width || 0) >= 300)
    .map((r) => ({
      url: r.url,
      width: r.width || 0,
      height: r.height || 0,
      creator: r.creator || '',
      license: r.license || '',
      title: r.title || '',
      tags: (r.tags || []).map((t) => t.name || t).join(' '),
      provider: 'openverse',
      foreignLandingUrl: r.foreign_landing_url || r.url,
      score: 0,
    }))
    .map((r) => ({ ...r, score: scoreCandidate(r, queryTokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

async function searchWikimedia(query, queryTokens) {
  const q = encodeURIComponent(query);
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1280&format=json`;
  const data = await fetchJson(url);
  const pages = data?.query?.pages;
  if (!pages) return [];

  const out = [];
  for (const page of Object.values(pages)) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    const meta = info.extmetadata || {};
    const artist = stripHtml(meta.Artist?.value || meta.Credit?.value || '');
    const licenseShort = stripHtml(meta.LicenseShortName?.value || 'CC');
    const w = info.thumbwidth || info.width || 0;
    const h = info.thumbheight || info.height || 0;
    const hit = {
      url: info.url,
      width: w,
      height: h,
      creator: artist,
      license: licenseShort,
      licenseShort,
      title: page.title || '',
      tags: page.title || '',
      provider: 'wikimedia',
      foreignLandingUrl: info.descriptionurl || info.url,
      score: 0,
    };
    hit.score = scoreCandidate(hit, queryTokens);
    if (hit.score > 0) out.push(hit);
  }
  return out.sort((a, b) => b.score - a.score);
}

async function validateCandidate(hit) {
  if (meetsLeadDisplaySize(hit.width, hit.height)) return hit;
  const dims = await probeRemoteImageSize(hit.url);
  if (!dims) return null;
  const enriched = { ...hit, width: dims.width, height: dims.height };
  return meetsLeadDisplaySize(dims.width, dims.height) ? enriched : null;
}

async function findStockPhoto(item) {
  const queries = extractSearchQueries(item);
  if (!queries.length) return null;

  const queryTokens = tokenize(queries[0]);
  const seen = new Set();

  for (const query of queries) {
    const batches = await Promise.all([
      searchOpenverse(query, queryTokens),
      searchWikimedia(query, queryTokens),
    ]);
    const candidates = batches.flat().sort((a, b) => b.score - a.score);

    for (const cand of candidates) {
      if (seen.has(cand.url)) continue;
      seen.add(cand.url);
      const valid = await validateCandidate(cand);
      if (!valid) continue;
      return {
        stockImage: valid.url,
        imageCredit: formatAttribution(valid),
        imageLicense: valid.license || '',
        imageProvider: valid.provider,
        imageSourceUrl: valid.foreignLandingUrl || valid.url,
      };
    }
    await sleep(250);
  }

  return null;
}

module.exports = {
  extractSearchQueries,
  formatAttribution,
  findStockPhoto,
  searchOpenverse,
  searchWikimedia,
};