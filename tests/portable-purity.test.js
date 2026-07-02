'use strict';

// Portable-purity gate: the modules that must load OUTSIDE a browser — the
// engine + tally in Node tests, RoomFlow in the sibling kit's JSC/QuickJS
// native embedding — may not touch a clock, a timer, randomness, or the module
// system. All time is injected (dt / nowMs), all randomness is caller-supplied,
// so the same inputs replay identically everywhere. This is the gate the
// partyplug test suite's closing comment points at; without it a stray
// performance.now() inside RoomFlow only fails at native-embed time.
//
// The scan is textual, per line. Whole-line `//` and `*` comment lines are
// skipped (prose may name these APIs), but a TRAILING comment on a code line
// still trips it — keep such mentions on their own line. Commented-out code
// therefore passes; the gate is against live calls, and a cheap gate beats a
// clever one.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const PORTABLE_FILES = [
  'partyplug/RoomFlow.js',
  'public/display/SeriesTally.js',
  ...fs.readdirSync(path.join(ROOT, 'public/display/engine'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => 'public/display/engine/' + f),
];

const FORBIDDEN = [
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(/,
  /\bperformance\.now\s*\(/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bMath\.random\s*\(/,
  /\brequire\s*\(/,          // RoomFlow's own UMD wrapper tests typeof module, never calls require
  /^\s*import[\s{('"]/,      // static import statement (not the word in prose)
];

for (const rel of PORTABLE_FILES) {
  test(`${rel} stays clock-free / dependency-free (portable to Node + JSC/QuickJS)`, () => {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    const hits = [];
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return; // whole-line comments may name the APIs
      for (const re of FORBIDDEN) {
        if (re.test(line)) hits.push(`${rel}:${i + 1} ${line.trim()} (matched ${re})`);
      }
    });
    assert.deepEqual(hits, []);
  });
}
