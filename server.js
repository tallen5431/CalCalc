#!/usr/bin/env node
/* Static file server for CalCalc.
 *
 * This project is a website, not a Node program — the JavaScript in it runs in
 * a browser. Hosts that look for a Node entry point should land here, which is
 * why package.json points "main" and "start" at this file.
 *
 *   node server.js              # http://localhost:8090
 *   PORT=3000 node server.js
 *
 * No dependencies, so there is nothing to install first.
 */

'use strict';

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');
var os = require('os');
var execFile = require('child_process').execFile;

var Journal = require('./journal.js');

var ROOT = __dirname;
// Deliberately not 8080. The HTTP Server Manager's own scaffolding defaults
// imported Node projects to 8080, so anything else already on the shelf is
// probably sitting there — and two programs fighting over a port present as
// one of them mysteriously refusing to start.
var PORT = parseInt(process.env.PORT, 10) || 8090;
var HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 8453;
var HOST = process.env.HOST || '0.0.0.0';
var SSL_DIR = path.join(ROOT, 'ssl');

var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  // Served as an opaque blob on purpose. This is the OCR language model, which
  // the reader inflates itself — labelling it Content-Encoding: gzip would have
  // the browser silently decompress it first and hand the reader garbage.
  '.gz': 'application/octet-stream'
};

/* Things that must never leave the machine, however they are asked for.
 *
 * On a tailnet this server has no authentication, and over a LAN it has no
 * transport security either — every file under ROOT is one GET away from
 * anyone who can reach the port. That is fine for a page of HTML and not fine
 * for `ssl/ca-key.pem`, which is the private key of the certificate authority
 * `tools/make-cert.sh` asks you to install on your phone as a trust anchor.
 * Anyone who fetches it can mint a certificate your phone will believe, for
 * any site.
 */
// `data/` holds the record of what you have scanned and where you shop. It is
// reached through /api/items, which returns rows — the file itself is never
// served, so the path is never taken from the request.
var PRIVATE = /(^|\/)(ssl|data|node_modules|\.git)(\/|$)|(^|\/)\./i;
var SECRET_EXT = /\.(pem|key|crt|cer|p12|pfx|jks)$/i;

