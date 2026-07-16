#!/usr/bin/env node
/**
 * LE RADAR — Full Québec student-media discovery report (read-only).
 *
 * Scans every institution in institutions.json for student newspaper signals
 * (never promotes institutional /feed portals). Cross-checks a curated seed
 * list of known campus papers. Writes docs/scan-qc-report.md + JSON summary.
 *
 * Usage:
 *   node scripts/scan-qc-report.js
 *   node scripts/scan-qc-report.js --out docs/scan-qc-report.md
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const INSTITUTIONS_PATH = path.join(ROOT, 'institutions.json');
const NEWS_SOURCES_PATH = path.join(ROOT, 'news-sources.json');
const RADIOS_PATH = path.join(ROOT, 'radios.json');
const RADIOS_CANDIDATES_PATH = path.join(ROOT, 'radios-candidates.json');

const TIMEOUT = 10000;
const CONCURRENCY = 4;
const MAX_LINKS = 8;
const FRESH_DAYS = 540; // ~18 months for "potentially live"
const FEED_PATHS = ['feed/', 'feed', '?feed=rss2', 'rss/', 'rss', 'index.xml', 'atom.xml'];

const NEWS_HINTS = /journal|étudiant|etudiant|student|newspaper|quartier|exemplaire|collectif|délit|delit|tribune|daily|link|pige|exil|campus|gazette|review|revue|trait.?union|griffonnier|oisif|gifle|brise.?glace|concordian|polyscope|plant\b|the.?campus|le.?d[eé]lit|motdit|mosaïk|mosaik|charlatan|forge|phénix|phenix|squat|l.?inter|intercoll[eé]gial|l.?oreille|oreille|bandana|impact|perspective|scribe|courier|courrier|voice|sentinel|mirror|free\s*press|libellule|réservoir|reservoir|phare|agora|étincelle|etincelle|hublot|entre-guillemets|entre.?guillemets|bref|le.?chat|point\.?com|saturne|artichaut|carcajou/i;
const RADIO_HINTS = /\bradio\b|\bfm\b|\bam\b|écoute|ecoute|listen|stream|webradio|campus.?radio|choq|chyz|cism|ckut|cjlo|cfou|cfak|cjep|crem/i;
const INSTITUTIONAL_PLACEHOLDER = /^m[eé]dia\s*[—–\-:]/i;
const WEAK_NEWS_LABEL = /^(actualit[eé]s?|nouvelles?|news|communiqu[eé]s?|presse|media|média|publications?)$/i;

/**
 * Known / historically attested Québec student papers (seeds to probe even if
 * not linked from the institution home page). name = journal; never institution.
 */
