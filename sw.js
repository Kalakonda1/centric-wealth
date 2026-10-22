/* Centric Wealth service worker — offline-first caching. Bump VERSION on every deploy. */
const VERSION = 'v1.11.0';
const CACHE = `centric-wealth-${VERSION}`;

const LOCAL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './statement-parser.js', './recurring-scanner.js', './advisor-engine.js', './monthly-report.js', './analytics-engine.js', './fonts/manrope-latin-var.woff2'];
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
  // PDF report (monthly-report.js)
  'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf-autotable@5.0.9/dist/jspdf.plugin.autotable.min.js',
  // Analytics charts (analytics-engine.js)
  'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js',
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

// Only the app's own files and the pinned CDN libraries are cached. Requests to any other site
// go straight to the network and are never stored on the device.
const CACHEABLE_HOSTS = new Set(['cdn.jsdelivr.net', 'cdn.tailwindcss.com']);
const isCacheable = (url) => url.origin === self.location.origin || CACHEABLE_HOSTS.has(url.hostname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isCacheable(url)) return; // let the browser handle it normally

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
  const target = new URL((event.notification.data && event.notification.data.url) || './#dashboard', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => c.url.startsWith(self.registration.scope));
    if (client) { await client.focus(); try { await client.navigate(target); } catch (_) {} return; }
    return self.clients.openWindow(target);
  })());
});

/* ---------------------------------------------------------------------------
 * Background bill/subscription reminders (Periodic Background Sync).
 * Chrome on Android, installed app only; the browser decides the exact timing (~daily).
 * The app (recurring-scanner.js) saves a ready-made schedule in IndexedDB; this only
 * shows entries that are due and haven't been shown yet.
 * ------------------------------------------------------------------------- */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'centric-reminders') event.waitUntil(deliverScheduledReminders());
});

function idbOpen() {
  return new Promise((resolve) => {
    const req = indexedDB.open('centric-wealth');
    req.onupgradeneeded = () => req.transaction.abort(); // DB not created yet: nothing to do
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}
const idbGet = (db, key) => new Promise((res) => {
  const r = db.transaction('settings').objectStore('settings').get(key);
  r.onsuccess = () => res(r.result ? r.result.value : undefined); r.onerror = () => res(undefined);
});
const idbSet = (db, key, value) => new Promise((res) => {
  const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key, value });
  tx.oncomplete = res; tx.onerror = res;
});

async function deliverScheduledReminders() {
  const db = await idbOpen();
  if (!db || !db.objectStoreNames.contains('settings')) return;
  try {
    if (!(await idbGet(db, 'notify'))) return;
    const schedule = await idbGet(db, 'reminderSchedule');
    if (!schedule || !Array.isArray(schedule.items)) return;
    const log = Object.assign({}, await idbGet(db, 'notificationLog'));
    const now = new Date(), nowISO = now.toISOString();
    const cutoff = new Date(now.getTime() - 3 * 86400000);
    const cutoffISO = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    let shown = 0;
    for (const s of schedule.items) {
      if (s.notifyAt > nowISO || s.dueDate < cutoffISO || log[s.tag]) continue;
      await self.registration.showNotification(s.title, { body: s.body, tag: s.tag, icon: './icon-192.png', badge: './icon-192.png', data: { url: s.url } });
      log[s.tag] = nowISO; shown++;
    }
    if (shown) await idbSet(db, 'notificationLog', log);
  } finally { db.close(); }
}
