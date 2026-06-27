#!/usr/bin/env node
/**
 * RADAR News Aggregator
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
const {
  reconcileAuthor,
  authorFromArticleHtml,
  detectFeedDefaultAuthors,
  isEditorialPlaceholder,
  needsPageAuthorVerification,
  normalizeArticleUrl,
  normalizeAuthor,
  extractBylineFromText,
} = require('./author-lib');
const { mergePriorEnrichment } = require('./article-photo-credit-lib');
const { isHtmlListSource, parseHtmlListPage } = require('./html-list-fetcher');
const { isFirebaseSource, fetchFirebaseFeed } = require('./firebase-list-fetcher');

const NEWS_PATH = path.join(__dirname, '..', 'news.json');
const SOURCES_PATH = path.join(__dirname, '..', 'news-sources.json');
const TIMEOUT = 15000;
const ENRICH_TIMEOUT = 12000;
const MAX_PER_SOURCE = 20;  // archive par journal (certains flux RSS en ont 18+)
const MAX_WP_FEATURED = 8;  // vedettes WordPress (catégorie slider, etc.)
const WP_FEATURED_SLUGS = ['slider', 'a-la-une', 'featured'];
const MAX_ENRICH = 45;      // cap article-page fetches per run

const GENERIC_AUTHORS = /^(admin|administrator|administrateur|editor|éditeur|editeur|rédaction|redaction|staff|wordpress|webmaster|collectif|le collectif|tribune|link|daily|exemplaire|quartier libre|zone campus|la pige|le délit|le delit|the link|the concordian|the tribune|the mcgill daily|the campus)$/i;

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
function fetchText(url, redirects = 3, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const req = https.get(
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
      }
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// === Minimal RSS / Atom parsing ==============================================
function decodeEntities(str = '') {
  return str
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

  let cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.55) cut = cut.slice(0, lastSpace);
  return cut.replace(/[,;:\s]+$/u, '').trimEnd();
}

const MC_CATEGORY_PREFIX = /^(?:Photoreportage|Marché aux puces|Cobaye|Incursion|Reportage|Opinion|Entrevue|Critique|Chronique)/;

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

function stripLeadingNonLetters(title = '') {
  return String(title).replace(/^[^\p{L}]+/u, '').trim();
}

function sanitizeTitle(title = '') {
  let t = stripHtml(stripEmbeddedCss(title));
  t = t.replace(/\s+/g, ' ').trim();
  const prefix = t.match(MC_CATEGORY_PREFIX);
  if (prefix) t = t.slice(prefix[0].length).trim();
  return stripLeadingNonLetters(t);
}

function tag(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = block.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, 'i'));
  return m ? m[1].trim() : '';
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

function parseAuthor(block, contentHtml = '', excerpt = '') {
  const fromExcerpt = extractBylineFromText(excerpt);
  if (fromExcerpt.author) return fromExcerpt.author;

  const fromContent = extractBylineFromText(firstParagraphFromHtml(contentHtml));
  if (fromContent.author) return fromContent.author;

  const fromDesc = extractBylineFromText(stripHtml(tag(block, 'description')));
  if (fromDesc.author) return fromDesc.author;

  let a = tag(block, 'dc:creator') || tag(block, 'creator') || tag(block, 'author');
  if (a && /<name[\s>]/i.test(a)) a = tag(a, 'name');
  a = normalizeAuthor(a);
  return a || '';
}

function firstImage(block) {
  const candidates = [];
  let m = block.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i);
  if (m) candidates.push(m[1]);
  m = block.match(/<enclosure[^>]*url=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i);
  if (m) candidates.push(m[1]);
  m = block.match(/<img[^>]*src=["']([^"']+)["']/i);
  if (m) candidates.push(decodeEntities(m[1]));
  for (const raw of candidates) {
    if (raw && isCandidateImageUrl(raw)) return raw;
  }
  return '';
}

function isFeedXml(xml = '') {
  return /<rss[\s>]|<feed[\s>]/i.test(String(xml).slice(0, 600));
}

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const title = sanitizeTitle(tag(block, 'title'));
    let link = stripHtml(tag(block, 'link'));
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    const dateRaw = tag(block, 'pubDate') || tag(block, 'dc:date') || tag(block, 'published') || tag(block, 'updated');
    const date = dateRaw ? new Date(dateRaw) : null;
    const contentHtml = tag(block, 'content:encoded') || tag(block, 'content') || '';
    const excerpt = pickExcerpt(block);
    const author = parseAuthor(block, contentHtml, excerpt);
    const image = firstImage(contentHtml || tag(block, 'description') || block) || firstImage(block);

    if (title && link) {
      items.push({ title, link, author, date: date && !isNaN(date) ? date.toISOString() : null, excerpt, image });
    }
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

async function fetchWpFeaturedPosts(feedUrl, src) {
  const base = wpApiBase(feedUrl);
  if (!base) return [];

  const refs = src.wpFeaturedCategories?.length
    ? src.wpFeaturedCategories
    : WP_FEATURED_SLUGS;

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

  return posts.map(wpPostToItem).filter(Boolean);
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
    return { items: parseFeed(xml).slice(0, maxItems), feedUsed, maxItems };
  }

  const merged = [];
  const seen = new Set();
  let feedsOk = 0;
  for (const feedUrl of uniqueUrls) {
    const xml = await fetchText(feedUrl);
    if (!xml || !isFeedXml(xml)) continue;
    feedsOk += 1;
    for (const item of parseFeed(xml)) {
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

function isCandidateImageUrl(raw = '') {
  const src = String(raw).trim();
  if (!src) return false;
  try {
    const url = new URL(src);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (/(logo|avatar|icon|placeholder|default|blank|spacer|profile|author|favicon|gravatar|emoji|smiley|(?:^|\/)article-2\.|campus-logo|campusgraphic)/.test(path)) {
      return false;
    }
    if (/(?:^|\/)(?:1x1|pixel)\b/.test(path)) return false;
    if (/article-tile|size-article-tile|thumbnail|thumb_|-150x\d+\./.test(path)) return false;
    return true;
  } catch {
    return false;
  }
}

function isWeakImageUrl(raw = '') {
  const path = String(raw).toLowerCase();
  if (/-\d{2,3}x\d{2,3}\./.test(path) && !/-\d{3,4}x\d{3,4}\./.test(path)) return true;
  return /article-tile|size-article-tile/.test(path);
}

function needsImageEnrichment(item) {
  if (!item.link) return false;
  if (!item.image || !isCandidateImageUrl(item.image)) return true;
  return isWeakImageUrl(item.image);
}

function imageFromArticleHtml(html = '') {
  const candidates = [];

  const ogImage = metaContent(html, 'og:image');
  const ogW = parseInt(metaContent(html, 'og:image:width'), 10) || 0;
  if (ogImage && isCandidateImageUrl(ogImage)) {
    candidates.push({ url: ogImage, score: 100 + Math.min(ogW, 2400) / 10 });
  }

  for (const key of ['twitter:image', 'twitter:image:src']) {
    const tw = metaContent(html, key);
    if (tw && isCandidateImageUrl(tw)) candidates.push({ url: tw, score: 90 });
  }

  const wpPost = html.match(
    /<img[^>]+class=["'][^"']*wp-post-image[^"']*["'][^>]*>/i,
  );
  if (wpPost) {
    const tag = wpPost[0];
    const srcM = tag.match(/src=["']([^"']+)["']/i);
    const w = parseInt((tag.match(/width=["'](\d+)["']/i) || [])[1], 10) || 0;
    if (srcM && isCandidateImageUrl(srcM[1]) && !isWeakImageUrl(srcM[1])) {
      candidates.push({ url: srcM[1], score: 85 + w / 10 });
    }
  }

  const neve = html.match(/class=["'][^"']*attachment-neve-blog[^"']*["'][^>]*src=["']([^"']+)["']/i);
  if (neve && isCandidateImageUrl(neve[1])) {
    candidates.push({ url: neve[1], score: 88 });
  }

  const jsonLdBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const m = block.match(/"image"\s*:\s*"([^"]+)"/)
      || block.match(/"image"\s*:\s*\[\s*"([^"]+)"/)
      || block.match(/"url"\s*:\s*"(https?:[^"]+\.(?:jpe?g|png|webp)[^"]*)"/i);
    if (m && isCandidateImageUrl(m[1])) candidates.push({ url: m[1], score: 75 });
  }

  const body = articleBodyHtml(html);
  for (const m of body.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const tag = m[0];
    const src = decodeEntities(m[1]);
    const w = parseInt((tag.match(/width=["'](\d+)["']/i) || [])[1], 10) || 0;
    if (!isCandidateImageUrl(src) || isWeakImageUrl(src)) continue;
    if (w > 0 && w < 400) continue;
    candidates.push({ url: src, score: 60 + w / 10 });
    break;
  }

  if (!candidates.length) return '';
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

function needsEnrichment(item, feedDefaults = new Map()) {
  const thinExcerpt = !item.excerpt || isJunkExcerpt(item.excerpt);
  const missingAuthor = !item.author || isGenericAuthor(item.author);
  const needsAuthorPage = needsPageAuthorVerification(item, feedDefaults);
  return thinExcerpt || missingAuthor || needsImageEnrichment(item) || needsAuthorPage;
}

async function enrichItem(item) {
  const html = await fetchText(item.link, 3, ENRICH_TIMEOUT);
  if (!html || html.length < 200) return item;

  const next = { ...item };
  const body = articleBodyHtml(html);

  if (needsImageEnrichment(next)) {
    const img = imageFromArticleHtml(html);
    if (img) next.image = img;
    else if (next.image && !isCandidateImageUrl(next.image)) next.image = '';
  }

  const pageAuthor = authorFromArticleHtml(html, item.lang === 'en' ? 'en' : 'fr');
  if (pageAuthor) {
    next._pageAuthor = pageAuthor;
  } else if (!next.author || isGenericAuthor(next.author)) {
    const fromBody = extractBylineFromText(firstParagraphFromHtml(body));
    if (fromBody.author) next._pageAuthor = fromBody.author;
  }

  const pageTitle = sanitizeTitle(metaContent(html, 'og:title') || metaContent(html, 'twitter:title'));
  if (pageTitle && (next.title.length < 12 || /\.[a-z][\w-]*\s*\{/.test(next.title))) {
    next.title = pageTitle;
  }

  if (!next.excerpt || isJunkExcerpt(next.excerpt)) {
    const candidates = [
      metaContent(html, 'og:description'),
      metaContent(html, 'description'),
      metaContent(html, 'twitter:description'),
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

async function enrichItems(items, feedDefaults = new Map()) {
  const queue = [
    ...items.filter(needsImageEnrichment),
    ...items.filter((item) => needsEnrichment(item, feedDefaults) && !needsImageEnrichment(item)),
  ];
  const seen = new Set();
  let enriched = 0;
  let imagesAdded = 0;

  for (const item of queue) {
    if (enriched >= MAX_ENRICH) break;
    if (!item.link || seen.has(item.link)) continue;
    seen.add(item.link);

    const hadImage = item.image && isCandidateImageUrl(item.image) && !isWeakImageUrl(item.image);
    const updated = await enrichItem(item);
    Object.assign(item, updated);
    enriched += 1;

    const hasImage = item.image && isCandidateImageUrl(item.image) && !isWeakImageUrl(item.image);
    if (!hadImage && hasImage) imagesAdded += 1;

    await sleep(250);
  }

  if (enriched) {
    console.log(`↻ Enriched ${enriched} articles from source pages (${imagesAdded} images)`);
  }
  return items;
}

async function fetchPageAuthors(items, feedDefaults, existing = new Map()) {
  const pageAuthors = new Map(existing);
  const toFetch = items.filter(
    (item) => needsPageAuthorVerification(item, feedDefaults)
      && !pageAuthors.has(normalizeArticleUrl(item.link)),
  );

  let fetched = 0;
  for (const item of toFetch) {
    if (fetched >= MAX_ENRICH) break;
    const key = normalizeArticleUrl(item.link);
    if (!key || pageAuthors.has(key)) continue;

    const html = await fetchText(item.link, 3, ENRICH_TIMEOUT);
    const author = authorFromArticleHtml(html, item.lang === 'en' ? 'en' : 'fr');
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
  console.log('RÉQ News Aggregator\n===================\n');

  if (!SOURCES.length) {
    console.error('No active sources in news-sources.json — aborting.');
    process.exit(1);
  }

  const all = [];
  let priorByLink = new Map();
  try {
    const prev = JSON.parse(fs.readFileSync(NEWS_PATH, 'utf8'));
    for (const item of prev.items || []) {
      const key = normalizeArticleUrl(item.link);
      if (key) priorByLink.set(key, item);
    }
  } catch {
    priorByLink = new Map();
  }

  for (const src of SOURCES) {
    process.stdout.write(`→ ${src.name} (${src.institution}) … `);
    let items = [];

    if (isFirebaseSource(src)) {
      items = await fetchFirebaseFeed(src, { maxItems: MAX_PER_SOURCE });
      items = items.map((it) => ({
        ...it,
        title: sanitizeTitle(it.title),
        excerpt: truncateExcerpt(it.excerpt, 280),
      }));
      if (!items.length) {
        console.log('✗ no articles (firebase)');
        continue;
      }
      console.log(`✓ ${items.length} articles (firebase)`);
    } else if (isHtmlListSource(src)) {
      const listUrls = [src.url, src.urlFallback, ...(src.feedAlternates || [])].filter(Boolean);
      let html = '';
      let listUsed = '';
      for (const listUrl of [...new Set(listUrls)]) {
        html = await fetchText(listUrl);
        const parsed = parseHtmlListPage(html, listUrl, { maxItems: MAX_PER_SOURCE });
        if (parsed.length) {
          listUsed = listUrl;
          items = parsed.slice(0, MAX_PER_SOURCE).map((it) => ({
            ...it,
            title: sanitizeTitle(it.title),
            excerpt: truncateExcerpt(it.excerpt, 280),
          }));
          break;
        }
        html = '';
      }
      if (!items.length) {
        console.log('✗ no articles (html-list)');
        continue;
      }
      const altNote = listUsed && listUsed !== src.url ? ` [repli: ${listUsed}]` : '';
      console.log(`✓ ${items.length} articles (html-list)${altNote}`);
    } else {
      const { items: rssItems, feedUsed, maxItems } = await fetchRssItems(src);
      if (!rssItems.length) {
        console.log('✗ no response');
        continue;
      }
      let altNote = '';
      if (feedUsed && feedUsed !== src.url) {
        altNote = src.mergeFeedAlternates ? ` [${feedUsed}]` : ` [repli: ${feedUsed}]`;
      }
      items = rssItems;
      const featuredItems = await fetchWpFeaturedPosts(src.url, src);
      if (featuredItems.length) {
        items = mergeSourceItems(rssItems, featuredItems, maxItems);
      }
      const featNote = featuredItems.length ? ` (+${featuredItems.length} vedettes WP)` : '';
      console.log(`✓ ${items.length} articles${featNote}${altNote}`);
    }
    for (const it of items) {
      all.push({
        source: src.name,
        institution: src.institution,
        region: src.region || '',
        type: src.type,
        lang: src.lang,
        ...it,
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

  await enrichItems(all, feedDefaults);

  const pageAuthors = new Map();
  for (const item of all) {
    if (item._pageAuthor && item._pageAuthorKey) {
      pageAuthors.set(item._pageAuthorKey, item._pageAuthor);
      delete item._pageAuthor;
      delete item._pageAuthorKey;
    }
  }
  await fetchPageAuthors(all, feedDefaults, pageAuthors);

  for (let i = 0; i < all.length; i += 1) {
    const pageAuthor = pageAuthors.get(normalizeArticleUrl(all[i].link)) || '';
    all[i] = reconcileAuthor(all[i], all, {
      applyFallback: true,
      feedDefaults,
      pageAuthor,
    }).item;
    if (all[i].image && !isCandidateImageUrl(all[i].image)) all[i].image = '';
    const prior = priorByLink.get(normalizeArticleUrl(all[i].link));
    if (prior) all[i] = mergePriorEnrichment(all[i], prior);
  }

  all.sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : 0;
    const db = b.date ? Date.parse(b.date) : 0;
    return db - da;
  });

  const news = {
    updated: new Date().toISOString(),
    count: all.length,
    items: all,
  };

  const withAuthor = news.items.filter((i) => i.author && !isGenericAuthor(i.author)).length;
  const withExcerpt = news.items.filter((i) => i.excerpt && !isJunkExcerpt(i.excerpt)).length;
  const withImage = news.items.filter(
    (i) => i.image && isCandidateImageUrl(i.image) && !isWeakImageUrl(i.image),
  ).length;
  console.log(`\nTotal: ${news.items.length} articles from ${SOURCES.length} sources.`);
  console.log(
    `Authors: ${withAuthor}/${news.items.length} · Excerpts: ${withExcerpt}/${news.items.length} · Images: ${withImage}/${news.items.length}`,
  );

  if (doUpdate) {
    fs.writeFileSync(NEWS_PATH, JSON.stringify(news, null, 2) + '\n');
    console.log(`✅ Wrote ${NEWS_PATH}`);
  } else {
    console.log('Dry-run complete. Use --update to write news.json.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});