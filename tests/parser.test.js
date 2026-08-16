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

/* ---------- the other panel ----------
   Small packages and gallon jugs do not have room for the table, so they print
   the same information as one running sentence. It is a different layout with
   different abbreviations, and every one of the checks below failed before this
   format was handled. From a Great Value whole milk gallon. */

var LINEAR_PANEL =
  'Nutrition Facts Servings: 16, Serv. size: 1 cup (240mL), ' +
  'Amount per serving: Calories 150, Total Fat 8g (10% DV), Sat. Fat 5g (25% DV), ' +
  'Trans Fat 0g, Cholest. 35mg (11% DV), Sodium 120mg (5% DV), ' +
  'Total Carb. 12g (4% DV), Fiber 0g (0% DV), Total Sugars 11g (Incl. 0g Added Sugars, 0% DV), ' +
  'Protein 8g, Vit. D (10% DV), Calcium (20% DV), Iron (0% DV), Potas. (8% DV), ' +
  'Vit. A (10% DV). % DV = % Daily Value';

group('the linear panel (a gallon of milk)', function () {
  var p = LabelParser.parse(LINEAR_PANEL);

  // The calorie figure is followed by a comma here, because the panel is a
  // list. Refusing a number followed by "." or "," — which is how a decimal
  // point was kept out — refused this one too, and the reading silently fell
  // back to totting up the macros.
  check('calories are read from the line', p.caloriesRead, 150);
  check('not reconstructed from the macros', p.caloriesFromMacros, false);
  check('and the macros confirm them', p.caloriesConfirmed, true);

  // "Serv. size", not "Serving size".
  check('the abbreviated serving line is found', p.servingGrams, 240);
  check('in millilitres', p.servingUnit, 'ml');

  // "Servings: 16" — this panel never says "per container" at all, and without
  // it a gallon of milk has no container size and no calories per dollar.
  check('servings with no "per container"', p.servingsPerContainer, 16);

  check('total fat, not the saturated line under it', p.fat, 8);
  check('the abbreviated carbohydrate line', p.carbs, 12);
  check('protein', p.protein, 8);
  check('fiber', p.fiber, 0);
  check('complete', p.complete, true);

  var m = LabelParser.metrics(p, { price: 3.24 });
  check('calories per millilitre', m.caloriesPerGram, 150 / 240, 0.0001);
  check('labelled per mL', m.perGramUnit, 'mL');
  // 16 x 240mL = 3840mL, which is a US gallon to within the rounding on the
  // serving size.
  check('the jug holds', m.totalGrams, 3840);
  check('and that many calories', m.totalCalories, 2400);
  check('calories per dollar', m.caloriesPerDollar, 2400 / 3.24, 0.01);
  check('dollars per 1000 calories', m.dollarsPerThousandCalories, 3.24 / 2.4, 0.001);
  check('from the servings count', m.containerBasis, 'servings');
});

/* ---------- panels off real shelves ----------
   Photographed in a shop, transcribed as printed. Snack packaging is where the
   awkward wordings live: servings measured in cakes and donuts, an "About"
   before the count, fibre written as "<1g", and four fat sub-lines under the
   total instead of two. */

group('Little Debbie Swiss Rolls', function () {
  var p = LabelParser.parse(
    'Nutrition Facts 6 servings per container Serving size 2 cakes (95g) ' +
    'Amount per serving Calories 400 % Daily Value* Total Fat 17g 22% ' +
    'Saturated Fat 9g 45% Trans Fat 0g Polyunsaturated Fat 3g Monounsaturated Fat 4.5g ' +
    'Cholesterol 15mg 5% Sodium 200mg 9% Total Carbohydrate 60g 22% ' +
    'Dietary Fiber 1g 4% Total Sugars 42g Includes 42g Added Sugars 84% Protein 2g ' +
    'Vit. D 0mcg 0% Calcium 20mg 0% Iron 1.6mg 8% Potas. 80mg 0%');

  check('calories', p.calories, 400);
  // "2 cakes (95g)" — the count of cakes is not the weight.
  check('serving weight, not the cake count', p.servingGrams, 95);
  check('servings', p.servingsPerContainer, 6);
  // Four sub-lines under the total here, two of them unsaturated fats.
  check('total fat, not any of its four sub-lines', p.fat, 17);
  check('carbohydrate', p.carbs, 60);
  check('protein', p.protein, 2);
  check('the macros confirm it (401 against 400)', p.caloriesConfirmed, true);
  check('calories per gram', p.caloriesPerGram, 400 / 95, 0.001);
});

