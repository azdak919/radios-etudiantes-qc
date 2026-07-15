#!/usr/bin/env node
/**
 * Bot QC vedette — toutes sources (pas seulement un média) :
 *   1. Vérifier la photo existante (dimensions réelles)
 *   2. Scraper la page source si photo absente ou trop faible
 *   3. Photo libre Openverse/Commons par mots-clés titre + contenu
 *      (stock-photo-lib : requêtes FR→EN, scoring thématique)
 *   4. Repli campus curaté, unicité par établissement
 *   5. 2e chance banque libre si l’unicité campus a vidé un article
 *
 *   node scripts/ensure-lead-images.js
 *   node scripts/ensure-lead-images.js --update
 */

const fs = require('fs');
const path = require('path');
const { hasUsableImage } = require('./lead-fallback-lib');
const {
  isCandidateImageUrl,
  isWeakImageUrl,
  imageRejectPatternsFromHints,
  imageOptionsFromHints,
} = require('./article-image-lib');
const {
  resolveLeadReadyPhoto,
  meetsLeadDisplaySize,
  meetsFeatureDisplaySize,
  leadImageUrlCandidates,
  probeRemoteImageSize,
  fetchText,
  articleImageIsValidOnPage,
  sleep,
} = require('./article-image-lib');
const { findStockPhoto, cleanCreatorName, stockStillFits } = require('./stock-photo-lib');
const { pickCampusPhoto, hasCampusBank, diversifyCampusBankItems } = require('./campus-photo-bank');
const { pruneToFreshWindow, loadSourceRegistryMap, getBotHints } = require('./source-retention-lib');


const ROOT = path.join(__dirname, '..');
const NEWS_PATH = path.join(ROOT, 'news.json');
const QC_PATH = path.join(ROOT, 'lead-image-qc.json');
const HERO_MIN_POOL = 4;
const HERO_PRIORITY_POOL = 45;
const PAGE_SCRAPE_LIMIT = 40;
/* Assez large pour couvrir le pool frais de toutes les sources. */
const STOCK_SEARCH_LIMIT = 120;
const doUpdate = process.argv.includes('--update');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function clearLegacyFallback(item) {
  delete item.fallbackImage;
}

function clearStockPhoto(item) {
  delete item.stockImage;
  delete item.imageTitle;
  delete item.imageCredit;
  delete item.imageCreator;
  delete item.imageLicense;
  delete item.imageProvider;
  delete item.imageSourceUrl;
}

function imageHintsFor(item = {}, sourceMap = new Map()) {
  return getBotHints(sourceMap.get(item.source), 'images');
}

function isCandidateForItem(item = {}, sourceMap = new Map()) {
  const hints = imageHintsFor(item, sourceMap);
  const reject = imageRejectPatternsFromHints(hints);
  const opts = imageOptionsFromHints(hints);
  return {
    reject,
    opts,
    ok: (url) => url && isCandidateImageUrl(url, reject) && !isWeakImageUrl(url, opts),
  };
}

function hasSourcePhoto(item = {}, sourceMap = new Map()) {
  const { ok } = isCandidateForItem(item, sourceMap);
  return ok(item.image);
}

