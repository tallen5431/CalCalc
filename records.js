/* Everything saved, and the orders worth reading it in.
 *
 * A single scan answers "what am I holding". This page answers the question a
 * record exists for — "which of these is the better buy" — which needs the
 * items beside each other and sorted, not listed in the order they happened.
 */

(function () {
  'use strict';

  var el = {};
  ['list', 'count', 'empty', 'pending', 'sorter', 'csv', 'showHidden'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  var items = [];
  var sort = 'perDollar';
  var showHidden = false;

  /* ---------- loading ---------- */

  function load() {
    // Anything saved while the phone was out of range goes first, so the list
    // it is about to draw includes it rather than appearing to have lost it.
    Save.flush().then(function (r) {
      if (r.queued) {
        el.pending.textContent = r.queued + ' item' + (r.queued === 1 ? '' : 's') +
          ' saved on this phone could not reach the server. They are still here ' +
          'and will be sent when it can.';
        el.pending.hidden = false;
      } else {
        el.pending.hidden = true;
      }
      return fetch('api/items' + (showHidden ? '?hidden=1' : ''), { cache: 'no-store' });
    }).then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json();
    }).then(function (data) {
      items = data.items || [];
      render();
    }).catch(function () {
      el.empty.textContent = 'Could not reach the CalCalc server, so the saved ' +
        'items cannot be shown. Anything saved on this phone is still safe and ' +
        'will be sent when the server is reachable again.';
      el.empty.hidden = false;
      el.list.textContent = '';
      el.count.textContent = '';
    });
  }

  /* ---------- sorting ----------
   *
   * Items missing the figure being sorted on go last rather than being dropped:
   * a scan with no price is still a record of the food, and hiding it here
   * would make the list quietly disagree with the count above it.
   */
  var SORTS = {
    perDollar: function (a, b) { return nullsLast(b.caloriesPerDollar, a.caloriesPerDollar); },
    perGram: function (a, b) { return nullsLast(b.caloriesPerGram, a.caloriesPerGram); },
    cheapest: function (a, b) { return nullsLast(a.dollarsPerThousandCalories, b.dollarsPerThousandCalories, true); },
    newest: function (a, b) { return (b.at || 0) - (a.at || 0); }
  };

  // `desc` sorts high-to-low, so a null must sort *below* every number; `asc`
  // sorts low-to-high, so it must sort above. One comparator either way.
  function nullsLast(x, y, asc) {
    var xn = (x === null || x === undefined || !isFinite(x));
    var yn = (y === null || y === undefined || !isFinite(y));
    if (xn && yn) return 0;
    if (xn) return asc ? 1 : -1;
    if (yn) return asc ? -1 : 1;
    return x - y;
  }

  /* ---------- rendering ----------
   *
   * Built with createElement and textContent throughout. Names are typed by a
   * person and stored verbatim, so this page renders text that came from an
   * input box — putting it through innerHTML would make the item name a place
   * to write markup that later runs on the origin holding every record.
   */
  function render() {
    el.list.textContent = '';

    var rows = items.slice().sort(SORTS[sort] || SORTS.newest);

    el.count.textContent = rows.length
      ? rows.length + (rows.length === 1 ? ' item' : ' items')
      : '';

    if (!rows.length) {
      el.empty.textContent = 'Nothing saved yet. Scan a label, tap 💾 Save and give it a name — ' +
        'then this page will tell you which of them is the most food for the money.';
      el.empty.hidden = false;
      return;
    }
    el.empty.hidden = true;

    var best = bestPerDollar(rows);

    rows.forEach(function (item) {
      el.list.appendChild(row(item, best));
    });
  }

  function bestPerDollar(rows) {
    var best = null;
    rows.forEach(function (r) {
      if (r.hidden) return;
      if (typeof r.caloriesPerDollar !== 'number' || !isFinite(r.caloriesPerDollar)) return;
      if (best === null || r.caloriesPerDollar > best) best = r.caloriesPerDollar;
    });
    return best;
  }

  function row(item, best) {
    var li = document.createElement('li');
    li.className = 'record' + (item.hidden ? ' hidden-record' : '');

    var head = document.createElement('div');
    head.className = 'record-head';

    var name = document.createElement('span');
    name.className = 'record-name';
    name.textContent = item.name || 'Unnamed';
    head.appendChild(name);

    // The winner is marked rather than merely being at the top, because the top
    // of the list changes with the sort and the best value does not.
    if (best !== null && item.caloriesPerDollar === best && !item.hidden) {
      var star = document.createElement('span');
      star.className = 'best';
      star.textContent = 'best cal/$';
      head.appendChild(star);
    }

    li.appendChild(head);

    var figs = document.createElement('div');
    figs.className = 'record-figs';
    figure(figs, fmt(item.caloriesPerGram, 2), 'cal/' + (item.servingUnit === 'ml' ? 'mL' : 'g'));
    figure(figs, fmt(item.caloriesPerDollar, 0), 'cal/$');
    figure(figs, money(item.price), 'price');
    figure(figs, fmt(item.totalCalories, 0), 'cal in pack');
    li.appendChild(figs);

    var meta = document.createElement('div');
    meta.className = 'record-meta';
    meta.appendChild(text(when(item.at)));
    if (item.containerBasis === 'netWeight') meta.appendChild(tag('pack size from mass'));
    if (item.source === 'typed') meta.appendChild(tag('typed'));
    // How much to trust the reading, kept with it. A record of a number with no
    // record of how it was arrived at cannot be checked once the box is gone.
    var f = item.flags || {};
    if (f.confirmed) meta.appendChild(tag('macros agreed'));
    if (f.caloriesCorrected) meta.appendChild(tag('calories corrected', true));
    if (f.fromMacros) meta.appendChild(tag('calories from macros', true));
    if (f.disagreed) meta.appendChild(tag('macros disagreed', true));
    if (f.servingCorrected) meta.appendChild(tag('serving corrected', true));
    if (f.unitInferred) meta.appendChild(tag('unit assumed', true));
    li.appendChild(meta);

    var act = document.createElement('button');
    act.type = 'button';
    act.className = 'record-hide';
    act.textContent = item.hidden ? 'Unhide' : 'Hide';
    act.addEventListener('click', function () {
      act.disabled = true;
      mark(item.id, !item.hidden).then(load);
    });
    li.appendChild(act);

    return li;
  }

  function figure(parent, value, label) {
    var d = document.createElement('div');
    d.className = 'fig';
    var v = document.createElement('span');
    v.textContent = value;
    var s = document.createElement('small');
    s.textContent = label;
    d.appendChild(v);
    d.appendChild(s);
    parent.appendChild(d);
  }

  function text(s) {
    var span = document.createElement('span');
    span.textContent = s;
    return span;
  }

  function tag(s, warn) {
    var span = document.createElement('span');
    span.className = 'tag' + (warn ? ' warn' : '');
    span.textContent = s;
    return span;
  }

  // Hiding appends a note; nothing is deleted. A mis-tap in a shop should cost
  // an entry in a list rather than a record.
  function mark(id, hidden) {
    return fetch('api/items/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, hidden: hidden })
    }).catch(function () { /* the reload will show it unchanged */ });
  }

  /* ---------- formatting ---------- */

  function fmt(n, d) {
    if (typeof n !== 'number' || !isFinite(n)) return '--';
    return n.toFixed(d);
  }

  function money(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '--';
    return '$' + n.toFixed(2);
  }

  function when(at) {
    if (!at) return '';
    var d = new Date(at);
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  /* ---------- controls ---------- */

  el.sorter.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    sort = btn.dataset.sort;
    Array.prototype.forEach.call(el.sorter.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b === btn);
    });
    render();
  });

  el.showHidden.addEventListener('change', function (e) {
    showHidden = e.target.checked;
    load();
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  load();
})();
