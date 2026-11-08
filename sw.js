/* Finora Service Worker — cache shell untuk PWA (FR-024) */
const CACHE = 'finora-v1';
const ASSETS = [
  './', './index.html', './css/styles.css', './js/app.js',
  './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(ASSETS.map((a) => c.add(new Request(a, { cache: 'reload' }))))
    )
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Permintaan lintas origin (Apps Script API) → langsung network, jangan dicache
  if (url.origin !== location.origin) return;

  // Navigasi halaman: network dulu, fallback ke shell cache (semi-offline)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Aset statis: cache-first
  e.respondWith(
    caches.match(req).then((cached) => cached ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
