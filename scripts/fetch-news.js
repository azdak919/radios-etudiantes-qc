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

const NEWS_PATH = path.join(__dirname, '..', 'news.json');
const SOURCES_PATH = path.join(__dirname, '..', 'news-sources.json');
const TIMEOUT = 15000;
const ENRICH_TIMEOUT = 12000;
const MAX_PER_SOURCE = 7;   // keep the freshest few from each paper
const MAX_TOTAL = 60;       // overall cap
const MAX_ENRICH = 20;      // cap article-page fetches per run

const GENERIC_AUTHORS = /^(admin|administrator|administrateur|editor|éditeur|editeur|rédaction|redaction|staff|wordpress|webmaster|collectif|le collectif|tribune|link|daily|exemplaire|quartier libre|zone campus|la pige|le délit|le delit|the link|the tribune|the mcgill daily)$/i;

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
    .replace(/&gt;/g, '>');
}

function stripHtml(html = '') {
  return decodeEntities(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function sanitizeTitle(title = '') {
  let t = stripHtml(stripEmbeddedCss(title));
  t = t.replace(/\s+/g, ' ').trim();
  const prefix = t.match(MC_CATEGORY_PREFIX);
  if (prefix) t = t.slice(prefix[0].length).trim();
  return t;
}

function tag(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = block.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, 'i'));
  return m ? m[1].trim() : '';
}

function isGenericAuthor(name = '') {
  const n = String(name).replace(/\s+/g, ' ').trim();
  if (!n || n.length < 2) return true;
  if (GENERIC_AUTHORS.test(n)) return true;
  if (/@/.test(n)) return true;
  return false;
}

function normalizeAuthor(name = '') {
  let a = stripHtml(name);
  const paren = a.match(/\(([^)]+)\)/);
  if (paren) a = paren[1];
  a = a.replace(/^(?:Par|By)\s+/i, '').replace(/\s+/g, ' ').trim();
  return isGenericAuthor(a) ? '' : a.slice(0, 80);
}

function extractBylineFromText(text = '') {
  const plain = stripHtml(text);
  const m = plain.match(/^(?:Par|By)\s+([\p{Lu}][\p{L}'’.\-]+(?:\s+[\p{Lu}][\p{L}'’.\-]+){0,3})/u);
  if (!m) return { author: '', body: plain };
  const author = normalizeAuthor(m[1]);
  const body = plain.slice(m[0].length).trim();
  return { author, body };
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

  return excerpt.slice(0, 280);
}

function parseAuthor(block, contentHtml = '') {
  let a = tag(block, 'dc:creator') || tag(block, 'creator') || tag(block, 'author');
  if (a && /<name[\s>]/i.test(a)) a = tag(a, 'name');
  a = normalizeAuthor(a);
  if (a) return a;

  const fromContent = extractBylineFromText(firstParagraphFromHtml(contentHtml));
  if (fromContent.author) return fromContent.author;

  const fromDesc = extractBylineFromText(stripHtml(tag(block, 'description')));
  if (fromDesc.author) return fromDesc.author;

  return '';
}

function firstImage(block) {
  let m = block.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(/<enclosure[^>]*url=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i);
  if (m) return m[1];
  m = block.match(/<img[^>]*src=["']([^"']+)["']/i);
  if (m) return decodeEntities(m[1]);
  return '';
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
    const author = parseAuthor(block, contentHtml);
    const excerpt = pickExcerpt(block);
    const image = firstImage(contentHtml || tag(block, 'description') || block) || firstImage(block);

    if (title && link) {
      items.push({ title, link, author, date: date && !isNaN(date) ? date.toISOString() : null, excerpt, image });
    }
  }
  return items;
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

function authorFromArticleHtml(html = '') {
  const candidates = [];

  const tribune = html.match(/tribune_author=([^"'&]+)/i);
  if (tribune) candidates.push(decodeURIComponent(tribune[1].replace(/\+/g, ' ')));

  const entryAuthor = html.match(/class=["'][^"']*entry-author[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
  if (entryAuthor) candidates.push(stripHtml(entryAuthor[1]));

  const authorTitle = html.match(/class=["'][^"']*author-title[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
  if (authorTitle) candidates.push(stripHtml(authorTitle[1]));

  const relAuthor = html.match(/rel=["']author["'][^>]*>([\s\S]*?)<\//i);
  if (relAuthor) candidates.push(stripHtml(relAuthor[1]));

  for (const raw of candidates) {
    const name = normalizeAuthor(raw);
    if (name) return name;
  }
  return '';
}

function needsEnrichment(item) {
  const thinExcerpt = !item.excerpt || isJunkExcerpt(item.excerpt);
  const missingAuthor = !item.author || isGenericAuthor(item.author);
  return thinExcerpt || missingAuthor;
}

async function enrichItem(item) {
  const html = await fetchText(item.link, 3, ENRICH_TIMEOUT);
  if (!html || html.length < 200) return item;

  const next = { ...item };
  const body = articleBodyHtml(html);

  if (!next.author || isGenericAuthor(next.author)) {
    const candidates = [
      authorFromArticleHtml(html),
      metaContent(html, 'parsely-author'),
      metaContent(html, 'article:author'),
      metaContent(html, 'author'),
      metaContent(html, 'dc.creator'),
      metaContent(html, 'dc:creator'),
    ].map(normalizeAuthor).filter(Boolean);

    const fromBody = extractBylineFromText(firstParagraphFromHtml(body));
    if (fromBody.author) candidates.unshift(fromBody.author);

    if (candidates.length) next.author = candidates[0];
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
      next.excerpt = excerpt.slice(0, 280);
    }
  }

  return next;
}

async function enrichItems(items) {
  let enriched = 0;
  for (const item of items) {
    if (enriched >= MAX_ENRICH) break;
    if (!needsEnrichment(item)) continue;
    const updated = await enrichItem(item);
    Object.assign(item, updated);
    enriched += 1;
    await sleep(250);
  }
  if (enriched) console.log(`↻ Enriched ${enriched} articles from source pages`);
  return items;
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

  for (const src of SOURCES) {
    process.stdout.write(`→ ${src.name} (${src.institution}) … `);
    const xml = await fetchText(src.url);
    if (!xml) {
      console.log('✗ no response');
      continue;
    }
    const items = parseFeed(xml).slice(0, MAX_PER_SOURCE);
    console.log(`✓ ${items.length} articles`);
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

  await enrichItems(all);

  all.sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : 0;
    const db = b.date ? Date.parse(b.date) : 0;
    return db - da;
  });

  const news = {
    updated: new Date().toISOString(),
    count: Math.min(all.length, MAX_TOTAL),
    items: all.slice(0, MAX_TOTAL),
  };

  const withAuthor = news.items.filter((i) => i.author && !isGenericAuthor(i.author)).length;
  const withExcerpt = news.items.filter((i) => i.excerpt && !isJunkExcerpt(i.excerpt)).length;
  console.log(`\nTotal: ${news.items.length} articles from ${SOURCES.length} sources.`);
  console.log(`Authors: ${withAuthor}/${news.items.length} · Excerpts: ${withExcerpt}/${news.items.length}`);

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