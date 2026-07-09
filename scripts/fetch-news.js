#!/usr/bin/env node
/**
 * LE RADAR News Aggregator
 *
 * Builds news.json from the RSS feeds of Québec student newspapers
 * (universités + cégeps). Runs at build time (GitHub Actions) so the
 * static site never has to deal with CORS — it just reads news.json.
 *
 * No external dependencies: plain https + a small RSS parser.
 *
 * Usage:
 *   node scripts/fetch-news.js          # dry run, prints summary
 *   node scripts/fetch-news.js --update # writes news.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { fork } = require('child_process');
const {
  reconcileAuthor,
  authorFromArticleHtml,
  detectFeedDefaultAuthors,
  isEditorialPlaceholder,
  needsPageAuthorVerification,
  normalizeArticleUrl,
  normalizeAuthor,
  expandAuthorName,
  extractBylineFromText,
  authorFromBodyCredits,
} = require('./author-lib');
const { mergePriorEnrichment } = require('./article-photo-credit-lib');
const {
  articleBodyHtml,
  imageFromArticleHtml,
  isCandidateImageUrl,
  isWeakImageUrl,
  needsImageEnrichment,
  imageRejectPatternsFromHints,
  imageOptionsFromHints,
  unwrapCdnImageUrl,
} = require('./article-image-lib');
const { isHtmlListSource, parseHtmlListPage } = require('./html-list-fetcher');
const { isFirebaseSource, fetchFirebaseFeed } = require('./firebase-list-fetcher');
const { isAllowedFetchUrl } = require('./url-security-lib');
const {
  groupItemsBySource,
  markRetainedArticles,
  retainablePriorArticles,
  readRegistry,
  writeRegistry,
  applyFetchRegistryUpdate,
  buildSourceRunMeta,
  shouldDropSource,
  pruneToFreshWindow,
  getBotHints,
} = require('./source-retention-lib');

const NEWS_PATH = path.join(__dirname, '..', 'news.json');
const SOURCES_PATH = path.join(__dirname, '..', 'news-sources.json');

// Passes quotidiennes planifiées du bot d'actualités, en UTC — doit refléter
// les crons primaires de .github/workflows/update-news.yml
// (le filet horaire :20 n'est pas listé ici : hors créneau, updatedSlot = null
//  → l'UI affiche l'heure réelle de la passe de rattrapage).
const SCHEDULED_PASSES_UTC = [
  [1, 0], [9, 30], [11, 0], [14, 0], [16, 0], [17, 30], [20, 0], [23, 0],
];
// Le cron GitHub part souvent en retard (jamais en avance) ; au-delà de cette
// marge, la passe est considérée hors horaire (filet :20, manuel, etc.).
const SCHEDULE_TOLERANCE_MS = 75 * 60 * 1000;

/** ISO de la passe planifiée correspondant à cette exécution, ou null si hors horaire. */
function scheduledSlotFor(now = new Date()) {
  let best = null;
  for (const dayOffset of [0, -1]) {
    for (const [h, m] of SCHEDULED_PASSES_UTC) {
      const slot = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, h, m,
      ));
      if (slot <= now && (!best || slot > best)) best = slot;
    }
  }
  if (!best || now - best > SCHEDULE_TOLERANCE_MS) return null;
  return best.toISOString();
}
const TIMEOUT = 15000;
const ENRICH_TIMEOUT = 12000;
const MAX_PER_SOURCE = 20;  // archive par journal (certains flux RSS en ont 18+)
const MAX_WP_FEATURED = 8;  // vedettes WordPress (catégorie slider, etc.)
const WP_FEATURED_SLUGS = ['slider', 'a-la-une', 'featured'];
const MAX_ENRICH = 45;      // cap article-page fetches per run
const MAX_AUTHOR_PAGES = 80; // vérification auteurs page (séparé de l'enrichissement)

const GENERIC_AUTHORS = /^(admin|administrator|administrateur|editor|éditeur|editeur|rédaction|redaction|staff|wordpress|webmaster|collectif|le collectif|tribune|link|daily|coordinating|exemplaire|quartier libre|zone campus|la pige|le délit|le delit|the link|the concordian|the tribune|the mcgill daily|the campus|the plant|theplantnews)$/i;

// Active feeds come from the registry (news-sources.json), maintained by
// scripts/discover-news-sources.js. Feeds flagged "_status": "dead" are skipped.
function loadSources() {
  try {
    const registry = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
    return (registry.active || []).filter((s) => s.url && s._status !== 'dead');
  } catch (e) {
    console.error('Could not read news-sources.json:', e.message);
    return [];
  }
}

const SOURCES = loadSources();

// === Tiny HTTP fetch =========================================================
const MAX_FETCH_BYTES = 2_500_000;
/** Plafond wall-clock par source (RSS) — kill process enfant si bloqué (CPU/réseau). */
const SOURCE_BUDGET_MS = 45_000;
const SOURCE_WORKER = path.join(__dirname, 'fetch-source-worker.js');

