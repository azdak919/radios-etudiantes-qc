/**
 * Source retention — shared rules for all RADAR news bots.
 *
 * Aligns server-side aggregation with the UI freshness window (3 university
 * sessions). Prevents transient RSS failures from wiping a source entirely.
 *
 * Registry field `botHints` (optional, per source in news-sources.json):
 *   { "fetch": {}, "authors": {}, "images": {}, "excerpts": {}, "credits": {} }
 */

const fs = require('fs');
const path = require('path');

/** Same window as app.js FRESHNESS_SESSION_COUNT / CONTINGENCY_MAX_SESSIONS_BACK */
const FRESHNESS_SESSION_COUNT = 3;
const CONTINGENCY_MAX_SESSIONS_BACK = FRESHNESS_SESSION_COUNT - 1;

const NEWS_PATH = path.join(__dirname, '..', 'news.json');
const SOURCES_PATH = path.join(__dirname, '..', 'news-sources.json');

// === University session calendar (Québec) ====================================

function getCurrentUniversitySessionStart(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();
  if (month >= 8) return new Date(year, 8, 1);
  if (month >= 4) return new Date(year, 4, 1);
  return new Date(year, 0, 1);
}

function getPriorUniversitySessionStart(sessionStart) {
  const year = sessionStart.getFullYear();
  const month = sessionStart.getMonth();
  if (month === 8) return new Date(year, 4, 1);
  if (month === 4) return new Date(year, 0, 1);
  return new Date(year - 1, 8, 1);
}

function getUniversitySessionStart(referenceDate = new Date(), sessionsBack = 0) {
  let start = getCurrentUniversitySessionStart(referenceDate);
  for (let i = 0; i < sessionsBack; i++) {
    start = getPriorUniversitySessionStart(start);
  }
  return start;
}

function getUniversitySessionBand(referenceDate = new Date(), sessionsBack = 0) {
  const start = getUniversitySessionStart(referenceDate, sessionsBack);
  const end = sessionsBack === 0
    ? referenceDate
    : new Date(getUniversitySessionStart(referenceDate, sessionsBack - 1).getTime() - 1);
  return { start, end };
}

function isPublishedOnOrBefore(item, referenceDate = new Date()) {
  const published = new Date(item.date || 0);
  return Number.isFinite(published.getTime()) && published.getTime() <= referenceDate.getTime();
}

function isWithinUniversitySessionBand(item, referenceDate = new Date(), sessionsBack = 0) {
  const published = new Date(item.date || 0);
  if (!Number.isFinite(published.getTime())) return false;
  const { start, end } = getUniversitySessionBand(referenceDate, sessionsBack);
  const t = published.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function isWithinFreshnessWindow(item, referenceDate = new Date()) {
  if (!isPublishedOnOrBefore(item, referenceDate)) return false;
  for (let band = 0; band <= CONTINGENCY_MAX_SESSIONS_BACK; band++) {
    if (isWithinUniversitySessionBand(item, referenceDate, band)) return true;
  }
  return false;
}

function filterFreshItems(items, referenceDate = new Date()) {
  return items.filter((item) => isWithinFreshnessWindow(item, referenceDate));
}

/** Oldest session start still inside the freshness window (for expiry checks). */
function freshnessWindowStart(referenceDate = new Date()) {
  return getUniversitySessionStart(referenceDate, CONTINGENCY_MAX_SESSIONS_BACK);
}

// === Article / source grouping ===============================================

function groupItemsBySource(items = []) {
  const map = new Map();
  for (const item of items) {
    const src = item.source || '';
    if (!src) continue;
    if (!map.has(src)) map.set(src, []);
    map.get(src).push(item);
  }
  return map;
}

function latestItemDate(items = []) {
  let best = 0;
  for (const item of items) {
    const t = Date.parse(item.date || '');
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best ? new Date(best).toISOString() : null;
}

function sourceHasFreshContent(items = [], referenceDate = new Date()) {
  return filterFreshItems(items, referenceDate).length > 0;
}

function retainablePriorArticles(priorItems = [], referenceDate = new Date()) {
  return filterFreshItems(priorItems, referenceDate);
}

/**
 * Strip source-level fields so cached rows can be re-wrapped by fetch-news.
 */
function articlePayloadFromPrior(item) {
  const {
    source,
    institution,
    region,
    type,
    lang,
    _retainedFromCache,
    ...rest
  } = item;
  return rest;
}

function markRetainedArticles(items) {
  return items.map((item) => ({
    ...articlePayloadFromPrior(item),
    _retainedFromCache: true,
  }));
}

// === Registry / news.json helpers ============================================

function readNewsItems() {
  try {
    const data = JSON.parse(fs.readFileSync(NEWS_PATH, 'utf8'));
    return data.items || [];
  } catch {
    return [];
  }
}

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  } catch {
    return { active: [], candidates: [] };
  }
}

