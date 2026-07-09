/**
 * Banque de photos campus / pavillons (établissements québécois).
 *
 * Dernier recours honnête quand :
 *   - la page source n'a pas de photo éditoriale,
 *   - la recherche libre (Openverse / Commons) ne trouve rien de fiable
 *     pour le sujet de l'article.
 *
 * Sources : Wikimedia Commons (licences libres). Préférence aux vues
 * extérieures distinctives, hors hiver/neige quand c'est possible.
 */

const crypto = require('crypto');

function normalizeKey(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Entrée : { url, title, creator, license, sourceUrl, tags? } */
const BANK = {
  'mcgill university': [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/e/e8/Roddick_Gates_%28McGill_University%29_2005-09-02.jpg',
      title: 'Roddick Gates, McGill University',
      creator: 'Acarpentier',
      license: 'CC BY 2.5',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Roddick_Gates_(McGill_University)_2005-09-02.jpg',
      tags: 'exterior summer autumn gates campus montreal',
    },
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/2/2d/McGill_University_Montr%C3%A9al.jpeg',
      title: 'McGill University, Montréal',
      creator: 'Thomas1313',
      license: 'CC BY-SA 4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:McGill_University_Montr%C3%A9al.jpeg',
      tags: 'exterior arts building campus montreal green',
    },
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/6/62/Roddick_Gates_closed%2C_McGill_University%2C_July_17%2C_2024.jpg',
      title: 'Roddick Gates closed, McGill University, July 17, 2024',
      creator: 'Gen. Quon',
      license: 'CC BY-SA 4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Roddick_Gates_closed,_McGill_University,_July_17,_2024.jpg',
      tags: 'exterior summer july gates campus montreal',
    },
  ],
  'universite mcgill': [
    // alias → same as mcgill (resolved via alias map)
  ],
  'universite de montreal': [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Universit%C3%A9_de_Montr%C3%A9al%2C_Pavillon_Roger-Gaudry.JPG',
      title: 'Université de Montréal, Pavillon Roger-Gaudry',
      creator: 'Jeangagnon',
      license: 'CC BY-SA 3.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Universit%C3%A9_de_Montr%C3%A9al,_Pavillon_Roger-Gaudry.JPG',
      tags: 'exterior tower campus montreal building',
    },
  ],
  udem: [],
  uqam: [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/2/2f/UQAM-Judith-Jasmin.jpg',
      title: 'UQAM — Pavillon Judith-Jasmin',
      creator: 'Jeangagnon',
      license: 'CC BY-SA 3.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:UQAM-Judith-Jasmin.jpg',
      tags: 'exterior campus montreal judith jasmin',
    },
  ],
  'universite du quebec a montreal': [],
  'concordia university': [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/1/16/CJ_Building%2C_Loyola_Campus%2C_Communication_Studies%2C_Concordia_University.jpg',
      title: 'CJ Building, Loyola Campus, Concordia University',
      creator: 'Gen. Quon',
      license: 'CC BY-SA 4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:CJ_Building,_Loyola_Campus,_Communication_Studies,_Concordia_University.jpg',
      tags: 'exterior loyola campus montreal building',
    },
  ],
  'universite laval': [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/f/f9/Universit%C3%A9_Laval%2C_Quebec_Canada_3.jpg',
      title: 'Université Laval, Quebec Canada',
      creator: 'Dxlinh',
      license: 'CC BY-SA 4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Universit%C3%A9_Laval,_Quebec_Canada_3.jpg',
      tags: 'exterior campus quebec city modern',
    },
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/d/de/Universit%C3%A9_Laval%2C_Quebec%2C_Canada_02.jpg',
      title: 'Université Laval, Quebec, Canada 02',
      creator: 'Dxlinh',
      license: 'CC BY-SA 4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Universit%C3%A9_Laval,_Quebec,_Canada_02.jpg',
      tags: 'exterior campus quebec city',
    },
  ],
  'universite de sherbrooke': [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/af/Campus_de_Longueuil_-_Universite_de_Sherbrooke_09.jpg',
      title: 'Campus de Longueuil — Université de Sherbrooke',
      creator: 'Jeangagnon',
      license: 'CC BY-SA 4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Campus_de_Longueuil_-_Universite_de_Sherbrooke_09.jpg',
      tags: 'exterior campus longueuil sherbrooke modern',
    },
  ],
  "bishop's university": [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/b/b3/Bishop%27s_University_campus_2011.jpg',
      title: "Bishop's University campus 2011",
      creator: 'Balcer',
      license: 'CC BY 3.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Bishop%27s_University_campus_2011.jpg',
      tags: 'exterior campus lennoxville green summer',
    },
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/e/ea/Bishop%27s_University_McGreer_Hall.jpg',
      title: "Bishop's University McGreer Hall",
      creator: 'Balcer',
      license: 'CC BY 3.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Bishop%27s_University_McGreer_Hall.jpg',
      tags: 'exterior campus lennoxville building',
    },
  ],
  'universite du quebec a trois rivieres': [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/4/47/Pavillon_Pierre-Boucher_UQTR.jpg',
      title: 'Pavillon Pierre-Boucher, UQTR',
      creator: 'Jeangagnon',
      license: 'CC BY-SA 3.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Pavillon_Pierre-Boucher_UQTR.jpg',
      tags: 'exterior campus trois-rivieres building',
    },
  ],
  'cegep du vieux montreal': [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/9/94/C%C3%A9gep_du_Vieux_Montr%C3%A9al01.JPG',
      title: 'Cégep du Vieux Montréal',
      creator: 'Jeangagnon',
      license: 'CC BY-SA 3.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:C%C3%A9gep_du_Vieux_Montr%C3%A9al01.JPG',
      tags: 'exterior cegep montreal',
    },
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/6/6c/C%C3%A9gep_du_Vieux_Montr%C3%A9al%2C_Nov_03_2022.jpg',
      title: 'Cégep du Vieux Montréal, Nov 03 2022',
      creator: 'Gen. Quon',
      license: 'CC BY-SA 4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:C%C3%A9gep_du_Vieux_Montr%C3%A9al,_Nov_03_2022.jpg',
      tags: 'exterior cegep montreal autumn',
    },
  ],
  'cegep de jonquiere': [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/f/f4/Pavillon_principal_du_C%C3%A9gep_de_Jonqui%C3%A8re.jpg',
      title: 'Pavillon principal du Cégep de Jonquière',
      creator: 'Jeangagnon',
      license: 'CC BY-SA 4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Pavillon_principal_du_C%C3%A9gep_de_Jonqui%C3%A8re.jpg',
      tags: 'exterior cegep jonquiere saguenay',
    },
  ],
};

