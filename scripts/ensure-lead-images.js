#!/usr/bin/env node
/**
 * Bot QC vedette — séquence :
 *   1. Vérifier la photo existante (dimensions réelles)
 *   2. Scraper la page source si photo absente ou trop faible
 *   3. Chercher une photo libre (Openverse / Wikimedia) par mots-clés
 *
 *   node scripts/ensure-lead-images.js
 *   node scripts/ensure-lead-images.js --update
 */

const fs = require('fs');
const path = require('path');
const { hasUsableImage, isCandidateImageUrl, isWeakImageUrl } = require('./lead-fallback-lib');
const {
  resolveLeadReadyPhoto,
  meetsLeadDisplaySize,
  probeRemoteImageSize,
  fetchText,
  articleImageIsValidOnPage,
  sleep,
} = require('./article-image-lib');
const { findStockPhoto, cleanCreatorName } = require('./stock-photo-lib');


const ROOT = path.join(__dirname, '..');
const NEWS_PATH = path.join(ROOT, 'news.json');
const QC_PATH = path.join(ROOT, 'lead-image-qc.json');
const HERO_MIN_POOL = 4;
const PAGE_SCRAPE_LIMIT = 30;
const STOCK_SEARCH_LIMIT = 28;
const doUpdate = process.argv.includes('--update');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function clearLegacyFallback(item) {
  delete item.fallbackImage;
}