function isPrivate(pathname) {
  return PRIVATE.test(pathname) || SECRET_EXT.test(pathname);
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-cache' }, headers || {}));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

/* ---------- where the phone should be pointed ----------
 *
 * The camera is the whole point of this app and browsers only hand one out in
 * a secure context, so the single most useful thing this server can say at
 * startup is which of its own addresses will actually work. That answer
 * depends on Tailscale, so it goes and finds out rather than guessing.
 *
 * `tailscale status --json` is the authority; the environment variables are
 * for hosts where the CLI is not on PATH (the HTTP Server Manager sets
 * TAILSCALE_HOSTNAME for exactly this reason).
 */
var tailnet = { name: null, checked: false };
// Where `tailscale serve` actually publishes this port, if it publishes it at
// all. Null means "not served", which is a different thing from "no Tailscale".
var serveMount = null;

function findTailnetName(done) {
  var configured = process.env.TAILSCALE_HOSTNAME || process.env.TS_CERT_DOMAIN;
  if (configured) {
    tailnet = { name: configured, checked: true, source: 'environment' };
    return done(tailnet);
  }
  // Short timeout and a swallowed error: Tailscale not being installed is an
  // ordinary state for this program, not a failure of it.
  execFile('tailscale', ['status', '--json'], { timeout: 3000 }, function (err, stdout) {
    if (err) {
      tailnet = { name: null, checked: true, source: 'absent' };
      return done(tailnet);
    }
    var name = null;
    try {
      var status = JSON.parse(stdout);
      var self = status && status.Self;
      if (self && typeof self.DNSName === 'string' && self.DNSName) {
        name = self.DNSName.replace(/\.$/, '');   // MagicDNS names arrive rooted
      }
    } catch (e) { /* not JSON: an old CLI, or something else called tailscale */ }
    tailnet = { name: name, checked: true, source: name ? 'tailscale' : 'absent' };
    done(tailnet);
  });
}

/* Where `tailscale serve` publishes this port — asked, never assumed.
 *
 * A tailnet name plus HTTPS does NOT mean this app is at the root of it. One
 * machine commonly serves several things, and whichever was mounted on "/"
 * owns that address. Constructing "https://<tailnet>/" and calling it the
 * camera URL sent a phone to a completely different application on the same
 * host, with the scanner cheerfully presenting the link as the fix.
 *
 * So the mapping is read back out of `tailscale serve status --json`, which
 * knows what is mounted where:
 *
 *   { "Web": { "host.tailnet.ts.net:443": {
 *       "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" },
 *                     "/calcalc": { "Proxy": "http://127.0.0.1:8090" } } } } }
 *
 * The handler whose proxy target is this server's port is this app's address,
 * whatever path or port it happens to be on. If nothing points here, the
 * honest answer is that this app is not served over HTTPS yet — and the
 * startup banner prints the command that would fix it.
 */
// Pure, and exported, so the mapping can be tested against real CLI output
// without a tailnet. This is the logic that sent a phone to the wrong
// application; it earns a test.
function pickServeMount(status, port) {
  var web = status && status.Web;
  if (!web || typeof web !== 'object') return null;

  var found = null;
  Object.keys(web).forEach(function (hostport) {
    var handlers = web[hostport] && web[hostport].Handlers;
    if (!handlers || typeof handlers !== 'object') return;
    Object.keys(handlers).forEach(function (mountPath) {
      var proxy = handlers[mountPath] && handlers[mountPath].Proxy;
      if (typeof proxy !== 'string') return;
      // Match on the port this process is listening on. The host half varies —
      // 127.0.0.1, localhost, and a bare "8090" are all written by different
      // versions of the CLI — so only the port is compared.
      var m = proxy.match(/:(\d+)\/?\s*$/) || proxy.match(/^(\d+)$/);
      if (!m || parseInt(m[1], 10) !== port) return;

      // hostport is "name:443"; 443 is implied in a URL and noise in one.
      var parts = String(hostport).split(':');
      var host = parts[0];
      var hostPort = (!parts[1] || parts[1] === '443') ? '' : ':' + parts[1];
      var path = mountPath === '/' ? '/' : mountPath.replace(/\/+$/, '') + '/';

      // The shortest address wins if several point here — that is the one
      // least annoying to type on a phone.
      var url = 'https://' + host + hostPort + path;
      if (!found || url.length < found.url.length) {
        found = { url: url, host: host, path: mountPath };
      }
    });
  });

  return found;
}

function findServeMount(port, done) {
  execFile('tailscale', ['serve', 'status', '--json'], { timeout: 3000 }, function (err, stdout) {
    if (err) return done(null);      // no Tailscale, or an old CLI without this
    var status;
    try {
      status = JSON.parse(stdout);
    } catch (e) {
      return done(null);
    }
    done(pickServeMount(status, port));
  });
}

function lanAddresses() {
  var out = [];
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (nic) {
      if (nic.family === 'IPv4' && !nic.internal) out.push(nic.address);
    });
  });
  return out;
}

/* ---------- the record ----------
 *
 * One JSON object per line, appended, never rewritten. The format survives a
 * power cut with the loss of at most the line being written, which a single
 * JSON document holding everything does not.
 */
var JOURNAL_PATH = process.env.JOURNAL || path.join(ROOT, 'data', 'journal.jsonl');

// Small on purpose. Nothing this server accepts is bigger than a name and a
// handful of numbers, so a body that keeps arriving is not a large request, it
// is a client that should be hung up on.
var MAX_BODY = 8192;

