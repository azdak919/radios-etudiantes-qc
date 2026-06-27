#!/usr/bin/env node
/**
 * RADAR Media Scanner
 *
 * Long-term discovery layer: reads institutions.json and looks for student
 * newspapers (RSS) and campus radios we don't cover yet. Findings land in
 * news-sources.json → candidates and radios-candidates.json.
 *
 * Designed to run weekly (low volume, resilient). Never wipes human data.
 *
 * Usage:
 *   node scripts/scan-media.js           # dry run
 *   node scripts/scan-media.js --update  # write candidate registries
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const INSTITUTIONS_PATH = path.join(ROOT, 'institutions.json');
const NEWS_SOURCES_PATH = path.join(ROOT, 'news-sources.json');
const RADIOS_PATH = path.join(ROOT, 'radios.json');
const RADIOS_CANDIDATES_PATH = path.join(ROOT, 'radios-candidates.json');

const TIMEOUT = 8000;
const MAX_SCAN = 8; // institutions per weekly run (~70 gaps in ~9 weeks)
const MAX_LINKS = 5; // promising links probed per institution
const SCAN_CONCURRENCY = 3;

const FEED_PATHS = ['feed/', 'feed', '?feed=rss2', 'rss/', 'rss', 'index.xml', 'atom.xml'];

const NEWS_HINTS = /journal|étudiant|etudiant|student|newspaper|média|media|quartier|exemplaire|collectif|délit|delit|tribune|daily|link|pige|exil|campus|gazette|review|revue|trait.?union|griffonnier|oisif|gifle|brise.?glace|concordian/i;
const RADIO_HINTS = /\bradio\b|\bfm\b|\bam\b|écoute|ecoute|listen|stream|webradio|campus.?radio|choq|chyz|cism|ckut|cjlo|cfou|cfak|cjep|crem/i;

// === HTTP ====================================================================
function fetchText(url, redirects = 4) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; RADAR-MediaScanner/1.0)',
            Accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml,*/*',
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
            if (data.length < 120000) data += c;
          });
          res.on('end', () => resolve(data));
        }
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

// === Matching helpers ==========================================================
function norm(s = '') {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function instKeys(name) {
  const keys = [norm(name).replace(/\(.*?\)/g, '').trim()];
  const acro = name.match(/\(([^)]+)\)/);
  if (acro) keys.push(norm(acro[1]));
  return keys.filter(Boolean);
}

function hostKey(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return norm(url);
  }
}

function isFeed(xml) {
  return /<rss[\s>]|<feed[\s>]/i.test((xml || '').slice(0, 600));
}

function countItems(xml) {
  return (xml.match(/<item[\s>]/gi) || xml.match(/<entry[\s>]/gi) || []).length;
}

function latestItemDate(xml) {
  const dates = [];
  const re = /<(?:pubDate|dc:date|published|updated)>([^<]+)<\//gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const d = Date.parse(m[1].trim());
    if (!isNaN(d)) dates.push(d);
  }
  return dates.length ? Math.max(...dates) : null;
}

function slugify(text = '') {
  return norm(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36);
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  const re = /href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl).toString();
      if (abs.startsWith('http')) links.add(abs);
    } catch {}
  }
  // RSS link tags
  const alt = html.match(/<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)["']/i);
  if (alt) {
    try { links.add(new URL(alt[1], baseUrl).toString()); } catch {}
  }
  return [...links];
}

