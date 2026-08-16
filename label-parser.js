/* Turns the raw text of a Nutrition Facts panel into the numbers a shopper
   actually decides on: calories per gram, and — once a price is typed —
   calories per dollar.

   Shared by the camera scanner, the typed calculator and the test suite so all
   three agree exactly.

   Written to survive OCR, which is why it is forgiving about lookalike
   characters, glued-together words and panels read out of order. A real panel
   flattens to something like:

     Nutrition Facts 8 servings per container Serving size 2/3 cup (55g)
     Amount per serving Calories 230 % Daily Value* Total Fat 8g 10%
     Saturated Fat 1g 5% Trans Fat 0g Cholesterol 0mg 0% Sodium 160mg 7%
     Total Carbohydrate 37g 13% Dietary Fiber 4g 14% Total Sugars 12g
     Includes 10g Added Sugars 20% Protein 3g
*/

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LabelParser = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- tolerances ----------
   *
   * These are the numbers that decide whether a reading is believed, so they
   * are collected here rather than buried in the code that applies them.
   */

  // Nothing edible beats pure fat, which is 9 kcal/g by definition. Refined
  // oils measure ~8.8. A reading above this is not a dense food, it is a
  // misread — and it is the misread that matters most, because calories per
  // gram is the headline this whole app exists to show.
  var MAX_KCAL_PER_G = 9.5;
  // The floor is for the other direction. Water is 0 and a diet soda is close
  // to it, so a low reading is not automatically wrong; it only becomes wrong
  // when the macros say otherwise, which is what the Atwater check is for.
  var MIN_KCAL_PER_G = 0;

  // Calories worked out from the macros will not equal the printed figure:
  // manufacturers round every line independently, fibre is counted at 4 kcal/g
  // here but absorbed at closer to 2, and sugar alcohols are not on the panel
  // at all. A quarter either way is comfortably inside normal rounding and
  // still far tighter than the order-of-magnitude errors OCR produces.
  var ATWATER_TOLERANCE = 0.25;
  // Below this many calories the rounding on each macro line swamps the total
  // (a 15-calorie serving is three lines of "0g" and one of "1g"), so the check
  // can neither confirm nor refute and is not run.
  var ATWATER_MIN_CALORIES = 25;

  var KCAL_PER_G_FAT = 9, KCAL_PER_G_CARB = 4, KCAL_PER_G_PROTEIN = 4;

  var GRAMS_PER_OZ = 28.349523125;
  var GRAMS_PER_LB = 453.59237;

  /* ---------- character-level repair ---------- */

  // Characters OCR routinely swaps for digits, but only ever applied inside a
  // token we already believe is a number.
  var DIGIT_FIX = {
    O: '0', o: '0', Q: '0', D: '0',
    l: '1', I: '1', i: '1', '|': '1', '!': '1',
    S: '5', s: '5',
    B: '8', b: '6',
    Z: '2', z: '2',
    g: '9', G: '6', T: '7'
  };

  function fixDigits(token) {
    var out = '';
    for (var i = 0; i < token.length; i++) {
      var c = token[i];
      out += DIGIT_FIX.hasOwnProperty(c) ? DIGIT_FIX[c] : c;
    }
    return out;
  }

  function toNumber(token) {
    if (token === undefined || token === null) return null;
    // OCR often reads a decimal point as a comma, and a nutrition panel never
    // has a thousands separator on it, so a comma is always a decimal point.
    var n = parseFloat(fixDigits(String(token)).replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  // Flatten whatever the OCR engine produced into one forgiving line. The panel
  // is a table and the engine may read it in any order; every pattern below is
  // anchored on its own label word, so the order it arrives in does not matter.
  function normalize(text) {
    var out = String(text || '')
      .replace(/[‘’“”]/g, "'")
      .replace(/[–—−]/g, '-')
      .replace(/[  ]/g, ' ');

    // Strip accents. Nothing on a US nutrition panel carries one, so every
    // accent in the text is a mark the engine invented out of glare or a rule
    // above the line — and one of them lands squarely on a word this parser
    // anchors on. The glare frame reads "Serving sizé", which matched nothing
    // and cost the serving weight, and therefore the headline.
    // The character class below is the combining-mark range U+0300–U+036F,
    // spelled with the marks themselves. That makes it a run of invisible
    // characters which an editor or a copy-paste is free to normalise away,
    // turning this line into a no-op that still looks right — so the behaviour
    // is pinned by a test ("glare accents are folded away") rather than trusted
    // to survive on the strength of how it reads here.
    if (typeof out.normalize === 'function') {
      out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
    }

    return out.replace(/\s+/g, ' ').trim();
  }

  // Digits as OCR may render them. Kept narrow on purpose: letters like G and T
  // are corrected inside a confirmed number but are too risky to match on.
  var DC = '[\\dOoQlIiSsBbZz]';
  var NUM = DC + '{1,4}(?:[.,]' + DC + '{1,2})?';

  // The number has to contain at least one real digit. "SI" is two lookalike
  // guesses stacked, and stacked guesses are how panel texture becomes data.
  function realNumber(token) {
    if (token === undefined || token === null) return null;
    if (!/\d/.test(String(token))) return null;
    return toNumber(token);
  }

  function firstMatch(text, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m) {
        var v = realNumber(m[1]);
        if (v !== null) return { value: v, match: m };
      }
    }
    return null;
  }

  /* ---------- calories ---------- */

  // "Calories 230", "Amount per serving Calories 230", "230 Calories".
  //
  // The word is the anchor and it must be there. A nutrition panel is wall to
  // wall with bare numbers — percentages, milligrams, the serving fraction —
  // and the calorie figure is the one number in the app that cannot be wrong,
  // so it is never taken from position alone.
  var CAL_WORD = 'ca[li1|]or[li1|]es?';
  // "Calories from Fat 72" is the old (pre-2016) panel's second calorie line.
  // Reading it as the headline turns a 230-calorie serving into a 72-calorie
  // one — a third of the truth, reported with total confidence.
  // The trailing guard demands the *whole* number, and it is load-bearing.
  // Without it the panel's own "Calories 230 % Daily Value" defeated an earlier
  // attempt to exclude percentages: refusing a match followed by "%" simply made
  // the engine backtrack and hand back "23" — a complete number, ten times too
  // small, from a line it had read perfectly. A partial number is the one
  // failure mode a digit-level check cannot see, so the pattern is not allowed
  // to produce one.
  //
  // Two separate conditions, and the second one is why this is not simply a
  // list of characters. A "." or "," after the number may be a decimal point —
  // in which case the number is not finished and this must not match — or it
  // may be ordinary punctuation. It is a decimal point only when a digit
  // follows it.
  //
  // Excluding "." and "," outright, as this first did, meant the linear panels
  // printed on milk jugs failed at the first line: "Calories 150, Total Fat 8g"
  // has a comma there as a list separator, so the calorie figure was refused
  // and the reading fell back to totting up the macros.
  var TOKEN_END = '(?![' + '\\dOoQlIiSsBbZz' + '])(?![.,]\\d)';

  // The calorie figure is set far larger than anything else on the panel —
  // that is the point of the 2016 redesign — and large type is exactly where
  // the engine starts inserting spaces between glyphs. "Calories 230" comes
  // back as "Calories 2 30" or "Calories 23 0" depending on the frame, and
  // both were measured on the harness, not imagined. Reading only up to the
  // first space yields 2 or 23 from a line the engine got completely right.
  //
  // So the digits are allowed to arrive in up to three runs and are joined
  // back up. What stops this swallowing the neighbouring number is the digit
  // budget: no serving is five digits, so a join that long is a join across a
  // gap that was never inside one number.
  // Only the first run may contain lookalike letters. A continuation fragment
  // has to be real digits and must not be a percentage, and both restrictions
  // were put here by a failing test rather than by caution:
  //
  //   "Calories 230 Serving size ..."  — S is a lookalike for 5, so a permissive
  //     continuation joined "230" to "S" and read 2305, which the macros then
  //     helpfully "corrected" to 230.5.
  //   "calories 230 9% Daily value"    — the daily-value figure joined on to
  //     give 2309, corrected to 230.9.
  //
  // Both produced a number close enough to the truth to look right on screen
  // and wrong enough to be wrong.
  var CAL_RUN = DC + '{1,4}(?:\\s{1,2}\\d{1,3}(?!\\s*%)){0,2}';
  var CAL_PATTERNS = [
    new RegExp(CAL_WORD + '\\s*(?:per\\s+serving)?\\s*[:\\-]?\\s*(' + CAL_RUN + ')' + TOKEN_END, 'i'),
    new RegExp('(' + DC + '{1,4})' + TOKEN_END + '\\s*' + CAL_WORD + '\\b', 'i')
  ];

  var MAX_CAL_DIGITS = 4;

  function findCalories(text) {
    // Strip the old panel's "from fat" line before looking, so it can neither
    // be matched directly nor sit between the anchor word and the real number.
    var cleaned = text.replace(new RegExp(CAL_WORD + '\\s*from\\s*fat\\s*' + DC + '{1,4}', 'gi'), ' ');

    for (var i = 0; i < CAL_PATTERNS.length; i++) {
      var m = cleaned.match(CAL_PATTERNS[i]);
      if (!m) continue;
      var raw = String(m[1]);
      var joined = raw.replace(/\s+/g, '');
      // Too many digits means the runs were joined across a gap that separated
      // two different numbers. Fall back to the first run, which is the part
      // that was certainly inside the calorie figure.
      if (joined.replace(/[.,]/g, '').length > MAX_CAL_DIGITS) {
        joined = raw.split(/\s+/)[0];
      }
      var v = realNumber(joined);
      if (v === null) continue;
      // A single serving of anything sold in a container tops out well below
      // this; beyond it the reading has picked up a percentage or run two
      // numbers together.
      if (v < 0 || v > 5000) continue;
      return v;
    }
    return null;
  }

  /* ---------- serving size ---------- */

  // The gram figure is what the whole calculation divides by, and on every US
  // panel since 1993 it is the one in parentheses: "2/3 cup (55g)". The
  // household measure in front of it — "2/3 cup", "1 bar", "about 12 chips" —
  // is deliberately never parsed. It carries no weight information and it is
  // full of numbers that would otherwise be mistaken for one.
  //
  // The unit is where this reading goes wrong, and it goes wrong the same way
  // every time: a lowercase "g" is a closed loop with a descender, which is a
  // "9". Measured, not guessed — the end-to-end harness reads the FDA panel's
  // "(55g)" back as "(559)" on a clean render, every time.
  //
  // So a "9" or a "q" sitting where the unit belongs is accepted as one. The
  // number is matched greedily first, which means "(559)" is only ever read as
  // 55 grams *after* trying and failing to read it as 559-with-a-unit; and a
  // parenthesised weight with no unit at all does not occur on a US panel,
  // while a misread "g" occurs constantly. The inference is reported rather
  // than made silently, because it is a guess about a character and the person
  // holding the package can see the real one.
  var UNIT = '(g|gram|grams|m[li1|]|ml|mL|oz|9|q)';

  // "Serving size", and also "Serv. size" — the abbreviation the linear panels
  // on milk jugs and small packages use. Requiring the full word meant those
  // labels fell through to the last-resort pattern below, which will take a
  // parenthesised weight from anywhere on the package and is not something to
  // rely on when the real line is right there.
  var SERV_SIZE = 'serv(?:[li1|]ng)?\\.?\\s*s[li1|]ze';

  var SERVING_PARENS = new RegExp(
    SERV_SIZE + '[^(]{0,40}\\(\\s*(' + NUM + ')\\s*' + UNIT + '\\s*\\)',
    'i'
  );
  // A panel that gives the weight without parentheses: "Serving Size 30 g".
  // No closing bracket to anchor against, so the unit has to be a real letter
  // here — a bare trailing "9" is far more likely to be part of the number.
  var SERVING_BARE = new RegExp(
    SERV_SIZE + '\\s*[:\\-]?\\s*(?:about\\s*)?(' + NUM + ')\\s*(g|gram|grams|m[li1|]|ml|mL|oz)\\b',
    'i'
  );
  // Last resort: any parenthesised weight anywhere. Only reached when the
  // words "serving size" were not read at all, which happens when the crop
  // clips the top of the panel.
  var ANY_PARENS_WEIGHT = new RegExp('\\(\\s*(' + NUM + ')\\s*(g|gram|grams|m[li1|]|ml|mL)\\s*\\)', 'i');

  var G_LOOKALIKE = /^[9q]$/i;

  function normalizeUnit(raw) {
    var u = String(raw || '').toLowerCase().replace(/[l1|]/g, 'l');
    if (u === 'oz') return 'oz';
    if (u.indexOf('ml') === 0) return 'ml';
    return 'g';
  }

  function findServing(text) {
    var m = text.match(SERVING_PARENS) || text.match(SERVING_BARE) || text.match(ANY_PARENS_WEIGHT);
    if (!m) return null;
    var amount = realNumber(m[1]);
    if (amount === null || amount <= 0) return null;
    var inferred = G_LOOKALIKE.test(m[2] || '');
    var unit = normalizeUnit(m[2]);

    // Ounces are converted; millilitres are not. A millilitre of oil and a
    // millilitre of water weigh different amounts, and guessing a density to
    // hide that would put an invented number in the denominator of the headline.
    // It is reported as calories per millilitre instead, and labelled as such.
    if (unit === 'oz') return { grams: amount * GRAMS_PER_OZ, unit: 'g', fromOunces: true, unitInferred: false };
    // A serving in the hundreds of grams is a whole meal tray and real; beyond
    // a kilogram the reading has run two numbers together.
    if (amount > 2000) return null;
    return { grams: amount, unit: unit, fromOunces: false, unitInferred: inferred };
  }

  /* ---------- servings per container ---------- */

  // "8 servings per container", "Servings Per Container About 8", "about 2.5
  // servings per container". Both orders appear on real packages.
  var SERVINGS_PATTERNS = [
    new RegExp('(' + NUM + ')\\s*serv[li1|]ngs?\\s*per\\s*conta[li1|]ner', 'i'),
    new RegExp('serv[li1|]ngs?\\s*per\\s*conta[li1|]ner\\s*[:\\-]?\\s*(?:about|approx\\.?)?\\s*(' + NUM + ')', 'i'),
    new RegExp('(?:about|approx\\.?)\\s*(' + NUM + ')\\s*serv[li1|]ngs?\\b', 'i'),
    // "Servings: 16" — the linear panel's way of saying it, with no "per
    // container" anywhere on the label. Without this a gallon of milk has no
    // container size at all, and therefore no calories per dollar.
    //
    // Two deliberate narrowings, because this pattern is far looser than the
    // three above it. The plural "s" is required, so "Serving size 2/3 cup"
    // cannot match — and real digits are required rather than the lookalike
    // class, because otherwise "size" itself reads as a number (S, I and Z are
    // all lookalikes) and poisons the match on any label that puts the serving
    // size first.
    new RegExp('serv[li1|]ngs\\s*[:\\-]?\\s*(\\d{1,3})\\b', 'i')
  ];

  function findServings(text) {
    var hit = firstMatch(text, SERVINGS_PATTERNS);
    if (!hit) return null;
    var v = hit.value;
    // "1 serving per container" is real and common; a thousand is a misread.
    if (v <= 0 || v > 999) return null;
    return v;
  }

  /* ---------- net weight ---------- */

  // "NET WT 12 OZ (340g)", "Net Wt. 1 LB 2 OZ", "Net weight 500g". Only used
  // when the servings-per-container line was unreadable — with a net weight
  // and a serving size the container's contents can still be worked out.
  var NET_METRIC = new RegExp('net\\s*w[te]?[a-z.]*\\s*[:\\-]?[^\\d]{0,12}(' + NUM + ')\\s*(g|kg|gram|grams)\\b', 'i');
  var NET_PARENS = new RegExp('net\\s*w[te]?[a-z.]*[^(]{0,24}\\(\\s*(' + NUM + ')\\s*(g|kg|gram|grams)\\b', 'i');
  var NET_LB_OZ = new RegExp('net\\s*w[te]?[a-z.]*\\s*[:\\-]?\\s*(?:(' + NUM + ')\\s*lbs?\\b)?\\s*(?:(' + NUM + ')\\s*oz\\b)?', 'i');

  function findNetWeight(text) {
    var m = text.match(NET_PARENS) || text.match(NET_METRIC);
    if (m) {
      var v = realNumber(m[1]);
      if (v !== null && v > 0) {
        var grams = /kg/i.test(m[2]) ? v * 1000 : v;
        if (grams <= 100000) return grams;
      }
    }
    m = text.match(NET_LB_OZ);
    if (m) {
      var lb = realNumber(m[1]) || 0;
      var oz = realNumber(m[2]) || 0;
      var total = lb * GRAMS_PER_LB + oz * GRAMS_PER_OZ;
      if (total > 0 && total <= 100000) return total;
    }
    return null;
  }

  /* ---------- macros ---------- */

  // Every macro line is anchored on its own words and takes the grams that
  // follow. "Total Fat 8g 10%" gives 8 — the percentage is a different number
  // in a different unit and is never wanted here.
  function grabGrams(text, patterns, max) {
    var hit = firstMatch(text, patterns);
    if (!hit) return null;
    var v = hit.value;
    if (v < 0 || v > max) return null;
    return v;
  }

  // "Total Fat" and not "Saturated Fat" or "Trans Fat": the sub-lines are
  // already inside the total, and adding either one again inflates the
  // calories the cross-check is supposed to be independently confirming.
  //
  // The qualifier is captured and rejected rather than excluded by a lookbehind,
  // which iOS Safari only learned in 16.4 — a phone older than that would throw
  // on this file at parse time and take the whole app down, not just this line.
  // The gram unit on a macro line collapses the same way it does on the
  // serving line — "Total Fat 8g" reads back as "Total Fat 89" under glare.
  // Because the number is matched greedily first, a real two-digit value with
  // a real "g" still wins: "19g" is read as 19, and only a trailing lookalike
  // with no letter behind it is taken as the unit. Without this the whole
  // macro cross-check goes missing on exactly the frames that most need
  // checking, since glare is what causes the misreads in the first place.
  var GU = '(?:g|gram|grams|9|q)';

  var FAT_TOTAL = new RegExp('tota[li1|]\\s*fat\\s*[:\\-]?\\s*(' + NUM + ')\\s*' + GU + '\\b', 'i');
  // The qualifier may be abbreviated with a full stop — linear panels write
  // "Sat. Fat 5g". Without allowing for that dot the qualifier was not captured
  // at all, the line looked unqualified, and the saturated figure was taken as
  // the total: on a glare frame of a milk jug that reported 5g of fat instead
  // of 8g, which is a wrong number rather than a missing one.
  var FAT_ANY = new RegExp('([a-z]+)?\\.?\\s*fat\\s*[:\\-]?\\s*(' + NUM + ')\\s*' + GU + '\\b', 'gi');
  var FAT_SUBLINE = /^(saturated|satd?|trans|from|poly|mono|polyunsaturated|monounsaturated)$/i;

  function findFat(text) {
    var m = text.match(FAT_TOTAL);
    if (m) {
      var total = realNumber(m[1]);
      if (total !== null && total >= 0 && total <= 500) return total;
    }
    // No "Total" was read. Take the first fat line that is not one of the
    // indented sub-lines, which are already counted inside the total.
    FAT_ANY.lastIndex = 0;
    var hit;
    while ((hit = FAT_ANY.exec(text)) !== null) {
      if (hit.index === FAT_ANY.lastIndex) FAT_ANY.lastIndex++;
      if (hit[1] && FAT_SUBLINE.test(hit[1])) continue;
      var v = realNumber(hit[2]);
      if (v !== null && v >= 0 && v <= 500) return v;
    }
    return null;
  }
  var CARB_PATTERNS = [
    new RegExp('tota[li1|]\\s*carbo?h?y?d?r?a?t?e?s?\\.?\\s*[:\\-]?\\s*(' + NUM + ')\\s*' + GU + '\\b', 'i'),
    new RegExp('carbo?h?y?d?r?a?t?e?s?\\.?\\s*[:\\-]?\\s*(' + NUM + ')\\s*' + GU + '\\b', 'i')
  ];
  var PROTEIN_PATTERNS = [
    new RegExp('prote[li1|]ns?\\s*[:\\-]?\\s*(' + NUM + ')\\s*' + GU + '\\b', 'i')
  ];
  // "Dietary Fiber <1g" is how a panel writes a rounded-down amount, and it is
  // common on biscuits and cakes. The "<" has to be allowed for or the line
  // does not parse at all.
  var LT = '[<~≤]?\\s*';
  var FIBER_PATTERNS = [
    new RegExp('d[li1|]etary\\s*f[li1|]b(?:er|re)\\s*[:\\-]?\\s*' + LT + '(' + NUM + ')\\s*' + GU + '\\b', 'i'),
    new RegExp('f[li1|]b(?:er|re)\\s*[:\\-]?\\s*' + LT + '(' + NUM + ')\\s*' + GU + '\\b', 'i')
  ];
  var SUGAR_PATTERNS = [
    new RegExp('tota[li1|]\\s*sugars?\\s*[:\\-]?\\s*(' + NUM + ')\\s*' + GU + '\\b', 'i'),
    new RegExp('sugars?\\s*[:\\-]?\\s*(' + NUM + ')\\s*' + GU + '\\b', 'i')
  ];

  // A macro line cannot exceed the serving it is part of, and no serving on a
  // panel is measured in kilograms, so these ceilings only ever reject misreads.
  function findMacros(text) {
    return {
      fat: findFat(text),
      carbs: grabGrams(text, CARB_PATTERNS, 500),
      protein: grabGrams(text, PROTEIN_PATTERNS, 500),
      fiber: grabGrams(text, FIBER_PATTERNS, 500),
      sugars: grabGrams(text, SUGAR_PATTERNS, 500)
    };
  }

  /* ---------- the cross-check ----------
   *
   * The panel states its calories, and it also states the macros those
   * calories are made of. Those are two independent readings of the same
   * quantity, which makes the second one a way to check the first — the only
   * such check this app has, and the reason a misread headline does not go
   * straight to the screen wearing the same confidence as a good one.
   *
   *   calories ~= 9 x fat + 4 x carbohydrate + 4 x protein
   *
   * The Atwater factors. They are how the number on the panel was worked out
   * in the first place, so agreement is expected and disagreement is a fact
   * about the reading rather than about the food.
   */
  function atwater(macros) {
    if (macros.fat === null || macros.carbs === null || macros.protein === null) return null;
    return macros.fat * KCAL_PER_G_FAT +
           macros.carbs * KCAL_PER_G_CARB +
           macros.protein * KCAL_PER_G_PROTEIN;
  }

  /* The other direction of the same repair.
   *
   * The gram unit is a "9" to this engine, and sometimes it arrives as *both*:
   * "Total Carb. 12g" comes back "129g", which parses as 129 grams because the
   * "g" really is there after it. Nothing about that line looks wrong on its
   * own — 129 is a perfectly ordinary number.
   *
   * The calorie figure is what catches it. When the panel states its calories
   * and the macros do not add up to them, one of the two was misread; and if
   * dropping a trailing digit from exactly one macro makes them agree, that
   * macro is the one. Same discipline as the calorie recovery: only when
   * exactly one candidate fits, so an ambiguous reading stays ambiguous, and
   * always reported rather than silently applied.
   *
   * Without this a good reading raised a false alarm — "the calories and the
   * macros disagree, check the calorie line" — on a panel whose calorie line
   * was read perfectly. A check that cries wolf is worse than no check.
   */
  var MACRO_FIELDS = ['fat', 'carbs', 'protein'];

  function repairMacros(macros, calories) {
    var winners = [];
    MACRO_FIELDS.forEach(function (field) {
      var v = macros[field];
      // Only a whole number with a digit to spare. A decimal reading like
      // "4.5g" was printed with its point intact and is not this artefact.
      if (v === null || v < 10 || v !== Math.floor(v)) return;
      var trimmed = Math.floor(v / 10);
      var candidate = {};
      MACRO_FIELDS.forEach(function (k) { candidate[k] = macros[k]; });
      candidate[field] = trimmed;
      if (agrees(calories, atwater(candidate))) {
        winners.push({ field: field, macros: candidate });
      }
    });
    return winners.length === 1 ? winners[0] : null;
  }

  function agrees(calories, predicted) {
    if (calories === null || predicted === null) return false;
    if (predicted < ATWATER_MIN_CALORIES) return false;
    return Math.abs(calories - predicted) / predicted <= ATWATER_TOLERANCE;
  }

  /* ---------- recovery ----------
   *
   * A digit lost or gained in the calorie figure moves the answer by a factor
   * of ten, which is the difference between celery and cooking oil. When the
   * macros disagree with the headline, the powers of ten around it are tried
   * against them — and a correction is only ever made when exactly one of them
   * agrees, so a genuinely ambiguous reading stays ambiguous instead of being
   * quietly resolved in whichever direction was tried first.
   */
  function reconcile(calories, predicted) {
    if (predicted === null || predicted < ATWATER_MIN_CALORIES) {
      return { calories: calories, corrected: false, disagrees: false, source: 'label' };
    }
    if (calories === null) {
      // No headline at all — the macros are the only reading there is. Worth
      // showing, but never as though it had been read off the panel.
      return { calories: predicted, corrected: false, disagrees: false, source: 'macros' };
    }
    if (agrees(calories, predicted)) {
      return { calories: calories, corrected: false, disagrees: false, source: 'label', confirmed: true };
    }

    var candidates = [calories * 10, calories / 10];
    var winners = candidates.filter(function (c) { return agrees(c, predicted); });
    if (winners.length === 1) {
      return { calories: winners[0], corrected: true, disagrees: false, source: 'label' };
    }
    // Two readings of the same thing that cannot be made to agree. Neither is
    // thrown away and neither is trusted: the caller is told, and shows it.
    return { calories: calories, corrected: false, disagrees: true, source: 'label' };
  }

  /* ---------- public ---------- */

  function parse(rawText) {
    var text = normalize(rawText);

    var macros = findMacros(text);
    var predicted = atwater(macros);
    var read = findCalories(text);

    // Before deciding the two sources disagree, check whether one macro line
    // picked up a stray digit from the gram symbol beside it. Only attempted
    // when the panel's own calorie figure was read, since that is the anchor
    // the repair is measured against.
    var macroCorrected = null;
    if (read !== null && predicted !== null && !agrees(read, predicted)) {
      var repair = repairMacros(macros, read);
      if (repair) {
        macros = repair.macros;
        predicted = atwater(macros);
        macroCorrected = repair.field;
      }
    }

    var fixed = reconcile(read, predicted);

    var serving = findServing(text);
    var servingGrams = serving ? serving.grams : null;
    var servingUnit = serving ? serving.unit : null;

    var calories = fixed.calories;
    var perGram = (calories !== null && servingGrams) ? calories / servingGrams : null;

    // The last guard, and the one that catches what the macros cannot: a
    // serving size misread. The macros confirm the calories per *serving*;
    // only this says whether the weight that figure is divided by is credible.
    var densityUncertain = false;
    var servingCorrected = false;
    if (perGram !== null && (perGram > MAX_KCAL_PER_G || perGram < MIN_KCAL_PER_G)) {
      // A dropped digit in the weight — "55g" read as "5g" — is the likeliest
      // cause and the easiest to test. As with the calories, the correction is
      // only made when it lands somewhere believable, and it is always shown.
      var scaled = [servingGrams * 10, servingGrams / 10].filter(function (g) {
        var r = calories / g;
        return g > 0 && r <= MAX_KCAL_PER_G && r >= MIN_KCAL_PER_G;
      });
      if (scaled.length === 1) {
        servingGrams = scaled[0];
        perGram = calories / servingGrams;
        servingCorrected = true;
      } else {
        densityUncertain = true;
      }
    }

    var servings = findServings(text);
    var netWeight = findNetWeight(text);

    return {
      calories: calories,
      caloriesRead: read,
      caloriesFromMacros: fixed.source === 'macros',
      caloriesCorrected: !!fixed.corrected,
      // Two independent readings that will not agree. Not an error — a fact
      // the screen has to carry, because the number is still the best there is.
      caloriesDisagree: !!fixed.disagrees,
      // Two independent readings that do agree. This is the only positive
      // evidence the app ever has that a scan is right, so it is passed on
      // rather than merely used and discarded.
      caloriesConfirmed: !!fixed.confirmed,
      atwaterCalories: predicted,

      servingGrams: servingGrams,
      servingUnit: servingUnit,
      servingCorrected: servingCorrected,
      // The unit letter was not read as a letter and was taken from its
      // position instead — see UNIT above. Worth saying out loud, because it
      // is the one part of the serving line that was guessed.
      servingUnitInferred: !!(serving && serving.unitInferred),
      // The one number the app exists to show, or null when it could not be
      // worked out honestly.
      caloriesPerGram: densityUncertain ? null : perGram,
      densityUncertain: densityUncertain,

      servingsPerContainer: servings,
      netWeightGrams: netWeight,

      fat: macros.fat,
      carbs: macros.carbs,
      protein: macros.protein,
      // Which macro line had a digit taken back off it, or null. Reported for
      // the same reason every other correction is: it is a guess about a
      // character, and the person holding the package can see the real one.
      macroCorrected: macroCorrected,
      fiber: macros.fiber,
      sugars: macros.sugars,

      // Enough to act on: without calories and a weight there is no density to
      // show, which is the whole point of pointing a camera at the panel.
      complete: calories !== null && calories > 0 &&
                servingGrams !== null && servingGrams > 0 && !densityUncertain,
      text: text
    };
  }

  /* ---------- the metrics ----------
   *
   * parse() reports what is on the panel. This turns it into what the shopper
   * is standing in the aisle deciding between, which needs one thing the panel
   * does not carry: the price.
   */
  function metrics(parsed, opts) {
    var o = opts || {};

    // Anything read off the panel can be overridden by hand. OCR gets the odd
    // line wrong and a person holding the box can see which one — a scan that
    // cannot be corrected is a scan that has to be redone from scratch.
    var calories = num(o.calories, parsed && parsed.calories);
    var grams = num(o.servingGrams, parsed && parsed.servingGrams);
    var servings = num(o.servingsPerContainer, parsed && parsed.servingsPerContainer);
    var netWeight = num(o.netWeightGrams, parsed && parsed.netWeightGrams);
    var price = num(o.price, null);

    // The unit is overridable like everything else. A panel that says "(240mL)"
    // and reads back as grams, or a serving weight typed in by hand off a
    // package the camera could not manage, both need the person to be able to
    // say which measure the number is in — otherwise the headline is labelled
    // wrong even when the arithmetic is right.
    var unit = o.servingUnit || (parsed && parsed.servingUnit) || 'g';
    var perGram = (calories !== null && grams) ? calories / grams : null;

    /* What the container holds, by whichever route is available.
     *
     * The two figures have different requirements and are worked out
     * separately, which they were not before: a single `if (servings && grams)`
     * computed `servings * calories` in a branch that had only established
     * `grams`, so a panel whose calorie line was unreadable produced a
     * container total of **0** — null times a number — and displayed it as a
     * confident zero. It also meant a package that gave its servings count and
     * calories but not its serving weight produced no container total at all,
     * when those two numbers are the only ones that total actually needs.
     */
    var totalGrams = null, totalCalories = null, basis = null;

    if (servings && calories !== null) {
      totalCalories = servings * calories;
      basis = 'servings';
    }
    if (servings && grams) {
      totalGrams = servings * grams;
    }

    // Net weight is the fallback for a package whose servings line was
    // unreadable. It needs the density, which is the one thing it cannot
    // supply itself.
    if (totalCalories === null && netWeight && perGram !== null) {
      totalCalories = netWeight * perGram;
      basis = 'netWeight';
    }
    if (totalGrams === null && netWeight) {
      totalGrams = netWeight;
    }

    // A price with nothing to divide into it is not an error, it is a field
    // waiting to be filled — as is a container whose size is not known yet.
    var caloriesPerDollar = null, dollarsPerThousand = null;
    var costPerServing = null, costPer100g = null;
    if (price !== null && price > 0) {
      if (totalCalories !== null && totalCalories > 0) {
        caloriesPerDollar = totalCalories / price;
        dollarsPerThousand = price / (totalCalories / 1000);
      }
      if (servings) costPerServing = price / servings;
      if (totalGrams) costPer100g = price / (totalGrams / 100);
    }

    return {
      // The density is available, which is what the headline needs.
      ready: perGram !== null,
      // Something worth showing and worth keeping — a weaker bar than `ready`
      // on purpose. A package whose serving weight never read still has a
      // calories-per-dollar figure if its calorie count, servings and price are
      // known, and gating the Save button on `ready` meant that figure could be
      // seen on screen and not put in the record.
      usable: perGram !== null || caloriesPerDollar !== null,
      calories: calories,
      servingGrams: grams,
      servingUnit: unit,
      servingsPerContainer: servings,

      // Calories per gram — or per millilitre, when that is what the panel
      // measured its serving in. The unit travels with the number so a display
      // never has to guess which one it is showing.
      caloriesPerGram: perGram,
      perGramUnit: unit === 'ml' ? 'mL' : 'g',
      caloriesPer100g: perGram === null ? null : perGram * 100,

      totalGrams: totalGrams,
      totalCalories: totalCalories,
      // Which route the container total came by, so a display can say so. The
      // two are not equally trustworthy and a figure nobody can reconstruct is
      // a figure nobody can check.
      containerBasis: basis,

      price: price,
      caloriesPerDollar: caloriesPerDollar,
      dollarsPerThousandCalories: dollarsPerThousand,
      costPerServing: costPerServing,
      costPer100g: costPer100g,

      // Where a food sits on the scale the panel itself implies: 0 kcal/g is
      // water, 4 is sugar or flour, 9 is fat. Bands, not a verdict — this app
      // has no business telling anyone what to eat, only what they are holding.
      band: perGram === null ? null
        : perGram < 1.5 ? 'low'
        : perGram < 4 ? 'medium'
        : 'high'
    };
  }

  /* ---------- units the shopper can type ----------
   *
   * A package states its mass in whatever unit it likes — grams on the panel,
   * ounces on the front, pounds on a bag of rice — and a person typing a
   * number the camera could not read should not have to do the conversion
   * first. This is the one place that arithmetic lives, so the scanner and the
   * typed screen cannot disagree about what an ounce is.
   *
   * Millilitres are carried, never converted. A millilitre of oil and a
   * millilitre of water do not weigh the same, and inventing a density to hide
   * that would put a made-up number under the headline — so a volume stays a
   * volume and the display says so.
   */
  var UNITS = {
    g: { factor: 1, measure: 'g' },
    gram: { factor: 1, measure: 'g' },
    grams: { factor: 1, measure: 'g' },
    kg: { factor: 1000, measure: 'g' },
    oz: { factor: GRAMS_PER_OZ, measure: 'g' },
    lb: { factor: GRAMS_PER_LB, measure: 'g' },
    lbs: { factor: GRAMS_PER_LB, measure: 'g' },
    ml: { factor: 1, measure: 'ml' },
    l: { factor: 1000, measure: 'ml' },
    liter: { factor: 1000, measure: 'ml' },
    litre: { factor: 1000, measure: 'ml' }
  };

  // Returns { amount, measure } where measure is 'g' or 'ml' — the two things
  // the rest of the app knows how to divide by. An unknown unit is treated as
  // grams rather than rejected: it can only come from a select box this project
  // controls, and a silently dropped serving weight is worse than a wrong label
  // on it.
  function convert(value, unit) {
    var n = (typeof value === 'number') ? value : parseFloat(value);
    if (!isFinite(n)) return { amount: null, measure: 'g' };
    var key = String(unit || 'g').toLowerCase().trim();
    var u = UNITS.hasOwnProperty(key) ? UNITS[key] : UNITS.g;
    return { amount: n * u.factor, measure: u.measure };
  }

  // An override only counts when it is a real, usable number. An empty input
  // box is not a zero, and a zero serving weight is a division this app must
  // never do.
  function num(override, fallback) {
    if (override !== undefined && override !== null && override !== '') {
      var n = typeof override === 'number' ? override : parseFloat(override);
      if (isFinite(n) && n > 0) return n;
      if (isFinite(n) && n === 0) return 0;
    }
    return (fallback === undefined || fallback === null || !isFinite(fallback)) ? null : fallback;
  }

  return {
    parse: parse,
    metrics: metrics,
    convert: convert,
    normalize: normalize,
    toNumber: toNumber,
    atwater: atwater,
    limits: {
      MAX_KCAL_PER_G: MAX_KCAL_PER_G,
      ATWATER_TOLERANCE: ATWATER_TOLERANCE,
      GRAMS_PER_OZ: GRAMS_PER_OZ
    }
  };
}));
