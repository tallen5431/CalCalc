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
/* `rotate` is the small skew of a hand-held shot. `turn` is a quarter turn of
 * the whole package, which is a completely different thing: a panel printed on
 * the side of a box is side-on in the frame however steadily you hold the
 * phone, and sideways text yields the reader nothing whatsoever — not a poor
 * reading, no reading at all. Two of the four frames below are turned for that
 * reason. */
var VARIANTS = [
  { name: 'clean render', scale: 1, blur: 0, glare: 0, contrast: 1, rotate: 0, turn: 0 },
  { name: 'camera sim: slight angle + blur', scale: 1, blur: 1.1, glare: 0.18, contrast: 0.85, rotate: 4, turn: 0 },
  { name: 'camera sim: half resolution', scale: 0.5, blur: 0.8, glare: 0.12, contrast: 0.9, rotate: 2, turn: 0 },
  { name: 'camera sim: glare and low contrast', scale: 1, blur: 1.3, glare: 0.35, contrast: 0.7, rotate: -6, turn: 0 },
  { name: 'side-on package (90°)', scale: 1, blur: 0.9, glare: 0.15, contrast: 0.88, rotate: 3, turn: 90 },
  { name: 'side-on the other way (270°)', scale: 1, blur: 0.9, glare: 0.12, contrast: 0.9, rotate: -3, turn: 270 },
  { name: 'upside down (180°)', scale: 1, blur: 0.9, glare: 0.12, contrast: 0.9, rotate: 2, turn: 180 }
];

/* Both panel layouts. They are not variations on a theme — the linear one uses
 * different words ("Serv. size"), states its servings count without ever saying
 * "per container", measures in millilitres, and puts a comma after every number
 * because it is a list. Each of those broke the reader when only the table was
 * being tested against. */
