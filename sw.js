// Ledgerly service worker: caches the app shell + pinned CDN libraries for offline use.
// Bump CACHE when you change index.html or library versions.
const CACHE = 'ledgerly-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.25.6/babel.min.js',
  'https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(ASSETS.map((url) =>
        fetch(url, { mode: url.startsWith('http') ? 'no-cors' : 'same-origin' })
          .then((res) => c.put(url, res))
          .catch(() => {})
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.hostname === 'api.anthropic.com') return; // never cache API calls

  // App shell: network-first so updates land, cache fallback when offline.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => { caches.open(CACHE).then((c) => c.put('./index.html', res.clone())); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else (CDN libs, Tailwind's runtime fetches): cache-first, then network.
  e.respondWith(
    caches.match(request, { ignoreSearch: false }).then((hit) =>
      hit || fetch(request).then((res) => {
        if (res.ok || res.type === 'opaque') caches.open(CACHE).then((c) => c.put(request, res.clone()));
        return res;
      })
    )
  );
});