/**
 * Fetch d'une source dans un process isolé (SIGKILL au budget).
 * Garantit qu'un parse regex qui fige l'event loop ne bloque pas le bot CI.
 */
function fetchSourceIsolated(src, referenceDate) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(v);
    };
    let child;
    try {
      child = fork(SOURCE_WORKER, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: process.env,
      });
    } catch (e) {
      return finish({ ok: false, items: [], note: '', timedOut: false, error: String(e.message || e) });
    }
    const timer = setTimeout(() => {
      finish({ ok: false, items: [], note: '', timedOut: true, error: 'source_timeout' });
    }, SOURCE_BUDGET_MS);
    child.on('message', (msg) => {
      clearTimeout(timer);
      finish({
        ok: !!(msg && msg.ok),
        items: (msg && msg.items) || [],
        note: (msg && msg.note) || '',
        timedOut: false,
        error: (msg && msg.error) || null,
      });
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish({ ok: false, items: [], note: '', timedOut: false, error: 'worker_error' });
    });
    child.on('exit', () => {
      clearTimeout(timer);
      if (!settled) {
        finish({ ok: false, items: [], note: '', timedOut: false, error: 'worker_exit' });
      }
    });
    child.send({
      source: src,
      referenceDateISO: referenceDate.toISOString(),
    });
  });
}

function fetchText(url, redirects = 3, timeout = TIMEOUT) {
  if (!isAllowedFetchUrl(url)) {
    console.warn('fetch-news: URL bloquée (sécurité):', url);
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let req;
    try {
      req = https.get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; REQ-NewsBot/1.0)',
            Accept: 'application/rss+xml, application/xml, text/xml, text/html, */*',
          },
          timeout,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            return done(fetchText(next, redirects - 1, timeout));
          }
          if (res.statusCode >= 400) {
            res.resume();
            return done('');
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            data += c;
            if (data.length > MAX_FETCH_BYTES) {
              try { req.destroy(); } catch { /* ignore */ }
              done(data);
            }
          });
          res.on('end', () => done(data));
          res.on('error', () => done(''));
        },
      );
    } catch {
      return done('');
    }
    req.on('error', () => done(''));
    req.on('timeout', () => {
      try { req.destroy(); } catch { /* ignore */ }
      done('');
    });
    // Deadline absolue : le timeout Node ne coupe pas une réponse qui « goutte ».
    setTimeout(() => {
      try { req.destroy(); } catch { /* ignore */ }
      done('');
    }, timeout + 1500);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const t = setTimeout(() => finish(fallback), ms);
    Promise.resolve(promise)
      .then((v) => {
        clearTimeout(t);
        finish(v);
      })
      .catch(() => {
        clearTimeout(t);
        finish(fallback);
      });
  });
}

const { decodeEntities, stripHtml } = require('./html-entities-lib');

// === Minimal RSS / Atom parsing ==============================================

const TRUNC_MARKERS_RE = /(?:…|\.{3,}|\[…\]|\[\.\.\.\]|\[&hellip;\])/gi;

