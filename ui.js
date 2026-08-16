/* The typed calculator. Same arithmetic as the scanner, reached without a
   camera — which is what you want on a phone over plain http, on a desktop,
   or when the panel is crumpled and the reader will not have it. */

(function () {
  'use strict';

  var KEY = 'calcalc.typed.v1';

  var FIELDS = [
    { id: 'fCalories', key: 'calories', max: 10000 },
    { id: 'fGrams', key: 'servingGrams', max: 100000 },
    { id: 'fServings', key: 'servingsPerContainer', max: 9999 },
    { id: 'fNetWeight', key: 'netWeight', max: 1000000 },
    { id: 'fPrice', key: 'price', max: 100000 }
  ];

  var UNIT_FIELDS = [
    { id: 'fGramsUnit', key: 'servingUnit' },
    { id: 'fNetWeightUnit', key: 'netWeightUnit' }
  ];

  var state = load();

  var el = {};
  ['readout', 'perGram', 'perGramUnit', 'perDollar', 'perDollarRow',
   'vTotal', 'vPerServing', 'vPer1000', 'warn', 'btnClear',
   'btnSave', 'saveNote', 'nameSheet', 'setName', 'btnSaveConfirm', 'saveSummary'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
    return {
      calories: numOrNull(s.calories),
      servingGrams: numOrNull(s.servingGrams),
      servingsPerContainer: numOrNull(s.servingsPerContainer),
      netWeight: numOrNull(s.netWeight),
      price: numOrNull(s.price),
      // An older save may carry the millilitres checkbox this replaced. It is
      // read once so a phone that has been using the app does not silently
      // switch a drink back to grams on upgrade.
      servingUnit: s.servingUnit || (s.milliliters ? 'ml' : 'g'),
      netWeightUnit: s.netWeightUnit || 'g'
    };
  }

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(v);
    return (isFinite(n) && n >= 0) ? n : null;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function round(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '--';
    return n.toFixed(d === undefined ? 0 : d);
  }

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return '--';
    return '$' + n.toFixed(2);
  }

  /* ---------- the numbers ----------
   *
   * Typed input goes through the same metrics() the camera uses. There is one
   * set of arithmetic in this project and both screens call it, so the two can
   * never drift into disagreeing about what a food costs.
   */
  function compute() {
    // A hand-typed entry has no parsed panel behind it, so the overrides carry
    // everything. metrics() is built to be handed null for exactly this.
    var serving = LabelParser.convert(state.servingGrams, state.servingUnit);
    var pack = LabelParser.convert(state.netWeight, state.netWeightUnit);

    return LabelParser.metrics(null, {
      calories: state.calories,
      servingGrams: serving.amount,
      servingUnit: serving.measure,
      servingsPerContainer: state.servingsPerContainer,
      netWeightGrams: pack.amount,
      price: state.price
    });
  }

  function render() {
    var m = compute();

    el.readout.className = 'verdict ' + (m.ready ? (m.band || 'empty') : 'empty');

    el.perGram.textContent = m.caloriesPerGram === null ? '--' : round(m.caloriesPerGram, 2);
    el.perGramUnit.textContent = 'cal/' + m.perGramUnit;

    var hasRate = m.caloriesPerDollar !== null;
    el.perDollarRow.hidden = !hasRate;
    if (hasRate) el.perDollar.textContent = round(m.caloriesPerDollar, 0);

    el.vTotal.textContent = m.totalCalories === null ? '--' : round(m.totalCalories, 0) + ' cal';
    el.vPerServing.textContent = money(m.costPerServing);
    el.vPer1000.textContent = money(m.dollarsPerThousandCalories);

    var notes = [];
    if (m.caloriesPerGram === null && (state.calories !== null || state.servingGrams !== null)) {
      notes.push('Calories per gram needs both the calories and the serving size.');
    }
    if (m.caloriesPerGram !== null && m.caloriesPerGram > LabelParser.limits.MAX_KCAL_PER_G) {
      // Not blocked, because a person typing has reasons a camera does not —
      // but nothing edible is denser than pure fat, so it is worth saying.
      notes.push('That is denser than pure fat (' + LabelParser.limits.MAX_KCAL_PER_G +
                 ' cal/g). Check the serving size.');
    }
    if (state.price !== null && state.price > 0 && m.caloriesPerDollar === null) {
      notes.push('Calories per dollar needs the size of the package too — fill in either ' +
                 'servings per container or the package mass.');
    }
    if (m.containerBasis === 'netWeight') {
      notes.push('Container figures are from the package mass, not a servings count.');
    }
    el.warn.textContent = notes.join(' ');
    el.warn.hidden = !notes.length;

    el.btnSave.hidden = !m.ready;
  }

  /* ---------- saving ---------- */

  el.btnSave.addEventListener('click', function () {
    var m = compute();
    if (!m.ready) return;
    var bits = [round(m.caloriesPerGram, 2) + ' cal/' + m.perGramUnit];
    if (m.caloriesPerDollar !== null) bits.push(round(m.caloriesPerDollar, 0) + ' cal/$');
    if (m.price !== null) bits.push(money(m.price));
    el.saveSummary.textContent = bits.join(' · ');
    el.setName.value = '';
    el.nameSheet.hidden = false;
    setTimeout(function () { el.setName.focus(); }, 50);
  });

  el.btnSaveConfirm.addEventListener('click', function () {
    var name = el.setName.value.trim();
    el.nameSheet.hidden = true;
    el.btnSaveConfirm.disabled = true;
    // No parsed panel behind a typed entry, so no reading flags — the record
    // says `typed` and that is the whole story of where the numbers came from.
    Save.save(name, compute(), null, 'typed').then(function (r) {
      el.btnSaveConfirm.disabled = false;
      el.saveNote.textContent = r.queued
        ? 'Kept on this device — ' + r.queued + ' waiting to reach the server.'
        : 'Saved “' + (name || 'Unnamed') + '”.';
      el.saveNote.hidden = false;
      setTimeout(function () { el.saveNote.hidden = true; }, 4000);
    });
  });

  el.setName.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); el.btnSaveConfirm.click(); }
  });

  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { document.getElementById(b.dataset.close).hidden = true; });
  });

  /* ---------- input ---------- */

  FIELDS.forEach(function (f) {
    var input = document.getElementById(f.id);
    input.value = state[f.key] === null ? '' : state[f.key];
    input.addEventListener('input', function (e) {
      var raw = e.target.value.trim();
      if (raw === '') {
        state[f.key] = null;
      } else {
        var v = parseFloat(raw);
        state[f.key] = (isFinite(v) && v >= 0) ? Math.min(f.max, v) : null;
      }
      save();
      render();
    });
  });

  UNIT_FIELDS.forEach(function (u) {
    var sel = document.getElementById(u.id);
    sel.value = state[u.key];
    sel.addEventListener('change', function (e) {
      state[u.key] = e.target.value;
      save();
      render();
    });
  });

  el.btnClear.addEventListener('click', function () {
    FIELDS.forEach(function (f) {
      state[f.key] = null;
      document.getElementById(f.id).value = '';
    });
    // Units are deliberately left alone. Someone working through a shelf of
    // drinks has set mL once and should not have to set it again for every
    // bottle, and CLR is for the numbers.
    save();
    render();
    document.getElementById('fCalories').focus();
  });

  // Registering fails on an untrusted certificate and that is fine — it costs
  // the offline install, not the app.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  render();
})();
