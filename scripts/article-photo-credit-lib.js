/**
 * Crédits photo depuis la page source de l'article —
 * cite le photographe si présent sur la page, sinon « Crédit photo : [média] ».
 */

const { fetchText, articleBodyHtml, decodeEntities } = require('./article-image-lib');
const { normalizeArticleUrl } = require('./author-lib');

const PHOTO_CREDIT_FIELDS = [
  'sourceImageCredit',
  'sourceImageCreator',
  'sourceImageCreditUrl',
  'sourceImageCreditFrom',
  'sourceImageCreditCited',
  'sourceImageCreditImageKey',
  'sourceImageCreditRev',
];

// Version des extracteurs de crédit : l'incrémenter force une re-vérification
// unique des articles restés au repli « Crédit photo : [média] », pour que les
// nouveaux extracteurs puissent retrouver le photographe rétroactivement.
const CREDIT_EXTRACTOR_REV = 2;

const LEAD_IMAGE_FIELDS = [
  'leadImageReady',
  'stockImage',
  'imageTitle',
  'imageCredit',
  'imageCreator',
  'imageLicense',
  'imageProvider',
  'imageSourceUrl',
];

const CREDIT_LINE_RE = /^(?:Photo|Crédit(?:\s+photo)?|Credit(?:\s+photo)?)\s*[:]\s*(.+)$/i;
const PHOTO_BY_RE = /(?:\(|^)\s*Photo\s+by\s+([^).]+?)(?:\s+via\s+([^).]+))?\s*\)?\.?$/i;
const MENTION_PHOTO_RE = /(?:Mention\s+)?(?:Photo|Crédit|Credit)\s*:\s*([^\n<.]+)/i;

