/**
 * LifeLab Service Worker
 * Network-first for HTML, cache-first for assets
 */

const CACHE_NAME = 'lifelab-v2';

const CORE_ASSETS = [
  './',
  './index.html'
];

const PATTERN_FILES = [
  './patterns/guns.json',
  './patterns/ships.json',
  './patterns/osc.json',
  './patterns/still.json',
  './patterns/meth.json',
  './patterns/seeds.json',
  './patterns/schema.json'
];

const STATIC_ASSETS = [...CORE_ASSETS, ...PATTERN_FILES];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isHTML = event.request.mode === 'navigate' || 
                 event.request.destination === 'document' ||
                 event.request.url.endsWith('.html');

  if (isHTML) {
    // Network-first for HTML pages
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request)
            .then((cached) => cached || caches.match('./index.html'));
        })
    );
  } else {
    // Cache-first for assets
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, clone);
              });
            }
            return networkResponse;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
