/**
 * Génération de visuels de repli pour la vedette (SVG, sans API payante).
 * Partagé par ensure-lead-images.js et la logique d'agrégation.
 */

const crypto = require('crypto');

const JUNK_IMAGE = /(logo|avatar|icon|placeholder|default|blank|spacer|profile|author|favicon|gravatar|emoji|smiley|article-tile|size-article-tile|thumbnail|thumb_|-150x\d+\.)/i;

function isCandidateImageUrl(raw = '') {
  const src = String(raw).trim();
  if (!src) return false;
  try {
    const url = new URL(src);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (JUNK_IMAGE.test(path)) return false;
    if (/(?:^|\/)(?:1x1|pixel)\b/.test(path)) return false;
    return true;
  } catch {
    return src.startsWith('data:image/') || src.startsWith('./assets/');
  }
}

function isWeakImageUrl(raw = '') {
  const path = String(raw).toLowerCase();
  if (/-\d{2,3}x\d{2,3}\./.test(path) && !/-\d{3,4}x\d{3,4}\./.test(path)) return true;
  return /article-tile|size-article-tile/.test(path);
}

function hasUsableImage(item) {
  return (
    (item.image && isCandidateImageUrl(item.image) && !isWeakImageUrl(item.image))
    || (item.stockImage && isCandidateImageUrl(item.stockImage))
    || (item.fallbackImage && isCandidateImageUrl(item.fallbackImage))
  );
}

function articleLinkKey(item) {
  return item.link || `${item.source}::${item.date}::${item.title}`;
}

function fallbackFileName(item) {
  const hash = crypto.createHash('sha1').update(articleLinkKey(item)).digest('hex').slice(0, 16);
  return `${hash}.svg`;
}

function escapeXml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function darkenHex(hex, amount = 0.28) {
  const h = String(hex || '#003DA5').replace('#', '');
  if (h.length !== 6) return '#003DA5';
  const r = Math.max(0, Math.round(parseInt(h.slice(0, 2), 16) * (1 - amount)));
  const g = Math.max(0, Math.round(parseInt(h.slice(2, 4), 16) * (1 - amount)));
  const b = Math.max(0, Math.round(parseInt(h.slice(4, 6), 16) * (1 - amount)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function wrapLines(text = '', max = 38, lines = 4) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > max && line) {
      out.push(line);
      line = w;
    } else {
      line = next;
    }
    if (out.length >= lines) break;
  }
  if (line && out.length < lines) out.push(line);
  return out.slice(0, lines);
}

function resolveBrandColor(item, brandColors = {}) {
  const inst = item.institution || '';
  const fromInst = brandColors.institutions?.[inst]?.color;
  if (fromInst) return fromInst;
  const palette = brandColors.fallback_palette || ['#003DA5', '#6C2163', '#047857'];
  let h = 0;
  for (const c of String(item.source || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function buildFallbackSvg(item, brandColors = {}) {
  const color = resolveBrandColor(item, brandColors);
  const dark = darkenHex(color, 0.32);
  const title = (item.title || 'Article').replace(/\s+/g, ' ').trim();
  const source = item.source || 'RADAR';
  const inst = item.institution || '';
  const lines = wrapLines(title, 36, 4);
  const tspans = lines.map((ln, i) =>
    `<tspan x="64" dy="${i === 0 ? 0 : 36}">${escapeXml(ln)}</tspan>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" role="img" aria-label="${escapeXml(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${color}"/>
      <stop offset="100%" stop-color="${dark}"/>
    </linearGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0V48" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1280" height="800" fill="url(#bg)"/>
  <rect width="1280" height="800" fill="url(#grid)"/>
  <circle cx="1080" cy="140" r="180" fill="rgba(255,255,255,0.06)"/>
  <circle cx="180" cy="680" r="240" fill="rgba(0,0,0,0.12)"/>
  <text x="64" y="72" fill="rgba(255,255,255,0.92)" font-family="system-ui,Segoe UI,sans-serif" font-size="28" font-weight="700" letter-spacing="0.12em">${escapeXml(source.toUpperCase())}</text>
  ${inst ? `<text x="64" y="108" fill="rgba(255,255,255,0.72)" font-family="system-ui,Segoe UI,sans-serif" font-size="20" font-weight="500">${escapeXml(inst)}</text>` : ''}
  <text x="64" y="${inst ? 220 : 200}" fill="#ffffff" font-family="Georgia,'Times New Roman',serif" font-size="44" font-weight="700">${tspans}</text>
  <text x="64" y="748" fill="rgba(255,255,255,0.55)" font-family="system-ui,Segoe UI,sans-serif" font-size="18" letter-spacing="0.08em">RADAR · MÉDIAS ÉTUDIANTS QC</text>
</svg>`;
}

module.exports = {
  isCandidateImageUrl,
  isWeakImageUrl,
  hasUsableImage,
  articleLinkKey,
  fallbackFileName,
  buildFallbackSvg,
  resolveBrandColor,
};