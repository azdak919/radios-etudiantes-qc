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
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !FALSE_FRIENDS.has(w) && !/^\d+$/.test(w));
}

function extractProperNouns(text = '') {
  const raw = String(text);
  const acronyms = raw.match(/\b[A-Z0-9]{2,}\b|\bG\d+\b/g) || [];
  const words = raw.match(/\b[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]+(?:['’-][A-ZÀ-ÖØ-Þa-zà-öø-ÿ]+)*/g) || [];
  return [...new Set([...acronyms, ...words]
    .map((w) => normalizeText(w))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !FALSE_FRIENDS.has(w)))];
}

/** Corps éditorial sans byline ni HTML — base pour les requêtes visuelles. */
function extractArticleContent(item) {
  let body = stripHtml(item.excerpt || '');
  body = body.replace(
    /^\s*(?:Par|By)\s+[\p{Lu}][\p{L}'’.\-]+(?:\s+[\p{Lu}][\p{L}'’.\-]+){0,3}\s+/iu,
    '',
  );
  return body.replace(/\s+/g, ' ').trim();
}

function buildMatchTokens(item) {
  const content = extractArticleContent(item);
  const titleTokens = tokenize(item.title || '');
  const contentTokens = tokenize(content);
  const proper = extractProperNouns(`${item.title || ''} ${content}`);
  const isUsefulToken = (t) => t.length >= 3 && !/^(?:19|20)\d{2}$/.test(t) && !/^\d+$/.test(t);
  const important = [...new Set([
    ...proper.filter(isUsefulToken),
    ...contentTokens.filter((t) => t.length >= 4),
    ...titleTokens.filter((t) => t.length >= 4),
  ])].slice(0, 16);
  return { important, title: titleTokens, content: contentTokens, proper, contentText: content };
}

function extractSearchQueries(item) {
  const content = extractArticleContent(item);
  const contentProper = extractProperNouns(content);
  const titleProper = extractProperNouns(item.title || '');
  const titleTokens = tokenize(item.title || '');
  const contentTokens = tokenize(content).slice(0, 12);
  const match = buildMatchTokens(item);

  const queries = [];

  if (contentProper.length >= 2) queries.push(contentProper.slice(0, 5).join(' '));
  if (contentTokens.length >= 3) queries.push(contentTokens.slice(0, 6).join(' '));
  const firstSentence = content.split(/[.!?]/)[0]?.trim() || '';
  if (firstSentence.length >= 24) {
    queries.push(tokenize(firstSentence).slice(0, 7).join(' '));
  }

  if (/g7/i.test(content) || /g7/i.test(item.title || '') || match.proper.includes('g7')) {
    queries.push('G7 summit 2026 Evian leaders');
    queries.push('G7 family photo Evian France');
  }

  if (titleProper.length >= 2) queries.push(titleProper.join(' '));
  if (titleProper.length >= 1 && contentTokens.length >= 1) {
    queries.push(`${titleProper[0]} ${contentTokens.slice(0, 3).join(' ')}`);
  }
  if (match.important.length >= 2) queries.push(match.important.slice(0, 4).join(' '));
  if (titleTokens.length >= 2) queries.push(titleTokens.slice(0, 3).join(' '));
  if (titleProper.length >= 1) queries.push(titleProper[0]);

  return [...new Set(queries.filter((q) => q && q.length > 2))];
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

function cleanCreatorName(raw = '') {
  let s = stripHtml(raw).trim();
  s = s.replace(/\.mw-parser-output[\s\S]*/i, '').trim();
  s = s.replace(/\s+/g, ' ');
  if (s.length > 72) {
    const cut = s.slice(0, 72);
    const lastSpace = cut.lastIndexOf(' ');
    s = `${(lastSpace > 36 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return s;
}

function parseOpenverseCreator(result = {}) {
  const direct = cleanCreatorName(result.creator || '');
  if (direct) return direct;
  const attr = stripHtml(result.attribution || '');
  const by = attr.match(/(?:photo\s+)?(?:by|par)\s+([^,·]+)/i);
  if (by) return cleanCreatorName(by[1]);
  const first = attr.split(/[,·]/)[0];
  return cleanCreatorName(first);
}

function formatAttribution(hit) {
  const creator = cleanCreatorName(hit.creator || hit.artist || '') || 'Auteur·e inconnu·e';
  const license = licenseLabel(hit.license || hit.licenseShort || 'CC');
  const via = hit.provider === 'wikimedia' ? 'Wikimedia Commons' : 'Openverse';
  return `Photo : ${creator} / ${license} · ${via}`;
}

function scoreCandidate(hit, matchTokens) {
  let score = 0;
  const w = hit.width || 0;
  const h = hit.height || 0;
  if (meetsLeadDisplaySize(w, h)) score += 90;
  else if (w >= 560 && h >= 315) score += 45;
  else if (w >= 400 && h >= 250) score += 20;
  else return -1;

  const ratio = w / Math.max(h, 1);
  if (ratio >= 1.1 && ratio <= 2.2) score += 22;
  score += Math.min(w, 2400) / 35;

  const hay = normalizeText(`${hit.title || ''} ${hit.tags || ''}`);
  const { important = [], content = [], title = [] } = matchTokens || {};
  let contentMatched = 0;
  let titleMatched = 0;

  for (const tok of content) {
    if (tok.length < 3 || FALSE_FRIENDS.has(tok)) continue;
    if (hay.includes(tok)) {
      contentMatched += 1;
      score += tok.length >= 5 ? 22 : 14;
    }
  }
  for (const tok of important) {
    if (FALSE_FRIENDS.has(tok) || tok.length < 3) continue;
    if (hay.includes(tok)) score += 16;
  }
  for (const tok of title) {
    if (tok.length < 4 || FALSE_FRIENDS.has(tok)) continue;
    if (hay.includes(tok)) {
      titleMatched += 1;
      score += 8;
    }
  }

  const needContentMatch = content.filter((t) => t.length >= 4 && !FALSE_FRIENDS.has(t));
  if (needContentMatch.length >= 2 && contentMatched === 0 && titleMatched === 0) return -1;
  if (important.length >= 2 && contentMatched + titleMatched === 0) return -1;

  if (hit.provider === 'wikimedia') score += 8;
  if (hit.license === 'cc0' || hit.license === 'pdm') score += 4;

  return score;
}

async function searchOpenverse(query, matchTokens) {
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
      creator: parseOpenverseCreator(r),
      license: r.license || '',
      title: r.title || '',
      tags: (r.tags || []).map((t) => t.name || t).join(' '),
      provider: 'openverse',
      foreignLandingUrl: r.foreign_landing_url || r.url,
      score: 0,
    }))
    .map((r) => ({ ...r, score: scoreCandidate(r, matchTokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

async function searchWikimedia(query, matchTokens) {
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
      creator: cleanCreatorName(artist),
      license: licenseShort,
      licenseShort,
      title: page.title || '',
      tags: page.title || '',
      provider: 'wikimedia',
      foreignLandingUrl: info.descriptionurl || info.url,
      score: 0,
    };
    hit.score = scoreCandidate(hit, matchTokens);
    if (hit.score > 0) out.push(hit);
  }
  return out.sort((a, b) => b.score - a.score);
}

async function validateCandidate(hit) {
  if (meetsLeadDisplaySize(hit.width, hit.height)) return hit;
  const dims = await probeRemoteImageSize(hit.url);
  if (!dims) {
    if (hit.width >= 720 && hit.height >= 405 && hit.width * hit.height >= 320000) return hit;
    return null;
  }
  const enriched = { ...hit, width: dims.width, height: dims.height };
  return meetsLeadDisplaySize(dims.width, dims.height) ? enriched : null;
}

async function findStockPhoto(item) {
  const queries = extractSearchQueries(item);
  if (!queries.length) return null;

  const matchTokens = buildMatchTokens(item);
  const seen = new Set();

  for (const query of queries) {
    const batches = await Promise.all([
      searchOpenverse(query, matchTokens),
      searchWikimedia(query, matchTokens),
    ]);
    const candidates = batches.flat().sort((a, b) => b.score - a.score);

    for (const cand of candidates) {
      if (seen.has(cand.url)) continue;
      seen.add(cand.url);
      const valid = await validateCandidate(cand);
      if (!valid) continue;
      const creator = cleanCreatorName(valid.creator || valid.artist || '');
      return {
        stockImage: valid.url,
        imageCredit: formatAttribution(valid),
        imageCreator: creator,
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
  extractArticleContent,
  buildMatchTokens,
  extractSearchQueries,
  formatAttribution,
  cleanCreatorName,
  findStockPhoto,
  searchOpenverse,
  searchWikimedia,
};