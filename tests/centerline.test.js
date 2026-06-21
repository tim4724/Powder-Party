'use strict';

// Centerline unit tests. Unlike engine.test.js (which feeds the engine a THREE-
// free stub centerline), these tests exercise the REAL Catmull-Rom spline math
// in public/display/Centerline.js — so they use the REAL THREE.Vector3 (the
// `three` devDep, which Centerline.js imports). The module is ES; we load it via
// dynamic import() from this CommonJS test (same trick as the sibling tests).

const test = require('node:test');
const assert = require('node:assert');

const loadCenterline = () => import('../public/display/Centerline.js');
const loadThree = () => import('three');

// Build a Centerline from an array of points. Each point may be a Vector3 or
// {x,y,z}; up defaults to +y. `s` is cumulative segment length (monotonic).
async function build(points, upDir) {
  const { Centerline } = await loadCenterline();
  const THREE = await loadThree();
  const up0 = upDir || new THREE.Vector3(0, 1, 0);
  let s = 0;
  const samples = [];
  points.forEach((p, i) => {
    const pos = p instanceof THREE.Vector3 ? p.clone() : new THREE.Vector3(p.x, p.y, p.z);
    if (i > 0) s += pos.distanceTo(samples[i - 1].pos);
    samples.push({ pos, up: up0.clone(), s });
  });
  return { cl: new Centerline(samples, s), THREE, samples };
}

// A descending polyline: advances in +x while dropping in -y, up roughly +y.
async function descending(n = 8, dx = 10, dy = -3) {
  const { Centerline } = await loadCenterline();
  const THREE = await loadThree();
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector3(i * dx, i * dy, 0));
  return build(pts);
}

const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

test('three resolves under Node with a real Vector3', async () => {
  const THREE = await loadThree();
  assert.strictEqual(typeof THREE.Vector3, 'function');
  const v = new THREE.Vector3(1, 2, 2);
  assert.ok(Math.abs(v.length() - 3) < 1e-9);
});

test('sampleAt(0) returns the first sample position', async () => {
  const { cl, samples } = await descending();
  const r = cl.sampleAt(0);
  assert.ok(r.pos.distanceTo(samples[0].pos) < 1e-6, 'pos == first sample');
});

test('sampleAt(length) returns the last sample position', async () => {
  const { cl, samples } = await descending();
  const r = cl.sampleAt(cl.length);
  assert.ok(r.pos.distanceTo(samples[samples.length - 1].pos) < 1e-6, 'pos == last sample');
});

test('s < 0 and s > length clamp (and stay finite)', async () => {
  const { cl } = await descending();
  const at0 = cl.sampleAt(0);
  const before = cl.sampleAt(-5);
  assert.ok(before.pos.distanceTo(at0.pos) < 1e-9, 'sampleAt(-5) == sampleAt(0)');

  const atEnd = cl.sampleAt(cl.length);
  const after = cl.sampleAt(cl.length + 5);
  assert.ok(after.pos.distanceTo(atEnd.pos) < 1e-9, 'sampleAt(length+5) == sampleAt(length)');

  for (const r of [before, after, at0, atEnd]) {
    assert.ok(finite(r.pos) && finite(r.tangent), 'all components finite (no NaN)');
  }
});

test('pos and tangent are finite and tangent is unit length across [0, length]', async () => {
  const { cl } = await descending();
  const N = 200;
  for (let k = 0; k <= N; k++) {
    const s = (cl.length * k) / N;
    const r = cl.sampleAt(s);
    assert.ok(finite(r.pos), `pos finite at s=${s}`);
    assert.ok(finite(r.tangent), `tangent finite at s=${s}`);
    assert.ok(finite(r.up) && finite(r.lateral), `up/lateral finite at s=${s}`);
    assert.ok(Math.abs(r.tangent.length() - 1) < 1e-6, `tangent unit at s=${s}`);
  }
});

test('arclength monotonicity: position advances along the dominant axis', async () => {
  // Dominant axis is +x (dx=10 >> |dy|=3).
  const { cl } = await descending();
  const N = 100;
  let prevX = -Infinity;
  let prevY = Infinity;
  for (let k = 0; k <= N; k++) {
    const s = (cl.length * k) / N;
    const r = cl.sampleAt(s);
    assert.ok(r.pos.x >= prevX - 1e-9, `x non-decreasing at s=${s} (${r.pos.x} >= ${prevX})`);
    assert.ok(r.pos.y <= prevY + 1e-9, `y non-increasing (descending) at s=${s}`);
    prevX = r.pos.x;
    prevY = r.pos.y;
  }
});

test('tangent points down the dominant axis of travel', async () => {
  const { cl } = await descending();
  for (const s of [0, cl.length * 0.25, cl.length * 0.5, cl.length * 0.75, cl.length]) {
    const r = cl.sampleAt(s);
    assert.ok(r.tangent.x > 0, `tangent advances +x at s=${s} (got ${r.tangent.x})`);
    assert.ok(r.tangent.y < 0, `tangent descends -y at s=${s} (got ${r.tangent.y})`);
  }
});

test('two-point centerline: finite pos/tangent at ends and interior', async () => {
  const { cl } = await build([
    { x: 0, y: 0, z: 0 },
    { x: 10, y: -4, z: 0 },
  ]);
  assert.ok(cl.length > 0, 'has positive length');
  for (const s of [0, cl.length * 0.5, cl.length]) {
    const r = cl.sampleAt(s);
    assert.ok(finite(r.pos), `pos finite at s=${s}`);
    assert.ok(finite(r.tangent), `tangent finite at s=${s}`);
    assert.ok(Math.abs(r.tangent.length() - 1) < 1e-6, `tangent unit at s=${s}`);
  }
  // Endpoints still pin to the actual sample positions.
  assert.ok(cl.sampleAt(0).pos.distanceTo(new (await loadThree()).Vector3(0, 0, 0)) < 1e-6);
});

test('duplicated point / zero-length span does not divide by zero', async () => {
  // Index 2 duplicates index 1 → a zero-length span (sB == sC). Exercises the
  // 1e-3 / 1e-6 nudges in sampleAt.
  const { cl } = await build([
    { x: 0, y: 0, z: 0 },
    { x: 10, y: -3, z: 0 },
    { x: 10, y: -3, z: 0 }, // duplicate
    { x: 20, y: -6, z: 0 },
    { x: 30, y: -9, z: 0 },
  ]);
  const N = 50;
  for (let k = 0; k <= N; k++) {
    const s = (cl.length * k) / N;
    const r = cl.sampleAt(s);
    assert.ok(finite(r.pos), `pos finite at s=${s} (no div-by-zero)`);
    assert.ok(finite(r.tangent), `tangent finite at s=${s}`);
    assert.ok(finite(r.up) && finite(r.lateral), `up/lateral finite at s=${s}`);
    assert.ok(Math.abs(r.tangent.length() - 1) < 1e-6, `tangent unit at s=${s}`);
  }
});

test('leading duplicated point (zero-length first span) stays finite', async () => {
  // First two points coincide → the stencil's first span is degenerate at s=0.
  const { cl } = await build([
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 }, // duplicate of the start
    { x: 10, y: -3, z: 0 },
    { x: 20, y: -6, z: 0 },
  ]);
  for (const s of [0, 1e-9, cl.length * 0.5, cl.length]) {
    const r = cl.sampleAt(s);
    assert.ok(finite(r.pos), `pos finite at s=${s}`);
    assert.ok(finite(r.tangent), `tangent finite at s=${s}`);
    assert.ok(Math.abs(r.tangent.length() - 1) < 1e-6, `tangent unit at s=${s}`);
  }
});
