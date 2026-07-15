/**
 * Extraction et validation d'images d'articles — partagé par fetch-news et ensure-lead-images.
 */

const https = require('https');
const http = require('http');

const DEFAULT_TIMEOUT = 12000;

/** Motifs globaux de rejet (logos, placeholders, widgets, carrousels). */
const GLOBAL_IMAGE_REJECT_RE = /(?:logo|avatar|icon|placeholder|default|blank|spacer|profile|author|favicon|gravatar|emoji|smiley|lapige_web|(?:^|\/)article-2\.|campus-logo|campusgraphic|article-tile|size-article-tile|thumbnail|thumb_|recent-posts|wp-block-query|widget|sponsor|banner|social-share|-150x\d+\.|cropped-logo|logoexile|121330814_121456603062023_8783413434532337259_n|(?:^|\/)daily\.png$|editorial[_-]|(?:^|\/)editorial(?:s)?(?:[_./-]|$)|画板|%e7%94%bb%e6%9d%bf|_optimized_optimized_optimized|00\.graphics\.csu\.naya_hachwa)/i;

function imageRejectPatternsFromHints(hints = {}) {
  const extra = hints.rejectPathPatterns;
  return Array.isArray(extra) ? extra.filter(Boolean) : [];
}

function isPathRejected(path = '', extraRejectPatterns = []) {
  const p = String(path).toLowerCase();
  if (GLOBAL_IMAGE_REJECT_RE.test(p)) return true;
  if (/(?:^|\/)(?:1x1|pixel)\b/.test(p)) return true;
  for (const pat of extraRejectPatterns) {
    if (pat && new RegExp(pat, 'i').test(p)) return true;
  }
  return false;
}

const { decodeEntities } = require('./html-entities-lib');

const BOT_USER_AGENT = 'Mozilla/5.0 (compatible; REQ-NewsBot/1.0)';
// Certains journaux (Wordfence, Elementor…) bloquent les UA « bot » : on
// retente une fois avec une signature navigateur avant d'abandonner —
// sans byline ni crédit lisibles, ces articles retombaient au repli générique.
const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_FETCH_BODY = 2_500_000;

function fetchTextWithAgent(url, redirects, timeout, userAgent) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let req;
    try {
      req = https.get(
        url,
        {
          headers: {
            'User-Agent': userAgent,
            Accept: 'application/rss+xml, application/xml, text/xml, text/html, image/*, */*',
          },
          timeout,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            return done(fetchTextWithAgent(next, redirects - 1, timeout, userAgent));
          }
          if (res.statusCode >= 400) {
            res.resume();
            return done('');
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            data += c;
            if (data.length > MAX_FETCH_BODY) {
              try { req.destroy(); } catch { /* ignore */ }
              done(data);
            }
          });
          res.on('end', () => done(data));
          res.on('error', () => done(''));
        },
      );
    } catch {
      return done('');
    }
    req.on('error', () => done(''));
    req.on('timeout', () => {
      try { req.destroy(); } catch { /* ignore */ }
      done('');
    });
    // Deadline wall-clock : une réponse qui goutte ne bloque plus le bot CI.
    setTimeout(() => {
      try { req.destroy(); } catch { /* ignore */ }
      done('');
    }, timeout + 1500);
  });
}

async function fetchText(url, redirects = 3, timeout = DEFAULT_TIMEOUT) {
  const first = await fetchTextWithAgent(url, redirects, timeout, BOT_USER_AGENT);
  // Réponse vide ou page d'interstitiel minuscule : probable blocage d'UA.
  if (first && first.length >= 2048) return first;
  const second = await fetchTextWithAgent(url, redirects, timeout, BROWSER_USER_AGENT);
  return second && second.length > (first || '').length ? second : first;
}

