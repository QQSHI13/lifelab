// LifeLab Service Worker - Stale-while-revalidate with hard refresh support
const CACHE_NAME = 'lifelab-v1';

// Core assets to cache
const CORE_ASSETS = [
  './',
  './index.html'
];

// Pattern files to cache
const PATTERN_FILES = [
  './patterns/guns.json',
  './patterns/ships.json',
  './patterns/osc.json',
  './patterns/still.json',
  './patterns/meth.json',
  './patterns/seeds.json',
  './patterns/schema.json'
];

// Combine all assets
const STATIC_ASSETS = [...CORE_ASSETS, ...PATTERN_FILES];

// Detect hard reload (Cmd+Shift+R / Ctrl+Shift+R)
// The navigation preload header indicates a force reload
function isHardReload(request) {
  // Check for cache-control header indicating no-cache
  if (request.headers.get('cache-control') === 'max-age=0') {
    return true;
  }
  // Check if it's a navigation request with reload navigation type
  if (request.destination === 'document' && 
      request.mode === 'navigate' &&
      request.cache === 'reload') {
    return true;
  }
  return false;
}

// Install: Cache core assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[SW] Install complete');
        // Don't skip waiting automatically - wait for skipWaiting message
      })
      .catch((err) => {
        console.error('[SW] Cache failed:', err);
      })
  );
});

// Activate: Clean up old caches
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
        console.log('[SW] Activation complete');
        return self.clients.claim();
      })
  );
});

// Fetch: Stale-while-revalidate strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }
  
  // Skip cross-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }
  
  // Handle hard reload - bypass cache
  if (isHardReload(request)) {
    console.log('[SW] Hard reload detected, bypassing cache');
    event.respondWith(fetch(request));
    return;
  }
  
  // Stale-while-revalidate for static assets
  event.respondWith(
    caches.match(request)
      .then((cached) => {
        // Start fetch for revalidation
        const fetchPromise = fetch(request)
          .then((networkResponse) => {
            // Update cache with fresh response
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, clone);
              });
            }
            return networkResponse;
          })
          .catch((err) => {
            console.log('[SW] Fetch failed:', err);
            // Return cached response if available, otherwise fail
            return cached;
          });
        
        // Return cached response immediately (stale), revalidate in background
        return cached || fetchPromise;
      })
  );
});

// Message handling for skipWaiting
self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data);
  
  if (event.data === 'skipWaiting') {
    console.log('[SW] Skipping waiting...');
    self.skipWaiting();
  }
  
  // Handle hard reload detection from client
  if (event.data && event.data.type === 'HARD_RELOAD') {
    console.log('[SW] Hard reload message received');
    // Force skip waiting on hard reload
    self.skipWaiting();
  }
  
  // Handle checking for updates
  if (event.data && event.data.type === 'CHECK_UPDATE') {
    console.log('[SW] Checking for updates...');
    self.registration.update();
  }
});
