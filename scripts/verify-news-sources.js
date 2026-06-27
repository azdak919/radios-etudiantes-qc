#!/usr/bin/env node
/**
 * Vérifie que chaque source active est bien intégrée à Le Radar.
 *
 *   node scripts/verify-news-sources.js
 *   node scripts/verify-news-sources.js --name "The Concordian"
 *   node scripts/verify-news-sources.js --strict   # exit 1 si échec
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  isHtmlListSource,
  countHtmlListItems,
  latestHtmlListDate,
} = require('./html-list-fetcher');
const { isFirebaseSource, classifyFirebaseSource } = require('./firebase-list-fetcher');

const ROOT = path.join(__dirname, '..');
const REQUIRED = ['name', 'institution', 'region', 'type', 'lang', 'url'];

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const nameFilter = args.includes('--name') ? args[args.indexOf('--name') + 1] : null;

function readJson(rel, fallback = null) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return fallback; }
}

function normInst(name = '') {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function fetchFeed(url, timeout = 12000) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LE-RADAR-VerifyBot/1.0)',
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
        timeout,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchFeed(new URL(res.headers.location, url).toString(), timeout));
        }
        if (res.statusCode >= 400) {
          res.resume();
          return resolve({ ok: false, status: res.statusCode, body: '' });
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
      },
    );
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '' }); });
  });
}

function isFeed(xml = '') {
  return /<rss[\s>]|<feed[\s>]/i.test(xml.slice(0, 600));
}

function countFeedItems(xml = '') {
  return (xml.match(/<item[\s>]/gi) || xml.match(/<entry[\s>]/gi) || []).length;
}

function institutionKnown(name, institutions) {
  const n = normInst(name);
  return (institutions.institutions || []).some((i) => {
    const key = normInst(i.name);
    return key === n || key.includes(n) || n.includes(key);
  });
}

function institutionBranded(name, brand) {
  if (brand.institutions?.[name]) return true;
  const n = normInst(name);
  return Object.keys(brand.institutions || {}).some((k) => normInst(k) === n);
}

async function verifySource(src, ctx) {
  const issues = [];
  const warnings = [];
  const ok = [];

  for (const field of REQUIRED) {
    if (!src[field]) issues.push(`champ requis manquant : ${field}`);
  }

  const dupes = ctx.active.filter((s) => s.name === src.name);
  if (dupes.length > 1) issues.push('nom dupliqué dans active');

  const sameUrl = ctx.active.filter((s) => s.url === src.url && s.name !== src.name);
  if (sameUrl.length) issues.push(`URL RSS partagée avec : ${sameUrl.map((s) => s.name).join(', ')}`);

  if (src.popularity == null) warnings.push('popularité absente (filtres UI en fin de liste)');

  if (!institutionKnown(src.institution, ctx.institutions)) {
    warnings.push(`institution absente de institutions.json : ${src.institution}`);
  }
  if (!institutionBranded(src.institution, ctx.brand)) {
    warnings.push(`couleur de marque manquante dans brand-colors.json : ${src.institution}`);
  }

  const articles = ctx.newsCounts[src.name] || 0;
  if (articles === 0) warnings.push('aucun article dans news.json (lancer fetch-news.js --update)');
  else ok.push(`${articles} article(s) dans news.json`);

  const social = ctx.socialNames.has(src.name);
  if (!social) warnings.push('absent de social-feed.json (optionnel — fetch-social.js --update)');

  const feedCandidates = [src.url, src.urlFallback, ...(src.feedAlternates || [])].filter(Boolean);
  if (isFirebaseSource(src)) {
    const { status, lastItemDate, count } = await classifyFirebaseSource(src);
    if (!count) issues.push('Firestore inaccessible ou aucun article publié');
    else {
      ok.push(`mode firebase OK (${count} articles)`);
      if (lastItemDate) ok.push(`dernier article : ${lastItemDate.slice(0, 10)}`);
    }
    if (status === 'dead') warnings.push('source marquée dead (articles trop anciens)');
  } else if (feedCandidates.length) {
    if (isHtmlListSource(src)) {
      let listHit = null;
      let listUsed = '';
      for (const listUrl of [...new Set(feedCandidates)]) {
        const page = await fetchFeed(listUrl);
        if (page.ok && countHtmlListItems(page.body, listUrl) > 0) {
          listHit = page;
          listUsed = listUrl;
          break;
        }
      }
      if (!listHit) {
        issues.push(`page liste HTML inaccessible ou vide (${feedCandidates.join(' → ')})`);
      } else {
        const n = countHtmlListItems(listHit.body, listUsed);
        const latest = latestHtmlListDate(listHit.body, listUsed);
        ok.push(`mode html-list OK (${n} articles)`);
        if (latest) ok.push(`dernier article : ${latest.slice(0, 10)}`);
        if (listUsed !== src.url) {
          warnings.push(`page principale inaccessible — repli actif : ${listUsed}`);
        }
      }
    } else {
      let feedHit = null;
      let feedUsed = '';
      for (const feedUrl of [...new Set(feedCandidates)]) {
        const feed = await fetchFeed(feedUrl);
        if (feed.ok && isFeed(feed.body)) {
          feedHit = feed;
          feedUsed = feedUrl;
          break;
        }
      }
      if (!feedHit) {
        issues.push(`aucun flux RSS joignable (${feedCandidates.join(' → ')})`);
        if (src.urlFallback && src.url !== src.urlFallback) {
          warnings.push('site principal bloqué ? Vérifier urlFallback (contenu partiel possible)');
        }
      } else {
        const n = countFeedItems(feedHit.body);
        if (feedUsed !== src.url) {
          warnings.push(`flux principal inaccessible — repli actif : ${feedUsed}`);
        } else {
          ok.push(`flux principal OK (${n} entrées)`);
        }
        if (n === 0) warnings.push('flux RSS vide');
        else if (feedUsed === src.url) ok.push(`${n} entrées`);
      }
    }
  }

  const peers = ctx.active.filter(
    (s) => s.institution === src.institution && s.name !== src.name,
  );
  if (peers.length) {
    ok.push(`coexistence : ${peers.length} autre(s) journal(aux) à ${src.institution} (${peers.map((p) => p.name).join(', ')})`);
  }

  return { name: src.name, issues, warnings, ok };
}

async function main() {
  const registry = readJson('news-sources.json', { active: [], candidates: [] });
  const news = readJson('news.json', { items: [] });
  const social = readJson('social-feed.json', { items: [] });
  const institutions = readJson('institutions.json', { institutions: [] });
  const brand = readJson('brand-colors.json', { institutions: {} });

  const active = (registry.active || []).filter((s) => s._status !== 'dead');
  const targets = nameFilter ? active.filter((s) => s.name === nameFilter) : active;

  if (!targets.length) {
    console.error(nameFilter ? `Source introuvable : ${nameFilter}` : 'Aucune source active.');
    process.exit(1);
  }

  const newsCounts = {};
  for (const item of news.items || []) {
    newsCounts[item.source] = (newsCounts[item.source] || 0) + 1;
  }
  const socialNames = new Set((social.items || []).map((i) => i.name));

  const ctx = { active, institutions, brand, newsCounts, socialNames };
  let fail = 0;

  console.log('LE RADAR — Vérification des sources\n===================================\n');

  for (const src of targets) {
    const r = await verifySource(src, ctx);
    const icon = r.issues.length ? '✗' : r.warnings.length ? '△' : '✓';
    console.log(`${icon} ${r.name}`);
    console.log(`   ${src.institution} · ${src.url}`);
    r.ok.forEach((m) => console.log(`   ✓ ${m}`));
    r.warnings.forEach((m) => console.log(`   △ ${m}`));
    r.issues.forEach((m) => console.log(`   ✗ ${m}`));
    if (r.issues.length) fail += 1;
    console.log('');
  }

  console.log('Protocole après ajout manuel :');
  console.log('  1. news-sources.json → active (name, institution, region, type, lang, url, popularity)');
  console.log('  2. node scripts/verify-news-sources.js --name "<journal>"');
  console.log('  3. node scripts/fetch-news.js --update');
  console.log('  4. node scripts/ensure-lead-images.js --update');
  console.log('  5. node scripts/fetch-social.js --update  (si site public)');
  console.log('  6. Incrémenter CACHE_NAME dans sw.js');
  console.log('  7. git commit + push\n');

  if (fail && strict) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});