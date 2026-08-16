/* match-worker.js — the only place a RegExp is built or run.
 *
 * Runs in two scopes. Inside a Worker it listens for {seq, source, flags, text}
 * and answers {seq, ranges, groups, error, truncated}. Loaded as a plain page
 * script (index.html) it just exposes regexLabMatch(), which app.js calls when
 * Worker construction is refused — on file://, for one. Same matcher either way.
 *
 * This file gets terminated mid-exec when a pattern runs long, so it holds no
 * state between messages.
 */
(function (scope) {
  'use strict';

  var MAX_MATCHES = 1000;   // hard cap on ranges
  var MAX_ROWS = 100;       // capture groups are only needed for rendered rows
  var MAX_TEXT = 50000;

  function message(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return String(err);
  }

  /* Step lastIndex past a zero-length match. One code point, not one UTF-16
     unit, when `u` is set — otherwise the next exec starts inside a surrogate
     pair and the loop can stall or match nonsense. */
  function advance(text, i, unicode) {
    if (i >= text.length) return i + 1;   // > length makes the next exec return null
    if (unicode) {
      var hi = text.charCodeAt(i);
      if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < text.length) {
        var lo = text.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) return i + 2;
      }
    }
    return i + 1;
  }

  function capturesOf(m) {
    var numbered = [];
    for (var i = 1; i < m.length; i++) {
      numbered.push(m[i] === undefined ? null : m[i]);
    }
    var named = null;
    if (m.groups) {
      named = [];
      for (var k in m.groups) {
        if (Object.prototype.hasOwnProperty.call(m.groups, k)) {
          named.push([k, m.groups[k] === undefined ? null : m.groups[k]]);
        }
      }
    }
    return { numbered: numbered, named: named };
  }

  function regexLabMatch(source, flags, text) {
    var out = { ranges: [], groups: [], error: null, truncated: false, total: 0, tooLong: false };
    text = typeof text === 'string' ? text : '';
    if (text.length >= MAX_TEXT) {
      out.tooLong = true;
      return out;
    }

    var re;
    try {
      re = new RegExp(String(source == null ? '' : source), String(flags == null ? '' : flags));
    } catch (err) {
      out.error = message(err);
      return out;
    }

    var repeats = re.global || re.sticky;
    var unicode = re.unicode;
    re.lastIndex = 0;

    while (true) {
      var m;
      try {
        m = re.exec(text);
      } catch (err) {
        // Some engines throw at exec time (stack overflow on a deep pattern).
        out.error = message(err);
        return out;
      }
      if (!m) break;

      var start = m.index;
      out.ranges.push([start, start + m[0].length]);
      if (out.groups.length < MAX_ROWS) out.groups.push(capturesOf(m));
      out.total++;

      if (!repeats) break;
      if (out.total >= MAX_MATCHES) { out.truncated = true; break; }

      // Zero-length match: lastIndex did not move, so move it by hand.
      if (re.lastIndex <= start) re.lastIndex = advance(text, start, unicode);
    }
    return out;
  }

  scope.regexLabMatch = regexLabMatch;

  var inWorker = typeof WorkerGlobalScope !== 'undefined' &&
                 typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

  if (inWorker) {
    scope.onmessage = function (ev) {
      var req = (ev && ev.data) || {};
      var res;
      try {
        res = regexLabMatch(req.source, req.flags, req.text);
      } catch (err) {
        res = { ranges: [], groups: [], error: message(err), truncated: false, total: 0, tooLong: false };
      }
      res.seq = req.seq;
      scope.postMessage(res);
    };
  }
})(typeof self !== 'undefined' ? self : this);
