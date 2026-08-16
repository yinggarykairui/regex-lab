/* app.js — the UI. Input handling, worker lifecycle, rendering.
 * No RegExp is constructed here; that lives in match-worker.js. */
(function () {
  'use strict';

  var MAX_TEXT = 50000;
  var TIMEOUT_MS = 400;
  var WORKER_URL = 'match-worker.js';
  var FALLBACK_NOTICE =
    'Web Workers are not available here, so matching runs on the page: ' +
    'the 400 ms runaway-pattern guard is off. Serve the folder over http:// to get it back.';

  var DEFAULT_PATTERN = '\\b(\\w+)@(\\w[\\w.-]*\\.\\w{2,})\\b';
  var DEFAULT_FLAGS = 'g';
  var DEFAULT_TEXT = [
    'Support: ada@example.com and grace@dev.example.org',
    'Bounce log: hopper@mail-2.example.net failed twice at 09:14.',
    'Copy to lovelace@example.co.uk before Friday.',
    'Not addresses: @example.com, user@, plain-text-here.',
    '',
    'Edit this box, or click a cheat-sheet entry to build a pattern.'
  ].join('\n');

  var patternEl = document.getElementById('pattern');
  var flagEcho = document.getElementById('flag-echo');
  var errorEl = document.getElementById('pattern-error');
  var noticeEl = document.getElementById('notice');
  var ta = document.getElementById('test-input');
  var pre = document.getElementById('highlight');
  var countEl = document.getElementById('count-line');
  var listEl = document.getElementById('match-list');
  var flagBoxes = [].slice.call(document.querySelectorAll('.flag input[type="checkbox"]'));

  var seq = 0;            // request counter
  var pendingSeq = -1;    // request the live worker is working on
  var lastApplied = -1;   // newest seq painted; an older reply never overwrites it
  var timer = null;
  var worker = null;
  var workerAvailable = true;

  /* --- small helpers ----------------------------------------------------- */

  function setText(el, s) {
    el.textContent = s;
  }

  function show(el, on) {
    el.hidden = !on;
  }

  function currentFlags() {
    var out = '';
    for (var i = 0; i < flagBoxes.length; i++) {
      if (flagBoxes[i].checked) out += flagBoxes[i].getAttribute('data-flag');
    }
    return out;
  }

  function setFlags(str) {
    for (var i = 0; i < flagBoxes.length; i++) {
      flagBoxes[i].checked = str.indexOf(flagBoxes[i].getAttribute('data-flag')) !== -1;
    }
  }

  function showError(msg) {
    if (msg) {
      errorEl.textContent = '';
      errorEl.appendChild(document.createTextNode('That pattern is not valid JavaScript regex. '));
      var span = document.createElement('span');
      span.className = 'engine';
      span.textContent = msg;
      errorEl.appendChild(span);
      show(errorEl, true);
      patternEl.setAttribute('aria-invalid', 'true');
    } else {
      errorEl.textContent = '';
      show(errorEl, false);
      patternEl.setAttribute('aria-invalid', 'false');
    }
  }

  function showNotice(msg) {
    if (msg) {
      setText(noticeEl, msg);
      show(noticeEl, true);
    } else {
      show(noticeEl, false);
    }
  }

  /* --- worker lifecycle -------------------------------------------------- */

  function spawnWorker() {
    try {
      worker = new Worker(WORKER_URL);
    } catch (err) {
      worker = null;
      workerAvailable = false;
      return false;
    }
    worker.onmessage = onWorkerMessage;
    worker.onerror = onWorkerError;
    return true;
  }

  function onWorkerError() {
    // The worker script failed to load or threw at the top level. Stop trusting
    // it and match on the page instead, rather than going silent.
    if (worker) { worker.terminate(); worker = null; }
    workerAvailable = false;
    clearTimeout(timer);
    pendingSeq = -1;
    showNotice(FALLBACK_NOTICE);
    run();
  }

  function onWorkerMessage(ev) {
    var res = ev && ev.data;
    if (!res || typeof res.seq !== 'number') return;
    if (res.seq < lastApplied) return;        // stale reply, newer paint already up
    if (res.seq === pendingSeq) {
      clearTimeout(timer);
      pendingSeq = -1;
    }
    apply(res);
  }

  function onTimeout(forSeq) {
    if (pendingSeq !== forSeq) return;
    if (worker) { worker.terminate(); worker = null; }
    pendingSeq = -1;
    lastApplied = forSeq;
    paint({ ranges: [], groups: [] });
    countEl.className = 'count-line capped';
    setText(countEl, 'Pattern took longer than 400 ms and was stopped.');
    spawnWorker();   // fresh worker, so the next keystroke works
  }

  /* --- running a match --------------------------------------------------- */

  function run() {
    var s = ++seq;
    var source = patternEl.value;
    var flags = currentFlags();
    var text = ta.value;

    setText(flagEcho, flags);

    if (text.length > MAX_TEXT) {
      lastApplied = s;
      showError(null);
      apply({ seq: s, ranges: [], groups: [], error: null, truncated: false,
              total: 0, tooLong: true });
      return;
    }

    if (worker) {
      pendingSeq = s;
      clearTimeout(timer);
      timer = setTimeout(function () { onTimeout(s); }, TIMEOUT_MS);
      worker.postMessage({ seq: s, source: source, flags: flags, text: text });
      return;
    }

    // Main-thread fallback. Same matcher, no timeout guard.
    var res;
    try {
      res = self.regexLabMatch(source, flags, text);
    } catch (err) {
      res = { ranges: [], groups: [], error: String(err && err.message || err),
              truncated: false, total: 0, tooLong: false };
    }
    res.seq = s;
    apply(res);
  }

  function apply(res) {
    if (typeof res.seq === 'number') {
      if (res.seq < lastApplied) return;
      lastApplied = res.seq;
    }

    if (res.tooLong) {
      showError(null);
      paint({ ranges: [], groups: [] });
      countEl.className = 'count-line capped';
      setText(countEl, 'Test string is ' + ta.value.length.toLocaleString() +
        ' characters — over the 50,000-character cap, so it was not matched.');
      return;
    }

    if (res.error) {
      showError(res.error);
      paint({ ranges: [], groups: [] });
      countEl.className = 'count-line';
      setText(countEl, 'No matches — the pattern has to be valid first.');
      return;
    }

    showError(null);
    paint(res);
    renderCount(res);
  }

  function renderCount(res) {
    var n = res.total;
    var line;
    countEl.className = 'count-line';
    if (res.truncated) {
      countEl.className = 'count-line capped';
      line = 'Stopped at the 1,000-match cap. First 100 listed below.';
    } else if (n === 0) {
      line = 'No matches.';
    } else if (n === 1) {
      line = '1 match.';
    } else if (n > 100) {
      line = n.toLocaleString() + ' matches. First 100 listed below.';
    } else {
      line = n + ' matches.';
    }
    setText(countEl, line);
  }

  /* --- rendering (filled in by the overlay and match-list passes) --------- */

  function paint(res) {
    pre.textContent = ta.value;
    listEl.textContent = '';
    void res;
  }

  /* --- wiring ------------------------------------------------------------ */

  function init() {
    patternEl.value = DEFAULT_PATTERN;
    setFlags(DEFAULT_FLAGS);
    ta.value = DEFAULT_TEXT;

    patternEl.addEventListener('input', run);
    ta.addEventListener('input', run);
    for (var i = 0; i < flagBoxes.length; i++) {
      flagBoxes[i].addEventListener('change', run);
    }

    if (!spawnWorker()) showNotice(FALLBACK_NOTICE);
    run();
  }

  init();
})();
