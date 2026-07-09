/**
 * Extraction et réconciliation des auteurs — partagé par fetch-news et verify-authors.
 *
 * Priorité : byline visible sur la page > extrait « Par … » > RSS (si fiable).
 * En cas de conflit ou de doute (auteur flux par défaut, doublons divergents) :
 * « La rédaction » / « The editorial team ».
 */

const GENERIC_AUTHORS = /^(admin|administrator|administrateur|editor|éditeur|editeur|rédaction|redaction|staff|wordpress|webmaster|collectif|tribune|link|daily|coordinating|exemplaire|quartier libre|zone campus|la pige|le délit|le delit|the link|the tribune|the mcgill daily|the campus)$/i;

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

const CONTRIBUTOR_DASH = '(?:[–—\\-]|&#8211;|&ndash;)';
const CONTRIBUTOR_BYLINE_RE = new RegExp(
  `^([\\p{Lu}][\\p{L}'’.\\-]+(?:\\s+[\\p{Lu}][\\p{L}'’.\\-]+){0,3})\\s*${CONTRIBUTOR_DASH}\\s*(?:Contributor|Staff Writer)\\b`,
  'iu',
);
const CONTRIBUTOR_HTML_RE = new RegExp(
  `<strong>\\s*([\\p{Lu}][\\p{L}'’.\\-]+(?:\\s+[\\p{Lu}][\\p{L}'’.\\-]+){0,3})\\s*${CONTRIBUTOR_DASH}\\s*(?:Contributor|Staff Writer)\\s*<\\/strong>`,
  'iu',
);

function looksLikeMultiAuthorList(name = '') {
  const a = String(name).replace(/\s+/g, ' ').trim();
  if (!/,/.test(a) && !/\s+and\s+/i.test(a) && !/\s+et\s+/i.test(a)) return false;
  const chunks = a.split(/\s*,\s*|\s+and\s+|\s+et\s+/i).map((c) => c.trim()).filter(Boolean);
  if (chunks.length < 2 || chunks.length > 4) return false;
  return chunks.every((chunk) => {
    const words = chunk.split(/\s+/).filter(Boolean);
    return words.length >= 1 && words.length <= 4
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
  for (const m of html.matchAll(
    /class=["'][^"']*wp-block-post-author-name__link[^"']*["'][^>]*>([^<]+)<\/a>/gi,
  )) {
    const n = expandAuthorName(m[1]);
    if (n) names.push(n);
  }
  return [...new Set(names)];
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

function authorsFromSchemaPerson(html = '') {
  const names = [];
  for (const m of html.matchAll(
    /itemprop=["']author["'][\s\S]*?itemprop=["']name["'][^>]*content=["']([^"']+)/gi,
  )) {
    const n = expandAuthorName(m[1]);
    if (n) names.push(n);
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
  const plain = stripHtml(text);
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

  const contributor = plain.match(CONTRIBUTOR_BYLINE_RE);
  if (contributor) {
    const author = normalizeAuthor(contributor[1]);
    const body = plain.slice(contributor[0].length).trim();
    if (author && body.length >= 8) return { author, body };
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

  const candidates = [];
  const l = lang === 'en' ? 'en' : 'fr';

  const hintAuthors = authorsFromHintSelectors(html, hints);
  if (hintAuthors.length) {
    candidates.push({ author: joinAuthorNames(hintAuthors, l), trust: 106 });
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

  const relAuthors = authorsFromRelLinks(html);
  if (relAuthors.length > 1) {
    candidates.push({ author: joinAuthorNames(relAuthors, l), trust: 98 });
  } else if (relAuthors.length === 1 && !bylineAuthors.length) {
    candidates.push({ author: relAuthors[0], trust: 95 });
  }

  const metaAuthor = metaContent(html, 'author');
  if (metaAuthor && metaAuthor.includes(',')) {
    const parts = metaAuthor.split(/,\s*/).map((part) => normalizeAuthor(part)).filter(Boolean);
    if (parts.length) {
      candidates.push({ author: joinAuthorNames(parts, l), trust: 92 });
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

  const sourceKey = normAuthorKey(String(sourceName || ''));
  for (const { author } of candidates.sort((a, b) => b.trust - a.trust)) {
    const parts = splitMultiAuthorLabel(author);
    const name = parts.length > 1
      ? joinAuthorNames(parts.map((p) => expandAuthorName(p)).filter(Boolean), l)
      : expandAuthorName(author, l);
    if (!name || isEditorialPlaceholder(name, l)) continue;
    if (sourceKey && normAuthorKey(name) === sourceKey) continue;
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
  authorFromArticleHtml,
  authorsFromTribuneAuthor,
  authorsFromHintSelectors,
  detectFeedDefaultAuthors,
  isFeedDefaultAuthor,
  needsPageAuthorVerification,
  resolveAuthor,
  applyAuthorFallback,
  reconcileAuthor,
  auditAuthors,
  normalizeArticleUrl,
};