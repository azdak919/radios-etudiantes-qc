export const QUEBEC_TIME_ZONE = "America/Toronto";
export const DAY_SLUGS = [
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
  "dimanche",
];

const FETCH_TIMEOUT_MS = 12_000;
const PROXY_BUILDERS = [
  (url) => url,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

const weekdayFormatter = new Intl.DateTimeFormat("fr-CA", {
  timeZone: QUEBEC_TIME_ZONE,
  weekday: "long",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const shortTimeFormatter = new Intl.DateTimeFormat("fr-CA", {
  timeZone: QUEBEC_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const longDateFormatter = new Intl.DateTimeFormat("fr-CA", {
  timeZone: QUEBEC_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export async function fetchTextWithFallbacks(url, options = {}) {
  const headers = options.accept ? { Accept: options.accept } : {};
  let lastError = null;

  for (const buildUrl of PROXY_BUILDERS) {
    const requestUrl = buildUrl(url);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(requestUrl, {
        cache: "no-store",
        headers,
        mode: "cors",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();

      if (!text.trim()) {
        throw new Error("Empty response body");
      }

      window.clearTimeout(timeoutId);
      return text;
    } catch (error) {
      window.clearTimeout(timeoutId);
      lastError = error;
    }
  }

  throw lastError ?? new Error(`Unable to fetch ${url}`);
}

export async function fetchJsonWithFallbacks(url, options = {}) {
  const text = await fetchTextWithFallbacks(url, {
    ...options,
    accept: "application/json, text/plain, */*",
  });

  return JSON.parse(text);
}

export function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function toAbsoluteUrl(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return "";
  }
}

export function truncateText(value, length = 160) {
  const text = cleanText(value);
  if (text.length <= length) {
    return text;
  }

  return `${text.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

export function getQuebecDateInfo(date = new Date()) {
  const parts = Object.fromEntries(
    weekdayFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const daySlug = cleanText(parts.weekday).toLowerCase();
  const dayIndex = DAY_SLUGS.indexOf(daySlug);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);

  return {
    daySlug,
    dayIndex,
    hour,
    minute,
    weekMinute: Math.max(0, dayIndex) * 1440 + hour * 60 + minute,
    label: formatQuebecTimestamp(date),
  };
}

export function formatQuebecTimestamp(date = new Date()) {
  return shortTimeFormatter.format(date).replace(":", " h ");
}

export function formatQuebecDateTime(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return longDateFormatter.format(date);
}

export function htmlToText(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html ?? "", "text/html");
  return cleanText(doc.body.textContent);
}

export function extractFirstImageFromHtml(html, baseUrl = "") {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html ?? "", "text/html");
  const source = doc.querySelector("img")?.getAttribute("src");

  return source ? toAbsoluteUrl(source, baseUrl) : "";
}

export function parseFeedDate(dateString) {
  if (!dateString) {
    return null;
  }

  const parsed = new Date(dateString);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