function readJsonBody(req, done) {
  // Chunks are collected as bytes and decoded once at the end. Appending a
  // Buffer to a string decodes each chunk on its own, and a character whose
  // bytes land either side of a chunk boundary is then two half-characters:
  // "café" arrives as "caf��". Names are typed by a person, on a
  // phone, about food — accents are not an edge case in that list.
  var chunks = [];
  var length = 0;
  var over = false;

  req.on('data', function (chunk) {
    if (over) return;
    chunks.push(chunk);
    length += chunk.length;
    if (length > MAX_BODY) { over = true; req.destroy(); done(new Error('too big')); }
  });
  req.on('error', function () { if (!over) { over = true; done(new Error('aborted')); } });
  req.on('end', function () {
    if (over) return;
    over = true;
    try {
      var parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      done(null, (parsed && typeof parsed === 'object') ? parsed : null);
    } catch (e) {
      done(e);
    }
  });
}

function appendJournal(line, done) {
  fs.mkdir(path.dirname(JOURNAL_PATH), { recursive: true }, function (mkErr) {
    if (mkErr) return done(mkErr);
    fs.appendFile(JOURNAL_PATH, JSON.stringify(line) + '\n', done);
  });
}

function readJournal(done) {
  fs.readFile(JOURNAL_PATH, 'utf8', function (err, text) {
    if (err) return done([]);          // nothing recorded yet is not an error
    var rows = [];
    text.split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      try {
        var row = JSON.parse(line);
        if (row && typeof row === 'object') rows.push(row);
      } catch (e) { /* a line torn by a power cut; skip it */ }
    });
    done(rows);
  });
}

/* ---------- routing ---------- */

// Anything thrown while routing becomes a 500 for that one request instead of
// the end of the process. A phone in a supermarket reloading a page is not a
// reason for the server at home to stop serving.
function handler(req, res) {
  try {
    route(req, res);
  } catch (e) {
    console.error('request failed: ' + req.method + ' ' + req.url + ' — ' + e.message);
    try {
      send(res, 500, 'server error', { 'Content-Type': 'text/plain' });
    } catch (ignored) {
      // Headers already went out. Nothing to say; just do not take the process
      // down over it.
    }
  }
}

