#!/usr/bin/env node
/**
 * LE RADAR — Génération des flux RSS sortants (méta-agrégateur).
 *
 * Lit news.json et publie feed.xml, feed-fr.xml et feed-en.xml.
 * Chaque item pointe vers l'article original ; description enrichie Le Radar.
 *
 *   node scripts/generate-feed.js
 *   node scripts/generate-feed.js --update
 */

const fs = require('fs');
const path = require('path');
const { pruneToFreshWindow } = require('./source-retention-lib');

const ROOT = path.join(__dirname, '..');
const NEWS_PATH = path.join(ROOT, 'news.json');
const SITE_BASE = (process.env.RADAR_SITE_URL || 'https://azdak919.github.io/radios-etudiantes-qc').replace(/\/$/, '');
const MAX_ITEMS = 50;

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
    title: 'LE RADAR — Les médias étudiants du Québec',
    description: 'Fil agrégé des journaux étudiants des cégeps et universités du Québec. Titres, brèves et liens vers les articles originaux.',
  },
  {
    file: 'feed-fr.xml',
    lang: 'fr-CA',
    filter: (item) => item.lang !== 'en',
    title: 'LE RADAR — Fil étudiant (français)',
    description: 'Actualités des médias étudiants francophones du Québec, agrégées par Le Radar.',
  },
  {
    file: 'feed-en.xml',
    lang: 'en-CA',
    filter: (item) => item.lang === 'en',
    title: 'LE RADAR — Student media feed (English)',
    description: 'Quebec student newspaper headlines and briefs in English, aggregated by LE RADAR.',
  },
];

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
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

function institutionLabel(item = {}) {
  const name = String(item.institution || '').trim();
  if (!name) return '';
  if (INSTITUTION_LABELS[name]) return INSTITUTION_LABELS[name];
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name;
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
  return cleanBrief(item.leadExcerpt || item.excerpt || '');
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

function buildDescriptionHtml(item = {}) {
  const parts = [];
  const brief = itemBrief(item);
  if (brief) parts.push(`<p>${escapeXml(brief)}</p>`);
  const attr = attributionLine(item);
  if (attr) parts.push(`<p><em>${escapeXml(attr)}</em></p>`);
  const credit = photoCreditLine(item);
  if (credit) parts.push(`<p><small>${escapeXml(credit)}</small></p>`);
  const note = item.lang === 'en'
    ? 'Aggregated by LE RADAR — link opens the original student publication.'
    : 'Agrégé par Le Radar — le lien ouvre la publication étudiante originale.';
  parts.push(`<p><small>${escapeXml(note)}</small></p>`);
  return parts.join('\n');
}

function buildItemXml(item = {}) {
  const link = String(item.link || '').trim();
  if (!link) return '';

  const title = String(item.title || 'Article').trim();
  const pubDate = formatRfc822(item.date);
  const description = buildDescriptionHtml(item);
  const imageUrl = itemImageUrl(item);
  const credit = photoCreditLine(item);

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

  const mediaXml = imageUrl
    ? `      <media:content url="${escapeXml(imageUrl)}" medium="image">\n`
      + (credit ? `        <media:credit>${escapeXml(credit)}</media:credit>\n` : '')
      + '      </media:content>\n'
      + `      <enclosure url="${escapeXml(imageUrl)}" type="image/jpeg" length="0" />\n`
    : '';

  return [
    '    <item>',
    `      <title>${escapeXml(title)}</title>`,
    `      <link>${escapeXml(link)}</link>`,
    `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
    pubDate ? `      <pubDate>${escapeXml(pubDate)}</pubDate>` : '',
    `      <description>${cdata(description)}</description>`,
    categoryXml,
    mediaXml.trimEnd(),
    '    </item>',
  ].filter(Boolean).join('\n');
}

function buildFeedXml(items = [], config = {}) {
  const feedUrl = `${SITE_BASE}/${config.file}`;
  const updated = items.length
    ? formatRfc822(items[0].date)
    : formatRfc822(new Date());

  const itemXml = items.map(buildItemXml).filter(Boolean).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(config.title)}</title>
    <link>${escapeXml(SITE_BASE)}/</link>
    <description>${escapeXml(config.description)}</description>
    <language>${escapeXml(config.lang)}</language>
    <lastBuildDate>${escapeXml(updated)}</lastBuildDate>
    <generator>LE RADAR Student Media Aggregator</generator>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <image>
      <url>${escapeXml(SITE_BASE)}/assets/icon-192.png</url>
      <title>${escapeXml(config.title)}</title>
      <link>${escapeXml(SITE_BASE)}/</link>
    </image>
${itemXml}
  </channel>
</rss>
`;
}

function main() {
  const doUpdate = process.argv.includes('--update');
  const news = readJson(NEWS_PATH, { items: [] });
  const items = pruneToFreshWindow(news.items || [])
    .filter((item) => item.link && item.title && item.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (!items.length) {
    console.error('No items in news.json — aborting.');
    process.exit(1);
  }

  console.log('LE RADAR RSS Generator');
  console.log('===================\n');
  console.log(`Site     : ${SITE_BASE}`);
  console.log(`Articles : ${items.length} (max ${MAX_ITEMS} par flux)\n`);

  const written = [];

  for (const config of FEEDS) {
    const subset = items.filter(config.filter).slice(0, MAX_ITEMS);
    const xml = buildFeedXml(subset, config);
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