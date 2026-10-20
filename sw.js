// 💡 アップデート時はここを v2, v3... と書き換えることで更新が発火します
const CACHE_NAME = 'grindmoney-v20261020-1';
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

// インストール時にキャッシュを作成
self.addEventListener('install', (event) => {
  // 新しいService Workerを即座にアクティブにする
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // ローカルファイルは通常通り一括追加
      await cache.addAll(urlsToCache.filter((url) => !url.endsWith('.wasm')));
      // WASMは個別にキャッシュ（失敗してもService Worker自体は止めない）
      await cache.add('./assets/sql-wasm.wasm').catch(() => console.warn('WASM cache failed.'));
    }),
  );
});

// 古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              return caches.delete(cacheName);
            }
          }),
        );
      })
      .then(() => self.clients.claim()),
  );
});

// fetchイベントでキャッシュを返す
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(event.request);

      const fetchAndCache = async () => {
        try {
          const networkResponse = await fetch(event.request);
          // 正常なレスポンスの場合、キャッシュを更新
          if (networkResponse && networkResponse.status === 200) {
            await cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        } catch (error) {
          if (
            event.request.mode === 'navigate' ||
            (event.request.headers.get('accept') &&
              event.request.headers.get('accept').includes('text/html'))
          ) {
            // The app itself works offline; offline.html is only the last resort
            return (
              (await cache.match('./index.html')) ||
              (await cache.match('./offline.html')) ||
              new Response('', { status: 503, statusText: 'Offline' })
            );
          }
          return new Response('', { status: 503, statusText: 'Offline' });
        }
      };

      // Stale-While-Revalidate
      if (cachedResponse) {
        event.waitUntil(fetchAndCache());
        return cachedResponse;
      }
      return await fetchAndCache();
    })(),
  );
});