const SEED_PAPERS = [
  // Already active — still listed for coverage matrix
  { name: 'Quartier Libre', institution: 'Université de Montréal', region: 'Montréal', site: 'https://quartierlibre.ca/', lang: 'fr' },
  { name: 'Montréal Campus', institution: 'UQAM', region: 'Montréal', site: 'https://montrealcampus.ca/', lang: 'fr' },
  { name: 'Le Délit', institution: 'Université McGill', region: 'Montréal', site: 'https://www.delitfrancais.com/', lang: 'fr' },
  { name: 'The McGill Daily', institution: 'McGill University', region: 'Montréal', site: 'https://www.mcgilldaily.com/', lang: 'en' },
  { name: 'The Link', institution: 'Concordia University', region: 'Montréal', site: 'https://thelinknewspaper.ca/', lang: 'en' },
  { name: 'The Concordian', institution: 'Concordia University', region: 'Montréal', site: 'https://theconcordian.com/', lang: 'en', note: 'retired active (Cloudflare)' },
  { name: 'Zone Campus', institution: 'Université du Québec à Trois-Rivières', region: 'Mauricie', site: 'https://www.zonecampus.ca/', lang: 'fr' },
  { name: "L'Exemplaire", institution: 'Université Laval', region: 'Capitale-Nationale', site: 'https://www.exemplaire.com.ulaval.ca/', lang: 'fr' },
  { name: 'Le Collectif', institution: 'Université de Sherbrooke', region: 'Estrie', site: 'https://lecollectif.ca/', lang: 'fr' },
  { name: 'Exil', institution: 'Cégep du Vieux Montréal', region: 'Montréal', site: 'https://exilecvm.ca/', lang: 'fr' },
  { name: 'La Pige', institution: 'Cégep de Jonquière', region: 'Saguenay–Lac-Saint-Jean', site: 'https://lapige.atmjonquiere.com/', lang: 'fr' },
  { name: 'Le Polyscope', institution: 'Polytechnique Montréal', region: 'Montréal', site: 'https://www.polyscope.qc.ca/', lang: 'fr' },
  { name: 'The Tribune', institution: 'McGill University', region: 'Montréal', site: 'https://www.thetribune.ca/', lang: 'en' },
  { name: 'The Campus', institution: "Bishop's University", region: 'Estrie', site: 'https://thebucampus.ca/', lang: 'en' },
  { name: 'The Plant', institution: 'Dawson College', region: 'Montréal', site: 'https://theplantnews.com/', lang: 'en' },
  // Staged candidates
  { name: 'Le Griffonnier', institution: 'Université du Québec à Chicoutimi', region: 'Saguenay–Lac-Saint-Jean', site: 'https://ceuc.ca/', lang: 'fr' },
  { name: "L'Oisif", institution: 'Cégep de Chicoutimi', region: 'Saguenay–Lac-Saint-Jean', site: 'https://cchic.ca/categorie/journal-etudiant-loisif/', lang: 'fr' },
  { name: "Le Trait d'Union", institution: 'Collège de Maisonneuve', region: 'Montréal', site: 'https://letraitdunion.org/', lang: 'fr' },
  { name: 'La Gifle', institution: 'Collège Lionel-Groulx', region: 'Laurentides', site: 'https://lagifleblog.wordpress.com/', lang: 'fr' },
  { name: 'Le Brise-Glace', institution: 'Cégep de Rimouski', region: 'Bas-Saint-Laurent', site: 'https://lebrise-glace.com/', lang: 'fr' },
  // Additional known / likely papers to probe
  // Wikipedia + FPJQ / historical campus press (URLs are hypotheses; probe verifies)
  { name: 'Impact Campus', institution: 'Université Laval', region: 'Capitale-Nationale', site: 'https://impactcampus.ca/', lang: 'fr', note: 'Journal étudiant généraliste ULaval (Wiki)' },
  { name: "L'Heuristique", institution: 'École de technologie supérieure (ÉTS)', region: 'Montréal', site: 'https://lheuris.ca/', lang: 'fr', alt: ['https://www.lheuris.ca/', 'https://heuristique.ca/'] },
  { name: "L'Unité", institution: 'UQAM', region: 'Montréal', site: 'https://lunite.org/', lang: 'fr', alt: ['https://www.lunite.org/'] },
  { name: 'Le MotDit', institution: 'Cégep Édouard-Montpetit', region: 'Montérégie', site: 'https://lemotdit.com/', lang: 'fr', alt: ['https://www.lemotdit.com/'] },
  { name: "L'Attribut", institution: 'Collège Ahuntsic', region: 'Montréal', site: 'https://lattribut.com/', lang: 'fr' },
  { name: "L'IntégrAL", institution: 'Cégep André-Laurendeau', region: 'Montréal', site: 'https://lintegral.ca/', lang: 'fr' },
  { name: "L'Infomane", institution: 'Collège de Bois-de-Boulogne', region: 'Montréal', site: 'https://linfomane.com/', lang: 'fr' },
  { name: 'Pastiche', institution: 'Cégep de Saint-Laurent', region: 'Montréal', site: 'https://pastichesl.com/', lang: 'fr' },
  { name: 'Le Phoque', institution: 'Cégep Limoilou', region: 'Capitale-Nationale', site: 'https://lephoque.ca/', lang: 'fr' },
  { name: "L'Éclosion", institution: 'Cégep de Sainte-Foy', region: 'Capitale-Nationale', site: 'https://leclosion.ca/', lang: 'fr' },
  { name: 'Le Typographe', institution: 'Collège Montmorency', region: 'Laval', site: 'https://letypographe.ca/', lang: 'fr' },
  { name: 'Le Lunatique', institution: 'Collège Montmorency', region: 'Laval', site: 'https://lelunatique.ca/', lang: 'fr' },
  { name: 'Le Matricule Zéro', institution: 'Cégep de Sherbrooke', region: 'Estrie', site: 'https://matriculezero.ca/', lang: 'fr' },
  { name: 'Le Dogme', institution: 'Cégep de Saint-Hyacinthe', region: 'Montérégie', site: 'https://ledogme.ca/', lang: 'fr' },
  { name: 'Météorites', institution: 'Cégep de La Pocatière', region: 'Bas-Saint-Laurent', site: 'https://meteorites.ca/', lang: 'fr' },
  { name: 'Le Visionnaire', institution: 'Cégep de Baie-Comeau', region: 'Côte-Nord', site: 'https://levisionnaire.ca/', lang: 'fr' },
  { name: 'Le Graffitti', institution: 'Collège Jean-de-Brébeuf', region: 'Montréal', site: 'https://legraffitti.com/', lang: 'fr' },
  { name: 'Le Point G', institution: 'Collège André-Grasset', region: 'Montréal', site: 'https://lepointg.ca/', lang: 'fr' },
  { name: 'The Papercut', institution: 'Marianopolis College', region: 'Montréal', site: 'https://thepapercut.com/', lang: 'en' },
  { name: 'The Free Press', institution: 'John Abbott College', region: 'Montréal', site: 'https://jacfreepress.com/', lang: 'en', alt: ['https://www.jacfreepress.com/'] },
  { name: 'The Bull & Bear', institution: 'McGill University', region: 'Montréal', site: 'https://bullandbearmcgill.com/', lang: 'en' },
  { name: "L'Obiter", institution: 'Université de Sherbrooke', region: 'Estrie', site: 'https://lobiter.com/', lang: 'fr', note: 'Journal de droit — niche' },
  { name: 'Le Soufflet', institution: 'Université du Québec à Rimouski (UQAR)', region: 'Bas-Saint-Laurent', site: 'https://lesoufflet.ca/', lang: 'fr' },
  { name: 'L’Organe', institution: 'Concordia University', region: 'Montréal', site: 'https://lorgane.ca/', lang: 'fr' },
  { name: "L'Artichaut", institution: 'UQAM', region: 'Montréal', site: 'https://lartichaut.ca/', lang: 'fr', note: 'Journal des arts UQAM (Wiki)' },
  { name: 'The Chronos', institution: 'Champlain College Saint-Lambert', region: 'Montérégie', site: 'https://thechronos.com/', lang: 'en' },
  { name: 'Le Scribe', institution: "Cégep de l'Outaouais", region: 'Outaouais', site: 'https://lescribe.ca/', lang: 'fr' },
  { name: "L'Agora", institution: 'Université du Québec en Outaouais (UQO)', region: 'Outaouais', site: 'https://lagora.ca/', lang: 'fr' },
  { name: 'Perspectives', institution: 'Université du Québec en Abitibi-Témiscamingue (UQAT)', region: 'Abitibi-Témiscamingue', site: 'https://perspectivesuqat.ca/', lang: 'fr' },
  { name: 'Le Carcajou', institution: "Cégep de l'Abitibi-Témiscamingue", region: 'Abitibi-Témiscamingue', site: 'https://lecarcajou.ca/', lang: 'fr' },
  { name: 'Le Réservoir', institution: 'Cégep de Trois-Rivières', region: 'Mauricie', site: 'https://lereservoir.ca/', lang: 'fr' },
  { name: 'La Forge', institution: 'Cégep de Trois-Rivières', region: 'Mauricie', site: 'https://laforge.cegeptr.qc.ca/', lang: 'fr' },
  { name: 'Le Phare', institution: 'Cégep de la Gaspésie et des Îles', region: 'Gaspésie–Îles-de-la-Madeleine', site: 'https://lepharegim.com/', lang: 'fr' },
  { name: 'Entre-Guillemets', institution: 'Cégep Garneau', region: 'Capitale-Nationale', site: 'https://entreguillemets.com/', lang: 'fr' },
  // NOTE: lehublot.net is "Fabrique numérique de territoire" — NOT a campus paper (false positive if feed-only checked)
  { name: 'Le Hublot', institution: 'Cégep de Sainte-Foy', region: 'Capitale-Nationale', site: 'https://lehublot.net/', lang: 'fr', note: 'OUT OF SCOPE — not a student newspaper (digital fab / territoire)' },
  { name: 'Mosaïk', institution: 'Collège Stanislas', region: 'Montréal', site: 'https://stanislas96.wixsite.com/mosaik', lang: 'fr', note: 'Wiki: Stanislas; collège privé' },
  { name: "L'Inter", institution: 'Collège de Maisonneuve', region: 'Montréal', site: 'https://linter.ca/', lang: 'fr' },
];

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function norm(s = '') {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function hostKey(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return norm(url);
  }
}

