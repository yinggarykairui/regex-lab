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
  var retried = false;    // one re-issue per timeout, never a loop
  var unanswered = [];    // states posted to the live worker and not yet answered

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
    clearTimeout(timer);
    pendingSeq = -1;
    unanswered.length = 0;
    showNotice(FALLBACK_NOTICE);
    run();
  }

  function onWorkerMessage(ev) {
    var res = ev && ev.data;
    if (!res || typeof res.seq !== 'number') return;
    if (res.seq < lastApplied) return;        // stale reply, newer paint already up
    // A reply for seq s means the worker is past everything up to s.
    while (unanswered.length && unanswered[0].seq <= res.seq) unanswered.shift();
    if (res.seq === pendingSeq) {
      clearTimeout(timer);
      pendingSeq = -1;
    }
    apply(res);
  }

  function onTimeout(forSeq) {
    if (pendingSeq !== forSeq) return;
    /* The worker hangs on the oldest message it has not answered, not on the
       newest one posted; everything after it is still queued. That oldest
       state is the one that was killed. */
    var killed = unanswered.length ? unanswered[0] : null;
    if (worker) { worker.terminate(); worker = null; }
    pendingSeq = -1;
    unanswered.length = 0;
    lastApplied = forSeq;
    showError(null);
    paint({ ranges: [], groups: [] });
    countEl.className = 'count-line capped';
    setText(countEl, 'Pattern took longer than 400 ms and was stopped.');
    spawnWorker();   // fresh worker, so the next keystroke works

    /* terminate() also threw away anything queued behind the run that hung, and
       the newest of those may be a perfectly fast pattern the user has already
       typed. Re-issue — but only if the state really moved on. Re-running the
       identical pattern, flags and text costs a second 400 ms kill and settles
       the page twice as late for no new information. */
    if (!retried && changedSince(killed)) {
      retried = true;
      run(true);
    }
  }

  function changedSince(state) {
    if (!state) return true;
    return state.source !== patternEl.value ||
           state.flags !== currentFlags() ||
           state.text !== ta.value;
  }

  /* --- running a match --------------------------------------------------- */

  /* isRetry is true only for the one re-issue after a timeout; anything the
     user does gets a fresh retry budget. */
  function run(isRetry) {
    if (isRetry !== true) retried = false;
    var s = ++seq;
    var source = patternEl.value;
    var flags = currentFlags();
    var text = ta.value;

    setText(flagEcho, flags);
    syncFlagButtons();

    if (text.length >= MAX_TEXT) {
      // Nothing is posted, so nothing is pending: disarm like every other path.
      clearTimeout(timer);
      pendingSeq = -1;
      unanswered.length = 0;
      lastApplied = s;
      showError(null);
      apply({ seq: s, ranges: [], groups: [], error: null, truncated: false,
              total: 0, tooLong: true });
      return;
    }

    if (worker) {
      pendingSeq = s;
      unanswered.push({ seq: s, source: source, flags: flags, text: text });
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
        ' characters. The 50,000-character cap means it was not matched.');
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

  /* --- cheat sheet -------------------------------------------------------- */

  /* Every entry does something: a token entry inserts itself at the caret, a
     flag entry toggles that flag. There are no display-only rows. */
  var CHEAT = [
    ['Characters', [
      ['.', 'any character except a line break'],
      ['\\d', 'a digit, 0 to 9'],
      ['\\w', 'a word character: letter, digit or _'],
      ['\\s', 'any whitespace'],
      ['\\.', 'a literal dot']
    ]],
    ['Quantifiers', [
      ['*', 'zero or more of what came before'],
      ['+', 'one or more'],
      ['?', 'zero or one — optional'],
      ['{2}', 'exactly two'],
      ['{2,4}', 'two to four'],
      ['*?', 'zero or more, lazy — stops as early as it can']
    ]],
    ['Groups and captures', [
      ['(a)', 'capture what is inside'],
      ['(?:a)', 'group without capturing'],
      ['(?<name>a)', 'capture under a name'],
      ['a|b', 'either side'],
      ['\\1', 'whatever group 1 captured']
    ]],
    ['Anchors and boundaries', [
      ['^', 'start of the string, or of a line with m'],
      ['$', 'end of the string, or of a line with m'],
      ['\\b', 'a word boundary — zero width'],
      ['\\B', 'not a word boundary'],
      ['(?=a)', 'lookahead: followed by this'],
      ['(?!a)', 'lookahead: not followed by this'],
      ['(?<=a)', 'lookbehind: preceded by this'],
      ['(?<!a)', 'lookbehind: not preceded by this']
    ]],
    ['Character classes', [
      ['[abc]', 'any one of these characters'],
      ['[^abc]', 'any character except these'],
      ['[a-z]', 'any character in the range'],
      ['\\D', 'anything that is not a digit'],
      ['[\\s\\S]', 'truly any character, line breaks included']
    ]],
    ['Flags', [
      ['g', 'find every match, not just the first', 'g'],
      ['i', 'ignore case', 'i'],
      ['m', 'make ^ and $ match at each line', 'm'],
      ['s', 'let . match a line break too', 's'],
      ['u', 'treat the pattern as unicode code points', 'u'],
      ['y', 'sticky: match only at lastIndex', 'y']
    ]]
  ];

  var cheatEl = document.getElementById('cheat');
  var cheatBody = document.getElementById('cheat-body');
  var flagButtons = [];
  var caretStart = 0;
  var caretEnd = 0;

  function rememberCaret() {
    if (patternEl.selectionStart !== null) {
      caretStart = patternEl.selectionStart;
      caretEnd = patternEl.selectionEnd;
    }
  }

  function focusPattern(pos) {
    patternEl.focus();
    try { patternEl.setSelectionRange(pos, pos); } catch (e) { /* not selectable */ }
    caretStart = caretEnd = pos;
  }

  function insertToken(token) {
    var v = patternEl.value;
    var s = Math.min(caretStart, v.length);
    var e = Math.min(caretEnd, v.length);
    if (e < s) { var swap = s; s = e; e = swap; }
    patternEl.value = v.slice(0, s) + token + v.slice(e);
    focusPattern(s + token.length);
    run();
  }

  function toggleFlag(flag) {
    for (var i = 0; i < flagBoxes.length; i++) {
      if (flagBoxes[i].getAttribute('data-flag') === flag) {
        flagBoxes[i].checked = !flagBoxes[i].checked;
      }
    }
    focusPattern(Math.min(caretStart, patternEl.value.length));
    run();
  }

  function syncFlagButtons() {
    var flags = currentFlags();
    for (var i = 0; i < flagButtons.length; i++) {
      var b = flagButtons[i];
      b.setAttribute('aria-pressed', flags.indexOf(b.getAttribute('data-flag')) !== -1 ? 'true' : 'false');
    }
  }

  function buildCheatSheet() {
    var frag = document.createDocumentFragment();

    for (var gi = 0; gi < CHEAT.length; gi++) {
      var section = document.createElement('section');
      section.className = 'cheat-group';

      var h = document.createElement('h3');
      h.textContent = CHEAT[gi][0];
      section.appendChild(h);

      var list = document.createElement('div');
      list.className = 'cheat-list';
      var entries = CHEAT[gi][1];

      for (var ei = 0; ei < entries.length; ei++) {
        var token = entries[ei][0];
        var gloss = entries[ei][1];
        var flag = entries[ei][2];

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cheat-entry';

        var tok = document.createElement('span');
        tok.className = 'token';
        tok.textContent = token;
        btn.appendChild(tok);

        var gl = document.createElement('span');
        gl.className = 'gloss';
        gl.textContent = gloss;
        btn.appendChild(gl);

        if (flag) {
          btn.setAttribute('data-flag', flag);
          btn.setAttribute('aria-pressed', 'false');
          btn.title = 'Toggle the ' + flag + ' flag';
          flagButtons.push(btn);
        } else {
          btn.setAttribute('data-token', token);
          btn.title = 'Insert ' + token + ' at the caret';
        }
        list.appendChild(btn);
      }
      section.appendChild(list);
      frag.appendChild(section);
    }

    cheatBody.appendChild(frag);

    // Keep the caret where the user left it: never let the button take focus.
    cheatBody.addEventListener('mousedown', function (ev) {
      if (ev.target.closest('.cheat-entry')) ev.preventDefault();
    });

    cheatBody.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.cheat-entry');
      if (!btn) return;
      var flag = btn.getAttribute('data-flag');
      if (flag) toggleFlag(flag);
      else insertToken(btn.getAttribute('data-token'));
    });
  }

  /* Above 720px the sheet is a sidebar, not something to open and close. */
  function syncCheatOpen() {
    cheatEl.open = wide.matches;
  }
  var wide = window.matchMedia('(min-width: 720px)');

  /* --- wiring ------------------------------------------------------------ */

  function init() {
    patternEl.value = DEFAULT_PATTERN;
    setFlags(DEFAULT_FLAGS);
    ta.value = DEFAULT_TEXT;

    caretStart = caretEnd = patternEl.value.length;

    buildCheatSheet();
    syncCheatOpen();
    if (wide.addEventListener) wide.addEventListener('change', syncCheatOpen);
    else wide.addListener(syncCheatOpen);

    patternEl.addEventListener('input', run);
    ta.addEventListener('input', run);
    ['keyup', 'click', 'select', 'focus', 'input'].forEach(function (name) {
      patternEl.addEventListener(name, rememberCaret);
    });
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
