#!/usr/bin/env node
/* Drives the real browser pipeline — canvas preprocessing, Tesseract, the
 * parser, the arithmetic — against rendered panels, including ones degraded
 * the way a phone camera degrades them.
 *
 *   node tests/e2e.js
 *
 * Needs Playwright and a running server:
 *
 *   npx playwright install chromium     # once, if it is not already there
 *   npm start &                         # or PORT=8765 npm start
 *   E2E_URL=http://localhost:8090 node tests/e2e.js
 *
 * Left out of `npm test` on purpose: that has to stay a zero-install command,
 * and this one needs a browser. The parser suite covers the reading logic; this
 * covers everything around it that only exists inside a browser.
 */

'use strict';

var BASE = process.env.E2E_URL || 'http://localhost:8090';

var chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  console.error('Playwright is not installed here.\n' +
    '  npm i -D playwright && npx playwright install chromium\n' +
    'The parser suite (npm test) needs neither.');
  process.exit(2);
}

/* Degradations, applied to the rendered panel on a canvas before the reader
 * ever sees it. Each one is something a phone actually does to a label: it is
 * held at an angle, it is not quite in focus, and the shelf light glares off
 * the packaging. */
var VARIANTS = [
  { name: 'clean render', scale: 1, blur: 0, glare: 0, contrast: 1, rotate: 0 },
  { name: 'camera sim: slight angle + blur', scale: 1, blur: 1.1, glare: 0.18, contrast: 0.85, rotate: 4 },
  { name: 'camera sim: half resolution', scale: 0.5, blur: 0.8, glare: 0.12, contrast: 0.9, rotate: 2 },
  { name: 'camera sim: glare and low contrast', scale: 1, blur: 1.3, glare: 0.35, contrast: 0.7, rotate: -6 }
];

var EXPECTED = {
  calories: 230,
  servingGrams: 55,
  servingsPerContainer: 8,
  fat: 8, carbs: 37, protein: 3
};

/* The contract this harness holds the reader to, and the distinction the whole
 * app is built on: **a missing number is acceptable, a wrong one is not.**
 *
 * REQUIRED is the headline — calories and the weight they are per. Without
 * both there is no calories-per-gram and no reason to have pointed a camera at
 * anything, so every frame must produce them.
 *
 * Everything else may come back null on a bad frame and the app copes: it says
 * what it is missing and offers a box to type it into. What none of it may
 * ever do is come back *wrong*, because a wrong servings count silently
 * multiplies straight through into calories per dollar, which is the number
 * being used to choose between two boxes on a shelf.
 *
 * The glare frame is the case in point. It reads "g servings per container" —
 * the 8 collapsed into a g. The lookalike table would happily turn that into a
 * 9, and a 9 there means every container figure is out by an eighth with
 * nothing on screen admitting it. It is left null instead, and that is a pass.
 */
var REQUIRED = ['calories', 'servingGrams'];

var PRICE = 4.99;

