#!/usr/bin/env node
/* Checks the label parser against panels as OCR actually delivers them:
   flattened to one line, in whatever order the engine read the table, with
   lookalike characters and lost decimal points.

   node tests/parser.test.js        — no browser and no dependencies needed
*/

'use strict';

var LabelParser = require('../label-parser.js');

var passed = 0, failed = 0;

function check(name, actual, expected, tolerance) {
  var ok;
  if (typeof expected === 'number' && typeof actual === 'number') {
    ok = Math.abs(actual - expected) <= (tolerance === undefined ? 0.01 : tolerance);
  } else {
    ok = actual === expected;
  }
  if (ok) {
    passed++;
  } else {
    failed++;
    console.log('  FAIL  ' + name + '\n        expected ' + expected + ', got ' + actual);
  }
}

function group(name, fn) {
  console.log('\n' + name);
  fn();
}

/* ---------- the reference panel ----------
   The FDA's own example panel, which is the one on every "what's different
   about the new label" explainer: 8 servings, 2/3 cup (55g), 230 calories.
   Its macros are 8g fat / 37g carb / 3g protein = 232 kcal by Atwater, which
   is what makes it a good check on the cross-check itself. */

var FDA_PANEL =
  'Nutrition Facts 8 servings per container Serving size 2/3 cup (55g) ' +
  'Amount per serving Calories 230 % Daily Value* Total Fat 8g 10% ' +
  'Saturated Fat 1g 5% Trans Fat 0g Cholesterol 0mg 0% Sodium 160mg 7% ' +
  'Total Carbohydrate 37g 13% Dietary Fiber 4g 14% Total Sugars 12g ' +
  'Includes 10g Added Sugars 20% Protein 3g Vitamin D 2mcg 10% ' +
  'Calcium 260mg 20% Iron 8mg 45% Potassium 240mg 6%';

group('the reference panel', function () {
  var p = LabelParser.parse(FDA_PANEL);
  check('calories', p.calories, 230);
  check('serving grams', p.servingGrams, 55);
  check('servings per container', p.servingsPerContainer, 8);
  check('fat', p.fat, 8);
  check('carbs', p.carbs, 37);
  check('protein', p.protein, 3);
  check('fiber', p.fiber, 4);
  check('sugars', p.sugars, 12);
  check('complete', p.complete, true);
  check('calories per gram', p.caloriesPerGram, 230 / 55, 0.001);
  check('atwater prediction', p.atwaterCalories, 232);
  check('macros confirm the headline', p.caloriesConfirmed, true);
  check('nothing corrected', p.caloriesCorrected, false);
  check('no disagreement', p.caloriesDisagree, false);

  var m = LabelParser.metrics(p, { price: 4.99 });
  check('total grams', m.totalGrams, 440);
  check('total calories', m.totalCalories, 1840);
  check('calories per dollar', m.caloriesPerDollar, 1840 / 4.99, 0.01);
  check('dollars per 1000 kcal', m.dollarsPerThousandCalories, 4.99 / 1.84, 0.01);
  check('cost per serving', m.costPerServing, 4.99 / 8, 0.001);
  check('container basis', m.containerBasis, 'servings');
  check('band', m.band, 'high');
});

/* ---------- what the camera actually hands over ---------- */

