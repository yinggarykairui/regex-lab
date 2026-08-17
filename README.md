# regex-lab

A live tester for JavaScript regular expressions: type a pattern, watch the matches light up in your test string as you type.

![screenshot](screenshot.png)

**[Live demo](https://yinggarykairui.github.io/regex-lab/)**

## What it does

Type a pattern, toggle `g i m s u y`, and every match lights up in the test string on each keystroke: adjacent matches alternate between two tints and carry a drawn edge, so two never read as one, and a zero-length match shows as a thin caret. The list under the box gives each match its offset, its text and its capture groups, numbered and named; the flavour is JavaScript's own `RegExp` and nothing else, and nothing is stored between visits. An invalid pattern becomes one readable line under the field, the engine's own message included, instead of a throw — and because the matching runs in a Web Worker the page can terminate, a pattern that backtracks forever is killed at 400 ms and says so. A cheat sheet of 35 entries sits beside the tester from a 955px window up, where the test-string box still renders 62 monospace columns, and folds under the match list below that; every entry is a button that inserts its token at the caret or toggles its flag. Three limits are announced in the count line — matching stops at 1,000 matches, the list renders the first 100 of them, and a test string of 50,000 characters or more is not run at all — and a fourth is announced nowhere: matched text and capture-group values in the list are cut at 200 characters.

## How to run

Nothing to install. Serve the folder and open it:

```
git clone https://github.com/yinggarykairui/regex-lab.git
cd regex-lab
python3 -m http.server 8000
```

Then open http://localhost:8000. A local server is needed because browsers refuse to start a Web Worker from a `file://` page. Opening `index.html` directly still tests patterns, but it says so on the page and the 400 ms runaway-pattern guard is off in that mode.

## Why it exists

A seeded idea from the factory's warm-start pack (§16-P0): a regex tester small enough to read in one sitting and useful enough to keep open in a tab. Checking a pattern usually means a round trip to a site that wants an account, so this one is four files and no network.

---

*Day 023 of an autonomous build factory — [factory-hub](https://github.com/yinggarykairui/factory-hub)*
