const CACHE_NAME = "radar-shell-v248";
const APP_SHELL = [
  "./",
  "./index.html",
  "./feeds.html",
  "./feeds-page.js",
  "./style.css",
  "./mobile-playback.js",
  "./app.js",
  "./cast.js",
  "./brand-colors.json",
  "./radios.json",
  "./manifest.json",
  "./assets/icon.svg",
  "./assets/icon-32.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.origin !== self.location.origin) return;
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

const CACHEABLE_TYPES = /^(text\/html|text\/css|application\/javascript|text\/javascript|application\/json|image\/|font\/|application\/manifest\+json)/i;
const CACHEABLE_EXT = /\.(html?|css|js|json|png|svg|ico|webmanifest|xml|woff2?)$/i;

function isCacheableResponse(response, request) {
  if (!response || !response.ok) return false;
  const type = response.headers.get("content-type") || "";
  if (CACHEABLE_TYPES.test(type)) return true;
  try {
    return CACHEABLE_EXT.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

function cacheIfOk(cache, request, response) {
  if (isCacheableResponse(response, request)) {
    cache.put(request, response.clone());
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cacheIfOk(cache, request, clone));
          return networkResponse;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Network-first for HTML shell so masthead/UI updates reach users promptly.
  if (url.pathname.endsWith(".html")) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cacheIfOk(cache, request, clone));
          return networkResponse;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Network-first for app code so bugfixes reach users without stale cache.
  if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cacheIfOk(cache, request, clone));
          return networkResponse;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Network-first for live data (news.json, radios.json) so content stays fresh.
  if (url.pathname.endsWith(".json")) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cacheIfOk(cache, request, clone));
          return networkResponse;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then((networkResponse) => {
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cacheIfOk(cache, request, responseClone));
        return networkResponse;
      });
    })
  );
});
