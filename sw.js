/* Centric Wealth service worker — offline-first caching. Bump VERSION on every deploy. */
const VERSION = 'v1.1.0';
const CACHE = `centric-wealth-${VERSION}`;

const LOCAL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './statement-parser.js'];
const CDN = [
  'https://cdn.tailwindcss.com/3.4.16',
  'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js',
  'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@babel/standalone@7.29.10/babel.min.js',
  'https://cdn.jsdelivr.net/npm/lucide@0.453.0/dist/umd/lucide.min.js',
  // Statement parser libraries (statement-parser.js)
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.mjs',
  'https://cdn.jsdelivr.net/npm/papaparse@5.5.3/papaparse.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(LOCAL);
    // CDN files: CORS first (ES modules like pdf.js refuse opaque responses), no-cors as a fallback.
    await Promise.all(CDN.map(async (url) => {
      try {
        let res = await fetch(url, { mode: 'cors' }).catch(() => null);
        if (!res || !res.ok) res = await fetch(url, { mode: 'no-cors' });
        await cache.put(url, res);
      } catch (e) { /* retried at runtime */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('centric-wealth-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // App shell: network-first so new deploys show up, cache fallback when offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        (await caches.open(CACHE)).put('./index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // Everything else (pinned CDN libs, icons): cache-first.
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreVary: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow('./#budget/bills');
  })());
});
