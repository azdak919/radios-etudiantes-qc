/**
 * Recherche de photos libres de droit (Openverse + Wikimedia Commons).
 * Dernier recours quand la page source n'a pas de visuel vedette utilisable.
 */

const https = require('https');
const http = require('http');
const { meetsLeadDisplaySize, probeRemoteImageSize, sleep } = require('./article-image-lib');

const USER_AGENT = 'LE-RADAR-NewsBot/1.0 (student media aggregator; contact: radios-etudiantes-qc)';

const STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l', 'à', 'au', 'aux', 'en', 'et', 'ou',
  'pour', 'par', 'sur', 'dans', 'son', 'sa', 'ses', 'leur', 'leurs', 'ce', 'cette', 'ces', 'qui',
  'que', 'quoi', 'dont', 'est', 'sont', 'avec', 'sans', 'plus', 'moins', 'tout', 'tous', 'toute',
  'comment', 'pourquoi', 'quand', 'vers', 'chez', 'entre', 'après', 'avant', 'depuis', 'the', 'and',
  'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'has', 'have', 'into', 'about',
  'read', 'more', 'lire', 'suite', 'hellip', 'utm', 'source', 'medium', 'campaign', 'rss',
]);

/** Faux-amis à exclure des requêtes (résumé ≠ resume anglais, etc.) */
const FALSE_FRIENDS = new Set([
  'resume', 'résumé', 'opinion', 'chronique', 'entrevue', 'critique', 'reportage', 'editorial',
  'feature', 'features', 'news', 'article', 'journal', 'campus', 'etudiant', 'étudiant',
]);

const QUEBEC_REGION_RE = /montréal|montreal|québec|quebec|laval|gatineau|sherbrooke|saguenay|rimouski|trois.?rivières|trois.?rivieres|abitibi|outaouais/i;
const QUEBEC_INSTITUTION_RE = /uqam|uqtr|udem|ulaval|mcgill|concordia|hec montréal|hec montreal|cégep|cegep|sherbrooke|bishop|polytechnique|vieux montréal|vieux montreal/i;
const QUEBEC_POLITICS_RE = /québécois|quebecois|élection provinciale|election provinciale|monde politique québécois|monde politique quebecois|\bcaq\b|parti québécois|parti quebecois|\bpq\b|\bqs\b|\bplq\b|\bpspp\b|françois legault|francois legault|hôtel du parlement|hotel du parlement|assemblée nationale du québec|assemblee nationale du quebec|député provincial|depute provincial|\bmna\b|\bmnas\b/i;
const FEDERAL_CANADA_RE = /chambre des communes|parlement du canada|ottawa|trudeau|député fédéral|depute federal|\bmp\b|house of commons|parliament hill/i;
const FRANCE_SUBJECT_RE = /g7|évian|evian|sommet|elysée|elysee|macron|paris 202|france 202|coupe du monde|jeux olympiques paris/i;
const SPORTS_TOPIC_RE = /\b(hockey|rink|athlete|u-sports|usports|soccer|football|basketball|volleyball|championship|mvp|golf|links|tennis|swim|sportifs?|sports)\b/i;
const STUDENT_MOBILIZATION_RE = /\b(mobilization|mobilisation|austerity|austérité|student federation|general meeting|grève|strike|manifestation)\b/i;

/** Lieux étrangers à pénaliser quand l'article parle du Québec / Canada. */
const FOREIGN_LOCATION_MARKERS = [
  'brighton', 'england', 'united kingdom', 'london uk', 'manchester', 'birmingham',
  'paris france', 'lyon', 'rhone', 'rhône', 'marseille', 'berlin', 'munich',
  'rome', 'milan', 'athens', 'lyceum', 'chirico', 'florence', 'venice',
  'spain', 'madrid', 'barcelona', 'portugal', 'lisbon', 'australia', 'sydney',
  'japan', 'tokyo', 'india', 'china', 'beijing', 'africa', 'brazil',
];

/** Acronymes courts : seul « ASFA » ne doit pas matcher une école italienne, etc. */
const SHORT_ACRONYM_RE = /^[a-z]{2,5}$/;

/* Documents d'archives numérisés (gravures, plaques de verre, cartes postales,
   photos 18xx-19xx…) : granuleux, noir et blanc, souvent « Unknown author ».
   Qualité visuelle trop faible pour illustrer un article — mieux vaut aucune
   photo — sauf si le sujet de l'article est justement historique. */
const ARCHIVAL_MEDIA_RE = /\b(?:archives?|archival|vintage|circa|daguerr[eé]otype|tintype|lithograph\w*|engraving|gravure|etching|postcard|carte postale|glass plate|plaque de verre|s[eé]pia|monochrome|black[\s-]?and[\s-]?white|microfilm|n[eé]gatifs?|negatives?)\b/i;
/* Année 18xx-19xx dans le titre/nom de fichier (« 1873-75 Ravenscrag… ») —
   les lookarounds évitent les dimensions du type « 1920x1080 ». */