function linkLabel(url, html) {
  const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<a[^>]+href=["'][^"']*${esc.slice(-40)}["'][^>]*>([^<]{2,80})<`, 'i');
  const m = html.match(re);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

async function probeFeed(url) {
  const { ok, body } = await (async () => {
    const body = await fetchText(url);
    return { ok: !!body, body };
  })();
  if (!ok || !isFeed(body) || countItems(body) === 0) return null;
  const last = latestItemDate(body);
  if (last == null) return null;
  const ageDays = (Date.now() - last) / 86400000;
  if (ageDays > 540) return null; // older than ~18 months
  return { url, lastItemDate: new Date(last).toISOString(), items: countItems(body) };
}

async function findFeedOnSite(siteUrl) {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  const tries = siteUrl.match(/feed\/?$|\.xml$|feed=rss/i)
    ? [siteUrl]
    : FEED_PATHS.map((p) => base + p);

  for (const url of tries) {
    const hit = await probeFeed(url);
    if (hit) return hit;
  }
  return null;
}

// === Coverage =================================================================
function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function coveredInstitutions(newsRegistry, radios, radioCandidates) {
  const covered = new Set();

  for (const s of newsRegistry.active || []) {
    if (s._status !== 'dead' && s.institution) covered.add(norm(s.institution));
  }
  for (const r of radios || []) {
    if (r.institution) covered.add(norm(r.institution));
  }
  for (const c of radioCandidates.candidates || []) {
    if (c.institution) covered.add(norm(c.institution));
  }

  const hasNews = (inst) =>
    instKeys(inst.name).some((k) => [...covered].some((c) => c.includes(k) || k.includes(c)));

  const hasRadio = (inst) =>
    (radios || []).some((r) =>
      instKeys(inst.name).some((k) => norm(r.institution || '').includes(k) || k.includes(norm(r.institution || '')))
    ) || (radioCandidates.candidates || []).some((c) =>
      instKeys(inst.name).some((k) => norm(c.institution || '').includes(k) || k.includes(norm(c.institution || '')))
    );

  return { hasNews, hasRadio };
}

function knownHosts(newsRegistry, radios, radioCandidates) {
  const hosts = new Set();
  for (const s of [...(newsRegistry.active || []), ...(newsRegistry.candidates || [])]) {
    if (s.url) hosts.add(hostKey(s.url));
    if (s.site) hosts.add(hostKey(s.site));
  }
  for (const r of [...(radios || []), ...(radioCandidates.candidates || [])]) {
    if (r.website) hosts.add(hostKey(r.website));
  }
  return hosts;
}

// === Scan one institution =====================================================
async function scanInstitution(inst, ctx) {
  if (!inst.website) return { news: [], radios: [] };

  const html = await fetchText(inst.website);
  if (!html) return { news: [], radios: [] };

  const links = extractLinks(html, inst.website);
  const newsFound = [];
  const radioFound = [];

  const scored = links.map((link) => {
    const label = linkLabel(link, html);
    const text = `${link} ${label}`;
    let score = 0;
    if (NEWS_HINTS.test(text)) score += 2;
    if (RADIO_HINTS.test(text)) score += 2;
    if (/feed|rss|xml/i.test(link)) score += 3;
    return { link, label, text, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, MAX_LINKS);

  for (const { link, label, text } of scored) {
    const h = hostKey(link);
    if (ctx.hosts.has(h)) continue;

    if (NEWS_HINTS.test(text) && !ctx.hasNews(inst)) {
      const feed = await findFeedOnSite(link);
      if (feed) {
        newsFound.push({
          name: label || link.replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
          institution: inst.name,
          region: inst.region || '',
          type: inst.type,
          lang: /student|daily|link|tribune|mcgill|concordia/i.test(text) ? 'en' : 'fr',
          site: link.split(/\/feed|\/rss|\?feed/)[0].replace(/\/$/, '') || link,
          url: feed.url,
          _discovered: new Date().toISOString(),
          _status: 'candidate',
        });
        ctx.hosts.add(h);
      }
    }

    if (RADIO_HINTS.test(text) && !ctx.hasRadio(inst) && !radioFound.length) {
      radioFound.push({
        id: `cand-${slugify(inst.name)}-${slugify(label || h)}`.slice(0, 48),
        name: label || `Radio — ${inst.name.split('(')[0].trim()}`,
        institution: inst.name,
        region: inst.region || '',
        type: inst.type,
        website: link,
        discoveredFrom: inst.website,
        _discovered: new Date().toISOString(),
        _failCount: 0,
      });
      ctx.hosts.add(h);
    }
  }

  // Fallback: try /feed on the institution site itself (some papers live on subdomains linked only in footer)
  if (!newsFound.length && !ctx.hasNews(inst)) {
    const feed = await findFeedOnSite(inst.website);
    if (feed && !ctx.hosts.has(hostKey(feed.url))) {
      newsFound.push({
        name: `Média — ${inst.name.split('(')[0].trim()}`,
        institution: inst.name,
        region: inst.region || '',
        type: inst.type,
        lang: 'fr',
        site: inst.website,
        url: feed.url,
        _discovered: new Date().toISOString(),
        _status: 'candidate',
      });
    }
  }

  return { news: newsFound, radios: radioFound };
}

// === Main =====================================================================
async function main() {
  const doUpdate = process.argv.includes('--update');
  const catalogue = loadJson(INSTITUTIONS_PATH, { institutions: [] });
  const newsRegistry = loadJson(NEWS_SOURCES_PATH, { active: [], candidates: [] });
  const radios = loadJson(RADIOS_PATH, []);
  const radioCandidates = loadJson(RADIOS_CANDIDATES_PATH, { candidates: [], _comment: '' });

  newsRegistry.active = newsRegistry.active || [];
  newsRegistry.candidates = newsRegistry.candidates || [];
  radioCandidates.candidates = radioCandidates.candidates || [];

  const { hasNews, hasRadio } = coveredInstitutions(newsRegistry, radios, radioCandidates);
  const hosts = knownHosts(newsRegistry, radios, radioCandidates);

  const insts = catalogue.institutions || [];
  const gaps = insts.filter((i) => !hasNews(i) || !hasRadio(i));
  // Universities first, then cégeps — capped per run
  const queue = [
    ...gaps.filter((i) => i.type === 'universite'),
    ...gaps.filter((i) => i.type === 'cegep'),
  ].slice(0, MAX_SCAN);

  console.log('RADAR Media Scanner\n===================\n');
  console.log(`Institutions: ${insts.length} · gaps: ${gaps.length} · scanning: ${queue.length}\n`);

  const ctx = { hasNews, hasRadio, hosts };
  let newNews = 0;
  let newRadios = 0;

  async function processResult(inst, { news, radios: rad }) {
    if (!news.length && !rad.length) {
      console.log(`→ ${inst.name.slice(0, 50).padEnd(50)} ·`);
      return;
    }
    const parts = [];
    if (news.length) parts.push(`${news.length} journal`);
    if (rad.length) parts.push(`${rad.length} radio`);
    console.log(`→ ${inst.name.slice(0, 50).padEnd(50)} + ${parts.join(', ')}`);

    for (const n of news) {
      const dup = newsRegistry.candidates.some((c) => hostKey(c.site) === hostKey(n.site))
        || newsRegistry.active.some((a) => hostKey(a.url) === hostKey(n.url));
      if (!dup) {
        newsRegistry.candidates.push({
          name: n.name,
          institution: n.institution,
          region: n.region,
          type: n.type,
          lang: n.lang,
          site: n.site,
          _discovered: n._discovered,
          _failCount: 0,
        });
        newNews++;
      }
    }

    for (const r of rad) {
      const dup = radioCandidates.candidates.some((c) => hostKey(c.website) === hostKey(r.website))
        || radios.some((x) => hostKey(x.website) === hostKey(r.website));
      if (!dup) {
        radioCandidates.candidates.push(r);
        newRadios++;
      }
    }
  }

  // Scan institutions in small parallel batches (faster CI, same resilience)
  let qi = 0;
  const workers = Array.from({ length: SCAN_CONCURRENCY }, async () => {
    while (qi < queue.length) {
      const inst = queue[qi++];
      await processResult(inst, await scanInstitution(inst, ctx));
    }
  });
  await Promise.all(workers);

  newsRegistry._lastScan = new Date().toISOString();
  radioCandidates._lastScan = new Date().toISOString();
  radioCandidates._comment = radioCandidates._comment
    || 'Candidats radios découverts automatiquement. Promus vers radios.json quand un flux direct est validé par discover-streams.js.';

  console.log(`\nSummary: +${newNews} news candidates, +${newRadios} radio candidates`);
  console.log(`Totals: ${newsRegistry.candidates.length} news candidates, ${radioCandidates.candidates.length} radio candidates`);

  if (doUpdate) {
    fs.writeFileSync(NEWS_SOURCES_PATH, JSON.stringify(newsRegistry, null, 2) + '\n');
    fs.writeFileSync(RADIOS_CANDIDATES_PATH, JSON.stringify(radioCandidates, null, 2) + '\n');
    console.log('✅ Registries updated');
  } else {
    console.log('Dry-run complete. Use --update to write.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});