const ALIASES = {
  'universite mcgill': 'mcgill university',
  mcgill: 'mcgill university',
  'universite de montreal': 'universite de montreal',
  udem: 'universite de montreal',
  'u de m': 'universite de montreal',
  'universite du quebec a montreal': 'uqam',
  'universite du quebec a montreal uqam': 'uqam',
  concordia: 'concordia university',
  ulaval: 'universite laval',
  laval: 'universite laval',
  sherbrooke: 'universite de sherbrooke',
  'u de s': 'universite de sherbrooke',
  bishops: "bishop's university",
  "bishop s university": "bishop's university",
  uqtr: 'universite du quebec a trois rivieres',
  'universite du quebec a trois-rivieres': 'universite du quebec a trois rivieres',
  'vieux montreal': 'cegep du vieux montreal',
  'cegep du vieux montreal': 'cegep du vieux montreal',
  jonquiere: 'cegep de jonquiere',
  'cegep de jonquiere atm journalisme': 'cegep de jonquiere',
  'cegep de jonquiere (atm journalisme)': 'cegep de jonquiere',
};

// Résoudre alias → liste (y compris listes vides qui pointent vers une clé peuplée)
function resolveBankKey(institution = '') {
  const raw = normalizeKey(institution).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (BANK[raw]?.length) return raw;
  if (ALIASES[raw] && BANK[ALIASES[raw]]?.length) return ALIASES[raw];

  // Correspondance partielle (ex. « Cégep de Jonquière (ATM – journalisme) »)
  for (const key of Object.keys(BANK)) {
    if (!BANK[key]?.length) continue;
    if (raw.includes(key) || key.includes(raw)) return key;
  }
  for (const [alias, target] of Object.entries(ALIASES)) {
    if ((raw.includes(alias) || alias.includes(raw)) && BANK[target]?.length) return target;
  }
  return null;
}

function bankEntriesFor(institution = '') {
  const key = resolveBankKey(institution);
  if (!key) return [];
  return BANK[key] || [];
}

const WINTER_RE = /\b(snow|neige|winter|hiver|glacial|blizzard|ice rink|patinoire)\b/i;
const SUMMER_RE = /\b(summer|ete|été|july|juillet|june|juin|august|aout|août|terrasse|warm|chaud)\b/i;

/**
 * Choisit une photo campus pour l'article.
 * @param {{ institution?: string, link?: string, title?: string, excerpt?: string }} item
 * @param {{ preferSeason?: 'summer'|'winter'|'any' }} [opts]
 */
function pickCampusPhoto(item = {}, opts = {}) {
  const entries = bankEntriesFor(item.institution || '');
  if (!entries.length) return null;

  const hayArticle = `${item.title || ''} ${item.excerpt || ''} ${item.leadExcerpt || ''}`;
  let pool = entries.slice();

  const prefer = opts.preferSeason
    || (SUMMER_RE.test(hayArticle) ? 'summer'
      : (WINTER_RE.test(hayArticle) ? 'winter' : 'any'));

  if (prefer === 'summer') {
    const noWinter = pool.filter((e) => !WINTER_RE.test(`${e.title} ${e.tags || ''}`));
    if (noWinter.length) pool = noWinter;
    const summerish = pool.filter((e) => SUMMER_RE.test(`${e.title} ${e.tags || ''}`));
    if (summerish.length) pool = summerish;
  } else if (prefer === 'winter') {
    const winterish = pool.filter((e) => WINTER_RE.test(`${e.title} ${e.tags || ''}`));
    if (winterish.length) pool = winterish;
  }

  // Variété stable par article (pas toujours la même photo pour un même campus).
  const seed = String(item.link || item.title || item.institution || 'x');
  const hash = crypto.createHash('sha1').update(seed).digest();
  const idx = hash[0] % pool.length;
  const pick = pool[idx];

  return {
    stockImage: pick.url,
    imageTitle: pick.title || '',
    imageCredit: `Photo : ${pick.creator || 'Auteur·e inconnu·e'} / ${pick.license || 'CC'} · Wikimedia Commons`,
    imageCreator: pick.creator || '',
    imageLicense: pick.license || '',
    imageProvider: 'campus-bank',
    imageSourceUrl: pick.sourceUrl || pick.url,
    _campusBank: true,
  };
}

function hasCampusBank(institution = '') {
  return bankEntriesFor(institution).length > 0;
}

module.exports = {
  BANK,
  ALIASES,
  normalizeKey,
  resolveBankKey,
  bankEntriesFor,
  pickCampusPhoto,
  hasCampusBank,
};
