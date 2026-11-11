// Service Worker — v5.13.0 紧急修复
// 根因：v5.12.3 的 fetch 对所有请求兜底 + HTML 被 308 重定向到无后缀路径 + 相对路径解析错误 → JS 请求拿到 HTML
// 修复：① 只对导航请求兜底 ② 非导航请求不缓存 ③ 缓存版本跳大
const CACHE_NAME = 'shortage-tool-v5.13.0';
const STATIC_ASSETS = [
  '/',
  '/login.html',
  '/store.html',
  '/admin.html',
  '/manifest.json',
  '/static/css/style.css',
  '/static/js/utils.js',
  '/static/js/admin.js',
  '/static/js/store.js',
  '/static/logo.jpg'
];

// 安装：只缓存导航请求（HTML 页面），静态资源每次走网络
self.addEventListener('install', (event) => {
  console.log('[SW v5.13.0] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 激活：清理所有旧缓存（v5.12.x 及更早全部清）
self.addEventListener('activate', (event) => {
  console.log('[SW v5.13.0] Activating...');
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => {
        console.log('[SW] Deleting old cache:', k);
        return caches.delete(k);
      })
    )).then(() => self.clients.claim())
  );
});

// ★ v5.13.0 收紧：只对导航请求兜底，非导航请求绝不缓存 HTML
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API 请求直接放行（不缓存）
  if (url.pathname.includes('/functions/v1/')) {
    event.respondWith(fetch(request));
    return;
  }

  // ★ 只对导航请求（HTML 页面）做缓存
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-cache' })
        .then((response) => {
          // 只缓存 200 且 Content-Type 是 text/html 的响应
          if (response.ok && response.headers.get('Content-Type')?.includes('text/html')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then(r => r || new Response('离线中，请检查网络', { status: 503 })))
    );
    return;
  }

  // ★ 非导航请求（.js / .css / .json / 图片等）：直接放行，不缓存，不兜底
  // 之前 v5.12.3 的问题：对 .js 也做了 fetch→cache→catch→兜底，导致缓存污染时把 HTML 存进 JS 缓存键
  event.respondWith(fetch(request));
});