function isInstitutionHost(linkOrFeed, instWebsite) {
  const h = hostKey(linkOrFeed);
  const instH = hostKey(instWebsite);
  if (!h || !instH) return false;
  return h === instH || h.endsWith(`.${instH}`) || instH.endsWith(`.${h}`);
}

function isPlausibleStudentPaperName(name = '') {
  const n = String(name || '').trim();
  if (!n || n.length < 2) return false;
  if (INSTITUTIONAL_PLACEHOLDER.test(n)) return false;
  if (WEAK_NEWS_LABEL.test(n)) return false;
  if (/^(institut|universit[eé]|c[eé]gep|college|coll[eè]ge)\b/i.test(n) && !NEWS_HINTS.test(n)) {
    return false;
  }
  return true;
}

function fetchText(url, redirects = 4) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve('');
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    let req;
    try {
      req = lib.get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LE-RADAR-QC-Report/1.0; +https://github.com/azdak919/le-radar)',
            Accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml,*/*',
          },
          timeout: TIMEOUT,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            try {
              return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects - 1));
            } catch {
              return resolve('');
            }
          }
          if (res.statusCode >= 400) {
            res.resume();
            return resolve('');
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            if (data.length < 150000) data += c;
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

function isFeed(xml) {
  return /<rss[\s>]|<feed[\s>]/i.test((xml || '').slice(0, 800));
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

function extractLinks(html, baseUrl) {
  const links = new Set();
  const re = /href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl).toString();
      if (abs.startsWith('http')) links.add(abs);
    } catch { /* ignore */ }
  }
  const alt = html.match(/<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/rss\+xml["']/i);
  if (alt) {
    try { links.add(new URL(alt[1], baseUrl).toString()); } catch { /* ignore */ }
  }
  return [...links];
}

function linkLabel(url, html) {
  const tail = url.slice(-50).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<a[^>]+href=["'][^"']*${tail}["'][^>]*>([\\s\\S]{2,100}?)</a>`, 'i');
  const m = html.match(re);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function probeFeed(url) {
  const body = await fetchText(url);
  if (!body || !isFeed(body) || countItems(body) === 0) {
    return { ok: false, url, reason: !body ? 'unreachable' : !isFeed(body) ? 'not-feed' : 'empty' };
  }
  const last = latestItemDate(body);
  const items = countItems(body);
  if (last == null) {
    return { ok: true, url, items, lastItemDate: null, ageDays: null, fresh: false, reason: 'no-dates' };
  }
  const ageDays = (Date.now() - last) / 86400000;
  return {
    ok: true,
    url,
    items,
    lastItemDate: new Date(last).toISOString(),
    ageDays: Math.round(ageDays),
    fresh: ageDays <= FRESH_DAYS,
    reason: ageDays <= FRESH_DAYS ? 'fresh' : 'stale',
  };
}

async function findFeedOnSite(siteUrl) {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  const tries = siteUrl.match(/feed\/?$|\.xml$|feed=rss/i)
    ? [siteUrl]
    : [siteUrl, ...FEED_PATHS.map((p) => base + p)];
  let best = null;
  for (const url of tries) {
    const hit = await probeFeed(url);
    if (hit.ok) {
      if (hit.fresh) return hit;
      if (!best) best = hit;
    }
  }
  return best;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function registryStatus(newsRegistry, name, site) {
  const n = norm(name);
  const h = hostKey(site || '');
  for (const s of newsRegistry.active || []) {
    if (norm(s.name) === n) return { status: 'active', entry: s };
    if (h && (hostKey(s.url) === h || hostKey(s.site || '') === h)) return { status: 'active', entry: s };
  }
  for (const s of newsRegistry.candidates || []) {
    if (norm(s.name) === n) return { status: s._status === 'retired' ? 'retired' : 'candidate', entry: s };
    if (h && hostKey(s.site || '') === h) return { status: s._status === 'retired' ? 'retired' : 'candidate', entry: s };
  }
  return { status: 'new', entry: null };
}

function newsCoveredInstitution(newsRegistry, instName) {
  const keys = [norm(instName).replace(/\(.*?\)/g, '').trim()];
  const acro = instName.match(/\(([^)]+)\)/);
  if (acro) keys.push(norm(acro[1]));
  const covered = [];
  for (const s of [...(newsRegistry.active || []), ...(newsRegistry.candidates || [])]) {
    const inst = norm(s.institution || '');
    if (keys.some((k) => k && (inst.includes(k) || k.includes(inst)))) {
      covered.push(s);
    }
  }
  return covered;
}

async function scanInstitutionSite(inst) {
  if (!inst.website) {
    return { newsSignals: [], radioSignals: [], siteOk: false, reason: 'no-website' };
  }
  const html = await fetchText(inst.website);
  if (!html) {
    return { newsSignals: [], radioSignals: [], siteOk: false, reason: 'site-unreachable' };
  }
  const links = extractLinks(html, inst.website);
  const scored = links.map((link) => {
    const label = linkLabel(link, html);
    const text = `${link} ${label}`;
    let score = 0;
    if (NEWS_HINTS.test(text)) score += 2;
    if (RADIO_HINTS.test(text)) score += 2;
    if (/feed|rss|xml/i.test(link)) score += 2;
    if (/journal|student|newspaper/i.test(text)) score += 2;
    return { link, label, text, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, MAX_LINKS);

  const newsSignals = [];
  const radioSignals = [];
  const seenHosts = new Set();

  for (const { link, label, text } of scored) {
    const h = hostKey(link);
    if (seenHosts.has(h)) continue;

    if (NEWS_HINTS.test(text)) {
      // Skip pure institutional portal hosts unless label screams journal
      if (isInstitutionHost(link, inst.website)
          && !/journal|student|newspaper|exemplaire|collectif|campus|oisif|griffonnier/i.test(`${label} ${link}`)) {
        newsSignals.push({
          kind: 'rejected-institutional',
          label: label || link,
          link,
          reason: 'same host as institution (likely admin news)',
        });
        continue;
      }
      const feed = await findFeedOnSite(link);
      const paperName = (label || '').trim() || link.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      if (feed && isInstitutionHost(feed.url, inst.website)
          && !/journal|student|newspaper/i.test(paperName)) {
        newsSignals.push({
          kind: 'rejected-institutional-feed',
          label: paperName,
          link,
          feed: feed.url,
          reason: 'feed on institution domain',
        });
        continue;
      }
      if (!isPlausibleStudentPaperName(paperName) && !(feed && feed.fresh)) {
        newsSignals.push({
          kind: 'weak-name',
          label: paperName,
          link,
          feed: feed || null,
        });
        continue;
      }
      newsSignals.push({
        kind: feed?.fresh ? 'paper-fresh' : feed?.ok ? 'paper-stale' : 'paper-no-feed',
        name: isPlausibleStudentPaperName(paperName) ? paperName : null,
        label: paperName,
        link,
        feed,
      });
      seenHosts.add(h);
    }

    if (RADIO_HINTS.test(text) && radioSignals.length < 2) {
      radioSignals.push({ label: label || link, link });
      seenHosts.add(h);
    }
  }

  return { newsSignals, radioSignals, siteOk: true, reason: 'ok' };
}

async function probeSeed(seed) {
  const sites = [seed.site, ...(seed.alt || [])].filter(Boolean);
  let best = null;
  let reachableSite = null;
  for (const site of sites) {
    const html = await fetchText(site);
    if (html) reachableSite = site;
    const feed = await findFeedOnSite(site);
    if (feed?.ok) {
      if (feed.fresh) {
        best = { ...feed, site: reachableSite || site };
        break;
      }
      if (!best) best = { ...feed, site: reachableSite || site };
    }
  }
  return {
    seed,
    site: reachableSite || seed.site,
    siteReachable: !!reachableSite,
    feed: best,
  };
}

function fmtDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

function ageLabel(ageDays) {
  if (ageDays == null) return '—';
  if (ageDays < 30) return `${ageDays} j`;
  if (ageDays < 365) return `${Math.round(ageDays / 30)} mo`;
  return `${(ageDays / 365).toFixed(1)} a`;
}

function log(msg = '') {
  // Always newline + flush so redirected / background runs keep progress.
  process.stdout.write(`${msg}\n`);
}

async function main() {
  const outArg = process.argv.indexOf('--out');
  const outPath = outArg >= 0 && process.argv[outArg + 1]
    ? path.resolve(process.argv[outArg + 1])
    : path.join(ROOT, 'docs', 'scan-qc-report.md');
  const jsonPath = outPath.replace(/\.md$/, '.json');
  const seedsOnly = process.argv.includes('--seeds-only');

  const catalogue = loadJson(INSTITUTIONS_PATH, { institutions: [] });
  const newsRegistry = loadJson(NEWS_SOURCES_PATH, { active: [], candidates: [] });
  const radios = loadJson(RADIOS_PATH, []);
  const radioCandidates = loadJson(RADIOS_CANDIDATES_PATH, { candidates: [] });

  const institutions = catalogue.institutions || [];
  const runAt = new Date().toISOString();

  log('LE RADAR — Québec full scan report');
  log('==================================');
  log(`Institutions: ${institutions.length}`);
  log(`Seed papers:  ${SEED_PAPERS.length}`);
  log(`Active:       ${(newsRegistry.active || []).length}`);
  log(`Candidates:   ${(newsRegistry.candidates || []).length}`);
  log(`Mode:         ${seedsOnly ? 'seeds-only' : 'full'}`);
  log('');

  // --- Seed probes ---
  log('▸ Probing seed / known papers…');
  let seedDone = 0;
  const seedResults = await mapPool(SEED_PAPERS, CONCURRENCY, async (seed, idx) => {
    const reg = registryStatus(newsRegistry, seed.name, seed.site);
    let probe;
    try {
      probe = await probeSeed(seed);
    } catch (e) {
      probe = {
        seed,
        site: seed.site,
        siteReachable: false,
        feed: null,
        error: String(e && e.message ? e.message : e),
      };
    }
    seedDone += 1;
    if (seedDone % 5 === 0 || seedDone === SEED_PAPERS.length) {
      log(`  seeds ${seedDone}/${SEED_PAPERS.length} (last: ${seed.name})`);
    }
    return { ...probe, seed, registry: reg.status, registryEntry: reg.entry };
  });
  log(`  done (${seedResults.length} seeds)`);
  log('');

  // --- Institution home-page scans ---
  let instResults = [];
  if (seedsOnly) {
    log('▸ Skipping institution website scan (--seeds-only)');
    instResults = institutions.map((inst) => ({
      name: inst.name,
      type: inst.type,
      region: inst.region || '(sans région)',
      location: inst.location || '',
      website: inst.website || '',
      coveredNews: newsCoveredInstitution(newsRegistry, inst.name).map((s) => ({
        name: s.name,
        status: s._status || 'unknown',
      })),
      newsSignals: [],
      radioSignals: [],
      siteOk: null,
      reason: 'skipped',
    }));
  } else {
    log('▸ Scanning institution websites…');
    let instDone = 0;
    instResults = await mapPool(institutions, CONCURRENCY, async (inst) => {
      let scan;
      try {
        scan = await scanInstitutionSite(inst);
      } catch (e) {
        scan = {
          newsSignals: [],
          radioSignals: [],
          siteOk: false,
          reason: `error: ${e && e.message ? e.message : e}`,
        };
      }
      const covered = newsCoveredInstitution(newsRegistry, inst.name);
      instDone += 1;
      if (instDone % 5 === 0 || instDone === institutions.length) {
        log(`  institutions ${instDone}/${institutions.length} (last: ${(inst.name || '').slice(0, 40)})`);
      }
      return {
        name: inst.name,
        type: inst.type,
        region: inst.region || '(sans région)',
        location: inst.location || '',
        website: inst.website || '',
        coveredNews: covered.map((s) => ({
          name: s.name,
          status: s._status || ((newsRegistry.active || []).some((a) => a.name === s.name) ? 'active' : 'candidate'),
        })),
        ...scan,
      };
    });
    log(`  done (${instResults.length} institutions)`);
    log('');
  }

  // --- Build findings ---
  const activeNames = new Set((newsRegistry.active || []).map((s) => norm(s.name)));
  const candidateNames = new Set((newsRegistry.candidates || []).map((s) => norm(s.name)));

  const findings = {
    promoteReady: [], // fresh feed, not active
    revive: [], // stale but named paper
    dormant: [], // unreachable or ancient
    alreadyActive: [],
    alreadyCandidate: [],
    retired: [],
    outOfScope: [],
    institutionalRejected: [],
    institutionGaps: [], // institutions with no news coverage and no seed hit
  };

  for (const r of seedResults) {
    const row = {
      name: r.seed.name,
      institution: r.seed.institution,
      region: r.seed.region,
      lang: r.seed.lang,
      site: r.site,
      note: r.seed.note || '',
      registry: r.registry,
      siteReachable: r.siteReachable,
      feedUrl: r.feed?.url || null,
      lastItemDate: r.feed?.lastItemDate || null,
      ageDays: r.feed?.ageDays ?? null,
      items: r.feed?.items ?? null,
      feedStatus: r.feed?.reason || (r.siteReachable ? 'no-feed' : 'site-down'),
    };
    if (r.seed.note && /outside Québec|hors Québec|Carleton|OUT OF SCOPE|not a student/i.test(r.seed.note)) {
      findings.outOfScope.push(row);
      continue;
    }
    if (r.registry === 'active') findings.alreadyActive.push(row);
    else if (r.registry === 'retired') findings.retired.push(row);
    else if (r.registry === 'candidate') {
      findings.alreadyCandidate.push(row);
      if (r.feed?.fresh) findings.promoteReady.push({ ...row, why: 'candidate with fresh feed' });
      else if (r.feed?.ok) findings.revive.push({ ...row, why: 'candidate, feed stale' });
      else findings.dormant.push({ ...row, why: 'candidate, no usable feed' });
    } else if (r.feed?.fresh && r.siteReachable) {
      findings.promoteReady.push({ ...row, why: 'new seed with fresh feed' });
    } else if (r.feed?.ok) {
      findings.revive.push({ ...row, why: 'new seed, feed stale' });
    } else if (r.siteReachable) {
      findings.dormant.push({ ...row, why: 'site up, no RSS/Atom found' });
    } else {
      findings.dormant.push({ ...row, why: 'site unreachable / wrong URL' });
    }
  }

  // Institution-page discoveries not already in seeds
  const seedHosts = new Set(SEED_PAPERS.flatMap((s) => [hostKey(s.site), ...(s.alt || []).map(hostKey)]));
  const seedNames = new Set(SEED_PAPERS.map((s) => norm(s.name)));

  for (const ir of instResults) {
    for (const sig of ir.newsSignals || []) {
      if (sig.kind === 'rejected-institutional' || sig.kind === 'rejected-institutional-feed') {
        findings.institutionalRejected.push({
          institution: ir.name,
          region: ir.region,
          label: sig.label,
          link: sig.link,
          reason: sig.reason,
        });
        continue;
      }
      if (!sig.link) continue;
      const h = hostKey(sig.link);
      const n = norm(sig.name || sig.label || '');
      if (seedHosts.has(h) || seedNames.has(n) || activeNames.has(n) || candidateNames.has(n)) continue;
      if (sig.kind === 'paper-fresh') {
        findings.promoteReady.push({
          name: sig.name || sig.label,
          institution: ir.name,
          region: ir.region,
          lang: 'fr',
          site: sig.link,
          note: 'discovered on institution website',
          registry: 'new',
          siteReachable: true,
          feedUrl: sig.feed?.url || null,
          lastItemDate: sig.feed?.lastItemDate || null,
          ageDays: sig.feed?.ageDays ?? null,
          items: sig.feed?.items ?? null,
          feedStatus: sig.feed?.reason || 'fresh',
          why: 'institution homepage link + fresh feed',
        });
      } else if (sig.kind === 'paper-stale' || sig.kind === 'paper-no-feed') {
        findings.revive.push({
          name: sig.name || sig.label,
          institution: ir.name,
          region: ir.region,
          site: sig.link,
          feedUrl: sig.feed?.url || null,
          lastItemDate: sig.feed?.lastItemDate || null,
          ageDays: sig.feed?.ageDays ?? null,
          why: sig.kind,
        });
      }
    }

    if (!(ir.coveredNews || []).length) {
      const hasSeed = seedResults.some(
        (s) => norm(s.seed.institution).includes(norm(ir.name).slice(0, 20))
          || norm(ir.name).includes(norm(s.seed.institution).slice(0, 20))
      );
      const hasFreshSignal = (ir.newsSignals || []).some((s) => s.kind === 'paper-fresh');
      if (!hasSeed && !hasFreshSignal) {
        findings.institutionGaps.push({
          name: ir.name,
          type: ir.type,
          region: ir.region,
          website: ir.website,
          siteOk: ir.siteOk,
          reason: ir.reason,
          radioHints: (ir.radioSignals || []).map((r) => r.link),
        });
      }
    }
  }

  // Dedup promoteReady by name
  const dedup = (arr, keyFn) => {
    const seen = new Set();
    return arr.filter((x) => {
      const k = keyFn(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  findings.promoteReady = dedup(findings.promoteReady, (x) => norm(x.name) + '|' + hostKey(x.site || x.feedUrl || ''));
  findings.revive = dedup(findings.revive, (x) => norm(x.name || '') + '|' + hostKey(x.site || ''));

  // --- By region ---
  const byRegion = {};
  const ensureRegion = (r) => {
    const k = r || '(sans région)';
    if (!byRegion[k]) {
      byRegion[k] = {
        active: [],
        promoteReady: [],
        candidates: [],
        dormantSeeds: [],
        institutionGaps: [],
        institutions: [],
      };
    }
    return byRegion[k];
  };

  for (const s of newsRegistry.active || []) {
    ensureRegion(s.region).active.push(s);
  }
  for (const s of newsRegistry.candidates || []) {
    ensureRegion(s.region).candidates.push(s);
  }
  for (const r of findings.promoteReady) ensureRegion(r.region).promoteReady.push(r);
  for (const r of findings.dormant) ensureRegion(r.region).dormantSeeds.push(r);
  for (const r of findings.institutionGaps) ensureRegion(r.region).institutionGaps.push(r);
  for (const ir of instResults) ensureRegion(ir.region).institutions.push(ir);

  // --- Markdown ---
  const lines = [];
  const push = (...a) => lines.push(...a);

  push(`# Scan Québec — médias étudiants par région`);
  push('');
  push(`> Rapport généré le **${runAt.slice(0, 19).replace('T', ' ')} UTC** par \`scripts/scan-qc-report.js\`.`);
  push(`> Périmètre : journaux étudiants (cégeps + universités). **Exclus** : portails institutionnels.`);
  push('');
  push('## Synthèse');
  push('');
  push(`| Indicateur | Valeur |`);
  push(`|------------|--------|`);
  push(`| Établissements catalogue | ${institutions.length} |`);
  push(`| Sources **actives** (live) | ${(newsRegistry.active || []).length} |`);
  push(`| Candidats **staged** | ${(newsRegistry.candidates || []).length} |`);
  push(`| **Prêts à promouvoir** (flux frais, pas encore live) | ${findings.promoteReady.length} |`);
  push(`| Graines dormantes / URL morts | ${findings.dormant.length} |`);
  push(`| Flux institutionnels rejetés | ${findings.institutionalRejected.length} |`);
  push(`| Établissements sans couverture news | ${findings.institutionGaps.length} |`);
  push(`| Radios natives (réf.) | ${radios.length} |`);
  push('');

  push('## 1. Prêts à examiner / promouvoir');
  push('');
  if (!findings.promoteReady.length) {
    push('_Aucun nouveau flux frais détecté hors sources déjà actives._');
    push('');
  } else {
    push('| Journal | Établissement | Région | Dernier article | Items | Site |');
    push('|---------|---------------|--------|-----------------|-------|------|');
    for (const r of findings.promoteReady.sort((a, b) => (a.region || '').localeCompare(b.region || ''))) {
      push(`| **${r.name}** | ${r.institution} | ${r.region} | ${fmtDate(r.lastItemDate)} (${ageLabel(r.ageDays)}) | ${r.items ?? '—'} | ${r.site || r.feedUrl || '—'} |`);
    }
    push('');
    push('> Vérifier manuellement que c’est bien un **journal étudiant** avant `add-news-source.js`.');
    push('');
  }

  push('## 2. Candidats déjà staged (pourquoi pas live)');
  push('');
  push('| Journal | Établissement | Région | Fail | Flux | Note |');
  push('|---------|---------------|--------|------|------|------|');
  for (const c of newsRegistry.candidates || []) {
    const probe = seedResults.find((s) => norm(s.seed.name) === norm(c.name));
    const feedInfo = probe?.feed
      ? `${probe.feed.reason}${probe.feed.lastItemDate ? ` · ${fmtDate(probe.feed.lastItemDate)}` : ''}`
      : '—';
    push(`| ${c.name} | ${c.institution} | ${c.region || '—'} | ${c._failCount ?? '—'} | ${feedInfo} | ${(c._note || c._status || '').replace(/\|/g, '/')} |`);
  }
  push('');

  push('## 3. Sources actives (référence)');
  push('');
  push('| Journal | Établissement | Région | Status |');
  push('|---------|---------------|--------|--------|');
  for (const s of newsRegistry.active || []) {
    push(`| ${s.name} | ${s.institution} | ${s.region || '—'} | ${s._status || 'ok'} |`);
  }
  push('');

  push('## 4. Rapport par région');
  push('');

  const regionOrder = Object.keys(byRegion).sort((a, b) => {
    const score = (r) => (byRegion[r].active.length * 10) + byRegion[r].promoteReady.length - byRegion[r].institutionGaps.length * 0.01;
    return score(b) - score(a) || a.localeCompare(b);
  });

  for (const region of regionOrder) {
    const block = byRegion[region];
    const nInst = block.institutions.length;
    const nActive = block.active.length;
    const nGap = block.institutionGaps.length;
    push(`### ${region}`);
    push('');
    push(`Établissements : **${nInst}** · Sources live : **${nActive}** · Gaps : **${nGap}** · Promote-ready : **${block.promoteReady.length}**`);
    push('');

    if (block.active.length) {
      push('**Live**');
      for (const s of block.active) {
        push(`- ✅ **${s.name}** — ${s.institution} (\`${s._status || 'ok'}\`)`);
      }
      push('');
    }
    if (block.promoteReady.length) {
      push('**Nouveaux / à promouvoir**');
      for (const s of block.promoteReady) {
        push(`- 🆕 **${s.name}** — ${s.institution} · dernier ${fmtDate(s.lastItemDate)} · ${s.site || s.feedUrl}`);
      }
      push('');
    }
    if (block.candidates.length) {
      push('**Candidats staged**');
      for (const s of block.candidates) {
        push(`- ⏳ ${s.name} — ${s.institution}${s._note ? ` — _${s._note.slice(0, 100)}_` : ''}`);
      }
      push('');
    }
    if (block.dormantSeeds.filter((d) => d.registry !== 'active').length) {
      const dorm = block.dormantSeeds.filter((d) => d.registry !== 'active' && d.registry !== 'candidate');
      if (dorm.length) {
        push('**Graines testées, pas de flux frais**');
        for (const s of dorm) {
          push(`- 💤 ${s.name} — ${s.why || s.feedStatus} · ${s.site || ''}`);
        }
        push('');
      }
    }
    // Show uncovered institutions (sample if huge)
    if (block.institutionGaps.length) {
      push('**Établissements sans journal au registre**');
      for (const g of block.institutionGaps.slice(0, 40)) {
        const flag = g.siteOk === false ? ' (site KO)' : '';
        push(`- ○ ${g.name} (${g.type})${flag}${g.website ? ` — ${g.website}` : ''}`);
      }
      if (block.institutionGaps.length > 40) {
        push(`- _… +${block.institutionGaps.length - 40} autres_`);
      }
      push('');
    }
  }

  push('## 5. Méthode & limites');
  push('');
  push('- Scan des pages d’accueil `institutions.json` + liste de graines (journaux connus / plausibles).');
  push('- Un flux sur le **même hôte** que le site institutionnel est **rejeté** (leçon INRS / UQAR).');
  push('- « Frais » = dernier item ≤ **18 mois** (fenêtre découverte ; la promo auto reste à 365 j).');
  push('- Beaucoup de journaux collégiaux sont **inactifs**, en PDF, Instagram-only, ou sans RSS.');
  push('- Les URL graines sont **hypothèses** : un site down ne prouve pas l’absence de journal.');
  push('- Ce script est **lecture seule** : il n’écrit pas `news-sources.json` (sauf ce rapport).');
  push('');
  push('## 6. Prochaines actions recommandées');
  push('');
  if (findings.promoteReady.length) {
    push('1. Valider manuellement chaque entrée « Prêts à examiner » (indépendance étudiante + RSS).');
    push('2. Intégrer via `node scripts/add-news-source.js --name "…" --url "…/feed/" …`.');
  } else {
    push('1. Aucun promote-ready automatique — prioriser des recherches manuelles sur les gaps régionaux (Outaouais, Abitibi, Côte-Nord, Gaspésie).');
  }
  push('3. Laisser les candidats staged dormants jusqu’à reprise éditoriale (souvent septembre).');
  push('4. Relancer : `node scripts/scan-qc-report.js`.');
  push('');

  const md = lines.join('\n');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: runAt,
    summary: {
      institutions: institutions.length,
      active: (newsRegistry.active || []).length,
      candidates: (newsRegistry.candidates || []).length,
      promoteReady: findings.promoteReady.length,
      dormant: findings.dormant.length,
      institutionalRejected: findings.institutionalRejected.length,
      institutionGaps: findings.institutionGaps.length,
    },
    findings,
    byRegion: Object.fromEntries(
      Object.entries(byRegion).map(([k, v]) => [k, {
        active: v.active.map((s) => s.name),
        promoteReady: v.promoteReady,
        candidates: v.candidates.map((s) => s.name),
        institutionGaps: v.institutionGaps.map((g) => g.name),
        institutionCount: v.institutions.length,
      }])
    ),
    seedResults: seedResults.map((r) => ({
      name: r.seed.name,
      institution: r.seed.institution,
      region: r.seed.region,
      registry: r.registry,
      siteReachable: r.siteReachable,
      feed: r.feed ? {
        url: r.feed.url,
        lastItemDate: r.feed.lastItemDate,
        ageDays: r.feed.ageDays,
        items: r.feed.items,
        reason: r.feed.reason,
      } : null,
    })),
  }, null, 2));

  log('');
  log(`✅ Report: ${outPath}`);
  log(`✅ JSON:   ${jsonPath}`);
  log(`Promote-ready: ${findings.promoteReady.length}`);
  log(`Dormant seeds: ${findings.dormant.length}`);
  log(`Institution gaps: ${findings.institutionGaps.length}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