function stripHtml(text = '') {
  return decodeEntities(String(text))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Retire les fuites d'attributs HTML (ex. `)" width="1661" height="527"`). */
function sanitizeCreditText(text = '') {
  let s = stripHtml(text);
  const attrIdx = s.search(/\s*(?:["'])\s*(?:width|height|srcset|class|style|loading|decoding|sizes|alt)\s*=/i);
  if (attrIdx > 0) s = s.slice(0, attrIdx);
  const bareAttr = s.search(/\s+(?:width|height|srcset)\s*=\s*["']/i);
  if (bareAttr > 0) s = s.slice(0, bareAttr);
  s = s.replace(/\\+"/g, '"').replace(/\)\s*["']\s*$/g, ')').replace(/["']\s*$/g, '').trim();
  return s.replace(/\s+/g, ' ').trim();
}

function imageUrlKey(url = '') {
  try {
    // Base factice : accepte aussi les src relatifs (« /images/made/… »).
    const path = decodeURIComponent(new URL(url, 'https://relative.invalid').pathname).toLowerCase();
    return path
      .split('/')
      .pop()
      .replace(/-\d+x\d+(?=\.[a-z]+$)/, '')
      .replace(/-scaled(?=\.[a-z]+$)/, '')
      // Suffixe de redimensionnement CE Image / ExpressionEngine (The Link) :
      // photo_900_674_90.jpeg et photo_600_375_90_s_c1.jpeg → même clé.
      .replace(/_\d{2,4}_\d{2,4}_\d{1,3}(?:_s_c\d+)?(?=\.[a-z]+$)/, '');
  } catch {
    return '';
  }
}

function urlsMatch(a = '', b = '') {
  const ka = imageUrlKey(a);
  const kb = imageUrlKey(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

function parseJsonLdBlocks(html = '') {
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const out = [];
  for (const block of blocks) {
    const raw = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return out;
}

function flattenJsonLd(nodes = [], acc = []) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    acc.push(node);
    if (node['@graph']) flattenJsonLd(node['@graph'], acc);
    if (node.image) {
      const imgs = Array.isArray(node.image) ? node.image : [node.image];
      for (const img of imgs) {
        if (typeof img === 'object') acc.push(img);
      }
    }
  }
  return acc;
}

function extractCreditSnippet(text = '') {
  const t = sanitizeCreditText(text);
  const parenColon = t.match(/\((?:Photo|Crédit|Credit)\s*:\s*([^)]+)\)/i);
  if (parenColon) return sanitizeCreditText(parenColon[1]);
  const paren = t.match(/\((?:Photo|Crédit|Credit)\s+(?:by|par)\s+([^)]+)\)/i);
  if (paren) return sanitizeCreditText(paren[1]);
  const inline = t.match(/(?:Photo|Crédit|Credit)\s+(?:by|par)\s+([^).]+(?:\s+via\s+[^).]+)?)/i);
  if (inline) return sanitizeCreditText(inline[1]);
  if (CREDIT_LINE_RE.test(t)) return sanitizeCreditText(t.replace(CREDIT_LINE_RE, '$1'));
  return t;
}

function extractEmbeddedPhotoCredit(text = '') {
  const t = stripHtml(text);
  const patterns = [
    /\((?:Photo|Crédit|Credit)\s*:\s*([^)]+)\)/gi,
    /\((?:Photo|Crédit|Credit)\s+(?:by|par)\s+([^)]+)\)/gi,
    /\((?:Photo|Crédit|Credit)\s*:\s*([^)"']+)$/gi,
    /(?:Mention\s+)?(?:Photo|Crédit|Credit)\s*:\s*([^\n<.]+)/gi,
  ];
  let last = '';
  for (const re of patterns) {
    for (const m of t.matchAll(re)) last = m[1];
  }
  return sanitizeCreditText(last);
}

function parseMediaCreditPipe(text = '') {
  const t = stripHtml(text).replace(/\s+/g, ' ').trim();
  const creator = t.split('|')[0].trim();
  if (!creator || creator.length < 2 || creator.length > 80) return '';
  if (/^(?:le|la|the)\s+/i.test(creator) && creator.split(/\s+/).length <= 3) return '';
  return sanitizeCreditText(creator);
}

/** Plugin WordPress Media Credit (The McGill Daily, Le Délit, etc.). */
function extractMediaCreditPlugin(html = '', imageUrl = '') {
  if (imageUrl) {
    const key = imageUrlKey(imageUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (key.length > 8) {
      const near = html.match(
        new RegExp(`${key}[\\s\\S]{0,1200}?class=["'][^"']*media-credit[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`, 'i'),
      );
      if (near) {
        const creator = parseMediaCreditPipe(near[1]);
        if (creator) {
          const parsed = creditFromPhrase(creator);
          if (parsed) return { ...parsed, source: 'media-credit-near' };
        }
      }
    }
  }

  const entryIdx = html.search(/class=["'][^"']*\bentry-content\b/i);
  const header = entryIdx > 0 ? html.slice(0, entryIdx) : html.slice(0, 80000);

  const featured = header.match(/class=["']media_credit_featured["'][^>]*>([\s\S]*?)<\/div>/i);
  if (featured) {
    const creator = parseMediaCreditPipe(featured[1]);
    if (creator) {
      const parsed = creditFromPhrase(creator);
      if (parsed) return { ...parsed, source: 'media-credit-featured' };
    }
  }

  const spans = header.match(/<span[^>]*class=["'][^"']*media-credit[^"']*["'][^>]*>[\s\S]*?<\/span>/gi) || [];
  for (const span of spans) {
    if (/max-width:\s*2\d{2}px/i.test(span)) continue;
    const inner = span.replace(/<span[^>]*>|<\/span>/gi, '');
    const creator = parseMediaCreditPipe(inner);
    if (creator) {
      const parsed = creditFromPhrase(creator);
      if (parsed) return { ...parsed, source: 'media-credit' };
    }
  }

  return null;
}

function normalizeCreditPhrase(text = '') {
  const embedded = extractEmbeddedPhotoCredit(text);
  let s = embedded || sanitizeCreditText(extractCreditSnippet(text));
  s = s.replace(/^["'«]|["'»]$/g, '').trim();
  s = s.replace(PHOTO_BY_RE, (_, who, via) => (via ? `${who.trim()} via ${via.trim()}` : who.trim()));
  s = s.replace(/^[(\[]+|[)\]]+$/g, '').trim();
  return sanitizeCreditText(s);
}

function looksLikePhotoCredit(text = '') {
  const t = stripHtml(text);
  if (!t || t.length < 4) return false;
  if (extractEmbeddedPhotoCredit(t)) return true;
  if (MENTION_PHOTO_RE.test(t)) return true;
  if (CREDIT_LINE_RE.test(t)) return true;
  if (/\((?:Photo|Crédit|Credit)\s*:\s*[^)]+\)/i.test(t)) return true;
  if (/\((?:Photo|Crédit|Credit)\s+(?:by|par)\s+[^)]+\)/i.test(t)) return true;
  if (/(?:Photo|Crédit|Credit)\s+(?:by|par)\s+/i.test(t)) return true;
  if (PHOTO_BY_RE.test(t)) return true;
  const snippet = extractCreditSnippet(t);
  if (snippet !== t && snippet.length >= 4 && snippet.length <= 120) return true;
  if (/\b(?:Getty|Shutterstock|AFP|Reuters|AP Photo|Canadian Press|La Presse canadienne)\b/i.test(t) && t.length < 160) {
    return true;
  }
  return false;
}

function creditFromPhrase(text = '') {
  const phrase = normalizeCreditPhrase(text);
  if (!phrase || phrase.length < 3) return null;
  const via = phrase.match(/^(.+?)\s+via\s+(.+)$/i);
  const creator = via ? via[1].trim() : phrase;
  const agency = via ? via[2].trim() : '';
  const label = agency ? `${creator} via ${agency}` : creator;
  return {
    creditLine: `Photo : ${label}`,
    creator,
    agency,
  };
}

/** Légendes WordPress « Nom / Média » ou « Illustration by … » (The Tribune, etc.). */
function parseFigcaptionAttribution(text = '', lang = 'fr') {
  const t = sanitizeCreditText(text);
  if (!t || t.length < 4) return null;
  if (t.length > 120) {
    // Légende descriptive longue : seule la signature en fin de texte compte.
    return t.length <= 300 ? parseTrailingCaptionCredit(t, lang) : null;
  }

  const slash = t.match(/^([\p{L}][\p{L}\s'.-]{1,48})\s*\/\s*([\p{L}][\p{L}\s'.&-]{1,48})$/u);
  if (slash) {
    const creator = slash[1].trim();
    const parsed = creditFromPhrase(creator);
    if (parsed) return { ...parsed, source: 'figcaption-attribution' };
  }

  // « Mention photo : X » / « Mention illustration : X » (Montréal Campus).
  const mention = t.match(/^Mention\s+(photo|illustration|graphique?)\s*:\s*(.+)$/iu);
  if (mention) {
    const parsed = creditFromPhrase(mention[2]);
    if (parsed) {
      const en = lang === 'en';
      const isIllustration = /^(illustration|graphique?)$/i.test(mention[1]);
      const label = isIllustration
        ? (en ? 'Illustration: ' : 'Illustration : ')
        : (en ? 'Photo: ' : 'Photo : ');
      return { ...parsed, creditLine: `${label}${parsed.creator}`, source: 'figcaption-mention' };
    }
  }

  // Légende-signature nue en casse de titre (The Tribune) :
  // « McGill Visual Arts Collection » — 2 à 5 mots capitalisés, sans ponctuation
  // finale : c'est une attribution, pas une phrase descriptive.
  if (t.length <= 60 && !/[.!?…:;,]$/.test(t)) {
    const words = t.split(/\s+/);
    const connective = /^(?:of|the|and|de|du|des|la|le|les|et|d'|l'|&)$/i;
    const capitalized = words.every((w) => connective.test(w) || /^[\p{Lu}]/u.test(w));
    if (words.length >= 2 && words.length <= 5 && capitalized) {
      const parsed = creditFromPhrase(t);
      if (parsed) return { ...parsed, source: 'figcaption-bare' };
    }
  }

  const illustrated = t.match(/^(?:Illustration|Artwork|Art|Drawing|Cartoon|Graphic|Design)\s+by\s+(.+)$/i);
  if (illustrated) {
    const parsed = creditFromPhrase(illustrated[1]);
    if (parsed) {
      const en = lang === 'en';
      return {
        ...parsed,
        creditLine: en ? `Illustration: ${parsed.creator}` : `Illustration : ${parsed.creator}`,
        source: 'figcaption-illustration',
      };
    }
  }

  return parseTrailingCaptionCredit(t, lang);
}

/**
 * Crédit en fin de légende sans deux-points ni « by » (The Link) :
 * « The CSU did not reach quorum. Graphic Naya Hachwa » / « … Photo Zachary Fortier »
 * / « … Courtesy Naya Hachwa ».
 */
function parseTrailingCaptionCredit(t = '', lang = 'fr') {
  const trailing = t.match(
    /(?:^|[.!?…»]\s+)(Photos?|Graphics?|Illustrations?|File photo|Courtesy(?:\s+of)?)\s+([\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}&][\p{L}'’.&-]*){1,4})\s*$/u,
  );
  if (!trailing) return null;
  const kind = trailing[1].toLowerCase();
  const parsed = creditFromPhrase(trailing[2]);
  if (!parsed) return null;
  const en = lang === 'en';
  let creditLine = en ? `Photo: ${parsed.creator}` : `Photo : ${parsed.creator}`;
  if (kind.startsWith('graphic') || kind.startsWith('illustration')) {
    creditLine = en ? `Illustration: ${parsed.creator}` : `Illustration : ${parsed.creator}`;
  } else if (kind.startsWith('courtesy')) {
    creditLine = en
      ? `Photo: Courtesy of ${parsed.creator}`
      : `Photo : avec l'aimable autorisation de ${parsed.creator}`;
  }
  return { ...parsed, creditLine, source: 'figcaption-trailing' };
}

function extractJsonLdCredit(html = '', imageUrl = '') {
  const flat = flattenJsonLd(parseJsonLdBlocks(html));
  for (const node of flat) {
    const type = String(node['@type'] || '').toLowerCase();
    if (!type.includes('imageobject')) continue;
    const nodeUrl = node.url || node.contentUrl || '';
    if (imageUrl && nodeUrl && !urlsMatch(nodeUrl, imageUrl)) continue;
    const fields = [node.caption, node.name, node.description, node.creditText];
    for (const field of fields) {
      if (!field) continue;
      const snippet = extractCreditSnippet(field);
      if (!looksLikePhotoCredit(snippet) && !looksLikePhotoCredit(field)) continue;
      const parsed = creditFromPhrase(snippet.length >= 4 ? snippet : field);
      if (parsed) return { ...parsed, source: 'json-ld' };
    }
  }
  return null;
}

function extractFigureCredit(html = '', imageUrl = '', lang = 'fr') {
  const figures = html.match(/<figure[^>]*>[\s\S]*?<\/figure>/gi) || [];
  for (const fig of figures) {
    const srcM = fig.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (!srcM || (imageUrl && !urlsMatch(srcM[1], imageUrl))) continue;
    const capM = fig.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
    if (capM) {
      const attr = parseFigcaptionAttribution(capM[1], lang);
      if (attr) return attr;
      const embedded = extractEmbeddedPhotoCredit(capM[1]);
      if (embedded) {
        const parsed = creditFromPhrase(embedded);
        if (parsed) return { ...parsed, source: 'figcaption' };
      }
      if (looksLikePhotoCredit(capM[1])) {
        const parsed = creditFromPhrase(capM[1]);
        if (parsed) return { ...parsed, source: 'figcaption' };
      }
    }
  }

  const captions = html.match(/<(?:p|span)[^>]*class=["'][^"']*wp-caption-text[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|span)>/gi) || [];
  for (const cap of captions) {
    const inner = cap.replace(/<(?:p|span)[^>]*>/i, '').replace(/<\/(?:p|span)>$/i, '');
    const block = cap.match(/<img[^>]+src=["']([^"']+)["']/i)
      ? cap
      : html.slice(Math.max(0, html.indexOf(cap) - 400), html.indexOf(cap) + cap.length);
    const srcM = block.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (srcM && imageUrl && !urlsMatch(srcM[1], imageUrl)) continue;
    if (looksLikePhotoCredit(inner)) {
      const parsed = creditFromPhrase(inner);
      if (parsed) return { ...parsed, source: 'wp-caption' };
    }
  }

  return null;
}

function extractBodyCredit(html = '', imageUrl = '') {
  const body = articleBodyHtml(html);
  const paragraphs = body.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  for (const p of paragraphs.slice(0, 12)) {
    const text = stripHtml(p);
    if (!looksLikePhotoCredit(text)) continue;
    if (text.length > 160) continue;
    const parsed = creditFromPhrase(text);
    if (parsed) return { ...parsed, source: 'body-line' };
  }

  // Ligne de crédit en fin d'article (Le Collectif) :
  // « Source : Festival international de jazz de Montréal ».
  for (const p of paragraphs.slice(-6)) {
    const text = stripHtml(p);
    if (text.length < 8 || text.length > 110) continue;
    const m = text.match(/^(?:Source|Crédit(?:\s+photo)?|Photo|Credit)\s*:\s*(.+)$/i);
    if (!m) continue;
    const parsed = creditFromPhrase(m[1]);
    if (parsed) return { ...parsed, source: 'body-tail' };
  }

  if (imageUrl) {
    const key = imageUrlKey(imageUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (key.length > 8) {
      const near = html.match(
        new RegExp(`${key}[\\s\\S]{0,500}?((?:Photo|Crédit|Credit)\\s*:\\s*[^"<)\\n]{2,80})`, 'i'),
      );
      if (near && looksLikePhotoCredit(near[1])) {
        const parsed = creditFromPhrase(near[1]);
        if (parsed) return { ...parsed, source: 'near-image' };
      }
    }
  }

  return null;
}

function titleCaseName(raw = '') {
  return String(raw)
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .trim();
}

/**
 * Photographe encodé dans le nom de fichier ou les attributs WordPress :
 *   - The Campus : sports_1_athletic-awards_credits_browyn-chenard.webp
 *     et data-image-title="…_Credits_Browyn Chenard"
 *   - The Link : 00.graphics.CSU.Naya_Hachwa_900_674_90.jpeg (segment
 *     Prénom_Nom en fin de fichier, limité aux URLs CE Image /images/made/).
 */
function extractFilenameCredit(html = '', imageUrl = '', lang = 'fr') {
  const en = lang === 'en';
  const makeCredit = (name, source) => {
    const parsed = creditFromPhrase(name);
    if (!parsed) return null;
    return {
      ...parsed,
      creditLine: en ? `Photo: ${parsed.creator}` : `Photo : ${parsed.creator}`,
      source,
    };
  };

  const fileM = String(imageUrl).match(/_cr[ée]dits?[_-]([a-z0-9-]{5,60})\.(?:jpe?g|png|webp|gif|avif)(?:$|\?)/i);
  if (fileM) {
    const name = titleCaseName(fileM[1].replace(/[-_]+/g, ' '));
    if (/\s/.test(name)) {
      const credit = makeCredit(name, 'filename-credit');
      if (credit) return credit;
    }
  }

  if (html) {
    const attrM = html.match(/data-image-title=["'][^"']*cr[ée]dits?[_\s:-]+([^"'_]{4,60})["']/i);
    if (attrM) {
      const name = attrM[1].replace(/[-_]+/g, ' ').trim();
      if (/^\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,3}$/u.test(name)) {
        const credit = makeCredit(name, 'image-title-credit');
        if (credit) return credit;
      }
    }
  }

  if (/\/images\/made\/|_resized\//i.test(String(imageUrl))) {
    const linkM = String(imageUrl).match(
      /([A-Z][a-zà-öø-ÿ'’-]+_[A-Z][a-zà-öø-ÿ'’-]+)(?:_\d{2,4}_\d{2,4}_\d{1,3}(?:_s_c\d+)?)?\.(?:jpe?g|png|webp)(?:$|\?)/,
    );
    if (linkM) {
      const credit = makeCredit(linkM[1].replace(/_/g, ' '), 'filename-byline');
      if (credit) return credit;
    }
  }

  return null;
}

function extractPhotoCreditFromHtml(html = '', imageUrl = '', lang = 'fr') {
  if (!html && imageUrl) return extractFilenameCredit(html, imageUrl, lang);
  if (!html || html.length < 200) return null;

  const extractors = imageUrl
    ? [
      () => extractFigureCredit(html, imageUrl, lang),
      () => extractMediaCreditPlugin(html, imageUrl),
      () => extractJsonLdCredit(html, imageUrl),
      () => extractBodyCredit(html, imageUrl),
      () => extractFilenameCredit(html, imageUrl, lang),
    ]
    : [
      () => extractMediaCreditPlugin(html, imageUrl),
      () => extractJsonLdCredit(html, imageUrl),
      () => extractFigureCredit(html, imageUrl, lang),
      () => extractBodyCredit(html, imageUrl),
    ];

  for (const fn of extractors) {
    const hit = fn();
    if (hit?.creditLine) return hit;
  }
  return null;
}

function formatMediaFallbackCredit(item = {}) {
  const media = String(item.source || '').trim() || 'Le Radar';
  const en = item.lang === 'en';
  return {
    cited: false,
    creditLine: en ? `Photo credit: ${media}` : `Crédit photo : ${media}`,
    creator: '',
    creditUrl: String(item.link || '').trim(),
    from: 'media',
  };
}

function resolveSourcePhotoCredit(item = {}, html = '') {
  const imageUrl = String(item.image || '').trim();
  if (!imageUrl) return null;

  const cited = extractPhotoCreditFromHtml(html, imageUrl, item.lang === 'en' ? 'en' : 'fr');
  if (cited) {
    return {
      cited: true,
      creditLine: cited.creditLine,
      creator: cited.creator || '',
      creditUrl: String(item.link || '').trim(),
      from: 'article',
      method: cited.source,
    };
  }

  return formatMediaFallbackCredit(item);
}

async function fetchSourcePhotoCredit(item) {
  if (!item?.link || !item?.image) return null;
  const html = await fetchText(item.link);
  return resolveSourcePhotoCredit(item, html);
}

function applySourcePhotoCredit(item, resolved, { doUpdate = false } = {}) {
  if (!resolved) return { changed: false };
  const prev = {
    line: item.sourceImageCredit || '',
    creator: item.sourceImageCreator || '',
    from: item.sourceImageCreditFrom || '',
  };
  const next = {
    line: resolved.creditLine,
    creator: resolved.creator || '',
    from: resolved.from,
  };
  const imageKey = imageUrlKey(item.image);
  const storedKey = item.sourceImageCreditImageKey || '';
  const keyChanged = imageKey && storedKey !== imageKey;
  const revChanged = (item.sourceImageCreditRev || 0) !== CREDIT_EXTRACTOR_REV;
  const changed = prev.line !== next.line
    || prev.creator !== next.creator
    || prev.from !== next.from
    || keyChanged
    || revChanged;

  if (doUpdate && changed) {
    item.sourceImageCredit = next.line;
    item.sourceImageCreator = next.creator;
    item.sourceImageCreditUrl = resolved.creditUrl || item.link || '';
    item.sourceImageCreditFrom = next.from;
    item.sourceImageCreditCited = !!resolved.cited;
    item.sourceImageCreditImageKey = imageKey;
    // Marque la version des extracteurs pour ne re-vérifier les replis média
    // qu'une seule fois par amélioration du code.
    item.sourceImageCreditRev = CREDIT_EXTRACTOR_REV;
  }

  return { changed, cited: resolved.cited, method: resolved.method || null };
}

function creditLooksCorrupt(text = '') {
  return /\b(?:width|height|srcset)\s*=/i.test(text) || /\\?"\s*width/i.test(text);
}

function needsSourceCreditCheck(item) {
  if (!item?.link || !item?.image) return false;
  const key = imageUrlKey(item.image);
  if (!key) return false;
  // Repli média jamais re-passé dans les extracteurs actuels : re-vérifier une
  // fois — les crédits cités, eux, restent acquis.
  if (!item.sourceImageCreditCited
    && (item.sourceImageCreditRev || 0) < CREDIT_EXTRACTOR_REV) {
    return true;
  }
  if (item.sourceImageCredit && !creditLooksCorrupt(item.sourceImageCredit)
    && !creditLooksCorrupt(item.sourceImageCreator)) {
    const storedKey = item.sourceImageCreditImageKey || key;
    if (storedKey === key) return false;
  }
  return true;
}

/** Priorise vedette + articles récents sans crédit (rotation dynamique à la une). */
function buildPhotoCreditQueue(items = [], { heroPool = 45 } = {}) {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.image && String(item.image).trim() && needsSourceCreditCheck(item))
    .sort((a, b) => {
      const aMiss = a.item.sourceImageCredit ? 1 : 0;
      const bMiss = b.item.sourceImageCredit ? 1 : 0;
      if (aMiss !== bMiss) return aMiss - bMiss;
      const aHero = a.index < heroPool || a.item.featured ? 0 : 1;
      const bHero = b.index < heroPool || b.item.featured ? 0 : 1;
      if (aHero !== bHero) return aHero - bHero;
      return (Date.parse(b.item.date) || 0) - (Date.parse(a.item.date) || 0);
    })
    .map(({ item }) => item);
}

function mergePriorEnrichment(item = {}, prior = null) {
  if (!prior) return item;
  if (normalizeArticleUrl(item.link) !== normalizeArticleUrl(prior.link)) return item;

  const imageKey = imageUrlKey(item.image);
  const priorImageKey = imageUrlKey(prior.image);
  if (imageKey && priorImageKey && imageKey === priorImageKey) {
    for (const field of [...PHOTO_CREDIT_FIELDS, ...LEAD_IMAGE_FIELDS]) {
      if (prior[field] !== undefined && prior[field] !== '') {
        item[field] = prior[field];
      }
    }
  }

  if (prior.leadExcerpt) item.leadExcerpt = prior.leadExcerpt;
  return item;
}

function auditPhotoCredits(items = []) {
  const withImage = items.filter((i) => i.image && String(i.image).trim());
  const withCredit = withImage.filter((i) => i.sourceImageCredit && String(i.sourceImageCredit).trim());
  const cited = withCredit.filter((i) => i.sourceImageCreditCited);
  const pending = buildPhotoCreditQueue(items);
  const missingHero = items
    .slice(0, 45)
    .filter((i) => i.image && !i.sourceImageCredit)
    .length;

  return {
    total: items.length,
    withImage: withImage.length,
    withCredit: withCredit.length,
    cited: cited.length,
    pending: pending.length,
    missingHero,
    ok: missingHero === 0 && pending.length === 0,
  };
}

module.exports = {
  CREDIT_EXTRACTOR_REV,
  extractFilenameCredit,
  parseTrailingCaptionCredit,
  imageUrlKey,
  urlsMatch,
  sanitizeCreditText,
  creditLooksCorrupt,
  looksLikePhotoCredit,
  extractMediaCreditPlugin,
  parseFigcaptionAttribution,
  extractPhotoCreditFromHtml,
  resolveSourcePhotoCredit,
  fetchSourcePhotoCredit,
  applySourcePhotoCredit,
  needsSourceCreditCheck,
  buildPhotoCreditQueue,
  mergePriorEnrichment,
  auditPhotoCredits,
  formatMediaFallbackCredit,
  PHOTO_CREDIT_FIELDS,
  LEAD_IMAGE_FIELDS,
};