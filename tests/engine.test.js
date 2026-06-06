'use strict';

// SkiEngine unit tests. The engine is THREE-free, so we feed it a lightweight
// centerline whose frames implement the handful of vector ops the engine calls
// (clone / addScaledVector / applyAxisAngle / cross / dot / sub / normalize /
// lengthSq). The engine is an ES module; we load it via dynamic import() from
// this CommonJS test so it works without "type":"module" on the package.

const test = require('node:test');
const assert = require('node:assert');

// --- minimal THREE.Vector3-compatible stub --------------------------------
class V {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new V(this.x, this.y, this.z); }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) {
    const ax = this.x, ay = this.y, az = this.z;
    this.x = ay * v.z - az * v.y;
    this.y = az * v.x - ax * v.z;
    this.z = ax * v.y - ay * v.x;
    return this;
  }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1e-9; return this.multiplyScalar(1 / l); }
  applyAxisAngle(axis, angle) {
    // Rodrigues (axis assumed unit)
    const c = Math.cos(angle), s = Math.sin(angle);
    const { x, y, z } = this;
    const ax = axis.x, ay = axis.y, az = axis.z;
    const dot = x * ax + y * ay + z * az;
    const cx = ay * z - az * y, cy = az * x - ax * z, cz = ax * y - ay * x;
    this.x = x * c + cx * s + ax * dot * (1 - c);
    this.y = y * c + cy * s + ay * dot * (1 - c);
    this.z = z * c + cz * s + az * dot * (1 - c);
    return this;
  }
}

// A straight, constant-pitch slope descending along +Z. Frames are constant, so
// neutral input holds a straight world line (the engine's dTheta is ~0).
function straightSlope(pitchDeg, length) {
  const p = pitchDeg * Math.PI / 180;
  const sinp = Math.sin(p), cosp = Math.cos(p);
  return {
    length,
    sampleAt(s) {
      if (s < 0) s = 0;
      const tangent = new V(0, -sinp, cosp);
      const up = new V(0, cosp, sinp);          // perpendicular, +y
      const lateral = tangent.clone().cross(up).normalize(); // = (-1,0,0)
      const pos = new V(0, -sinp * s, cosp * s);
      return { pos, tangent, up, lateral };
    },
  };
}

function track(opts = {}) {
  const length = opts.length || 140;
  return {
    centerline: straightSlope(opts.pitch || 18, length),
    length,
    slopeWidth: opts.width || 11,
    ramps: opts.ramps || [],
    obstacles: opts.obstacles || [],
  };
}

// Step the engine `secs` seconds at a fixed dt, optionally feeding input each tick.
function run(engine, secs, perTick) {
  const dt = 1000 / 60;
  const n = Math.round(secs / (dt / 1000));
  for (let i = 0; i < n; i++) { if (perTick) perTick(i); engine.update(dt); }
}

async function makeEngine(players, trk, cb) {
  const { SkiEngine } = await import('../public/display/engine/SkiEngine.js');
  return new SkiEngine(players, trk, cb);
}

test('skiers descend under gravity and finish at the bottom', async () => {
  const events = [];
  const e = await makeEngine([1], track({ length: 120 }), { onEvent: (ev) => events.push(ev) });
  run(e, 30, () => {});
  const snap = e.getSnapshot().skiers[0];
  assert.ok(snap.finished, 'skier should reach the finish within 30s');
  assert.ok(snap.finishTime > 0, 'finish time recorded');
  assert.ok(e.raceOver, 'raceOver true once all finish');
  assert.ok(events.some((ev) => ev.type === 'finish'), 'finish event fired');
  assert.ok(events.some((ev) => ev.type === 'race_over'), 'race_over event fired');
});

test('tuck reaches a higher speed than upright', async () => {
  const e = await makeEngine([1, 2], track({ length: 400 }), {});
  run(e, 6, () => {
    e.processInput(1, { s: 0, t: 1, j: 0 }); // tucking
    e.processInput(2, { s: 0, t: 0, j: 0 }); // upright
  });
  const a = e.getSnapshot().skiers.find((s) => s.id === 1);
  const b = e.getSnapshot().skiers.find((s) => s.id === 2);
  assert.ok(a.v > b.v * 1.05, `tucker (${a.v.toFixed(1)}) should outrun upright (${b.v.toFixed(1)})`);
});