function fetchBinaryPrefix(url, maxBytes = 65536, redirects = 3, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    // Choix du module par protocole ; une redirection (Location) http:// ou une
    // URL malformée ne doit jamais faire planter tout l'enrichissement (le
    // https.get brut lançait « Protocol http: not supported » → run avorté).
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
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; REQ-NewsBot/1.0)',
            Accept: 'image/*,*/*',
          },
          timeout,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            return resolve(fetchBinaryPrefix(next, maxBytes, redirects - 1, timeout));
          }
          if (res.statusCode >= 400) {
            res.resume();
            return resolve(null);
          }
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            if (size >= maxBytes) return;
            chunks.push(chunk);
            size += chunk.length;
            if (size >= maxBytes) res.destroy();
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('close', () => {
            if (chunks.length) resolve(Buffer.concat(chunks));
          });
        },
      );
    } catch {
      return resolve(null);
    }
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function parseJpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return { width: w, height: h };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

function parsePngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseWebpSize(buf) {
  if (!buf || buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fmt = buf.toString('ascii', 12, 16);
  if (fmt === 'VP8 ') {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (fmt === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fmt === 'VP8X' && buf.length >= 30) {
    return {
      width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
      height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
    };
  }
  return null;
}

function parseImageSize(buf) {
  return parseJpegSize(buf) || parsePngSize(buf) || parseWebpSize(buf);
}

async function probeRemoteImageSize(url) {
  if (!url) return null;
  const buf = await fetchBinaryPrefix(url);
  if (!buf) return null;
  return parseImageSize(buf);
}

function metaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${key}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]).trim();
  }
  return '';
}

function stripBoilerplateRegions(html = '') {
  return String(html)
    .replace(/<div[^>]*\bwp-block-query\b[\s\S]*?<\/div>\s*(?=<div|<\/main|<\/body|$)/gi, '')
    .replace(/<ul[^>]*\bwp-block-post-template\b[\s\S]*?<\/ul>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '');
}

function articleBodyHtml(html = '') {
  const patterns = [
    /itemprop=["']articleBody["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*s-post-nav|<aside|<footer)/i,
    /class=["'][^"']*wp-block-post-content[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*(?:id=["']jp-post-flair|\bwp-block-query\b)|<\/div>\s*<\/div>\s*<div[^>]*wp-block-column)/i,
    // Elementor (Quartier Libre) : widget thème « Post Content »
    /class=["'][^"']*elementor-widget-theme-post-content[^"']*["'][\s\S]{0,400}?class=["'][^"']*elementor-widget-container[^"']*["'][^>]*>([\s\S]{80,60000}?)(?=<div[^>]*class=["'][^"']*elementor-element[^"']*elementor-widget(?!-theme-post-content)|<div[^>]*elementor-location-footer|<\/main)/i,
    /class=["'][^"']*elementor-widget-theme-post-content[^"']*["'][\s\S]{0,200}?>([\s\S]{80,60000}?)(?=<div[^>]*class=["'][^"']*elementor-element[^"']*elementor-widget(?!-theme-post-content)|<\/main)/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /class=["'][^"']*post-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /class=["'][^"']*article-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].length > 80) return stripBoilerplateRegions(m[1]);
  }
  return '';
}

