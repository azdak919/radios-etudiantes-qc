/**
 * Extraction et validation d'images d'articles — partagé par fetch-news et ensure-lead-images.
 */

const https = require('https');

const DEFAULT_TIMEOUT = 12000;

/** Motifs globaux de rejet (logos, placeholders, widgets, carrousels). */
const GLOBAL_IMAGE_REJECT_RE = /(?:logo|avatar|icon|placeholder|default|blank|spacer|profile|author|favicon|gravatar|emoji|smiley|lapige_web|(?:^|\/)article-2\.|campus-logo|campusgraphic|article-tile|size-article-tile|thumbnail|thumb_|recent-posts|wp-block-query|widget|sponsor|banner|social-share|-150x\d+\.)/i;

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

function fetchText(url, redirects = 3, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; REQ-NewsBot/1.0)',
          Accept: 'application/rss+xml, application/xml, text/xml, text/html, image/*, */*',
        },
        timeout,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(fetchText(next, redirects - 1, timeout));
        }
        if (res.statusCode >= 400) {
          res.resume();
          return resolve('');
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });
}

function fetchBinaryPrefix(url, maxBytes = 65536, redirects = 3, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const req = https.get(
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

function collectContentImages(content = '', extraRejectPatterns = [], options = {}) {
  const urls = [];
  const preferSizeFull = !!options.preferSizeFull;
  for (const m of content.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const tag = m[0];
    const src = decodeEntities(m[1]);
    const w = parseInt((tag.match(/width=["'](\d+)["']/i) || [])[1], 10) || 0;
    if (!isCandidateImageUrl(src, extraRejectPatterns) || isWeakImageUrl(src, options)) continue;
    if (w > 0 && w < 400) continue;
    const isFull = /\bsize-full\b/i.test(tag);
    const isCropThumb = /-\d{3}x\d{2,3}\./i.test(src);
    urls.push({ url: src, tag, w, isFull, isCropThumb });
  }
  if (preferSizeFull) {
    const fullOnly = urls.filter((img) => img.isFull || !img.isCropThumb);
    if (fullOnly.length) return fullOnly;
  }
  return urls;
}

function articleImageIsValidOnPage(html = '', imageUrl = '', extraRejectPatterns = [], options = {}) {
  if (!html || !imageUrl) return false;
  const contentImages = collectContentImages(articleImageRegions(html), extraRejectPatterns, options);
  if (!contentImages.length) return false;
  return contentImages.some((img) => imageUrlsMatch(img.url, imageUrl));
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

function isWeakImageUrl(raw = '', options = {}) {
  const path = String(raw).toLowerCase();
  if (options.preferSizeFull && /-\d{3}x\d{2,3}\./.test(path) && !/\bsize-full\b/.test(path)) return true;
  if (/-\d{2,3}x\d{2,3}\./.test(path) && !/-\d{3,4}x\d{3,4}\./.test(path)) return true;
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

function imageFromArticleHtml(html = '', extraRejectPatterns = [], options = {}) {
  const contentImages = collectContentImages(articleImageRegions(html), extraRejectPatterns, options);
  if (!contentImages.length) return { url: '', w: 0, h: 0 };

  const candidates = [];

  const ogImage = metaContent(html, 'og:image');
  const ogW = parseInt(metaContent(html, 'og:image:width'), 10) || 0;
  const ogH = parseInt(metaContent(html, 'og:image:height'), 10) || 0;
  if (ogImage && contentImages.some((img) => imageUrlsMatch(img.url, ogImage))) {
    candidates.push({ url: ogImage, score: 100 + Math.min(ogW, 2400) / 10, w: ogW, h: ogH });
  }

  for (const key of ['twitter:image', 'twitter:image:src']) {
    const tw = metaContent(html, key);
    if (tw && contentImages.some((img) => imageUrlsMatch(img.url, tw))) {
      candidates.push({ url: tw, score: 90, w: 0, h: 0 });
    }
  }

  for (const img of contentImages) {
    const isFeatured = /\bwp-post-image\b/i.test(img.tag)
      || /\bwp-block-post-featured-image\b/i.test(img.tag)
      || img.isFull;
    const isThumb = img.isCropThumb;
    let score = (isFeatured ? 85 : 60) + img.w / 10 - (isThumb ? 25 : 0);
    if (options.preferSizeFull && img.isFull) score += 20;
    if (options.preferSizeFull && isThumb) score -= 30;
    candidates.push({
      url: img.url,
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
  const found = imageFromArticleHtml(html, extraRejectPatterns, options);
  if (!found.url) return null;
  return found;
}

async function resolveLeadReadyPhoto(item, extraRejectPatterns = [], options = {}) {
  const tryUrl = async (url, metaW = 0, metaH = 0) => {
    if (!url || !isCandidateImageUrl(url, extraRejectPatterns) || isWeakImageUrl(url, options)) return null;
    if (metaW && metaH && meetsLeadDisplaySize(metaW, metaH)) {
      return { url, width: metaW, height: metaH, source: 'meta' };
    }
    const dims = await probeRemoteImageSize(url);
    if (dims && meetsLeadDisplaySize(dims.width, dims.height)) {
      return { url, width: dims.width, height: dims.height, source: 'probe' };
    }
    if (dims && dims.width >= 200 && dims.height >= 150) {
      return { url, width: dims.width, height: dims.height, source: 'probe-small', leadReady: false };
    }
    return null;
  };

  if (item.image && item.link) {
    const html = await fetchText(item.link);
    if (html && articleImageIsValidOnPage(html, item.image, extraRejectPatterns, options)) {
      const hit = await tryUrl(item.image);
      if (hit) return hit;
    }
  }

  const scraped = await scrapeArticleImage(item, extraRejectPatterns, options);
  if (scraped?.url) {
    const hit = await tryUrl(scraped.url, scraped.w, scraped.h);
    if (hit) return hit;
    if (scraped.url && isCandidateImageUrl(scraped.url, extraRejectPatterns)) {
      const dims = await probeRemoteImageSize(scraped.url);
      if (dims) {
        return {
          url: scraped.url,
          width: dims.width,
          height: dims.height,
          source: 'page-scrape',
          leadReady: meetsLeadDisplaySize(dims.width, dims.height),
        };
      }
      return { url: scraped.url, width: scraped.w, height: scraped.h, source: 'page-scrape', leadReady: false };
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  GLOBAL_IMAGE_REJECT_RE,
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
  sleep,
  decodeEntities,
};