'use strict';

// generateSlope() unit tests. slopes.js is THREE-free DATA, so we load it via
// dynamic import() from this CommonJS test (same trick as engine.test.js) and
// assert the procedural slopes are deterministic AND "bounded & fair": a
// believable descent the renderer/engine can consume unchanged.

const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/shared/slopes.js');

// piece-end arclengths + total length for a generated def.
function measure(def) {
  let acc = 0;
  const ends = def.pieces.map((p) => (acc += p.len));
  return { length: acc, ends };
}
// kind of the piece containing arclength `s`.
function kindAt(def, ends, s) {
  for (let i = 0; i < ends.length; i++) if (s <= ends[i]) return def.pieces[i].kind;
  return def.pieces[def.pieces.length - 1].kind;
}

test('generateSlope is deterministic per seed and varies across seeds', async () => {
  const { generateSlope } = await load();
  assert.deepStrictEqual(generateSlope(42), generateSlope(42), 'same seed → identical def');
  assert.notDeepStrictEqual(generateSlope(1), generateSlope(2), 'different seeds → different defs');
});

test('every piece descends within a sane pitch band', async () => {
  const { generateSlope } = await load();
  for (let seed = 0; seed < 150; seed++) {
    const def = generateSlope(seed);
    assert.ok(def.pieces.length >= 4, `seed ${seed}: enough pieces`);
    for (const p of def.pieces) {
      assert.ok(p.kind === 'straight' || p.kind === 'carve', `seed ${seed}: valid kind`);
      assert.ok(p.len > 0, `seed ${seed}: positive length`);
      assert.ok(p.pitch >= 10 && p.pitch <= 26, `seed ${seed}: pitch ${p.pitch} in band (descends, no cliff)`);
      if (p.kind === 'carve') assert.ok(Number.isFinite(p.turn) && p.turn !== 0, `seed ${seed}: carve has a turn`);
    }
  }
});

test('total run length lands in the ~1-minute target window', async () => {
  const { generateSlope } = await load();
  for (let seed = 0; seed < 150; seed++) {
    const { length } = measure(generateSlope(seed));
    assert.ok(length >= 800 && length <= 1000, `seed ${seed}: length ${length} ~880u`);
  }
});

test('cumulative yaw stays bounded — the run never spirals back on itself', async () => {
  const { generateSlope } = await load();
  for (let seed = 0; seed < 150; seed++) {
    const def = generateSlope(seed);
    let psi = 0, maxAbs = 0;
    for (const p of def.pieces) if (p.kind === 'carve') { psi += p.turn; maxAbs = Math.max(maxAbs, Math.abs(psi)); }
    // YAW_CAP (75°) + one max turn (~58°) of overshoot before the turn-back kicks in.
    assert.ok(maxAbs <= 140, `seed ${seed}: yaw ${maxAbs.toFixed(0)}° bounded`);
  }
});

test('start + finish stay clear; obstacles are spaced and on/near the piste', async () => {
  const { generateSlope } = await load();
  for (let seed = 0; seed < 150; seed++) {
    const def = generateSlope(seed);
    const obs = def.obstacles;
    assert.ok(obs.length >= 6 && obs.length <= 10, `seed ${seed}: 6–10 obstacles`);
    for (const o of obs) {
      assert.ok(o.at >= 0.12 && o.at <= 0.92, `seed ${seed}: obstacle at ${o.at} clears launch/finish`);
      assert.ok(Math.abs(o.lat) <= 3.2, `seed ${seed}: obstacle lat ${o.lat} on piste/shoulder`);
      assert.ok(o.kind === 'tree' || o.kind === 'rock', `seed ${seed}: valid obstacle kind`);
    }
    for (let i = 1; i < obs.length; i++) {
      assert.ok(obs[i].at - obs[i - 1].at >= 0.03, `seed ${seed}: obstacles min-spaced`);
    }
  }
});

test('ramps sit on straights, spaced, clear of obstacles', async () => {
  const { generateSlope } = await load();
  for (let seed = 0; seed < 150; seed++) {
    const def = generateSlope(seed);
    const { length, ends } = measure(def);
    assert.ok(def.ramps.length >= 1 && def.ramps.length <= 3, `seed ${seed}: 1–3 ramps`);
    for (const r of def.ramps) {
      assert.ok(r.at > 0.12 && r.at < 0.9, `seed ${seed}: ramp at ${r.at} clears launch/finish`);
      assert.strictEqual(kindAt(def, ends, r.at * length), 'straight', `seed ${seed}: ramp on a straight`);
      for (const o of def.obstacles) {
        assert.ok(Math.abs(o.at - r.at) >= 0.05, `seed ${seed}: ramp clear of obstacles`);
      }
    }
    for (let i = 1; i < def.ramps.length; i++) {
      assert.ok(def.ramps[i].at - def.ramps[i - 1].at > 0.12, `seed ${seed}: ramps spaced apart`);
    }
  }
});
