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
  // seed 0 must not alias to seed 1 (compare layout, since `id` always differs).
  assert.notDeepStrictEqual(generateSlope(0).pieces, generateSlope(1).pieces, 'seed 0 ≠ seed 1');
});

test('obstacleRadius is the single source of truth for footprint radii', async () => {
  const { obstacleRadius, generateSlope } = await load();
  assert.strictEqual(obstacleRadius('rock'), 0.85, 'rock footprint radius');
  assert.strictEqual(obstacleRadius('tree'), 0.7, 'tree footprint radius');
  // Every NON-'post' obstacle on a freshly generated slope resolves to the
  // per-kind radius obstacleRadius() defines — generated defs carry no explicit
  // radius, so the builder default (`o.radius || obstacleRadius(o.kind)`) IS this.
  for (let seed = 0; seed < 50; seed++) {
    for (const o of generateSlope(seed).obstacles) {
      if (o.kind === 'post') continue;
      const radius = o.radius || obstacleRadius(o.kind);
      assert.strictEqual(radius, obstacleRadius(o.kind), `seed ${seed}: ${o.kind} radius`);
    }
  }
});

test('every piece descends within a sane pitch band', async () => {
  const { generateSlope } = await load();
  for (let seed = 0; seed < 150; seed++) {
    const def = generateSlope(seed);
    assert.ok(def.pieces.length >= 4, `seed ${seed}: enough pieces`);
    for (const p of def.pieces) {
      assert.ok(p.kind === 'straight' || p.kind === 'carve', `seed ${seed}: valid kind`);
      assert.ok(p.len > 0, `seed ${seed}: positive length`);
      assert.ok(p.pitch >= 10 && p.pitch <= 32, `seed ${seed}: pitch ${p.pitch} in band (descends, no cliff)`);
      if (p.kind === 'carve') assert.ok(Number.isFinite(p.turn) && p.turn !== 0, `seed ${seed}: carve has a turn`);
    }
  }
});

