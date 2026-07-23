#!/usr/bin/env node
/**
 * LE-RADAR.ca — Génération des flux RSS sortants (méta-agrégateur).
 *
 * Lit news.json et publie feed.xml (fil unique, toutes langues).
 * Chaque item pointe vers l'article original ; corps HTML compact
 * (méta · image · brève · pied de page) pour un rendu propre dans
 * les lecteurs RSS — sans fiche auteur ni pièce jointe parasite.
 *
 *   node scripts/generate-feed.js
 *   node scripts/generate-feed.js --update
 */

const fs = require('fs');
const path = require('path');
const { pruneToFreshWindow } = require('./source-retention-lib');

const ROOT = path.join(__dirname, '..');
const NEWS_PATH = path.join(ROOT, 'news.json');
const SOURCES_PATH = path.join(ROOT, 'news-sources.json');
/** Domaine canonique (Pages + custom domain). Surcharge : RADAR_SITE_URL. */
const SITE_BASE = (process.env.RADAR_SITE_URL || 'https://le-radar.ca').replace(/\/$/, '');
const BRAND = 'LE-RADAR.ca';
const MAX_ITEMS = 50;
const BRIEF_MAX = 900;

const INSTITUTION_LABELS = {
  'Université de Montréal': 'UdeM',
  UQAM: 'UQAM',
  'Université du Québec à Montréal': 'UQAM',
  'Université McGill': 'McGill',
  'McGill University': 'McGill',
  'Concordia University': 'Concordia',
  'Université Laval': 'ULaval',
  'Université de Sherbrooke': 'UdeS',
  'Université du Québec à Trois-Rivières': 'UQTR',
  'Université du Québec à Chicoutimi': 'UQAC',
  'Université du Québec à Rimouski': 'UQAR',
  'Polytechnique Montréal': 'Poly Montréal',
  'Cégep du Vieux Montréal': 'Cégep Vieux-Montréal',
};

const FEEDS = [
  {
    file: 'feed.xml',
    lang: 'fr-CA',
    filter: () => true,
    title: BRAND,
    description:
      'LE-RADAR.ca — fil agrégé des journaux étudiants des cégeps et universités du Québec (français et anglais). Titres, brèves, images et liens vers les articles originaux.',
  },
];

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function loadSourceSites() {
  const registry = readJson(SOURCES_PATH, { active: [] });
  return Object.fromEntries(
    (registry.active || [])
      .filter((src) => src.name && src.site)
      .map((src) => [src.name, String(src.site).trim()]),
  );
}

