// LetsFly Service Worker
// Caches the app shell (this HTML file + its CDN dependencies) so the app can still open
// without a network connection. Trip data itself comes from Supabase's live API, which a
// Service Worker cache can't meaningfully serve offline — that's handled separately in the
// app via a localStorage snapshot of the last-viewed trip (see snapshotTripForOffline in
// the main HTML file). This worker only handles GET requests; it never touches the POST/PATCH
// calls the app makes to Supabase, so live saves/loads are completely unaffected while online.

const CACHE_NAME = 'letsfly-shell-v4';

// Precache the page itself. CDN assets (Leaflet, MarkerCluster, the Supabase client library,
// etc.) are cached opportunistically on first successful fetch instead of listed here by exact
// version/URL, so this doesn't silently break if a CDN path changes.
const APP_SHELL = [
  './',
  './index.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => { /* precache is best-effort — a failure here shouldn't block install */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever intercept GET requests. Everything else (POST/PATCH/DELETE to Supabase, etc.)
  // passes straight through untouched — a Service Worker cache has no business answering those.
  if (req.method !== 'GET') return;

  // Never intercept calls to Supabase's API — those need to always hit the network so the app
  // can tell the difference between "genuinely offline" and "got cached stale data that looks
  // like a success." Let those fail naturally if the network is down; the app's own
  // localStorage-based offline fallback handles that case explicitly.
  if (req.url.includes('supabase.co')) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached); // network failed — fall back to whatever's cached, if anything

      // Serve the cached version immediately if we have one (fast, works offline), while still
      // updating the cache in the background for next time.
      return cached || networkFetch;
    })
  );
});