const ARCHIVAL_YEAR_RE = /(?<!x)\b1[89]\d{2}\b(?!x)/;
const HISTORICAL_TOPIC_RE = /\b(?:histoire|historiques?|historical|history|heritage|patrimoine|archives?|anniversaires?|centenaires?|centennial|comm[eé]moration\w*|commemorat\w*|fondation|founding|r[eé]trospectives?|retrospectives?)\b/i;
const UNKNOWN_CREATOR_RE = /^(?:unknown|inconnu|anonym)/i;

/* Saisons / météo : une photo d'hiver pour un billet d'été (et inversement)
   est le type même d'image « hors-sujet » que l'on refuse. */
const SUMMER_TOPIC_RE = /\b(?:summer|summertime|été|ete|estival|warm|chaleur|chaud|hot weather|canicule|heat\s?wave|vague de chaleur|terrasse|patio|defrost|d[eé]gele|d[eé]gele|first warm|soir[eé]e chaude|20 degrees|vingt degr[eé]s|july|juillet|june|juin|august|ao[uû]t)\b/i;
const WINTER_TOPIC_RE = /\b(?:winter|hiver|hivernal|snow|neige|blizzard|temp[eê]te de neige|glacial|freezing|sub[- ]zero|moins \d+|patinoire|ice storm|verglas|froid extr[eê]me)\b/i;
const WINTER_PHOTO_RE = /\b(?:snow|neige|winter|hiver|blizzard|frost|gel|glacial|january|janvier|february|f[eé]vrier|december|d[eé]cembre|ice[- ]cover|covered in snow)\b/i;
const SUMMER_PHOTO_RE = /\b(?:summer|été|ete|july|juillet|june|juin|august|ao[uû]t|green lawn|leafy|foliage|sunny|ensoleill)\b/i;

/** Pays/régions/lieux à pénaliser quand l'article parle de l'Assemblée nationale du Québec. */
const FOREIGN_ASSEMBLY_MARKERS = [
  // France (Assemblée nationale française = Palais Bourbon, à Paris).
  'france', 'french', 'francaise', 'française', 'paris', 'palais bourbon', 'bourbon',
  // Afrique francophone (« Assemblée nationale » y désigne un autre parlement).
  'burkina', 'faso', 'afrique', 'africa', 'senegal', 'sénégal', 'dakar', 'mali', 'niger',
  'benin', 'bénin', 'togo', 'cameroun', 'cameroon', 'rwanda', 'madagascar', 'gabon', 'congo',
  'ouganda', 'uganda', 'nigeria', 'ghana', 'kenya', 'tanzania', 'zambia', 'zimbabwe',
  'mozambique', 'angola', 'tunisia', 'tunisie', 'algeria', 'algérie', 'morocco', 'maroc',
  'egypt', 'égypte', 'ivory coast', 'cote d ivoire', 'côte d ivoire', 'haiti', 'haïti',
  'guinea', 'guinée', 'liberia', 'libéria',
  // Autres parlements homonymes croisés dans les résultats de recherche.
  'lisbon', 'lisbonne', 'lisboa', 'sao bento', 'portugal', 'chili', 'chile',
];

/** Repère générique « c'est bien une assemblée / un parlement » (peu importe le pays). */
const ASSEMBLY_SUBJECT_RE = /\b(?:assemblee|assemblée|national assembly|parliament|parlement|legislative|legislature|hemicycle|hémicycle|palais bourbon)\b/i;

const QC_ASSEMBLY_MARKERS = [
  'quebec', 'québec', 'quebec city', 'ville de quebec', 'ville de québec',
  'hotel du parlement', 'hôtel du parlement', 'national assembly quebec',
  'assemblee nationale du quebec', 'assemblée nationale du québec',
];

function stripHtml(text = '') {
  return String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text = '') {
  return normalizeText(text)
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !FALSE_FRIENDS.has(w) && !/^\d+$/.test(w));
}

