#!/usr/bin/env node
/**
 * RÉQ News Aggregator
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
const MAX_PER_SOURCE = 7;   // keep the freshest few from each paper
const MAX_TOTAL = 60;       // overall cap

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
function fetchText(url, redirects = 3) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; REQ-NewsBot/1.0)',
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
        timeout: TIMEOUT,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(fetchText(next, redirects - 1));
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
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
}

function firstImage(block) {
  // media:content / media:thumbnail
  let m = block.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i);
  if (m) return m[1];
  // enclosure
  m = block.match(/<enclosure[^>]*url=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i);
  if (m) return m[1];
  // first <img> inside content
  m = block.match(/<img[^>]*src=["']([^"']+)["']/i);
  if (m) return decodeEntities(m[1]);
  return '';
}

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const title = stripHtml(tag(block, 'title'));
    let link = stripHtml(tag(block, 'link'));
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    const dateRaw = tag(block, 'pubDate') || tag(block, 'dc:date') || tag(block, 'published') || tag(block, 'updated');
    const date = dateRaw ? new Date(dateRaw) : null;
    const rawSummary = tag(block, 'description') || tag(block, 'content:encoded') || tag(block, 'summary') || tag(block, 'content');
    const excerpt = stripHtml(rawSummary).slice(0, 220);
    const image = firstImage(tag(block, 'content:encoded') || rawSummary || block) || firstImage(block);

    if (title && link) {
      items.push({ title, link, date: date && !isNaN(date) ? date.toISOString() : null, excerpt, image });
    }
  }
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

  // Sort newest first; items without a date sink to the bottom.
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

  console.log(`\nTotal: ${news.items.length} articles from ${SOURCES.length} sources.`);

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
