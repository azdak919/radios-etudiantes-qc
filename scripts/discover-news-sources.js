#!/usr/bin/env node
/**
 * RÉQ News Source Bot
 *
 * Maintains news-sources.json so the news feed keeps working over time:
 *
 *  1. Health-checks every ACTIVE feed (still reachable? still publishing?)
 *     and tags it _status = ok | stale | dead, with _lastItemDate /
 *     _lastChecked / _failCount.
 *  2. Probes every CANDIDATE site for a working RSS feed and, when it finds
 *     a fresh one, PROMOTES it into the active list automatically.
 *
 * A dead active feed is skipped by scripts/fetch-news.js but kept in the
 * registry (it might come back to life — students return in September).
 *
 * No external dependencies.
 *
 * Usage:
 *   node scripts/discover-news-sources.js           # dry run, prints report
 *   node scripts/discover-news-sources.js --update  # writes news-sources.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  isHtmlListSource,
  classifyHtmlList,
  countHtmlListItems,
} = require('./html-list-fetcher');
const { isFirebaseSource, classifyFirebaseSource } = require('./firebase-list-fetcher');
const {
  groupItemsBySource,
  sourceHasFreshContent,
  freshnessWindowStart,
  latestItemDate: latestCachedItemDate,
  classifyFeedFreshness,
} = require('./source-retention-lib');

const SOURCES_PATH = path.join(__dirname, '..', 'news-sources.json');
const INSTITUTIONS_PATH = path.join(__dirname, '..', 'institutions.json');
const NEWS_PATH = path.join(__dirname, '..', 'news.json');
const TIMEOUT = 15000;

const DAY = 86400000;
const MAX_FAILS = 4;       // consecutive fetch failures before marking dead (if no fresh cache)
const PROMOTE_DAYS = 365;  // a candidate must have posted within a year

// Feed paths tried on a candidate site (most common first).
const FEED_PATHS = ['feed/', 'feed', '?feed=rss2', 'rss/', 'rss', 'index.xml', 'atom.xml'];

// === HTTP ====================================================================
function fetchText(url, redirects = 4) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(
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
            return resolve({ ok: false, body: '' });
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ ok: true, body: data }));
        }
      );
    } catch {
      return resolve({ ok: false, body: '' });
    }
    req.on('error', () => resolve({ ok: false, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, body: '' });
    });
  });
}

// === Feed inspection =========================================================
function isFeed(xml) {
  return /<rss[\s>]|<feed[\s>]/i.test(xml.slice(0, 600));
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

function countItems(xml) {
  return (xml.match(/<item[\s>]/gi) || xml.match(/<entry[\s>]/gi) || []).length;
}

// Returns { status, lastItemDate } for a fetched feed body (3-session window).
function classify(xml) {
  if (!isFeed(xml) || countItems(xml) === 0) return { status: 'dead', lastItemDate: null };
  const last = latestItemDate(xml);
  return classifyFeedFreshness(last);
}

function loadCachedBySource() {
  try {
    const data = JSON.parse(fs.readFileSync(NEWS_PATH, 'utf8'));
    return groupItemsBySource(data.items || []);
  } catch {
    return new Map();
  }
}

function hasFreshCachedArticles(src, cachedBySource, referenceDate = new Date()) {
  const cached = cachedBySource.get(src.name) || [];
  return sourceHasFreshContent(cached, referenceDate);
}

// === Maintenance =============================================================
async function checkActive(src, cachedBySource) {
  const before = src._status;
  src._lastChecked = new Date().toISOString();
  const referenceDate = new Date();

  if (isFirebaseSource(src)) {
    const { status, lastItemDate, count } = await classifyFirebaseSource(src);
    src._status = status;
    src._failCount = 0;
    if (lastItemDate) src._lastItemDate = lastItemDate;
    return {
      name: src.name,
      result: `${count} items (firebase), latest ${lastItemDate ? lastItemDate.slice(0, 10) : '?'}`,
      before,
      after: status,
    };
  }

  const { ok, body } = await fetchText(src.url);

  if (!ok) {
    src._failCount = (src._failCount || 0) + 1;
    const freshCache = hasFreshCachedArticles(src, cachedBySource, referenceDate);
    const lastFreshMs = Math.max(
      Date.parse(src._lastItemDate || '') || 0,
      Date.parse(latestCachedItemDate(cachedBySource.get(src.name) || []) || '') || 0,
    );
    const insideWindow = lastFreshMs >= freshnessWindowStart(referenceDate).getTime();
    if (freshCache || insideWindow) {
      src._status = 'stale';
    } else if (src._failCount >= MAX_FAILS) {
      src._status = 'dead';
    } else if (src._status !== 'dead') {
      src._status = src._status || 'ok';
    }
    const note = freshCache ? ', cache frais conservé' : '';
    return {
      name: src.name,
      result: `unreachable (${src._failCount}/${MAX_FAILS})${note}`,
      before,
      after: src._status,
    };
  }

  src._failCount = 0;
  const { status, lastItemDate } = isHtmlListSource(src)
    ? classifyHtmlList(body, src.url)
    : classify(body);
  src._status = status;
  if (lastItemDate) src._lastItemDate = lastItemDate;
  const count = isHtmlListSource(src) ? countHtmlListItems(body, src.url) : countItems(body);
  const mode = isHtmlListSource(src) ? 'html-list' : 'rss';
  return {
    name: src.name,
    result: `${count} items (${mode}), latest ${lastItemDate ? lastItemDate.slice(0, 10) : '?'}`,
    before,
    after: status,
  };
}

async function probeCandidate(cand) {
  cand._lastChecked = new Date().toISOString();
  const base = cand.site.endsWith('/') ? cand.site : cand.site + '/';
  const tries = cand.site.match(/feed\/?$|\.xml$|feed=rss/i) ? [cand.site] : FEED_PATHS.map((p) => base + p);

  for (const url of tries) {
    const { ok, body } = await fetchText(url);
    if (!ok || !isFeed(body) || countItems(body) === 0) continue;
    const last = latestItemDate(body);
    const fresh = last != null && (Date.now() - last) / DAY <= PROMOTE_DAYS;
    if (fresh) {
      return {
        promoted: true,
        entry: {
          name: cand.name,
          institution: cand.institution,
          region: cand.region || '',
          type: cand.type,
          lang: cand.lang || 'fr',
          url,
          _status: 'ok',
          _lastItemDate: new Date(last).toISOString(),
          _lastChecked: cand._lastChecked,
          _failCount: 0,
        },
        feedUrl: url,
      };
    }
  }
  cand._failCount = (cand._failCount || 0) + 1;
  return { promoted: false };
}

// === Coverage report (cross-reference institutions.json) =====================
function norm(s = '') {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Core tokens that identify an institution (full name + parenthetical acronym).
function instKeys(name) {
  const keys = [norm(name).replace(/\(.*?\)/g, '').trim()];
  const acro = name.match(/\(([^)]+)\)/);
  if (acro) keys.push(norm(acro[1]));
  return keys.filter(Boolean);
}

function reportCoverage(registry) {
  let catalogue;
  try {
    catalogue = JSON.parse(fs.readFileSync(INSTITUTIONS_PATH, 'utf8'));
  } catch {
    console.log('\n▸ Coverage: institutions.json not found — skipping.');
    return;
  }
  const covered = registry.active
    .filter((s) => s._status !== 'dead')
    .map((s) => norm(s.institution || ''));

  const isCovered = (inst) =>
    instKeys(inst.name).some((k) => covered.some((c) => c.includes(k) || k.includes(c)));

  const insts = catalogue.institutions || [];
  const gapsU = insts.filter((i) => i.type === 'universite' && !isCovered(i));
  const gapsC = insts.filter((i) => i.type === 'cegep' && !isCovered(i));
  const nU = insts.filter((i) => i.type === 'universite').length;
  const nC = insts.filter((i) => i.type === 'cegep').length;

  console.log('\n▸ Coverage vs institutions.json');
  console.log(`  Universités : ${nU - gapsU.length}/${nU} avec une source`);
  console.log(`  Cégeps      : ${nC - gapsC.length}/${nC} avec une source`);
  if (gapsU.length) {
    console.log(`  Universités sans source (${gapsU.length}): ${gapsU.map((i) => i.name).join(', ')}`);
  }
  console.log(`  Cégeps sans source : ${gapsC.length} (voir institutions.json pour candidats potentiels)`);
}

// === Main ====================================================================
async function main() {
  const doUpdate = process.argv.includes('--update');
  const registry = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  registry.active = registry.active || [];
  registry.candidates = registry.candidates || [];

  console.log('RÉQ News Source Bot\n===================\n');

  const cachedBySource = loadCachedBySource();

  // 1. Health-check active feeds
  console.log('▸ Active feeds');
  for (const src of registry.active) {
    const r = await checkActive(src, cachedBySource);
    const flag = r.after === 'dead' ? '✗' : r.after === 'stale' ? '~' : '✓';
    console.log(`  ${flag} ${r.name.padEnd(20)} ${r.result}${r.before && r.before !== r.after ? `  [${r.before}→${r.after}]` : ''}`);
  }

  // 2. Probe candidates → promote fresh ones
  console.log('\n▸ Candidates');
  const stillCandidates = [];
  let promotedCount = 0;
  for (const cand of registry.candidates) {
    const r = await probeCandidate(cand);
    if (r.promoted) {
      registry.active.push(r.entry);
      promotedCount++;
      console.log(`  ⬆ ${cand.name.padEnd(20)} PROMOTED → ${r.feedUrl}`);
    } else {
      stillCandidates.push(cand);
      console.log(`  ·  ${cand.name.padEnd(20)} no fresh feed (${cand._failCount || 1} tries)`);
    }
  }
  registry.candidates = stillCandidates;

  // 3. Coverage report against the institutions catalogue
  reportCoverage(registry);

  registry._lastRun = new Date().toISOString();

  const live = registry.active.filter((s) => s._status !== 'dead').length;
  console.log(`\nSummary: ${live}/${registry.active.length} active feeds live, ${promotedCount} promoted, ${registry.candidates.length} candidates remaining.`);

  if (doUpdate) {
    fs.writeFileSync(SOURCES_PATH, JSON.stringify(registry, null, 2) + '\n');
    console.log(`✅ Wrote ${SOURCES_PATH}`);
  } else {
    console.log('Dry-run complete. Use --update to write news-sources.json.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
