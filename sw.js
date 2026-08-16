/* Offline cache. Bump CACHE whenever a file in ASSETS changes — this is
 * cache-first, so a phone holding the old worker would otherwise keep serving
 * the old page forever. */
var CACHE = 'calcalc-v1';

/* The app shell only. The OCR engine under vendor/ is deliberately absent:
 * three core builds and a language model come to ~15MB, and a phone downloads
 * exactly one of those builds. Pre-caching all of them would spend most of the
 * budget on files that device will never load. They are picked up by the
 * runtime cache below on first use instead, which stores the ~4MB variant that
 * phone actually chose. */
var ASSETS = [
  './',
  'index.html',
  'styles.css',
  'ui.js',
  'label-parser.js',
  'scan.html',
  'scan.css',
  'scan.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;

  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  /* /api/status is live state — which port https is on, whether Tailscale is
   * up, what this machine is called on the tailnet. A cache-first worker
   * answers it once and is then frozen at that answer forever, because
   * Cache.match will happily satisfy a request that asked for
   * `cache: 'no-store'`. The scanner uses it to tell you which address will
   * actually open the camera, so a stale answer sends you to an address that
   * has since changed. None of it is any use offline either. */
  if (url.pathname.indexOf('/api/') === 0) return;

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        // Cache same-origin successes so a first visit online works offline
        // later — this is what puts the OCR engine on the device. Query
        // strings are skipped: they are cache-busters here, and storing them
        // accumulates entries nothing will ever ask for again.
        if (res && res.ok && res.type === 'basic' && !url.search) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match('index.html');
      });
    })
  );
});
