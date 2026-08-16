/* Offline cache.
 *
 * This was cache-first for everything, and that was a mistake that cost real
 * debugging: the app files were served from cache forever unless CACHE below
 * was bumped by hand, and it was not bumped through four commits of parser
 * fixes. A phone that had opened the app once kept reading labels with the old
 * reader — the same bug reproducing perfectly against code that no longer
 * existed. "Did the fix reach the device" is not a question anyone should have
 * to ask.
 *
 * So the app's own files are network-first now: the network answers when it can
 * and the cache is the fallback, which is the right way round for anything
 * still being fixed. The OCR engine stays cache-first, because it is ~4MB, it
 * is versioned by filename, and it genuinely never changes.
 */
var CACHE = 'calcalc-v3';

/* The app shell, pre-cached so a first visit works offline afterwards. The OCR
 * engine under vendor/ is deliberately absent: three core builds and a language
 * model come to ~15MB and a phone downloads exactly one of those builds, so
 * pre-caching all of them spends the budget on files that device will never
 * load. They are picked up by the runtime cache below on first use instead. */
var ASSETS = [
  './',
  'index.html',
  'styles.css',
  'ui.js',
  'label-parser.js',
  'scan.html',
  'scan.css',
  'scan.js',
  'save.js',
  'records.html',
  'records.css',
  'records.js',
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

  /* /api/ is live state — which port https is on, whether Tailscale is up, and
   * every saved item. A cache-first worker answers those once and is then
   * frozen at that answer, because Cache.match will happily satisfy a request
   * that asked for `cache: 'no-store'`.
   *
   * Resolved against the worker's own scope, not the root: under `tailscale
   * serve --set-path /calcalc` this app lives at /calcalc/, so its endpoints
   * are /calcalc/api/… and a check for a leading "/api/" does not match them. */
  var scope = new URL(self.registration.scope).pathname;
  if (url.pathname.indexOf(scope + 'api/') === 0) return;

  // The reader and its language model: big, immutable, and the one thing worth
  // keeping out of the network's way.
  if (url.pathname.indexOf('vendor/') !== -1) {
    e.respondWith(cacheFirst(e.request));
    return;
  }

  e.respondWith(networkFirst(e.request, url));
});

function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(request, copy); });
      }
      return res;
    });
  });
}

// The network decides, and the cache catches it when there is no network —
// which in a shop, in a basement, off the tailnet, is often.
function networkFirst(request, url) {
  return fetch(request).then(function (res) {
    // Query strings are skipped: they are cache-busters here, and storing them
    // accumulates entries nothing will ever ask for again.
    if (res && res.ok && res.type === 'basic' && !url.search) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(request, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(request).then(function (hit) {
      return hit || caches.match('index.html');
    });
  });
}
