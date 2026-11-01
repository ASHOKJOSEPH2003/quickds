// Makes the app open with no network. Bump VERSION whenever a listed file changes.
const VERSION = 'quickds-v8';
const FILES = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'js/app.js', 'js/engine.js', 'js/seed.js', 'js/store.js', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (event) => {
  // The browser may hold old copies for minutes after a release, so go past its cache.
  const fresh = FILES.map((file) => new Request(file, { cache: 'reload' }));
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const lookup = event.request.mode === 'navigate' ? 'index.html' : event.request;
  event.respondWith(caches.match(lookup).then((hit) => hit || fetch(event.request)));
});