(async function () {
  // A Chromium already on the machine is used when it is pointed at. Playwright
  // pins an exact build number and refuses anything else, which on a host that
  // already ships a browser means downloading a second copy of it to run four
  // screenshots.
  var launchOpts = {};
  if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
  var browser = await chromium.launch(launchOpts);
  // deviceScaleFactor is doing real work here. The fixture lays the panel out
  // at 320 CSS px, which is roughly its physical size on a box — but a phone
  // filling its reticle with that panel hands the reader something closer to a
  // thousand pixels across, and testing against a 320px capture measures a
  // camera nobody owns. At 3x the render is ~960px wide, which is what the
  // scanner actually sees.
  var ctx = await browser.newContext({
    viewport: { width: 900, height: 1400 },
    deviceScaleFactor: 3
  });
  var page = await ctx.newPage();

  // Render the fixture and take the panel's own pixels.
  await page.goto(BASE + '/tests/label-fixture.html', { waitUntil: 'load' });
  var shot = await page.locator('#panel').screenshot();
  var pngDataUrl = 'data:image/png;base64,' + shot.toString('base64');

  // Then drive the scanner page, which is the code that actually ships.
  var errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await page.goto(BASE + '/scan.html', { waitUntil: 'load' });
  await page.waitForFunction('window.__scan && window.__scan.ready()', null, { timeout: 120000 });

  var results = [];
  for (var i = 0; i < VARIANTS.length; i++) {
    var v = VARIANTS[i];
    var degraded = await page.evaluate(degradeInPage, { src: pngDataUrl, v: v });
    var t = Date.now();
    var out = await page.evaluate(function (src) { return window.__scan.readImage(src); }, degraded);
    results.push({ variant: v.name, out: out, wall: Date.now() - t });
  }

  await browser.close();

  /* ---------- report ---------- */

  var failed = 0;
  console.log('\nEnd-to-end: rendered panel -> canvas -> Tesseract -> parser -> metrics\n');

  results.forEach(function (r) {
    var p = r.out.parsed;
    var m = r.out.metrics;
    var wrong = [], missing = [];
    Object.keys(EXPECTED).forEach(function (k) {
      if (p[k] === null || p[k] === undefined) {
        // Absent is only a failure for the two fields the headline needs.
        if (REQUIRED.indexOf(k) !== -1) wrong.push(k + ' missing');
        else missing.push(k);
      } else if (p[k] !== EXPECTED[k]) {
        wrong.push(k + '=' + p[k] + ' (want ' + EXPECTED[k] + ')');
      }
    });

    var ok = wrong.length === 0;
    if (!ok) failed++;

    console.log((ok ? '  PASS  ' : '  FAIL  ') + r.variant);
    console.log('        ' + r.out.ms + 'ms in the reader, ' + r.wall + 'ms end to end');
    console.log('        calories ' + p.calories + ' · serving ' + p.servingGrams + 'g · ' +
                p.servingsPerContainer + ' servings');
    console.log('        ' + fmt(m.caloriesPerGram, 2) + ' cal/' + m.perGramUnit +
                ' · container ' + fmt(m.totalCalories, 0) + ' cal');
    var flags = [];
    if (p.caloriesConfirmed) flags.push('macros confirm the headline');
    if (p.caloriesCorrected) flags.push('CALORIES CORRECTED');
    if (p.servingCorrected) flags.push('SERVING CORRECTED');
    if (p.caloriesDisagree) flags.push('MACROS DISAGREE');
    if (p.caloriesFromMacros) flags.push('calories came from the macros');
    if (p.densityUncertain) flags.push('DENSITY UNCERTAIN');
    if (flags.length) console.log('        ' + flags.join(' · '));
    // Named, not hidden. A frame that quietly dropped half the panel while
    // reporting a pass is how a harness stops being evidence of anything.
    if (missing.length) console.log('        not read (allowed, app asks for these): ' + missing.join(', '));
    if (wrong.length) console.log('        WRONG: ' + wrong.join(', '));
    // E2E_DEBUG=1 prints what the reader actually handed the parser. When a
    // panel will not read, this is the only thing that says whether the problem
    // is the camera, the engine or the patterns.
    if (process.env.E2E_DEBUG) console.log('        text: ' + p.text);
    console.log('');
  });

  // The price arithmetic, on the best read available. This is the half of the
  // app the parser suite proves and the camera cannot.
  var good = results.filter(function (r) { return r.out.parsed.complete; })[0];
  if (good) {
    var m = good.out.metrics;
    var expectTotal = EXPECTED.calories * EXPECTED.servingsPerContainer;
    console.log('  With a $' + PRICE.toFixed(2) + ' package price:');
    console.log('    container ' + expectTotal + ' cal  ->  ' +
                fmt(expectTotal / PRICE, 0) + ' cal/$  ·  $' +
                fmt(PRICE / (expectTotal / 1000), 2) + ' per 1000 cal');
    console.log('');
  }

  if (errors.length) {
    console.log('  Page errors:');
    errors.forEach(function (e) { console.log('    ' + e); });
    failed++;
  }

  console.log((results.length - failed) + '/' + results.length + ' variants read correctly');
  process.exit(failed ? 1 : 0);
}()).catch(function (e) {
  console.error(e);
  process.exit(1);
});

function fmt(n, d) {
  return (n === null || n === undefined || !isFinite(n)) ? '--' : n.toFixed(d);
}

/* Runs inside the page: redraws the panel through the distortions a lens and a
   shelf light apply, and hands back a data URL. */
function degradeInPage(args) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onerror = reject;
    img.onload = function () {
      var v = args.v;
      var w = Math.round(img.width * v.scale);
      var h = Math.round(img.height * v.scale);
      // Room for the rotation to swing the corners out without clipping them.
      var pad = Math.round(Math.max(w, h) * 0.12);
      var c = document.createElement('canvas');
      c.width = w + pad * 2;
      c.height = h + pad * 2;
      var g = c.getContext('2d');

      g.fillStyle = '#c9c9c9';        // the shelf behind the package
      g.fillRect(0, 0, c.width, c.height);

      g.save();
      g.translate(c.width / 2, c.height / 2);
      g.rotate(v.rotate * Math.PI / 180);
      if (v.blur) g.filter = 'blur(' + v.blur + 'px) contrast(' + v.contrast + ')';
      else if (v.contrast !== 1) g.filter = 'contrast(' + v.contrast + ')';
      g.drawImage(img, -w / 2, -h / 2, w, h);
      g.restore();

      if (v.glare) {
        // A diagonal blown-out band, which is what a ceiling light does to
        // glossy packaging.
        var grad = g.createLinearGradient(0, 0, c.width, c.height);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.45, 'rgba(255,255,255,' + v.glare + ')');
        grad.addColorStop(0.6, 'rgba(255,255,255,' + (v.glare * 0.6) + ')');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, c.width, c.height);
      }

      resolve(c.toDataURL('image/jpeg', 0.9));
    };
    img.src = args.src;
  });
}
