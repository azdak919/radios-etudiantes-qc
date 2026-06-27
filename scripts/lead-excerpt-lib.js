/**
 * Extraction du premier paragraphe substantiel depuis la page source —
 * pour l'affichage « à la une » (champ leadExcerpt dans news.json).
 */

const https = require('https');
const { extractBylineFromText } = require('./author-lib');

const FETCH_TIMEOUT = 12000;
const LEAD_EXCERPT_MAX = 1200;
const LEAD_EXCERPT_MIN = 80;
const SUBSTANTIVE_MIN = 60;

const TRUNC_MARKERS_RE = /(?:…|\.{3,}|\[…\]|\[\.\.\.\]|\[&hellip;\])/gi;

function decodeEntities(str = '') {
  return String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, '’')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&hellip;/gi, '…');
}

function stripHtml(html = '') {
  return decodeEntities(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTruncationArtifacts(text = '') {
  return String(text)
    .replace(TRUNC_MARKERS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function endsCompleteSentence(text = '') {
  return /[.!?»"')\]]\s*$/.test(String(text).trim());
}

function fetchText(url, redirects = 3, timeout = FETCH_TIMEOUT) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; REQ-NewsBot/1.0)',
          Accept: 'text/html, application/xhtml+xml, */*',
        },
        timeout,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(fetchText(next, redirects - 1, timeout));
        }
        if (res.statusCode >= 400) {
          res.resume();
          return resolve('');
        }
        let data = '';
        res.setEncoding('utf8');
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

function articleBodyHtml(html = '') {
  const regions = [
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i),
    html.match(/class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i),
    html.match(/class=["'][^"']*post-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i),
    html.match(/class=["'][^"']*article-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i),
  ];
  for (const m of regions) {
    if (m && m[1] && m[1].length > 120) return m[1];
  }
  return html;
}

function isBylineOnlyParagraph(text = '') {
  const plain = String(text).replace(/\s+/g, ' ').trim();
  if (!/^(?:Par|By)\s+/i.test(plain)) return false;
  const { author, body } = extractBylineFromText(plain);
  return !!author && body.length < 24;
}

function isJunkParagraph(text = '') {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t || t.length < 24) return true;
  if (/^(?:Photo|Crédit|Credit|Image|Illustration)\s*:/i.test(t)) return true;
  if (/^\[?\s*(?:read more|lire la suite|continue reading)/i.test(t)) return true;
  if (/^L['’]article\b/i.test(t) && t.length < 100) return true;
  if (isBylineOnlyParagraph(t)) return true;
  return false;
}

function paragraphsFromHtml(html = '') {
  const decoded = decodeEntities(html);
  const raw = decoded.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  return raw.map((p) => stripHtml(p)).filter(Boolean);
}

function normalizeLeadParagraph(text = '') {
  let s = stripTruncationArtifacts(stripHtml(text));
  s = s.replace(/\s*L['’]article\b[\s\S]*?est apparu en premier sur[\s\S]*$/i, '');
  s = s.replace(/\[[^\]]*(?:read more|lire la suite|continue reading)[^\]]*\]/gi, '');
  s = s.replace(/\b(?:read more|lire la suite|continue reading)\b\.?\s*$/i, '');
  const byline = extractBylineFromText(s);
  if (byline.body.length >= SUBSTANTIVE_MIN) s = byline.body;
  return s.replace(/\s+/g, ' ').trim();
}

function truncateLeadExcerpt(text = '', max = LEAD_EXCERPT_MAX) {
  let s = normalizeLeadParagraph(text);
  if (!s) return '';
  if (s.length <= max) return s;

  let cut = s.slice(0, max);
  const sentenceEnd = s.slice(max).search(/[.!?»"')\]](?:\s|$)/);
  if (sentenceEnd >= 0 && sentenceEnd < 140) {
    cut = s.slice(0, max + sentenceEnd + 1);
  } else {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > max * 0.55) cut = cut.slice(0, lastSpace);
  }
  return cut.replace(/[,;:\s]+$/u, '').trimEnd();
}

/**
 * Premier paragraphe substantiel du corps d'article (HTML fragment).
 * Ignore les bylines seules et les crédits photo ; fusionne le 2e si le 1er est court.
 */
function leadParagraphFromHtml(html = '') {
  const paragraphs = paragraphsFromHtml(html);
  const substantive = [];

  for (const p of paragraphs) {
    if (isJunkParagraph(p)) continue;
    const normalized = normalizeLeadParagraph(p);
    if (!normalized) continue;
    substantive.push(normalized);
    if (substantive.join(' ').length >= SUBSTANTIVE_MIN) break;
    if (substantive.length >= 2) break;
  }

  if (!substantive.length) {
    const fallback = normalizeLeadParagraph(stripHtml(html));
    return fallback.length >= LEAD_EXCERPT_MIN ? truncateLeadExcerpt(fallback) : '';
  }

  return truncateLeadExcerpt(substantive.join(' '));
}

function excerptLooksIncomplete(item = {}) {
  const existing = String(item.leadExcerpt || '').trim();
  if (existing.length >= 200 && endsCompleteSentence(existing)) return false;

  const ex = stripTruncationArtifacts(stripHtml(String(item.excerpt || '')));
  if (!ex) return true;
  if (TRUNC_MARKERS_RE.test(String(item.excerpt || ''))) return true;
  if (!endsCompleteSentence(ex) && ex.length >= 120) return true;

  const { body } = extractBylineFromText(ex);
  const text = body || ex;
  if (text.length < 200) return true;
  return false;
}

function isLeadExcerptCandidate(item, index = 0) {
  if (!item?.link) return false;
  if (item.featured) return true;
  return index < 45;
}

function needsLeadExcerptEnrichment(item, index = 0) {
  if (!isLeadExcerptCandidate(item, index)) return false;
  return excerptLooksIncomplete(item);
}

async function fetchLeadExcerpt(item) {
  if (!item?.link) return null;
  const html = await fetchText(item.link);
  if (!html || html.length < 200) return null;
  const body = articleBodyHtml(html);
  const lead = leadParagraphFromHtml(body);
  return lead.length >= LEAD_EXCERPT_MIN ? lead : null;
}

function selectEnrichmentCandidates(items = [], limit = 35) {
  const queue = [];
  const seen = new Set();

  items.forEach((item, index) => {
    if (!needsLeadExcerptEnrichment(item, index)) return;
    const key = item.link;
    if (!key || seen.has(key)) return;
    seen.add(key);
    queue.push({ item, index });
  });

  queue.sort((a, b) => {
    const fa = a.item.featured ? 1 : 0;
    const fb = b.item.featured ? 1 : 0;
    if (fb !== fa) return fb - fa;
    return a.index - b.index;
  });

  return queue.slice(0, limit).map((e) => e.item);
}

module.exports = {
  LEAD_EXCERPT_MAX,
  LEAD_EXCERPT_MIN,
  fetchText,
  articleBodyHtml,
  leadParagraphFromHtml,
  excerptLooksIncomplete,
  isLeadExcerptCandidate,
  needsLeadExcerptEnrichment,
  fetchLeadExcerpt,
  selectEnrichmentCandidates,
  endsCompleteSentence,
};