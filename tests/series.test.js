'use strict';

// Series scoring unit tests. The points rule is the one knob the player tunes
// (linear N..1, DNF 0), so it lives as a pure helper in shared/protocol.js — both
// the display tally and these tests share the single definition. protocol.js is a
// classic browser script with a CommonJS export tail, so a plain require() pulls
// it in. The accumulation/champion BEHAVIOUR (auto-advance across runs) is covered
// end-to-end in tests/e2e/series.spec.js against the real pages.

const test = require('node:test');
const assert = require('node:assert');

const { seriesPoints, RUN_COUNTS, DEFAULT_RUNS } = require('../public/shared/protocol.js');

test('a finishing place earns points linearly: 1st = fieldSize, last = 1', () => {
  // The always-4 field → 4 / 3 / 2 / 1 for places 1..4 (the user-chosen scheme).
  assert.strictEqual(seriesPoints(1, 4, true), 4);
  assert.strictEqual(seriesPoints(2, 4, true), 3);
  assert.strictEqual(seriesPoints(3, 4, true), 2);
  assert.strictEqual(seriesPoints(4, 4, true), 1);
});

test('a DNF earns 0 regardless of rank', () => {
  assert.strictEqual(seriesPoints(1, 4, false), 0);
  assert.strictEqual(seriesPoints(3, 4, false), 0);
  assert.strictEqual(seriesPoints(4, 4, false), 0);
});

test('points scale with the field size (so a short-handed run still ranks fairly)', () => {
  // 3-skier field → 3 / 2 / 1.
  assert.strictEqual(seriesPoints(1, 3, true), 3);
  assert.strictEqual(seriesPoints(2, 3, true), 2);
  assert.strictEqual(seriesPoints(3, 3, true), 1);
  // Solo "field" → a single point for finishing.
  assert.strictEqual(seriesPoints(1, 1, true), 1);
});

test('points never go negative even on a malformed rank', () => {
  assert.strictEqual(seriesPoints(5, 4, true), 0); // a rank past the field clamps to 0, not -1
});

test('cumulative score sums each run; the champion is simply the most points', () => {
  // Three players over a 3-run series; rows are [rank, finished] per run.
  const runs = [
    { tim: [1, true], sam: [2, true], bo: [3, true] },   // run 1: 3 / 2 / 1
    { tim: [2, true], sam: [1, true], bo: [3, true] },   // run 2: 2 / 3 / 1
    { tim: [1, true], sam: [3, true], bo: [2, true] },   // run 3: 3 / 1 / 2
  ];
  const field = 3;
  const totals = {};
  for (const run of runs) {
    for (const [id, [rank, finished]] of Object.entries(run)) {
      totals[id] = (totals[id] || 0) + seriesPoints(rank, field, finished);
    }
  }
  assert.deepStrictEqual(totals, { tim: 8, sam: 6, bo: 4 });
  const champion = Object.keys(totals).reduce((a, b) => (totals[b] > totals[a] ? b : a));
  assert.strictEqual(champion, 'tim');
});

test('a points tie yields co-champions (every top-score id)', () => {
  const totals = { tim: 9, sam: 9, bo: 6 };
  const top = Math.max(...Object.values(totals));
  const champs = Object.keys(totals).filter((id) => totals[id] === top);
  assert.deepStrictEqual(champs.sort(), ['sam', 'tim']);
});

test('the run-count presets are sane and the default is one of them', () => {
  assert.ok(Array.isArray(RUN_COUNTS) && RUN_COUNTS.length > 0);
  assert.ok(RUN_COUNTS.every((n) => Number.isInteger(n) && n > 0));
  assert.ok(RUN_COUNTS.includes(DEFAULT_RUNS), 'DEFAULT_RUNS must be a selectable preset');
});
