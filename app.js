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

  /* One line under the pattern field for every state of the pattern itself.
     A pattern that never returns is such a state, exactly like a syntax error:
     the count line alone is a screen and a half below the field on a phone,
     so a message only there is a message the typist never sees. The slot keeps
     its height whether or not it holds anything — see .error-line in the CSS. */
  function setPatternMessage(kind, msg) {
    errorEl.className = 'error-line' + (kind ? ' is-' + kind : '');
    errorEl.textContent = '';
    /* aria-invalid says "this value is malformed", and the spec ties that to a
       SyntaxError at construction. A pattern that ran past 400 ms is perfectly
       well-formed — it is expensive, not wrong — so it gets its own class and
       its own border colour and leaves the attribute alone. */
    patternEl.setAttribute('aria-invalid', kind === 'error' ? 'true' : 'false');
    patternEl.classList.toggle('timed-out', kind === 'timeout');
    if (!kind) return;
    errorEl.appendChild(document.createTextNode(
      kind === 'timeout'
        ? 'That pattern took longer than 400 ms on this text and was stopped. '
        : 'That pattern is not valid JavaScript regex. '));
    if (msg) {
      // The engine's own words are quoted verbatim, so they get the mono face;
      // the timeout advice is ours, and stays prose. A clamped message comes back
      // in three parts so the marker between them can carry its own face.
      var parts = kind === 'error' ? engineParts(msg) : [msg];
      for (var i = 0; i < parts.length; i++) {
        var span = document.createElement('span');
        span.className = kind !== 'error' ? '' : (i === 1 ? 'elision' : 'engine');
        span.textContent = parts[i];
        errorEl.appendChild(span);
      }
    }
  }

  /* The engine puts the pattern's own source inside its message, so a 5,000-character
     invalid pattern is a 5,000-character message — and the slot below the field has no
     ceiling (deliberately; see .error-line), so that message was 3,177px of it at 320px
     and put the test-string box 3.7 screens down. The budget below bounds the echo.

     The cut is in the MIDDLE. V8 formats the message as
     "Invalid regular expression: /<source>/<flags>: <reason>", so cutting the tail —
     which is what the match list's 200-character rule does, and what it should do there,
     because a match is its own head — would throw away the reason, the only part of the
     message worth reading. Head + marker + tail keeps the engine's opening words and its
     closing reason and drops the run of source between them. Nothing is lost by it: the
     source is the pattern in the field directly above, unabridged and still editable. */
  var ENGINE_HEAD = 40;
  var ENGINE_TAIL = 56;
  var ENGINE_KEEP = ENGINE_HEAD + ENGINE_TAIL;   /* 96 characters of the message survive */
  /* Below this much overflow the marker would cost more than the cut saves, so a message
     is only ever shortened when there is something worth saying about it. It also puts a
     floor under the dropped count, which is why the marker never has to read "1
     characters". */
  var ELIDE_MIN = 40;

  /* The marker is not a bare ellipsis. A bare one lands mid-wall in the same red mono face
     as the parentheses around it and reads as "the message trailed off", which is the
     broken reading rather than the shortened one. This says what happened and how much of
     it happened, in the prose face, and is kept on one line so a wrap cannot split it. */
  function elisionMark(dropped) {
    /* Counted in code points, not code units. The mark says "characters", and on a
       pattern of emoji those differ by two — a critic measured the old count calling
       356 what a reader would count as 178. Array.from iterates code points, so the
       number in the mark is the number a person would arrive at. The locale tag is
       hardcoded so the grouping is the same everywhere and can never come back in
       another numbering system. */
    var n = Array.from(dropped).length;
    return '[\u2026 ' + n.toLocaleString('en-US') + ' characters cut \u2026]';
  }

  /* Returns the message as parts: [head, mark, tail], or [msg] when it fits. The head
     budget is small on purpose. Most of what a long message contains is the engine's echo
     of the source, and the source is in the field eight pixels above, unabridged — so the
     budget belongs to the reason, which is at the end and is the only part that tells the
     typist anything they do not already have. */
  function engineParts(msg) {
    if (msg.length <= ENGINE_KEEP + ELIDE_MIN) return [msg];
    var head = ENGINE_HEAD;
    var tail = msg.length - ENGINE_TAIL;
    /* Never cut a surrogate pair in half. String indices are UTF-16 code units, and a
       pattern of emoji is exactly the kind of input that lands a cut inside a pair: the
       half that survives renders as a replacement glyph, so the clamp would put a
       corruption mark in a message whose only job is to be read. Both edges move outward
       by one unit, which lengthens the dropped run by up to two and leaves as few as 94
       units surviving rather than 96. (An earlier draft of this comment had that
       backwards and said the elision could only shorten; it cannot.) */
    if (msg.charCodeAt(head - 1) >= 0xD800 && msg.charCodeAt(head - 1) <= 0xDBFF) head -= 1;
    if (msg.charCodeAt(tail) >= 0xDC00 && msg.charCodeAt(tail) <= 0xDFFF) tail += 1;
    return [msg.slice(0, head), elisionMark(msg.slice(head, tail)), msg.slice(tail)];
  }

  function showError(msg) {
    setPatternMessage(msg ? 'error' : null, msg);
  }

  /* One class carries the in-flight state; the CSS decides when it becomes
     visible, so a 5 ms run never flickers. */
  function setRunning(on) {
    document.body.classList.toggle('running', !!on);
    countEl.setAttribute('aria-busy', on ? 'true' : 'false');
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

  /* An exec that has entered `(a+)+$` cannot be interrupted from inside, so
     terminate() is the only way to stop it. That makes "stop caring about the
     request in flight" and "kill the worker" the same act: an abandoned
     runaway keeps burning a core, and — worse — it is still the worker the
     next keystroke posts to, so the next pattern inherits the dead one's
     400 ms and a valid sub-millisecond regex is reported as a timeout. Every
     path that drops a pending request calls this, not just onTimeout(). */
  function abandonInFlight() {
    clearTimeout(timer);
    timer = null;
    var inFlight = pendingSeq !== -1 || unanswered.length > 0;
    pendingSeq = -1;
    unanswered.length = 0;
    if (!inFlight || !worker) return;   // idle worker, or the fallback: nothing to kill
    worker.terminate();
    worker = null;
    if (!spawnWorker()) showNotice(FALLBACK_NOTICE);
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
    abandonInFlight();     // terminates the wedged worker and spawns a fresh one
    lastApplied = forSeq;
    setRunning(false);
    setPatternMessage('timeout', 'Simplify it, or shorten the test string.');
    paint({ ranges: [], groups: [] });
    countEl.className = 'count-line capped';
    setText(countEl, 'Pattern took longer than 400 ms and was stopped.');

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

    /* An empty pattern matches at every position: technically 276 zero-length
       matches on the default text, and as a reset gesture that is hostile.
       Clearing the field is an idle state, not a question. */
    if (source === '') {
      abandonInFlight();   // an idle UI must not sit on top of a live exec
      lastApplied = s;
      setRunning(false);
      showError(null);
      paint({ ranges: [], groups: [] });
      countEl.className = 'count-line';
      setText(countEl, 'No pattern yet. Type one, or click a cheat-sheet entry.');
      return;
    }

    if (text.length >= MAX_TEXT) {
      // Nothing is posted, so nothing may stay pending: disarm and kill.
      abandonInFlight();
      lastApplied = s;
      setRunning(false);
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
      setRunning(true);
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
    if (pendingSeq === -1) setRunning(false);

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

  /* Inserting must not move the page. focus({preventScroll}) covers the focus
     call; the caret-into-view scroll that the insertion itself performs is not
     preventable, so put the page back before the frame is drawn — the restore
     is in the same task as the insertion, so nothing is ever painted scrolled. */
  function keepingPagePut(fn) {
    var x = window.scrollX;
    var y = window.scrollY;
    fn();
    if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
  }

  /* preventScroll matters: the sheet sits at the bottom of the page on a phone
     and beside a scrolled page on a desktop, and a plain focus() scrolls the
     pattern field into view — which reads as the page jumping to the top. */
  function focusPatternOnly() {
    try {
      patternEl.focus({ preventScroll: true });
    } catch (err) {
      patternEl.focus();
    }
  }

  function focusPattern(pos) {
    focusPatternOnly();
    try { patternEl.setSelectionRange(pos, pos); } catch (e) { /* not selectable */ }
    caretStart = caretEnd = pos;
  }

  function insertToken(token) {
    var v = patternEl.value;
    var s = Math.min(caretStart, v.length);
    var e = Math.min(caretEnd, v.length);
    if (e < s) { var swap = s; s = e; e = swap; }

    focusPatternOnly();
    try { patternEl.setSelectionRange(s, e); } catch (err) { /* not selectable */ }

    /* execCommand is deprecated but it is the only insertion that joins the
       field's own undo stack: one Ctrl+Z then takes the token back out instead
       of stepping outside the history and replaying the default pattern.
       It returns false where it is unsupported, so the direct write stays. */
    var native = false;
    try {
      native = document.execCommand('insertText', false, token);
    } catch (err) {
      native = false;
    }
    if (native) {
      // The insertion fired `input`, which already re-ran the match and
      // remembered the caret it left behind.
      return;
    }

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

      /* A pointer click reports a non-zero detail; Enter and Space on a focused
         button report 0. A mouse user never gave the button focus — mousedown
         is prevented above — so leaving them in the pattern field is where they
         already were. A keyboard user is standing on the button, and sending
         them to the field means Tabbing back through the whole sheet to insert
         a second token, so they keep their place. The caret the next insertion
         uses is remembered from the field either way. */
      var byKeyboard = ev.detail === 0;
      keepingPagePut(function () {
        if (flag) toggleFlag(flag);
        else insertToken(btn.getAttribute('data-token'));
        if (byKeyboard) {
          try { btn.focus({ preventScroll: true }); } catch (err) { btn.focus(); }
        }
      });
    });
  }

  /* --- which arrangement, measured ---------------------------------------- */

  /* Two columns buy the tester a sidebar and cost it a column of width. The
     one thing that settles that trade is the width the test-string box would
     have *in two columns* — not the viewport, and not an area, which mixes
     width with height and so made the sidebar come and go with window height:
     1280x800 showed it, 1280x600 buried it. Measuring the candidate width live
     keeps the sidebar width, the gaps and the padding in the stylesheet where
     they belong, and makes the arrangement a function of width alone.

     The minimum is 620px of editor box. The textarea inside it spends 21px on
     its own border and padding, so what the reader actually gets is 598.8px of
     text: 62 columns of the 16px monospace at the switch, 64 at a 971px
     window, 69 at 1024. 62 is the floor — wide enough that a line of test
     string still reads as a line rather than as wrapping.

     And it has a cliff, which the comment this replaces wrongly claimed to
     avoid: between a 954px and a 955px window the editor steps 899px -> 620px,
     -31.0% of width and -17.1% of area, because that is what giving up a
     column to a 260px sidebar costs. The area rule it replaces never stepped
     more than 5% anywhere in 320-1400, and paid for that with a sidebar that
     did not exist below 1232px and moved with window height. One step at one
     width is the price of the sheet being there on every common laptop. A
     viewport media query would put the same step at a number that stops
     agreeing with the stylesheet the first time the sidebar is resized. */
  var MIN_TWO_COL_EDITOR = 620;

  var editorEl = document.getElementById('editor');
  var widthKey = -1;

  function chooseArrangement(force) {
    if (!force && window.innerWidth === widthKey) return false;
    widthKey = window.innerWidth;

    var was = document.body.classList.contains('two-col');
    document.body.classList.add('two-col');
    var twoColEditor = editorEl.clientWidth;
    var want = twoColEditor >= MIN_TWO_COL_EDITOR;
    document.body.classList.toggle('two-col', want);
    return want !== was;
  }

  /* The sheet opens with the sidebar and folds with the stack — until the
     reader says otherwise, after which their choice stands. */
  var cheatChosenByUser = false;

  function syncCheatOpen() {
    if (!cheatChosenByUser) cheatEl.open = document.body.classList.contains('two-col');
  }

  /* --- wiring ------------------------------------------------------------ */

  function init() {
    patternEl.value = DEFAULT_PATTERN;
    setFlags(DEFAULT_FLAGS);
    ta.value = DEFAULT_TEXT;

    caretStart = caretEnd = patternEl.value.length;

    buildCheatSheet();
    chooseArrangement(true);
    syncCheatOpen();
    cheatEl.querySelector('summary').addEventListener('click', function () {
      cheatChosenByUser = true;
    });

    patternEl.addEventListener('input', run);
    ta.addEventListener('input', run);
    ['keyup', 'click', 'select', 'focus', 'input'].forEach(function (name) {
      patternEl.addEventListener(name, rememberCaret);
    });
    ta.addEventListener('scroll', syncScroll);
    window.addEventListener('resize', function () {
      if (chooseArrangement(false)) syncCheatOpen();
      syncMetrics();
      syncScroll();
    });
    for (var i = 0; i < flagBoxes.length; i++) {
      flagBoxes[i].addEventListener('change', run);
    }

    if (!spawnWorker()) showNotice(FALLBACK_NOTICE);
    run();
  }

  init();
})();
