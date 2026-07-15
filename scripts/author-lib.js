/**
 * Extraction et réconciliation des auteurs — partagé par fetch-news et verify-authors.
 *
 * Priorité : byline visible sur la page > extrait « Par … » > RSS (si fiable).
 * En cas de conflit ou de doute (auteur flux par défaut, doublons divergents) :
 * « La rédaction » / « The editorial team ».
 */

const GENERIC_AUTHORS = /^(admin|administrator|administrateur|editor|éditeur|editeur|rédaction|redaction|staff|wordpress|webmaster|collectif|tribune|link|daily|coordinating|exemplaire|quartier libre|zone campus|la pige|le délit|le delit|the link|the tribune|the mcgill daily|the campus|the plant|theplantnews)$/i;

const EDITORIAL_BYLINE_RE = /^(?:Par|By)\s+(?:(?:La|L')\s*)?[Rr]édaction\b\.?/i;
const EDITORIAL_BYLINE_EN_RE = /^(?:Par|By)\s+Editorial\s+(?:team|staff|board)\b\.?/i;

const BYLINE_ARTICLE_STARTERS = /^(Le|La|Les|L'|L'|Un|Une|The|An|À|A)$/iu;
const NAME_PARTICLES = new Set(['de', 'du', 'des', 'd', 'la', 'le', 'les', 'van', 'von', 'st', 'ste', 'saint', 'sainte']);

const FEED_DEFAULT_MIN_SHARE = 0.5;
const FEED_DEFAULT_MIN_COUNT = 3;

function stripHtml(text = '') {
  return String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const { decodeHtmlEntities } = require('./html-entities-lib');

function decodeBasicEntities(str = '') {
  return decodeHtmlEntities(str);
}

function editorialFallback(lang = 'fr') {
  return lang === 'en' ? 'The editorial team' : 'La rédaction';
}

function canonicalizeEditorialAuthor(name = '') {
  const a = stripHtml(name).replace(/^(?:Par|By)\s+/i, '').replace(/\s+/g, ' ').trim();
  if (/^(?:la\s+|l')\s*rédaction$/i.test(a) || /^redaction$/i.test(a)) return 'La rédaction';
  if (/^editorial\s+(?:team|staff|board)$/i.test(a) || /^the\s+editorial\s+team$/i.test(a)) {
    return 'The editorial team';
  }
  if (/^staff\s+writers?$/i.test(a)) return 'The editorial team';
  return '';
}

const CONTRIBUTOR_DASH = '(?:[–—\\-]|&#8211;|&ndash;|&mdash;)';
/**
 * Rôles de byline : Staff Writer, Sports Editor, Director of …, etc.
 * IMPORTANT : ne jamais utiliser * non borné sur [A-Za-z]+… — backtracking
 * catastrophique sur des extraits sans tiret/rôle (hang CI 12+ min).
 */
const CONTRIBUTOR_ROLE = '(?:'
  + 'Contributor|Staff Writer|Staff|Reporter|Columnist|Correspondent'
  // « Sports Editor », « Arts & Culture Editor », « Managing Editor », …
  + '|(?:[A-Za-z]+(?:\\s+|&amp;|&|\\s+and\\s+|\\s+&\\s+)?){0,6}(?:Editor(?:-in-Chief)?|Writer)'
  + '|Director of [A-Za-z\\s&\'’.-]{2,40}'
  + '|Photographer|Illustrator|Photo Editor'
  + ')';
const CONTRIBUTOR_BYLINE_RE = new RegExp(
  `^([\\p{Lu}][\\p{L}'’.\\-]+(?:\\s+[\\p{Lu}][\\p{L}'’.\\-]+){0,3})\\s*${CONTRIBUTOR_DASH}\\s*${CONTRIBUTOR_ROLE}\\b`,
  'iu',
);
const CONTRIBUTOR_HTML_RE = new RegExp(
  `<strong>\\s*([\\p{Lu}][\\p{L}'’.\\-]+(?:\\s+[\\p{Lu}][\\p{L}'’.\\-]+){0,3})\\s*${CONTRIBUTOR_DASH}\\s*${CONTRIBUTOR_ROLE}\\s*<\\/strong>`,
  'iu',
);

function looksLikeMultiAuthorList(name = '') {
  const a = String(name).replace(/\s+/g, ' ').trim();
  if (!/,/.test(a) && !/\s+and\s+/i.test(a) && !/\s+et\s+/i.test(a)) return false;
  const chunks = a
    .split(/\s*,\s*|\s+and\s+|\s+et\s+/i)
    .map((c) => c.replace(/^(?:and|et)\s+/i, '').trim())
    .filter(Boolean);
  if (chunks.length < 2 || chunks.length > 4) return false;
  return chunks.every((chunk) => {
    const words = chunk.split(/\s+/).filter(Boolean);
    return words.length >= 1 && words.length <= 5
      && words.every((w) => /^[\p{Lu}][\p{L}'’.\-]+$/u.test(w));
  });
}

function isJunkAuthorName(name = '') {
  const a = String(name).replace(/\s+/g, ' ').trim();
  if (!a || a.length < 2 || a.length > 120) return true;
  if (/^[,;:.]/.test(a) || /[,;]{2,}/.test(a)) return true;
  if (/\bfunction\s*\(/.test(a) || /[{}\[\]]/.test(a)) return true;
  if (/https?:\/\//i.test(a) || /\.(?:php|js|css)\b/i.test(a)) return true;
  if (/\b(?:wp-content|wp-admin|wp-block|prefetch|selector_matches|splide)\b/i.test(a)) return true;
  if (/\b(?:Recent Posts|Skip to content|Written by|Read more|Lire la suite)\b/i.test(a)) return true;
  if (/\b(?:photo|crédit|credit)\s*:/i.test(a)) return true;
  if (/\d+\s*,\s*\d+\s*,\s*[\d.]+\s*/.test(a)) return true;
  if (/\b(?:rgba?|box-shadow|max-width|font-family|\.td-|\.wp-|\.molongui|Open Sans)\b/i.test(a)) return true;
  if (/[`'"]\s*,\s*[`'"]/.test(a)) return true;
  if (a.split(/\s+/).length > 6 && !looksLikeMultiAuthorList(a)) return true;
  return false;
}

/** « Nathan Brisbois et Elora Veyron-Churlet » → noms joints. */
function expandAuthorName(name = '', lang = 'fr') {
  const raw = decodeBasicEntities(stripHtml(name)).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (/\s+et\s+|\s+and\s+/i.test(raw)) {
    const parts = raw.split(/\s+et\s+|\s+and\s+/i).map((p) => normalizeAuthor(p)).filter(Boolean);
    if (parts.length > 1) return joinAuthorNames(parts, lang);
  }
  return normalizeAuthor(raw);
}

function normalizeAuthor(name = '') {
  let a = decodeBasicEntities(stripHtml(name));
  const paren = a.match(/\(([^)]+)\)/);
  if (paren) a = paren[1];
  a = a.replace(/^(?:Par|By)\s+/i, '').replace(/\s+/g, ' ').trim();
  const editorial = canonicalizeEditorialAuthor(a);
  if (editorial) return editorial;
  if (!a || a.length < 2 || GENERIC_AUTHORS.test(a) || /@/.test(a) || isJunkAuthorName(a)) return '';
  return a.slice(0, 120);
}

function isEditorialPlaceholder(name = '', lang = 'fr') {
  const a = normalizeAuthor(name);
  return !!canonicalizeEditorialAuthor(a) || a === editorialFallback(lang === 'en' ? 'en' : 'fr');
}

/** « A, B et C » ou « A and B » */
function joinAuthorNames(names = [], lang = 'fr') {
  const list = [...new Set(names.map((n) => normalizeAuthor(n)).filter(Boolean))];
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  const conj = lang === 'en' ? ' and ' : ' et ';
  if (list.length === 2) return `${list[0]}${conj}${list[1]}`;
  return `${list.slice(0, -1).join(', ')}${conj}${list[list.length - 1]}`;
}

function authorsFromRelLinks(html = '') {
  const names = [...html.matchAll(/<a[^>]*\brel=["']author["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => normalizeAuthor(stripHtml(m[1])))
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * The Link (ExpressionEngine) :
 *   <div class="byline"><span class="topic-badge">News</span>
 *   <a href="/author/racha-rais">Racha Rais</a> &mdash; Published …</div>
 * Le lien n'a pas rel=author — sans ce sélecteur, la page ne rendait aucun auteur.
 */
function authorsFromLinkByline(html = '') {
  const names = [];
  for (const m of html.matchAll(
    /class=["'][^"']*\bbyline\b[^"']*["'][^>]*>[\s\S]{0,500}?<a[^>]+href=["'][^"']*\/author\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const n = expandAuthorName(m[1]);
    if (n && !isJunkAuthorName(n)) names.push(n);
  }
  // Repli : liens /author/slug près du badge de rubrique
  if (!names.length) {
    for (const m of html.matchAll(
      /topic-badge[\s\S]{0,200}?<a[^>]+href=["'][^"']*\/author\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      const n = expandAuthorName(m[1]);
      if (n && !isJunkAuthorName(n)) names.push(n);
    }
  }
  return [...new Set(names)];
}

/** La Pige / thèmes « post-author » (itemprop author, lien sans rel=author). */
function authorsFromPostAuthor(html = '') {
  const names = [];
  for (const m of html.matchAll(
    /class=["'][^"']*\bpost-author\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/gi,
  )) {
    const n = expandAuthorName(m[1]);
    if (n) names.push(n);
  }
  return [...new Set(names)];
}

function authorsFromAuthorNameBlock(html = '') {
  const names = [];
  // Gutenberg « post-author-name » (lien) et « post-author__name » (The Campus, etc.)
  const patterns = [
    /class=["'][^"']*wp-block-post-author-name__link[^"']*["'][^>]*>([^<]+)<\/a>/gi,
    /class=["'][^"']*\bwp-block-post-author__name\b[^"']*["'][^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi,
    /class=["'][^"']*\bwp-block-post-author__name\b[^"']*["'][^>]*>\s*([^<]{2,80})</gi,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      const n = expandAuthorName(m[1]);
      if (n) names.push(n);
    }
  }
  return [...new Set(names)];
}

/**
 * The Campus / bylines WP en gras en tête de corps :
 *   <strong>Henri Dessureaux – Contributor</strong>
 *   <strong>Name – Sports Editor</strong>
 * (le compte WP « The Campus » est dans le bloc post-author — générique.)
 */
function authorsFromStrongRoleByline(html = '') {
  if (!html) return [];
  const names = [];
  for (const m of html.matchAll(/<strong\b[^>]*>([\s\S]{3,100}?)<\/strong>/gi)) {
    const plain = decodeBasicEntities(stripHtml(m[1])).replace(/\s+/g, ' ').trim();
    if (!plain || plain.length > 90) continue;
    const pipe = plain.match(
      /^([\p{Lu}][\p{L}'’.\-]+(?:\s+[\p{Lu}][\p{L}'’.\-]+){0,4})\s*[|–—\-]\s*(.+)$/u,
    );
    if (!pipe) continue;
    const role = pipe[2].trim();
    if (!PLANT_ROLE_LINE_RE.test(role) && !/^contributor/i.test(role)) continue;
    const n = expandAuthorName(pipe[1], 'en');
    if (n && !isJunkAuthorName(n) && !isEditorialPlaceholder(n, 'en')) {
      names.push(n);
    }
  }
  return [...new Set(names)];
}

/**
 * Concentre le HTML sur les zones utiles (corps d'article + blocs auteur).
 * Évite de couper la byline réelle qui est souvent après 80k de CSS/thème WP
 * (ex. The Campus : « Henri Dessureaux – Contributor » vers offset 82k+).
 */
function focusHtmlForAuthorExtraction(html = '', maxLen = 100_000) {
  if (!html) return '';
  const chunks = [];

  // Blocs auteur Gutenberg (haut de page, souvent avant le corps)
  for (const m of html.matchAll(
    /class=["'][^"']*\bwp-block-post-author\b[^"']*["'][^>]*>[\s\S]{0,2500}/gi,
  )) {
    chunks.push(m[0]);
    if (chunks.length >= 4) break;
  }

  // Neve / McGill Daily : byline « by <a rel=author>… » juste avant entry-content
  // (souvent ~100k — hors du slice head 28k et hors du corps article).
  for (const m of html.matchAll(
    /class=["'][^"']*(?:\bnv-meta-list\b|\bmeta\s+author\b|\bauthor-name\b|\bauthor\s+vcard\b)[^"']*["'][^>]*>[\s\S]{0,2000}/gi,
  )) {
    chunks.push(m[0]);
    if (chunks.length >= 8) break;
  }

  // Liens rel=author isolés (thèmes WP classiques)
  for (const m of html.matchAll(
    /<a[^>]*\brel=["'][^"']*\bauthor\b[^"']*["'][^>]*>[\s\S]{0,200}?<\/a>/gi,
  )) {
    chunks.push(m[0]);
    if (chunks.length >= 12) break;
  }

  // Corps d'article (byline « Name – Role » en tête)
  const bodyRes = [
    /class=["'][^"']*(?:entry-content|wp-block-post-content|post-content|article-content|td-post-content)[^"']*["'][^>]*>([\s\S]{0,45000})/i,
    /itemprop=["']articleBody["'][^>]*>([\s\S]{0,45000})/i,
    /<(?:article|main)\b[^>]*>([\s\S]{0,45000})/i,
  ];
  for (const re of bodyRes) {
    const m = html.match(re);
    if (m) {
      chunks.push(m[0]);
      break;
    }
  }

  // Méta head (og:description « Par … », meta name=author, dc.creator)
  chunks.push(html.slice(0, 28_000));

  // Yoast JSON-LD (souvent en fin de page) — Person.name pour l'auteur
  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    if (/@type"\s*:\s*"Person"|author/i.test(m[1])) {
      chunks.push(m[0]);
      if (chunks.length >= 16) break;
    }
  }

  const focused = chunks.filter(Boolean).join('\n\n');
  if (focused.length >= 400) {
    return focused.length > maxLen ? focused.slice(0, maxLen) : focused;
  }
  return html.length > maxLen ? html.slice(0, maxLen) : html;
}

/** TagDiv (L'Exemplaire, etc.) — byline « Par » + lien auteur. */
function authorsFromTdPostAuthor(html = '') {
  const names = [];
  for (const m of html.matchAll(
    /class=["'][^"']*\btd-post-author-name\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/gi,
  )) {
    const n = expandAuthorName(m[1]);
    if (n) names.push(n);
  }
  return [...new Set(names)];
}

/**
 * The Plant (et thèmes WP block) — bylines en tête de corps, sans rel=author :
 *   <p>By Atika Ume Fazal</p><p>News Editor</p>
 *   <p>Jacqueline Graif<br>Editor-in-Chief</p>
 *   <p>Chloe Bercovitz</p><p>Managing Editor</p>
 *   <p>Minola Grent | Editor-in-Chief</p>
 *   <p>Bethany …, Pohanna …, and Ana …</p><p>Contributors</p>
 * On lit les premiers <p> (texte plat) — pas de regex lourde sur tout le HTML.
 */
const PLANT_ROLE_LINE_RE = /^(?:Editor(?:-in-Chief)?|News Editor|Sports Editor|Arts(?:\s*&\s*Culture)?\s+(?:Editor|Correspondent)|Managing Editor|Staff Writer|Copy Editor|Contributors?|Contributor|Reporter|Correspondent|Photo Editor|Opinions Editor|Features? Editor|Online Editor|Assistant Editor)s?\.?$/i;

function looksLikePersonNameLine(text = '') {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t || t.length < 3 || t.length > 120) return false;
  if (/^(?:Via|Photo|Source|Image|Cover)\b/i.test(t)) return false;
  if (PLANT_ROLE_LINE_RE.test(t)) return false;
  // Un ou plusieurs noms propres (virgules / and)
  if (looksLikeMultiAuthorList(t)) return true;
  // Phrases (autoriser l'initiale « H. » dans un nom : Tessa H. Chabot)
  if (/[!?:;]/.test(t)) return false;
  if (/\.\s+\p{Lu}/u.test(t) && !/(?:^|\s)\p{Lu}\.\s+\p{Lu}/u.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  return words.every(
    (w) => /^[\p{Lu}][\p{L}'’.\-]*\.?$/u.test(w) || NAME_PARTICLES.has(w.toLowerCase()),
  );
}

function authorsFromStandaloneByParagraph(html = '') {
  if (!html) return [];
  const bodyMatch = html.match(
    /class=["'][^"']*(?:entry-content|wp-block-post-content|post-content|article-content)[^"']*["'][^>]*>([\s\S]{0,5000})/i,
  );
  const region = bodyMatch ? bodyMatch[1] : '';
  if (!region) return [];

  const paras = [];
  for (const m of region.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const plain = decodeBasicEntities(
      stripHtml(m[1].replace(/<br\s*\/?>/gi, ' | ')),
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) paras.push(plain);
    if (paras.length >= 8) break;
  }

  const names = [];

  for (let i = 0; i < paras.length; i += 1) {
    const p = paras[i];
    // Légende photo « Via … » — sauter
    if (/^Via\b/i.test(p)) continue;

    // « By Name » / « Par Name »
    const by = p.match(/^(?:By|Par)\s+(.+)$/i);
    if (by) {
      const n = expandAuthorName(by[1], 'en');
      if (n && !isJunkAuthorName(n) && !isEditorialPlaceholder(n, 'en')) {
        names.push(n);
        break;
      }
    }

    // « Name | Role » ou « Name – Role » sur une ligne
    const pipe = p.match(
      /^([\p{Lu}][\p{L}'’.\-]+(?:\s+[\p{Lu}][\p{L}'’.\-]+){0,4})\s*[|–—\-]\s*(.+)$/u,
    );
    if (pipe && PLANT_ROLE_LINE_RE.test(pipe[2].trim())) {
      const n = expandAuthorName(pipe[1], 'en');
      if (n && !isJunkAuthorName(n)) {
        names.push(n);
        break;
      }
    }

    // « Name » puis paragraphe suivant = rôle
    const next = paras[i + 1] || '';
    if (looksLikePersonNameLine(p) && PLANT_ROLE_LINE_RE.test(next)) {
      if (looksLikeMultiAuthorList(p)) {
        const joined = joinAuthorNames(splitMultiAuthorLabel(p), 'en');
        if (joined) {
          names.push(joined);
          break;
        }
      }
      const n = expandAuthorName(p, 'en');
      if (n && !isJunkAuthorName(n) && !isEditorialPlaceholder(n, 'en')) {
        names.push(n);
        break;
      }
    }
  }

  return [...new Set(names)];
}

function authorsFromSchemaPerson(html = '') {
  const names = [];
  for (const m of html.matchAll(
    /itemprop=["']author["'][\s\S]*?itemprop=["']name["'][^>]*content=["']([^"']+)/gi,
  )) {
    const n = expandAuthorName(m[1]);
    if (n) names.push(n);
  }
  // Yoast / schema.org JSON-LD : Person dans @graph (The McGill Daily, etc.)
  for (const block of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse(block[1]);
      const nodes = [];
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        nodes.push(node);
        if (node['@graph']) walk(node['@graph']);
        if (node.author) walk(node.author);
      };
      walk(parsed);
      for (const node of nodes) {
        const type = String(node['@type'] || '');
        if (!/\bPerson\b/i.test(type)) continue;
        const n = expandAuthorName(node.name || '');
        if (n && !isJunkAuthorName(n)) names.push(n);
      }
      // Article.author peut être une liste de Person ou de chaînes
      for (const node of nodes) {
        if (!node.author) continue;
        const authors = Array.isArray(node.author) ? node.author : [node.author];
        for (const a of authors) {
          if (typeof a === 'string') {
            const n = expandAuthorName(a);
            if (n) names.push(n);
          } else if (a && typeof a === 'object' && a.name) {
            const n = expandAuthorName(a.name);
            if (n) names.push(n);
          }
        }
      }
    } catch {
      /* JSON-LD mal formé */
    }
  }
  return [...new Set(names)];
}

/**
 * Neve / thèmes WP : <li class="meta author vcard"><span class="author-name fn">by
 * <a rel="author">Name</a></span>
 */
function authorsFromMetaAuthorVcard(html = '') {
  const names = [];
  for (const m of html.matchAll(
    /class=["'][^"']*\b(?:meta\s+author|author\s+vcard|author-name|nv-meta-list)\b[^"']*["'][^>]*>[\s\S]{0,500}?<a[^>]*(?:rel=["'][^"']*author[^"']*["']|href=["'][^"']*\/author\/)[^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const n = expandAuthorName(m[1]);
    if (n && !isJunkAuthorName(n)) names.push(n);
  }
  // Multi-auteurs : plusieurs <a rel=author> dans le même bloc meta
  for (const block of html.matchAll(
    /class=["'][^"']*\bmeta\s+author\b[^"']*["'][^>]*>([\s\S]{0,800}?)<\/li>/gi,
  )) {
    for (const a of block[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)) {
      const n = expandAuthorName(a[1]);
      if (n && !isJunkAuthorName(n)) names.push(n);
    }
  }
  return [...new Set(names)];
}

function splitMultiAuthorLabel(text = '') {
  const raw = decodeBasicEntities(stripHtml(text)).replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  if (!/[,&]|\bet\b|\band\b/i.test(raw)) return [raw];
  return raw
    .split(/\s*,\s*|\s+et\s+|\s+and\s+/i)
    .map((part) => part.replace(/^and\s+/i, '').trim())
    .filter(Boolean);
}

function tribuneAuthorRegion(html = '') {
  const side = html.match(
    /class=["'][^"']*\bpost_author_side\b[^"']*["'][\s\S]*?<\/(?:div|section)>/i,
  );
  if (side) return side[0];
  const meta = html.match(
    /class=["'][^"']*\bentry-author\b[^"']*["'][^>]*>[\s\S]*?<\/time>/i,
  );
  return meta ? meta[0] : html.slice(0, 100000);
}

/** The Tribune — lien ?tribune_author=Nom+Prénom dans la byline entry-author. */
function authorsFromTribuneAuthor(html = '') {
  const region = tribuneAuthorRegion(html);
  const names = [];
  const tribuneMatch = region.match(/tribune_author=([^"'&]+)/i);
  if (tribuneMatch) {
    const decoded = decodeURIComponent(tribuneMatch[1].replace(/\+/g, ' '));
    for (const part of splitMultiAuthorLabel(decoded)) {
      const n = expandAuthorName(part);
      if (n) names.push(n);
    }
  }
  const entryAuthor = region.match(
    /class=["'][^"']*\bentry-author\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
  );
  if (entryAuthor) {
    const label = stripHtml(entryAuthor[1]);
    if (label && !/^author$/i.test(label)) {
      for (const part of splitMultiAuthorLabel(label)) {
        const n = expandAuthorName(part);
        if (n) names.push(n);
      }
    }
  }
  return [...new Set(names)];
}

/** Sélecteurs documentés dans botHints.authors.selectors. */
function authorsFromHintSelectors(html = '', hints = {}) {
  const selectors = Array.isArray(hints.selectors) ? hints.selectors : [];
  if (!selectors.length) return [];

  const names = [];
  for (const sel of selectors) {
    const key = String(sel).trim().toLowerCase();
    if (key === 'tribune_author' || key === 'entry-author') {
      names.push(...authorsFromTribuneAuthor(html));
    } else if (key === 'post-author') {
      names.push(...authorsFromPostAuthor(html));
    } else if (key === 'td-post-author-name') {
      names.push(...authorsFromTdPostAuthor(html));
    } else if (key === 'rel-author') {
      names.push(...authorsFromRelLinks(html));
    } else if (key === 'schema.org/person' || key === 'schema-person') {
      names.push(...authorsFromSchemaPerson(html));
    }
  }
  return [...new Set(names.map((n) => normalizeAuthor(n)).filter(Boolean))];
}

function normAuthorKey(name = '') {
  return normalizeAuthor(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function authorsAgree(...names) {
  const keys = names.map((n) => normalizeAuthor(n)).filter(Boolean).map(normAuthorKey);
  return new Set(keys).size <= 1;
}

const MANGLED_TAIL_WORDS = /^(?:après|avant|dans|pour|avec|sans|sous|sur|entre|depuis|pendant|lors|comme|mais|donc|alors|vers|chez|when|after|before|from|into|about)$/i;

/** Auteurs RSS mal fusionnés avec le début du texte (« Médéric Dens Après »). */
function trimMangledAuthor(name = '') {
  const a = normalizeAuthor(name);
  const parts = a.split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return a;
  if (parts.length >= 3 && NAME_PARTICLES.has(parts[1].toLowerCase())) {
    return parts.slice(0, Math.min(parts.length, 4)).join(' ');
  }
  if (parts.length >= 3 && MANGLED_TAIL_WORDS.test(parts[2].replace(/[,;:]$/, ''))) {
    return parts.slice(0, 2).join(' ');
  }
  return a;
}

function extractBylineFromText(text = '') {
  // Tête seulement : bylines en début d'extrait ; évite regex lourdes sur le corps.
  const plain = stripHtml(text).slice(0, 400);
  if (EDITORIAL_BYLINE_RE.test(plain)) {
    return {
      author: 'La rédaction',
      body: plain.replace(EDITORIAL_BYLINE_RE, '').trim(),
    };
  }
  if (EDITORIAL_BYLINE_EN_RE.test(plain)) {
    return {
      author: 'The editorial team',
      body: plain.replace(EDITORIAL_BYLINE_EN_RE, '').trim(),
    };
  }

  // Contributor/role : uniquement si la tête ressemble à « Name – Role »
  if (/[–—\-]/.test(plain.slice(0, 80))) {
    const contributor = plain.match(CONTRIBUTOR_BYLINE_RE);
    if (contributor) {
      const author = normalizeAuthor(contributor[1]);
      const body = plain.slice(contributor[0].length).trim();
      if (author && body.length >= 8) return { author, body };
    }
  }

  if (!/^(?:Par|By)\s+/i.test(plain)) return { author: '', body: plain };

  const tokens = plain.replace(/^\s*(?:Par|By)\s+/i, '').split(/\s+/);
  const nameParts = [];
  let i = 0;
  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (nameParts.length >= 1 && BYLINE_ARTICLE_STARTERS.test(token)) break;
    if (nameParts.length >= 2) break;
    if (/^[\p{Lu}][\p{L}'’.\-]+$/u.test(token)) nameParts.push(token);
    else break;
  }

  const author = normalizeAuthor(nameParts.join(' '));
  const body = tokens.slice(i).join(' ').trim();
  if (!author || body.length < 8) return { author: '', body: plain };
  return { author, body };
}

function excerptOpensWithByline(excerpt = '') {
  return /^(?:Par|By)\s+/i.test(String(excerpt).trim());
}

/* Crédits de production en fin de billet (balados / newsletters Substack :
   « Produced by X », « Hosted by X », « Written by X »…). Verbes capitalisés
   uniquement : une critique de film écrit « produced by » en minuscules au
   fil de la phrase, alors qu'un crédit ouvre sa ligne avec la majuscule. */
const BODY_CREDIT_STOP = '(?:Cover|Photo|Art|Artwork|Graphics?|Music|Sound|Editing|Edited|Illustration|Design|Mixing|Mixed|Produced|Hosted|Written)';
const BODY_CREDIT_AUTHOR_RE = new RegExp(
  `(?:Written|Produced|Hosted|Reported|Rédigé|Réalisé|Animé|Écrit)\\s+(?:by|par)\\s*:?\\s+([\\p{Lu}][\\p{L}'’.\\-]+(?:\\s+(?!${BODY_CREDIT_STOP}\\b)[\\p{Lu}][\\p{L}'’.\\-]+){0,3})`,
  'u',
);

function authorFromBodyCredits(text = '') {
  // Plafonner : sur un content:encoded long, le regex global peut pathologuer
  // et figer l'event loop (bot CI bloqué 40 min sur The McGill Daily).
  const plain = stripHtml(String(text || '').slice(0, 24_000)).slice(0, 12_000);
  if (!plain || plain.length < 12) return '';
  // Plusieurs crédits possibles : prendre le premier « Written/Produced/… by »
  // qui n'est pas un crédit artistique (Cover art by …).
  const re = new RegExp(BODY_CREDIT_AUTHOR_RE.source, 'gu');
  re.lastIndex = 0;
  let m;
  let guards = 0;
  while ((m = re.exec(plain)) && guards < 20) {
    guards += 1;
    const name = normalizeAuthor(m[1]);
    if (!name || isJunkAuthorName(name)) continue;
    if (/^(?:Substack|WordPress|Wix|Squarespace|ASFA)$/i.test(name)) continue;
    // Rejeter si le match est précédé de Cover/Art (faux positif)
    const before = plain.slice(Math.max(0, m.index - 12), m.index);
    if (/\b(?:cover|art|photo|graphics?)\s*$/i.test(before)) continue;
    return name;
  }
  return '';
}

/**
 * The Campus / thèmes block : « Owen Kitzan – Sports Editor » en tête d'article.
 * Le compte WP est souvent le nom du journal ; la vraie byline est dans le corps.
 * The Campus place parfois la byline juste avant entry-content (pas dedans).
 */
function authorFromOpeningRoleLine(html = '', lang = 'fr') {
  if (!html) return '';
  // Zones prioritaires : corps WP, puis article, puis en-tête proche du titre.
  const regions = [];
  const bodyMatch = html.match(
    /class=["'][^"']*(?:entry-content|wp-block-post-content|post-content|article-content)[^"']*["'][^>]*>([\s\S]{0,2500})/i,
  );
  if (bodyMatch) regions.push(bodyMatch[1]);

  // Fenêtre juste avant le corps (byline The Campus souvent hors entry-content).
  const beforeBody = html.match(
    /([\s\S]{0,1200})class=["'][^"']*(?:entry-content|wp-block-post-content|post-content)[^"']*["']/i,
  );
  if (beforeBody) regions.push(beforeBody[1]);

  const art = html.match(/<article[^>]*>([\s\S]{0,3500})/i);
  if (art) regions.push(art[1]);
  if (!regions.length) regions.push(html.slice(0, 8000));

  for (const region of regions) {
    const plain = stripHtml(region)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!plain) continue;

    // Première byline rôle en tête de zone (ancre ^) ou après un saut de ligne implicite.
    const m = plain.match(CONTRIBUTOR_BYLINE_RE)
      || plain.match(new RegExp(
        `(?:^|\\.\\s+|\\s{2,})([\\p{Lu}][\\p{L}'’.\\-]+(?:\\s+[\\p{Lu}][\\p{L}'’.\\-]+){0,3})\\s*${CONTRIBUTOR_DASH}\\s*${CONTRIBUTOR_ROLE}\\b`,
        'iu',
      ));
    if (m) {
      const name = normalizeAuthor(m[1]);
      if (name && !isEditorialPlaceholder(name, lang)) return name;
    }
  }
  return '';
}

function normalizeArticleUrl(link = '') {
  try {
    const u = new URL(link);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return String(link).split('?')[0].split('#')[0];
  }
}

function metaContent(html = '', key = '') {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${esc}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m = html.match(re);
  // Décoder les entités (&nbsp;…) sinon « Par Nicolas Mathieu&nbsp;Le… »
  // casse l'extraction de la byline au premier mot.
  if (m) return decodeBasicEntities(stripHtml(m[1]));
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${esc}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? decodeBasicEntities(stripHtml(m2[1])) : '';
}

/**
 * Auteur depuis la page source — priorité à la byline visible « Par … » (rel=author),
 * pas au JSON-LD / dc:creator WordPress (souvent rédacteur·rice technique).
 * `sourceName` : nom du média — un « auteur » identique au nom de la
 * publication (compte technique, ex. rel=author « Le Collectif ») est écarté
 * pour laisser la vraie byline (og:description, etc.) remonter.
 */
function authorFromArticleHtml(html = '', lang = 'fr', hints = {}, sourceName = '') {
  if (!html || html.length < 200) return '';
  // Garder corps + blocs auteur (souvent après 80k de CSS WP) sans scanner
  // tout le document (évite les matchAll pathologiques sur le shell).
  html = focusHtmlForAuthorExtraction(html, 100_000);

  const candidates = [];
  const l = lang === 'en' ? 'en' : 'fr';
  const sourceKey = normAuthorKey(String(sourceName || ''));

  const hintAuthors = authorsFromHintSelectors(html, hints);
  if (hintAuthors.length) {
    candidates.push({ author: joinAuthorNames(hintAuthors, l), trust: 106 });
  }

  // The Campus — « <strong>Name – Contributor</strong> » en tête de corps
  // (prioritaire sur le compte WP générique « The Campus »).
  const strongRole = authorsFromStrongRoleByline(html);
  if (strongRole.length) {
    const joined = joinAuthorNames(strongRole, l);
    const early = expandAuthorName(joined, l) || joined;
    if (early && !isEditorialPlaceholder(early, l)) {
      if (!sourceKey || normAuthorKey(early) !== sourceKey) {
        return early;
      }
    }
    candidates.push({ author: joined, trust: 108 });
  }

  // The Link — byline EE avant tout (évite de confondre « Photo Racha Rais »
  // en légende avec l'absence d'auteur page).
  const linkByline = authorsFromLinkByline(html);
  if (linkByline.length) {
    candidates.push({ author: joinAuthorNames(linkByline, l), trust: 107 });
  }

  // The Plant — paragraphe « By Name » / « Name + rôle » en tête de corps WP.
  // Retour anticipé : évite les extracteurs lourds (openingRole / regex imbriquées)
  // qui pathologuent sur certaines pages WP complètes.
  const standaloneBy = authorsFromStandaloneByParagraph(html);
  if (standaloneBy.length) {
    const joined = joinAuthorNames(standaloneBy, l);
    const early = expandAuthorName(joined, l) || joined;
    if (early && !isEditorialPlaceholder(early, l)) {
      if (!sourceKey || normAuthorKey(early) !== sourceKey) {
        return early;
      }
    }
    candidates.push({ author: joinAuthorNames(standaloneBy, l), trust: 105 });
  }

  const tribuneAuthors = authorsFromTribuneAuthor(html);
  if (tribuneAuthors.length) {
    candidates.push({ author: joinAuthorNames(tribuneAuthors, l), trust: 104 });
  }

  const contributor = html.match(CONTRIBUTOR_HTML_RE);
  if (contributor) {
    candidates.push({ author: contributor[1].replace(/\s+/g, ' ').trim(), trust: 96 });
  }

  for (const key of ['og:description', 'description', 'twitter:description']) {
    const desc = metaContent(html, key);
    if (!desc) continue;
    const fromDesc = extractBylineFromText(desc);
    if (fromDesc.author) {
      candidates.push({ author: fromDesc.author, trust: 94 });
      break;
    }
  }

  const postAuthors = authorsFromPostAuthor(html);
  if (postAuthors.length) {
    candidates.push({ author: joinAuthorNames(postAuthors, l), trust: 102 });
  }

  const tdAuthors = authorsFromTdPostAuthor(html);
  if (tdAuthors.length) {
    candidates.push({ author: joinAuthorNames(tdAuthors, l), trust: 101 });
  }

  const schemaAuthors = authorsFromSchemaPerson(html);
  if (schemaAuthors.length) {
    candidates.push({ author: joinAuthorNames(schemaAuthors, l), trust: 100 });
  }

  const bylineAuthors = authorsFromAuthorNameBlock(html);
  if (bylineAuthors.length) {
    candidates.push({ author: joinAuthorNames(bylineAuthors, l), trust: 100 });
  }

  // Neve / McGill Daily — byline « by Name » (prioritaire sur le compte Coordinating).
  const vcardAuthors = authorsFromMetaAuthorVcard(html);
  if (vcardAuthors.length) {
    candidates.push({ author: joinAuthorNames(vcardAuthors, l), trust: 103 });
  }

  const relAuthors = authorsFromRelLinks(html);
  if (relAuthors.length > 1) {
    candidates.push({ author: joinAuthorNames(relAuthors, l), trust: 98 });
  } else if (relAuthors.length === 1 && !bylineAuthors.length && !vcardAuthors.length) {
    candidates.push({ author: relAuthors[0], trust: 95 });
  }

  // meta name="author" : un ou plusieurs (The McGill Daily : « Erandy Rogel »,
  // « Eva Marriott-Fabre, Sena Ho »). Avant, seul le cas multi-auteurs (virgule)
  // était pris — d'où « The editorial team » sur presque tous les billets Daily.
  const metaAuthor = metaContent(html, 'author');
  if (metaAuthor) {
    if (metaAuthor.includes(',') || /\s+and\s+|\s+et\s+/i.test(metaAuthor)) {
      const parts = splitMultiAuthorLabel(metaAuthor)
        .map((part) => normalizeAuthor(part))
        .filter(Boolean);
      if (parts.length) {
        candidates.push({ author: joinAuthorNames(parts, l), trust: 97 });
      }
    } else {
      const single = expandAuthorName(metaAuthor, l);
      if (single && !isEditorialPlaceholder(single, l)) {
        candidates.push({ author: single, trust: 96 });
      }
    }
  }

  const parSpan = html.match(
    /(?:^|(?<=>))\s*(?:Par|By)\s+(?!<\/)[^<]*<[^>]+>([\s\S]*?)<\/[^>]+>\s*<\/span>/i,
  );
  if (parSpan) {
    const candidate = stripHtml(parSpan[1]);
    if (candidate.length <= 80 && !isJunkAuthorName(candidate)) {
      candidates.push({ author: candidate, trust: 85 });
    }
  }

  const tribune = html.match(/tribune_author=([^"'&]+)/i);
  if (tribune) {
    candidates.push({
      author: decodeURIComponent(tribune[1].replace(/\+/g, ' ')),
      trust: 90,
    });
  }

  const entryAuthor = html.match(
    /class=["'][^"']*entry-author[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
  );
  if (entryAuthor) {
    const name = stripHtml(entryAuthor[1]);
    if (name && !/^author$/i.test(name)) {
      candidates.push({ author: name, trust: 75 });
    }
  }

  const authorTitle = html.match(/class=["'][^"']*author-title[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
  if (authorTitle) candidates.push({ author: stripHtml(authorTitle[1]), trust: 75 });

  for (const key of ['parsely-author', 'article:author', 'dc.creator', 'dc:creator']) {
    const meta = metaContent(html, key);
    if (meta) candidates.push({ author: meta, trust: 40 });
  }

  // Crédit de production dans le corps (« Produced by X », « Hosted by X »…) —
  // signal nominal des billets Substack signés au nom de la publication.
  // Ne pas prendre « Photo Racha Rais » / « Graphic Naya Hachwa » pour l'auteur
  // (crédits photo The Link, souvent collés en fin de légende).
  const bodyCredit = authorFromBodyCredits(html);
  if (bodyCredit) candidates.push({ author: bodyCredit, trust: 88 });

  // « Prénom Nom – Sports Editor » en tête d'article (The Campus, etc.)
  const openingRole = authorFromOpeningRoleLine(html, l);
  if (openingRole) candidates.push({ author: openingRole, trust: 103 });

  for (const { author } of candidates.sort((a, b) => b.trust - a.trust)) {
    const parts = splitMultiAuthorLabel(author);
    const name = parts.length > 1
      ? joinAuthorNames(parts.map((p) => expandAuthorName(p)).filter(Boolean), l)
      : expandAuthorName(author, l);
    if (!name || isEditorialPlaceholder(name, l)) continue;
    if (sourceKey && normAuthorKey(name) === sourceKey) continue;
    // Compte technique WP = nom du média (ex. « The Campus », « The Concordian »)
    if (sourceKey && (normAuthorKey(name).includes(sourceKey) || sourceKey.includes(normAuthorKey(name)))) {
      if (name.split(/\s+/).length <= 3) continue;
    }
    return name;
  }
  return '';
}

/** Auteur présent sur ≥50 % des articles d'une source = compte flux (ex. Carla Roche / QL). */
function detectFeedDefaultAuthors(items = []) {
  const bySource = new Map();
  for (const item of items) {
    const src = item.source || '';
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(item);
  }

  const defaults = new Map();
  for (const [source, list] of bySource) {
    if (list.length < FEED_DEFAULT_MIN_COUNT) continue;
    const counts = new Map();
    for (const item of list) {
      const lang = item.lang === 'en' ? 'en' : 'fr';
      const a = normalizeAuthor(item.author);
      if (!a || isEditorialPlaceholder(a, lang)) continue;
      const key = normAuthorKey(a);
      counts.set(key, { name: a, count: (counts.get(key)?.count || 0) + 1 });
    }
    for (const { name, count } of counts.values()) {
      if (count >= FEED_DEFAULT_MIN_COUNT && count / list.length >= FEED_DEFAULT_MIN_SHARE) {
        if (!defaults.has(source)) defaults.set(source, new Set());
        defaults.get(source).add(normAuthorKey(name));
      }
    }
  }
  return defaults;
}

function isFeedDefaultAuthor(item, feedDefaults = new Map()) {
  const src = item.source || '';
  const key = normAuthorKey(normalizeAuthor(item.author));
  if (!key || !feedDefaults.has(src)) return false;
  return feedDefaults.get(src).has(key);
}

function findSiblingAuthor(item, allItems = []) {
  const key = normalizeArticleUrl(item.link);
  if (!key) return '';

  const siblings = allItems.filter(
    (other) => other !== item && normalizeArticleUrl(other.link) === key,
  );
  if (!siblings.length) return '';

  const keys = new Set();
  for (const entry of [item, ...siblings]) {
    const a = normalizeAuthor(entry.author);
    if (a) keys.add(normAuthorKey(a));
  }
  if (keys.size !== 1) return '';
  return normalizeAuthor(item.author) || normalizeAuthor(siblings[0].author) || '';
}

/** Chroniques à la première personne — seulement si aucune autre source fiable. */
function extractFirstPersonAuthor(text = '') {
  const plain = stripHtml(text);
  const m = plain.match(/^(?:Salut,?\s+)?moi,?\s+c['']est\s+([\p{Lu}][\p{L}'’.\-]+)/iu)
    || plain.match(/^je\s+m['']appelle\s+([\p{Lu}][\p{L}'’.\-]+)/iu);
  return m ? normalizeAuthor(m[1]) : '';
}

function needsPageAuthorVerification(item, feedDefaults = new Map(), hints = {}) {
  if (!item.link) return false;
  if (hints.forcePageAuthor) return true;
  const lang = item.lang === 'en' ? 'en' : 'fr';
  const ex = String(item.excerpt || '').trim();
  if (excerptOpensWithByline(ex) && extractBylineFromText(ex).author) return false;
  if (isEditorialPlaceholder(item.author, lang)) return true;
  if (isFeedDefaultAuthor(item, feedDefaults)) return true;
  if (!normalizeAuthor(item.author)) return true;
  return false;
}

function applyAuthorFallback(item = {}) {
  const fallback = editorialFallback(item.lang === 'en' ? 'en' : 'fr');
  if (normalizeAuthor(item.author) === fallback) return item;
  return { ...item, author: fallback };
}

function resolveAuthorCandidate(item, allItems, feedDefaults, pageAuthor) {
  const ex = String(item.excerpt || '').trim();
  const fromExcerpt = extractBylineFromText(ex);
  const excerptAuthor = excerptOpensWithByline(ex) && fromExcerpt.author
    ? fromExcerpt.author
    : '';
  const lang = item.lang === 'en' ? 'en' : 'fr';
  let page = normalizeAuthor(pageAuthor);
  // « Auteur » identique au nom du média = compte technique, pas une byline.
  if (page && normAuthorKey(page) === normAuthorKey(item.source || '')) page = '';
  let rss = normalizeAuthor(trimMangledAuthor(item.author));
  if (isEditorialPlaceholder(rss, lang)) rss = '';
  if (rss && normAuthorKey(rss) === normAuthorKey(item.source || '')) rss = '';
  const rssIsDefault = rss && isFeedDefaultAuthor(item, feedDefaults);

  if (rssIsDefault) rss = '';

  const sibling = findSiblingAuthor(item, allItems);
  const firstPerson = !excerptAuthor && !page && !rss ? extractFirstPersonAuthor(ex) : '';

  const sources = [
    excerptAuthor && { author: excerptAuthor, reason: 'excerpt-byline' },
    page && { author: page, reason: 'page-byline' },
    sibling && { author: sibling, reason: 'sibling-agreement' },
    rss && { author: rss, reason: 'rss-field' },
    firstPerson && { author: firstPerson, reason: 'first-person-intro' },
  ].filter(Boolean);

  if (!sources.length) {
    return { author: '', reason: rssIsDefault ? 'rss-feed-default-rejected' : 'no-author-source', excerptBody: fromExcerpt.body };
  }

  const primary = sources[0];
  const conflicting = sources.slice(1).filter((s) => !authorsAgree(primary.author, s.author));

  if (conflicting.length) {
    if (excerptAuthor && page && !authorsAgree(excerptAuthor, page)) {
      return { author: '', reason: 'author-conflict-excerpt-page', excerptBody: fromExcerpt.body };
    }
    if (page && rss && !authorsAgree(page, rss)) {
      return { author: page, reason: 'page-byline-overrides-rss', excerptBody: fromExcerpt.body };
    }
    if (excerptAuthor) {
      return {
        author: excerptAuthor,
        reason: 'excerpt-byline-wins-conflict',
        excerptBody: fromExcerpt.body.length >= 20 ? fromExcerpt.body : '',
      };
    }
    if (page) {
      return { author: page, reason: 'page-byline-wins-conflict', excerptBody: fromExcerpt.body };
    }
    return { author: '', reason: 'author-conflict', excerptBody: fromExcerpt.body };
  }

  return {
    author: primary.author,
    reason: primary.reason,
    excerptBody: excerptAuthor && fromExcerpt.body.length >= 20 ? fromExcerpt.body : '',
  };
}

function reconcileAuthor(item, allItems = [], {
  applyFallback = false,
  feedDefaults = null,
  pageAuthor = '',
} = {}) {
  const defaults = feedDefaults || detectFeedDefaultAuthors(allItems);
  const previousAuthor = normalizeAuthor(item.author) || null;
  const resolved = resolveAuthorCandidate(item, allItems, defaults, pageAuthor);

  let next = { ...item };
  let changed = false;

  if (resolved.author && normalizeAuthor(next.author) !== resolved.author) {
    next.author = resolved.author;
    changed = true;
  } else if (!resolved.author && normalizeAuthor(next.author)) {
    next.author = '';
    changed = true;
  }

  if (resolved.excerptBody && resolved.excerptBody !== exString(next)) {
    next.excerpt = resolved.excerptBody;
    changed = true;
  }

  if (applyFallback && !normalizeAuthor(next.author)) {
    next = applyAuthorFallback(next);
    changed = true;
    resolved.reason = resolved.reason || 'fallback-editorial';
  }

  const author = normalizeAuthor(next.author) || null;
  if (changed || (applyFallback && author !== previousAuthor)) {
    return {
      changed: true,
      item: next,
      author,
      previousAuthor,
      reason: resolved.reason,
    };
  }
  return { changed: false, item: next, author, previousAuthor, reason: null };
}

function exString(item) {
  return String(item.excerpt || '').trim();
}

function resolveAuthor(item = {}, allItems = [], options = {}) {
  const { item: reconciled } = reconcileAuthor(item, allItems, { ...options, applyFallback: true });
  return normalizeAuthor(reconciled.author) || editorialFallback(reconciled.lang === 'en' ? 'en' : 'fr');
}

function auditAuthors(items = [], { feedDefaults = null, pageAuthors = new Map() } = {}) {
  const defaults = feedDefaults || detectFeedDefaultAuthors(items);
  const mismatches = [];
  let fixable = 0;

  for (const item of items) {
    const pageAuthor = pageAuthors.get(normalizeArticleUrl(item.link)) || '';
    const result = reconcileAuthor(item, items, {
      applyFallback: true,
      feedDefaults: defaults,
      pageAuthor,
    });
    if (result.changed) {
      fixable += 1;
      mismatches.push({
        title: item.title,
        link: item.link,
        source: item.source,
        fieldAuthor: result.previousAuthor,
        canonicalAuthor: result.author,
        reason: result.reason,
      });
    }
  }

  return { mismatches, fixable, total: items.length, feedDefaults: defaults };
}

module.exports = {
  GENERIC_AUTHORS,
  editorialFallback,
  canonicalizeEditorialAuthor,
  isEditorialPlaceholder,
  joinAuthorNames,
  expandAuthorName,
  normalizeAuthor,
  trimMangledAuthor,
  extractBylineFromText,
  extractFirstPersonAuthor,
  excerptOpensWithByline,
  authorFromBodyCredits,
  authorFromArticleHtml,
  authorsFromStrongRoleByline,
  authorsFromTribuneAuthor,
  authorsFromHintSelectors,
  focusHtmlForAuthorExtraction,
  detectFeedDefaultAuthors,
  isFeedDefaultAuthor,
  needsPageAuthorVerification,
  resolveAuthor,
  applyAuthorFallback,
  reconcileAuthor,
  auditAuthors,
  normalizeArticleUrl,
};