test('total run length lands in the ~1-minute target window', async () => {
  const { generateSlope } = await load();
  for (let seed = 0; seed < 150; seed++) {
    const { length } = measure(generateSlope(seed));
    assert.ok(length >= 900 && length <= 1000, `seed ${seed}: length ${length} ~940u`);
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
    // Pinned to `red` (the original mountain) — these count/lat bounds are red's
    // envelope; the per-tier test below covers blue/black. (The DEFAULT is blue.)
    const def = generateSlope(seed, { level: 'red' });
    const obs = def.obstacles;
    assert.ok(obs.length >= 6 && obs.length <= 10, `seed ${seed}: 6–10 obstacles`);
    for (const o of obs) {
      assert.ok(o.at >= 0.12 && o.at <= 0.92, `seed ${seed}: obstacle at ${o.at} clears launch/finish`);
      assert.ok(Math.abs(o.lat) <= 3.2, `seed ${seed}: obstacle lat ${o.lat} on piste/shoulder`);
      assert.ok(o.kind === 'tree' || o.kind === 'rock', `seed ${seed}: valid obstacle kind`);
    }
    for (let i = 1; i < obs.length; i++) {
      // Generator guarantees ≥ 0.035 spacing, but subtracting two r3-rounded `at`
      // values can land a hair under in float (e.g. 0.29 − 0.255 = 0.0349999…976),
      // so compare to 0.035 with a tiny epsilon — NOT a bare `>= 0.035` (flaky).
      assert.ok(obs[i].at - obs[i - 1].at >= 0.035 - 1e-9, `seed ${seed}: obstacles min-spaced`);
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

// ---- difficulty tiers (Blue / Red / Black) --------------------------------
// A tier tunes ONLY the procedural mountain (geometry + obstacle/jump density),
// never the physics or AI. `blue` is the DEFAULT (gentlest), so the no-level
// default must reproduce it; blue/red/black each stay "bounded & fair" within
// their own (wider/steeper) envelope; and the tiers must order monotonically
// easy→hard on the difficulty levers.

test('the no-level default IS the blue tier (gentlest); unknown falls back too', async () => {
  const { generateSlope, DEFAULT_LEVEL } = await load();
  assert.strictEqual(DEFAULT_LEVEL, 'blue', 'default tier is blue');
  for (let seed = 0; seed < 50; seed++) {
    assert.deepStrictEqual(generateSlope(seed), generateSlope(seed, { level: 'blue' }), `seed ${seed}: default = blue`);
    // an unknown level falls back to the default rather than throwing / drifting
    assert.deepStrictEqual(generateSlope(seed, { level: 'mauve' }), generateSlope(seed, { level: 'blue' }), `seed ${seed}: unknown level → blue`);
  }
});

// Per-tier envelope: loose count bounds (the ORDERING test below locks the
// difficulty deltas) + the universal fairness invariants in each tier's band.
const TIER_BOUNDS = {
  blue:  { pitchMax: 26, width: [12, 14],  obs: [1, 6],  ramps: [1, 3], obsLat: 2.6 },
  red:   { pitchMax: 32, width: [10, 12],  obs: [6, 10], ramps: [2, 3], obsLat: 3.2 },
  black: { pitchMax: 32, width: [8.5, 10], obs: [5, 14], ramps: [2, 5], obsLat: 3.7 },
};

test('every tier stays bounded & fair within its own envelope', async () => {
  const { generateSlope, LEVELS } = await load();
  assert.deepStrictEqual(LEVELS, ['blue', 'red', 'black'], 'tier ids in easy→hard order');
  for (const level of LEVELS) {
    const B = TIER_BOUNDS[level];
    for (let seed = 0; seed < 150; seed++) {
      const def = generateSlope(seed, { level });
      assert.strictEqual(def.level, level, `${level} ${seed}: def tags its level`);
      const { length, ends } = measure(def);
      assert.ok(length >= 900 && length <= 1000, `${level} ${seed}: length ${length} ~940u`);
      let psi = 0, yaw = 0;
      for (const p of def.pieces) {
        assert.ok(p.pitch >= 10 && p.pitch <= B.pitchMax, `${level} ${seed}: pitch ${p.pitch} in band`);
        if (p.kind === 'carve') { psi += p.turn; yaw = Math.max(yaw, Math.abs(psi)); }
      }
      assert.ok(yaw <= 140, `${level} ${seed}: yaw ${yaw.toFixed(0)}° bounded`);
      assert.ok(def.width >= B.width[0] && def.width <= B.width[1], `${level} ${seed}: width ${def.width}`);
      assert.ok(def.obstacles.length >= B.obs[0] && def.obstacles.length <= B.obs[1], `${level} ${seed}: ${def.obstacles.length} obstacles`);
      assert.ok(def.ramps.length >= B.ramps[0] && def.ramps.length <= B.ramps[1], `${level} ${seed}: ${def.ramps.length} ramps`);
      for (const o of def.obstacles) {
        assert.ok(o.at >= 0.12 && o.at <= 0.92, `${level} ${seed}: obstacle at ${o.at} clears launch/finish`);
        assert.ok(Math.abs(o.lat) <= B.obsLat + 1e-9, `${level} ${seed}: obstacle lat ${o.lat} on piste/shoulder`);
        assert.ok(o.kind === 'tree' || o.kind === 'rock', `${level} ${seed}: valid obstacle kind`);
      }
      for (let i = 1; i < def.obstacles.length; i++) {
        assert.ok(def.obstacles[i].at - def.obstacles[i - 1].at >= 0.035 - 1e-9, `${level} ${seed}: obstacles min-spaced`);
      }
      for (const r of def.ramps) {
        assert.ok(r.at > 0.12 && r.at < 0.9, `${level} ${seed}: ramp at ${r.at} clears launch/finish`);
        assert.strictEqual(kindAt(def, ends, r.at * length), 'straight', `${level} ${seed}: ramp on a straight`);
        for (const o of def.obstacles) assert.ok(Math.abs(o.at - r.at) >= 0.05, `${level} ${seed}: ramp clear of obstacles`);
      }
      for (let i = 1; i < def.ramps.length; i++) {
        assert.ok(def.ramps[i].at - def.ramps[i - 1].at > 0.12, `${level} ${seed}: ramps spaced apart`);
      }
    }
  }
});

test('tiers order easy→hard: blue is gentler / wider / sparser than black', async () => {
  const { generateSlope } = await load();
  const RUNS = 200;
  const mean = (level) => {
    let pitch = 0, pieces = 0, width = 0, obs = 0, ramps = 0;
    for (let seed = 0; seed < RUNS; seed++) {
      const d = generateSlope(seed, { level });
      for (const p of d.pieces) { pitch += p.pitch; pieces++; }
      width += d.width; obs += d.obstacles.length; ramps += d.ramps.length;
    }
    return { pitch: pitch / pieces, width: width / RUNS, obs: obs / RUNS, ramps: ramps / RUNS };
  };
  const blue = mean('blue'), red = mean('red'), black = mean('black');
  assert.ok(blue.pitch < red.pitch && red.pitch < black.pitch, `mean pitch ${blue.pitch.toFixed(1)} < ${red.pitch.toFixed(1)} < ${black.pitch.toFixed(1)}`);
  assert.ok(blue.width > red.width && red.width > black.width, `mean width ${blue.width.toFixed(1)} > ${red.width.toFixed(1)} > ${black.width.toFixed(1)}`);
  assert.ok(blue.obs < red.obs && red.obs < black.obs, `mean obstacles ${blue.obs.toFixed(1)} < ${red.obs.toFixed(1)} < ${black.obs.toFixed(1)}`);
  assert.ok(blue.ramps < red.ramps && red.ramps < black.ramps, `mean ramps ${blue.ramps.toFixed(2)} < ${red.ramps.toFixed(2)} < ${black.ramps.toFixed(2)}`);
});
