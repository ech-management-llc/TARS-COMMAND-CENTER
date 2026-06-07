// TARS Command Center — Service Worker
// Platform v1 (tile-home). Offline shell: precache the core + registry + drill-ins.
// Cache-first for same-origin assets; live sources (FL API, data snapshots) fall
// through to the network when online.

const CACHE_NAME = 'tcc-tilehome-live-20260607';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './agents.js',
  './artifact.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // registry
  './config/tenant.json',
  './config/layers.json',
  // committed data snapshots (present today)
  './data/REVENTURE_LATEST.json',
  './data/CENSUS_VACANCY_LATEST.json',
  // drill-ins (each layer's standalone artifact page)
  './layers/financials/artifact/index.html',
  './layers/deal-analyzer/artifact/index.html',
  './layers/document-navigator/artifact/index.html',
  './layers/deal-screener/artifact/index.html',
  './layers/punch-list/artifact/index.html',
  './layers/rent-roll/artifact/index.html',
  './layers/inbox/artifact/index.html',
  './layers/lender-packet/artifact/index.html',
  './layers/vendors-payables/artifact/index.html',
  './layers/build-renovate/artifact/index.html',
  './layers/maintenance/artifact/index.html',
  './layers/website-it/artifact/index.html',
  './layers/team-access/artifact/index.html',
  './layers/plans-billing/artifact/index.html',
  './layers/investor-reporting/artifact/index.html',
  './layers/tenant-portal/artifact/index.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    // addAll is atomic; use individual puts so one missing optional asset can't
    // abort the whole precache.
    caches.open(CACHE_NAME).then(cache => Promise.all(
      ASSETS.map(url => cache.add(url).catch(() => {}))
    ))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // Only handle same-origin GET; everything else (FL API cross-origin, POST) → network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).catch(() => cached))
  );
});
