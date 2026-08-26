const CACHE_NAME = 'parcelas-cache-v1.11';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/stats.js',
  './js/dexie.mjs',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  // O skipWaiting força a nova versão a assumir imediatamente
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Ativação: Limpa os caches antigos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Limpando cache antigo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Interceptação: Se estiver offline, serve o arquivo do cache
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    }).catch(() => {
      // Fallback genérico caso a rede falhe e não esteja no cache
      console.error('Falha ao buscar recurso offline:', event.request.url);
    })
  );
});