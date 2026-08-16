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

  /* The queue is held in memory and mirrored to localStorage, rather than
   * living in localStorage and being re-read each time.
   *
   * Writing to storage can fail — private browsing refuses it, and a full quota
   * throws — and it fails by throwing, which was caught and ignored. The queue
   * was then re-read from the storage that had just refused the write, came
   * back empty, and the screen said "Saved". The item had been neither stored
   * nor sent, and nothing anywhere said so.
   *
   * In memory it survives at least until the page is closed, which is long
   * enough for the next flush to get it to the server; and when storage does
   * work — the normal case — the mirror keeps it across reloads and lets a
   * second tab see it.
   */
  var queue = hydrate();

  function hydrate() {
    try {
      var q = JSON.parse(localStorage.getItem(QUEUE_KEY));
      return Array.isArray(q) ? q : [];
    } catch (e) {
      return [];
    }
  }

  function persist() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) {
      // Storage is refusing writes. The queue is still in memory, so the save
      // is not lost — it just will not survive this page being closed.
    }
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
      // The pack's mass, however the container total was arrived at. Keeping it
      // only when the total *came* from it threw the figure away whenever a
      // servings count was also known — so a record could say what the package
      // holds in calories but not what it weighs, which is half of what you go
      // back to a record for.
      netWeightGrams: (typeof metrics.totalGrams === 'number' && isFinite(metrics.totalGrams))
        ? metrics.totalGrams : null,
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
    queue.push(buildItem(name, metrics, parsed, source));
    persist();
    return flush();
  }

  /* Sends whatever is waiting, oldest first, and stops at the first failure so
   * the order the shelf was walked in is the order the records are filed in.
   * A 4xx is the one case where a row is dropped: the server has looked at it
   * and refused it, so retrying forever would block every later save behind an
   * entry that can never land. */
  function flush() {
    if (!queue.length) return Promise.resolve({ queued: 0 });

    var item = queue[0];
    return fetch('api/items', {
      // application/json is required by the server, and deliberately: it is
      // what makes this a request a browser will not send cross-origin without
      // asking permission first.
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    }).then(function (res) {
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        // Removed by identity rather than by position: another flush may have
        // been running, and shifting blind would drop whatever is at the front
        // now instead of the row that was actually accepted.
        var at = queue.indexOf(item);
        if (at !== -1) queue.splice(at, 1);
        persist();
        return flush();
      }
      return { queued: queue.length };      // 5xx: keep it, try later
    }).catch(function () {
      return { queued: queue.length };      // offline
    });
  }

  function pending() {
    return queue.length;
  }

  return { save: save, flush: flush, pending: pending, buildItem: buildItem };
}));