function escapeXml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(text = '') {
  return `<![CDATA[${String(text).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function formatRfc822(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toUTCString().replace('GMT', '+0000');
}

function formatInstitutionDisplay(name = '') {
  if (!name) return '';
  return String(name)
    .replace(/\buniversité\b/giu, 'Université')
    .replace(/\buniversite\b/giu, 'Université')
    .replace(/\buniversity\b/giu, 'University')
    .replace(/\bcégep\b/giu, 'Cégep')
    .replace(/\bcegep\b/giu, 'Cégep');
}

function institutionLabel(item = {}) {
  const name = String(item.institution || '').trim();
  if (!name) return '';
  if (INSTITUTION_LABELS[name]) return INSTITUTION_LABELS[name];
  return formatInstitutionDisplay(name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name);
}

function cleanBrief(text = '', max = 520) {
  let s = String(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const last = cut.lastIndexOf(' ');
    s = (last > max * 0.6 ? cut.slice(0, last) : cut).trim() + '…';
  }
  return s;
}

function itemBrief(item = {}) {
  return cleanBrief(item.leadExcerpt || item.excerpt || '', BRIEF_MAX);
}

function itemDateline(item = {}) {
  const d = new Date(item.date);
  if (Number.isNaN(d.getTime())) return '';
  const region = String(item.region || '').trim();
  const en = item.lang === 'en';
  const dateStr = d.toLocaleDateString(en ? 'en-CA' : 'fr-CA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Toronto',
  });
  if (region) return en ? `${region} — ${dateStr}` : `${region}, le ${dateStr}`;
  return dateStr;
}

/** Date courte pour lecteurs RSS à espace limité (sous le titre). */
function itemSimpleDate(item = {}) {
  const d = new Date(item.date);
  if (Number.isNaN(d.getTime())) return '';
  const en = item.lang === 'en';
  const now = new Date();
  const opts = { day: 'numeric', month: 'short', timeZone: 'America/Toronto' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(en ? 'en-CA' : 'fr-CA', opts);
}

/** Ligne prioritaire : média · auteur · date (affichée sous le titre dans les apps RSS). */
function itemCompactMeta(item = {}) {
  const author = itemAuthor(item);
  const source = String(item.source || '').trim();
  const date = itemSimpleDate(item);
  return [source, author, date].filter(Boolean).join(' · ');
}

function sourceHomeUrl(item = {}, sourceSites = {}) {
  const named = sourceSites[item.source];
  if (named) return named;
  try {
    const url = new URL(String(item.link || '').trim());
    return `${url.origin}/`;
  } catch {
    return '';
  }
}

function itemAuthor(item = {}) {
  const author = String(item.author || '').trim();
  if (!author) return '';
  return author;
}

function attributionLine(item = {}) {
  const en = item.lang === 'en';
  const author = itemAuthor(item);
  const source = String(item.source || '').trim();
  const inst = institutionLabel(item);
  const parts = [];
  if (author) parts.push(en ? `By ${author}` : `Par ${author}`);
  if (source) {
    const via = en ? `Via ${source}` : `Via ${source}`;
    parts.push(inst ? `${via} (${inst})` : via);
  } else if (inst) {
    parts.push(inst);
  }
  return parts.join(' — ');
}

function photoCreditLine(item = {}) {
  const credit = String(item.sourceImageCredit || item.imageCredit || '').trim();
  if (!credit) return '';
  return item.lang === 'en' ? `Photo: ${credit.replace(/^Photo\s*:?\s*/i, '')}` : credit;
}

function itemImageUrl(item = {}) {
  return String(item.image || item.stockImage || '').trim();
}

function imageMimeType(url = '') {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/jpeg';
}

/**
 * Résumé texte pour &lt;description&gt; (apps qui n'utilisent pas content:encoded).
 * Méta + brève, sans HTML — lisible sous le titre.
 */
function buildDescriptionText(item = {}) {
  const meta = itemCompactMeta(item);
  const brief = itemBrief(item);
  return [meta, brief].filter(Boolean).join('\n\n');
}

/**
 * Corps HTML pour content:encoded — carte éditoriale compacte :
 * méta · image · brève · lien source + marque.
 * Pas de fiche auteur (avatar, bio) ni d'images de bas de page source.
 */
function buildItemBodyHtml(item = {}, sourceSites = {}) {
  const parts = [];
  const imageUrl = itemImageUrl(item);
  const title = String(item.title || 'Article').trim();
  const credit = photoCreditLine(item);
  const meta = itemCompactMeta(item);
  const en = item.lang === 'en';
  const link = String(item.link || '').trim();
  const sourceName = String(item.source || '').trim();
  const inst = institutionLabel(item);

  if (meta) {
    parts.push(
      `<p style="margin:0 0 0.85em;font-size:0.9em;line-height:1.4;color:#666">`
      + `<strong style="color:#444">${escapeXml(meta)}</strong>`
      + `</p>`,
    );
  }

  if (imageUrl) {
    parts.push(
      '<figure style="margin:0 0 1em;padding:0">',
      `<img src="${escapeXml(imageUrl)}" alt="${escapeXml(title)}" `
      + 'style="max-width:100%;height:auto;display:block;border-radius:8px" />',
      credit
        ? `<figcaption style="font-size:0.8em;color:#888;margin-top:0.4em;line-height:1.35">`
          + `${escapeXml(credit)}</figcaption>`
        : '',
      '</figure>',
    );
  }

  const brief = itemBrief(item);
  if (brief) {
    parts.push(
      `<p style="margin:0 0 1em;line-height:1.55;font-size:1em;color:#222">${escapeXml(brief)}</p>`,
    );
  }
  if (credit && !imageUrl) {
    parts.push(`<p style="margin:0 0 0.75em;font-size:0.85em;color:#888">${escapeXml(credit)}</p>`);
  }

  // Pied de page compact — remplace les boîtes auteur scrapées en bas d'article.
  const footerBits = [];
  if (link) {
    const label = sourceName
      ? (en ? `Read on ${sourceName}` : `Lire sur ${sourceName}`)
      : (en ? 'Read the article' : "Lire l'article");
    footerBits.push(`<a href="${escapeXml(link)}" style="color:#6C2163;text-decoration:none;font-weight:600">${escapeXml(label)}</a>`);
  }
  if (inst) footerBits.push(`<span style="color:#888">${escapeXml(inst)}</span>`);
  footerBits.push(`<span style="color:#888">${escapeXml(BRAND)}</span>`);

  parts.push(
    `<p style="margin:1.1em 0 0;padding-top:0.75em;border-top:1px solid #e5e5e5;`
    + `font-size:0.85em;line-height:1.45;color:#666">`
    + footerBits.join(' <span style="color:#ccc">·</span> ')
    + `</p>`,
  );

  return parts.join('\n');
}

