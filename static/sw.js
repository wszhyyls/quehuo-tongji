// Service Worker — v5.14.0 终极修复
// 根因：v5.12.3 fetch 对非导航请求也兜底 → 缓存污染（JS请求拿到 HTML）
// 修复：fetch 只处理 request.mode === 'navigate'，其他请求直接 return（SW 不拦截）
// activate 里清所有旧 cache（含 v5.12.x 和 v5.13.0）
const CACHE_NAME = 'shortage-tool-v5.14.0';

self.addEventListener('install', (e) => {
  console.log('[SW v5.14.0] install → skipWaiting');
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log('[SW v5.14.0] activate → 清全部旧 cache');
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => {
        console.log('[SW] delete old:', k);
        return caches.delete(k);
      })
    )).then(() => self.clients.claim())
  );
});

// ★ v5.14.0：严格只拦截导航请求（HTML），其他请求一概放行
self.addEventListener('fetch', (e) => {
  // 只拦截浏览器导航（用户点链接/URL栏直接访问 HTML 页面）
  if (e.request.mode !== 'navigate') return;

  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((resp) => {
        if (resp.ok && resp.headers.get('Content-Type')?.includes('text/html')) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then((r) => r || new Response('离线中，请检查网络', { status: 503 })))
  );
});
