#!/usr/bin/env node
/**
 * LE RADAR Social Feed
 *
 * Builds social-feed.json: student media profiles on Instagram, Facebook, X…
 * Stats are read from public Open Graph metadata (no API keys).
 *
 * Usage:
 *   node scripts/fetch-social.js
 *   node scripts/fetch-social.js --update
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'social-feed.json');
const NEWS_SOURCES_PATH = path.join(ROOT, 'news-sources.json');
const RADIOS_PATH = path.join(ROOT, 'radios.json');
const TIMEOUT = 12000;

const SOCIAL_RE = /https?:\/\/(?:www\.)?(instagram\.com\/(?!explore|accounts|p\/|reel\/)[A-Za-z0-9._]+|facebook\.com\/(?!sharer|share|dialog|groups\/)[A-Za-z0-9._-]+|twitter\.com\/(?!intent)[A-Za-z0-9_]+|x\.com\/(?!intent)[A-Za-z0-9_]+|tiktok\.com\/@?[A-Za-z0-9._]+|youtube\.com\/(?:@|channel\/|user\/)[A-Za-z0-9._-]+)/gi;

const JUNK_SOCIAL = /sharer|share\.php|intent\/|\/groups\/|tiktok\.com\/?$/i;

function fetchText(url, redirects = 4) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LE-RADAR-SocialBot/1.0)',
            Accept: 'text/html,application/xhtml+xml,*/*',
          },
          timeout: TIMEOUT,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects - 1));
          }
          if (res.statusCode >= 400) {
            res.resume();
            return resolve('');
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            if (data.length < 180000) data += c;
          });
          res.on('end', () => resolve(data));
        },
      );
    } catch {
      return resolve('');
    }
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });
}

function decodeEntities(str = '') {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function metaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]).trim();
  }
  return '';
}

function normalizeSocialUrl(raw = '') {
  let url = raw.replace(/&amp;/g, '&').split('?')[0].replace(/\/+$/, '');
  if (/^http:\/\//i.test(url)) url = url.replace(/^http:/i, 'https:');
  if (JUNK_SOCIAL.test(url)) return '';
  if (/instagram\.com\/[^/]+$/i.test(url)) return `${url}/`;
  return url;
}

function classifyNetwork(url = '') {
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/facebook\.com/i.test(url)) return 'facebook';
  if (/twitter\.com|x\.com/i.test(url)) return 'x';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/youtube\.com/i.test(url)) return 'youtube';
  return 'web';
}

function handleFromUrl(url = '', type = '') {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (type === 'instagram') return parts[0] ? `@${parts[0]}` : '';
    if (type === 'x') return parts[0] ? `@${parts[0]}` : '';
    if (type === 'tiktok') return parts[0] ? `@${parts[0].replace(/^@/, '')}` : '';
    if (type === 'youtube') return parts[0] ? (parts[0].startsWith('@') ? parts[0] : `@${parts[parts.length - 1]}`) : '';
    if (type === 'facebook') return parts[0] ? parts[0] : '';
  } catch {
    return '';
  }
  return '';
}

function parseInstagramStats(desc = '') {
  const m = desc.match(/([\d,.]+)\s+Followers?,\s*([\d,.]+)\s+Following,\s*([\d,.]+)\s+Posts?/i);
  if (!m) return '';
  const posts = m[3].replace(/,/g, ' ');
  const followers = m[1].replace(/,/g, ' ');
  return `${followers} abonnés · ${posts} publications`;
}

function parseFacebookStats(desc = '') {
  const likes = desc.match(/([\d,.]+)\s+(?:likes|mentions\s+J['']aime)/i);
  if (likes) return `${likes[1].replace(/,/g, ' ')} mentions J'aime`;
  if (desc.length > 20 && desc.length < 160) return desc;
  return '';
}

async function profileStats(url, type) {
  const html = await fetchText(url);
  if (!html) return '';
  const desc = metaContent(html, 'og:description') || metaContent(html, 'description');
  if (!desc) return '';
  if (type === 'instagram') return parseInstagramStats(desc);
  if (type === 'facebook') return parseFacebookStats(desc);
  if (type === 'x') return desc.length < 120 ? desc : '';
  return '';
}

