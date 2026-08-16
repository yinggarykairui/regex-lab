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
    renderList(res);
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

  /* --- the highlight overlay --------------------------------------------- */

  /* The <pre> sits behind the textarea and paints backgrounds only; the
     textarea paints the text. They wrap identically because style.css gives
     them the same font, padding, border and wrapping rules — plus this, which
     no stylesheet can do: the textarea's content width shrinks when its
     scrollbar appears, so copy the measured width across. */
  function syncMetrics() {
    var border = pre.offsetWidth - pre.clientWidth;  // 2 * border-width
    pre.style.width = (ta.clientWidth + border) + 'px';
    pre.style.height = (ta.clientHeight + (pre.offsetHeight - pre.clientHeight)) + 'px';
  }

  function syncScroll() {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  }

  function paint(res) {
    var text = ta.value;
    var ranges = res.ranges || [];
    listEl.textContent = '';
    var frag = document.createDocumentFragment();
    var at = 0;

    for (var i = 0; i < ranges.length; i++) {
      var start = ranges[i][0];
      var end = ranges[i][1];
      if (start < at) continue;                    // never overlap a painted mark
      if (start > text.length) break;
      if (end > text.length) end = text.length;
      if (start > at) frag.appendChild(document.createTextNode(text.slice(at, start)));

      var mark = document.createElement('mark');
      mark.className = (i % 2 ? 'alt' : '') + (end === start ? ' zero' : '');
      // textContent, never innerHTML: the test string is user input. A
      // zero-length match holds no text at all — its caret rule is drawn by an
      // absolutely positioned ::after, so it adds no width and shifts nothing.
      mark.textContent = end === start ? '' : text.slice(start, end);
      frag.appendChild(mark);
      at = end;
    }
    if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));

    // A textarea's trailing newline has a line after it; a <pre>'s does not.
    // Without this the last line of a long string scrolls out of register.
    frag.appendChild(document.createTextNode('\n'));

    pre.textContent = '';
    pre.appendChild(frag);
    syncMetrics();
    syncScroll();
  }

  /* --- the match list ----------------------------------------------------- */

  var MAX_ROWS = 100;       // matches the worker's cap on returned capture groups
  var MAX_ROW_CHARS = 200;  // one match can be the whole test string

  function clip(s) {
    return s.length > MAX_ROW_CHARS ? s.slice(0, MAX_ROW_CHARS) + '…' : s;
  }

  function muted(word) {
    var span = document.createElement('span');
    span.className = 'undef';
    span.textContent = word;
    return span;
  }

  function addPair(dl, name, value) {
    var dt = document.createElement('dt');
    dt.textContent = name;
    var dd = document.createElement('dd');
    if (value === null) dd.appendChild(muted('undefined'));
    else if (value === '') dd.appendChild(muted('empty string'));
    else dd.textContent = clip(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function renderList(res) {
    var text = ta.value;
    var ranges = res.ranges || [];
    var groups = res.groups || [];
    var rows = Math.min(ranges.length, MAX_ROWS);
    var frag = document.createDocumentFragment();

    for (var i = 0; i < rows; i++) {
      var start = ranges[i][0];
      var end = ranges[i][1];

      var li = document.createElement('li');
      li.className = 'match-row';

      var at = document.createElement('span');
      at.className = 'at';
      at.textContent = '#' + i + ' at ' + start;
      li.appendChild(at);

      var txt = document.createElement('span');
      txt.className = 'text';
      if (end === start) {
        var em = document.createElement('span');
        em.className = 'empty';
        em.textContent = 'zero-length match';
        txt.appendChild(em);
      } else {
        txt.textContent = clip(text.slice(start, end));
      }
      li.appendChild(txt);

      var g = groups[i];
      var named = (g && g.named) || [];
      if (g && (g.numbered.length || named.length)) {
        var dl = document.createElement('dl');
        dl.className = 'groups';
        for (var k = 0; k < g.numbered.length; k++) addPair(dl, '$' + (k + 1), g.numbered[k]);
        for (var j = 0; j < named.length; j++) addPair(dl, '?<' + named[j][0] + '>', named[j][1]);
        li.appendChild(dl);
      }

      frag.appendChild(li);
    }
    listEl.appendChild(frag);
  }

  /* --- wiring ------------------------------------------------------------ */

  function init() {
    patternEl.value = DEFAULT_PATTERN;
    setFlags(DEFAULT_FLAGS);
    ta.value = DEFAULT_TEXT;

    patternEl.addEventListener('input', run);
    ta.addEventListener('input', run);
    ta.addEventListener('scroll', syncScroll);
    window.addEventListener('resize', function () { syncMetrics(); syncScroll(); });
    for (var i = 0; i < flagBoxes.length; i++) {
      flagBoxes[i].addEventListener('change', run);
    }

    if (!spawnWorker()) showNotice(FALLBACK_NOTICE);
    run();
  }

  init();
})();
