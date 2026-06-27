#!/usr/bin/env node
/**
 * Bot « à l'antenne » — titre en ondes pour chaque poste natif (radios.json).
 * Sources : ICY du flux, ou API Craft (/api/live) pour CHOQ.
 * Tourne aux 30 min (workflow update-radio-nowplaying.yml).
 * Les grilles hebdomadaires sont dans fetch-radio-schedules.js (aux 2 semaines).
 *
 *   node scripts/fetch-radio-nowplaying.js
 *   node scripts/fetch-radio-nowplaying.js --update
 */

const fs = require('fs');
const path = require('path');
const { probeNowPlaying } = require('./radio-nowplaying-lib');

const ROOT = path.join(__dirname, '..');
const RADIOS_PATH = path.join(ROOT, 'radios.json');
const OUT_PATH = path.join(ROOT, 'radio-nowplaying.json');
const doUpdate = process.argv.includes('--update');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const radios = readJson(RADIOS_PATH, []);
  const playable = radios.filter((r) => r.stream);
  const stations = {};
  let hits = 0;

  for (const radio of playable) {
    const hit = await probeNowPlaying(radio);
    stations[radio.id] = {
      id: radio.id,
      name: radio.name,
      showTitle: hit.showTitle || '',
      host: hit.host || '',
      source: hit.source,
      checkedAt: new Date().toISOString(),
    };
    if (hit.showTitle) {
      hits += 1;
      console.log(`  ✓ ${radio.id}: ${hit.showTitle}`);
    } else {
      console.log(`  · ${radio.id}: (pas de titre flux — repli nom + slogan)`);
    }
    await sleep(400);
  }

  const out = {
    updatedAt: new Date().toISOString(),
    stations,
  };

  console.log(`\n${hits}/${playable.length} postes avec titre à l'antenne détecté.`);

  if (doUpdate) {
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`Écrit ${OUT_PATH}`);
  } else {
    console.log('Dry-run — utilisez --update pour écrire radio-nowplaying.json');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});