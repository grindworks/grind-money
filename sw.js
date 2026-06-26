// 💡 アップデート時はここを v2, v3... と書き換えることで更新が発火します
const CACHE_NAME = 'grindmoney-v20260625-2';
const urlsToCache = [
  './',
  './index.html',
  './main.js',
  './styles.css',
  './icon-192.png',
  './icon-512.png',
  './manifest.json',
];

const externalUrlsToCache = [
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm',
];

// インストール時にキャッシュを作成
self.addEventListener('install', (event) => {
  // 新しいService Workerを即座にアクティブにする
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // ローカルファイルは通常通り一括追加
      await cache.addAll(urlsToCache);
      // 外部CDNファイルはCORS対応のため cors で個別に追加
      for (const url of externalUrlsToCache) {
        try {
          // まずCORSモードで取得を試みる
          let request = new Request(url, { mode: 'cors' });
          let response;
          try {
            response = await fetch(request);
          } catch (e) {
            // CORSエラーなどで弾かれた場合は、no-corsモードで不透明(Opaque)レスポンスとして取得
            request = new Request(url, { mode: 'no-cors' });
            response = await fetch(request);
          }
          // 正常なレスポンス、または不透明レスポンス(type === 'opaque')の場合はキャッシュする
          if (response.ok || response.type === 'opaque') {
            await cache.put(request, response);
          } else {
            throw new Error(`Asset fetch failed: ${response.status} for ${url}`);
          }
        } catch (error) {
          console.warn('外部リソースのキャッシュをスキップしました:', url, error);
          // 外部リソースの失敗でService Worker全体のインストールが中断しないよう、throwしない
        }
      }
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
          // ネットワークエラー（オフライン）で、キャッシュにもない場合のフォールバック
          if (
            event.request.mode === 'navigate' ||
            (event.request.headers.get('accept') &&
              event.request.headers.get('accept').includes('text/html'))
          ) {
            return await cache.match('./index.html');
          }
        }
      };

      // Stale-While-Revalidate 戦略
      if (cachedResponse) {
        // キャッシュヒット。バックグラウンドで更新を試みる
        fetchAndCache();
        return cachedResponse;
      }
      // キャッシュミス。ネットワークからの応答を待つ
      return await fetchAndCache();
    })(),
  );
});