/** Zone éditoriale de l’article courant — hors carrousels « Recent Posts » / wp-block-query. */
function articleImageRegions(html = '') {
  const chunks = [];
  const content = articleBodyHtml(html);
  if (content) chunks.push(content);

  const main = html.match(/<main[\s\S]*?<\/main>/i);
  if (main) {
    const beforeQuery = main[0].split(/\bwp-block-query\b/i)[0] || main[0];
    const featured = beforeQuery.match(
      /class=["'][^"']*wp-block-post-featured-image[^"']*["'][\s\S]*?<\/figure>/i,
    );
    if (featured) chunks.push(featured[0]);
  }

  // Elementor — image à la une (souvent hors entry-content)
  const elFeatured = html.match(
    /class=["'][^"']*elementor-widget-theme-post-featured-image[^"']*["'][\s\S]{0,4000}?(?:<\/div>\s*){2,4}/i,
  );
  if (elFeatured) chunks.push(elFeatured[0]);

  // Widgets image Elementor dans la zone principale (avant footer / sidebar)
  const elMain = html.match(
    /class=["'][^"']*elementor-location-single[^"']*["'][\s\S]{0,120000}?(?=<div[^>]*elementor-location-footer|class=["'][^"']*elementor-location-footer)/i,
  );
  if (elMain && elMain[0].length > 200) chunks.push(elMain[0]);

  return chunks.join('\n');
}

function normalizeImagePath(raw = '') {
  try {
    const u = new URL(decodeEntities(raw));
    const file = decodeURIComponent(u.pathname).split('/').pop() || '';
    return file.replace(/-\d+x\d+(?=\.[a-z]+$)/i, '').toLowerCase();
  } catch {
    return '';
  }
}

function imageUrlsMatch(a = '', b = '') {
  const pa = normalizeImagePath(a);
  const pb = normalizeImagePath(b);
  if (!pa || !pb) return false;
  return pa === pb || pa.includes(pb) || pb.includes(pa);
}

function toAbsoluteImageUrl(raw = '', baseUrl = '') {
  const src = decodeEntities(String(raw || '').trim());
  if (!src) return '';
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  if (!baseUrl) return src;
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return src;
  }
}

/** The Link (ExpressionEngine) / WordPress : vignette → pleine résolution. */
function upgradeCmsImageUrl(raw = '') {
  const src = String(raw || '').trim();
  if (!src) return '';
  const out = [];

  const made = src.match(/\/images\/made\/images\/articles\/_resized\/([^/_]+)(?:_\d+_\d+_\d+)?(\.[a-z]{3,4})$/i);
  if (made) {
    try {
      const u = new URL(src);
      out.push(`${u.origin}/images/articles/_resized/${made[1]}${made[2]}`);
    } catch {
      out.push(src.replace(
        /\/images\/made\/images\/articles\/_resized\/[^/]+$/i,
        `/images/articles/_resized/${made[1]}${made[2]}`,
      ));
    }
  }

  const hiRes = src.replace(/_(\d{2,3})_(\d{2,3})_\d+(\.[a-z]{3,4})$/i, '_900_600_90$3');
  if (hiRes !== src) out.push(hiRes);

  // WordPress intermediate size : name-1024x574.jpg → name.jpg
  // Aussi 600x315 (og:image La Pige) : 2–4 chiffres par côté.
  const wpSized = src.replace(/-\d{2,4}x\d{2,4}(\.[a-z]{3,4})(?:$|\?)/i, '$1');
  if (wpSized !== src) out.push(wpSized.split('?')[0]);

  const wp = normalizeWpContentImageUrl(src);
  if (wp && wp !== src) out.push(wp);

  return [...new Set(out)];
}

/**
 * Si l'URL est une taille WP « faible » (ex. Image-16-600x315.jpg), préférer
 * la version pleine (Image-16.jpg) plutôt que de jeter le candidat — sinon
 * og:image + body ne gardent que des crops et le bot bascule sur Openverse.
 */
function promoteImageUrl(raw = '', options = {}) {
  const src = String(raw || '').trim();
  if (!src) return '';
  if (!isWeakImageUrl(src, options)) return src;
  for (const up of upgradeCmsImageUrl(src)) {
    if (up && up !== src && !isWeakImageUrl(up, options)) return up;
  }
  // Garder le seed upgradé même si on ne peut pas juger sans probe
  // (probe se fait plus tard dans resolveLeadReadyPhoto).
  const upgraded = upgradeCmsImageUrl(src)[0];
  return upgraded || '';
}

