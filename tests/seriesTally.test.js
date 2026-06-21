// SeriesTally unit tests — the cumulative cross-run scoring lifted out of
// display/main.js. Previously this logic (points folding, row derivation, champion
// flagging, sorting) had NO direct unit coverage — only end-to-end in
// tests/e2e/series.spec.js. SeriesTally is dependency-injected with the pure
// seriesPoints rule, so it loads under Node with no DOM/net/THREE.
//
// SeriesTally.js is an ES module (`export class`); protocol.js is a classic browser
// script with a CommonJS export tail, so it's pulled in via a default import of its
// module.exports object.
import test from 'node:test';
import assert from 'node:assert';
import { SeriesTally } from '../public/display/SeriesTally.js';
import protocol from '../public/shared/protocol.js';
const { seriesPoints } = protocol;

// A field of 4 (the always-4 game field): names/colours for the rows.
const FIELD = [
  { peerIndex: 'a', name: 'Ann', colorIndex: 0, ai: false },
  { peerIndex: 'b', name: 'Bo', colorIndex: 1, ai: false },
  { peerIndex: 'c', name: 'Cy', colorIndex: 2, ai: true },
  { peerIndex: 'd', name: 'Di', colorIndex: 3, ai: true },
];

// Build an engine-style getResults() object from a [playerId, rank, finished, time]
// list (rank is 1-based finishing order; finishers first, then DNFs).
function results(rows) {
  return { results: rows.map(([playerId, rank, finished, time]) => ({ playerId, rank, finished, time })) };
}

test('a fresh tally starts in the lobby with no scores', () => {
  const t = new SeriesTally(seriesPoints, 5);
  assert.strictEqual(t.runIndex, 0);
  assert.strictEqual(t.runsTotal, 5);
  assert.strictEqual(t.seriesOver, false);
  assert.strictEqual(t.scores.size, 0);
});

test('startNextRun advances the index; endCurrentRun flips over only on the final run', () => {
  const t = new SeriesTally(seriesPoints, 3);
  t.startNextRun(); assert.strictEqual(t.runIndex, 1);
  assert.strictEqual(t.endCurrentRun(), false);
  t.startNextRun(); assert.strictEqual(t.runIndex, 2);
  assert.strictEqual(t.endCurrentRun(), false);
  t.startNextRun(); assert.strictEqual(t.runIndex, 3);
  assert.strictEqual(t.endCurrentRun(), true);
  assert.strictEqual(t.seriesOver, true);
});

test('buildRows carries this-run points + cumulative score, keeping finish order mid-series', () => {
  const t = new SeriesTally(seriesPoints, 3);
  t.startNextRun();
  // Run 1 finishing order: a, b, c, d → points 4/3/2/1.
  const rows = t.buildRows(results([['a', 1, true, 30.0], ['b', 2, true, 31.0], ['c', 3, true, 32.0], ['d', 4, true, 33.0]]), FIELD);
  assert.deepStrictEqual(rows.map((r) => r.playerId), ['a', 'b', 'c', 'd']); // finish order
  assert.deepStrictEqual(rows.map((r) => r.points), [4, 3, 2, 1]);
  assert.deepStrictEqual(rows.map((r) => r.score), [4, 3, 2, 1]); // nothing banked yet
  assert.deepStrictEqual(rows.map((r) => r.place), [1, 2, 3, 4]);
  assert.strictEqual(rows[0].name, 'Ann');
  assert.strictEqual(rows[2].ai, true);
});

test('fold banks a run; the next run layers on top without double-counting', () => {
  const t = new SeriesTally(seriesPoints, 3);
  t.startNextRun();
  const r1 = results([['a', 1, true, 30], ['b', 2, true, 31], ['c', 3, true, 32], ['d', 4, true, 33]]);
  t.fold(FIELD, r1);                       // bank 4/3/2/1
  assert.strictEqual(t.scores.get('a').points, 4);
  assert.strictEqual(t.scores.get('d').points, 1);
  t.startNextRun();
  // Run 2 order: d, c, b, a → +4/+3/+2/+1 on top of the banked 1/2/3/4.
  const rows = t.buildRows(results([['d', 1, true, 29], ['c', 2, true, 30], ['b', 3, true, 31], ['a', 4, true, 32]]), FIELD);
  const byId = new Map(rows.map((r) => [r.playerId, r]));
  assert.strictEqual(byId.get('d').score, 1 + 4); // banked 1 + this run 4
  assert.strictEqual(byId.get('a').score, 4 + 1); // banked 4 + this run 1
  assert.strictEqual(byId.get('b').score, 3 + 2);
  assert.strictEqual(byId.get('c').score, 2 + 3);
});

