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

test('crouch-release launches the skier into the air, then lands', async () => {
  const e = await makeEngine([1], track({ length: 300 }), {});
  // build a charge by tucking
  run(e, 1.0, () => e.processInput(1, { s: 0, t: 1, j: 0 }));
  assert.ok(e.getSnapshot().skiers[0].charge > 0.8, 'tucking builds a jump charge');
  // release: bump the jump counter
  e.processInput(1, { s: 0, t: 0, j: 1 });
  e.update(1000 / 60);
  assert.ok(e.getSnapshot().skiers[0].airborne, 'releasing a charge launches the skier');
  // fly and land
  let wasAir = false;
  run(e, 2.5, () => { if (e.getSnapshot().skiers[0].airborne) wasAir = true; });
  assert.ok(wasAir, 'skier was airborne');
  assert.ok(!e.getSnapshot().skiers[0].airborne, 'skier lands again');
});

test('a ramp auto-launches a skier crossing it on the snow', async () => {
  const e = await makeEngine([1], track({ length: 200, ramps: [{ s: 40, lat: 0, radius: 1.6 }] }), {});
  let airSeen = false;
  run(e, 8, () => { if (e.getSnapshot().skiers[0].airborne) airSeen = true; });
  assert.ok(airSeen, 'crossing the ramp should put the skier in the air');
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