group('McKee cookie', function () {
  var p = LabelParser.parse(
    'Nutrition Facts 12 servings per container Serving size 1 cookie (38g) ' +
    'Amount per serving Calories 170 % Daily Value* Total Fat 7g 9% ' +
    'Saturated Fat 3g 15% Trans Fat 0g Polyunsaturated Fat 1.5g Monounsaturated Fat 2g ' +
    'Cholesterol 0mg 0% Sodium 150mg 7% Total Carbohydrate 26g 9% ' +
    'Dietary Fiber <1g 4% Total Sugars 13g Includes 13g Added Sugars 26% Protein 1g');

  check('calories', p.calories, 170);
  check('serving weight', p.servingGrams, 38);
  check('servings', p.servingsPerContainer, 12);
  check('fat', p.fat, 7);
  check('carbohydrate', p.carbs, 26);
  check('protein', p.protein, 1);
  // "<1g" is how a panel writes a rounded-down amount. Without allowing for
  // the "<" the line does not parse at all.
  check('fibre written as "<1g"', p.fiber, 1);
  check('confirmed', p.caloriesConfirmed, true);
});

group('Hostess donuts', function () {
  var p = LabelParser.parse(
    'Nutrition Facts About 5 servings per container Serving size 3 donuts (53g) ' +
    'Amount per serving Calories 250 % Daily Value* Total Fat 13g 16% ' +
    'Saturated Fat 6g 32% Trans Fat 0g Cholesterol 10mg 3% Sodium 200mg 9% ' +
    'Total Carbohydrate 32g 11% Dietary Fiber 0g 0% Total Sugars 16g ' +
    'Includes 15g Added Sugars 31% Protein 2g');

  check('calories', p.calories, 250);
  check('serving weight, not the donut count', p.servingGrams, 53);
  // "About 5 servings per container" — the hedge in front of the number.
  check('an "About" before the count', p.servingsPerContainer, 5);
  check('fat', p.fat, 13);
  check('carbohydrate', p.carbs, 32);
  check('protein', p.protein, 2);
  check('confirmed', p.caloriesConfirmed, true);

  var m = LabelParser.metrics(p, { price: 4.48 });
  check('calories per gram', m.caloriesPerGram, 250 / 53, 0.001);
  check('the bag holds', m.totalCalories, 1250);
  check('calories per dollar', m.caloriesPerDollar, 1250 / 4.48, 0.01);
});

group('punctuation after a number', function () {
  // The reason the guard cannot simply exclude "." and ",": one of them ends a
  // number and the other is inside it, and only what follows tells them apart.
  check('a comma is a list separator', LabelParser.parse('Calories 150, Total Fat 8g').caloriesRead, 150);
  check('a full stop ends a sentence', LabelParser.parse('Calories 150. Total Fat 8g').caloriesRead, 150);
  check('a comma before a digit is a decimal', LabelParser.parse('Calories 1,5 Total Fat 8g').caloriesRead, null);
  // ...and the original reason for the guard, which must still hold: a partial
  // number must never be returned from a line that was read perfectly.
  check('no prefix of a longer number', LabelParser.parse('Calories 230 % Daily Value').caloriesRead, 230);
  check('nor from a decimal', LabelParser.parse('Calories 230.5 Total Fat 8g').caloriesRead, null);
});