var PANELS = [
  {
    name: 'tabular panel (FDA example)',
    fixture: '/tests/label-fixture.html',
    expected: {
      calories: 230, servingGrams: 55, servingsPerContainer: 8,
      fat: 8, carbs: 37, protein: 3
    },
    price: 4.99
  },
  {
    name: 'linear panel (gallon of milk)',
    fixture: '/tests/label-fixture-linear.html',
    expected: {
      calories: 150, servingGrams: 240, servingsPerContainer: 16,
      fat: 8, carbs: 12, protein: 8
    },
    price: 3.24
  }
];

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

  var errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });

  // Every panel is captured first, then all of them are run through one loaded
  // scanner page — the OCR engine takes a few seconds to start and there is no
  // reason to pay that twice.
  var captures = [];
  for (var pi = 0; pi < PANELS.length; pi++) {
    await page.goto(BASE + PANELS[pi].fixture, { waitUntil: 'load' });
    var shot = await page.locator('#panel').screenshot();
    captures.push('data:image/png;base64,' + shot.toString('base64'));
  }

  // Then drive the scanner page, which is the code that actually ships.
  await page.goto(BASE + '/scan.html', { waitUntil: 'load' });
  await page.waitForFunction('window.__scan && window.__scan.ready()', null, { timeout: 120000 });

  var runs = [];
  for (var pj = 0; pj < PANELS.length; pj++) {
    var results = [];
    for (var i = 0; i < VARIANTS.length; i++) {
      var v = VARIANTS[i];
      var degraded = await page.evaluate(degradeInPage, { src: captures[pj], v: v });
      var t = Date.now();
      var out = await page.evaluate(function (src) { return window.__scan.readImage(src); }, degraded);
      results.push({ variant: v.name, out: out, wall: Date.now() - t });
    }
    runs.push({ panel: PANELS[pj], results: results });
  }

  await browser.close();

  /* ---------- report ---------- */

  var failed = 0, total = 0;
  console.log('\nEnd-to-end: rendered panel -> canvas -> Tesseract -> parser -> metrics');

  runs.forEach(function (run) {
    var expected = run.panel.expected;
    console.log('\n' + run.panel.name);

    run.results.forEach(function (r) {
      total++;
      var p = r.out.parsed;
      var m = r.out.metrics;
      var wrong = [], missing = [];
      Object.keys(expected).forEach(function (k) {
        if (p[k] === null || p[k] === undefined) {
          // Absent is only a failure for the two fields the headline needs.
          if (REQUIRED.indexOf(k) !== -1) wrong.push(k + ' missing');
          else missing.push(k);
        } else if (p[k] !== expected[k]) {
          wrong.push(k + '=' + p[k] + ' (want ' + expected[k] + ')');
        }
      });

      var ok = wrong.length === 0;
      if (!ok) failed++;

      // The unit comes off the reading rather than being assumed: one of these
      // panels measures its serving in millilitres, and printing "g" over it
      // would make the harness the first thing lying about the answer.
      var unit = m.perGramUnit;
      console.log((ok ? '  PASS  ' : '  FAIL  ') + r.variant);
      console.log('        ' + r.out.ms + 'ms in the reader, ' + r.wall + 'ms end to end');
      console.log('        calories ' + p.calories + ' · serving ' + p.servingGrams + unit +
                  ' · ' + p.servingsPerContainer + ' servings');
      console.log('        ' + fmt(m.caloriesPerGram, 2) + ' cal/' + unit +
                  ' · container ' + fmt(m.totalCalories, 0) + ' cal');
      var flags = [];
      if (p.caloriesConfirmed) flags.push('macros confirm the headline');
      if (p.caloriesCorrected) flags.push('CALORIES CORRECTED');
      if (p.servingCorrected) flags.push('SERVING CORRECTED');
      if (p.caloriesDisagree) flags.push('MACROS DISAGREE');
      if (p.caloriesFromMacros) flags.push('calories came from the macros');
      if (p.servingUnitInferred) flags.push('unit assumed');
      if (p.densityUncertain) flags.push('DENSITY UNCERTAIN');
      if (r.out.rotation) flags.push('turned ' + r.out.rotation + '° to read it');
      if (flags.length) console.log('        ' + flags.join(' · '));
      // Named, not hidden. A frame that quietly dropped half the panel while
      // reporting a pass is how a harness stops being evidence of anything.
      if (missing.length) console.log('        not read (allowed, app asks for these): ' + missing.join(', '));
      if (wrong.length) console.log('        WRONG: ' + wrong.join(', '));
      // E2E_DEBUG=1 prints what the reader actually handed the parser. When a
      // panel will not read, this is the only thing that says whether the
      // problem is the camera, the engine or the patterns.
      if (process.env.E2E_DEBUG) console.log('        text: ' + p.text);
      console.log('');
    });

    // The price arithmetic, on the panel's real figures. This is the half of
    // the app the parser suite proves and a camera cannot.
    var totalCal = expected.calories * expected.servingsPerContainer;
    console.log('  At $' + run.panel.price.toFixed(2) + ' a package: ' + totalCal +
                ' cal  ->  ' + fmt(totalCal / run.panel.price, 0) + ' cal/$  ·  $' +
                fmt(run.panel.price / (totalCal / 1000), 2) + ' per 1000 cal');
  });

  if (errors.length) {
    console.log('\n  Page errors:');
    errors.forEach(function (e) { console.log('    ' + e); });
    failed++;
  }

  console.log('\n' + (total - failed) + '/' + total + ' reads correct across ' +
              runs.length + ' panel layouts');
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
      var turn = v.turn || 0;
      var quarter = (turn === 90 || turn === 270);
      // Room for the rotation to swing the corners out without clipping them.
      var pad = Math.round(Math.max(w, h) * 0.12);
      var c = document.createElement('canvas');
      c.width = (quarter ? h : w) + pad * 2;
      c.height = (quarter ? w : h) + pad * 2;
      var g = c.getContext('2d');

      g.fillStyle = '#c9c9c9';        // the shelf behind the package
      g.fillRect(0, 0, c.width, c.height);

      g.save();
      g.translate(c.width / 2, c.height / 2);
      g.rotate((v.rotate + turn) * Math.PI / 180);
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
