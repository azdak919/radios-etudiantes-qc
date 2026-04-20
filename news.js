import {
  cleanText,
  escapeHtml,
  extractFirstImageFromHtml,
  fetchTextWithFallbacks,
  formatQuebecDateTime,
  formatQuebecTimestamp,
  htmlToText,
  parseFeedDate,
  toAbsoluteUrl,
  truncateText,
} from "./data-utils.js";

const PRIMARY_NEWS_URL = "https://nouvelles.ulaval.ca/";
const NEWS_CACHE_KEY = "chyz-plus-news-cache";
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

const ASSOCIATION_FEEDS = [
  { name: "AELIES", url: "https://www.aelies.ulaval.ca/feed/" },
  { name: "AEGSEG", url: "https://aegseg.asso.ulaval.ca/feed/" },
  { name: "AEC", url: "https://www.aec.asso.ulaval.ca/feed/" },
  { name: "ACCESE", url: "https://www.accese.asso.ulaval.ca/feed/" },
  { name: "AEEPCPUL", url: "https://www.aeepcpul.ca/feed/" },
  { name: "APETUL", url: "https://www.apetul.asso.ulaval.ca/feed/" },
];

let refreshTimerId = null;
let lastFetchedAt = 0;

export function initNewsFeed() {
  const status = document.querySelector("#news-status");
  const feed = document.querySelector("#news-feed");

  if (!status || !feed) {
    return;
  }

  const cachedSnapshot = readCache();
  if (cachedSnapshot?.items?.length) {
    renderNewsSnapshot(cachedSnapshot, { cached: true });
  } else {
    renderLoadingState();
  }

  refreshNews();

  if (!refreshTimerId) {
    refreshTimerId = window.setInterval(refreshNews, REFRESH_INTERVAL_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastFetchedAt > REFRESH_INTERVAL_MS) {
      refreshNews();
    }
  });
}

async function refreshNews() {
  const status = document.querySelector("#news-status");

  try {
    if (status) {
      status.textContent = "Lecture des sources…";
    }

    const results = await Promise.allSettled([
      fetchPrimaryStories(),
      ...ASSOCIATION_FEEDS.map((source) => fetchAssociationFeed(source)),
    ]);
    const merged = selectStories(
      results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    );

    if (merged.length === 0) {
      throw new Error("No stories available");
    }

    const snapshot = {
      fetchedAt: new Date().toISOString(),
      items: merged,
    };

    lastFetchedAt = Date.now();
    localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify(snapshot));
    renderNewsSnapshot(snapshot, { cached: false });
  } catch (error) {
    console.warn("News refresh failed.", error);
    const cachedSnapshot = readCache();

    if (cachedSnapshot?.items?.length) {
      renderNewsSnapshot(cachedSnapshot, { cached: true });
      return;
    }

    renderErrorState();
  }
}

async function fetchPrimaryStories() {
  const html = await fetchTextWithFallbacks(PRIMARY_NEWS_URL, {
    accept: "text/html,application/xhtml+xml",
  });
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  return [...doc.querySelectorAll("article a[href^='/']")]
    .slice(0, 12)
    .map((anchor) => {
      const relativeUrl = anchor.getAttribute("href");
      const absoluteUrl = toAbsoluteUrl(relativeUrl, PRIMARY_NEWS_URL);
      const title = cleanText(anchor.querySelector("h2")?.textContent);
      const excerpt = cleanText(anchor.querySelector("section p.text-sm")?.textContent);
      const image = toAbsoluteUrl(anchor.querySelector("img")?.getAttribute("src"), PRIMARY_NEWS_URL);
      const publishedAt = parsePrimaryDate(relativeUrl);

      if (!title || !absoluteUrl) {
        return null;
      }

      return {
        id: absoluteUrl,
        sourceName: "ULaval Nouvelles",
        sourceType: "primary",
        title,
        excerpt: truncateText(excerpt, 170),
        image,
        link: absoluteUrl,
        publishedAt: publishedAt?.toISOString() ?? "",
        publishedLabel: publishedAt ? formatQuebecDateTime(publishedAt) : "",
      };
    })
    .filter(Boolean);
}

async function fetchAssociationFeed(source) {
  const xml = await fetchTextWithFallbacks(source.url, {
    accept: "application/rss+xml, application/xml, text/xml",
  });
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");

  if (doc.querySelector("parsererror")) {
    throw new Error(`Invalid XML for ${source.name}`);
  }

  const channelTitle = cleanText(doc.querySelector("channel > title")?.textContent) || source.name;

  return [...doc.querySelectorAll("item")]
    .slice(0, 6)
    .map((item) => {
      const title = cleanText(item.querySelector("title")?.textContent);
      const link = cleanText(item.querySelector("link")?.textContent);
      const descriptionHtml =
        item.querySelector("content\\:encoded")?.textContent ||
        item.querySelector("description")?.textContent ||
        "";
      const excerpt = truncateText(htmlToText(descriptionHtml), 170);
      const image =
        cleanText(item.querySelector("enclosure")?.getAttribute("url")) ||
        cleanText(item.querySelector("media\\:content")?.getAttribute("url")) ||
        extractFirstImageFromHtml(descriptionHtml, link);
      const publishedAt = parseFeedDate(item.querySelector("pubDate")?.textContent);

      if (!title || !link) {
        return null;
      }

      return {
        id: `${channelTitle}-${link}`,
        sourceName: channelTitle,
        sourceType: "secondary",
        title,
        excerpt,
        image: toAbsoluteUrl(image, link),
        link,
        publishedAt: publishedAt?.toISOString() ?? "",
        publishedLabel: publishedAt ? formatQuebecDateTime(publishedAt) : "",
      };
    })
    .filter(Boolean);
}