group('OCR damage', function () {
  // Lookalike characters inside numbers: O for 0, S for 5, l for 1.
  var p = LabelParser.parse(
    'Nutrition Facts 8 servings per container Serving size 2/3 cup (5Sg) ' +
    'Calories 23O Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('O read as zero in calories', p.calories, 230);
  check('S read as five in grams', p.servingGrams, 55);

  // The panel read out of order — engines do this on a multi-column crop.
  var q = LabelParser.parse(
    'Protein 3g Total Carbohydrate 37g Total Fat 8g Calories 230 ' +
    'Serving size 2/3 cup (55g) 8 servings per container');
  check('order does not matter: calories', q.calories, 230);
  check('order does not matter: grams', q.servingGrams, 55);
  check('order does not matter: servings', q.servingsPerContainer, 8);

  // Glued-together words and missing punctuation.
  var r = LabelParser.parse('Servings Per Container About 12 Serving Size 30g Calories 140 ' +
                            'Total Fat 7g Total Carb. 17g Protein 2g');
  check('servings after the words', r.servingsPerContainer, 12);
  check('serving size with no parentheses', r.servingGrams, 30);
  check('abbreviated carbohydrate', r.carbs, 17);
});

group('numbers that must never be mistaken for calories', function () {
  // The old (pre-2016) panel carries a second calorie figure. Reading it as
  // the headline turns 230 calories into 120 — half the truth, confidently.
  var p = LabelParser.parse(
    'Serving Size 55g Servings Per Container 8 Amount Per Serving ' +
    'Calories 230 Calories from Fat 120 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('calories from fat is not the headline', p.calories, 230);

  // The calorie figure is followed on every current panel by "% Daily Value".
  // An earlier attempt to keep percentages out of the calorie line refused a
  // match followed by "%", which only made the regex backtrack and return a
  // complete, plausible, ten-times-too-small "23" from a line it had read
  // perfectly. The macros happened to rescue it, which is exactly why it is
  // pinned here: a guard that turns a good read into a bad one is worse than no
  // guard, and it only showed up as a stray "corrected" flag.
  var pct = LabelParser.parse('Amount per serving Calories 230 % Daily Value* ' +
                              'Serving size (55g) Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('the whole number is read, not a prefix of it', pct.caloriesRead, 230);
  check('so no correction is needed', pct.caloriesCorrected, false);

  // A panel with no calorie word at all should not invent one from the
  // percentages and milligrams that fill the rest of the table.
  var q = LabelParser.parse('Sodium 160mg 7% Calcium 260mg 20% Iron 8mg 45% Potassium 240mg 6%');
  check('no calorie line, no calories', q.calories, null);
  check('and therefore not complete', q.complete, false);

  // The unit letter is the character this panel loses most reliably: a
  // lowercase "g" is a closed loop with a descender and comes back as a "9".
  // Measured, not assumed — the end-to-end harness reads the reference panel's
  // "(55g)" back as "(559)" on a clean render, every single time. Without this
  // the serving size is simply never found and the app has no headline at all.
  var g9 = LabelParser.parse(
    'Serving size 2/3 cup (559) Calories 230 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('a "g" read as "9" is still a g', g9.servingGrams, 55);
  check('and the guess is reported', g9.servingUnitInferred, true);
  check('so the density comes out right', g9.caloriesPerGram, 230 / 55, 0.001);

  // The same for "q", the other shape a "g" collapses into.
  var gq = LabelParser.parse('Serving size (28q) Calories 150 Total Fat 10g ' +
                             'Total Carbohydrate 15g Protein 2g');
  check('a "q" read for a "g"', gq.servingGrams, 28);

  // A real unit must not be reported as a guess.
  var real = LabelParser.parse('Serving size (55g) Calories 230 Total Fat 8g ' +
                               'Total Carbohydrate 37g Protein 3g');
  check('a unit that was actually read is not flagged', real.servingUnitInferred, false);

  // Millilitres still win over the lookalike rule — the letters are there.
  var ml = LabelParser.parse('Serving size 1 cup (240ml) Calories 120 Total Fat 5g ' +
                             'Total Carbohydrate 12g Protein 8g');
  check('millilitres are not swallowed by the g rule', ml.servingGrams, 240);
  check('and keep their unit', ml.servingUnit, 'ml');

  // "2/3 cup" is two numbers in front of the weight. Neither is the weight.
  var r = LabelParser.parse('Serving size 2/3 cup (55g) Calories 230 ' +
                            'Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('the household measure is not the weight', r.servingGrams, 55);

  // "about 12 chips (28g)" — the count is not the weight either.
  var s = LabelParser.parse('Serving size about 12 chips (28g) Calories 150 ' +
                            'Total Fat 10g Total Carbohydrate 15g Protein 2g');
  check('a piece count is not the weight', s.servingGrams, 28);
});

/* ---------- the guards ----------
   These are the reason the app can be pointed at a shelf rather than only at
   a screenshot: a wrong number that announces itself is recoverable, and a
   wrong number that does not is what makes a scanner useless. */

group('the macro cross-check', function () {
  // A digit gained in the calorie figure: 230 read as 2300. The macros say
  // 232, so exactly one power of ten fits and the correction is made.
  var p = LabelParser.parse(
    'Serving size (55g) Calories 2300 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('a gained digit is recovered', p.calories, 230);
  check('and the recovery is reported', p.caloriesCorrected, true);

  // A digit lost: 230 read as 23.
  var q = LabelParser.parse(
    'Serving size (55g) Calories 23 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('a lost digit is recovered', q.calories, 230);
  check('and reported', q.caloriesCorrected, true);

  // Macros that cannot be reconciled with the headline by any power of ten.
  // Nothing is corrected and nothing is hidden — the reading is flagged.
  var r = LabelParser.parse(
    'Serving size (55g) Calories 500 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('an irreconcilable headline is kept', r.calories, 500);
  check('and flagged as disagreeing', r.caloriesDisagree, true);
  check('never silently corrected', r.caloriesCorrected, false);

  // No calorie line, but the macros are all there. The figure is usable and
  // must be labelled as having come from the macros rather than the panel.
  var s = LabelParser.parse(
    'Serving size (55g) Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('macros stand in for a missing headline', s.calories, 232);
  check('and say where the number came from', s.caloriesFromMacros, true);

  // Rounding on a real panel: 4g fat, 20g carb, 4g protein predicts 132 but
  // the panel says 130. That is normal and must not be "corrected".
  var t = LabelParser.parse(
    'Serving size (40g) Calories 130 Total Fat 4g Total Carbohydrate 20g Protein 4g');
  check('ordinary rounding is left alone', t.calories, 130);
  check('and counts as confirmation', t.caloriesConfirmed, true);

  // A serving too small for the macro lines to resolve: every line rounds to
  // 0g or 1g, so the check cannot confirm or refute and must not try.
  var u = LabelParser.parse(
    'Serving size (240ml) Calories 5 Total Fat 0g Total Carbohydrate 1g Protein 0g');
  check('a tiny serving is not second-guessed', u.calories, 5);
  check('and is not flagged', u.caloriesDisagree, false);
});

group('the density guard', function () {
  // Nothing edible exceeds 9 kcal/g. A serving weight read as 5g instead of
  // 55g makes a breakfast cereal denser than lard; the digit is restored.
  var p = LabelParser.parse(
    'Serving size (5g) Calories 230 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('a dropped digit in the weight is restored', p.servingGrams, 50);
  check('and reported', p.servingCorrected, true);
  check('the density is now believable', p.caloriesPerGram < 9.5, true);

  // Pure fat is exactly 9 kcal/g and real. It must survive the guard.
  var q = LabelParser.parse(
    'Serving size 1 Tbsp (14g) Calories 126 Total Fat 14g Total Carbohydrate 0g Protein 0g');
  check('cooking oil is not rejected', q.caloriesPerGram, 9, 0.01);
  check('and is complete', q.complete, true);

  // A weight that cannot be rescued by any power of ten: the density is not
  // shown at all rather than shown wrong.
  var r = LabelParser.parse('Serving size (2g) Calories 1500');
  check('an unrescuable weight yields no density', r.caloriesPerGram, null);
  check('and says so', r.densityUncertain, true);
  check('and is not complete', r.complete, false);

  // Water and diet drinks really are near zero. The low end is not a misread.
  var s = LabelParser.parse(
    'Serving size (355ml) Calories 0 Total Fat 0g Total Carbohydrate 0g Protein 0g');
  check('a zero-calorie drink parses', s.servingGrams, 355);
  check('with no density complaint', s.densityUncertain, false);
});

group('units', function () {
  // Millilitres are never converted to grams — that would need a density the
  // panel does not give. The number is reported per millilitre and labelled.
  var p = LabelParser.parse('Serving size 1 cup (240mL) Calories 120 ' +
                            'Total Fat 5g Total Carbohydrate 12g Protein 8g');
  check('millilitres stay millilitres', p.servingGrams, 240);
  check('and are labelled as such', p.servingUnit, 'ml');
  var m = LabelParser.metrics(p, {});
  check('the display unit follows', m.perGramUnit, 'mL');

  // Ounces are converted, because that is a fixed ratio and not a guess.
  var q = LabelParser.parse('Serving size 2 oz Calories 200 ' +
                            'Total Fat 8g Total Carbohydrate 25g Protein 6g');
  check('ounces become grams', q.servingGrams, 2 * 28.349523125, 0.001);
});

/* ---------- price ---------- */

group('price', function () {
  var p = LabelParser.parse(FDA_PANEL);

  // No price yet is a field waiting to be filled, not an error.
  var none = LabelParser.metrics(p, {});
  check('density without a price', none.caloriesPerGram, 230 / 55, 0.001);
  check('no price, no calories per dollar', none.caloriesPerDollar, null);
  check('still ready', none.ready, true);

  var m = LabelParser.metrics(p, { price: 4.99 });
  check('calories per dollar', m.caloriesPerDollar, 368.7375, 0.01);
  check('dollars per 1000 kcal', m.dollarsPerThousandCalories, 2.7120, 0.001);
  check('cost per 100g', m.costPer100g, 4.99 / 4.4, 0.001);

  // A container whose servings line was unreadable falls back to net weight.
  var q = LabelParser.parse(
    'Serving size (55g) Calories 230 Total Fat 8g Total Carbohydrate 37g ' +
    'Protein 3g NET WT 16 OZ (454g)');
  check('net weight is read', q.netWeightGrams, 454);
  var n = LabelParser.metrics(q, { price: 3.00 });
  check('the container total comes from net weight', n.containerBasis, 'netWeight');
  check('total calories from net weight', n.totalCalories, 454 * (230 / 55), 0.01);
  check('calories per dollar from net weight', n.caloriesPerDollar, 454 * (230 / 55) / 3, 0.01);

  // Neither servings nor net weight: the density still works, the container
  // figures cannot, and nothing is invented to fill the gap.
  var r = LabelParser.parse('Serving size (55g) Calories 230 Total Fat 8g ' +
                            'Total Carbohydrate 37g Protein 3g');
  var s = LabelParser.metrics(r, { price: 4.99 });
  check('density survives without a container size', s.caloriesPerGram, 230 / 55, 0.001);
  check('no container size, no calories per dollar', s.caloriesPerDollar, null);
  check('but cost per serving is still unknown', s.costPerServing, null);
  check('and the basis is named as absent', s.containerBasis, null);

  // A free price field is a place to type nonsense. Zero and negative are
  // divisions this app must never do.
  var zero = LabelParser.metrics(p, { price: 0 });
  check('a zero price divides nothing', zero.caloriesPerDollar, null);
  var neg = LabelParser.metrics(p, { price: -3 });
  check('a negative price divides nothing', neg.caloriesPerDollar, null);
});

group('hand corrections', function () {
  var p = LabelParser.parse(FDA_PANEL);

  // A person holding the box can see which line the camera got wrong. Every
  // parsed field can be overridden, and the overrides drive everything below.
  var m = LabelParser.metrics(p, { calories: 200, servingGrams: 50, price: 4.00, servingsPerContainer: 10 });
  check('overridden calories', m.calories, 200);
  check('overridden density', m.caloriesPerGram, 4);
  check('overridden container total', m.totalCalories, 2000);
  check('overridden calories per dollar', m.caloriesPerDollar, 500);

  // An empty input box is not a zero. Blanking a field falls back to the scan.
  var blank = LabelParser.metrics(p, { calories: '', price: 4.99 });
  check('a blank field falls back to the scan', blank.calories, 230);

  // Overrides arrive from input boxes, so they arrive as strings.
  var str = LabelParser.metrics(p, { price: '4.99', servingGrams: '55' });
  check('a string price is a price', str.caloriesPerDollar, 1840 / 4.99, 0.01);
});

/* ---------- nothing at all ---------- */

group('empty and hostile input', function () {
  [null, undefined, '', '   ', 'no numbers here at all',
   '%%%% ### $$$$', '0000000000'].forEach(function (input, i) {
    var p = LabelParser.parse(input);
    check('junk input ' + i + ' is not complete', p.complete, false);
    var m = LabelParser.metrics(p, { price: 5 });
    check('junk input ' + i + ' yields no density', m.caloriesPerGram, null);
    check('junk input ' + i + ' yields no rate', m.caloriesPerDollar, null);
  });

  // metrics() must survive being handed nothing, because the display calls it
  // on every frame including the ones before the first successful read.
  var m = LabelParser.metrics(null, {});
  check('no parse at all is survivable', m.ready, false);
  check('and yields nothing', m.caloriesPerGram, null);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
