/* ═══════════════════════════════════════════════════════
   Pomodoro (Le Radar) — Service Worker
   Scope: /pomo/ only — isolated from root radar SW and solitaire.
   Strategy:
     • App shell (HTML, icons, manifest)  → stale-while-revalidate
     • Google Fonts CSS + WOFF2 files     → cache-first
     • External background images         → network-only
     • Anything else same-origin under scope → stale-while-revalidate
   ═══════════════════════════════════════════════════════ */

const SHELL_CACHE  = 'pomo-shell-v44';
const FONT_CACHE   = 'pomo-fonts-v25';
const CACHE_PREFIX = 'pomo-';
const KNOWN_CACHES = [SHELL_CACHE, FONT_CACHE];

const IMAGE_CDN_HOSTS = new Set([
  'images.unsplash.com',
  'source.unsplash.com',
  'upload.wikimedia.org',
  'commons.wikimedia.org',
  'images.pexels.com',
]);

const SHELL_ASSETS = [
  './',
  './index.html',
  './site.webmanifest',
  './favicon.svg',
  './favicon.ico',
  './favicon-16x16.png',
  './favicon-32x32.png',
  './favicon-96x96.png',
  './favicon-128x128.png',
  './apple-touch-icon.png',
  './apple-touch-icon-120x120.png',
  './apple-touch-icon-152x152.png',
  './apple-touch-icon-180x180.png',
  './icon-192.png',
  './icon-192-maskable.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './browserconfig.xml',
  './sw.js',
  './styles/base.css',
  './styles/layout.css',
  './js/storage.js',
  './js/backgrounds-data.js',
  './js/backgrounds.js',
  './js/quotes-data.js',
  './js/quotes-i18n.js',
  './js/quotes-expansion.js',
  './js/quotes.js',
  './js/toast.js',
  './js/pomo-audio.js',
  './js/pomo.js',
  './js/translate.js',
  './js/layout.js',
  './js/panels.js',
  './js/app.js',
  './js/weather.js',
  '../translate-menu.js',
  '../translate-menu.css',
  '../indigenous-mt.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            // Only purge our own caches — never touch radar-* or solitaire-*
            .filter((k) => k.startsWith(CACHE_PREFIX) && !KNOWN_CACHES.includes(k))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(cacheFirst(FONT_CACHE, request));
    return;
  }

  if (IMAGE_CDN_HOSTS.has(url.hostname)) {
    return;
  }

  const sharedTranslationAsset = /\/(?:translate-menu\.(?:js|css)|indigenous-mt\.json)$/.test(url.pathname);
  // Le module de langue vit à la racine, mais appartient aussi au shell hors ligne.
  if (url.origin === self.location.origin && (url.pathname.includes('/pomo/') || sharedTranslationAsset)) {
    event.respondWith(staleWhileRevalidate(SHELL_CACHE, request));
  }
});

const CACHEABLE_TYPES = /^(text\/html|text\/css|application\/javascript|text\/javascript|application\/json|image\/|font\/|application\/manifest\+json)/i;
const CACHEABLE_EXT = /\.(html?|css|js|json|png|jpe?g|svg|ico|webmanifest|xml|woff2?)$/i;

function isCacheableResponse(response, request) {
  if (!response || !response.ok) return false;
  const type = response.headers.get('content-type') || '';
  if (CACHEABLE_TYPES.test(type)) return true;
  try {
    return CACHEABLE_EXT.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

async function cacheFirst(cacheName, request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheableResponse(response, request)) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(cacheName, request) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request).then((response) => {
    if (isCacheableResponse(response, request)) {
      cache.put(request, response.clone());
      return response;
    }
    return cached || response;
  }).catch(() => cached || new Response('Service unavailable', { status: 503 }));

  return cached || networkFetch;
}