function selectStories(stories) {
  const deduped = [];
  const seen = new Set();

  for (const story of stories) {
    const key = story.link || story.id;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(story);
  }

  const sourceCounts = new Map();
  const selected = [];
  const sorted = deduped.sort((left, right) => {
    const leftDate = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const rightDate = right.publishedAt ? Date.parse(right.publishedAt) : 0;

    if (rightDate !== leftDate) {
      return rightDate - leftDate;
    }

    if (left.sourceType !== right.sourceType) {
      return left.sourceType === "primary" ? -1 : 1;
    }

    return left.title.localeCompare(right.title, "fr");
  });

  for (const story of sorted) {
    const count = sourceCounts.get(story.sourceName) ?? 0;
    const cap = story.sourceType === "primary" ? 4 : 2;

    if (count >= cap) {
      continue;
    }

    sourceCounts.set(story.sourceName, count + 1);
    selected.push(story);

    if (selected.length === 12) {
      break;
    }
  }

  return selected;
}

function renderNewsSnapshot(snapshot, options = { cached: false }) {
  const feed = document.querySelector("#news-feed");
  const status = document.querySelector("#news-status");

  if (!feed || !status) {
    return;
  }

  feed.dataset.ready = "true";
  feed.innerHTML = snapshot.items
    .map((item) => {
      const imageMarkup = item.image
        ? `
          <div class="news-card__thumb-wrap">
            <img class="news-card__image" src="${escapeHtml(item.image)}" alt="${escapeHtml(
            item.title
          )}" loading="lazy" />
          </div>
        `
        : `<div class="news-card__thumb"></div>`;

      return `
        <article class="news-card ${item.image ? "" : "news-card--ghost"}">
          ${imageMarkup}
          <div class="news-card__body">
            <p class="news-card__source">${escapeHtml(item.sourceName)}</p>
            <h3 class="news-card__title">${escapeHtml(item.title)}</h3>
            <p class="news-card__excerpt">${escapeHtml(
              item.excerpt || "Consulte la publication complete sur la source d'origine."
            )}</p>
            <p class="news-card__meta">${escapeHtml(item.publishedLabel || "Publication recente")}</p>
            <a class="news-card__link" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">Lire plus</a>
          </div>
        </article>
      `;
    })
    .join("");

  status.textContent = `${options.cached ? "Cache" : "Mis a jour"} • ${formatQuebecTimestamp(
    new Date(snapshot.fetchedAt)
  )}`;
}

function renderLoadingState() {
  const feed = document.querySelector("#news-feed");
  const status = document.querySelector("#news-status");

  if (!feed || !status) {
    return;
  }

  status.textContent = "Connexion aux sources…";
  feed.dataset.ready = "false";
  feed.innerHTML = `
    <article class="news-card">
      <div class="news-card__thumb"></div>
      <div class="news-card__body">
        <p class="news-card__source">ULaval Nouvelles</p>
        <h3 class="news-card__title">Preparation du fil campus</h3>
        <p class="news-card__excerpt">Scraping de la une ULaval et agregation des flux associatifs verifies.</p>
        <span class="news-card__link">Chargement…</span>
      </div>
    </article>
  `;
}

function renderErrorState() {
  const feed = document.querySelector("#news-feed");
  const status = document.querySelector("#news-status");

  if (!feed || !status) {
    return;
  }

  status.textContent = "Nouvelles hors ligne";
  feed.dataset.ready = "false";
  feed.innerHTML = `
    <article class="news-card">
      <div class="news-card__thumb"></div>
      <div class="news-card__body">
        <p class="news-card__source">Sources externes</p>
        <h3 class="news-card__title">Impossible de charger les articles en ce moment</h3>
        <p class="news-card__excerpt">Les sources campus n'ont pas repondu. Reessaie plus tard ou ouvre ULaval Nouvelles directement.</p>
        <a class="news-card__link" href="${PRIMARY_NEWS_URL}" target="_blank" rel="noreferrer">Ouvrir ULaval Nouvelles</a>
      </div>
    </article>
  `;
}

function readCache() {
  const raw = localStorage.getItem(NEWS_CACHE_KEY);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("Unable to parse cached news.", error);
    return null;
  }
}

function parsePrimaryDate(url) {
  const match = String(url).match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);

  if (!match) {
    return null;
  }

  return new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00-04:00`);
}