/** src réel d'une balise <img>, y compris chargement paresseux (Elementor, etc.). */
function imgTagSrc(tag = '') {
  for (const attr of ['data-lazy-src', 'data-src', 'data-orig-file', 'data-large_image', 'src']) {
    const m = tag.match(new RegExp(`${attr}=["']([^"']+)["']`, 'i'));
    if (!m) continue;
    const val = m[1].trim();
    // Placeholder inline des thèmes lazy-load : passer à l'attribut suivant.
    if (/^data:image\//i.test(val)) continue;
    if (val) return val;
  }
  // Repli srcset : prendre la plus large candidate
  const srcset = tag.match(/\bsrcset=["']([^"']+)["']/i);
  if (srcset) {
    let best = '';
    let bestW = 0;
    for (const part of srcset[1].split(',')) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0] || /^data:image\//i.test(bits[0])) continue;
      const w = parseInt((bits[1] || '').replace(/w$/i, ''), 10) || 0;
      if (w >= bestW) {
        bestW = w;
        best = bits[0];
      }
    }
    if (best) return best;
  }
  return '';
}

/** URLs (normalisées) des images placées dans une <figure> avec légende réelle. */
function captionedFigureImageKeys(content = '') {
  const keys = new Set();
  for (const fig of content.match(/<figure[^>]*>[\s\S]*?<\/figure>/gi) || []) {
    const cap = fig.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
    if (!cap) continue;
    const text = cap[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 12) continue;
    for (const img of fig.match(/<img[^>]*>/gi) || []) {
      const key = normalizeImagePath(imgTagSrc(img));
      if (key) keys.add(key);
    }
  }
  return keys;
}

