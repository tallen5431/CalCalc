#!/usr/bin/env node
/* What may go into the record, how records collapse, and how they export.
 *
 *   node tests/journal.test.js
 *
 * The file this guards is written by anything that can reach the server and
 * read back by a page, so the rules about what is allowed in are the rules that
 * keep it a record rather than a place to put arbitrary content.
 */

'use strict';

var Journal = require('../journal.js');

var passed = 0, failed = 0;
var NOW = 1755300000000;                    // a fixed clock; nothing here may use the real one

function check(name, actual, expected) {
  var ok = (actual === expected) ||
           (typeof expected === 'number' && typeof actual === 'number' &&
            Math.abs(actual - expected) < 1e-9);
  if (ok) {
    passed++;
  } else {
    failed++;
    console.log('  FAIL  ' + name + '\n        expected ' + JSON.stringify(expected) +
                ', got ' + JSON.stringify(actual));
  }
}

function group(name, fn) { console.log('\n' + name); fn(); }

function save(body) { return Journal.sanitize(body, NOW); }

var GOOD = {
  name: 'Store brand oats',
  calories: 150, servingAmount: 40, servingUnit: 'g', servingsPerContainer: 13,
  price: 4.29, caloriesPerGram: 3.75, totalCalories: 1950,
  caloriesPerDollar: 454.5, source: 'scan', caloriesConfirmed: true
};

group('what a record keeps', function () {
  var r = save(GOOD);
  check('it is accepted', r.error, undefined);
  check('the name', r.item.name, 'Store brand oats');
  check('calories', r.item.calories, 150);
  check('serving', r.item.servingAmount, 40);
  check('price', r.item.price, 4.29);
  check('calories per dollar', r.item.caloriesPerDollar, 454.5);
  check('the source', r.item.source, 'scan');
  check('an id is minted when none is given', typeof r.item.id, 'string');
  // How the reading was made travels with it. A number with no record of how
  // much to trust it cannot be checked once the package is in a bin.
  check('the confirmation flag is kept', r.item.flags.confirmed, true);

  // Only the fields named in the module are stored. Anything else a client
  // sends is dropped rather than written to a file a page reads back.
  var extra = save(Object.assign({}, GOOD, {
    somethingElse: 'x', __proto__unused: 1, notes: 'a'.repeat(5000)
  }));
  check('unknown fields are dropped', extra.item.somethingElse, undefined);
  check('and so are long ones', extra.item.notes, undefined);
});

group('names', function () {
  check('a blank name is labelled, not rejected', save(Object.assign({}, GOOD, { name: '  ' })).item.name, 'Unnamed');
  check('a missing name too', save(Object.assign({}, GOOD, { name: undefined })).item.name, 'Unnamed');
  check('a non-string name too', save(Object.assign({}, GOOD, { name: 42 })).item.name, 'Unnamed');
  check('whitespace is trimmed', save(Object.assign({}, GOOD, { name: '  oats  ' })).item.name, 'oats');

  var long = save(Object.assign({}, GOOD, { name: 'x'.repeat(500) }));
  check('a long name is cut to the limit', long.item.name.length, Journal.limits.MAX_NAME);

  // Control characters would break the one-object-per-line file this is stored
  // in, and a newline inside a name is a second row that parses as nothing.
  var nasty = save(Object.assign({}, GOOD, { name: 'oats\nrice\ttea' }));
  check('newlines cannot split a record in two', nasty.item.name.indexOf('\n'), -1);
  check('nor tabs', nasty.item.name.indexOf('\t'), -1);
});

group('numbers', function () {
  check('a negative price is dropped', save(Object.assign({}, GOOD, { price: -5 })).item.price, null);
  check('a string price is dropped', save(Object.assign({}, GOOD, { price: '4.29' })).item.price, null);
  check('infinity is dropped', save(Object.assign({}, GOOD, { calories: Infinity })).item.calories, null);
  check('NaN is dropped', save(Object.assign({}, GOOD, { calories: NaN })).item.calories, null);
  check('an absurd figure is dropped', save(Object.assign({}, GOOD, { calories: 1e12 })).item.calories, null);
  check('millilitres are kept as a unit', save(Object.assign({}, GOOD, { servingUnit: 'ml' })).item.servingUnit, 'ml');
  check('an unknown unit becomes grams', save(Object.assign({}, GOOD, { servingUnit: 'furlong' })).item.servingUnit, 'g');

  // A row with a name and no figures at all is not a record of anything.
  check('an empty record is refused', save({ name: 'nothing' }).error, 'nothing to record');
  check('so is a non-object', save(null).error, 'not an object');
});

group('the clock', function () {
  // A save made in a shop with no signal syncs hours later, so the phone's
  // time is the true one — the moment it arrives at the server is not.
  var earlier = NOW - 6 * 3600000;
  check('a client timestamp is honoured', save(Object.assign({}, GOOD, { at: earlier })).item.at, earlier);

  // ...but a phone with a broken clock must not be able to file an item at one
  // end of every sort, forever.
  check('a 1970 timestamp is refused', save(Object.assign({}, GOOD, { at: 1000 })).item.at, NOW);
  check('and so is one far in the future', save(Object.assign({}, GOOD, { at: NOW + 999 * 86400000 })).item.at, NOW);
  check('a missing timestamp uses the server clock', save(Object.assign({}, GOOD, { at: undefined })).item.at, NOW);
});