function stripTruncationArtifacts(text = '') {
  return String(text)
    .replace(TRUNC_MARKERS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateExcerpt(text = '', max = 280) {
  let s = stripTruncationArtifacts(stripHtml(text));
  if (!s) return '';

  if (s.length <= max) return s;

  const ahead = s.slice(max, max + 140);
  const sentenceEnd = ahead.search(/[.!?»"')\]](?:\s|$)/);
  if (sentenceEnd >= 0 && sentenceEnd < 120) {
    return s.slice(0, max + sentenceEnd + 1).replace(/\s+/g, ' ').trim();
  }

  let cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.55) cut = cut.slice(0, lastSpace);
  return cut.replace(/[,;:\s]+$/u, '').trimEnd();
}

/**
 * Rubriques Montréal Campus collées au titre (souvent après une fuite CSS).
 * On les GARDE sous la forme « Rubrique : titre », on ne les jette plus
 * (ex. « Marché aux puces : Incursion chez un bastion… »).
 */
const MC_SERIES_LABEL = /^(Photoreportage|Marché aux puces|Cobaye|Reportage photo)(?:\s*[:：–—-]\s*|\s+)(.+)$/iu;

function stripEmbeddedCss(title = '') {
  let t = String(title).trim();
  if (!/^\.[\w-]+\s*\{/.test(t) && !/@media/i.test(t)) return t;
  const start = t.indexOf('{');
  if (start === -1) return t;
  let depth = 0;
  for (let i = start; i < t.length; i += 1) {
    if (t[i] === '{') depth += 1;
    else if (t[i] === '}') {
      depth -= 1;
      if (depth === 0) return t.slice(i + 1).trim();
    }
  }
  return t;
}

/** Retire puces / symboles en tête, mais garde chiffres et lettres (« 14 bourses… »). */
function stripLeadingNonLetters(title = '') {
  return String(title).replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

/** « pucesIncursion » / « pucesIncursion » après CSS → espace avant majuscule. */
function fixCamelGlue(title = '') {
  return String(title).replace(
    /([\p{Ll}éèêëàâäùûüôöîïç])([\p{Lu}ÀÂÄÉÈÊËÎÏÔÖÙÛÜ])/gu,
    '$1 $2',
  );
}

function sanitizeTitle(title = '') {
  let t = stripHtml(stripEmbeddedCss(title));
  t = fixCamelGlue(t).replace(/\s+/g, ' ').trim();
  // Retirer le suffixe « - Montréal Campus » des og:title
  t = t.replace(/\s*[–—|-]\s*Montréal\s+Campus\s*$/i, '').trim();
  const series = t.match(MC_SERIES_LABEL);
  if (series) {
    const label = series[1].trim();
    const rest = series[2].trim();
    if (rest) return stripLeadingNonLetters(`${label} : ${rest}`);
  }
  return stripLeadingNonLetters(t);
}

function tag(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = block.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, 'i'));
  return m ? decodeEntities(m[1].trim()) : '';
}

function isGenericAuthor(name = '', lang = 'fr') {
  const n = String(name).replace(/\s+/g, ' ').trim();
  if (!n || n.length < 2) return true;
  if (isEditorialPlaceholder(n, lang)) return true;
  if (GENERIC_AUTHORS.test(n)) return true;
  if (/@/.test(n)) return true;
  return false;
}

function isJunkExcerpt(text = '') {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t || t.length < 24) return true;
  if (/^\[?\s*(?:read more|lire la suite|continue reading)/i.test(t)) return true;
  if (/^L['’]article\b/i.test(t) && t.length < 80) return true;
  return false;
}

function firstParagraphFromHtml(html = '') {
  const decoded = decodeEntities(html);
  const paragraphs = decoded.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  for (const p of paragraphs) {
    const text = stripHtml(p);
    if (text.length < 40) continue;
    if (/^(?:Par|By)\s+[\p{Lu}]/u.test(text) && text.length < 80) continue;
    if (/^(?:Photo|Crédit|Credit)\s*:/i.test(text)) continue;
    return text;
  }
  const fallback = stripHtml(decoded);
  return fallback.length >= 40 ? fallback : '';
}

function pickExcerpt(block) {
  const description = tag(block, 'description');
  const content = tag(block, 'content:encoded') || tag(block, 'content') || tag(block, 'summary');

  const descText = stripHtml(description);
  const contentLead = firstParagraphFromHtml(content) || stripHtml(content);

  let excerpt = '';
  if (!isJunkExcerpt(descText)) excerpt = descText;
  if (isJunkExcerpt(excerpt) || (contentLead.length > excerpt.length + 30)) {
    if (!isJunkExcerpt(contentLead)) excerpt = contentLead;
  }
  if (!excerpt && descText) excerpt = descText;

  excerpt = excerpt
    .replace(/\s*L['’]article\b[\s\S]*?est apparu en premier sur[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return truncateExcerpt(excerpt, 280);
}

function authorKeyLoose(name = '') {
  return String(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseAuthor(block, contentHtml = '', excerpt = '', feedTitle = '') {
  // Tête de contenu seulement — le HTML complet de content:encoded fait
  // pathologuer certaines regex d'auteur (hang CI sur McGill Daily, etc.).
  const contentHead = String(contentHtml || '').slice(0, 12_000);

  const fromExcerpt = extractBylineFromText(excerpt);
  if (fromExcerpt.author) return fromExcerpt.author;

  const fromContent = extractBylineFromText(firstParagraphFromHtml(contentHead));
  if (fromContent.author) return fromContent.author;

  const fromDesc = extractBylineFromText(stripHtml(tag(block, 'description')));
  if (fromDesc.author) return fromDesc.author;

  let a = tag(block, 'dc:creator') || tag(block, 'creator') || tag(block, 'author');
  if (a && /<name[\s>]/i.test(a)) a = tag(a, 'name');
  a = expandAuthorName(a);

  // dc:creator = compte de la publication (Substack signe tous les billets
  // du nom du journal) : chercher un crédit de production dans le corps
  // (« Produced by X », « Hosted by X »…).
  if (!a || (feedTitle && authorKeyLoose(a) === authorKeyLoose(feedTitle))) {
    const credit = authorFromBodyCredits(contentHead);
    if (credit) return credit;
  }
  return a || '';
}

function firstImage(block) {
  // Chercher l'image dans un préfixe : le match /img/ sur un item entier
  // avec content:encoded massif est inutilement coûteux.
  const head = String(block || '').slice(0, 40_000);
  const candidates = [];
  let m = head.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i);
  if (m) candidates.push(m[1]);
  m = head.match(/<enclosure[^>]*url=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i);
  if (m) candidates.push(m[1]);
  m = head.match(/<img[^>]*src=["']([^"']+)["']/i);
  if (m) candidates.push(decodeEntities(m[1]));
  for (const raw of candidates) {
    if (!raw) continue;
    const unwrapped = unwrapCdnImageUrl(raw) || raw;
    // Préférer l'original S3 Substack au CDN redimensionné.
    if (unwrapped && isCandidateImageUrl(unwrapped) && !isWeakImageUrl(unwrapped)) return unwrapped;
    if (isCandidateImageUrl(raw) && !isWeakImageUrl(raw)) return raw;
  }
  return '';
}

function isFeedXml(xml = '') {
  return /<rss[\s>]|<feed[\s>]/i.test(String(xml).slice(0, 600));
}

function parseFeed(xml) {
  const items = [];
  // Match non-greedy item blocks ; éviter un scan catastrophique sur XML monstrueux
  const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi)
    || String(xml || '').match(/<entry\b[\s\S]*?<\/entry>/gi)
    || [];
  // Le premier <title> du document est celui du canal ; l'image de canal est
  // le logo de la publication (Substack la répète en <enclosure> des billets
  // sans couverture propre).
  const channelHead = String(xml || '').slice(0, 8_000);
  const channelTitle = sanitizeTitle(tag(channelHead, 'title'));
  const channelImage = (channelHead.match(/<image>[\s\S]{0,600}?<url>\s*([^<\s]+)\s*<\/url>/i) || [])[1] || '';
  for (const rawBlock of blocks) {
    // Tronquer chaque item : content:encoded WP peut dépasser 100 ko
    const block = rawBlock.length > 80_000 ? rawBlock.slice(0, 80_000) : rawBlock;
    const title = sanitizeTitle(tag(block, 'title'));
    let link = stripHtml(tag(block, 'link'));
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    const dateRaw = tag(block, 'pubDate') || tag(block, 'dc:date') || tag(block, 'published') || tag(block, 'updated');
    const date = dateRaw ? new Date(dateRaw) : null;
    // content:encoded : tête seulement pour byline/image
    const contentFull = tag(block, 'content:encoded') || tag(block, 'content') || '';
    const contentHtml = contentFull.slice(0, 16_000);
    const excerpt = pickExcerpt(block);
    const author = parseAuthor(block, contentHtml, excerpt, channelTitle);
    let image = firstImage(contentHtml || tag(block, 'description') || block) || firstImage(block);
    if (image && channelImage && image === channelImage) image = '';

    if (title && link) {
      items.push({ title, link, author, date: date && !isNaN(date) ? date.toISOString() : null, excerpt, image });
    }
  }

  // La même image sur plusieurs billets du flux = visuel générique (logo,
  // bannière de rubrique, avatar) — pas une photo d'article.
  const imageUses = new Map();
  for (const it of items) {
    if (it.image) imageUses.set(it.image, (imageUses.get(it.image) || 0) + 1);
  }
  for (const it of items) {
    if (it.image && imageUses.get(it.image) >= 2) it.image = '';
  }

  return items;
}

// === WordPress REST API (vedettes absentes du haut du flux RSS) ================
function wpApiBase(feedUrl = '') {
  try {
    const u = new URL(feedUrl);
    return `${u.protocol}//${u.host}/wp-json/wp/v2`;
  } catch {
    return null;
  }
}

function parseJson(text = '') {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function resolveWpCategoryId(base, ref) {
  if (Number.isInteger(ref)) return ref;
  const slug = String(ref || '').trim();
  if (!slug) return null;
  const cats = parseJson(await fetchText(`${base}/categories?slug=${encodeURIComponent(slug)}`));
  return Array.isArray(cats) && cats[0]?.id ? cats[0].id : null;
}

function wpPostToItem(post) {
  const title = sanitizeTitle(post.title?.rendered || '');
  const link = post.link || '';
  const date = post.date ? new Date(post.date) : null;
  const excerpt = truncateExcerpt(stripHtml(post.excerpt?.rendered || ''), 280);
  const embeddedAuthor = post._embedded?.author?.[0]?.name || '';
  const image = post.yoast_head_json?.og_image?.[0]?.url
    || post._embedded?.['wp:featuredmedia']?.[0]?.source_url
    || '';
  if (!title || !link) return null;
  return {
    title,
    link,
    author: normalizeAuthor(embeddedAuthor),
    date: date && !isNaN(date) ? date.toISOString() : null,
    excerpt,
    image,
    featured: true,
  };
}

async function fetchWpFeaturedPosts(feedUrl, src, referenceDate = new Date()) {
  const base = wpApiBase(feedUrl);
  if (!base || !src.wpFeaturedCategories?.length) return [];

  const refs = src.wpFeaturedCategories;

  const posts = [];
  const seenIds = new Set();

  for (const ref of refs) {
    const catId = await resolveWpCategoryId(base, ref);
    if (!catId) continue;
    const batch = parseJson(
      await fetchText(`${base}/posts?categories=${catId}&per_page=${MAX_WP_FEATURED}&_embed`),
    );
    if (!Array.isArray(batch)) continue;
    for (const post of batch) {
      if (!post?.id || seenIds.has(post.id)) continue;
      seenIds.add(post.id);
      posts.push(post);
    }
    if (posts.length) break;
  }

  return pruneToFreshWindow(
    posts.map(wpPostToItem).filter(Boolean),
    referenceDate,
  );
}

function sourceMaxItems(src = {}) {
  const n = Number(src.maxItems);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : MAX_PER_SOURCE;
}

function mergeSourceItems(rssItems, featuredItems, maxItems = MAX_PER_SOURCE) {
  const seen = new Set();
  const merged = [];
  const add = (item) => {
    const key = item.link;
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  };
  for (const item of featuredItems) add(item);
  for (const item of rssItems) add(item);
  return merged.slice(0, maxItems);
}

/** Billets newsletter / promo (ex. Substack The Concordian) à ignorer. */
function shouldDropFeedItem(item = {}, src = {}) {
  const patterns = getBotHints(src, 'fetch').dropTitlePatterns;
  if (!Array.isArray(patterns) || !patterns.length) return false;
  const title = String(item.title || '').toLowerCase();
  return patterns.some((p) => p && title.includes(String(p).toLowerCase()));
}

function filterFeedItems(items = [], src = {}) {
  return items.filter((it) => !shouldDropFeedItem(it, src));
}

/** RSS principal, ou fusion de plusieurs flux (ex. catégories WordPress disjointes). */
async function fetchRssItems(src = {}) {
  const feedUrls = [src.url, src.urlFallback, ...(src.feedAlternates || [])].filter(Boolean);
  const uniqueUrls = [...new Set(feedUrls)];
  const maxItems = sourceMaxItems(src);

  if (!src.mergeFeedAlternates || uniqueUrls.length <= 1) {
    let xml = '';
    let feedUsed = '';
    for (const feedUrl of uniqueUrls) {
      xml = await fetchText(feedUrl);
      if (xml && isFeedXml(xml)) {
        feedUsed = feedUrl;
        break;
      }
      xml = '';
    }
    if (!xml) return { items: [], feedUsed: '', maxItems };
    return {
      items: filterFeedItems(parseFeed(xml), src).slice(0, maxItems),
      feedUsed,
      maxItems,
    };
  }

  const merged = [];
  const seen = new Set();
  let feedsOk = 0;
  for (const feedUrl of uniqueUrls) {
    const xml = await fetchText(feedUrl);
    if (!xml || !isFeedXml(xml)) continue;
    feedsOk += 1;
    for (const item of filterFeedItems(parseFeed(xml), src)) {
      if (!item.link || seen.has(item.link)) continue;
      seen.add(item.link);
      merged.push(item);
    }
  }

  merged.sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : 0;
    const db = b.date ? Date.parse(b.date) : 0;
    return db - da;
  });

  const feedUsed = feedsOk > 1 ? `${feedsOk} feeds` : (uniqueUrls[0] || '');
  return { items: merged.slice(0, maxItems), feedUsed, maxItems };
}

// === Article-page enrichment (missing author / thin excerpt) ===================
function metaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${key}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]).trim();
  }
  return '';
}

function needsEnrichment(item, feedDefaults = new Map(), sourceByName = new Map()) {
  const thinExcerpt = !item.excerpt || isJunkExcerpt(item.excerpt);
  const authorHints = getBotHints(sourceByName.get(item.source), 'authors');
  const missingAuthor = !item.author || isGenericAuthor(item.author);
  const needsAuthorPage = needsPageAuthorVerification(item, feedDefaults, authorHints);
  return thinExcerpt || missingAuthor || needsImageEnrichment(item) || needsAuthorPage;
}

async function enrichItem(item, sourceByName = new Map()) {
  const html = await fetchText(item.link, 3, ENRICH_TIMEOUT);
  if (!html || html.length < 200) return item;
  // HTML tronqué pour parsers regex (évite hangs pathologiques WP)
  const slim = html.length > 450_000 ? html.slice(0, 450_000) : html;

  const src = sourceByName.get(item.source);
  const imageHints = getBotHints(src, 'images');
  const authorHints = getBotHints(src, 'authors');
  const rejectPatterns = imageRejectPatternsFromHints(imageHints);
  const imageOptions = imageOptionsFromHints(imageHints);

  const next = { ...item };
  const body = articleBodyHtml(slim);

  if (needsImageEnrichment(next, rejectPatterns, imageOptions)) {
    const found = await withTimeout(
      Promise.resolve().then(() => imageFromArticleHtml(slim, rejectPatterns, imageOptions)),
      2000,
      null,
    );
    if (found?.url && isCandidateImageUrl(found.url, rejectPatterns)) next.image = found.url;
    else if (next.image && !isCandidateImageUrl(next.image, rejectPatterns)) next.image = '';
  } else if (next.image) {
    const found = await withTimeout(
      Promise.resolve().then(() => imageFromArticleHtml(slim, rejectPatterns, imageOptions)),
      2000,
      null,
    );
    if (!found?.url && next.image) next.image = '';
    else if (next.image && !isCandidateImageUrl(next.image, rejectPatterns)) next.image = '';
  }

  const pageAuthor = await withTimeout(
    Promise.resolve().then(() => authorFromArticleHtml(
      slim,
      item.lang === 'en' ? 'en' : 'fr',
      authorHints,
      item.source,
    )),
    2500,
    '',
  );
  if (pageAuthor) {
    next._pageAuthor = pageAuthor;
  } else if (!next.author || isGenericAuthor(next.author)) {
    const fromBody = extractBylineFromText(firstParagraphFromHtml(body));
    if (fromBody.author) next._pageAuthor = fromBody.author;
  }

  // Titre page : préférer h1 nettoyé (séries MC + fuite CSS) puis og:title.
  const h1Raw = (() => {
    const m = slim.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    return m ? stripHtml(m[1]) : '';
  })();
  const pageTitle = sanitizeTitle(h1Raw)
    || sanitizeTitle(metaContent(slim, 'og:title') || metaContent(slim, 'twitter:title'));
  if (pageTitle) {
    const current = String(next.title || '').trim();
    const needsUpgrade = !current
      || current.length < 12
      || /\.[a-z][\w-]*\s*\{/.test(current)
      || pageTitle.length > current.length + 8
      || (/^Marché aux puces\b/i.test(pageTitle) && !/^Marché aux puces\b/i.test(current));
    if (needsUpgrade) next.title = pageTitle;
  }

  if (!next.excerpt || isJunkExcerpt(next.excerpt)) {
    const candidates = [
      metaContent(slim, 'og:description'),
      metaContent(slim, 'description'),
      metaContent(slim, 'twitter:description'),
      firstParagraphFromHtml(body),
    ].map((s) => stripHtml(s)).filter((s) => !isJunkExcerpt(s));

    if (candidates.length) {
      let excerpt = candidates[0];
      const byline = extractBylineFromText(excerpt);
      if (byline.author && (!next.author || isGenericAuthor(next.author))) next.author = byline.author;
      if (byline.body.length >= 24) excerpt = byline.body;
      next.excerpt = truncateExcerpt(excerpt, 280);
    }
  }

  return next;
}

async function enrichItems(items, feedDefaults = new Map(), sourceByName = new Map()) {
  const queue = [
    ...items.filter(needsImageEnrichment),
    ...items.filter(
      (item) => needsEnrichment(item, feedDefaults, sourceByName) && !needsImageEnrichment(item),
    ),
  ];
  const seen = new Set();
  let enriched = 0;
  let imagesAdded = 0;

  for (const item of queue) {
    if (enriched >= MAX_ENRICH) break;
    if (!item.link || seen.has(item.link)) continue;
    seen.add(item.link);

    const hints = getBotHints(sourceByName.get(item.source), 'images');
    const reject = imageRejectPatternsFromHints(hints);
    const opts = imageOptionsFromHints(hints);
    const hadImage = item.image && isCandidateImageUrl(item.image, reject) && !isWeakImageUrl(item.image, opts);
    const updated = await enrichItem(item, sourceByName);
    Object.assign(item, updated);
    enriched += 1;

    const hasImage = item.image && isCandidateImageUrl(item.image, reject) && !isWeakImageUrl(item.image, opts);
    if (!hadImage && hasImage) imagesAdded += 1;

    await sleep(250);
  }

  if (enriched) {
    console.log(`↻ Enriched ${enriched} articles from source pages (${imagesAdded} images)`);
  }
  return items;
}

function authorPagePriority(item = {}, sourceByName = new Map()) {
  const hints = getBotHints(sourceByName.get(item.source), 'authors');
  return hints.forcePageAuthor ? 0 : 1;
}

async function fetchPageAuthors(items, feedDefaults, existing = new Map(), sourceByName = new Map()) {
  const pageAuthors = new Map(existing);
  const toFetch = items
    .filter(
      (item) => {
        const hints = getBotHints(sourceByName.get(item.source), 'authors');
        return needsPageAuthorVerification(item, feedDefaults, hints)
          && !pageAuthors.has(normalizeArticleUrl(item.link));
      },
    )
    .sort((a, b) => authorPagePriority(a, sourceByName) - authorPagePriority(b, sourceByName));

  let fetched = 0;
  for (const item of toFetch) {
    if (fetched >= MAX_AUTHOR_PAGES) break;
    const key = normalizeArticleUrl(item.link);
    if (!key || pageAuthors.has(key)) continue;

    const html = await fetchText(item.link, 3, ENRICH_TIMEOUT);
    const authorHints = getBotHints(sourceByName.get(item.source), 'authors');
    // authorFromArticleHtml peut pathologuer (regex) sur certains HTML WP —
    // plafonner pour ne pas bloquer le job CI 40 min.
    const author = await withTimeout(
      Promise.resolve().then(() => authorFromArticleHtml(
        html.length > 400_000 ? html.slice(0, 400_000) : html,
        item.lang === 'en' ? 'en' : 'fr',
        authorHints,
        item.source,
      )),
      2500,
      '',
    );
    if (author) pageAuthors.set(key, author);
    fetched += 1;
    await sleep(250);
  }

  if (fetched) {
    console.log(`↻ Auteurs vérifiés sur ${fetched} page(s) source (${pageAuthors.size} extrait(s))`);
  }
  return pageAuthors;
}

// === Main ====================================================================
async function main() {
  const doUpdate = process.argv.includes('--update');
  console.log('LE RADAR News Aggregator\n========================\n');

  if (!SOURCES.length) {
    console.error('No active sources in news-sources.json — aborting.');
    process.exit(1);
  }

  const all = [];
  const sourceRuns = {};
  const referenceDate = new Date();
  let priorByLink = new Map();
  let priorBySource = new Map();
  try {
    const prev = JSON.parse(fs.readFileSync(NEWS_PATH, 'utf8'));
    for (const item of prev.items || []) {
      const key = normalizeArticleUrl(item.link);
      if (key) priorByLink.set(key, item);
    }
    priorBySource = groupItemsBySource(prev.items || []);
  } catch {
    priorByLink = new Map();
    priorBySource = new Map();
  }

  const registry = readRegistry();
  const sourceByName = new Map(SOURCES.map((s) => [s.name, s]));

  for (const src of SOURCES) {
    process.stdout.write(`→ ${src.name} (${src.institution}) … `);
    let items = [];
    let fetchOk = false;
    let usedStaleCache = false;
    const priorForSource = priorBySource.get(src.name) || [];

    try {
      // Process isolé + SIGKILL : une source qui fige le CPU (regex) ou le
      // réseau ne peut plus bloquer le job Actions 40 minutes.
      const result = await fetchSourceIsolated(src, referenceDate);

      if (result.timedOut) {
        console.log(`⚠ timeout ${SOURCE_BUDGET_MS / 1000}s — source sautée (cache si dispo)`);
      } else if (result.error && !result.items.length) {
        console.log(`⚠ ${result.error}`);
      } else if (result.ok && result.items.length) {
        items = result.items.map((it) => ({
          ...it,
          title: sanitizeTitle(it.title),
          excerpt: truncateExcerpt(it.excerpt, 280),
        }));
        // Vedettes WP (Délit, etc.) — budget court séparé, non bloquant
        if (src.wpFeaturedCategories?.length) {
          try {
            const featuredItems = await withTimeout(
              fetchWpFeaturedPosts(src.url, src, referenceDate),
              20_000,
              [],
            );
            if (featuredItems.length) {
              items = mergeSourceItems(items, featuredItems, MAX_PER_SOURCE);
              result.note = `${result.note || ''} (+${featuredItems.length} vedettes WP)`;
            }
          } catch { /* ignore featured failures */ }
        }
        fetchOk = true;
        console.log(`✓ ${items.length} articles${result.note || ''}`);
      }
    } catch (err) {
      console.log(`⚠ erreur: ${(err && err.message) || err}`);
      items = [];
      fetchOk = false;
    }

    if (!items.length) {
      const retainable = retainablePriorArticles(priorForSource, referenceDate);
      if (retainable.length) {
        items = markRetainedArticles(retainable);
        usedStaleCache = true;
        console.log(`⚠ ${items.length} articles conservés (flux indisponible, cache frais)`);
      } else {
        const registryEntry = (registry.active || []).find((s) => s.name === src.name);
        if (shouldDropSource({
          sourceName: src.name,
          priorItems: priorForSource,
          registryEntry,
          referenceDate,
        })) {
          console.log('✗ no response (aucun article frais — source retirée)');
        } else {
          console.log('✗ no response');
        }
        applyFetchRegistryUpdate(
          (registry.active || []).find((s) => s.name === src.name),
          { fetchOk: false, usedStaleCache: false, items: [], referenceDate },
        );
        sourceRuns[src.name] = buildSourceRunMeta({
          sourceName: src.name,
          fetchOk: false,
          usedStaleCache: false,
          items: [],
          referenceDate,
        });
        continue;
      }
    }

    applyFetchRegistryUpdate(
      (registry.active || []).find((s) => s.name === src.name),
      { fetchOk, usedStaleCache, items, referenceDate },
    );
    sourceRuns[src.name] = buildSourceRunMeta({
      sourceName: src.name,
      fetchOk,
      usedStaleCache,
      items,
      referenceDate,
    });

    const authorHints = getBotHints(src, 'authors');
    for (const it of items) {
      all.push({
        source: src.name,
        institution: src.institution,
        region: src.region || '',
        type: src.type,
        lang: src.lang,
        ...it,
        author: authorHints.ignoreRssAuthor ? '' : it.author,
      });
    }
  }

  const feedDefaults = detectFeedDefaultAuthors(all);

  for (const item of all) {
    if (item._pageAuthor) {
      const key = normalizeArticleUrl(item.link);
      if (key) item._pageAuthorKey = key;
    }
  }

  await enrichItems(all, feedDefaults, sourceByName);

  const pageAuthors = new Map();
  for (const item of all) {
    if (item._pageAuthor && item._pageAuthorKey) {
      pageAuthors.set(item._pageAuthorKey, item._pageAuthor);
      delete item._pageAuthor;
      delete item._pageAuthorKey;
    }
  }
  await fetchPageAuthors(all, feedDefaults, pageAuthors, sourceByName);

  for (let i = 0; i < all.length; i += 1) {
    const pageAuthor = pageAuthors.get(normalizeArticleUrl(all[i].link)) || '';
    all[i] = reconcileAuthor(all[i], all, {
      applyFallback: true,
      feedDefaults,
      pageAuthor,
    }).item;
    const imgHints = getBotHints(sourceByName.get(all[i].source), 'images');
    const imgReject = imageRejectPatternsFromHints(imgHints);
    const imgOpts = imageOptionsFromHints(imgHints);
    if (all[i].image && (!isCandidateImageUrl(all[i].image, imgReject) || isWeakImageUrl(all[i].image, imgOpts))) {
      all[i].image = '';
    }
    const prior = priorByLink.get(normalizeArticleUrl(all[i].link));
    if (prior) all[i] = mergePriorEnrichment(all[i], prior);
  }

  all.sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : 0;
    const db = b.date ? Date.parse(b.date) : 0;
    return db - da;
  });

  const beforePrune = all.length;
  const prunedAll = pruneToFreshWindow(all, referenceDate);
  const prunedCount = beforePrune - prunedAll.length;
  if (prunedCount > 0) {
    console.log(`\nFraîcheur: ${prunedCount} article(s) hors fenêtre de sessions (A/H/É + grâce sept.) retiré(s)`);
  }

  const staleSources = Object.entries(sourceRuns)
    .filter(([, meta]) => meta.stale)
    .map(([name]) => name);

  const runDate = new Date();
  const news = {
    updated: runDate.toISOString(),
    // Heure de passe planifiée (update-news.yml) la plus proche : c'est elle
    // que le site affiche, pour que « mis à jour » colle à l'horaire annoncé
    // malgré les retards du cron GitHub Actions.
    updatedSlot: scheduledSlotFor(runDate),
    count: prunedAll.length,
    freshnessSessions: 3,
    sources: sourceRuns,
    items: prunedAll,
  };

  const withAuthor = news.items.filter((i) => i.author && !isGenericAuthor(i.author)).length;
  const withExcerpt = news.items.filter((i) => i.excerpt && !isJunkExcerpt(i.excerpt)).length;
  const withImage = news.items.filter(
    (i) => i.image && isCandidateImageUrl(i.image) && !isWeakImageUrl(i.image),
  ).length;
  const liveSources = new Set(news.items.map((i) => i.source)).size;
  console.log(`\nTotal: ${news.items.length} articles from ${liveSources} sources (${SOURCES.length} registered).`);
  if (staleSources.length) {
    console.log(`Cache: ${staleSources.length} source(s) served from prior run — ${staleSources.join(', ')}`);
  }
  console.log(
    `Authors: ${withAuthor}/${news.items.length} · Excerpts: ${withExcerpt}/${news.items.length} · Images: ${withImage}/${news.items.length}`,
  );

  if (doUpdate) {
    fs.writeFileSync(NEWS_PATH, JSON.stringify(news, null, 2) + '\n');
    registry._lastFetchRun = news.updated;
    writeRegistry(registry);
    console.log(`✅ Wrote ${NEWS_PATH}`);
    console.log(`✅ Updated ${SOURCES_PATH}`);
  } else {
    console.log('Dry-run complete. Use --update to write news.json.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});