function route(req, res) {
  var bare = req.url.split('?')[0];

  /* Saving an item, and hiding one.
   *
   * Both only ever append a line. This server has no authentication and sits on
   * whatever network it is reachable from, so the worst anyone who reaches it
   * can do is add an entry to a list — nothing here can reach an existing row,
   * and nothing can destroy a record.
   */
  if (req.method === 'POST' && (bare === '/api/items' || bare === '/api/items/mark')) {
    /* JSON only, and this is a security check rather than a formality.
     *
     * A cross-origin POST carrying Content-Type: text/plain is a "simple
     * request": the browser sends it without a preflight, so any page on the
     * internet you happened to open while your phone was on the tailnet could
     * write rows into this journal. Measured, not theorised — it worked.
     *
     * Requiring application/json makes such a request non-simple, so the
     * browser must ask permission first with an OPTIONS preflight, which this
     * server answers with 405 and no CORS headers. That is a refusal, and the
     * write never leaves the browser.
     *
     * It stops a *browser* being used as the weapon. Anyone who can reach this
     * port directly can still append — there is no authentication here, which
     * is why it belongs on a tailnet and not on the open internet. Appending is
     * also the worst they can do: nothing here rewrites or deletes a row.
     */
    var ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (ctype.indexOf('application/json') !== 0) {
      return sendJson(res, 415, { ok: false, error: 'send application/json' });
    }

    var mark = bare === '/api/items/mark';
    return readJsonBody(req, function (err, body) {
      if (err || !body) return sendJson(res, 400, { ok: false, error: 'bad body' });
      var now = Date.now();
      var result = mark ? Journal.sanitizeMark(body, now) : Journal.sanitize(body, now);
      if (result.error) return sendJson(res, 400, { ok: false, error: result.error });
      appendJournal(result.item, function (writeErr) {
        if (writeErr) return sendJson(res, 500, { ok: false, error: writeErr.message });
        sendJson(res, 200, { ok: true, item: result.item });
      });
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'method not allowed', { 'Content-Type': 'text/plain' });
  }

  var pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname);
  } catch (e) {
    return send(res, 400, 'bad request', { 'Content-Type': 'text/plain' });
  }

  // A percent-encoded NUL survives decodeURIComponent as a real \0, and every
  // check below it is string work that lets it through: path.resolve keeps it
  // and ROOT-containment still matches. It then reaches fs.realpath, which
  // validates its argument synchronously and throws. No file has a NUL in its
  // name, so there is nothing here to serve and nothing lost by refusing early.
  if (pathname.indexOf('\0') !== -1) {
    return send(res, 400, 'bad request', { 'Content-Type': 'text/plain' });
  }

  // What this server knows about itself. The page uses it to tell you *why*
  // the camera will not open and what address to use instead, which over a
  // tailnet is the difference between a fixable problem and a mystery.
  if (pathname === '/api/status') {
    return sendJson(res, 200, {
      app: 'CalCalc',
      httpPort: PORT,
      httpsPort: tls ? HTTPS_PORT : null,
      https: !!tls,
      tailscale: {
        hostname: tailnet.name,
        source: tailnet.source || null,
        // The address that actually reaches THIS app over HTTPS, or null.
        // Never assembled from the hostname — see findServeMount.
        serveUrl: serveMount ? serveMount.url : null,
        servePath: serveMount ? serveMount.path : null
      },
      addresses: lanAddresses(),
      // Whether the request itself arrived somewhere the camera can be opened.
      // The browser knows this too (isSecureContext), but only the server can
      // say what the working address would be.
      secure: !!req.socket.encrypted
    });
  }

  // Everything saved. The file lives under data/, which the static handler
  // refuses outright, and it stays that way — this returns rows and nothing
  // else, so no path is ever taken from the request.
  if (pathname === '/api/items' || pathname === '/api/items.csv') {
    var q = url.parse(req.url, true).query || {};
    var withHidden = q.hidden === '1';
    return readJournal(function (rows) {
      var items = Journal.collapse(rows);
      var hidden = items.filter(function (r) { return r.hidden; }).length;
      // Hidden rows are still on disk — nothing here deletes — but they are out
      // of the list and the export unless asked for by name.
      if (!withHidden) items = items.filter(function (r) { return !r.hidden; });

      if (pathname === '/api/items.csv') {
        return send(res, 200, Journal.toCsv(items), {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="calcalc-items.csv"'
        });
      }
      sendJson(res, 200, { count: items.length, hidden: hidden, items: items });
    });
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve first, then confirm the result is still inside ROOT, so "..", an
  // encoded traversal and an absolute path all fail the same way.
  var file = path.resolve(ROOT, '.' + pathname);
  if ((file !== ROOT && !file.startsWith(ROOT + path.sep)) || isPrivate(pathname)) {
    return send(res, 403, 'forbidden', { 'Content-Type': 'text/plain' });
  }

  // ...and again after following links. Resolving the *path* proves nothing
  // about where a symlink inside ROOT actually points, and a lexical check
  // alone would happily serve whatever it aims at.
  fs.realpath(file, function (linkErr, real) {
    if (linkErr) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
    if (real !== ROOT && !real.startsWith(ROOT + path.sep)) {
      return send(res, 403, 'forbidden', { 'Content-Type': 'text/plain' });
    }
    serveFile(req, res, real);
  });
}

function serveFile(req, res, file) {
  fs.stat(file, function (err, stat) {
    if (err || !stat.isFile()) {
      return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
    }
    var headers = {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    };
    if (req.method === 'HEAD') return send(res, 200, '', headers);

    res.writeHead(200, headers);
    var stream = fs.createReadStream(file);
    stream.on('error', function () { res.destroy(); });
    stream.pipe(res);
  });
}

/* ---------- listening ---------- */

// Browsers gate the camera, the home-screen install and service workers behind
// a secure context, so over plain http on a LAN address the scanner cannot open
// a camera at all.
//
// Certificates are found on disk rather than configured, because the usual way
// this runs is a process manager invoking Start.sh — there is no shell in which
// to set an environment variable. Drop a pair in ./ssl (npm run cert) and https
// starts appearing on the next restart, alongside http rather than instead of
// it, so nothing that already points at the http port breaks.
function findCert() {
  var cert = process.env.SSL_CERT || path.join(SSL_DIR, 'cert.pem');
  var key = process.env.SSL_KEY || path.join(SSL_DIR, 'key.pem');
  try {
    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key), certPath: cert };
  } catch (e) {
    return null;
  }
}