function collectContentImages(content = '', extraRejectPatterns = [], options = {}, baseUrl = '') {
  const urls = [];
  const preferSizeFull = !!options.preferSizeFull;
  const captionedKeys = captionedFigureImageKeys(content);
  for (const m of content.matchAll(/<img[^>]*>/gi)) {
    const tag = m[0];
    const rawSrc = imgTagSrc(tag);
    if (!rawSrc) continue;
    let src = toAbsoluteImageUrl(rawSrc, baseUrl);
    if (!src || !isCandidateImageUrl(src, extraRejectPatterns)) continue;
    // WP -600x315 / -750x375 → version pleine avant rejet « weak »
    const promoted = promoteImageUrl(src, options);
    if (promoted) src = promoted;
    else if (isWeakImageUrl(src, options)) continue;
    const w = parseInt((tag.match(/width=["'](\d+)["']/i) || [])[1], 10) || 0;
    // Ne pas jeter une image dont on a promu l'URL (w HTML peut rester 150)
    if (w > 0 && w < 400 && promoted === rawSrc) continue;
    if (w > 0 && w < 400 && !promoted) continue;
    const isFull = /\bsize-full\b/i.test(tag) || !/-\d{2,4}x\d{2,4}\./i.test(src);
    const isCropThumb = /-\d{2,4}x\d{2,4}\./i.test(src);
    const hasCaption = captionedKeys.has(normalizeImagePath(src))
      || captionedKeys.has(normalizeImagePath(toAbsoluteImageUrl(rawSrc, baseUrl)));
    urls.push({ url: src, tag, w, isFull, isCropThumb, hasCaption });
  }
  if (preferSizeFull) {
    const fullOnly = urls.filter((img) => img.isFull || !img.isCropThumb);
    if (fullOnly.length) return fullOnly;
  }
  return urls;
}

function articleImageIsValidOnPage(html = '', imageUrl = '', extraRejectPatterns = [], options = {}, baseUrl = '') {
  if (!html || !imageUrl) return false;
  const contentImages = collectContentImages(articleImageRegions(html), extraRejectPatterns, options, baseUrl);
  if (!contentImages.length) return false;
  const keys = new Set(leadImageUrlCandidates(imageUrl).map(normalizeImagePath));
  return contentImages.some((img) => keys.has(normalizeImagePath(img.url)) || imageUrlsMatch(img.url, imageUrl));
}

function isCandidateImageUrl(raw = '', extraRejectPatterns = []) {
  const src = String(raw).trim();
  if (!src) return false;
  if (src.startsWith('data:image/') || src.startsWith('./assets/')) return true;
  try {
    const url = new URL(src);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const path = decodeURIComponent(url.pathname).toLowerCase();
    return !isPathRejected(path, extraRejectPatterns);
  } catch {
    return false;
  }
}

function resizeFromImageUrl(raw = '') {
  try {
    const u = new URL(String(raw));
    const resize = u.searchParams.get('resize');
    if (resize) {
      const parts = resize.split(/[,%]/).map((n) => parseInt(n, 10));
      return { width: parts[0] || 0, height: parts[1] || 0 };
    }
    const w = parseInt(u.searchParams.get('w'), 10) || 0;
    const h = parseInt(u.searchParams.get('h'), 10) || 0;
    if (w || h) return { width: w, height: h };
    // Transformations dans le chemin (substackcdn/Cloudinary : « ,w_256,c_limit,… »)
    const pw = u.pathname.match(/[,/]w_(\d+)\b/);
    const ph = u.pathname.match(/[,/]h_(\d+)\b/);
    if (pw || ph) {
      return { width: pw ? parseInt(pw[1], 10) : 0, height: ph ? parseInt(ph[1], 10) : 0 };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** i0.wp.com / photon : retirer resize et pointer vers l’original wp-content. */
function normalizeWpContentImageUrl(raw = '') {
  const src = String(raw).trim();
  if (!src) return '';
  try {
    const u = new URL(src);
    const host = u.hostname.toLowerCase();
    if (/\.wp\.com$/i.test(host)) {
      const m = u.pathname.match(/^\/([^/]+\/wp-content\/uploads\/.+)$/i);
      if (m) return `https://${m[1]}`;
    }
    if (u.searchParams.has('resize') || u.searchParams.has('w') || u.searchParams.has('h')) {
      const clean = new URL(src);
      clean.searchParams.delete('resize');
      clean.searchParams.delete('w');
      clean.searchParams.delete('h');
      return clean.toString();
    }
  } catch {
    return src;
  }
  return src;
}

/**
 * Substack CDN : …/image/fetch/…/https%3A%2F%2Fsubstack-post-media.s3…
 * → URL S3 originale (meilleure qualité, dimensions fiables).
 */
function unwrapCdnImageUrl(raw = '') {
  const src = String(raw || '').trim();
  if (!src) return '';
  try {
    if (/substackcdn\.com\/image\/fetch/i.test(src)) {
      const m = src.match(/\/(https?%3A%2F%2F[^?\s#]+)/i)
        || src.match(/\/(https?:\/\/[^?\s#]+)/i);
      if (m) {
        const inner = m[1].includes('%') ? decodeURIComponent(m[1]) : m[1];
        if (/^https?:\/\//i.test(inner)) return inner;
      }
    }
  } catch {
    /* ignore */
  }
  return src;
}

function isWeakImageUrl(raw = '', options = {}) {
  const path = String(raw).toLowerCase();
  const resize = resizeFromImageUrl(raw);
  if (resize) {
    const { width = 0, height = 0 } = resize;
    if ((width > 0 && width < 640) || (height > 0 && height < 360)) return true;
    if (width > 0 && height > 0 && width * height < FEATURE_MIN_PIXELS) return true;
  }
  if (options.preferSizeFull && /-\d{3}x\d{2,3}\./.test(path) && !/\bsize-full\b/.test(path)) return true;
  // Suffixe WP « name-930x620.jpg » : garder les formats ≥ feature, rejeter -150x150.
  const sized = path.match(/-(\d{2,4})x(\d{2,4})(?=\.[a-z]+(?:$|\?))/);
  if (sized) {
    const w = parseInt(sized[1], 10);
    const h = parseInt(sized[2], 10);
    if (w > 0 && h > 0) {
      if (Math.max(w, h) < 400) return true;
      if (w < 640 || h < 360 || w * h < FEATURE_MIN_PIXELS) return true;
    }
  }
  return /article-tile|size-article-tile/.test(path);
}

/** Seuils vedette : assez grands pour un hero ~800px sans pixelisation visible. */
const LEAD_MIN_WIDTH = 720;
const LEAD_MIN_HEIGHT = 405;
const LEAD_MIN_PIXELS = 320000;
const FEATURE_MIN_WIDTH = 640;
const FEATURE_MIN_HEIGHT = 360;
const FEATURE_MIN_PIXELS = 240000;

function meetsLeadDisplaySize(width = 0, height = 0) {
  const ratio = width / Math.max(height, 1);
  const pixels = width * height;
  return (
    width >= LEAD_MIN_WIDTH
    && height >= LEAD_MIN_HEIGHT
    && pixels >= LEAD_MIN_PIXELS
    && ratio >= 0.95
    && ratio <= 2.6
  );
}

function meetsFeatureDisplaySize(width = 0, height = 0) {
  const ratio = width / Math.max(height, 1);
  const pixels = width * height;
  return (
    width >= FEATURE_MIN_WIDTH
    && height >= FEATURE_MIN_HEIGHT
    && pixels >= FEATURE_MIN_PIXELS
    && ratio >= 0.95
    && ratio <= 2.6
  );
}

function imageFromArticleHtml(html = '', extraRejectPatterns = [], options = {}, baseUrl = '') {
  // Plafond : parsers HTML WP sur pages monstrueuses (hang CPU / CI).
  if (html && html.length > 150_000) html = html.slice(0, 150_000);
  const preferFirstContentImage = !!options.preferFirstContentImage;
  const imageRegion = preferFirstContentImage
    ? (articleBodyHtml(html) || articleImageRegions(html))
    : articleImageRegions(html);
  const contentImages = collectContentImages(imageRegion, extraRejectPatterns, options, baseUrl);

  const candidates = [];
  const pushMeta = (raw, scoreBase, w = 0, h = 0) => {
    if (!raw) return;
    const unwrapped = unwrapCdnImageUrl(raw);
    for (const seed of [unwrapped, raw]) {
      if (!seed || !isCandidateImageUrl(seed, extraRejectPatterns)) continue;
      // og:image souvent en -600x315 (La Pige) : promouvoir en pleine taille
      // avant de rejeter comme weak, sinon → Openverse hors sujet.
      const url = promoteImageUrl(seed, options) || (!isWeakImageUrl(seed, options) ? seed : '');
      if (!url) continue;
      candidates.push({
        url,
        score: scoreBase
          + (url !== seed ? 25 : 0)
          + (url === unwrapped && unwrapped !== raw ? 15 : 0)
          + Math.min(w, 2400) / 10,
        w: url !== seed ? 0 : w,
        h: url !== seed ? 0 : h,
      });
      break;
    }
  };

  // og:image / Twitter : toujours candidats (Substack n'embarque souvent que
  // des miniatures dans le HTML — la couverture est uniquement en meta).
  if (!preferFirstContentImage) {
    const ogImage = metaContent(html, 'og:image');
    const ogW = parseInt(metaContent(html, 'og:image:width'), 10) || 0;
    const ogH = parseInt(metaContent(html, 'og:image:height'), 10) || 0;
    const ogInContent = ogImage && contentImages.some((img) => imageUrlsMatch(img.url, ogImage));
    // Bonus fort si aussi dans le corps ; sinon on accepte quand même (Substack).
    pushMeta(ogImage, ogInContent ? 110 : 95, ogW, ogH);

    for (const key of ['twitter:image', 'twitter:image:src']) {
      const tw = metaContent(html, key);
      const twIn = tw && contentImages.some((img) => imageUrlsMatch(img.url, tw));
      pushMeta(tw, twIn ? 95 : 85, 0, 0);
    }
  }

  for (let index = 0; index < contentImages.length; index += 1) {
    const img = contentImages[index];
    const isFeatured = /\bwp-post-image\b/i.test(img.tag)
      || /\bwp-block-post-featured-image\b/i.test(img.tag)
      || img.isFull;
    const isThumb = img.isCropThumb;
    let score = (isFeatured ? 85 : 60) + img.w / 10 - (isThumb ? 25 : 0);
    // Image dans une <figure> légendée : placée et décrite par la rédaction,
    // c'est la photo éditorialement pertinente de l'article.
    if (img.hasCaption) score += 15;
    if (preferFirstContentImage && index === 0) score += 40;
    if (options.preferSizeFull && img.isFull) score += 20;
    if (options.preferSizeFull && isThumb) score -= 30;
    const unwrapped = unwrapCdnImageUrl(img.url);
    candidates.push({
      url: unwrapped || img.url,
      score,
      w: img.w,
      h: 0,
    });
  }

  if (!candidates.length) return { url: '', w: 0, h: 0 };
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return { url: best.url, w: best.w || 0, h: best.h || 0 };
}

function imageOptionsFromHints(hints = {}) {
  return {
    preferSizeFull: !!hints.preferSizeFull,
    preferFirstContentImage: !!hints.preferFirstContentImage,
  };
}

function needsImageEnrichment(item, extraRejectPatterns = [], options = {}) {
  if (!item.link) return false;
  if (!item.image || !isCandidateImageUrl(item.image, extraRejectPatterns)) return true;
  return isWeakImageUrl(item.image, options);
}

async function scrapeArticleImage(item, extraRejectPatterns = [], options = {}) {
  if (!item?.link) return null;
  const html = await fetchText(item.link);
  if (!html || html.length < 200) return null;
  const found = imageFromArticleHtml(html, extraRejectPatterns, options, item.link);
  if (!found.url) return null;
  return found;
}

function leadImageUrlCandidates(raw = '') {
  const seed = String(raw || '').trim();
  const ordered = [];
  const seen = new Set();
  const add = (u) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      ordered.push(u);
    }
  };
  const unwrapped = unwrapCdnImageUrl(seed);
  add(unwrapped);
  for (const up of upgradeCmsImageUrl(unwrapped || seed)) add(up);
  add(normalizeWpContentImageUrl(unwrapped || seed));
  add(seed);
  return ordered;
}

async function resolveLeadReadyPhoto(item, extraRejectPatterns = [], options = {}) {
  const tryUrlOnce = async (url, metaW = 0, metaH = 0) => {
    if (!url || !isCandidateImageUrl(url, extraRejectPatterns)) return null;
    // Ne pas abandonner une URL « weak » : leadImageUrlCandidates la promeut
    // (Image-16-600x315.jpg → Image-16.jpg). On ne skip que si *aucune*
    // variante n'est viable (géré par l'appelant via leadImageUrlCandidates).
    if (isWeakImageUrl(url, options)) return null;
    if (metaW && metaH && meetsLeadDisplaySize(metaW, metaH)) {
      return { url, width: metaW, height: metaH, source: 'meta', leadReady: true };
    }
    const dims = await probeRemoteImageSize(url);
    if (dims && meetsLeadDisplaySize(dims.width, dims.height)) {
      return { url, width: dims.width, height: dims.height, source: 'probe', leadReady: true };
    }
    // Feature / vignette OK mais pas hero (panorama trop large, etc.)
    if (dims && meetsFeatureDisplaySize(dims.width, dims.height)) {
      return { url, width: dims.width, height: dims.height, source: 'probe-feature', leadReady: false };
    }
    if (dims && dims.width >= 200 && dims.height >= 150) {
      return { url, width: dims.width, height: dims.height, source: 'probe-small', leadReady: false };
    }
    return null;
  };

  /** Ne retourne un hit « prêt vedette » que si leadReady !== false. */
  const tryUrlLeadReady = async (url, metaW = 0, metaH = 0) => {
    for (const candidate of leadImageUrlCandidates(url)) {
      const hit = await tryUrlOnce(candidate, metaW, metaH);
      if (hit && hit.leadReady !== false) return hit;
    }
    return null;
  };

  const tryUrlAny = async (url, metaW = 0, metaH = 0) => {
    for (const candidate of leadImageUrlCandidates(url)) {
      const hit = await tryUrlOnce(candidate, metaW, metaH);
      if (hit) return hit;
    }
    return null;
  };

  // 1) Image RSS déjà en format vedette
  if (item.image) {
    const hit = await tryUrlLeadReady(item.image);
    if (hit) return hit;
  }

  // 2) Scraper la page : l'image RSS peut être un panorama trop large ou une
  //    vignette, alors qu'une autre photo du corps est parfaitement utilisable
  //    (ex. La Pige : Bruno 1661×527 rejeté, Joanne 2560×1707 OK).
  //    Ne PAS renvoyer l'image RSS « petite » avant d'avoir cherché mieux.
  const scraped = await scrapeArticleImage(item, extraRejectPatterns, options);
  if (scraped?.url) {
    const hit = await tryUrlLeadReady(scraped.url, scraped.w, scraped.h);
    if (hit) return hit;
  }

  // 3) Plusieurs images du corps : tenter les meilleures candidates collectées
  //    via un second passage HTML (og + content), pas seulement le top score.
  if (item.link) {
    const html = await fetchText(item.link);
    if (html && html.length > 200) {
      const region = options.preferFirstContentImage
        ? (articleBodyHtml(html) || articleImageRegions(html))
        : articleImageRegions(html);
      const contentImages = collectContentImages(region, extraRejectPatterns, options, item.link);
      // Prioriser les plus larges / non-cropped
      const ranked = [...contentImages].sort((a, b) => {
        const aFull = a.isFull ? 1 : 0;
        const bFull = b.isFull ? 1 : 0;
        if (aFull !== bFull) return bFull - aFull;
        return (b.w || 0) - (a.w || 0);
      });
      for (const img of ranked.slice(0, 8)) {
        if (item.image && imageUrlsMatch(img.url, item.image)) continue;
        if (scraped?.url && imageUrlsMatch(img.url, scraped.url)) continue;
        const hit = await tryUrlLeadReady(img.url, img.w || 0, 0);
        if (hit) return hit;
      }
    }
  }

  // 4) Repli : image RSS ou scrape même si pas « lead ready » (mieux que rien
  //    pour les vignettes ; la banque campus ne doit pas les écraser).
  if (item.image) {
    const hit = await tryUrlAny(item.image);
    if (hit) return hit;
  }
  if (scraped?.url) {
    const hit = await tryUrlAny(scraped.url, scraped.w, scraped.h);
    if (hit) return hit;
  }

  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  GLOBAL_IMAGE_REJECT_RE,
  unwrapCdnImageUrl,
  upgradeCmsImageUrl,
  promoteImageUrl,
  imageRejectPatternsFromHints,
  imageOptionsFromHints,
  isPathRejected,
  LEAD_MIN_WIDTH,
  LEAD_MIN_HEIGHT,
  LEAD_MIN_PIXELS,
  FEATURE_MIN_WIDTH,
  FEATURE_MIN_HEIGHT,
  FEATURE_MIN_PIXELS,
  fetchText,
  fetchBinaryPrefix,
  probeRemoteImageSize,
  parseImageSize,
  metaContent,
  articleBodyHtml,
  articleImageRegions,
  articleImageIsValidOnPage,
  imageUrlsMatch,
  isCandidateImageUrl,
  isWeakImageUrl,
  meetsLeadDisplaySize,
  meetsFeatureDisplaySize,
  imageFromArticleHtml,
  needsImageEnrichment,
  scrapeArticleImage,
  resolveLeadReadyPhoto,
  normalizeWpContentImageUrl,
  upgradeCmsImageUrl,
  toAbsoluteImageUrl,
  resizeFromImageUrl,
  leadImageUrlCandidates,
  sleep,
  decodeEntities,
};