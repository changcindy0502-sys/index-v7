/* 恢復室病人運送管理系統 - Service Worker
 * 版本號每次部署時更新，確保APP自動載入最新版本
 * 使用者不需要手動重新安裝 */

// ★ 每次更新檔案後，請把下方版本號+1（例如 v2 → v3）
// 這樣所有已安裝的APP會在下次開啟時自動更新到最新版
const CACHE_VERSION = 'v14';
const CACHE_NAME = 'por-transport-' + CACHE_VERSION;

const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 安裝：快取所有靜態資源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // 立即接管，不等舊的Service Worker結束
  self.skipWaiting();
});

// 啟動：刪除所有舊版快取，讓APP載入最新版本
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('por-transport-') && k !== CACHE_NAME)
          .map((k) => {
            console.log('[SW] 刪除舊快取：', k);
            return caches.delete(k);
          })
      )
    ).then(() => {
      // 立即控制所有已開啟的頁面
      return self.clients.claim();
    }).then(() => {
      // 通知所有已開啟的頁面重新整理以載入最新版本
      return self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION });
        });
      });
    })
  );
});

// 攔截請求
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Google Apps Script API：永遠走網路，不快取
  if (url.hostname.includes('script.google.com') || url.hostname.includes('script.googleusercontent.com')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ success: false, message: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // 靜態資源：網路優先，失敗才用快取（確保每次都拿最新版）
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      })
      .catch(() => {
        // 網路失敗時才用快取（離線模式）
        return caches.match(event.request);
      })
  );
});
