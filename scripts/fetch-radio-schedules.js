#!/usr/bin/env node
/**
 * Bot horaires — collige la grille hebdomadaire de chaque poste depuis
 * plusieurs sources (Airtime/LibreTime + grilles manuelles du seed) et écrit
 * radio-schedules.json. Le site y lit l'émission en cours selon l'heure.
 *
 * Comme les horaires changent rarement, ce bot tourne aux deux semaines.
 *
 *   node scripts/fetch-radio-schedules.js            # dry-run
 *   node scripts/fetch-radio-schedules.js --update   # écrit radio-schedules.json
 */

const fs = require('fs');
const path = require('path');
const { collateStationGrid, DEFAULT_TZ } = require('./radio-schedule-lib');

const ROOT = path.join(__dirname, '..');
const RADIOS_PATH = path.join(ROOT, 'radios.json');
const SEED_PATH = path.join(ROOT, 'radio-schedules.seed.json');
const OUT_PATH = path.join(ROOT, 'radio-schedules.json');
const doUpdate = process.argv.includes('--update');

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const radios = readJson(RADIOS_PATH, []);
  const seed = readJson(SEED_PATH, { stations: {} });
  const prev = readJson(OUT_PATH, { stations: {} });
  const timezone = seed.timezone || DEFAULT_TZ;
  const now = new Date().toISOString();

  const stations = {};
  let totalSlots = 0;

  for (const radio of radios) {
    const cfg = seed.stations?.[radio.id];
    if (!cfg) continue; // pas de config horaire pour ce poste

    const { grid, sources } = await collateStationGrid(cfg, {
      onError: (src, err) =>
        console.warn(`  ! ${radio.id} source ${src.type}: ${err.message}`),
    });

    let finalGrid = grid;
    let finalSources = sources;
    let checkedAt = now;
    let carried = false;

    // Résilience : si toutes les sources sont injoignables ce cycle mais qu'on
    // avait déjà une grille, on conserve la dernière connue.
    if (!finalGrid.length && prev.stations?.[radio.id]?.grid?.length) {
      finalGrid = prev.stations[radio.id].grid;
      finalSources = prev.stations[radio.id].sources || [];
      checkedAt = prev.stations[radio.id].checkedAt || now;
      carried = true;
    }

    if (!finalGrid.length) {
      if (!cfg._nowPlayingOnly) {
        console.log(`  · ${radio.id}: aucune plage (sources vides)`);
      }
      continue;
    }

    stations[radio.id] = {
      id: radio.id,
      name: radio.name,
      sources: finalSources,
      checkedAt,
      grid: finalGrid,
    };
    totalSlots += finalGrid.length;
    console.log(
      `  ✓ ${radio.id}: ${finalGrid.length} plages [${finalSources.join(', ') || '—'}]${carried ? ' (conservé)' : ''}`,
    );
  }

  const out = { updatedAt: now, timezone, stations };

  console.log(
    `\n${Object.keys(stations).length} postes avec horaire, ${totalSlots} plages au total.`,
  );

  const playable = radios.filter((r) => r.stream);
  const uncovered = [];
  console.log('\n── Couverture postes natifs ──');
  for (const radio of playable) {
    const cfg = seed.stations?.[radio.id];
    if (!cfg) {
      uncovered.push(radio.id);
      console.log(`  ? ${radio.id}: absent du seed — non mis à jour par ce bot`);
    } else if (cfg._nowPlayingOnly) {
      console.log(`  ○ ${radio.id}: now-playing seulement (fetch-radio-nowplaying.js)`);
    } else if (!stations[radio.id] && !(cfg.grid || []).length && !(cfg.sources || []).length) {
      uncovered.push(radio.id);
      console.log(`  ! ${radio.id}: seed sans source ni grille manuelle`);
    }
  }
  if (uncovered.length) {
    console.warn(`\n⚠ ${uncovered.length} poste(s) natif(s) sans horaire : ${uncovered.join(', ')}`);
  }

  if (doUpdate) {
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`Écrit ${OUT_PATH}`);
  } else {
    console.log('Dry-run — utilisez --update pour écrire radio-schedules.json');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
