/**
 * Agrégation Firestore REST (sites SPA sans flux RSS — ex. Le Polyscope).
 *
 * fetchMode: "firebase" dans news-sources.json + bloc firebase { projectId, apiKey, ... }
 */

const https = require('https');

const DAY = 86400000;
const OK_DAYS = 270;
const STALE_DAYS = 540;
const DEAD_DAYS = 730;
const DEFAULT_TIMEOUT = 15000;

function isFirebaseSource(src = {}) {
  return src.fetchMode === 'firebase' && src.firebase?.projectId && src.firebase?.apiKey;
}

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

function stripHtml(text = '') {
  return decodeEntities(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firestoreValue(field = {}) {
  if (field.stringValue != null) return field.stringValue;
  if (field.integerValue != null) return parseInt(field.integerValue, 10);
  if (field.doubleValue != null) return field.doubleValue;
  if (field.booleanValue != null) return field.booleanValue;
  if (field.timestampValue != null) return field.timestampValue;
  if (field.nullValue != null) return null;
  return '';
}

function slugifyTitle(title = '') {
  return String(title)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[·']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function siteBase(src = {}) {
  const raw = String(src.site || src.url || '').trim();
  return raw.replace(/\/$/, '');
}

function articleLink(src = {}, { uid = '', title = '' } = {}) {
  const base = siteBase(src);
  const tpl = src.firebase?.linkTemplate || '/blog/post/{uid}';
  const slug = slugifyTitle(title);
  return `${base}${tpl.replace('{uid}', uid).replace('{slug}', slug)}`;
}

function extractAuthor(fields = {}) {
  const map = fields.author?.mapValue?.fields;
  if (map?.displayName?.stringValue) return stripHtml(map.displayName.stringValue);
  if (map?.name?.stringValue) return stripHtml(map.name.stringValue);
  if (fields.authorName?.stringValue) return stripHtml(fields.authorName.stringValue);
  return '';
}

function parseFirestoreDocument(doc = {}, src = {}) {
  const fields = doc.fields || {};
  const uid = firestoreValue(fields.UID) || (doc.name || '').split('/').pop() || '';
  const title = stripHtml(firestoreValue(fields.title));
  if (!title || !uid) return null;

  const publishField = src.firebase?.publishField || 'publish';
  const published = firestoreValue(fields[publishField]);
  if (published === false) return null;

  const dateField = src.firebase?.dateField || 'publishedDate';
  const rawDate = firestoreValue(fields[dateField]);
  let date = null;
  if (typeof rawDate === 'number' && rawDate > 1e11) {
    date = new Date(rawDate).toISOString();
  } else if (typeof rawDate === 'string' && rawDate) {
    const d = Date.parse(rawDate);
    if (!isNaN(d)) date = new Date(d).toISOString();
  }

  const excerpt = stripHtml(firestoreValue(fields.description) || '');
  const image = String(firestoreValue(fields.cover) || firestoreValue(fields.image) || '').trim();
  const author = extractAuthor(fields);

  return {
    title,
    link: articleLink(src, { uid, title }),
    author,
    date,
    excerpt,
    image,
  };
}

function postJson(url, body, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'Mozilla/5.0 (compatible; LE-RADAR-NewsBot/1.0)',
        },
        timeout,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) return resolve(null);
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function runFirestoreQuery(src = {}, { limit = 25 } = {}) {
  const fb = src.firebase || {};
  const projectId = fb.projectId;
  const apiKey = fb.apiKey;
  const collection = fb.collection || 'blogs';
  const dateField = fb.dateField || 'publishedDate';
  if (!projectId || !apiKey) return [];

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${encodeURIComponent(apiKey)}`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      orderBy: [{ field: { fieldPath: dateField }, direction: 'DESCENDING' }],
      limit,
    },
  };

  const rows = await postJson(url, body);
  if (!Array.isArray(rows)) return [];

  const items = [];
  for (const row of rows) {
    if (!row.document) continue;
    const item = parseFirestoreDocument(row.document, src);
    if (item) items.push(item);
  }
  return items;
}

async function fetchFirebaseFeed(src = {}, options = {}) {
  const maxItems = options.maxItems || 20;
  const items = await runFirestoreQuery(src, { limit: Math.max(maxItems * 2, 30) });
  return items.slice(0, maxItems);
}

function classifyFirebaseItems(items = []) {
  if (!items.length) return { status: 'dead', lastItemDate: null };

  const dates = items.map((i) => i.date).filter(Boolean).map((d) => Date.parse(d));
  if (!dates.length) return { status: 'stale', lastItemDate: null };

  const last = Math.max(...dates);
  const ageDays = (Date.now() - last) / DAY;
  let status = 'ok';
  if (ageDays > DEAD_DAYS) status = 'dead';
  else if (ageDays > STALE_DAYS) status = 'stale';
  else if (ageDays > OK_DAYS) status = 'stale';

  return { status, lastItemDate: new Date(last).toISOString() };
}

async function classifyFirebaseSource(src = {}) {
  const items = await fetchFirebaseFeed(src, { maxItems: 12 });
  return { ...classifyFirebaseItems(items), count: items.length };
}

module.exports = {
  isFirebaseSource,
  slugifyTitle,
  articleLink,
  fetchFirebaseFeed,
  classifyFirebaseItems,
  classifyFirebaseSource,
  runFirestoreQuery,
};