#!/usr/bin/env node
/**
 * QC auteurs — byline page > extrait « Par … » > RSS (si fiable).
 * En cas de doute : « La rédaction » / « The editorial team ».
 *
 *   node scripts/verify-authors.js
 *   node scripts/verify-authors.js --update
 *   node scripts/verify-authors.js --strict
 */

const fs = require('fs');
const path = require('path');
const { fetchText } = require('./article-image-lib');
const {
  auditAuthors,
  reconcileAuthor,
  authorFromArticleHtml,
  detectFeedDefaultAuthors,
  needsPageAuthorVerification,
  normalizeArticleUrl,
} = require('./author-lib');
const { pruneToFreshWindow, loadSourceRegistryMap, getBotHints } = require('./source-retention-lib');

const ROOT = path.join(__dirname, '..');
const NEWS_PATH = path.join(ROOT, 'news.json');
const QC_PATH = path.join(ROOT, 'author-qc.json');

const PAGE_FETCH_TIMEOUT = 12000;
const PAGE_FETCH_DELAY = 200;

const args = process.argv.slice(2);
const doUpdate = args.includes('--update');
const strict = args.includes('--strict');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPageAuthors(items, feedDefaults, sourceMap = new Map()) {
  const pageAuthors = new Map();
  const toFetch = items
    .filter((item) => {
      const hints = getBotHints(sourceMap.get(item.source), 'authors');
      return needsPageAuthorVerification(item, feedDefaults, hints);
    })
    .sort((a, b) => {
      const ah = getBotHints(sourceMap.get(a.source), 'authors').forcePageAuthor ? 0 : 1;
      const bh = getBotHints(sourceMap.get(b.source), 'authors').forcePageAuthor ? 0 : 1;
      return ah - bh;
    });

  if (!toFetch.length) return pageAuthors;

  console.log(`\nVérification page source : ${toFetch.length} article(s)`);

  let fetched = 0;
  for (const item of toFetch) {
    const key = normalizeArticleUrl(item.link);
    if (!key || pageAuthors.has(key)) continue;

    const html = await fetchText(item.link, 3, PAGE_FETCH_TIMEOUT);
    const hints = getBotHints(sourceMap.get(item.source), 'authors');
    const author = authorFromArticleHtml(html, item.lang === 'en' ? 'en' : 'fr', hints, item.source);
    if (author) pageAuthors.set(key, author);
    fetched += 1;

    if (fetched % 5 === 0 || fetched === toFetch.length) {
      process.stdout.write(`  … ${fetched}/${toFetch.length}\r`);
    }
    await sleep(PAGE_FETCH_DELAY);
  }

  console.log(`  ✓ ${fetched} page(s) consultée(s), ${pageAuthors.size} auteur(s) extrait(s)`);
  return pageAuthors;
}

async function main() {
  const news = readJson(NEWS_PATH, { items: [] });
  const allItems = news.items || [];
  if (!allItems.length) {
    console.error('No items in news.json');
    process.exit(1);
  }

  const sourceMap = loadSourceRegistryMap();
  const items = pruneToFreshWindow(allItems);
  const feedDefaults = detectFeedDefaultAuthors(items);
  const pageAuthors = await fetchPageAuthors(items, feedDefaults, sourceMap);
  const { mismatches, fixable, total } = auditAuthors(items, { feedDefaults, pageAuthors });
  const withAuthor = items.filter((i) => i.author && String(i.author).trim()).length;

  console.log('Author QC');
  console.log('==========');
  console.log(`Articles        : ${total}`);
  console.log(`Avec auteur     : ${withAuthor}`);
  console.log(`À corriger      : ${fixable}`);

  if (mismatches.length) {
    console.log('\nConflits / corrections :');
    mismatches.slice(0, 12).forEach((m) => {
      const from = m.fieldAuthor ? `"${m.fieldAuthor}"` : '(vide)';
      console.log(`  · ${m.title}`);
      console.log(`    ${from} → "${m.canonicalAuthor}" (${m.source}) [${m.reason}]`);
    });
    if (mismatches.length > 12) {
      console.log(`  … et ${mismatches.length - 12} autres`);
    }
  } else {
    console.log('\nAucun conflit détecté.');
  }

  const qc = {
    updated: new Date().toISOString(),
    total,
    withAuthor,
    mismatches: fixable,
    ok: fixable === 0,
    samples: mismatches.slice(0, 20),
  };

  if (doUpdate && fixable > 0) {
    const freshKeys = new Set(items.map((i) => normalizeArticleUrl(i.link)));
    const nextItems = allItems.map((item) => {
      if (!freshKeys.has(normalizeArticleUrl(item.link))) return item;
      const pageAuthor = pageAuthors.get(normalizeArticleUrl(item.link)) || '';
      return reconcileAuthor(item, items, {
        applyFallback: true,
        feedDefaults,
        pageAuthor,
      }).item;
    });
    fs.writeFileSync(NEWS_PATH, JSON.stringify({ ...news, items: nextItems, count: nextItems.length }, null, 2) + '\n');
    console.log(`\n✅ ${fixable} auteur(s) corrigé(s) dans news.json`);
    qc.fixed = fixable;
    qc.ok = true;
  } else if (doUpdate) {
    console.log('\nRien à écrire.');
  } else if (fixable > 0) {
    console.log('\nDry-run. Utilisez --update pour corriger news.json.');
  }

  fs.writeFileSync(QC_PATH, JSON.stringify(qc, null, 2) + '\n');
  console.log(`✅ ${QC_PATH}`);

  if (strict && fixable > 0 && !doUpdate) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});