group('the saturated fat line', function () {
  // "Sat. Fat" is the linear panel's abbreviation, and the sub-lines are
  // already inside the total — counting one as the total understates the fat
  // and, through the macro cross-check, the calories it is used to confirm.
  var abbrev = LabelParser.parse(
    'Serv. size: 1 cup (240mL), Calories 150, Total Fat 8g, Sat. Fat 5g, Protein 8g, Total Carb. 12g');
  check('the total wins over the abbreviated sub-line', abbrev.fat, 8);

  // The case that actually bit: glare ate the word "Total", so the fallback
  // ran — and with the full stop unaccounted for it read the saturated line as
  // the total. Missing is the correct answer here; 5 is not.
  var noTotal = LabelParser.parse(
    'Serv. size: 1 cup (240mL), Calories 150, Sat. Fat 5g, Trans Fat 0g, Protein 8g');
  check('with no total line, the sub-line is refused', noTotal.fat, null);

  ['Saturated Fat 5g', 'Sat Fat 5g', 'Sat. Fat 5g', 'Trans Fat 5g',
   'Polyunsaturated Fat 5g', 'Monounsaturated Fat 5g'
  ].forEach(function (line, i) {
    var p = LabelParser.parse('Serving size (100g) Calories 150, ' + line + ', Protein 8g');
    check('sub-line ' + i + ' (' + line.split(' ')[0] + ') is not the total', p.fat, null);
  });

  // An unqualified "Fat 8g" is still a total — some panels really do write it
  // that way, and refusing it would lose the macro check entirely.
  var bare = LabelParser.parse('Serving size (100g) Calories 150, Fat 8g, Protein 8g');
  check('a bare fat line is a total', bare.fat, 8);
});

group('serving-size wordings', function () {
  ['Serving size 1 cup (240mL)', 'Serv. size: 1 cup (240mL)', 'Serv size 1 cup (240mL)',
   'SERVING SIZE 1 cup (240mL)', 'Serv.size 1 cup (240mL)'
  ].forEach(function (wording, i) {
    var p = LabelParser.parse(wording + ' Calories 120 Total Fat 5g Total Carbohydrate 12g Protein 8g');
    check('wording ' + i + ': "' + wording.slice(0, 12) + '..."', p.servingGrams, 240);
  });
});