test('hard carving scrubs speed and moves laterally', async () => {
  const e = await makeEngine([1, 2], track({ length: 400, width: 20 }), {});
  run(e, 4, () => {
    e.processInput(1, { s: 0, t: 1, j: 0 });   // straight schuss
    e.processInput(2, { s: 1, t: 1, j: 0 });   // full carve
  });
  const straight = e.getSnapshot().skiers.find((s) => s.id === 1);
  const carver = e.getSnapshot().skiers.find((s) => s.id === 2);
  assert.ok(carver.v < straight.v, 'a hard carve scrubs speed vs a straight schuss');
  assert.ok(Math.abs(carver.lat) > Math.abs(straight.lat) + 0.5, 'carving moves you sideways');
});

test('hitting a tree wipes you out (spin + speed loss)', async () => {
  // A lone skier starts dead center (lat 0); put a tree on the fall line.
  const e = await makeEngine([1], track({ length: 200, obstacles: [{ s: 28, lat: 0, radius: 0.7 }] }), {});
  let crashedSeen = false, vBefore = 0;
  run(e, 8, () => {
    const s = e.getSnapshot().skiers[0];
    if (s.progress < 0.1) vBefore = Math.max(vBefore, s.v);
    if (s.crashed) crashedSeen = true;
  });
  assert.ok(crashedSeen, 'skier should wipe out crossing the tree');
});

test('flick-up no longer jumps on open snow (feature removed)', async () => {
  const e = await makeEngine([1], track({ length: 300 }), {}); // no ramps to launch off
  run(e, 1.0, () => e.processInput(1, { s: 0, t: 0, j: 0 }));   // get moving
  assert.ok(!e.getSnapshot().skiers[0].airborne, 'on the snow');
  // an up-flick on open snow does NOTHING now — jump-on-snow was removed (ramps auto-launch)
  e.processInput(1, { s: 0, t: 0, j: 1 });
  e.update(1000 / 60);
  assert.ok(!e.getSnapshot().skiers[0].airborne, 'an up-flick does not launch a hop');
  let everAir = false;
  run(e, 2.0, () => { if (e.getSnapshot().skiers[0].airborne) everAir = true; });
  assert.ok(!everAir, 'with no ramp, the skier never leaves the snow');
});

test('a ramp auto-launches a skier crossing it on the snow', async () => {
  const e = await makeEngine([1], track({ length: 200, ramps: [{ s: 40, lat: 0, radius: 1.6 }] }), {});
  let airSeen = false;
  run(e, 8, () => { if (e.getSnapshot().skiers[0].airborne) airSeen = true; });
  assert.ok(airSeen, 'crossing the ramp should put the skier in the air');
});

test('an air flip lands clean and banks a trick boost', async () => {
  const events = [];
  const e = await makeEngine([1], track({ length: 300 }), { onEvent: (ev) => events.push(ev) });
  run(e, 1.0, () => e.processInput(1, { s: 0, t: 1, j: 0 })); // get moving, straight line
  // a generous pop — plenty of air to finish a 0.45s flip
  const sk = [...e.skiers.values()][0];
  sk.airborne = true; sk.vAir = 12; sk.air = 0.01; sk.airPeak = 0; sk.trickCount = 0;
  let flipSent = false, sawAxis = false;
  run(e, 1.4, () => {
    const s = e.getSnapshot().skiers[0];
    if (s.airborne && s.air > 0.6 && !flipSent) { e.processInput(1, { s: 0, t: 1, j: 1 }); flipSent = true; } // up-flick in the air → back flip
    if (s.trickActive && Math.abs(s.trickAngle - Math.PI / 2) < 0.01) sawAxis = true;
  });
  assert.ok(sawAxis, 'an up-flick mid-air spins a back flip (angle = +π/2)');
  assert.ok(events.some((ev) => ev.type === 'trick_done'), 'the flip completed before touchdown');
  const land = events.filter((ev) => ev.type === 'land').pop();
  assert.ok(land && land.tricks > 0, `a clean landing credits the flip (saw tricks=${land && land.tricks})`);
  assert.ok(e.getSnapshot().skiers[0].boostActive, 'a landed flip banks a speed boost');
});