function extractProperNouns(text = '') {
  const raw = String(text);
  const acronyms = raw.match(/\b[A-Z0-9]{2,}\b|\bG\d+\b/g) || [];
  const words = raw.match(/\b[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]+(?:['’-][A-ZÀ-ÖØ-Þa-zà-öø-ÿ]+)*/g) || [];
  return [...new Set([...acronyms, ...words]
    .map((w) => normalizeText(w))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !FALSE_FRIENDS.has(w)))];
}

/**
 * Nom complet (et acronyme entre parenthèses) de l'établissement, normalisés.
 * Une photo dont le titre/nom de fichier contient ce nom (pavillon, campus…)
 * est contextuellement sûre pour un article de média étudiant.
 */
function institutionPhrases(item = {}) {
  const raw = String(item.institution || '');
  const phrases = [];
  const base = normalizeText(raw.replace(/\s*\([^)]*\)/g, ''));
  if (base.length >= 5) phrases.push(base);
  const paren = raw.match(/\(([^)]+)\)/);
  if (paren) {
    const acro = normalizeText(paren[1]);
    if (acro.length >= 3) phrases.push(acro);
  }
  return phrases;
}

function detectEditorialContext(item = {}) {
  const content = extractArticleContent(item);
  const title = item.title || '';
  const full = `${title} ${content} ${item.institution || ''} ${item.region || ''} ${item.source || ''}`;
  const norm = normalizeText(full);

  const quebecRegion = QUEBEC_REGION_RE.test(item.region || '') || QUEBEC_REGION_RE.test(norm);
  const quebecInstitution = QUEBEC_INSTITUTION_RE.test(item.institution || '') || QUEBEC_INSTITUTION_RE.test(norm);
  const quebecPolitics = QUEBEC_POLITICS_RE.test(norm);
  const federalCanada = FEDERAL_CANADA_RE.test(norm);
  const franceAsSubject = FRANCE_SUBJECT_RE.test(norm);

  const quebec = quebecRegion
    || quebecInstitution
    || quebecPolitics
    || (item.lang === 'fr' && !!item.institution);

  const assemblyTopic = /assemblée nationale|assemblee nationale|national assembly/i.test(full);
  const provincialParliament = assemblyTopic && quebec && !federalCanada;

  const titleNorm = normalizeText(title);

  const summerTopic = SUMMER_TOPIC_RE.test(full) || SUMMER_TOPIC_RE.test(title);
  const winterTopic = WINTER_TOPIC_RE.test(full) || WINTER_TOPIC_RE.test(title);

  return {
    quebec,
    quebecPolitics: quebecPolitics || (quebec && assemblyTopic),
    federalCanada,
    franceAsSubject,
    provincialParliament,
    assemblyTopic,
    montreal: /montréal|montreal/i.test(norm) || /montréal|montreal/i.test(item.region || ''),
    /* Sujet historique : seul cas où une photo d'archive est appropriée. */
    historicalTopic: HISTORICAL_TOPIC_RE.test(norm) || ARCHIVAL_YEAR_RE.test(titleNorm),
    summerTopic,
    winterTopic,
    institutionPhrases: institutionPhrases(item),
    norm,
    titleNorm,
  };
}

