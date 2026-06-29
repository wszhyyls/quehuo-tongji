// Service Worker for 缺货统计系统 PWA
const CACHE_NAME = 'shortage-tool-v4.2';
const STATIC_ASSETS = [
  '/',
  '/login.html',
  '/store.html',
  '/admin.html',
  '/procurement.html',
  '/manifest.json',
  '/static/css/style.css',
  '/static/js/utils.js',
  '/static/js/admin.js',
  '/static/js/store.js',
  '/static/js/procurement.js',
  '/static/logo.jpg'
];

// 安装 Service Worker
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[SW] Skip waiting');
        return self.skipWaiting();
      })
  );
});

// 激活并清理旧缓存
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('[SW] Claiming clients');
        return self.clients.claim();
      })
  );
});

// 拦截网络请求
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API 请求直接放行（不缓存）
  if (url.pathname.includes('/functions/v1/')) {
    event.respondWith(fetch(request));
    return;
  }

  // 对于同源请求，使用缓存优先策略
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            // 返回缓存，同时在后台更新缓存
            event.waitUntil(
              fetch(request)
                .then((response) => {
                  if (response.ok) {
                    caches.open(CACHE_NAME)
                      .then((cache) => cache.put(request, response));
                  }
                })
                .catch(() => {})
            );
            return cachedResponse;
          }

          // 没有缓存，发起网络请求
          return fetch(request)
            .then((response) => {
              if (response.ok) {
                const clonedResponse = response.clone();
                caches.open(CACHE_NAME)
                  .then((cache) => cache.put(request, clonedResponse));
              }
              return response;
            });
        })
    );
  } else {
    // 其他请求直接放行
    event.respondWith(fetch(request));
  }
});

// 处理推送通知（预留）
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body || '您有新的通知',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: data.id || 1
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '缺货统计系统', options)
  );
});

// 点击通知处理（预留）
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/admin.html')
  );
});

console.log('[SW] Service Worker loaded');
