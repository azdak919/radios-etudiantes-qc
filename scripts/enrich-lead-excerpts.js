#!/usr/bin/env node
/**
 * Bot extrait « à la une » — récupère le premier paragraphe substantiel
 * depuis la page source (ex. Le Collectif : byline seule puis vrai lead).
 *
 *   node scripts/enrich-lead-excerpts.js
 *   node scripts/enrich-lead-excerpts.js --update
 */

const fs = require('fs');
const path = require('path');
const {
  fetchLeadExcerpt,
  selectEnrichmentCandidates,
  excerptLooksIncomplete,
  isLeadExcerptCandidate,
} = require('./lead-excerpt-lib');

const ROOT = path.join(__dirname, '..');
const NEWS_PATH = path.join(ROOT, 'news.json');
const QC_PATH = path.join(ROOT, 'lead-excerpt-qc.json');

const doUpdate = process.argv.includes('--update');
const FETCH_LIMIT = 35;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const news = readJson(NEWS_PATH, { items: [] });
  const items = news.items || [];
  if (!items.length) {
    console.error('No items in news.json');
    process.exit(1);
  }

  const candidates = selectEnrichmentCandidates(items, FETCH_LIMIT);
  const withLead = items.filter((i) => i.leadExcerpt && String(i.leadExcerpt).length >= 80).length;
  const pool = items.filter((item, index) => isLeadExcerptCandidate(item, index)).length;
  const incomplete = items.filter((item, index) =>
    isLeadExcerptCandidate(item, index) && excerptLooksIncomplete(item),
  ).length;

  console.log('Lead excerpt enrichment');
  console.log('=======================');
  console.log(`Articles          : ${items.length}`);
  console.log(`Pool vedette      : ${pool}`);
  console.log(`Extraits incomplets : ${incomplete}`);
  console.log(`Avec leadExcerpt  : ${withLead}`);
  console.log(`À traiter (max ${FETCH_LIMIT}) : ${candidates.length}`);

  const results = [];
  let enriched = 0;
  let failed = 0;

  for (const item of candidates) {
    process.stdout.write(`→ ${item.source}: ${item.title.slice(0, 48)}… `);
    const lead = await fetchLeadExcerpt(item);
    await sleep(250);

    if (!lead) {
      console.log('skip');
      failed += 1;
      results.push({ title: item.title, link: item.link, ok: false });
      continue;
    }

    const prev = String(item.leadExcerpt || '');
    const changed = lead !== prev;
    if (doUpdate && changed) item.leadExcerpt = lead;
    if (changed) enriched += 1;

    console.log(doUpdate && changed ? `✓ ${lead.length} car.` : `dry ${lead.length} car.`);
    results.push({
      title: item.title,
      link: item.link,
      ok: true,
      chars: lead.length,
      sample: lead.slice(0, 100),
      changed,
    });
  }

  const qc = {
    updated: new Date().toISOString(),
    total: items.length,
    pool,
    incomplete,
    withLeadExcerpt: withLead + (doUpdate ? enriched : 0),
    candidates: candidates.length,
    enriched: doUpdate ? enriched : 0,
    failed,
    ok: incomplete === 0 || (withLead + enriched) >= Math.min(pool, 4),
    samples: results.filter((r) => r.ok).slice(0, 8),
  };

  if (doUpdate && enriched > 0) {
    fs.writeFileSync(NEWS_PATH, JSON.stringify({ ...news, items }, null, 2) + '\n');
    console.log(`\n✅ ${enriched} leadExcerpt écrit(s) dans news.json`);
  } else if (doUpdate) {
    console.log('\nRien à écrire.');
  } else if (enriched > 0) {
    console.log('\nDry-run. Utilisez --update pour écrire news.json.');
  }

  fs.writeFileSync(QC_PATH, JSON.stringify(qc, null, 2) + '\n');
  console.log(`✅ ${QC_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});