function extractContextualQueries(item, context = detectEditorialContext(item)) {
  const queries = [];
  const title = item.title || '';
  const content = extractArticleContent(item);
  const combined = `${title} ${content}`;

  if (context.provincialParliament || (context.assemblyTopic && context.quebec)) {
    queries.push('Assemblée nationale du Québec');
    queries.push('Hôtel du Parlement Québec');
    queries.push('Quebec Parliament Building Quebec City');
  }

  if (/national assembly/i.test(combined) && context.quebec && !context.federalCanada) {
    queries.push('Quebec National Assembly Quebec City');
  }

  if (/\bparlement\b/i.test(combined) && context.quebec && !context.federalCanada) {
    queries.push('Assemblée nationale du Québec');
  }

  if (/cour suprême|cour supreme|supreme court/i.test(combined) && context.quebec && !context.federalCanada) {
    queries.push('Cour suprême du Canada Ottawa');
  }

  if (/chambre des communes|house of commons/i.test(combined) && context.federalCanada) {
    queries.push('Parliament Hill Ottawa Canada');
  }

  if (/élection provinciale|election provinciale/i.test(combined) && context.quebec) {
    queries.push('élection Québec politique');
  }

  if (item.institution && context.quebec && /campus|université|universite|cégep|cegep|étudiant|etudiant/i.test(combined)) {
    const inst = String(item.institution).replace(/\b(university|université|universite)\b/gi, '').trim();
    if (inst.length > 4) queries.push(`${inst} Québec`);
  }

  if (STUDENT_MOBILIZATION_RE.test(combined)) {
    const inst = String(item.institution || '').replace(/\b(university|université|universite)\b/gi, '').trim();
    if (inst.length > 4) queries.push(`${inst} student protest`);
    queries.push('student demonstration university Canada');
    queries.push('student mobilization campus Montreal');
  }

  if (SPORTS_TOPIC_RE.test(combined)) {
    if (/\b(hockey|rink|ice)\b/i.test(combined)) {
      queries.push('ice hockey player Canada');
      queries.push('university hockey team Canada');
    }
    if (/\b(golf|links)\b/i.test(combined)) {
      queries.push('university golf athlete');
      queries.push('golf sport campus');
    }
    if (/\bathlete\b/i.test(combined)) {
      queries.push('university athlete sport Canada');
    }
    queries.push('college sports Canada');
  }

  // Sujets visuels tirés du résumé / titre (pas seulement le campus).
  if (context.summerTopic) {
    if (context.montreal) {
      queries.push('Montreal summer terrasse patio outdoor');
      queries.push('Montréal été terrasse rue');
      queries.push('warm summer evening Montreal sidewalk');
    } else if (context.quebec) {
      queries.push('Québec été ville terrasse');
      queries.push('summer outdoor cafe Canada');
    }
    queries.push('summer city street warm evening');
  }
  if (context.winterTopic) {
    if (context.montreal) queries.push('Montreal winter snow street');
    else if (context.quebec) queries.push('Québec hiver neige ville');
    queries.push('winter city snow Canada');
  }

  // Dossiers femmes / alumnae (The McGill Daily et similaires) : photos de
  // campus « generic editorial banner » souvent absentes — chercher un sujet.
  if (/\b(?:alumnae|alumni|women(?:'s)?\s+history|international\s+women|women(?:'s)?\s+(?:rights|day)|féminis|feminis|gender\s+equity|second-?class\s+citizens)\b/i.test(combined)) {
    if (item.institution && /mcgill/i.test(item.institution)) {
      queries.push('McGill University women graduates ceremony');
      queries.push('McGill University convocation graduates');
    }
    queries.push('university women graduates Canada');
    queries.push('women students university campus');
    if (/\b(?:rights|citizens|legislative|indignation)\b/i.test(combined)) {
      queries.push('women rights demonstration Canada');
      queries.push('International Women Day march');
    }
  }

  // Articles sans photo (McGill Daily text-only) : ancrage institutionnel
  // pour la recherche libre avant le repli campus.
  if (item.institution && /mcgill/i.test(String(item.institution))) {
    const hasStrongVisual = SPORTS_TOPIC_RE.test(combined)
      || STUDENT_MOBILIZATION_RE.test(combined)
      || context.summerTopic
      || context.winterTopic;
    if (!hasStrongVisual && title.length > 8) {
      queries.push('McGill University campus Montreal');
      queries.push('McGill University students campus');
    }
  }

  return [...new Set(queries.filter((q) => q && q.length > 2))];
}

function applyContextScoring(hit, context = {}) {
  if (!context || !hit) return 0;
  const hay = normalizeText(`${hit.title || ''} ${hit.tags || ''} ${hit.url || ''}`);
  let delta = 0;

  if (context.provincialParliament || (context.assemblyTopic && context.quebec)) {
    let qcMatch = false;
    for (const marker of QC_ASSEMBLY_MARKERS) {
      if (hay.includes(normalizeText(marker))) { delta += 90; qcMatch = true; }
    }
    const foreignMatch = FOREIGN_ASSEMBLY_MARKERS.some((m) => hay.includes(normalizeText(m)));
    // Une photo d'assemblée / de parlement clairement identifiable, mais SANS
    // ancrage québécois (ou marquée France / Sénégal / Paris…), est la mauvaise
    // assemblée : rejet net. On ne veut jamais l'Assemblée nationale française
    // (Palais Bourbon) ni une assemblée africaine pour un sujet québécois.
    if (!qcMatch && !context.franceAsSubject && (foreignMatch || ASSEMBLY_SUBJECT_RE.test(hay))) {
      delta -= 400;
    }
  }

  if (context.quebec && context.federalCanada && context.provincialParliament) {
    if (/ottawa|house of commons|chambre des communes|parliament hill/i.test(hay)) delta -= 45;
  } else if (context.federalCanada && !context.provincialParliament) {
    if (/ottawa|parliament hill|house of commons|chambre des communes/i.test(hay)) delta += 45;
    if (/hotel du parlement|hôtel du parlement|national assembly quebec/i.test(hay)) delta -= 35;
  }

  if (context.quebec && /cour suprême|cour supreme|supreme court/i.test(context.norm)) {
    if (/washington|united states|u\.s\. supreme|usa supreme/i.test(hay)) delta -= 80;
    if (/supreme court of canada|cour suprême du canada|ottawa/i.test(hay)) delta += 55;
  }

  if (context.quebec || context.montreal) {
    for (const marker of FOREIGN_LOCATION_MARKERS) {
      if (hay.includes(normalizeText(marker))) delta -= 85;
    }
    if (/\b(canada|canadian|quebec|québec|montreal|montréal)\b/.test(hay)) delta += 25;
  }

  return delta;
}

