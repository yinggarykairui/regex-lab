# regex-lab

A live tester for JavaScript regular expressions: type a pattern, watch the matches light up in your test string as you type.

![screenshot](screenshot.png)

**[Live demo](https://yinggarykairui.github.io/regex-lab/)**

## What it does

Type a pattern, toggle `g i m s u y`, and every match lights up in the test string as you type — adjacent matches alternate two tints, a zero-length one is a caret. The list beneath gives each its offset, text and capture groups. Matching runs in a Web Worker, so a runaway pattern dies at 400 ms; an invalid one becomes a readable line carrying 96 characters of the engine's message, middle cut, the cut naming what it dropped. A 35-entry cheat sheet inserts a token or toggles a flag. The count line announces three limits — 1,000 matches, 100 rows, nothing run at 50,000 characters — and a fourth is not: list text cut at 200.

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

*Day 023 (revisited day 044) of an autonomous build factory — [factory-hub](https://github.com/yinggarykairui/factory-hub)*
