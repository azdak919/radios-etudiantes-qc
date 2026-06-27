#!/usr/bin/env node
/**
 * Découverte + maintenance des sources d'horaires.
 *
 * Pour chaque poste, ce bot :
 *   1. revalide les sources déjà déclarées dans radio-schedules.seed.json ;
 *   2. sonde des sources potentielles avec les adaptateurs génériques
 *      (Airtime dérivé du flux, JSON-LD sur les pages d'horaire) et avec
 *      l'adaptateur dédié au poste (même id que la radio, s'il existe) ;
 *   3. détecte des plateformes connues (Spinitron) à brancher manuellement ;
 *   4. produit un rapport de santé : sources trouvées, perdues, postes sans
 *      horaire.
 *
 * Avec --update, écrit les sources validées dans le seed (les grilles
 * manuelles et les notes sont préservées).
 *
 *   node scripts/discover-schedule-sources.js            # rapport (dry-run)
 *   node scripts/discover-schedule-sources.js --update   # met à jour le seed
 */

const fs = require('fs');
const path = require('path');
const {
  ADAPTERS,
  runAdapter,
  fetchText,
  sourceLabel,
} = require('./radio-schedule-lib');

// sourceLabel n'est pas exporté par défaut ; repli local si absent.
const labelOf = typeof sourceLabel === 'function'
  ? sourceLabel
  : (s) => s.type + (s.base || s.url ? `:${s.base || s.url}` : '');

const ROOT = path.join(__dirname, '..');
const RADIOS_PATH = path.join(ROOT, 'radios.json');
const SEED_PATH = path.join(ROOT, 'radio-schedules.seed.json');
const doUpdate = process.argv.includes('--update');

// Chemins fréquents d'une page d'horaire à sonder en JSON-LD / adaptateur dédié.
const SCHEDULE_PATHS = [
  '/horaire/', '/grille-horaire/', '/grille/', '/programmation/',
  '/schedule/', '/shows/', '/emissions/', '/',
];

const MIN_SLOTS = 1; // une source est retenue si elle produit au moins ce nb de plages

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function normBase(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}

function dedupeSources(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const key = `${s.type}|${(s.base || s.url || '').replace(/\/+$/, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Déduit une base d'API Airtime/LibreTime à partir d'un flux. */
function airtimeBaseFromStream(stream) {
  const host = (() => { try { return new URL(stream).host; } catch { return ''; } })();
  if (!host) return null;
  // airtime.pro : "<station>.out.airtime.pro" → "https://<station>.airtime.pro"
  const m = /^([a-z0-9-]+)\.out\.airtime\.pro$/i.exec(host);
  if (m) return `https://${m[1]}.airtime.pro`;
  return null;
}

/** Construit la liste des sources à tester pour un poste. */
function candidatesFor(radio, seedCfg) {
  const out = [];

  // 1. Sources déjà déclarées (revalidation).
  for (const s of seedCfg.sources || []) {
    if (s && s.type) out.push({ ...s });
  }

  // 2. Airtime déduit du flux.
  const airtimeBase = radio.stream ? airtimeBaseFromStream(radio.stream) : null;
  if (airtimeBase) out.push({ type: 'airtime', base: airtimeBase });

  // 3. Adaptateur dédié au poste (id == nom d'adaptateur) + JSON-LD générique,
  //    testés sur les chemins d'horaire usuels du site officiel.
  const base = normBase(radio.website);
  if (base) {
    for (const p of SCHEDULE_PATHS) {
      const url = base + p;
      if (ADAPTERS[radio.id]) out.push({ type: radio.id, url });
      out.push({ type: 'jsonld', url });
    }
  }

  return dedupeSources(out);
}

/** Détecte une plateforme Spinitron référencée sur le site (jeton requis). */
async function detectSpinitron(radio, deps) {
  const base = normBase(radio.website);
  if (!base) return null;
  for (const p of ['/', '/schedule/', '/shows/']) {
    try {
      const html = await fetchText(base + p, deps);
      const m = /spinitron\.com\/([A-Za-z0-9_-]+)/i.exec(html);
      if (m) return m[1];
    } catch { /* page injoignable */ }
  }
  return null;
}

async function main() {
  const radios = readJson(RADIOS_PATH, []);
  const seed = readJson(SEED_PATH, { stations: {} });
  seed.stations = seed.stations || {};
  const configured = new Set(Object.keys(seed.stations));

  const deps = { timeoutMs: 20000 };
  const report = { found: [], lost: [], attention: [], stable: [] };

  for (const radio of radios) {
    const seedCfg = seed.stations[radio.id] || { sources: [], grid: [] };
    const prevLabels = new Set((seedCfg.sources || []).map(labelOf));

    const candidates = candidatesFor(radio, seedCfg);
    const working = [];

    for (const src of candidates) {
      try {
        const grid = await runAdapter(src, deps);
        if (grid && grid.length >= MIN_SLOTS) {
          working.push({ src, count: grid.length });
        }
      } catch { /* source injoignable — ignorée */ }
    }

    const workingSources = dedupeSources(working.map((w) => w.src));
    const workingLabels = new Set(workingSources.map(labelOf));

    // Spinitron : signalé pour branchement manuel (jeton API requis).
    if (!workingSources.length) {
      const station = await detectSpinitron(radio, deps);
      if (station) {
        report.attention.push(
          `${radio.id}: Spinitron détecté (station "${station}") — ajouter un jeton API dans le seed.`,
        );
      }
    }

    // Diff santé.
    for (const w of working) {
      if (!prevLabels.has(labelOf(w.src))) {
        report.found.push(`${radio.id}: + ${labelOf(w.src)} (${w.count} plages)`);
      }
    }
    for (const label of prevLabels) {
      if (!workingLabels.has(label)) {
        report.lost.push(`${radio.id}: − ${label} (ne répond plus)`);
      }
    }
    if (workingSources.length && !report.found.some((l) => l.startsWith(`${radio.id}:`))
      && !report.lost.some((l) => l.startsWith(`${radio.id}:`))) {
      report.stable.push(radio.id);
    }
    // On ne signale « grille manuelle requise » que pour les postes déjà suivis
    // dans le seed (éviter le bruit des postes sans flux ni horaire).
    if (configured.has(radio.id) && !seedCfg._nowPlayingOnly
      && !workingSources.length && !(seedCfg.grid || []).length) {
      report.attention.push(`${radio.id}: aucune source automatique — grille manuelle requise.`);
    }
    if (seedCfg._nowPlayingOnly) {
      report.stable.push(`${radio.id} (now-playing)`);
    }

    // Persiste seulement les postes déjà suivis ou qui ont une source validée
    // (on n'ajoute pas d'entrées vides pour les postes sans horaire).
    if (configured.has(radio.id) || workingSources.length) {
      seed.stations[radio.id] = { ...seedCfg, sources: workingSources };
    }
  }

  // Rapport.
  const line = (arr) => (arr.length ? arr.map((x) => `   ${x}`).join('\n') : '   (aucun)');
  console.log('\n══ Découverte des sources d\'horaires ══');
  console.log(`Nouvelles sources :\n${line(report.found)}`);
  console.log(`Sources perdues :\n${line(report.lost)}`);
  console.log(`À surveiller :\n${line(report.attention)}`);
  console.log(`Stables : ${report.stable.join(', ') || '(aucune)'}`);

  if (doUpdate) {
    fs.writeFileSync(SEED_PATH, `${JSON.stringify(seed, null, 2)}\n`);
    console.log(`\nÉcrit ${SEED_PATH}`);
  } else {
    console.log('\nDry-run — utilisez --update pour écrire le seed.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
