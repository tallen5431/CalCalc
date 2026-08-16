#!/usr/bin/env node
/* Checks how this server works out where `tailscale serve` publishes it.
 *
 *   node tests/serve.test.js       — no tailnet needed
 *
 * This exists because getting it wrong is not a cosmetic failure. The scanner
 * puts the answer on screen as a link and tells you to open it on your phone,
 * so a wrong answer hands someone a confident link to a different application
 * on the same machine — which is exactly what happened when the URL was
 * assembled from the tailnet hostname instead of being looked up.
 */

'use strict';

var pickServeMount = require('../server.js').pickServeMount;

var passed = 0, failed = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.log('  FAIL  ' + name + '\n        expected ' + expected + ', got ' + actual);
  }
}

function group(name, fn) { console.log('\n' + name); fn(); }

function url(status, port) {
  var m = pickServeMount(status, port);
  return m ? m.url : null;
}

/* The situation that prompted all of this: one machine, two apps, and
   something else already holding the root of the hostname. */
var SHARED_HOST = {
  TCP: { 443: { HTTPS: true } },
  Web: {
    'tj-nucboxg3-plus.tail8ce2ce.ts.net:443': {
      Handlers: {
        '/': { Proxy: 'http://127.0.0.1:3000' },
        '/calcalc': { Proxy: 'http://127.0.0.1:8090' }
      }
    }
  }
};

group('a host that serves more than one app', function () {
  check('this app is found at its own path',
        url(SHARED_HOST, 8090), 'https://tj-nucboxg3-plus.tail8ce2ce.ts.net/calcalc/');
  // The whole point. Another app owning "/" must never be reported as this one.
  check('the app on the root is reported at the root',
        url(SHARED_HOST, 3000), 'https://tj-nucboxg3-plus.tail8ce2ce.ts.net/');
  check('a port nothing serves gets no url', url(SHARED_HOST, 9999), null);
});

group('the ordinary cases', function () {
  check('mounted on the root', url({
    Web: { 'box.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8090' } } } }
  }, 8090), 'https://box.tailnet.ts.net/');

  // A non-443 port keeps its port in the URL; 443 does not, because a URL
  // carrying ":443" is a URL nobody wants to type.
  check('mounted on its own https port', url({
    Web: { 'box.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8090' } } } }
  }, 8090), 'https://box.tailnet.ts.net:8443/');

  // Different CLI versions write the proxy target differently, and all of
  // them mean the same local port.
  ['http://127.0.0.1:8090', 'http://localhost:8090', '127.0.0.1:8090', '8090',
   'http://127.0.0.1:8090/'].forEach(function (proxy, i) {
    check('proxy form ' + i + ' (' + proxy + ')', url({
      Web: { 'box.tailnet.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } }
    }, 8090), 'https://box.tailnet.ts.net/');
  });

  check('a trailing slash on the mount path is normalised', url({
    Web: { 'box.tailnet.ts.net:443': { Handlers: { '/calcalc/': { Proxy: 'http://127.0.0.1:8090' } } } }
  }, 8090), 'https://box.tailnet.ts.net/calcalc/');

  // Two mounts onto the same app: the shorter address is the one to put in
  // front of someone holding a phone.
  check('the shortest of several mounts wins', url({
    Web: {
      'box.tailnet.ts.net:443': {
        Handlers: {
          '/a-very-long-mount-path': { Proxy: 'http://127.0.0.1:8090' },
          '/cc': { Proxy: 'http://127.0.0.1:8090' }
        }
      }
    }
  }, 8090), 'https://box.tailnet.ts.net/cc/');
});

group('nothing serving, and malformed input', function () {
  // Every one of these must produce null rather than a guess. "No HTTPS
  // address" is a true and useful answer; a fabricated one is not.
  [null, undefined, {}, { Web: null }, { Web: {} }, { Web: 'nonsense' },
   { Web: { 'box.ts.net:443': {} } },
   { Web: { 'box.ts.net:443': { Handlers: null } } },
   { Web: { 'box.ts.net:443': { Handlers: { '/': {} } } } },
   { Web: { 'box.ts.net:443': { Handlers: { '/': { Proxy: 42 } } } } },
   // A serve config that exists but points somewhere else entirely.
   { Web: { 'box.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } },
   // A port that merely appears inside another number must not match.
   { Web: { 'box.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18090' } } } } }
  ].forEach(function (status, i) {
    check('input ' + i + ' yields no url', url(status, 8090), null);
  });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