function imagePathKey(url = '') {
  try {
    const file = decodeURIComponent(new URL(url).pathname).split('/').pop() || '';
    return file.replace(/-\d+x\d+(?=\.[a-z]+$)/i, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Évite de re-fetcher toutes les pages : sources avec botHints.images.validateOnPage + heuristique slug. */
function shouldValidateImageOnPage(item = {}, sourceMap = new Map()) {
  if (!item.image || !item.link) return false;
  const hints = getBotHints(sourceMap.get(item.source), 'images');
  if (hints.trustSourceImage || hints.preferFirstContentImage) return false;
  if (hints.validateOnPage) return true;
  const slug = String(item.link).split('/').filter(Boolean).pop() || '';
  const img = imagePathKey(item.image);
  if (!slug || !img || slug.length < 10) return false;
  const tokens = slug.split('-').filter((t) => t.length > 4);
  if (tokens.length < 2) return false;
  return !tokens.some((t) => img.includes(t));
}

async function probeLeadReady(url, reject = [], opts = {}) {
  if (!url || !isCandidateImageUrl(url, reject) || isWeakImageUrl(url, opts)) return false;
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

async function tryUpgradeExistingImage(item, sourceMap = new Map()) {
  if (!item.image) return false;
  const { reject, opts } = isCandidateForItem(item, sourceMap);
  for (const candidate of leadImageUrlCandidates(item.image)) {
    if (!candidate || candidate === item.image) continue;
    if (!isCandidateImageUrl(candidate, reject) || isWeakImageUrl(candidate, opts)) continue;
    const dims = await probeRemoteImageSize(candidate);
    if (!dims || !meetsLeadDisplaySize(dims.width, dims.height)) continue;
    if (doUpdate) {
      item.image = candidate;
      item.leadImageReady = true;
      clearLegacyFallback(item);
      clearStockPhoto(item);
    }
    return true;
  }
  return false;
}

function applyPhotoFields(item, stock) {
  item.stockImage = stock.stockImage;
  item.imageTitle = stock.imageTitle || '';
  item.imageCredit = stock.imageCredit;
  item.imageCreator = stock.imageCreator || '';
  item.imageLicense = stock.imageLicense;
  item.imageProvider = stock.imageProvider;
  item.imageSourceUrl = stock.imageSourceUrl;
  clearLegacyFallback(item);
}

function isSubstackItem(item = {}) {
  return /substack\.com/i.test(String(item.link || ''));
}

/**
 * Photo libre thématique (Openverse / Commons) si le score est solide.
 * Sinon banque campus curatée — uniquement s'il n'y a PAS de photo source
 * affichable (sinon on écrase une photo de l'article, même imparfaite).
 *
 * Substack : la couverture og:image est la source de vérité ; on n'injecte
 * ni Openverse ni campus (c'est ce qui donnait des photos « toutes fausses »
 * pour The Concordian).
 */
async function applyStockPhoto(item, sourceMap = new Map(), { avoidCampusUrls = null } = {}) {
  if (await photoIsLeadReady(item)) return false;

  const hints = imageHintsFor(item, sourceMap);
  const allowFreeStock = hints.disableFreeStock !== true && !isSubstackItem(item);
  const allowCampus = hints.disableCampusBank !== true && !isSubstackItem(item);

  // Photo source déjà correcte pour vedette/feature : ne pas injecter de stock.
  if (item.image && hasSourcePhoto(item, sourceMap)) {
    for (const candidate of leadImageUrlCandidates(item.image)) {
      const dims = await probeRemoteImageSize(candidate);
      if (dims && meetsFeatureDisplaySize(dims.width, dims.height)) return false;
      // Vignette / panorama source : garder la photo de l'article, pas le campus.
      if (dims && dims.width >= 320 && dims.height >= 200) {
        if (!allowFreeStock) return false;
        const stock = await findStockPhoto(item);
        if (stock?.stockImage) {
          if (doUpdate) {
            applyPhotoFields(item, stock);
            item.leadImageReady = false;
          }
          return true;
        }
        return false;
      }
    }
  }

  // Avant toute banque libre : récupérer la photo d'article (RSS / og:image /
  // corps). Si la page n'offre qu'un défaut de site trop faible (logo Exil,
  // og:image partagée), on ne l'impose PAS — le stock thématique (ex. Hôtel
  // du Parlement pour un billet Assemblée) est préférable.
  let weakSiteImage = null;
  if ((!item.image || !hasSourcePhoto(item, sourceMap)) && item.link) {
    const { reject, opts } = isCandidateForItem(item, sourceMap);
    const resolved = await resolveLeadReadyPhoto(
      { ...item, image: hasSourcePhoto(item, sourceMap) ? item.image : '' },
      reject,
      opts,
    );
    if (resolved?.url && doUpdate) {
      if (resolved.leadReady !== false) {
        item.image = resolved.url;
        item.leadImageReady = true;
        clearLegacyFallback(item);
        clearStockPhoto(item);
        return false;
      }
      // leadReady false : retenir comme filet, mais essayer d'abord le stock
      weakSiteImage = resolved;
    }
  }

  if (allowFreeStock) {
    const stock = await findStockPhoto(item);
    if (stock?.stockImage) {
      if (doUpdate) {
        // Stock thématique gagne sur un défaut de site trop faible
        if (weakSiteImage) {
          item.image = '';
          item.leadImageReady = false;
        }
        applyPhotoFields(item, stock);
        const sourceReady = await markSourceLeadQuality(item);
        if (!sourceReady) item.leadImageReady = false;
      }
      return true;
    }
  }

  // Pas de stock : accepter l'image site faible (mieux que rien / campus)
  if (weakSiteImage?.url && doUpdate) {
    item.image = weakSiteImage.url;
    item.leadImageReady = false;
    clearLegacyFallback(item);
  }

  // Campus : seulement si aucune photo source utilisable et source non-Substack.
  if (item.image && hasSourcePhoto(item, sourceMap)) return false;
  if (!allowCampus) return false;

  const campus = pickCampusPhoto(item, {
    avoidUrls: avoidCampusUrls || [],
  });
  if (!campus?.stockImage) return false;
  if (doUpdate) {
    applyPhotoFields(item, campus);
    item.leadImageReady = false;
    if (avoidCampusUrls && campus.stockImage) avoidCampusUrls.add(campus.stockImage);
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
  const allItems = news.items || [];
  const sourceMap = loadSourceRegistryMap();
  const items = pruneToFreshWindow(allItems);
  items.forEach(backfillImageCreator);
  if (!items.length) {
    console.error('No items in news.json');
    process.exit(1);
  }

  let pageScraped = 0;
  let photosRecovered = 0;
  let stockFound = 0;
  let campusBankFound = 0;
  let stockSearches = 0;
  let imagesCleared = 0;
  const gaps = [];

  for (const item of items) {
    if (!shouldValidateImageOnPage(item, sourceMap)) continue;
    const { reject, opts } = isCandidateForItem(item, sourceMap);
    const html = await fetchText(item.link);
    if (!html || articleImageIsValidOnPage(html, item.image, reject, opts, item.link)) continue;
    if (doUpdate) {
      item.image = '';
      item.leadImageReady = false;
    }
    imagesCleared += 1;
    await sleep(120);
  }

  // Priorité : articles sans aucune photo (ex. Tribune RSS vide) d'abord,
  // les plus récents en tête — récupère les vraies og:image avant la banque.
  const scrapeQueue = items
    .filter((item) => {
      const { ok } = isCandidateForItem(item, sourceMap);
      return item.link && !ok(item.image);
    })
    .sort((a, b) => {
      const aEmpty = a.image || a.stockImage ? 1 : 0;
      const bEmpty = b.image || b.stockImage ? 1 : 0;
      if (aEmpty !== bEmpty) return aEmpty - bEmpty;
      return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
    })
    .slice(0, PAGE_SCRAPE_LIMIT);

  for (const item of scrapeQueue) {
    // Isolation par item : un scrape qui plante ne doit pas tuer la file.
    try {
      const { reject, opts } = isCandidateForItem(item, sourceMap);
      const resolved = await resolveLeadReadyPhoto(item, reject, opts);
      if (!resolved?.url) continue;
      pageScraped += 1;
      if (doUpdate) {
        item.image = resolved.url;
        item.leadImageReady = resolved.leadReady !== false;
        clearLegacyFallback(item);
        if (resolved.leadReady !== false) clearStockPhoto(item);
      }
      if (resolved.leadReady !== false) photosRecovered += 1;
    } catch (err) {
      console.warn(`  ⚠ scrape skip ${item.source}: ${(err && err.message) || err}`);
    }
    await sleep(200);
  }

  let upgraded = 0;
  for (const item of items) {
    if (await tryUpgradeExistingImage(item, sourceMap)) upgraded += 1;
  }
  if (upgraded) console.log(`↻ ${upgraded} image(s) WordPress passée(s) en pleine résolution`);

  let stockCleared = 0;
  for (const item of items) {
    if (!item.stockImage || stockStillFits(item)) continue;
    if (doUpdate) {
      clearStockPhoto(item);
      if (!item.image) item.leadImageReady = false;
    }
    stockCleared += 1;
  }
  if (stockCleared) console.log(`↻ ${stockCleared} photo(s) banque retirée(s) (hors-sujet)`);

  const stockQueue = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    // Isolation par item : un échec (scrape, probe, parse) ne doit pas avorter
    // la boucle et empêcher la phase banque/campus des items suivants. L'item
    // fautif reste éligible au repli campus (poussé dans la file).
    try {
      const { reject, opts, ok } = isCandidateForItem(item, sourceMap);

      // Image source déjà rejetée (logo Exil, Daily.png…) : la retirer pour
      // que le stock / campus prenne le relais sans être écrasé plus bas.
      if (doUpdate && item.image && !ok(item.image)) {
        item.image = '';
        item.leadImageReady = false;
        imagesCleared += 1;
      }

      if (await photoIsLeadReady(item)) {
        if (doUpdate) {
          // Ne retirer le stock QUE si la photo SOURCE seule est lead-ready.
          // Sinon (stock Assemblée + logo Exil) on effaçait le bon visuel.
          const sourceLead = item.image && ok(item.image) && await probeLeadReady(item.image);
          if (sourceLead) {
            clearStockPhoto(item);
          } else if (item.stockImage && item.image && !ok(item.image)) {
            item.image = '';
          }
          await markSourceLeadQuality(item);
          clearLegacyFallback(item);
        }
        continue;
      }

      if (!item.image || !ok(item.image)) {
        const resolved = await resolveLeadReadyPhoto(item, reject, opts);
        if (resolved?.url && doUpdate) {
          // leadReady : vraie photo → garder. Sinon défaut de site faible
          // (logo partagé) : ne pas l'imposer, laisser la file stock.
          if (resolved.leadReady !== false) {
            item.image = resolved.url;
            item.leadImageReady = true;
            clearLegacyFallback(item);
            clearStockPhoto(item);
            pageScraped += 1;
            photosRecovered += 1;
          } else {
            pageScraped += 1;
            // Ne pas écrire le logo faible dans item.image
          }
        }
        if (await photoIsLeadReady(item)) continue;
      } else if (hasSourcePhoto(item, sourceMap)) {
        const resolved = await resolveLeadReadyPhoto(item, reject, opts);
        if (resolved?.url && doUpdate) {
          const better = resolved.leadReady !== false
            || resolved.url !== item.image
            || !item.leadImageReady;
          if (better && resolved.leadReady !== false) {
            item.image = resolved.url;
            item.leadImageReady = true;
            clearLegacyFallback(item);
            // Une vraie photo d'article remplace toujours la banque campus / stock.
            clearStockPhoto(item);
            pageScraped += 1;
            photosRecovered += 1;
          } else if (better && resolved.leadReady === false && resolved.url !== item.image) {
            // Amélioration faible seulement si on n'a pas encore de stock thématique
            if (!item.stockImage || item.imageProvider === 'campus-bank') {
              item.image = resolved.url;
              item.leadImageReady = false;
              clearLegacyFallback(item);
              pageScraped += 1;
            }
          }
        }
        if (await photoIsLeadReady(item)) {
          if (doUpdate) {
            const sourceLead = item.image && ok(item.image) && await probeLeadReady(item.image);
            if (sourceLead) clearStockPhoto(item);
            clearLegacyFallback(item);
          }
          continue;
        }
      }

      stockQueue.push({ item, index });
    } catch (err) {
      console.error(`⚠ enrich ignoré (${item.source || '?'}): ${err.message}`);
      stockQueue.push({ item, index });
    }
  }

  stockQueue.sort((a, b) => {
    const aHero = a.index < HERO_PRIORITY_POOL ? 0 : 1;
    const bHero = b.index < HERO_PRIORITY_POOL ? 0 : 1;
    if (aHero !== bHero) return aHero - bHero;
    const aImg = a.item.image ? 1 : 0;
    const bImg = b.item.image ? 1 : 0;
    if (aImg !== bImg) return aImg - bImg;
    return (Date.parse(b.item.date) || 0) - (Date.parse(a.item.date) || 0);
  });

  // URLs campus déjà utilisées (y compris hors file d'attente) pour varier.
  const usedCampusUrls = new Set(
    items
      .filter((i) => i.imageProvider === 'campus-bank' && i.stockImage)
      .map((i) => i.stockImage),
  );

  for (const { item } of stockQueue.slice(0, STOCK_SEARCH_LIMIT)) {
    // Un item défaillant (URL, parse, réseau) ne doit jamais interrompre la
    // phase banque/campus et priver tous les suivants de leur photo.
    try {
      if (await photoIsLeadReady(item)) {
        if (doUpdate) clearLegacyFallback(item);
        continue;
      }

      stockSearches += 1;
      const beforeProvider = item.imageProvider;
      const found = await applyStockPhoto(item, sourceMap, { avoidCampusUrls: usedCampusUrls });
      if (found) {
        stockFound += 1;
        if (doUpdate && item.imageProvider === 'campus-bank') campusBankFound += 1;
        else if (!doUpdate && hasCampusBank(item.institution) && !beforeProvider) {
          // dry-run : comptage approximatif via pick
        }
      }
      if (await photoIsLeadReady(item)) continue;

      gaps.push({
        title: item.title,
        link: item.link,
        reason: found
          ? (item.imageProvider === 'campus-bank' ? 'campus-bank' : 'stock-too-small')
          : 'no-stock-match',
        image: item.image || item.stockImage || null,
      });
      await sleep(300);
    } catch (err) {
      console.error(`⚠ stock/campus ignoré (${item.source || '?'}): ${err.message}`);
    }
  }

  // Filet campus (local, sans réseau) : tout article encore sans visuel — y
  // compris ceux situés au-delà du plafond de recherche libre — rattaché à un
  // établissement de la banque reçoit une photo de campus. Garantit la règle
  // « mots-clés sans photo acceptable → photo du campus » pour l'ensemble
  // affiché, pas seulement les STOCK_SEARCH_LIMIT premiers.
  if (doUpdate) {
    let campusBackfill = 0;
    for (const item of items) {
      if (hasSourcePhoto(item, sourceMap)) continue;
      if (item.stockImage && isCandidateImageUrl(item.stockImage)) continue;
      const hints = imageHintsFor(item, sourceMap);
      if (hints.disableCampusBank === true || isSubstackItem(item)) continue;
      if (!hasCampusBank(item.institution)) continue;
      const campus = pickCampusPhoto(item, { avoidUrls: usedCampusUrls });
      if (!campus?.stockImage) continue;
      applyPhotoFields(item, campus);
      item.leadImageReady = false;
      usedCampusUrls.add(campus.stockImage);
      campusBankFound += 1;
      stockFound += 1;
      campusBackfill += 1;
    }
    if (campusBackfill) console.log(`↻ ${campusBackfill} photo(s) campus en repli (au-delà du plafond)`);
  }

  // Répartir les photos campus déjà en place (lot entier) pour éviter
  // la même entrée sur À la une et En bref d'un même établissement.
  if (doUpdate) {
    const diversified = diversifyCampusBankItems(items);
    if (diversified) console.log(`↻ ${diversified} photo(s) campus répartie(s) (variété)`);
  }

  // 2e chance banque libre (toutes sources) : articles encore sans visuel
  // après unicité campus — mots-clés titre/contenu via stock-photo-lib.
  if (doUpdate) {
    let freeRetry = 0;
    for (const item of items) {
      if (hasSourcePhoto(item, sourceMap)) continue;
      if (item.stockImage && isCandidateImageUrl(item.stockImage)) continue;
      if (isSubstackItem(item)) continue;
      const hints = imageHintsFor(item, sourceMap);
      if (hints.disableFreeStock === true) continue;
      try {
        const stock = await findStockPhoto(item);
        if (!stock?.stockImage) continue;
        applyPhotoFields(item, stock);
        item.leadImageReady = false;
        freeRetry += 1;
        stockFound += 1;
        await sleep(200);
      } catch (err) {
        console.warn(`⚠ free-retry skip ${item.source}: ${(err && err.message) || err}`);
      }
    }
    if (freeRetry) console.log(`↻ ${freeRetry} photo(s) libre(s) (2e chance, toutes sources)`);

    // Filet campus final pour ce qui reste vide (unicité).
    let campusFinal = 0;
    for (const item of items) {
      if (hasSourcePhoto(item, sourceMap)) continue;
      if (item.stockImage && isCandidateImageUrl(item.stockImage)) continue;
      const hints = imageHintsFor(item, sourceMap);
      if (hints.disableCampusBank === true || isSubstackItem(item)) continue;
      if (!hasCampusBank(item.institution)) continue;
      const campus = pickCampusPhoto(item, { avoidUrls: usedCampusUrls });
      if (!campus?.stockImage) continue;
      applyPhotoFields(item, campus);
      item.leadImageReady = false;
      usedCampusUrls.add(campus.stockImage);
      campusBankFound += 1;
      stockFound += 1;
      campusFinal += 1;
    }
    if (campusFinal) console.log(`↻ ${campusFinal} photo(s) campus (filet final)`);
  }

  const withPhoto = items.filter((i) => i.image && isCandidateImageUrl(i.image)).length;
  const withStock = items.filter((i) => i.stockImage && isCandidateImageUrl(i.stockImage)).length;
  const withCampus = items.filter((i) => i.imageProvider === 'campus-bank' && i.stockImage).length;
  const fullyCovered = items.filter((i) => hasUsableImage(i)).length;
  const leadReadyCount = (await Promise.all(items.map((i) => photoIsLeadReady(i)))).filter(Boolean).length;

  const qc = {
    updated: new Date().toISOString(),
    total: items.length,
    withPhoto,
    withStock,
    withCampusBank: withCampus,
    fullyCovered,
    leadReadyPhotos: leadReadyCount,
    pageScraped,
    photosRecovered,
    imagesCleared,
    stockSearches,
    stockFound,
    campusBankFound,
    mainPageLeadReady: leadReadyCount >= Math.min(HERO_MIN_POOL, items.length),
    gaps: gaps.slice(0, 12),
  };

  console.log('Lead image QC');
  console.log('==============');
  console.log(`Articles          : ${qc.total}`);
  console.log(`Photos source     : ${qc.withPhoto}`);
  console.log(`Photos banque     : ${qc.withStock} (dont campus curaté : ${withCampus})`);
  console.log(`Photos vedette OK : ${qc.leadReadyPhotos}`);
  console.log(`Pages scrapées    : ${qc.pageScraped}`);
  if (qc.imagesCleared) console.log(`Photos invalides  : ${qc.imagesCleared} retirée(s)`);
  console.log(`Banques consultées: ${qc.stockSearches}`);
  console.log(`Photos libres     : ${qc.stockFound - campusBankFound} + campus ${campusBankFound}`);
  console.log(`Couverture totale : ${qc.fullyCovered}/${qc.total}`);
  console.log('Crédits photo     : voir scripts/verify-photo-credits.js');

  if (gaps.length) {
    console.log('\nArticles sans visuel vedette :');
    gaps.slice(0, 5).forEach((g) => console.log(`  · ${g.title} — ${g.reason}`));
  }

  if (doUpdate) {
    fs.writeFileSync(NEWS_PATH, JSON.stringify({ ...news, items: allItems, count: allItems.length }, null, 2) + '\n');
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