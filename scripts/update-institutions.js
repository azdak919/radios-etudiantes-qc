#!/usr/bin/env node
/**
 * RÉQ Institutions Bot
 *
 * Maintains institutions.json — the canonical catalogue of Québec higher-
 * education institutions (universities + cégeps) that the news bots refer
 * to. Runs 3×/year (winter / summer / fall terms) via GitHub Actions.
 *
 *  - Cégeps: pulled live from Wikidata (instances of CEGEP, Q1110056), so
 *    mergers / new campuses / renamed sites are picked up automatically.
 *  - Universities: a stable, curated base list (the Québec set effectively
 *    never changes); we still refresh their existence against Wikidata when
 *    possible.
 *
 * Resilient by design: if Wikidata is unreachable, the existing
 * institutions.json is preserved rather than wiped.
 *
 * No external dependencies.
 *
 * Usage:
 *   node scripts/update-institutions.js           # dry run
 *   node scripts/update-institutions.js --update  # writes institutions.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_PATH = path.join(__dirname, '..', 'institutions.json');
const UA = 'REQ-InstitutionsBot/1.0 (https://github.com/azdak919/radios-etudiantes-qc)';
const SPARQL = 'https://query.wikidata.org/sparql';
const CEGEP_QID = 'Q1110056';
const TIMEOUT = 60000;

// Curated canonical list of the public cégeps (Fédération des cégeps members).
// Wikidata types cégeps inconsistently (some as CEGEP, some as "collège", some
// missing), so we keep an authoritative base here and *enrich* it from Wikidata
// (websites, plus any extra/private colleges Wikidata knows). Stable: the set
// changes maybe once a decade. Source of truth for completeness.
const CEGEPS = [
  { name: "Cégep de l'Abitibi-Témiscamingue", region: 'Abitibi-Témiscamingue', website: 'https://www.cegepat.qc.ca/' },
  { name: 'Cégep André-Laurendeau', region: 'Montréal', website: 'https://www.claurendeau.qc.ca/' },
  { name: "Cégep d'Alma", region: 'Saguenay–Lac-Saint-Jean', website: 'https://www.cegepalma.ca/' },
  { name: 'Collège Ahuntsic', region: 'Montréal', website: 'https://www.collegeahuntsic.qc.ca/' },
  { name: 'Cégep de Baie-Comeau', region: 'Côte-Nord', website: 'https://www.cegep-baie-comeau.qc.ca/' },
  { name: 'Cégep Beauce-Appalaches', region: 'Chaudière-Appalaches', website: 'https://www.cegepba.qc.ca/' },
  { name: 'Collège de Bois-de-Boulogne', region: 'Montréal', website: 'https://www.bdeb.qc.ca/' },
  { name: 'Champlain Regional College', region: 'Estrie', website: 'https://www.champlaincollege.qc.ca/' },
  { name: 'Cégep de Chicoutimi', region: 'Saguenay–Lac-Saint-Jean', website: 'https://cchic.ca/' },
  { name: 'Dawson College', region: 'Montréal', website: 'https://www.dawsoncollege.qc.ca/' },
  { name: 'Cégep de Drummondville', region: 'Centre-du-Québec', website: 'https://www.cegepdrummond.ca/' },
  { name: 'Cégep Édouard-Montpetit', region: 'Montérégie', website: 'https://www.cegepmontpetit.ca/' },
  { name: 'Cégep Garneau', region: 'Capitale-Nationale', website: 'https://www.cegepgarneau.ca/' },
  { name: 'Cégep de la Gaspésie et des Îles', region: 'Gaspésie–Îles-de-la-Madeleine', website: 'https://www.cegepgim.ca/' },
  { name: 'Cégep Gérald-Godin', region: 'Montréal', website: 'https://www.cgodin.qc.ca/' },
  { name: 'Cégep de Granby', region: 'Montérégie', website: 'https://cegepgranby.qc.ca/' },
  { name: 'Collège Heritage', region: 'Outaouais', website: 'https://www.cegep-heritage.qc.ca/' },
  { name: 'John Abbott College', region: 'Montréal', website: 'https://www.johnabbott.qc.ca/' },
  { name: 'Cégep de Jonquière', region: 'Saguenay–Lac-Saint-Jean', website: 'https://www.cegepjonquiere.ca/' },
  { name: 'Cégep régional de Lanaudière', region: 'Lanaudière', website: 'https://www.cegep-lanaudiere.qc.ca/' },
  { name: 'Cégep de Lévis', region: 'Chaudière-Appalaches', website: 'https://www.cegeplevis.ca/' },
  { name: 'Cégep Limoilou', region: 'Capitale-Nationale', website: 'https://www.cegeplimoilou.ca/' },
  { name: 'Collège Lionel-Groulx', region: 'Laurentides', website: 'https://www.clg.qc.ca/' },
  { name: 'Collège de Maisonneuve', region: 'Montréal', website: 'https://www.cmaisonneuve.qc.ca/' },
  { name: 'Cégep Marie-Victorin', region: 'Montréal', website: 'https://www.collegemv.qc.ca/' },
  { name: 'Cégep de Matane', region: 'Bas-Saint-Laurent', website: 'https://www.cegep-matane.qc.ca/' },
  { name: 'Collège Montmorency', region: 'Laval', website: 'https://www.cmontmorency.qc.ca/' },
  { name: "Cégep de l'Outaouais", region: 'Outaouais', website: 'https://www.cegepoutaouais.qc.ca/' },
  { name: 'Cégep de Rimouski', region: 'Bas-Saint-Laurent', website: 'https://www.cegep-rimouski.qc.ca/' },
  { name: 'Cégep de Rivière-du-Loup', region: 'Bas-Saint-Laurent', website: 'https://www.cegeprdl.ca/' },
  { name: 'Cégep de La Pocatière', region: 'Bas-Saint-Laurent', website: 'https://www.cegeplapocatiere.qc.ca/' },
  { name: 'Collège de Rosemont', region: 'Montréal', website: 'https://www.crosemont.qc.ca/' },
  { name: 'Cégep de Saint-Félicien', region: 'Saguenay–Lac-Saint-Jean', website: 'https://cegepstfe.ca/' },
  { name: 'Cégep de Saint-Hyacinthe', region: 'Montérégie', website: 'https://www.cegepsth.qc.ca/' },
  { name: 'Cégep Saint-Jean-sur-Richelieu', region: 'Montérégie', website: 'https://www.cstjean.qc.ca/' },
  { name: 'Cégep de Saint-Jérôme', region: 'Laurentides', website: 'https://www.cstj.qc.ca/' },
  { name: 'Cégep de Saint-Laurent', region: 'Montréal', website: 'https://www.cegepsl.qc.ca/' },
  { name: 'Cégep de Sainte-Foy', region: 'Capitale-Nationale', website: 'https://www.cegep-ste-foy.qc.ca/' },
  { name: 'Cégep de Sept-Îles', region: 'Côte-Nord', website: 'https://www.cegepsept-iles.ca/' },
  { name: 'Cégep de Shawinigan', region: 'Mauricie', website: 'https://www.cegepshawinigan.ca/' },
  { name: 'Cégep de Sherbrooke', region: 'Estrie', website: 'https://www.cegepsherbrooke.qc.ca/' },
  { name: 'Cégep de Sorel-Tracy', region: 'Montérégie', website: 'https://www.cegepst.qc.ca/' },
  { name: 'Cégep de Thetford', region: 'Chaudière-Appalaches', website: 'https://www.cegepthetford.ca/' },
  { name: 'Cégep de Trois-Rivières', region: 'Mauricie', website: 'https://www.cegeptr.qc.ca/' },
  { name: 'Cégep de Valleyfield', region: 'Montérégie', website: 'https://www.colval.qc.ca/' },
  { name: 'Vanier College', region: 'Montréal', website: 'https://www.vaniercollege.qc.ca/' },
  { name: 'Cégep de Victoriaville', region: 'Centre-du-Québec', website: 'https://www.cegepvicto.ca/' },
  { name: 'Cégep du Vieux Montréal', region: 'Montréal', website: 'https://www.cvm.qc.ca/' },
];

// Curated, stable list of Québec universities (with official site + region).
// Universities in Québec change essentially never; this is the source of truth
// for them, kept in code so the bot is never empty if Wikidata is down.
const UNIVERSITIES = [
  { name: 'Université de Montréal', region: 'Montréal', website: 'https://www.umontreal.ca/' },
  { name: 'Université du Québec à Montréal (UQAM)', region: 'Montréal', website: 'https://uqam.ca/' },
  { name: 'McGill University', region: 'Montréal', website: 'https://www.mcgill.ca/' },
  { name: 'Concordia University', region: 'Montréal', website: 'https://www.concordia.ca/' },
  { name: 'HEC Montréal', region: 'Montréal', website: 'https://www.hec.ca/' },
  { name: 'Polytechnique Montréal', region: 'Montréal', website: 'https://www.polymtl.ca/' },
  { name: 'École de technologie supérieure (ÉTS)', region: 'Montréal', website: 'https://www.etsmtl.ca/' },
  { name: 'Université Laval', region: 'Capitale-Nationale', website: 'https://www.ulaval.ca/' },
  { name: 'Université du Québec (réseau)', region: 'Capitale-Nationale', website: 'https://www.uquebec.ca/' },
  { name: 'Université TÉLUQ', region: 'Capitale-Nationale', website: 'https://www.teluq.ca/' },
  { name: "Institut national de la recherche scientifique (INRS)", region: 'Capitale-Nationale', website: 'https://inrs.ca/' },
  { name: "École nationale d'administration publique (ENAP)", region: 'Capitale-Nationale', website: 'https://enap.ca/' },
  { name: 'Université de Sherbrooke', region: 'Estrie', website: 'https://www.usherbrooke.ca/' },
  { name: "Bishop's University", region: 'Estrie', website: 'https://www.ubishops.ca/' },
  { name: 'Université du Québec à Trois-Rivières (UQTR)', region: 'Mauricie', website: 'https://www.uqtr.ca/' },
  { name: 'Université du Québec à Chicoutimi (UQAC)', region: 'Saguenay–Lac-Saint-Jean', website: 'https://www.uqac.ca/' },
  { name: 'Université du Québec à Rimouski (UQAR)', region: 'Bas-Saint-Laurent', website: 'https://www.uqar.ca/' },
  { name: 'Université du Québec en Outaouais (UQO)', region: 'Outaouais', website: 'https://uqo.ca/' },
  { name: 'Université du Québec en Abitibi-Témiscamingue (UQAT)', region: 'Abitibi-Témiscamingue', website: 'https://www.uqat.ca/' },
];

function httpGet(url) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' }, timeout: TIMEOUT }, (res) => {
        if (res.statusCode >= 400) { res.resume(); return resolve(null); }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      });
    } catch { return resolve(null); }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function fetchCegeps() {
  const query = `SELECT ?item ?itemLabel ?website ?adminLabel WHERE {
    ?item wdt:P31/wdt:P279* wd:${CEGEP_QID} .
    OPTIONAL { ?item wdt:P856 ?website. }
    OPTIONAL { ?item wdt:P131 ?admin. }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
  }`;
  const url = `${SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const body = await httpGet(url);
  if (!body) return null;
  let json;
  try { json = JSON.parse(body); } catch { return null; }

  const seen = new Map();
  for (const r of json.results.bindings) {
    const name = r.itemLabel?.value?.trim();
    if (!name || /^Q\d+$/.test(name)) continue; // skip unlabelled items
    const wikidata = r.item?.value?.split('/').pop() || '';
    // Prefer the row that has a website if duplicates appear.
    const prev = seen.get(name);
    const entry = {
      name,
      type: 'cegep',
      region: '',
      location: r.adminLabel?.value || '',
      website: r.website?.value || (prev?.website || ''),
      wikidata,
      source: 'wikidata',
    };
    if (!prev || (!prev.website && entry.website)) seen.set(name, entry);
  }
  return [...seen.values()];
}

function buildUniversities() {
  return UNIVERSITIES.map((u) => ({
    name: u.name,
    type: 'universite',
    region: u.region,
    location: '',
    website: u.website,
    wikidata: '',
    source: 'curated',
  }));
}

// Normalized key to match a curated cégep with its Wikidata twin despite
// "Cégep"/"Collège" prefixes, accents, casing and punctuation differences.
function cegepKey(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(cegep|college|campus|de|du|des|la|le|les|et|d|l)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Merge the curated cégep base with Wikidata results: curated guarantees
// completeness + correct names/regions; Wikidata fills missing websites and
// contributes any extra colleges/campuses it knows (flagged source: wikidata).
// Stale/duplicate Wikidata variants to drop (the canonical entry is curated).
const DROP_KEYS = new Set([
  'granbyhauteyamaska', // old name of "Cégep de Granby"
]);

function mergeCegeps(curated, wiki) {
  const byKey = new Map();
  for (const c of curated) {
    byKey.set(cegepKey(c.name), {
      name: c.name,
      type: 'cegep',
      region: c.region,
      location: '',
      website: c.website || '',
      wikidata: '',
      source: 'curated',
    });
  }
  for (const w of wiki || []) {
    const k = cegepKey(w.name);
    if (DROP_KEYS.has(k)) continue;
    const hit = byKey.get(k);
    if (hit) {
      if (!hit.website && w.website) hit.website = w.website;
      if (w.wikidata) hit.wikidata = w.wikidata;
      if (w.location) hit.location = w.location;
      hit.source = 'both';
    } else {
      byKey.set(k, { ...w, type: 'cegep', region: w.region || '', source: 'wikidata' });
    }
  }
  return [...byKey.values()];
}

async function main() {
  const doUpdate = process.argv.includes('--update');
  console.log('RÉQ Institutions Bot\n====================\n');

  const universities = buildUniversities();
  console.log(`▸ Universities (curated): ${universities.length}`);

  console.log('▸ Cégeps: curated base + Wikidata enrichment…');
  const wiki = await fetchCegeps();
  if (wiki) {
    console.log(`  ✓ Wikidata returned ${wiki.length} entries`);
  } else {
    console.log('  ! Wikidata unreachable — using curated base only (still complete).');
  }
  const cegeps = mergeCegeps(CEGEPS, wiki);
  const enriched = cegeps.filter((c) => c.source === 'both').length;
  const extras = cegeps.filter((c) => c.source === 'wikidata').length;
  console.log(`  → ${cegeps.length} cégeps (${enriched} enrichis par Wikidata, ${extras} extras Wikidata)`);

  const institutions = [...universities, ...cegeps].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'universite' ? -1 : 1;
    return a.name.localeCompare(b.name, 'fr');
  });

  const out = {
    updated: new Date().toISOString(),
    source: 'Wikidata (cégeps) + liste curée (universités)',
    counts: {
      universite: institutions.filter((i) => i.type === 'universite').length,
      cegep: institutions.filter((i) => i.type === 'cegep').length,
      total: institutions.length,
    },
    institutions,
  };

  console.log(`\nTotal: ${out.counts.total} établissements (${out.counts.universite} universités, ${out.counts.cegep} cégeps).`);

  if (doUpdate) {
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
    console.log(`✅ Wrote ${OUT_PATH}`);
  } else {
    console.log('Dry-run complete. Use --update to write institutions.json.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