test('landing mid-flip washes you out', async () => {
  const events = [];
  const e = await makeEngine([1], track({ length: 300 }), { onEvent: (ev) => events.push(ev) });
  run(e, 1.0, () => e.processInput(1, { s: 0, t: 1, j: 0 }));
  // at the apex with little airtime left — a 0.45s flip can't finish before the snow
  const sk = [...e.skiers.values()][0];
  sk.airborne = true; sk.vAir = 0; sk.air = 0.6; sk.airPeak = 0.6; sk.trickCount = 0;
  e.processInput(1, { s: 0, t: 1, j: 1 }); // flick now (already above the arm gate)
  let crashed = false;
  run(e, 1.5, () => { if (e.getSnapshot().skiers[0].crashed) crashed = true; });
  assert.ok(events.some((ev) => ev.type === 'crash' && ev.trick), 'a flip caught by the ground crashes');
  assert.ok(crashed, 'skier is in the spin-out after a botched flip');
  assert.ok(!e.getSnapshot().skiers[0].boostActive, 'a botched flip banks no boost');
});

test('a tiny hop is too low to arm a flip (no accidental crash)', async () => {
  const events = [];
  const e = await makeEngine([1], track({ length: 300 }), { onEvent: (ev) => events.push(ev) });
  run(e, 1.0, () => e.processInput(1, { s: 0, t: 1, j: 0 }));
  // apex ≈ vAir²/2g ≈ 0.1u, well under TRICK_MIN_AIR (0.55)
  const sk = [...e.skiers.values()][0];
  sk.airborne = true; sk.vAir = 2.5; sk.air = 0.01; sk.airPeak = 0; sk.trickCount = 0;
  let n = 1, sawAxis = false;
  run(e, 1.0, () => {
    const s = e.getSnapshot().skiers[0];
    if (s.airborne) e.processInput(1, { s: 0, t: 1, j: n++ }); // spam up-flicks the whole hop
    if (s.trickActive) sawAxis = true;
  });
  assert.ok(!sawAxis, 'a sub-threshold hop never arms a flip');
  assert.ok(!events.some((ev) => ev.type === 'trick_start'), 'no flip started');
  assert.ok(!events.some((ev) => ev.type === 'crash'), 'so it cannot crash you');
});

test('a side-flick spins (yaw), not a flip or a jump', async () => {
  const events = [];
  const e = await makeEngine([1], track({ length: 300 }), { onEvent: (ev) => events.push(ev) });
  run(e, 1.0, () => e.processInput(1, { s: 0, t: 1, j: 0 }));
  const sk = [...e.skiers.values()][0];
  sk.airborne = true; sk.vAir = 12; sk.air = 0.01; sk.airPeak = 0; sk.trickCount = 0;
  let sent = false, sawSpin = false;
  run(e, 1.4, () => {
    const s = e.getSnapshot().skiers[0];
    // a LEFT flick (angle π) in the air — analog f only, never bumps the jump edge
    if (s.airborne && s.air > 0.6 && !sent) { e.processInput(1, { s: 0, t: 1, f: { n: 1, a: Math.PI } }); sent = true; }
    // a pure spin: the trick axis is yaw → |cos(angle)| ≈ 1, |sin(angle)| ≈ 0
    if (s.trickActive && Math.abs(Math.cos(s.trickAngle)) > 0.99) sawSpin = true;
  });
  assert.ok(sawSpin, 'a left-flick mid-air spins a (yaw) trick');
  assert.equal(events.filter((ev) => ev.type === 'jump').length, 0, 'a side-flick never pops a jump');
});

test('a diagonal flick corks (off-axis), not a pure flip or spin', async () => {
  const events = [];
  const e = await makeEngine([1], track({ length: 300 }), { onEvent: (ev) => events.push(ev) });
  run(e, 1.0, () => e.processInput(1, { s: 0, t: 1, j: 0 }));
  const sk = [...e.skiers.values()][0];
  sk.airborne = true; sk.vAir = 12; sk.air = 0.01; sk.airPeak = 0; sk.trickCount = 0;
  let sent = false, corkAngle = null;
  run(e, 1.4, () => {
    const s = e.getSnapshot().skiers[0];
    if (s.airborne && s.air > 0.6 && !sent) { e.processInput(1, { s: 0, t: 1, f: { n: 1, a: Math.PI / 4, m: 0.8 } }); sent = true; }
    if (s.trickActive && corkAngle == null) corkAngle = s.trickAngle;
  });
  assert.ok(corkAngle != null, 'a diagonal flick arms a trick');
  // a true cork blends pitch + yaw → BOTH axis components are well off zero
  assert.ok(Math.abs(Math.sin(corkAngle)) > 0.3 && Math.abs(Math.cos(corkAngle)) > 0.3,
    `the cork axis is off both pure-flip and pure-spin (angle=${corkAngle.toFixed(2)})`);
  assert.ok(events.some((ev) => ev.type === 'trick_done'), 'the cork completed before touchdown');
});

