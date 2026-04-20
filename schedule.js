import {
  DAY_SLUGS,
  cleanText,
  escapeHtml,
  fetchTextWithFallbacks,
  formatQuebecTimestamp,
  getQuebecDateInfo,
  toAbsoluteUrl,
  truncateText,
} from "./data-utils.js";

const SCHEDULE_URL = "https://chyz.ca/horaire/";
const SCHEDULE_CACHE_KEY = "chyz-plus-schedule-cache";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SCHEDULE_EVENT_NAME = "chyz:schedule-update";
const CARD_KICKERS = [
  "Emission precedente",
  "En cours",
  "A suivre",
  "Plus tard",
];

let refreshTimerId = null;
let lastFetchedAt = 0;

export function getCachedScheduleSnapshot() {
  return readCache();
}

export function initSchedulePanel() {
  const cards = getCards();
  const status = document.querySelector("#schedule-status");

  if (cards.length !== 4 || !status) {
    return;
  }

  const cachedSnapshot = readCache();
  if (cachedSnapshot) {
    renderSnapshot(cachedSnapshot, { cached: true });
  } else {
    renderLoadingState();
  }

  refreshSchedule();

  if (!refreshTimerId) {
    refreshTimerId = window.setInterval(refreshSchedule, REFRESH_INTERVAL_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastFetchedAt > REFRESH_INTERVAL_MS) {
      refreshSchedule();
    }
  });
}

async function refreshSchedule() {
  const status = document.querySelector("#schedule-status");

  try {
    if (status) {
      status.textContent = "Analyse de l'horaire…";
    }

    const html = await fetchTextWithFallbacks(SCHEDULE_URL, {
      accept: "text/html,application/xhtml+xml",
    });
    const timeline = parseScheduleHtml(html);
    const snapshot = buildSnapshot(timeline);

    if (!snapshot) {
      throw new Error("Unable to build schedule snapshot");
    }

    lastFetchedAt = Date.now();
    localStorage.setItem(SCHEDULE_CACHE_KEY, JSON.stringify(snapshot));
    renderSnapshot(snapshot, { cached: false });
  } catch (error) {
    console.warn("Schedule refresh failed.", error);
    const cachedSnapshot = readCache();

    if (cachedSnapshot) {
      renderSnapshot(cachedSnapshot, { cached: true });
      return;
    }

    renderErrorState();
  }
}

function parseScheduleHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  return [...doc.querySelectorAll(".article-horaire[data-jour-slug]")]
    .map((article, index) => {
      const daySlug = cleanText(article.getAttribute("data-jour-slug")).toLowerCase();
      const timeText = cleanText(article.querySelector(".container-heure p")?.textContent);
      const title = cleanText(article.querySelector("h3")?.textContent);
      const description = cleanText(article.querySelector(".container-infos p")?.textContent);
      const link = toAbsoluteUrl(article.getAttribute("href"), SCHEDULE_URL);
      const match = timeText.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
      const dayIndex = DAY_SLUGS.indexOf(daySlug);

      if (!match || dayIndex < 0 || !title) {
        return null;
      }

      const startMinute = parseTimeToMinute(match[1]);
      const endMinute = parseTimeToMinute(match[2]);
      const startWeekMinute = dayIndex * 1440 + startMinute;
      const endWeekMinute =
        dayIndex * 1440 + endMinute + (endMinute <= startMinute ? 1440 : 0);

      return {
        id: `${daySlug}-${match[1]}-${title}-${index}`,
        daySlug,
        dayIndex,
        domIndex: index,
        startWeekMinute,
        endWeekMinute,
        timeLabel: `${capitalize(daySlug)} • ${match[1]} - ${match[2]}`,
        title,
        description,
        link,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      return (
        left.startWeekMinute - right.startWeekMinute ||
        left.endWeekMinute - right.endWeekMinute ||
        left.domIndex - right.domIndex
      );
    });
}

function buildSnapshot(timeline) {
  if (timeline.length === 0) {
    return null;
  }

  const nowInfo = getQuebecDateInfo();
  const expandedTimeline = [
    ...timeline.map((slot) => ({ ...slot })),
    ...timeline.map((slot) => ({
      ...slot,
      startWeekMinute: slot.startWeekMinute - 7 * 1440,
      endWeekMinute: slot.endWeekMinute - 7 * 1440,
    })),
    ...timeline.map((slot) => ({
      ...slot,
      startWeekMinute: slot.startWeekMinute + 7 * 1440,
      endWeekMinute: slot.endWeekMinute + 7 * 1440,
    })),
  ].sort((left, right) => {
    return (
      left.startWeekMinute - right.startWeekMinute ||
      left.endWeekMinute - right.endWeekMinute ||
      left.domIndex - right.domIndex
    );
  });

  const currentCandidates = expandedTimeline.filter(
    (slot) => slot.startWeekMinute <= nowInfo.weekMinute && slot.endWeekMinute > nowInfo.weekMinute
  );
  const current =
    currentCandidates.sort((left, right) => {
      return (
        right.startWeekMinute - left.startWeekMinute ||
        left.endWeekMinute - right.endWeekMinute ||
        right.domIndex - left.domIndex
      );
    })[0] ?? null;
  const previous =
    [...expandedTimeline]
      .filter((slot) => slot.endWeekMinute <= nowInfo.weekMinute)
      .sort((left, right) => right.endWeekMinute - left.endWeekMinute || right.domIndex - left.domIndex)[0] ??
    null;
  const nextCandidates = expandedTimeline
    .filter((slot) => slot.startWeekMinute > nowInfo.weekMinute)
    .sort((left, right) => left.startWeekMinute - right.startWeekMinute || left.domIndex - right.domIndex);

  return {
    fetchedAt: new Date().toISOString(),
    previous: serializeSlot(previous),
    current: serializeSlot(
      current ?? {
        title: "CHYZ 94.3 FM en continu",
        description:
          "Aucune case precise ne correspond a cette minute dans l'horaire public. Le flux reste en direct.",
        timeLabel: `Maintenant • ${formatQuebecTimestamp()}`,
        link: SCHEDULE_URL,
      }
    ),
    next: serializeSlot(nextCandidates[0] ?? null),
    afterNext: serializeSlot(nextCandidates[1] ?? null),
  };
}