group('collapsing the file', function () {
  var rows = [
    { id: 'a', at: 3, name: 'oats' },
    { id: 'b', at: 1, name: 'rice' },
    { id: 'a', at: 4, name: 'oats, renamed' },        // a later write for the same item
    { kind: 'mark', id: 'b', hidden: true },
    { kind: 'somethingNewer', id: 'c' }               // written by a future version
  ];
  var out = Journal.collapse(rows);

  check('one row per item', out.length, 2);
  check('sorted oldest first', out[0].id, 'b');
  check('the last write wins', out[1].name, 'oats, renamed');
  check('a note hides its item', out[0].hidden, true);
  check('and leaves the other alone', out[1].hidden, undefined);

  // Hiding is a note, and a note can be taken back. Nothing is ever deleted.
  var unhidden = Journal.collapse(rows.concat([{ kind: 'mark', id: 'b', hidden: false }]));
  check('hiding can be undone', unhidden[0].hidden, false);
  check('and the row was never lost', unhidden.length, 2);

  check('an empty file collapses to nothing', Journal.collapse([]).length, 0);
  check('and so does junk', Journal.collapse([null, 4, 'x', undefined]).length, 0);

  var mark = Journal.sanitizeMark({ id: 'a', hidden: true }, NOW);
  check('a mark is accepted', mark.item.kind, 'mark');
  check('a mark with no id is refused', Journal.sanitizeMark({ hidden: true }, NOW).error, 'no item named');
  check('a mark with nothing to say is refused', Journal.sanitizeMark({ id: 'a' }, NOW).error, 'nothing to note');
});

group('the rest of the panel', function () {
  var full = save(Object.assign({}, GOOD, {
    nutrients: {
      fat: 17, saturatedFat: 9, transFat: 0, polyunsaturatedFat: 3,
      monounsaturatedFat: 4.5, cholesterol: 15, sodium: 200, carbs: 60,
      fiber: 1, sugars: 42, addedSugars: 42, protein: 2,
      vitaminD: 0, calcium: 20, iron: 1.6, potassium: 80
    }
  }));
  check('the panel is kept', full.item.nutrients.sodium, 200);
  check('decimals survive', full.item.nutrients.monounsaturatedFat, 4.5);
  check('so do zeroes', full.item.nutrients.transFat, 0);

  // Only the named keys. A record whose shape depends on what a client felt
  // like sending is not a record.
  var junk = save(Object.assign({}, GOOD, {
    nutrients: { sodium: 200, caffeine: 90, __proto__: { x: 1 }, notes: 'hello' }
  }));
  check('a known key is kept', junk.item.nutrients.sodium, 200);
  check('an unknown one is dropped', junk.item.nutrients.caffeine, undefined);
  check('and so is a string', junk.item.nutrients.notes, undefined);

  // Same clamping as every other figure. One good value rides along so the
  // field survives to be inspected — with all of them dropped there is no
  // field at all, which is the next check.
  var bad = save(Object.assign({}, GOOD, {
    nutrients: { fat: 17, sodium: -5, calcium: Infinity, iron: 'lots', protein: 1e9 }
  }));
  check('the good one is kept', bad.item.nutrients.fat, 17);
  check('a negative is dropped', bad.item.nutrients.sodium, undefined);
  check('infinity is dropped', bad.item.nutrients.calcium, undefined);
  check('a string is dropped', bad.item.nutrients.iron, undefined);
  check('an absurd figure is dropped', bad.item.nutrients.protein, undefined);

  // Every value rejected means no field, rather than an empty object on the row.
  var allBad = save(Object.assign({}, GOOD, { nutrients: { sodium: -5, iron: 'lots' } }));
  check('nothing usable, no field', allBad.item.nutrients, undefined);

  // Nothing sent means no field at all, rather than an empty object cluttering
  // every row in the file.
  check('no panel, no field', save(GOOD).item.nutrients, undefined);
  check('an empty panel likewise', save(Object.assign({}, GOOD, { nutrients: {} })).item.nutrients, undefined);
  check('and junk in its place', save(Object.assign({}, GOOD, { nutrients: 'x' })).item.nutrients, undefined);
});

group('the export', function () {
  var csv = Journal.toCsv([save(GOOD).item]);
  var lines = csv.trim().split('\n');
  check('a header and a row', lines.length, 2);
  check('the name is in it', lines[1].indexOf('"Store brand oats"') !== -1, true);
  check('a readable date is added', lines[1].indexOf('T') !== -1, true);

  // A name is the one free-text column here, and a spreadsheet treats a cell
  // starting =, + or @ as a formula to run. A product called "=cmd" must land
  // as text.
  var formula = Journal.toCsv([save(Object.assign({}, GOOD, { name: '=1+1' })).item]);
  check('a formula name is defused', formula.indexOf('"\'=1+1"') !== -1, true);

  // A quote in a name must not end the field early.
  var quoted = Journal.toCsv([save(Object.assign({}, GOOD, { name: 'the "good" oats' })).item]);
  check('quotes are escaped', quoted.indexOf('"the ""good"" oats"') !== -1, true);

  check('an empty export is still a header', Journal.toCsv([]).trim().split('\n').length, 1);

  // Each panel line gets its own column, so a spreadsheet can sort on protein
  // per dollar without anyone unpacking a nested field first.
  var withPanel = Journal.toCsv([save(Object.assign({}, GOOD, {
    nutrients: { sodium: 200, protein: 2, iron: 1.6 }
  })).item]);
  var head = withPanel.split('\n')[0].split(',');
  var row = withPanel.split('\n')[1].split(',');
  check('sodium has a column', head.indexOf('sodium') !== -1, true);
  check('and potassium too', head.indexOf('potassium') !== -1, true);
  check('the value lands under it', row[head.indexOf('sodium')], '200');
  check('a decimal survives the export', row[head.indexOf('iron')], '1.6');
  // A line the panel never gave is an empty cell, not a zero — those are
  // different facts and a spreadsheet will average them differently.
  check('an unread line is blank, not zero', row[head.indexOf('calcium')], '');
  check('the row is as wide as the header', row.length, head.length);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