/** Corps éditorial sans byline ni HTML — base pour les requêtes visuelles. */
function extractArticleContent(item) {
  let body = stripHtml(item.excerpt || '');
  body = body.replace(
    /^\s*(?:Par|By)\s+[\p{Lu}][\p{L}'’.\-]+(?:\s+[\p{Lu}][\p{L}'’.\-]+){0,3}\s+/iu,
    '',
  );
  return body.replace(/\s+/g, ' ').trim();
}

function buildMatchTokens(item) {
  const content = extractArticleContent(item);
  const titleTokens = tokenize(item.title || '');
  const contentTokens = tokenize(content);
  const proper = extractProperNouns(`${item.title || ''} ${content}`);
  const isUsefulToken = (t) => t.length >= 3 && !/^(?:19|20)\d{2}$/.test(t) && !/^\d+$/.test(t);
  const important = [...new Set([
    ...proper.filter(isUsefulToken),
    ...contentTokens.filter((t) => t.length >= 4),
    ...titleTokens.filter((t) => t.length >= 4),
  ])].slice(0, 16);
  return { important, title: titleTokens, content: contentTokens, proper, contentText: content };
}

function extractSearchQueries(item, context = detectEditorialContext(item)) {
  const content = extractArticleContent(item);
  const contentProper = extractProperNouns(content);
  const titleProper = extractProperNouns(item.title || '');
  const titleTokens = tokenize(item.title || '');
  const contentTokens = tokenize(content).slice(0, 12);
  const match = buildMatchTokens(item);

  const queries = [...extractContextualQueries(item, context)];

  if (context.provincialParliament) {
    queries.push('Assemblée nationale Québec politique');
  }

  if (contentProper.length >= 2) queries.push(contentProper.slice(0, 5).join(' '));
  if (contentTokens.length >= 3) queries.push(contentTokens.slice(0, 6).join(' '));
  const firstSentence = content.split(/[.!?]/)[0]?.trim() || '';
  if (firstSentence.length >= 24) {
    queries.push(tokenize(firstSentence).slice(0, 7).join(' '));
  }

  if (/g7/i.test(content) || /g7/i.test(item.title || '') || match.proper.includes('g7')) {
    queries.push('G7 summit 2026 Evian leaders');
    queries.push('G7 family photo Evian France');
  }

  if (titleProper.length >= 2) queries.push(titleProper.join(' '));
  if (titleProper.length >= 1 && contentTokens.length >= 1) {
    queries.push(`${titleProper[0]} ${contentTokens.slice(0, 3).join(' ')}`);
  }
  if (match.important.length >= 2) queries.push(match.important.slice(0, 4).join(' '));
  if (titleTokens.length >= 2) queries.push(titleTokens.slice(0, 3).join(' '));
  if (titleProper.length >= 1) queries.push(titleProper[0]);

  // Le campus de l'établissement n'est plus une requête de recherche libre :
  // un match « McGill » seul ramenait des photos d'hiver hors-sujet.
  // Le repli campus est géré par campus-photo-bank.js (vues curatées).

  return [...new Set(queries.filter((q) => q && q.length > 2))];
}

