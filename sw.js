// 💡 アップデート時はここを v2, v3... と書き換えることで更新が発火します
const CACHE_NAME = 'grindmoney-v53';
const urlsToCache = [
  './',
  './index.html',
  './main.js',
  './styles.css',
  './icon-192.png',
  './icon-512.png',
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
          const request = new Request(url, { mode: 'cors' });
          const response = await fetch(request);
          // 404エラーなどで壊れたキャッシュを保存しないための防波堤
          if (response.ok) {
            await cache.put(request, response);
          } else {
            throw new Error(`Critical asset fetch failed: ${response.status} for ${url}`);
          }
        } catch (error) {
          console.error('外部リソースのキャッシュに失敗しました:', url, error);
          throw error; // コアリソースの失敗はインストール全体を中断（失敗）させる
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
  event.respondWith(
    caches.match(event.request).then((response) => {
      // 1. キャッシュがあればそれを返す
      if (response) {
        return response;
      }
      // 2. キャッシュがなければネットワークから取得を試みる
      return fetch(event.request).catch(() => {
        // 3. オフラインかつキャッシュにもない場合のフォールバック（HTMLへのアクセス時のみ）
        if (
          event.request.mode === 'navigate' ||
          (event.request.headers.get('accept') &&
            event.request.headers.get('accept').includes('text/html'))
        ) {
          const fallbackHtml = `
            <!DOCTYPE html>
            <html lang="ja">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>GrindMoney - 通知</title>
              <style>
                body { font-family: sans-serif; background-color: #fafafa; color: #333; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px; }
                h1 { font-size: 20px; color: #111827; margin-bottom: 16px; font-weight: bold; }
                p { font-size: 15px; color: #4b5563; line-height: 1.6; margin-bottom: 24px; }
                .icon { font-size: 48px; margin-bottom: 16px; }
              </style>
            </head>
            <body>
              <div class="icon">💡</div>
              <h1>ブラウザのキャッシュがクリアされたようです</h1>
              <p>お金のデータ（.grindファイル）はあなたのPCに安全に保存されていますので、ご安心ください！<br><br>アプリを再びオフラインで使うには、お手数ですが<strong>一度インターネットに接続した状態で、GrindMoneyにアクセスし直して</strong>ください。<br>すぐに元通り使えるようになります。</p>
            </body>
            </html>
          `;
          return new Response(fallbackHtml, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
      });
    }),
  );
});