function imagePathKey(url = '') {
  try {
    const file = decodeURIComponent(new URL(url).pathname).split('/').pop() || '';
    return file.replace(/-\d+x\d+(?=\.[a-z]+$)/i, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Évite de re-fetcher toutes les pages : Campus + images dont le nom ne colle pas au slug. */
function shouldValidateImageOnPage(item = {}) {
  if (!item.image || !item.link) return false;
  if (item.source === 'The Campus') return true;
  const slug = String(item.link).split('/').filter(Boolean).pop() || '';
  const img = imagePathKey(item.image);
  if (!slug || !img || slug.length < 10) return false;
  const tokens = slug.split('-').filter((t) => t.length > 4);
  if (tokens.length < 2) return false;
  return !tokens.some((t) => img.includes(t));
}

async function probeLeadReady(url) {
  if (!url || !isCandidateImageUrl(url) || isWeakImageUrl(url)) return false;
  const dims = await probeRemoteImageSize(url);
  return !!(dims && meetsLeadDisplaySize(dims.width, dims.height));
}

async function markSourceLeadQuality(item) {
  const sourceReady = await probeLeadReady(item.image);
  item.leadImageReady = sourceReady;
  return sourceReady;
}

async function photoIsLeadReady(item) {
  if (await probeLeadReady(item.stockImage)) return true;
  return markSourceLeadQuality(item);
}

async function applyStockPhoto(item) {
  const stock = await findStockPhoto(item);
  if (!stock?.stockImage) return false;
  if (doUpdate) {
    item.stockImage = stock.stockImage;
    item.imageCredit = stock.imageCredit;
    item.imageCreator = stock.imageCreator || '';
    item.imageLicense = stock.imageLicense;
    item.imageProvider = stock.imageProvider;
    item.imageSourceUrl = stock.imageSourceUrl;
    const sourceReady = await markSourceLeadQuality(item);
    if (!sourceReady) item.leadImageReady = false;
    clearLegacyFallback(item);
  }
  return true;
}

function backfillImageCreator(item) {
  if (item.imageCreator || !item.imageCredit) return;
  const m = String(item.imageCredit).match(/^Photo\s*:\s*(.+?)\s*\/\s*/i);
  if (m) item.imageCreator = cleanCreatorName(m[1].trim());
}

async function main() {
  const news = readJson(NEWS_PATH, { items: [] });
  const items = news.items || [];
  items.forEach(backfillImageCreator);
  if (!items.length) {
    console.error('No items in news.json');
    process.exit(1);
  }

  let pageScraped = 0;
  let photosRecovered = 0;
  let stockFound = 0;
  let stockSearches = 0;
  let imagesCleared = 0;
  const gaps = [];

  for (const item of items) {
    if (!shouldValidateImageOnPage(item)) continue;
    const html = await fetchText(item.link);
    if (!html || articleImageIsValidOnPage(html, item.image)) continue;
    if (doUpdate) {
      item.image = '';
      item.leadImageReady = false;
    }
    imagesCleared += 1;
    await sleep(120);
  }

  const scrapeQueue = items
    .filter((item) => item.link && (!item.image || !isCandidateImageUrl(item.image) || isWeakImageUrl(item.image)))
    .slice(0, PAGE_SCRAPE_LIMIT);

  for (const item of scrapeQueue) {
    const resolved = await resolveLeadReadyPhoto(item);
    if (!resolved?.url) continue;
    pageScraped += 1;
    if (doUpdate) {
      item.image = resolved.url;
      clearLegacyFallback(item);
    }
    if (resolved.leadReady !== false) photosRecovered += 1;
    await sleep(200);
  }

  const stockQueue = [];
  for (const item of items) {
    if (await photoIsLeadReady(item)) {
      if (doUpdate) {
        await markSourceLeadQuality(item);
        clearLegacyFallback(item);
      }
      continue;
    }
    if (!item.image || !isCandidateImageUrl(item.image)) {
      const resolved = await resolveLeadReadyPhoto(item);
      if (resolved?.url && doUpdate) {
        item.image = resolved.url;
        clearLegacyFallback(item);
        pageScraped += 1;
        if (resolved.leadReady !== false) photosRecovered += 1;
      }
      if (await photoIsLeadReady(item)) continue;
    }
    stockQueue.push(item);
  }

  for (const item of stockQueue.slice(0, STOCK_SEARCH_LIMIT)) {
    if (await photoIsLeadReady(item)) {
      if (doUpdate) clearLegacyFallback(item);
      continue;
    }

    stockSearches += 1;
    const found = await applyStockPhoto(item);
    if (found) stockFound += 1;
    if (await photoIsLeadReady(item)) continue;

    gaps.push({
      title: item.title,
      link: item.link,
      reason: found ? 'stock-too-small' : 'no-stock-match',
      image: item.image || item.stockImage || null,
    });
    await sleep(300);
  }

  const withPhoto = items.filter((i) => i.image && isCandidateImageUrl(i.image)).length;
  const withStock = items.filter((i) => i.stockImage && isCandidateImageUrl(i.stockImage)).length;
  const fullyCovered = items.filter((i) => hasUsableImage(i)).length;
  const leadReadyCount = (await Promise.all(items.map((i) => photoIsLeadReady(i)))).filter(Boolean).length;

  const qc = {
    updated: new Date().toISOString(),
    total: items.length,
    withPhoto,
    withStock,
    fullyCovered,
    leadReadyPhotos: leadReadyCount,
    pageScraped,
    photosRecovered,
    imagesCleared,
    stockSearches,
    stockFound,
    mainPageLeadReady: leadReadyCount >= Math.min(HERO_MIN_POOL, items.length),
    gaps: gaps.slice(0, 12),
  };

  console.log('Lead image QC');
  console.log('==============');
  console.log(`Articles          : ${qc.total}`);
  console.log(`Photos source     : ${qc.withPhoto}`);
  console.log(`Photos banque     : ${qc.withStock}`);
  console.log(`Photos vedette OK : ${qc.leadReadyPhotos}`);
  console.log(`Pages scrapées    : ${qc.pageScraped}`);
  if (qc.imagesCleared) console.log(`Photos invalides  : ${qc.imagesCleared} retirée(s)`);
  console.log(`Banques consultées: ${qc.stockSearches}`);
  console.log(`Photos libres     : ${qc.stockFound}`);
  console.log(`Couverture totale : ${qc.fullyCovered}/${qc.total}`);
  console.log('Crédits photo     : voir scripts/verify-photo-credits.js');

  if (gaps.length) {
    console.log('\nArticles sans visuel vedette :');
    gaps.slice(0, 5).forEach((g) => console.log(`  · ${g.title} — ${g.reason}`));
  }

  if (doUpdate) {
    fs.writeFileSync(NEWS_PATH, JSON.stringify({ ...news, items }, null, 2) + '\n');
    fs.writeFileSync(QC_PATH, JSON.stringify(qc, null, 2) + '\n');
    console.log(`\n✅ ${NEWS_PATH}`);
    console.log(`✅ ${QC_PATH}`);
  } else {
    console.log('\nDry-run. Use --update to write news.json.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});