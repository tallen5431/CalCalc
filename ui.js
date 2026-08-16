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
    { id: 'fPrice', key: 'price', max: 100000 }
  ];

  var state = load();

  var el = {};
  ['readout', 'perGram', 'perGramUnit', 'perDollar', 'perDollarRow',
   'vTotal', 'vPerServing', 'vPer1000', 'warn', 'fMilliliters', 'btnClear'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
    return {
      calories: numOrNull(s.calories),
      servingGrams: numOrNull(s.servingGrams),
      servingsPerContainer: numOrNull(s.servingsPerContainer),
      price: numOrNull(s.price),
      milliliters: !!s.milliliters
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
    var stub = state.milliliters ? { servingUnit: 'ml' } : null;
    return LabelParser.metrics(stub, {
      calories: state.calories,
      servingGrams: state.servingGrams,
      servingsPerContainer: state.servingsPerContainer,
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
      notes.push('Calories per dollar needs servings per container as well, so the price can be spread over the package.');
    }
    el.warn.textContent = notes.join(' ');
    el.warn.hidden = !notes.length;
  }

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

  el.fMilliliters.checked = state.milliliters;
  el.fMilliliters.addEventListener('change', function (e) {
    state.milliliters = e.target.checked;
    save();
    render();
  });

  el.btnClear.addEventListener('click', function () {
    state.calories = null;
    state.servingGrams = null;
    state.servingsPerContainer = null;
    state.price = null;
    save();
    FIELDS.forEach(function (f) { document.getElementById(f.id).value = ''; });
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
