/* Camera scanner: point the phone at a Nutrition Facts panel, read it, show
   calories per gram — and once a price is typed, calories per dollar.

   All processing is local. The OCR engine, its language model and every frame
   stay on the device; nothing is uploaded and no image is stored. */

(function () {
  'use strict';

  var SETTINGS_KEY = 'calcalc.settings.v1';
  var DEFAULTS = {
    price: null,
    calories: null, servingGrams: null, servingsPerContainer: null,
    netWeight: null,
    // The units the two typed weights are in. Kept beside the numbers rather
    // than derived from the scan, because the whole point of typing one is
    // that the scan could not read it.
    servingUnit: 'g', netWeightUnit: 'g',
    fullFrame: false, haptics: true
  };

  // Two readings that agree is the difference between acting on a number and
  // acting on a glitch. Cheap to require when a read takes a fraction of a
  // second, and a nutrition panel does not run away like an offer card does.
  var AGREE_TO_LOCK = 2;
  var MISSES_TO_RESET = 4;
  var MAX_OCR_WIDTH = 1600;   // beyond this the engine slows with no gain

  var settings = load();
  var worker = null;
  var running = false, frozen = false, busy = false;
  var lastSig = null, agree = 0, misses = 0, locked = false;
  var lastParsed = null;

  var el = {};
  ['video', 'frame', 'reticle', 'verdict', 'verdictLabel', 'perGram', 'perGramUnit',
   'perDollar', 'perDollarRow', 'vCal', 'vServing', 'vServings', 'vTotal',
   'warn', 'statusline', 'btnFreeze', 'photo', 'btnPrice',
   'btnSave', 'saveNote', 'nameSheet', 'setName', 'btnSaveConfirm', 'saveSummary'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  var ctx = el.frame.getContext('2d', { willReadFrequently: true });

  /* ---------- settings ---------- */

  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) {}
    var out = {};
    for (var k in DEFAULTS) {
      out[k] = (s[k] === null || s[k] === undefined) ? DEFAULTS[k] : s[k];
    }
    return out;
  }

  function save() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function buzz(p) {
    if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} }
  }

  /* ---------- engine ---------- */

  function status(msg) { el.statusline.textContent = msg; }

  async function startEngine() {
    status('loading reader…');
    worker = await Tesseract.createWorker('eng', 1, {
      workerPath: 'vendor/worker.min.js',
      corePath: 'vendor/core',
      langPath: 'vendor/lang',
      gzip: true
    });
    await applyPsm();
    return worker;
  }

  function applyPsm() {
    // A tight crop on the panel is a single block of text; a whole shelf is not.
    return worker.setParameters({ tessedit_pageseg_mode: settings.fullFrame ? '3' : '6' });
  }

  /* ---------- camera ---------- */

  // Browsers only expose a camera on HTTPS or localhost. Over plain http on a
  // LAN address navigator.mediaDevices is simply absent, which surfaces as an
  // unhelpful TypeError unless it is named for what it is.
  function cameraBlockedReason() {
    if (window.isSecureContext === false) return 'insecure';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'unsupported';
    return null;
  }

  // The page cannot know what address would have worked, but the server can:
  // it knows whether Tailscale is up and what this machine is called on the
  // tailnet. Being told "open https://box.tailnet.ts.net" beats being told
  // "cameras need HTTPS" by the entire distance between a fix and a fact.
  async function suggestSecureUrl() {
    try {
      // Relative, not "/api/status". `tailscale serve --set-path /calcalc`
      // mounts this app under a prefix and strips it before proxying, so an
      // absolute path here leaves the app's own address entirely and asks
      // whatever owns the root of that host — a different application — for
      // its status.
      var res = await fetch('api/status', { cache: 'no-store' });
      if (!res.ok) return null;
      var s = await res.json();

      // Only an address Tailscale confirms is mounted on THIS app. A tailnet
      // name is not an address: one machine commonly serves several things and
      // whichever holds "/" owns that URL. Assembling one from the hostname
      // sent phones to the wrong application with the scanner presenting the
      // link as the fix.
      if (s.tailscale && s.tailscale.serveUrl) {
        return { url: s.tailscale.serveUrl, how: 'tailscale' };
      }
      if (s.https && s.httpsPort) {
        return { url: 'https://' + location.hostname + ':' + s.httpsPort + '/scan.html', how: 'cert' };
      }
      // Nothing is serving this app over HTTPS. Saying so, with the command
      // that fixes it, beats offering a link that goes somewhere else.
      if (s.tailscale && s.tailscale.hostname) {
        return { how: 'unserved', port: s.httpPort, host: s.tailscale.hostname };
      }
      return null;
    } catch (e) {
      return null;   // opened from a file, or the server is something else
    }
  }

  async function explainNoCamera(reason) {
    if (reason === 'insecure') {
      el.verdictLabel.textContent = 'CAMERA NEEDS HTTPS';
      var base = 'You are on ' + location.protocol + '//' + location.host +
        '. Browsers only allow camera access over HTTPS or on localhost. ';
      el.warn.textContent = base + 'The 📷 Photo button below still works — it runs the same reader on a photo.';
      el.warn.hidden = false;

      var hint = await suggestSecureUrl();
      if (hint && hint.how === 'unserved') {
        // Nothing publishes this app over HTTPS. There is no link to give, so
        // it gives the command instead rather than inventing an address.
        el.warn.textContent = base + 'Nothing is serving this app over HTTPS yet. On ' +
          hint.host + ', run:';
        var code = document.createElement('code');
        code.className = 'fixcode';
        code.textContent = 'sudo tailscale serve --bg --https=8443 ' + (hint.port || 8090);
        el.warn.appendChild(document.createElement('br'));
        el.warn.appendChild(code);
      } else if (hint) {
        el.warn.textContent = base + 'Open this instead:';
        var a = document.createElement('a');
        a.href = hint.url;
        a.textContent = hint.url;
        a.className = 'fixlink';
        el.warn.appendChild(document.createElement('br'));
        el.warn.appendChild(a);
        if (hint.how === 'cert') {
          el.warn.appendChild(document.createTextNode(
            ' — a self-signed certificate, so it warns once. Accepting it is enough for the camera.'));
        }
      }
    } else {
      el.verdictLabel.textContent = 'NO CAMERA';
      el.warn.textContent = 'This browser exposes no camera. Use 📷 Photo, or ⌨ Type.';
      el.warn.hidden = false;
    }
    status('camera unavailable — 📷 Photo still works');
  }

  // These failures need different answers, and calling them all "permission"
  // sends you to a settings page that cannot help.
  function explainCameraError(e) {
    var label = 'CAMERA UNAVAILABLE';
    var msg;
    if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
      label = 'NO CAMERA ON THIS DEVICE';
      msg = 'The browser found no camera at all, so this is not a permission ' +
        'problem. Open this page on the phone you want to scan with.';
    } else if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      label = 'CAMERA PERMISSION DENIED';
      msg = 'This site was refused the camera. Allow it in the browser\'s site ' +
        'settings and reload.';
    } else if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
      label = 'CAMERA IN USE';
      msg = 'Another app already holds the camera. Close it and reload.';
    } else {
      msg = 'The camera could not start (' + e.name + ': ' + e.message + ').';
    }
    el.verdictLabel.textContent = label;
    el.warn.textContent = msg + ' 📷 Photo below still works on any device.';
    el.warn.hidden = false;
    status('camera unavailable — 📷 Photo still works');
  }

  async function startCamera() {
    status('starting camera…');
    var stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 }, height: { ideal: 1080 }
      },
      audio: false
    });
    el.video.srcObject = stream;
    await el.video.play();
    await new Promise(function (r) {
      if (el.video.videoWidth) return r();
      el.video.onloadedmetadata = r;
    });
    // Small panels on a curved package need a close focus. Not every phone
    // offers it, and asking for it must never be the reason the camera fails.
    try {
      var track = stream.getVideoTracks()[0];
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch (e) { /* the camera works; it just focuses however it likes */ }
  }

  /* ---------- frame capture ---------- */

  // Maps the on-screen reticle back to pixels in the camera's own frame,
  // undoing the object-fit: cover crop the preview applies.
  function sourceRect() {
    var vw = el.video.videoWidth, vh = el.video.videoHeight;
    var box = el.video.getBoundingClientRect();
    var scale = Math.max(box.width / vw, box.height / vh);
    var offX = (vw * scale - box.width) / 2;
    var offY = (vh * scale - box.height) / 2;

    var r = el.reticle.getBoundingClientRect();
    var x = (r.left - box.left + offX) / scale;
    var y = (r.top - box.top + offY) / scale;
    var w = r.width / scale;
    var h = r.height / scale;

    return {
      x: Math.max(0, Math.min(vw, x)),
      y: Math.max(0, Math.min(vh, y)),
      w: Math.max(8, Math.min(vw, w)),
      h: Math.max(8, Math.min(vh, h))
    };
  }

  // Upscale and flatten to high-contrast grey. A nutrition panel is black on
  // white with fine rules between the lines, and the small print — the grams
  // after each macro — is what the cross-check depends on.
  function grab(source, rect) {
    var sw = rect ? rect.w : source.videoWidth || source.width;
    var sh = rect ? rect.h : source.videoHeight || source.height;
    var scale = Math.min(2, MAX_OCR_WIDTH / sw);
    if (!isFinite(scale) || scale <= 0) scale = 1;

    el.frame.width = Math.round(sw * scale);
    el.frame.height = Math.round(sh * scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (rect) ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, el.frame.width, el.frame.height);
    else ctx.drawImage(source, 0, 0, el.frame.width, el.frame.height);

    var img = ctx.getImageData(0, 0, el.frame.width, el.frame.height);
    var p = img.data;
    for (var i = 0; i < p.length; i += 4) {
      var v = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;
      v = (v - 128) * 1.6 + 128;
      p[i] = p[i + 1] = p[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    ctx.putImageData(img, 0, 0);
    return el.frame;
  }

  /* ---------- scanning ---------- */

  async function readOnce(source, rect) {
    var canvas = grab(source, rect);
    var t = performance.now();
    var res = await worker.recognize(canvas);
    var ms = Math.round(performance.now() - t);
    return { parsed: LabelParser.parse(res.data.text), ms: ms };
  }

  function consider(parsed) {
    if (!parsed.complete) {
      misses++;
      if (misses >= MISSES_TO_RESET) { locked = false; agree = 0; lastSig = null; lastParsed = null; }
      return;
    }
    misses = 0;
    var sig = parsed.calories + '|' + parsed.servingGrams + '|' + parsed.servingsPerContainer;
    agree = (sig === lastSig) ? agree + 1 : 1;
    lastSig = sig;

    var wasLocked = locked;
    // A reading the macros independently confirm has already been checked
    // against a second source, which is stronger evidence than the same frame
    // being read twice — so it locks on the first good frame.
    locked = agree >= AGREE_TO_LOCK || (parsed.caloriesConfirmed && agree >= 1);
    lastParsed = parsed;
    if (locked && !wasLocked) buzz([18, 40, 18]);
  }

  async function loop() {
    while (running) {
      if (frozen || busy || el.video.readyState < 2) { await sleep(80); continue; }
      busy = true;
      try {
        var out = await readOnce(el.video, settings.fullFrame ? null : sourceRect());
        consider(out.parsed);
        render(out.ms);
      } catch (e) {
        status('read failed: ' + e.message);
      }
      busy = false;
      await sleep(30);
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- render ---------- */

  function round(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '--';
    return n.toFixed(d === undefined ? 0 : d);
  }

  // A count that happens to be whole is written whole. Panels do say "about
  // 2.5 servings", so the decimal has to survive when there is one — but "8.0
  // servings" reads like a measurement rather than a count.
  function tidy(n) {
    if (n === null || n === undefined || !isFinite(n)) return '--';
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  // Typed weights are converted here, once, by the same helper the typed screen
  // uses — so an ounce means the same thing on both and neither has its own
  // copy of the number 28.35.
  function overrides() {
    var o = {
      price: settings.price,
      calories: settings.calories,
      servingsPerContainer: settings.servingsPerContainer
    };

    if (settings.servingGrams !== null) {
      var s = LabelParser.convert(settings.servingGrams, settings.servingUnit);
      o.servingGrams = s.amount;
      // A hand-typed serving size names its own measure. Without this a
      // 240 mL drink typed by hand would be labelled "cal/g".
      o.servingUnit = s.measure;
    }

    if (settings.netWeight !== null) {
      o.netWeightGrams = LabelParser.convert(settings.netWeight, settings.netWeightUnit).amount;
    }

    return o;
  }

  function render(ms) {
    var m = LabelParser.metrics(lastParsed, overrides());

    el.verdict.className = 'verdict ' + (m.ready ? (m.band || 'empty') : 'empty');
    document.body.classList.toggle('locked', locked);

    el.verdictLabel.textContent = !m.ready
      ? 'POINT AT THE PANEL'
      : (locked ? 'READ' : 'READING…');

    el.perGram.textContent = m.caloriesPerGram === null ? '--' : round(m.caloriesPerGram, 2);
    el.perGramUnit.textContent = 'cal/' + m.perGramUnit;

    // Shown only once there is a price and something to divide it into. An
    // empty second headline reading "--" invites the reading that it is zero.
    var hasRate = m.caloriesPerDollar !== null;
    el.perDollarRow.hidden = !hasRate;
    if (hasRate) el.perDollar.textContent = round(m.caloriesPerDollar, 0);

    el.vCal.textContent = m.calories === null ? '--' : round(m.calories, 0);
    el.vServing.textContent = m.servingGrams === null ? '--' : round(m.servingGrams, 0) + m.perGramUnit;
    el.vServings.textContent = tidy(m.servingsPerContainer);
    // No unit suffix: four columns across a phone is not enough room for one,
    // and "1840 c…" truncated mid-word is worse than no unit at all. The
    // column heading carries it instead.
    el.vTotal.textContent = m.totalCalories === null ? '--' : round(m.totalCalories, 0);

    // Offered only when there is a reading behind it. Freezing the scan first
    // is not required — but it is what most people do, and holding still while
    // typing a name is not possible, so the value is captured on tap rather
    // than read again on save.
    el.btnSave.hidden = !m.ready;

    el.warn.textContent = '';
    var notes = noteworthy(m);
    if (notes.length) {
      el.warn.textContent = notes.join(' ');
      el.warn.hidden = false;
    } else {
      el.warn.hidden = true;
    }

    status((ms ? ms + 'ms · ' : '') +
      (locked ? 'confirmed' : (m.ready ? 'confirming…' : 'searching…')) +
      (settings.fullFrame ? ' · whole frame' : ' · in box'));
  }

  // A read can warrant more than one note at once: a corrected calorie figure
  // and a missing container size are independent facts and both change what
  // the numbers on screen mean.
  function noteworthy(m) {
    var p = lastParsed;
    var notes = [];
    if (!p) return notes;

    if (p.caloriesDisagree) {
      notes.push('The calories and the macros disagree (panel says ' + round(p.caloriesRead, 0) +
                 ', its own fat/carbs/protein come to ' + round(p.atwaterCalories, 0) +
                 '). Check the calorie line.');
    }
    if (p.caloriesCorrected) {
      notes.push('Recovered a digit in the calories using the macros — check it.');
    }
    if (p.caloriesFromMacros) {
      notes.push('The calorie line was unreadable; this is worked out from the fat, carbs and protein.');
    }
    if (p.servingCorrected) {
      notes.push('Recovered a digit in the serving weight — check it.');
    }
    if (p.servingUnitInferred) {
      notes.push('The unit after the serving size was unreadable and has been taken as grams.');
    }
    if (p.servingUnit === 'ml') {
      notes.push('This panel measures its serving in millilitres, so the figure is per mL.');
    }
    if (m.ready && m.caloriesPerDollar === null && m.price !== null && m.price > 0) {
      notes.push('The package size was not read, so the price cannot be spread over it. ' +
                 'Under 💲 Price, type either the servings per container or the package mass.');
    }
    if (m.ready && m.price === null) {
      notes.push('Tap 💲 Price for calories per dollar.');
    }
    if (m.containerBasis === 'netWeight') {
      notes.push('Container total is from the net weight, not a servings count.');
    }
    return notes;
  }

  /* ---------- controls ---------- */

  el.btnFreeze.addEventListener('click', function () {
    frozen = !frozen;
    document.body.classList.toggle('frozen', frozen);
    el.btnFreeze.textContent = frozen ? '▶ Scan' : '⏸ Hold';
  });

  el.photo.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var img = new Image();
    img.onload = async function () {
      frozen = true;
      document.body.classList.add('frozen');
      el.btnFreeze.textContent = '▶ Scan';
      status('reading photo…');
      // A still has no successive frames to agree with, so trust one good read.
      var out = await readOnce(img, null);
      lastParsed = out.parsed;
      locked = out.parsed.complete;
      render(out.ms);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });

  el.btnPrice.addEventListener('click', function () {
    setValue('setPrice', settings.price);
    setValue('setCalories', settings.calories);
    setValue('setGrams', settings.servingGrams);
    setValue('setServings', settings.servingsPerContainer);
    setValue('setNetWeight', settings.netWeight);
    document.getElementById('setGramsUnit').value = settings.servingUnit;
    document.getElementById('setNetWeightUnit').value = settings.netWeightUnit;
    document.getElementById('priceSheet').hidden = false;
    // The price is the reason this sheet exists, so it is the field the
    // keyboard opens on.
    var price = document.getElementById('setPrice');
    setTimeout(function () { price.focus(); price.select(); }, 50);
  });

  function setValue(id, v) {
    document.getElementById(id).value = (v === null || v === undefined) ? '' : v;
  }

  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { document.getElementById(b.dataset.close).hidden = true; });
  });

  // A blank box means "use what was scanned", which is a different thing from
  // zero — so it is stored as null rather than coerced to a number.
  function bind(id, key, max) {
    document.getElementById(id).addEventListener('input', function (e) {
      var raw = e.target.value.trim();
      if (raw === '') {
        settings[key] = null;
      } else {
        var v = parseFloat(raw);
        settings[key] = (isFinite(v) && v >= 0) ? Math.min(max, v) : null;
      }
      save();
      render(0);
    });
  }
  bind('setPrice', 'price', 100000);
  bind('setCalories', 'calories', 10000);
  bind('setGrams', 'servingGrams', 100000);
  bind('setServings', 'servingsPerContainer', 9999);
  bind('setNetWeight', 'netWeight', 1000000);

  // Changing a unit re-reads the number beside it, so switching g to oz
  // updates the answer without having to retype the weight.
  function bindUnit(id, key) {
    document.getElementById(id).addEventListener('change', function (e) {
      settings[key] = e.target.value;
      save();
      render(0);
    });
  }
  bindUnit('setGramsUnit', 'servingUnit');
  bindUnit('setNetWeightUnit', 'netWeightUnit');

  document.getElementById('btnClearOverrides').addEventListener('click', function () {
    settings.calories = null;
    settings.servingGrams = null;
    settings.servingsPerContainer = null;
    settings.netWeight = null;
    settings.servingUnit = DEFAULTS.servingUnit;
    settings.netWeightUnit = DEFAULTS.netWeightUnit;
    save();
    setValue('setCalories', null);
    setValue('setGrams', null);
    setValue('setServings', null);
    setValue('setNetWeight', null);
    document.getElementById('setGramsUnit').value = settings.servingUnit;
    document.getElementById('setNetWeightUnit').value = settings.netWeightUnit;
    render(0);
  });

  /* ---------- saving ---------- */

  // What is being saved is frozen at the moment Save is tapped. The camera is
  // still running while a name is typed, and the reading it drifts to two
  // seconds later is not the one that was on screen when the decision to keep
  // it was made.
  var pendingSave = null;

  el.btnSave.addEventListener('click', function () {
    var m = LabelParser.metrics(lastParsed, overrides());
    if (!m.ready) return;

    pendingSave = { metrics: m, parsed: lastParsed };
    frozen = true;
    document.body.classList.add('frozen');
    el.btnFreeze.textContent = '▶ Scan';

    el.saveSummary.textContent = summarise(m);
    el.setName.value = '';
    el.nameSheet.hidden = false;
    setTimeout(function () { el.setName.focus(); }, 50);
  });

  function summarise(m) {
    var bits = [round(m.caloriesPerGram, 2) + ' cal/' + m.perGramUnit];
    if (m.caloriesPerDollar !== null) bits.push(round(m.caloriesPerDollar, 0) + ' cal/$');
    if (m.price !== null) bits.push('$' + m.price.toFixed(2));
    return bits.join(' · ');
  }

  el.btnSaveConfirm.addEventListener('click', function () {
    if (!pendingSave) return;
    var name = el.setName.value.trim();
    el.nameSheet.hidden = true;
    el.btnSaveConfirm.disabled = true;

    Save.save(name, pendingSave.metrics, pendingSave.parsed, 'scan').then(function (r) {
      el.btnSaveConfirm.disabled = false;
      pendingSave = null;
      showSaved(name, r.queued);
    });
  });

  // Enter on the name field saves, because the keyboard is already up and
  // reaching past it for a button on a phone is a poor way to end the job.
  el.setName.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); el.btnSaveConfirm.click(); }
  });

  function showSaved(name, queued) {
    var label = name || 'Unnamed';
    el.saveNote.textContent = queued
      // Never "saved" when it is not on the server yet. The phone knowing about
      // an item is not the same as the record having it, and the difference
      // matters the moment the phone is wiped or replaced.
      ? 'Kept on this phone — ' + queued + ' waiting to reach the server.'
      : 'Saved “' + label + '”.';
    el.saveNote.hidden = false;
    buzz([12, 30, 12]);
    setTimeout(function () { el.saveNote.hidden = true; }, 4000);
  }

  /* ---------- boot ---------- */

  // Registering fails on an untrusted certificate and that is fine — it costs
  // the offline install, not the app. Nothing below depends on it.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  (async function () {
    el.reticle.classList.toggle('full', settings.fullFrame);
    render(0);
    // Anything saved while out of range goes now. This is the moment the phone
    // is most likely to be back on the tailnet — the page just loaded from it.
    if (Save.pending()) {
      Save.flush().then(function (r) {
        if (!r.queued) showSaved(null, 0);
      });
    }
    try {
      await startEngine();
    } catch (e) {
      status('reader failed to load: ' + e.message);
      return;
    }
    var blocked = cameraBlockedReason();
    if (blocked) {
      await explainNoCamera(blocked);
      return;
    }
    try {
      await startCamera();
      running = true;
      loop();
    } catch (e) {
      explainCameraError(e);
    }
  })();

  // Exposed so a test harness can drive the same pipeline headlessly.
  window.__scan = {
    readImage: async function (src) {
      var img = new Image();
      await new Promise(function (r, j) { img.onload = r; img.onerror = j; img.src = src; });
      var out = await readOnce(img, null);
      lastParsed = out.parsed;
      locked = out.parsed.complete;
      render(out.ms);
      return {
        parsed: out.parsed, ms: out.ms,
        metrics: LabelParser.metrics(out.parsed, overrides())
      };
    },
    ready: function () { return !!worker; }
  };
})();