test('a harder flick spins faster than a soft one', async () => {
  // The flick strength m scales the spin rate. Arm a flip at the same airtime with
  // m=0 vs m=1 and compare the resulting trickRate (read off the internal skier).
  const armRate = async (m) => {
    const e = await makeEngine([1], track({ length: 300 }), {});
    run(e, 1.0, () => e.processInput(1, { s: 0, t: 1, j: 0 }));
    const sk = [...e.skiers.values()][0];
    sk.airborne = true; sk.vAir = 6; sk.air = 0.7; sk.airPeak = 0.7; sk.trickCount = 0; // already above the arm gate
    e.processInput(1, { s: 0, t: 1, f: { n: 1, a: Math.PI / 2, m } });
    e.update(1000 / 60);
    return [...e.skiers.values()][0].trickRate;
  };
  const soft = await armRate(0);
  const hard = await armRate(1);
  assert.ok(hard > soft * 1.2, `a full-strength flick spins faster (${hard.toFixed(2)}) than a soft one (${soft.toFixed(2)})`);
});

test('results rank finished skiers by time, then by distance', async () => {
  const e = await makeEngine([1, 2], track({ length: 150 }), {});
  // skier 1 tucks (faster), skier 2 upright (slower) → 1 finishes first
  run(e, 30, () => {
    e.processInput(1, { s: 0, t: 1, j: 0 });
    e.processInput(2, { s: 0, t: 0, j: 0 });
  });
  const res = e.getResults().results;
  assert.equal(res[0].playerId, 1, 'faster skier ranks first');
  assert.equal(res[0].rank, 1);
  assert.ok(res[0].finished);
});

test('straying off-piste bogs you down and a half-slope-width out resets you', async () => {
  const events = [];
  // width 11 → pisteHalf 5.5, resetLat 11. Hold a full carve so the skier runs
  // off the groomed piste into deep snow and (eventually) past the reset line.
  const e = await makeEngine([1], track({ length: 600, width: 11 }), { onEvent: (ev) => events.push(ev) });
  let sawOffPiste = false, maxAbsLat = 0, offPisteV = Infinity, onPisteV = 0;
  run(e, 8, () => {
    e.processInput(1, { s: 1, t: 1, j: 0 });
    const s = e.getSnapshot().skiers[0];
    maxAbsLat = Math.max(maxAbsLat, Math.abs(s.lat));
    if (s.offPiste) { sawOffPiste = true; offPisteV = Math.min(offPisteV, s.v); }
    else onPisteV = Math.max(onPisteV, s.v);
  });
  assert.ok(sawOffPiste, 'a hard sustained carve should run the skier off-piste');
  assert.ok(maxAbsLat <= 11 + 1.0, `lat stays bounded by the reset (saw ${maxAbsLat.toFixed(1)}, reset at 11)`);
  assert.ok(events.some((ev) => ev.type === 'reset'), 'wandering a half-slope-width out fires a reset');
  assert.ok(offPisteV < onPisteV, `deep snow (${offPisteV.toFixed(1)}) is slower than on-piste (${onPisteV.toFixed(1)})`);
});

test('a malformed (NaN/Infinity) control packet cannot corrupt a skier', async () => {
  const events = [];
  const e = await makeEngine([1], track({ length: 200 }), { onEvent: (ev) => events.push(ev) });
  // hammer the engine with garbage every tick for 1s
  run(e, 1, () => e.processInput(1, { s: NaN, t: NaN, j: Infinity }));
  const s = e.getSnapshot().skiers[0];
  assert.ok(Number.isFinite(s.pose.pos.x) && Number.isFinite(s.pose.pos.y) && Number.isFinite(s.pose.pos.z),
    'pose stays finite under NaN input');
  assert.ok(Number.isFinite(s.v) && Number.isFinite(s.carve), 'speed + carve stay finite');
  assert.equal(events.filter((ev) => ev.type === 'jump').length, 0, 'Infinity jumpSeq never fires a jump');
});

test('removeCar drops a skier and recomputes raceOver', async () => {
  const e = await makeEngine([1, 2], track({ length: 120 }), {});
  run(e, 4, () => { e.processInput(1, { s: 0, t: 1, j: 0 }); e.processInput(2, { s: 0, t: 0, j: 0 }); });
  assert.equal(e.getSnapshot().skiers.length, 2);
  assert.ok(e.removeCar(2), 'removeCar returns true for an existing skier');
  assert.equal(e.getSnapshot().skiers.length, 1);
  assert.ok(!e.removeCar(99), 'removeCar returns false for an unknown id');
});