function renderSnapshot(snapshot, options = { cached: false }) {
  const cards = getCards();
  const status = document.querySelector("#schedule-status");
  const slots = [snapshot.previous, snapshot.current, snapshot.next, snapshot.afterNext];

  cards.forEach((card, index) => {
    const slot = slots[index];
    const fallbackTitle = index === 1 ? "CHYZ 94.3 FM en direct" : "Aucune case";
    const fallbackDescription =
      index === 1
        ? "Le flux reste accessible meme si l'horaire est temporairement indisponible."
        : "L'horaire public n'expose pas de case supplementaire pour ce moment.";

    card.classList.toggle("schedule-card--current", index === 1);
    card.innerHTML = `
      <p class="schedule-card__kicker">${CARD_KICKERS[index]}</p>
      <p class="schedule-card__time">${escapeHtml(slot?.timeLabel || "Horaire indisponible")}</p>
      <h3 class="schedule-card__title">${escapeHtml(slot?.title || fallbackTitle)}</h3>
      <p class="schedule-card__meta">${escapeHtml(slot?.description || fallbackDescription)}</p>
      ${
        slot?.link
          ? `<a class="schedule-card__link" href="${escapeHtml(slot.link)}" target="_blank" rel="noreferrer">Voir l'emission</a>`
          : ""
      }
    `;
  });

  if (status) {
    status.textContent = `${options.cached ? "Cache" : "Mis a jour"} • ${formatQuebecTimestamp(
      new Date(snapshot.fetchedAt)
    )}`;
  }

  publishScheduleUpdate(snapshot);
}

function renderLoadingState() {
  const cards = getCards();
  const status = document.querySelector("#schedule-status");

  cards.forEach((card, index) => {
    card.classList.toggle("schedule-card--current", index === 1);
    card.innerHTML = `
      <p class="schedule-card__kicker">${CARD_KICKERS[index]}</p>
      <p class="schedule-card__time">Chargement…</p>
      <h3 class="schedule-card__title">${index === 1 ? "Recherche du direct" : "Preparation"}</h3>
      <p class="schedule-card__meta">Lecture de l'horaire CHYZ et calcul des emissions autour de l'heure actuelle.</p>
    `;
  });

  if (status) {
    status.textContent = "Connexion a CHYZ…";
  }
}

function renderErrorState() {
  const cards = getCards();
  const status = document.querySelector("#schedule-status");

  cards.forEach((card, index) => {
    card.classList.toggle("schedule-card--current", index === 1);
    card.innerHTML = `
      <p class="schedule-card__kicker">${CARD_KICKERS[index]}</p>
      <p class="schedule-card__time">Indisponible</p>
      <h3 class="schedule-card__title">${index === 1 ? "CHYZ 94.3 FM en direct" : "Horaire indisponible"}</h3>
      <p class="schedule-card__meta">Impossible de joindre la grille horaire pour le moment. Le lecteur radio reste utilisable.</p>
      <a class="schedule-card__link" href="${SCHEDULE_URL}" target="_blank" rel="noreferrer">Ouvrir l'horaire officiel</a>
    `;
  });

  if (status) {
    status.textContent = "Horaire hors ligne";
  }

  publishScheduleUpdate(null);
}

function readCache() {
  const raw = localStorage.getItem(SCHEDULE_CACHE_KEY);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("Unable to parse cached schedule.", error);
    return null;
  }
}

function getCards() {
  return [...document.querySelectorAll("#schedule-grid .schedule-card")];
}

function parseTimeToMinute(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function serializeSlot(slot) {
  if (!slot) {
    return null;
  }

  return {
    title: slot.title,
    description: truncateText(slot.description, 160),
    timeLabel: slot.timeLabel,
    link: slot.link || SCHEDULE_URL,
  };
}

function capitalize(value) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : "";
}

function publishScheduleUpdate(snapshot) {
  window.dispatchEvent(
    new CustomEvent(SCHEDULE_EVENT_NAME, {
      detail: snapshot,
    })
  );
}