group('servings-count wordings', function () {
  var tail = ' Serving size (55g) Calories 230 Total Fat 8g Total Carbohydrate 37g Protein 3g';
  check('Servings: 16', LabelParser.parse('Servings: 16,' + tail).servingsPerContainer, 16);
  check('Servings 16', LabelParser.parse('Servings 16' + tail).servingsPerContainer, 16);
  check('16 servings per container', LabelParser.parse('16 servings per container' + tail).servingsPerContainer, 16);
  check('Servings Per Container 16', LabelParser.parse('Servings Per Container 16' + tail).servingsPerContainer, 16);

  // The loose "Servings: N" pattern must not fire on a serving *size* line. S,
  // I and Z are all digit lookalikes, so "size" itself reads as a number unless
  // real digits are demanded — and the singular has no "s" to match on.
  var sizeFirst = LabelParser.parse(
    'Serving size 2/3 cup (55g) Calories 230 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('a serving size is not a servings count', sizeFirst.servingsPerContainer, null);
  check('and the size itself still reads', sizeFirst.servingGrams, 55);
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

  // Glare puts accents on letters that never had them, and one of them lands
  // on a word every serving-size pattern is anchored to. The fold that fixes
  // this is a character class of combining marks — invisible characters an
  // editor is free to normalise away, leaving a line that still reads correctly
  // and does nothing. Hence this check.
  var accented = LabelParser.parse(
    'Serving sizé 2/3 cup (55g) Calories 230 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('glare accents are folded away', accented.servingGrams, 55);

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

group('a stray digit on a macro line', function () {
  // The gram symbol reads as a "9" and sometimes arrives as both: "Total Carb.
  // 12g" comes back "129g", which is a perfectly ordinary-looking number. The
  // calorie figure is what catches it — and before this, a good reading raised
  // "the calories and the macros disagree" against a calorie line it had read
  // perfectly. Measured on an upside-down frame of a milk panel.
  var p = LabelParser.parse(
    'Serv. size: 1 cup (240mL), Calories 150, Total Fat 8g, Total Carb. 129g, Protein 8g');
  check('the stray digit is taken back off', p.carbs, 12);
  check('and which line it was is reported', p.macroCorrected, 'carbs');
  check('so no false alarm is raised', p.caloriesDisagree, false);
  check('the panel calories stand', p.calories, 150);
  check('and are not "corrected"', p.caloriesCorrected, false);

  // The same artefact on the fat line.
  var f = LabelParser.parse(
    'Serving size (55g) Calories 230 Total Fat 89g Total Carbohydrate 37g Protein 3g');
  check('fat repaired', f.fat, 8);
  check('reported', f.macroCorrected, 'fat');

  // A panel that reads cleanly is left alone.
  var clean = LabelParser.parse(
    'Serving size (55g) Calories 230 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('nothing is repaired when nothing is wrong', clean.macroCorrected, null);
  check('and it still confirms', clean.caloriesConfirmed, true);

  // A decimal reading kept its point, so it is not this artefact and must not
  // be trimmed.
  var dec = LabelParser.parse(
    'Serving size (95g) Calories 400 Total Fat 17g Total Carbohydrate 60g ' +
    'Monounsaturated Fat 4.5g Protein 2g');
  check('a real panel is untouched', dec.macroCorrected, null);
  check('and confirms', dec.caloriesConfirmed, true);

  // When two different trims would each reconcile, neither is applied —
  // an ambiguous reading stays ambiguous rather than being resolved by
  // whichever was tried first.
  var noCalories = LabelParser.parse(
    'Serving size (55g) Total Fat 89g Total Carbohydrate 379g Protein 3g');
  check('no calorie anchor, no repair', noCalories.macroCorrected, null);

  // A genuine disagreement that no single trim can fix is still reported.
  var real = LabelParser.parse(
    'Serving size (55g) Calories 500 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('an irreconcilable panel still says so', real.caloriesDisagree, true);
  check('with nothing trimmed', real.macroCorrected, null);
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

/* ---------- typing in what the camera could not read ---------- */

group('units the shopper can type', function () {
  var c = LabelParser.convert;

  check('grams pass through', c(55, 'g').amount, 55);
  check('and stay grams', c(55, 'g').measure, 'g');
  check('kilograms', c(1.5, 'kg').amount, 1500);
  check('ounces', c(16, 'oz').amount, 16 * 28.349523125, 0.001);
  check('pounds', c(2, 'lb').amount, 2 * 453.59237, 0.001);
  check('litres become millilitres', c(2, 'l').amount, 2000);

  // A volume stays a volume. Converting mL to grams needs a density the panel
  // does not give, and inventing one puts a made-up number under the headline.
  check('millilitres are carried, not converted', c(240, 'ml').amount, 240);
  check('and keep their measure', c(240, 'ml').measure, 'ml');

  // The unit comes from a select box this project controls, so an unknown one
  // is a bug here rather than user input — and dropping the weight silently
  // would be worse than labelling it grams.
  check('an unknown unit falls back to grams', c(50, 'furlong').amount, 50);
  check('a missing unit falls back to grams', c(50, undefined).measure, 'g');
  check('a blank amount converts to nothing', c('', 'oz').amount, null);
  check('and so does junk', c('abc', 'g').amount, null);
});

group('typing the mass when the scan cannot find it', function () {
  // The case this exists for: the panel's servings line is unreadable — which
  // is exactly what the glare frame does to it — but the package says 16 oz on
  // the front, and that is enough to price the whole thing.
  var p = LabelParser.parse(
    'Serving size (55g) Calories 230 Total Fat 8g Total Carbohydrate 37g Protein 3g');
  check('the scan has no servings count', p.servingsPerContainer, null);

  var grams = LabelParser.convert(16, 'oz').amount;
  var m = LabelParser.metrics(p, { price: 4.99, netWeightGrams: grams });
  check('a typed mass sizes the container', m.containerBasis, 'netWeight');
  check('total grams', m.totalGrams, 453.59, 0.01);
  check('total calories', m.totalCalories, grams * (230 / 55), 0.01);
  check('and calories per dollar follows', m.caloriesPerDollar, grams * (230 / 55) / 4.99, 0.01);

  // A typed serving size in millilitres must relabel the headline. Getting
  // this wrong prints "cal/g" over a number that is per millilitre.
  var drink = LabelParser.metrics(null, {
    calories: 120, servingGrams: 240, servingUnit: 'ml', price: 2.50, servingsPerContainer: 4
  });
  check('a typed millilitre serving is labelled mL', drink.perGramUnit, 'mL');
  check('and still divides', drink.caloriesPerGram, 0.5);
  check('and still prices', drink.caloriesPerDollar, 480 / 2.5);

  // Servings wins when both are given: it is the figure the calorie line is
  // actually stated per, and the mass has to go through the density to be used.
  var both = LabelParser.metrics(p, { price: 4.00, servingsPerContainer: 8, netWeightGrams: 1000 });
  check('servings is preferred over mass', both.containerBasis, 'servings');
  check('and gives the container total', both.totalCalories, 1840);
});

group('the container total', function () {
  // A panel that gave its servings and its serving weight but whose calorie
  // line was unreadable used to report a container total of 0 — null times a
  // number — and show it as a confident zero next to "cal in pack".
  var p = LabelParser.parse('Serving size (55g) 8 servings per container');
  check('no calories were read', p.calories, null);
  var m = LabelParser.metrics(p, { price: 4.99 });
  check('so there is no container total', m.totalCalories, null);
  check('not a zero one', m.totalCalories === 0, false);
  check('the pack mass is still known', m.totalGrams, 440);
  check('and no rate is invented', m.caloriesPerDollar, null);

  // The mirror case: calories and servings are known but the serving weight is
  // not. Those two are the only numbers a container total needs, and this used
  // to return nothing because both figures were computed in one branch that
  // required the weight as well.
  var q = LabelParser.metrics(null, { calories: 230, servingsPerContainer: 8, price: 4.99 });
  check('calories x servings needs no weight', q.totalCalories, 1840);
  check('and prices the package', q.caloriesPerDollar, 1840 / 4.99, 0.01);
  check('with no density to show', q.caloriesPerGram, null);
  check('and no pack mass', q.totalGrams, null);
});

group('what counts as worth keeping', function () {
  // `ready` means the density is available. `usable` means there is something
  // worth showing and worth saving, which is a weaker bar — and the Save button
  // was gated on the wrong one, so a figure visible on screen could not be put
  // in the record.
  var noWeight = LabelParser.metrics(null, {
    calories: 100, servingsPerContainer: 2, price: 5
  });
  check('no serving weight, so no density', noWeight.ready, false);
  check('but a calories-per-dollar figure exists', noWeight.caloriesPerDollar, 40);
  check('so it is worth keeping', noWeight.usable, true);

  var density = LabelParser.metrics(null, { calories: 230, servingGrams: 55 });
  check('a density with no price is usable', density.usable, true);
  check('and ready', density.ready, true);

  var nothing = LabelParser.metrics(null, { price: 5 });
  check('a price on its own is not', nothing.usable, false);
  check('nor is nothing at all', LabelParser.metrics(null, {}).usable, false);

  // A zero-calorie drink has a real density of 0 and no meaningful rate. It is
  // still a record of the food.
  var water = LabelParser.metrics(null, { calories: 0, servingGrams: 355, price: 1.50, servingsPerContainer: 1 });
  check('a zero-calorie item is still keepable', water.usable, true);
  check('with no calories per dollar', water.caloriesPerDollar, null);
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