function writeRegistry(registry) {
  fs.writeFileSync(SOURCES_PATH, JSON.stringify(registry, null, 2) + '\n');
}

function findRegistrySource(registry, name) {
  return (registry.active || []).find((s) => s.name === name) || null;
}

/**
 * Per-bot instructions from news-sources.json → botHints.<bot>.
 * Example:
 *   "botHints": {
 *     "authors": { "verifyPage": true },
 *     "images": { "rejectPathPatterns": ["lapige_web"] }
 *   }
 */
function getBotHints(src = {}, bot = '') {
  if (!src || !bot) return {};
  const hints = src.botHints;
  if (!hints || typeof hints !== 'object') return {};
  const block = hints[bot];
  return block && typeof block === 'object' ? block : {};
}

/**
 * Whether a source may be dropped from news.json / marked dead.
 * Requires no fresh articles in cache AND no fresh _lastItemDate in registry.
 */
function shouldDropSource({
  sourceName,
  priorItems = [],
  registryEntry = null,
  referenceDate = new Date(),
}) {
  const freshPrior = retainablePriorArticles(priorItems, referenceDate);
  if (freshPrior.length > 0) return false;

  const lastRegistry = registryEntry?._lastItemDate;
  if (lastRegistry) {
    const t = Date.parse(lastRegistry);
    if (Number.isFinite(t) && t >= freshnessWindowStart(referenceDate).getTime()) {
      return false;
    }
  }

  return true;
}

/**
 * Update registry entry after a fetch-news run for one source.
 */
function applyFetchRegistryUpdate(src, {
  fetchOk = false,
  usedStaleCache = false,
  items = [],
  referenceDate = new Date(),
}) {
  if (!src) return;
  src._lastChecked = new Date().toISOString();

  const lastArticle = latestItemDate(items);
  if (lastArticle) src._lastItemDate = lastArticle;

  if (fetchOk && !usedStaleCache) {
    src._failCount = 0;
    src._lastFetchOk = src._lastChecked;
    if (src._status === 'dead') src._status = 'ok';
    return;
  }

  if (usedStaleCache) {
    src._failCount = (src._failCount || 0) + 1;
    src._status = 'stale';
    return;
  }

  src._failCount = (src._failCount || 0) + 1;
  const fresh = sourceHasFreshContent(items, referenceDate);
  if (!fresh && src._failCount >= 4) {
    src._status = 'dead';
  } else if (src._status !== 'dead') {
    src._status = fresh ? 'ok' : 'stale';
  }
}

const DAY_MS = 86400000;
const OK_DAYS = 270;

/** Classify a feed by latest item date using the 3-session UI window. */
function classifyFeedFreshness(lastItemMs, referenceDate = new Date()) {
  if (lastItemMs == null || !Number.isFinite(lastItemMs)) {
    return { status: 'stale', lastItemDate: null };
  }
  const windowStart = freshnessWindowStart(referenceDate).getTime();
  let status = 'ok';
  if (lastItemMs < windowStart) status = 'dead';
  else if ((referenceDate.getTime() - lastItemMs) / DAY_MS > OK_DAYS) status = 'stale';
  return { status, lastItemDate: new Date(lastItemMs).toISOString() };
}

function buildSourceRunMeta({
  sourceName,
  fetchOk,
  usedStaleCache,
  items = [],
  referenceDate = new Date(),
}) {
  const freshCount = filterFreshItems(items, referenceDate).length;
  return {
    fetchOk,
    stale: usedStaleCache,
    articleCount: items.length,
    freshArticleCount: freshCount,
    lastArticle: latestItemDate(items),
    lastFetchOk: fetchOk && !usedStaleCache ? new Date().toISOString() : null,
  };
}

module.exports = {
  FRESHNESS_SESSION_COUNT,
  CONTINGENCY_MAX_SESSIONS_BACK,
  freshnessWindowStart,
  getCurrentUniversitySessionStart,
  getUniversitySessionStart,
  getUniversitySessionBand,
  isWithinFreshnessWindow,
  isWithinUniversitySessionBand,
  filterFreshItems,
  groupItemsBySource,
  latestItemDate,
  sourceHasFreshContent,
  retainablePriorArticles,
  markRetainedArticles,
  articlePayloadFromPrior,
  readNewsItems,
  readRegistry,
  writeRegistry,
  findRegistrySource,
  getBotHints,
  shouldDropSource,
  applyFetchRegistryUpdate,
  buildSourceRunMeta,
  classifyFeedFreshness,
  OK_DAYS,
};