// A listener that cannot bind must not take the other one down with it. The
// https port failing is an inconvenience; the process dying under a supervisor
// that restarts it is a loop.
function listen(server, port, label, fatal, onReady) {
  server.on('error', function (err) {
    var why = err.code === 'EADDRINUSE' ? 'port ' + port + ' is already in use' : err.message;
    console.error('\ncould not start ' + label + ': ' + why);
    if (fatal) process.exit(1);
    console.error(label + ' is off; the rest of the server is still running.');
  });
  server.listen(port, HOST, onReady);
}

var tls = findCert();

function start() {
listen(http.createServer(handler), PORT, 'http', true, function () {
  console.log('CalCalc serving ' + ROOT);
  console.log('  http://localhost:' + PORT + '/');
  lanAddresses().forEach(function (ip) {
    console.log('  http://' + ip + ':' + PORT + '/');
  });

  if (tls) {
    listen(https.createServer({ cert: tls.cert, key: tls.key }, handler),
           HTTPS_PORT, 'https', false, function () {
      console.log('\nhttps using ' + tls.certPath);
      lanAddresses().forEach(function (ip) {
        console.log('  https://' + ip + ':' + HTTPS_PORT + '/');
      });
    });
  }

  // Printed last, because it is the line worth reading. Everything above is an
  // address the camera will refuse to open on.
  findTailnetName(function (ts) {
    findServeMount(PORT, function (mount) {
      serveMount = mount;
      printAdvice(ts, mount);
    });
  });
});
}

// Serving is what happens when this file is the program. When it is required —
// by tests/serve.test.js, to check the mount mapping against real CLI output —
// nothing binds a port.
if (require.main === module) start();
module.exports = { pickServeMount: pickServeMount };

function printAdvice(ts, mount) {
    console.log('');
    if (mount) {
      console.log('Tailscale: this app is served at');
      console.log('');
      console.log('      ' + mount.url);
      console.log('');
      console.log('  Open that on the phone — a real certificate, nothing to install,');
      console.log('  and the camera works from anywhere on the tailnet.');
    } else if (ts.name) {
      console.log('Tailscale: ' + ts.name + (ts.source === 'environment' ? ' (from the environment)' : ''));
      console.log('  Nothing is serving port ' + PORT + ' over HTTPS yet, so the camera will');
      console.log('  not open on the tailnet address. One command fixes it:');
      console.log('');
      console.log('      sudo tailscale serve --bg --https=8443 ' + PORT);
      console.log('      -> https://' + ts.name + ':8443/');
      console.log('');
      console.log('  That leaves port 443 alone. If nothing else is using the root of');
      console.log('  this machine, plain `sudo tailscale serve --bg ' + PORT + '` gives you');
      console.log('  https://' + ts.name + '/ instead — but check first:');
      console.log('');
      console.log('      tailscale serve status');
      console.log('');
      console.log('  Whatever is mounted on "/" owns that address, and this app will not');
      console.log('  be what a phone opening it gets.');
    } else if (tls) {
      console.log('No Tailscale here, but https is on. Open the https address above on');
      console.log('the phone and accept the warning once — that is a genuine secure');
      console.log('context, which is all the camera needs. See README.md for the');
      console.log('offline install, which needs ssl/ca.pem trusted as well.');
    } else {
      console.log('http only, so the camera will not open on any address above except');
      console.log('localhost. Two ways to fix it, in order of how little work they are:');
      console.log('');
      console.log('  1. Tailscale:  sudo tailscale serve --bg --https=8443 ' + PORT);
      console.log('     A real certificate, nothing to install on the phone.');
      console.log('  2. Local cert: npm run cert   (then restart; warns once)');
      console.log('');
      console.log('The ⌨ Type screen works anywhere, with no camera at all.');
    }
}