function fetchJson(url, timeout = 12000) {
  return new Promise((resolve) => {
    // Module par protocole + garde : une redirection http:// ou une URL invalide
    // ne doit pas rejeter la promesse (planterait la phase banque/campus).
    let mod;
    try {
      const { protocol } = new URL(url);
      if (protocol === 'https:') mod = https;
      else if (protocol === 'http:') mod = http;
      else return resolve(null);
    } catch {
      return resolve(null);
    }

    let req;
    try {
      req = mod.get(
        url,
        { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return resolve(fetchJson(new URL(res.headers.location, url).toString(), timeout));
          }
          if (res.statusCode >= 400) {
            res.resume();
            return resolve(null);
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          });
        },
      );
    } catch {
      return resolve(null);
    }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function licenseLabel(code = '') {
  const map = {
    cc0: 'CC0',
    pdm: 'Domaine public',
    by: 'CC BY',
    'by-sa': 'CC BY-SA',
    'by-nc': 'CC BY-NC',
    'by-nd': 'CC BY-ND',
    'by-nc-sa': 'CC BY-NC-SA',
    'by-nc-nd': 'CC BY-NC-SA',
  };
  return map[String(code).toLowerCase()] || String(code).toUpperCase();
}

function cleanCreatorName(raw = '') {
  let s = stripHtml(raw).trim();
  s = s.replace(/\.mw-parser-output[\s\S]*/i, '').trim();
  s = s.replace(/\s+/g, ' ');
  // Champ dédoublé à la source (« Unknown authorUnknown author ») :
  // ne garder qu'une occurrence.
  s = s.replace(/^(.{3,}?)\s*\1$/u, '$1').trim();
  if (s.length > 72) {
    const cut = s.slice(0, 72);
    const lastSpace = cut.lastIndexOf(' ');
    s = `${(lastSpace > 36 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return s;
}

function parseOpenverseCreator(result = {}) {
  const direct = cleanCreatorName(result.creator || '');
  if (direct) return direct;
  const attr = stripHtml(result.attribution || '');
  const by = attr.match(/(?:photo\s+)?(?:by|par)\s+([^,·]+)/i);
  if (by) return cleanCreatorName(by[1]);
  const first = attr.split(/[,·]/)[0];
  return cleanCreatorName(first);
}

function formatAttribution(hit) {
  const creator = cleanCreatorName(hit.creator || hit.artist || '') || 'Auteur·e inconnu·e';
  const license = licenseLabel(hit.license || hit.licenseShort || 'CC');
  const via = hit.provider === 'wikimedia' ? 'Wikimedia Commons' : 'Openverse';
  return `Photo : ${creator} / ${license} · ${via}`;
}

function isShortAcronymToken(tok = '') {
  const t = normalizeText(tok);
  return SHORT_ACRONYM_RE.test(t) && t === t.toLowerCase() && /^[a-z]+$/.test(t) && t.length <= 5;
}

function countSubstantiveMatches(hay, matchTokens = {}) {
  const { important = [], content = [], title = [] } = matchTokens;
  let contentMatched = 0;
  let titleMatched = 0;
  let importantMatched = 0;
  let acronymOnly = 0;

  for (const tok of content) {
    if (tok.length < 3 || FALSE_FRIENDS.has(tok) || isShortAcronymToken(tok)) continue;
    if (hay.includes(tok)) contentMatched += 1;
  }
  for (const tok of title) {
    if (tok.length < 4 || FALSE_FRIENDS.has(tok) || isShortAcronymToken(tok)) continue;
    if (hay.includes(tok)) titleMatched += 1;
  }
  for (const tok of important) {
    if (FALSE_FRIENDS.has(tok) || tok.length < 3) continue;
    if (!hay.includes(tok)) continue;
    if (isShortAcronymToken(tok)) acronymOnly += 1;
    else importantMatched += 1;
  }

  return { contentMatched, titleMatched, importantMatched, acronymOnly };
}

function scoreCandidate(hit, matchTokens, context = null) {
  let score = 0;
  const w = hit.width || 0;
  const h = hit.height || 0;
  if (meetsLeadDisplaySize(w, h)) score += 90;
  else if (w >= 560 && h >= 315) score += 45;
  else if (w >= 400 && h >= 250) score += 20;
  else return -1;

  const ratio = w / Math.max(h, 1);
  if (ratio >= 1.1 && ratio <= 2.2) score += 22;
  score += Math.min(w, 2400) / 35;

  const hay = normalizeText(`${hit.title || ''} ${hit.tags || ''} ${hit.url || ''}`);

  // Document d'archive (année 18xx-19xx, gravure, N&B…) : qualité trop
  // faible pour illustrer un article — rejet, sauf sujet historique.
  if (!context?.historicalTopic && (ARCHIVAL_MEDIA_RE.test(hay) || ARCHIVAL_YEAR_RE.test(hay))) {
    return -1;
  }

  const { important = [], content = [], title = [] } = matchTokens || {};
  const matches = countSubstantiveMatches(hay, matchTokens);
  const { contentMatched, titleMatched, importantMatched, acronymOnly } = matches;

  // Établissement : bonus seulement s'il y a déjà un ancrage thématique.
  // Un match « McGill » seul ne suffit plus (photo campus hiver pour un
  // billet d'été) — le repli campus curaté est une autre étape.
  let institutionMatched = 0;
  for (const phrase of context?.institutionPhrases || []) {
    if (hay.includes(phrase)) {
      institutionMatched += 1;
    }
  }

  for (const tok of content) {
    if (tok.length < 3 || FALSE_FRIENDS.has(tok) || isShortAcronymToken(tok)) continue;
    if (hay.includes(tok)) score += tok.length >= 5 ? 22 : 14;
  }
  for (const tok of important) {
    if (FALSE_FRIENDS.has(tok) || tok.length < 3 || isShortAcronymToken(tok)) continue;
    if (hay.includes(tok)) score += 16;
  }
  for (const tok of title) {
    if (tok.length < 4 || FALSE_FRIENDS.has(tok) || isShortAcronymToken(tok)) continue;
    if (hay.includes(tok)) score += 8;
  }

  // Saison / météo : refus net d'une photo d'hiver pour un sujet d'été, etc.
  const photoWinter = WINTER_PHOTO_RE.test(hay);
  const photoSummer = SUMMER_PHOTO_RE.test(hay);
  if (context?.summerTopic && photoWinter) return -1;
  if (context?.winterTopic && photoSummer && !photoWinter) return -1;
  if (context?.summerTopic && photoSummer) score += 35;
  if (context?.winterTopic && photoWinter) score += 35;

  const topicMatched = contentMatched + titleMatched + importantMatched;
  // Exiger un ancrage dans le titre ou le résumé — pas seulement le campus.
  if (topicMatched === 0) return -1;
  if (important.length >= 2 && topicMatched === 0) return -1;
  if (acronymOnly > 0 && topicMatched === 0) return -1;

  if (institutionMatched > 0 && topicMatched > 0) score += 40;

  if (STUDENT_MOBILIZATION_RE.test(context?.norm || '')) {
    if (!/\b(student|university|campus|college|protest|demonstration|mobilization|mobilisation|strike|gr[eè]ve|manifestation|rally|march)\b/.test(hay)) {
      return -1;
    }
  }
  if (SPORTS_TOPIC_RE.test(context?.norm || '')) {
    if (!/\b(sport|sports|athlete|hockey|golf|rink|ice|team|championship|university|college|player|game)\b/.test(hay)) {
      return -1;
    }
  }

  if (hit.provider === 'wikimedia') score += 8;

  // Auteur inconnu ou simple « Domaine public » : presque toujours un vieux
  // document numérisé — pénalité au lieu de l'ancien bonus cc0/pdm.
  const creatorName = normalizeText(hit.creator || hit.artist || '');
  if (!creatorName || UNKNOWN_CREATOR_RE.test(creatorName)) score -= 30;
  if (String(hit.license || '').toLowerCase() === 'pdm' && !context?.historicalTopic) score -= 40;

  score += applyContextScoring(hit, context);

  return score > 0 ? score : -1;
}

// Seuil un peu plus haut : on préfère aucune banque libre qu'un match fragile
// (le repli campus curaté prend le relais ensuite).
const STOCK_MIN_RETAIN_SCORE = 110;

function stockHitFromItem(item, stockUrl = '', meta = {}) {
  const filename = decodeURIComponent(String(stockUrl).split('/').pop() || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ');
  return {
    url: stockUrl,
    width: meta.width || 1280,
    height: meta.height || 720,
    title: meta.title || filename,
    tags: meta.tags || '',
    provider: stockUrl.includes('wikimedia') ? 'wikimedia' : 'openverse',
    license: meta.license || '',
    creator: meta.creator || '',
  };
}

function scoreStockFit(item, stockUrl = '', meta = {}) {
  if (!stockUrl) return -1;
  const context = detectEditorialContext(item);
  const matchTokens = buildMatchTokens(item);
  const hit = stockHitFromItem(item, stockUrl, meta);
  return scoreCandidate(hit, matchTokens, context);
}

function stockStillFits(item, meta = {}) {
  if (!item?.stockImage) return true;

  // Banque campus curatée : on ne re-score pas comme une photo libre.
  // On vérifie seulement les conflits de saison évidents.
  if (item.imageProvider === 'campus-bank') {
    const context = detectEditorialContext(item);
    const hay = normalizeText([
      item.imageTitle || '',
      item.imageCredit || '',
      meta.title || '',
      item.stockImage || '',
    ].join(' '));
    if (context.summerTopic && WINTER_PHOTO_RE.test(hay)) return false;
    if (context.winterTopic && SUMMER_PHOTO_RE.test(hay) && !WINTER_PHOTO_RE.test(hay)) return false;
    return true;
  }

  return scoreStockFit(item, item.stockImage, {
    // Le titre original de la photo (imageTitle) est bien plus fidèle que la
    // ligne de crédit pour juger si elle colle toujours au sujet.
    title: [item.imageTitle || '', item.imageCredit || ''].filter(Boolean).join(' '),
    license: item.imageLicense || '',
    creator: item.imageCreator || '',
    ...meta,
  }) >= STOCK_MIN_RETAIN_SCORE;
}

async function searchOpenverse(query, matchTokens, context = null) {
  const q = encodeURIComponent(query);
  const url = `https://api.openverse.org/v1/images/?q=${q}&page_size=12&license=cc0,by,by-sa,pdm&format=json`;
  const data = await fetchJson(url);
  if (!data?.results?.length) return [];

  return data.results
    .filter((r) => r.url && (r.width || 0) >= 300)
    .map((r) => ({
      url: r.url,
      width: r.width || 0,
      height: r.height || 0,
      creator: parseOpenverseCreator(r),
      license: r.license || '',
      title: r.title || '',
      tags: (r.tags || []).map((t) => t.name || t).join(' '),
      provider: 'openverse',
      foreignLandingUrl: r.foreign_landing_url || r.url,
      score: 0,
    }))
    .map((r) => ({ ...r, score: scoreCandidate(r, matchTokens, context) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

async function searchWikimedia(query, matchTokens, context = null) {
  const q = encodeURIComponent(query);
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1280&format=json`;
  const data = await fetchJson(url);
  const pages = data?.query?.pages;
  if (!pages) return [];

  const out = [];
  for (const page of Object.values(pages)) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    const meta = info.extmetadata || {};
    const artist = stripHtml(meta.Artist?.value || meta.Credit?.value || '');
    const licenseShort = stripHtml(meta.LicenseShortName?.value || 'CC');
    const w = info.thumbwidth || info.width || 0;
    const h = info.thumbheight || info.height || 0;
    const hit = {
      url: info.url,
      width: w,
      height: h,
      creator: cleanCreatorName(artist),
      license: licenseShort,
      licenseShort,
      title: page.title || '',
      tags: page.title || '',
      provider: 'wikimedia',
      foreignLandingUrl: info.descriptionurl || info.url,
      score: 0,
    };
    hit.score = scoreCandidate(hit, matchTokens, context);
    if (hit.score > 0) out.push(hit);
  }
  return out.sort((a, b) => b.score - a.score);
}

function isRasterImageUrl(url = '') {
  const path = String(url).split('?')[0].split('#')[0].toLowerCase();
  // gif/bmp exclus : qualité photo insuffisante pour la une.
  return /\.(jpe?g|png|webp|avif)$/i.test(path);
}

async function validateCandidate(hit) {
  if (!isRasterImageUrl(hit.url)) return null;
  if (meetsLeadDisplaySize(hit.width, hit.height)) return hit;
  const dims = await probeRemoteImageSize(hit.url);
  if (!dims) {
    if (hit.width >= 720 && hit.height >= 405 && hit.width * hit.height >= 320000) return hit;
    return null;
  }
  const enriched = { ...hit, width: dims.width, height: dims.height };
  return meetsLeadDisplaySize(dims.width, dims.height) ? enriched : null;
}

// Nombre maximal de requêtes interrogées et score au-delà duquel on cesse
// d'en lancer de nouvelles : on cherche le meilleur candidat global plutôt
// que le premier venu de la première requête.
const STOCK_QUERY_LIMIT = 8;
const STOCK_STRONG_SCORE = 170;

async function findStockPhoto(item) {
  const context = detectEditorialContext(item);
  const queries = extractSearchQueries(item, context);
  if (!queries.length) return null;

  const matchTokens = buildMatchTokens(item);
  const seen = new Set();
  const pool = [];

  for (const query of queries.slice(0, STOCK_QUERY_LIMIT)) {
    const batches = await Promise.all([
      searchOpenverse(query, matchTokens, context),
      searchWikimedia(query, matchTokens, context),
    ]);
    for (const cand of batches.flat()) {
      if (seen.has(cand.url)) continue;
      seen.add(cand.url);
      pool.push(cand);
    }
    if (pool.some((c) => c.score >= STOCK_STRONG_SCORE)) break;
    await sleep(250);
  }

  pool.sort((a, b) => b.score - a.score);

  for (const cand of pool) {
    // Trié par score décroissant : sous le seuil de rétention, tout ce qui
    // suit est plus faible — mieux vaut aucune photo qu'une photo hors-sujet
    // (qui serait de toute façon retirée à la passe suivante).
    if (cand.score < STOCK_MIN_RETAIN_SCORE) break;
    const valid = await validateCandidate(cand);
    if (!valid) continue;
    // Les dimensions réelles peuvent différer de celles annoncées : re-scorer.
    if (scoreCandidate(valid, matchTokens, context) < STOCK_MIN_RETAIN_SCORE) continue;
    const creator = cleanCreatorName(valid.creator || valid.artist || '');
    return {
      stockImage: valid.url,
      imageTitle: valid.title || '',
      imageCredit: formatAttribution(valid),
      imageCreator: creator,
      imageLicense: valid.license || '',
      imageProvider: valid.provider,
      imageSourceUrl: valid.foreignLandingUrl || valid.url,
    };
  }

  return null;
}

module.exports = {
  extractArticleContent,
  buildMatchTokens,
  detectEditorialContext,
  extractContextualQueries,
  applyContextScoring,
  extractSearchQueries,
  formatAttribution,
  cleanCreatorName,
  findStockPhoto,
  scoreStockFit,
  stockStillFits,
  scoreCandidate,
  STOCK_MIN_RETAIN_SCORE,
  searchOpenverse,
  searchWikimedia,
  SUMMER_TOPIC_RE,
  WINTER_TOPIC_RE,
  WINTER_PHOTO_RE,
};