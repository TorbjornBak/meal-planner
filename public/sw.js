/*
 * MealPlanner service worker — on-device offline caching.
 *
 * Strategy:
 *  - Hashed static assets (/_next/static, icons): cache-first. They never change
 *    under a given URL, so a cached copy is always correct and instant.
 *  - Pages and their RSC payloads: network-first. Online you always get fresh
 *    data; offline you fall back to the last copy cached while online (e.g. the
 *    shopping list you opened at home), and finally to /offline.html.
 *  - Recipe photos (/api/recipes/<id>/image): cache-first. They're immutable
 *    under a given URL (edits bust them with a ?v= stamp) and we want them on
 *    the phone in the kitchen and the store.
 *  - Non-GET requests (Server Actions, /api writes) and auth endpoints are never
 *    intercepted — mutations require a live connection.
 *
 * Bump CACHE_VERSION to force old caches out on the next activate.
 */
const CACHE_VERSION = "v2";
const SHELL_CACHE = `mealplanner-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `mealplanner-runtime-${CACHE_VERSION}`;

// Precached so the app can boot and show an offline page with no network at all.
const PRECACHE_URLS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Recipe photos are the one API response worth holding on to: binary, stable
// under its URL, and useless to re-fetch.
function isRecipeImage(url) {
  return /^\/api\/recipes\/[^/]+\/image$/.test(url.pathname);
}

function isHashedStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icon") ||
    url.pathname === "/apple-icon.png" ||
    url.pathname === "/manifest.webmanifest"
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never touch mutations — Server Actions and API writes must hit the network.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Auth flows should never be served stale from cache.
  if (url.pathname === "/login") return;
  if (url.pathname.startsWith("/api/") && !isRecipeImage(url)) return;

  if (isHashedStatic(url) || isRecipeImage(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            // Cache-first means a cached error is permanent, so only keep good
            // responses. Opaque ones (status 0) are cross-origin images we
            // followed a redirect to — legitimate, just unreadable to us.
            if (response.ok || response.type === "opaque") {
              const copy = response.clone();
              caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Pages + RSC payloads: network-first with an offline fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        // ignoreVary: RSC responses vary on router headers that don't match
        // offline, so match on URL alone to still find the cached page.
        let cached = await cache.match(request, { ignoreVary: true });
        if (!cached && request.mode === "navigate") {
          cached = await cache.match(url.pathname, {
            ignoreVary: true,
            ignoreSearch: true,
          });
        }
        if (cached) return cached;
        if (request.mode === "navigate") {
          return caches.match("/offline.html");
        }
        return Response.error();
      }),
  );
});