test('a DNF earns 0 points and reads as not-finished in the row', () => {
  const t = new SeriesTally(seriesPoints, 1);
  t.startNextRun();
  const rows = t.buildRows(results([['a', 1, true, 30], ['b', 2, true, 31], ['c', 3, false, null], ['d', 4, false, null]]), FIELD);
  const byId = new Map(rows.map((r) => [r.playerId, r]));
  assert.strictEqual(byId.get('c').points, 0);
  assert.strictEqual(byId.get('c').finished, false);
  assert.strictEqual(byId.get('a').points, 4);
});

test('when the series is over, rows sort by total score and the leader is champion', () => {
  const t = new SeriesTally(seriesPoints, 2);
  t.startNextRun();
  t.fold(FIELD, results([['a', 1, true, 30], ['b', 2, true, 31], ['c', 3, true, 32], ['d', 4, true, 33]])); // banked a4 b3 c2 d1
  t.startNextRun();
  t.endCurrentRun(); // 2 of 2 → seriesOver
  // Final run: b wins it. Totals: a 4+? ...
  // order b,a,c,d → +4/+3/+2/+1. Totals: a 4+3=7, b 3+4=7, c 2+2=4, d 1+1=2.
  const rows = t.buildRows(results([['b', 1, true, 29], ['a', 2, true, 30], ['c', 3, true, 31], ['d', 4, true, 32]]), FIELD);
  assert.strictEqual(t.seriesOver, true);
  assert.deepStrictEqual(rows.map((r) => r.score), [7, 7, 4, 2]); // sorted by score desc
  assert.deepStrictEqual(rows.map((r) => r.place), [1, 2, 3, 4]); // renumbered
  // a and b tie at the top → co-champions; c and d are not.
  assert.strictEqual(rows[0].champion, true);
  assert.strictEqual(rows[1].champion, true);
  assert.strictEqual(rows[2].champion, false);
  assert.strictEqual(rows[3].champion, false);
});

test('rekey carries a player\'s banked points onto a new slot (cross-device reconnect)', () => {
  const t = new SeriesTally(seriesPoints, 3);
  t.startNextRun();
  t.fold(FIELD, results([['a', 1, true, 30], ['b', 2, true, 31], ['c', 3, true, 32], ['d', 4, true, 33]]));
  assert.strictEqual(t.scores.get('a').points, 4);
  t.rekey('a', 'z');
  assert.strictEqual(t.scores.has('a'), false);
  assert.strictEqual(t.scores.get('z').points, 4);
  t.rekey('missing', 'q'); // no-op when the old id was never scored
  assert.strictEqual(t.scores.has('q'), false);
});

test('reset wipes scores/index/over but keeps the host runsTotal pick; setRunsTotal changes it', () => {
  const t = new SeriesTally(seriesPoints, 5);
  t.startNextRun();
  t.fold(FIELD, results([['a', 1, true, 30], ['b', 2, true, 31], ['c', 3, true, 32], ['d', 4, true, 33]]));
  t.endCurrentRun();
  t.reset();
  assert.strictEqual(t.runIndex, 0);
  assert.strictEqual(t.seriesOver, false);
  assert.strictEqual(t.scores.size, 0);
  assert.strictEqual(t.runsTotal, 5); // survives reset
  t.setRunsTotal(7);
  assert.strictEqual(t.runsTotal, 7);
});

test('stagePreview injects mid-series or final-board state for no-relay previews', () => {
  const t = new SeriesTally(seriesPoints, 5);
  t.stagePreview({ index: 2, total: 5, over: false, scores: { a: 7, b: 4 } });
  assert.strictEqual(t.runIndex, 2);
  assert.strictEqual(t.runsTotal, 5);
  assert.strictEqual(t.seriesOver, false);
  assert.strictEqual(t.scores.get('a').points, 7);
  assert.strictEqual(t.scores.get('b').points, 4);
});