function extractSocialLinks(html = '') {
  const found = new Set();
  let m;
  const re = new RegExp(SOCIAL_RE.source, 'gi');
  while ((m = re.exec(html)) !== null) {
    const clean = normalizeSocialUrl(m[0]);
    if (clean) found.add(clean);
  }
  return [...found];
}

function siteUrlFromSource(src) {
  if (src.website) return src.website;
  if (src.url) {
    try {
      const u = new URL(src.url);
      return `${u.protocol}//${u.host}/`;
    } catch {
      return '';
    }
  }
  return '';
}

function socialPresetFromSource(src = {}) {
  const preset = {};
  if (src.instagram) preset.instagram = src.instagram;
  if (src.facebook) preset.facebook = src.facebook;
  if (src.x) preset.x = src.x;
  if (src.twitter) preset.x = src.twitter;
  if (src.tiktok) preset.tiktok = src.tiktok;
  if (src.youtube) preset.youtube = src.youtube;
  if (src.social && typeof src.social === 'object') {
    for (const [type, url] of Object.entries(src.social)) {
      if (url) preset[type] = url;
    }
  }
  return preset;
}

async function networksForSource(src, preset = {}) {
  const links = new Map();

  for (const [type, url] of Object.entries(preset)) {
    const clean = normalizeSocialUrl(url);
    if (clean) links.set(type, clean);
  }

  const site = siteUrlFromSource(src);
  if (site) {
    const html = await fetchText(site);
    for (const url of extractSocialLinks(html)) {
      const type = classifyNetwork(url);
      if (type !== 'web' && !links.has(type)) links.set(type, url);
    }
  }

  const order = ['instagram', 'facebook', 'x', 'tiktok', 'youtube'];
  const networks = [];
  for (const type of order) {
    const url = links.get(type);
    if (!url) continue;
    const stats = await profileStats(url, type);
    networks.push({
      type,
      url,
      handle: handleFromUrl(url, type),
      stats,
      label: { instagram: 'Instagram', facebook: 'Facebook', x: 'X', tiktok: 'TikTok', youtube: 'YouTube' }[type],
    });
    await sleep(200);
  }
  return networks;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const doUpdate = process.argv.includes('--update');
  console.log('LE RADAR Social Feed\n====================\n');

  const newsRegistry = JSON.parse(fs.readFileSync(NEWS_SOURCES_PATH, 'utf8'));
  const radios = JSON.parse(fs.readFileSync(RADIOS_PATH, 'utf8'));
  const items = [];

  for (const src of newsRegistry.active || []) {
    process.stdout.write(`→ ${src.name} … `);
    const networks = await networksForSource(src, socialPresetFromSource(src));
    console.log(networks.length ? networks.map((n) => n.type).join(', ') : '—');
    if (!networks.length) continue;
    items.push({
      name: src.name,
      institution: src.institution,
      type: src.type,
      kind: 'journal',
      networks,
    });
  }

  for (const radio of radios) {
    const preset = socialPresetFromSource(radio);
    if (!Object.keys(preset).length) continue;

    process.stdout.write(`→ ${radio.name} (radio) … `);
    const networks = await networksForSource({ website: radio.website, url: radio.website }, preset);
    console.log(networks.length ? networks.map((n) => n.type).join(', ') : '—');
    if (!networks.length) continue;
    items.push({
      name: radio.name,
      institution: radio.institution,
      type: radio.type,
      kind: 'radio',
      networks,
    });
  }

  const feed = {
    updated: new Date().toISOString(),
    count: items.length,
    items,
  };

  console.log(`\nTotal: ${items.length} médias avec réseaux sociaux.`);

  if (doUpdate) {
    fs.writeFileSync(OUT_PATH, JSON.stringify(feed, null, 2) + '\n');
    console.log(`✅ Wrote ${OUT_PATH}`);
  } else {
    console.log('Dry-run complete. Use --update to write social-feed.json.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});