function buildItemXml(item = {}, sourceSites = {}) {
  const link = String(item.link || '').trim();
  if (!link) return '';

  const title = String(item.title || 'Article').trim();
  const pubDate = formatRfc822(item.date);
  const description = buildDescriptionText(item);
  const imageUrl = itemImageUrl(item);
  const credit = photoCreditLine(item);
  const author = itemAuthor(item);
  const sourceName = String(item.source || '').trim();
  const sourceUrl = sourceHomeUrl(item, sourceSites);

  const categories = [
    item.source,
    institutionLabel(item),
    item.region,
    item.type === 'universite' ? 'université' : item.type === 'cegep' ? 'cégep' : '',
    item.lang === 'en' ? 'English' : 'Français',
  ].filter(Boolean);

  const categoryXml = categories
    .map((c) => `      <category>${escapeXml(c)}</category>`)
    .join('\n');

  // Image via Media RSS seulement (pas d'<enclosure>) :
  // les enclosures apparaissent comme « Attachments » dans Discord / certains
  // lecteurs, en double de l'image déjà dans content:encoded.
  const mime = imageUrl ? imageMimeType(imageUrl) : '';
  const mediaXml = imageUrl
    ? `      <media:content url="${escapeXml(imageUrl)}" medium="image" type="${escapeXml(mime)}" isDefault="true">\n`
      + (credit ? `        <media:credit role="photographer">${escapeXml(credit)}</media:credit>\n` : '')
      + (title ? `        <media:title>${escapeXml(title)}</media:title>\n` : '')
      + '      </media:content>\n'
      + `      <media:thumbnail url="${escapeXml(imageUrl)}" />`
    : '';

  const bodyHtml = buildItemBodyHtml(item, sourceSites);
  const creatorXml = author ? `      <dc:creator>${escapeXml(author)}</dc:creator>` : '';
  const sourceXml = sourceName && sourceUrl
    ? `      <source url="${escapeXml(sourceUrl)}">${escapeXml(sourceName)}</source>`
    : '';

  return [
    '    <item>',
    `      <title>${escapeXml(title)}</title>`,
    `      <link>${escapeXml(link)}</link>`,
    `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
    pubDate ? `      <pubDate>${escapeXml(pubDate)}</pubDate>` : '',
    creatorXml,
    sourceXml,
    `      <description>${cdata(description)}</description>`,
    `      <content:encoded>${cdata(bodyHtml)}</content:encoded>`,
    categoryXml,
    mediaXml,
    '    </item>',
  ].filter(Boolean).join('\n');
}

function buildFeedXml(items = [], config = {}, sourceSites = {}) {
  const feedUrl = `${SITE_BASE}/${config.file}`;
  const updated = items.length
    ? formatRfc822(items[0].date)
    : formatRfc822(new Date());

  const itemXml = items.map((item) => buildItemXml(item, sourceSites)).filter(Boolean).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(config.title)}</title>
    <link>${escapeXml(SITE_BASE)}/</link>
    <description>${escapeXml(config.description)}</description>
    <language>${escapeXml(config.lang)}</language>
    <lastBuildDate>${escapeXml(updated)}</lastBuildDate>
    <generator>${escapeXml(BRAND)} Student Media Aggregator</generator>
    <docs>${escapeXml(SITE_BASE)}/feeds.html</docs>
    <copyright>© publications étudiantes sources — fil agrégé par ${escapeXml(BRAND)}</copyright>
    <ttl>180</ttl>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <image>
      <url>${escapeXml(SITE_BASE)}/assets/icon-192.png</url>
      <title>${escapeXml(config.title)}</title>
      <link>${escapeXml(SITE_BASE)}/</link>
      <width>192</width>
      <height>192</height>
    </image>
${itemXml}
  </channel>
</rss>
`;
}

function main() {
  const doUpdate = process.argv.includes('--update');
  const news = readJson(NEWS_PATH, { items: [] });
  const sourceSites = loadSourceSites();
  const items = pruneToFreshWindow(news.items || [])
    .filter((item) => item.link && item.title && item.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (!items.length) {
    console.error('No items in news.json — aborting.');
    process.exit(1);
  }

  console.log(`${BRAND} RSS Generator`);
  console.log('=======================\n');
  console.log(`Site     : ${SITE_BASE}`);
  console.log(`Articles : ${items.length} (max ${MAX_ITEMS} par flux)\n`);

  const written = [];

  for (const config of FEEDS) {
    const subset = items.filter(config.filter).slice(0, MAX_ITEMS);
    const xml = buildFeedXml(subset, config, sourceSites);
    const outPath = path.join(ROOT, config.file);

    if (doUpdate) {
      fs.writeFileSync(outPath, xml, 'utf8');
    }

    written.push({ file: config.file, count: subset.length, bytes: Buffer.byteLength(xml, 'utf8') });
    console.log(`${config.file}: ${subset.length} item(s)${doUpdate ? ' → written' : ' (dry-run)'}`);
  }

  if (!doUpdate) {
    console.log('\nDry-run. Utilisez --update pour écrire les flux.');
  } else {
    console.log('\n✅ Flux RSS publiés :');
    written.forEach((w) => console.log(`   ${w.file} (${w.count} items, ${w.bytes} bytes)`));
  }
}

main();