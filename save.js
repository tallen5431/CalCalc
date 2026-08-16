/* Saving a named item, from either screen.
 *
 * The server holds the record, but the phone is the thing standing in the shop
 * — quite possibly with no signal and certainly off the tailnet. So a save is
 * written to the phone first and sent afterwards: nothing is ever lost to being
 * out of range, and the aisle is exactly where the saving happens.
 *
 * Every entry carries an id generated here, so a queued save that is retried
 * lands on the same row rather than filing a second copy of the same item.
 */

(function (root, factory) {
  root.Save = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var QUEUE_KEY = 'calcalc.pending.v1';

  function loadQueue() {
    try {
      var q = JSON.parse(localStorage.getItem(QUEUE_KEY));
      return Array.isArray(q) ? q : [];
    } catch (e) {
      return [];
    }
  }

  function storeQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
  }

  function newId() {
    return 'i' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  /* Builds the row from what is on screen. The flags travel with the numbers on
   * purpose: a saved figure without a record of how much to trust it is what
   * makes a log impossible to audit a month later, when the panel it came from
   * is in a bin. */
  function buildItem(name, metrics, parsed, source) {
    var p = parsed || {};
    return {
      id: newId(),
      at: Date.now(),
      name: name,

      calories: metrics.calories,
      servingAmount: metrics.servingGrams,
      servingUnit: metrics.servingUnit === 'ml' ? 'ml' : 'g',
      servingsPerContainer: metrics.servingsPerContainer,
      netWeightGrams: metrics.containerBasis === 'netWeight' ? metrics.totalGrams : null,
      price: metrics.price,

      caloriesPerGram: metrics.caloriesPerGram,
      totalCalories: metrics.totalCalories,
      caloriesPerDollar: metrics.caloriesPerDollar,
      dollarsPerThousandCalories: metrics.dollarsPerThousandCalories,
      containerBasis: metrics.containerBasis,

      source: source,
      caloriesConfirmed: !!p.caloriesConfirmed,
      caloriesCorrected: !!p.caloriesCorrected,
      caloriesFromMacros: !!p.caloriesFromMacros,
      caloriesDisagree: !!p.caloriesDisagree,
      servingCorrected: !!p.servingCorrected,
      servingUnitInferred: !!p.servingUnitInferred
    };
  }

  // Resolves to { queued: n } — how many are still waiting to reach the server.
  // Zero means everything is filed; anything else is not an error, it is a
  // phone that is out of range and will catch up.
  function save(name, metrics, parsed, source) {
    var item = buildItem(name, metrics, parsed, source);
    var q = loadQueue();
    q.push(item);
    storeQueue(q);
    return flush();
  }

  /* Sends whatever is waiting, oldest first, and stops at the first failure so
   * the order the shelf was walked in is the order the records are filed in.
   * A 4xx is the one case where a row is dropped: the server has looked at it
   * and refused it, so retrying forever would block every later save behind an
   * entry that can never land. */
  function flush() {
    var q = loadQueue();
    if (!q.length) return Promise.resolve({ queued: 0 });

    var item = q[0];
    return fetch('api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    }).then(function (res) {
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        var rest = loadQueue();
        rest.shift();
        storeQueue(rest);
        return flush();
      }
      return { queued: loadQueue().length };      // 5xx: keep it, try later
    }).catch(function () {
      return { queued: loadQueue().length };      // offline
    });
  }

  function pending() {
    return loadQueue().length;
  }

  return { save: save, flush: flush, pending: pending, buildItem: buildItem };
}));
