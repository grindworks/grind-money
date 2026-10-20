// Bump the version on every release; the new worker waits until the page asks for it (SKIP_WAITING)
const CACHE_NAME = 'grindmoney-v20261020-2';
const urlsToCache = [
  './',
  './index.html',
  './main.js',
  './styles.css',
  './icon-192.png',
  './icon-512.png',
  './manifest.json',
  './offline.html',
  './assets/sql-wasm.js',
  './assets/sql-wasm.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(urlsToCache.map((url) => new Request(url, { cache: 'reload' }))),
      ),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.map((cacheName) =>
            cacheName.startsWith('grindmoney-') && cacheName !== CACHE_NAME
              ? caches.delete(cacheName)
              : undefined,
          ),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const precachedPaths = new Set(urlsToCache.map((url) => new URL(url, self.location).pathname));

function isHtmlRequest(request) {
  return request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
}

function offlineResponse(request) {
  if (isHtmlRequest(request)) {
    return caches
      .match('./index.html')
      .then((cached) => cached || caches.match('./offline.html'))
      .then((cached) => cached || new Response('Offline', { status: 503 }));
  }
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !precachedPaths.has(url.pathname)) return;

  // Precached files come only from this version's cache; CACHE_NAME updates them as a whole
  event.respondWith(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.match(event.request, { ignoreSearch: true }))
      .then((response) => response || fetch(event.request))
      .catch(() => offlineResponse(event.request)),
  );
});
