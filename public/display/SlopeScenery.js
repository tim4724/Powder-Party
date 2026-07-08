// SlopeScenery — static world construction for SceneRenderer: the snow ribbon,
// mountainside walls/flanks, decorative forests, distant peaks, props (ramps,
// obstacles, banners) and the (s, lat) hitbox-debug outlines. Pure mesh
// builders: every function takes the group it populates plus explicit data —
// no renderer state. SceneRenderer owns cameras/lighting/skiers and calls these
// from setTrack.
import * as THREE from 'three';
import { mulberry32, obstacleRadius } from '../shared/slopes.js';
import { hitSL, SKI_HALF } from './engine/SkiEngine.js';

const _up = new THREE.Vector3(0, 1, 0);
const _basis = new THREE.Matrix4(); // scratch for prop orientation

// FNV-1a hash of a slope's `def.id` → a uint32 seed, so the decorative forest is
// deterministic per slope (same hill → same trees) instead of re-randomised on
// every setTrack. (Gameplay geometry is already seed-deterministic; this makes
// the cosmetic scatter match it.)
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// ---- hitbox debug (?hitbox=1) ------------------------------------------
// Wireframes of every collision footprint, drawn in the (s, lat) plane each
// test really runs in. ONE rule everywhere (the engine's hitSL): contact the
// moment two outlines touch. Purely diagnostic; nothing here is read back.
function debugLoop(pts, color) {
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color }));
}

// Circle on the slope surface around (frame.s, lat) — flat in the local frame,
// lifted a hair along the normal so it doesn't z-fight the snow.
export function debugCircle(f, lat, radius, color) {
  const pts = [];
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    pts.push(f.pos.clone()
      .addScaledVector(f.lateral, lat + Math.cos(a) * radius)
      .addScaledVector(f.tangent, Math.sin(a) * radius)
      .addScaledVector(f.up, 0.06));
  }
  return debugLoop(pts, color);
}

// Axis-aligned (s, lat) rectangle on the slope surface around (frame.s, lat).
export function debugRect(f, lat, halfS, halfLat, color) {
  const corner = (ds, dl) => f.pos.clone()
    .addScaledVector(f.tangent, ds * halfS)
    .addScaledVector(f.lateral, lat + dl * halfLat)
    .addScaledVector(f.up, 0.06);
  return debugLoop([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], color);
}

// Skier-local capsule outline (stadium along local +Z = the ski direction).
// Child of the skier group, whose basis already includes the carve heading —
// so the outline yaws with the skis for free.
export function debugSkierCapsule(radius, halfLen, color) {
  const pts = [];
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const z = Math.sin(a) * radius;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0.06, z + (z >= 0 ? halfLen : -halfLen)));
  }
  return debugLoop(pts, color);
}

// ---- terrain ------------------------------------------------------------
// Renderer-only extension of the physics samples: a stretch BEHIND the start
// gate (the chase cam parks up-slope of the grid and must not look into the
// void) and a little extra past the flat finish apron (so the ground never ends
// exactly where a skier can coast to). The physics centerline is unchanged.
export function extendMeshSamples(samples) {
  const meshSamples = samples.slice();
  {
    const f0 = samples[0], BACK = 16, STEPS = 7;
    for (let k = 1; k <= STEPS; k++) {
      const d = (BACK * k) / STEPS;
      meshSamples.unshift({
        pos: f0.pos.clone().addScaledVector(f0.tangent, -d),
        tangent: f0.tangent.clone(), up: f0.up.clone(), lateral: f0.lateral.clone(),
        s: f0.s - d,
      });
    }
  }
  {
    const fE = samples[samples.length - 1];
    const flatT = new THREE.Vector3(fE.tangent.x, 0, fE.tangent.z);
    if (flatT.lengthSq() < 1e-6) flatT.set(0, 0, 1);
    flatT.normalize();
    const lateral = flatT.clone().cross(_up).normalize();
    if (lateral.dot(fE.lateral) < 0) lateral.negate(); // align with the run's side → no twist at the join
    const OUT = 18, STEPS = 4;
    for (let k = 1; k <= STEPS; k++) {
      const d = (OUT * k) / STEPS;
      meshSamples.push({
        pos: new THREE.Vector3(fE.pos.x + flatT.x * d, fE.pos.y, fE.pos.z + flatT.z * d),
        tangent: flatT.clone(), up: _up.clone(), lateral: lateral.clone(),
        s: fE.s + d,
      });
    }
  }
  return meshSamples;
}

// Fine mesh rows resampled from the spline the ENGINE rides (Centerline.sampleAt),
// not the raw ~2u build samples. Skier poses are glued to the smooth Catmull-Rom
// surface; strips built straight from the coarse samples are chords of it, and the
// chord–curve gap grows with |lat| (turning frames swing offset points on wider
// arcs, and the wide off-piste quads crease when the frame twists) — past the
// piste edge it clears the few-cm epsilons the contact-shadow blobs and ski bases
// sit on, so the ground pokes through them. Rows every MESH_STEP hug the spline
// closely enough to stay under those epsilons everywhere a skier can be; ONE row
// list feeds every strip (piste, shoulders, walls, flanks) so there are no seams.
// 0.5 measured worst-case ~1.2cm mesh-above-surface across black-tier seeds (2.0
// was ~4.5cm — past the 4cm blob lift); halving again buys little (crease-local
// spline curvature dominates) and the strips are static, so this is the knee.
const MESH_STEP = 0.5;
export function resampleMeshRows(centerline) {
  const rows = [];
  const n = Math.max(2, Math.ceil(centerline.length / MESH_STEP));
  for (let i = 0; i <= n; i++) {
    const s = (centerline.length * i) / n;
    const f = centerline.sampleAt(s);
    rows.push({ pos: f.pos, tangent: f.tangent, up: f.up, lateral: f.lateral, s });
  }
  return rows;
}

// One snow strip from lateral offset offA→offB, optionally rising in world-Y
// (riseA→riseB) to form mountainside terrain. computeVertexNormals so the flat
// piste AND the tilted walls both light correctly.
function addSlopeStrip(group, samples, offA, offB, riseA, riseB, material) {
  const n = samples.length;
  const pos = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const s = samples[i], a = i * 6;
    pos[a] = s.pos.x + s.lateral.x * offA; pos[a + 1] = s.pos.y + s.lateral.y * offA + riseA; pos[a + 2] = s.pos.z + s.lateral.z * offA;
    pos[a + 3] = s.pos.x + s.lateral.x * offB; pos[a + 4] = s.pos.y + s.lateral.y * offB + riseB; pos[a + 5] = s.pos.z + s.lateral.z * offB;
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) { const p = i * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  group.add(m);
}

// The two-tone snow ribbon + valley cross-section: groomed piste (alternating
// corduroy passes), deep-snow shoulders, then snow rising into mountainside
// walls on each side — all built from the centerline so the whole valley
// descends with the run.
//
// CONTRAST FOR BAD-DYNAMIC-RANGE TVS: every surface used to sit in 237–255 luma,
// so on a panel that crushes highlights the whole slope collapsed to one flat
// white blob — no piste edge, no corduroy, no terrain depth. We keep the groomed
// piste bright white but step everything off-piste progressively DARKER and
// COOLER-BLUE. Hue (chroma) survives highlight-crush where near-white luma does
// not, and shadowed/ungroomed snow genuinely reads blue-grey — so the piste now
// stands out as a bright ribbon framed by visibly darker snow.
export function addTerrain(group, meshSamples, pisteHalf, edgeLat, groundY) {
  const NB = 6;                       // groomer passes across the piste
  const PASS = 0xffffff, GROOVE = 0xe2ecf6, DEEP = 0xbccadf, WALL = 0xa0b4d1;
  // Lambert, not Standard: matte snow has no specular lobe worth the per-fragment
  // GGX cost, and this is the largest screen-coverage surface ×N split-screen passes.
  const mat = (color) => new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  const passMat = mat(PASS), grooveMat = mat(GROOVE), deepMat = mat(DEEP), wallMat = mat(WALL);
  for (let p = 0; p < NB; p++) {      // groomed piste passes
    const a = -pisteHalf + (2 * pisteHalf) * (p / NB);
    const b = -pisteHalf + (2 * pisteHalf) * ((p + 1) / NB);
    addSlopeStrip(group, meshSamples, a, b, 0, 0, p % 2 === 0 ? passMat : grooveMat);
  }
  // Deep-snow shoulders, split into sub-strips: one edgeLat-wide quad per row
  // goes visibly non-planar where the frame twists (turn + pitch changing at
  // once) and its triangulation creases — bumps the flat analytic shoulder the
  // skier pose rides doesn't have. Narrower quads keep the crease sub-epsilon.
  const SHOULDER_SUBS = 3;
  for (let k = 0; k < SHOULDER_SUBS; k++) {
    const a = pisteHalf + (edgeLat - pisteHalf) * (k / SHOULDER_SUBS);
    const b = pisteHalf + (edgeLat - pisteHalf) * ((k + 1) / SHOULDER_SUBS);
    addSlopeStrip(group, meshSamples, -b, -a, 0, 0, deepMat);
    addSlopeStrip(group, meshSamples, a, b, 0, 0, deepMat);
  }
  addSlopeStrip(group, meshSamples, -(edgeLat + 26), -edgeLat, 14, 0, wallMat); // mountainside walls
  addSlopeStrip(group, meshSamples, -(edgeLat + 72), -(edgeLat + 26), 48, 14, wallMat);
  addSlopeStrip(group, meshSamples, edgeLat, edgeLat + 26, 0, 14, wallMat);
  addSlopeStrip(group, meshSamples, edgeLat + 26, edgeLat + 72, 14, 48, wallMat);
  addFlanks(group, meshSamples, edgeLat, groundY);
}

// Mountainside flanks: a strip per side from the outer wall ring (lateral
// ±(edgeLat+72), world-Y = sample + 48 — matching the top wall strip) sweeping
// out and DOWN to the valley floor (absolute groundY). Closes the sky-gap under
// the elevated run so it reads as a solid mountain from every orbit angle.
function addFlanks(group, samples, edgeLat, groundY) {
  const offInner = edgeLat + 72, riseInner = 48, offOuter = edgeLat + 240;
  // deepest, coolest snow — the valley walls fall away below the run (see DEEP/WALL).
  const mat = new THREE.MeshLambertMaterial({ color: 0x93a8c9, side: THREE.DoubleSide });
  const n = samples.length;
  for (const sign of [-1, 1]) {
    const oi = sign * offInner, oo = sign * offOuter;
    const pos = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      const s = samples[i], a = i * 6;
      pos[a] = s.pos.x + s.lateral.x * oi; pos[a + 1] = s.pos.y + s.lateral.y * oi + riseInner; pos[a + 2] = s.pos.z + s.lateral.z * oi;
      pos[a + 3] = s.pos.x + s.lateral.x * oo; pos[a + 4] = groundY; pos[a + 5] = s.pos.z + s.lateral.z * oo;
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const p = i * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    group.add(m);
  }
}

// ---- forests + peaks ------------------------------------------------------
// World-Y height of the mountainside at a lateral distance |off| from centre
// (matches the wall strips built in addTerrain), for sitting trees on the banks.
function riseAt(absO, edgeLat) {
  if (absO <= edgeLat) return 0;
  if (absO <= edgeLat + 26) return 14 * (absO - edgeLat) / 26;
  return 14 + 34 * Math.min(1, (absO - edgeLat - 26) / 46);
}

// Build a pine forest from { x, y, z, scl, rotY } placements as 4 InstancedMeshes
// (trunk + 3 foliage cones) — one draw call per part, regardless of tree count.
// Shared by both decorative forests. Each call makes its OWN geometry + material:
// the bank forest (slopeGroup) and outer forest (lobbyGroup) are disposed
// independently, so sharing would let one group's _disposeGroup free geometry still
// in use by the other. frustumCulled is off — a forest spans the whole run, so an
// origin-centred instance bound would wrongly cull it. Geometry is base-origin-
// translated so compose(pos, yaw, scale) reproduces a plain Group's transform exactly.
function addPineInstances(group, place) {
  const N = place.length;
  if (!N) return;
  const bark = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
  const foliage = new THREE.MeshLambertMaterial({ color: 0x2f7d52, flatShading: true });
  const parts = [new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.24, 1.2, 6).translate(0, 0.6, 0), bark, N)];
  for (let c = 0; c < 3; c++) {
    parts.push(new THREE.InstancedMesh(new THREE.ConeGeometry(1.3 - c * 0.32, 1.5, 7).translate(0, 1.4 + c * 0.85, 0), foliage, N));
  }
  const q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), m4 = new THREE.Matrix4();
  for (let k = 0; k < N; k++) {
    const t = place[k];
    q.setFromAxisAngle(_up, t.rotY); p.set(t.x, t.y, t.z); sc.setScalar(t.scl);
    m4.compose(p, q, sc);
    for (const im of parts) im.setMatrixAt(k, m4);
  }
  for (const im of parts) {
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    group.add(im);
  }
}

// Scatter an alpine pine forest over the mountainside banks (decorative, not
// collidable — the engine's obstacles are separate). Lives in the slope group, so
// unlike the lobby-only outer forest it renders DURING the race — which is exactly
// why the per-tree → 4-draw-call instancing matters most here.
function addBankForest(group, samples, edgeLat, rnd) {
  const n = samples.length;
  // Collect placements first, consuming rnd() in the SAME order as the old per-tree
  // build (skip → off → scale → rotation) so the scatter stays byte-for-byte the
  // same hill — just drawn instanced.
  const place = [];
  for (let i = 4; i < n - 4; i += 3) {
    const s = samples[i];
    for (const side of [-1, 1]) {
      if (rnd() < 0.5) continue;
      const off = side * (edgeLat + 3 + rnd() * 58);
      const scl = 0.8 + rnd() * 1.9;
      const rotY = rnd() * Math.PI * 2; // random yaw so the bank trees don't all face the same way
      place.push({
        x: s.pos.x + s.lateral.x * off,
        y: s.pos.y + s.lateral.y * off + riseAt(Math.abs(off), edgeLat),
        z: s.pos.z + s.lateral.z * off,
        scl, rotY,
      });
    }
  }
  addPineInstances(group, place);
}

// Lobby-only flank forest: trees on the OUTER mountainside (between the valley
// walls and the floor). INSTANCED — the whole forest is 4 draw calls no matter
// the count, lives in the lobby group (hidden during the race → zero cost in
// the split-screen passes), and casts no shadow. Density falls off where the
// flank is steep (bare cliffs near the top of the run, forest lower down) for a
// natural treeline.
function addOuterTrees(group, samples, edgeLat, groundY, rnd) {
  const offInner = edgeLat + 72, riseInner = 48, span = (edgeLat + 240) - offInner; // matches addFlanks
  const place = [];
  const n = samples.length;
  for (let i = 4; i < n - 4; i += 2) {
    const s = samples[i];
    const steep = ((s.pos.y + riseInner) - groundY) / span;   // flank height / width here
    const density = Math.max(0, 1 - steep / 2.1);             // sparse on steep upper flanks
    for (const sign of [-1, 1]) {
      if (rnd() > density * 0.8) continue;
      const t = 0.34 + 0.62 * rnd();                         // bias to the outer (gentler) flank, off the lip
      const off = sign * (offInner + t * span);
      place.push({
        x: s.pos.x + s.lateral.x * off,
        y: (s.pos.y + riseInner) + t * (groundY - (s.pos.y + riseInner)),
        z: s.pos.z + s.lateral.z * off,
        rotY: rnd() * Math.PI * 2,
        scl: 0.85 + rnd() * 1.7,
      });
    }
  }
  addPineInstances(group, place);
}

// Both decorative forests, seeded off the slope id (two independent streams so
// tweaking one doesn't shift the other). `bankGroup` renders always; the
// instanced outer forest goes in `lobbyGroup` (overview camera only).
export function addForests(bankGroup, lobbyGroup, samples, edgeLat, groundY, slopeId) {
  const seed = hashStr(slopeId || 'slope');
  addBankForest(bankGroup, samples, edgeLat, mulberry32(seed));
  addOuterTrees(lobbyGroup, samples, edgeLat, groundY, mulberry32(seed ^ 0x9e3779b9));
}

// A FULL ring of big low-poly snow peaks encircling the run — the distant range
// that frames the lobby orbit from every angle. Placed safely beyond the orbit
// radius and BASED ON THE VALLEY FLOOR so they tower like real mountains rather
// than float as chips.
export function addPeaks(group, center, orbitRadius, floorY) {
  const R = (orbitRadius || 200) * 1.45;        // ring radius — well outside the camera orbit
  // emissive lifts the shaded faces toward a cool snowy white (distant peaks are
  // hazy/bright), so they read as snow mountains rather than dark grey pyramids.
  const snow = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xc6d2e0, emissiveIntensity: 0.18, flatShading: true });
  const N = 16;
  // ONE instanced unit cone, scaled non-uniformly per peak (a cone is linear, so a
  // unit cone scaled (r,h,r) is identical to ConeGeometry(r,h,5,1)) → 1 draw call.
  const im = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 5, 1), snow, N);
  const q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), m4 = new THREE.Matrix4();
  for (let i = 0; i < N; i++) {
    // even spacing + alternating jitter → organic but never a gap.
    const ang = (i / N) * Math.PI * 2 + (i % 2 ? 0.17 : -0.13);
    const dist = R * (0.92 + (i % 3) * 0.16);
    const h = 210 + (i % 4) * 50 + (i % 2) * 44;  // ~210..390
    const r = h * 0.62;
    p.set(center.x + Math.cos(ang) * dist, floorY + h / 2, center.z + Math.sin(ang) * dist);
    q.setFromAxisAngle(_up, ang * 1.7);
    sc.set(r, h, r);
    m4.compose(p, q, sc);
    im.setMatrixAt(i, m4);
  }
  im.instanceMatrix.needsUpdate = true;
  im.frustumCulled = false; // the ring encircles the whole scene; an origin-centred bound would wrongly cull it
  group.add(im);
}

// ---- props ----------------------------------------------------------------
function makeSnowRampGeometry(w, h, len) {
  const x0 = -w / 2, x1 = w / 2, z0 = -len / 2, z1 = len / 2;
  const positions = [];
  const groups = [];

  const tri = (a, b, c) => positions.push(...a, ...b, ...c);
  const quad = (materialIndex, a, b, c, d) => {
    const start = positions.length / 3;
    tri(a, b, c); tri(a, c, d);
    groups.push({ start, count: 6, materialIndex });
  };

  // material 0: packed snow riding surface; material 1: compacted side walls;
  // material 2: compressed lip face.
  quad(0, [x0, 0, z0], [x0, h, z1], [x1, h, z1], [x1, 0, z0]);
  quad(2, [x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1]);
  {
    const start = positions.length / 3;
    tri([x0, 0, z0], [x0, 0, z1], [x0, h, z1]);
    groups.push({ start, count: 3, materialIndex: 1 });
  }
  {
    const start = positions.length / 3;
    tri([x1, 0, z0], [x1, h, z1], [x1, 0, z1]);
    groups.push({ start, count: 3, materialIndex: 1 });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  for (const group of groups) geo.addGroup(group.start, group.count, group.materialIndex);
  geo.computeVertexNormals();
  return geo;
}

let _snowRampChevronTexture = null;
function snowRampChevronTexture() {
  if (_snowRampChevronTexture) return _snowRampChevronTexture;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(72, 113, 145, 0.38)';
  ctx.lineWidth = 18;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const y of [125, 256, 387]) {
    ctx.beginPath();
    ctx.moveTo(66, y + 28);
    ctx.quadraticCurveTo(98, y + 8, 128, y - 25);
    ctx.quadraticCurveTo(158, y + 8, 190, y + 28);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  _snowRampChevronTexture = tex;
  return tex;
}

function addSnowRampChevrons(ramp, w, h, len) {
  const decalW = w * 0.82, decalLen = len * 0.78;
  const x0 = -decalW / 2, x1 = decalW / 2, z0 = -decalLen / 2, z1 = decalLen / 2;
  const yAt = (z) => ((z + len / 2) / len) * h + 0.024;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    x0, yAt(z0), z0,
    x1, yAt(z0), z0,
    x1, yAt(z1), z1,
    x0, yAt(z0), z0,
    x1, yAt(z1), z1,
    x0, yAt(z1), z1,
  ], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0,
    1, 0,
    1, 1,
    0, 0,
    1, 1,
    0, 1,
  ], 2));
  ramp.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: snowRampChevronTexture(),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })));
}

export function addRamp(group, cl, r, hitboxDebug) {
  const f = cl.sampleAt(r.s);
  // A LOW snow kicker, sized to the air scale (launch apex ~0.9u) so the skier
  // clears it instead of driving through a too-tall wedge. The footprint matches
  // the engine hitbox; only the visible body is packed snow now.
  const w = (r.width || 2.4), len = 3.0, h = 0.5;
  const geo = makeSnowRampGeometry(w, h, len);
  const ramp = new THREE.Mesh(geo, [
    new THREE.MeshLambertMaterial({ color: 0xb7e4ff }),
    new THREE.MeshLambertMaterial({ color: 0xb9cadf }),
    new THREE.MeshLambertMaterial({ color: 0x9fb4cd }),
  ]);
  addSnowRampChevrons(ramp, w, h, len);
  const lateral = f.lateral.clone().normalize();
  const tangent = f.tangent.clone().normalize();
  const up = f.up.clone().normalize();
  ramp.position.copy(f.pos).addScaledVector(lateral, r.lat).addScaledVector(up, 0.035);
  // Build a RIGHT-handed basis (x = up × tangent, NOT `lateral` = tangent × up,
  // which would be left-handed → setFromRotationMatrix mis-orients the wedge).
  const rx = new THREE.Vector3().crossVectors(up, tangent).normalize();
  ramp.quaternion.setFromRotationMatrix(_basis.makeBasis(rx, up, tangent));
  group.add(ramp);
  // Same footprint the engine collides with (SkiEngine track setup): the kicker
  // box, read with ONE rule — contact the moment the skier's ring touches it.
  if (hitboxDebug) group.add(debugRect(f, r.lat || 0, 1.5, (r.width || 2.4) / 2, 0x27c4f5));
}

export function addObstacle(group, cl, o, hitboxDebug) {
  const f = cl.sampleAt(o.s);
  const up = f.up.clone().normalize();
  const g = new THREE.Group();
  if (o.kind === 'rock') {
    const rock = new THREE.Mesh(
      new THREE.IcosahedronGeometry(o.radius || 0.7, 0), // same default the engine collides at
      new THREE.MeshLambertMaterial({ color: 0x8a93a1, flatShading: true })
    );
    rock.scale.set(1, 0.7, 1);
    g.add(rock);
  } else {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, 0.9, 6),
      new THREE.MeshLambertMaterial({ color: 0x7a5230 })
    );
    trunk.position.y = 0.45;
    g.add(trunk);
    const foliage = new THREE.MeshLambertMaterial({ color: 0x2f8f5b, flatShading: true });
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.95 - i * 0.22, 1.0, 7), foliage);
      cone.position.y = 1.0 + i * 0.55;
      g.add(cone);
    }
  }
  g.position.copy(f.pos).addScaledVector(f.lateral, o.lat);
  g.quaternion.setFromUnitVectors(_up, up);
  group.add(g);
  if (hitboxDebug) {
    group.add(debugCircle(f, o.lat || 0, o.radius || obstacleRadius(o.kind), 0xff2244));
  }
}

// A tinted band of snow ACROSS the piste — the start (grey) and finish (black)
// markers. An overhead gate was unreadable in split-screen — a flat surface
// marking is clear from the low chase cam without any 3D clutter. Built the SAME
// way as the snow ribbon: a strip stitched from centerline cross-sections (each
// edge placed off its own frame), so it hugs the slope exactly — following the
// pitch instead of floating as one rigid quad. computeVertexNormals makes it
// light identically to the piste, so it reads as tinted snow, not a panel.
// transparent + depthWrite:false makes it a decal the (opaque) skiers render on
// top of.
export function addSnowLine(group, cl, s, halfW, color, opacity) {
  const DEPTH = 0.7;   // down-slope width of the band
  const N = 4;         // cross-sections spanning the depth → conforms to the local pitch
  const LIFT = 0.02;   // along the local normal, to clear z-fighting with the piste
  const pos = new Float32Array((N + 1) * 2 * 3);
  for (let i = 0; i <= N; i++) {
    const si = Math.max(0, Math.min(cl.length, s - DEPTH / 2 + (DEPTH * i) / N));
    const f = cl.sampleAt(si);
    const lx = f.lateral.x, ly = f.lateral.y, lz = f.lateral.z;
    const ox = f.up.x * LIFT, oy = f.up.y * LIFT, oz = f.up.z * LIFT;
    const a = i * 6;
    pos[a]     = f.pos.x - lx * halfW + ox; pos[a + 1] = f.pos.y - ly * halfW + oy; pos[a + 2] = f.pos.z - lz * halfW + oz;
    pos[a + 3] = f.pos.x + lx * halfW + ox; pos[a + 4] = f.pos.y + ly * halfW + oy; pos[a + 5] = f.pos.z + lz * halfW + oz;
  }
  const idx = [];
  for (let i = 0; i < N; i++) { const p = i * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const line = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
    color, side: THREE.DoubleSide,
    transparent: true, opacity, depthWrite: false,
  }));
  group.add(line);
}

// A black/white checkerboard, baked square (`cols`×`rows` cells) so it stays
// crisp up close and mip-averages cleanly at distance. Cached per cols×rows and
// reused across every setTrack — _disposeGroup frees geometries/materials but
// not textures, so a fresh one each rebuild would leak; one shared tiny texture
// (like the blob sprite) is the intended pattern.
const _checkerCache = new Map();
function checkerTexture(cols, rows) {
  const key = cols + 'x' + rows;
  const cached = _checkerCache.get(key);
  if (cached) return cached;
  const cell = 8;
  const c = document.createElement('canvas');
  c.width = cols * cell; c.height = rows * cell;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f7fb'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#15181e';
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      if ((x + y) & 1) ctx.fillRect(x * cell, y * cell, cell, cell);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.magFilter = THREE.NearestFilter; // crisp cell edges up close (linear mag blurs the boundaries); minFilter keeps mipmaps for clean distance averaging
  _checkerCache.set(key, tex);
  return tex;
}

const GATE_H = 3.4;        // post height
const POST_R = 0.13;       // post footprint = cylinder radius
const GATE_BAR_H = 0.9;    // checkered banner height
const GATE_HIT_R = 0.25;   // post hit radius (matches the engine 'post' obstacle, so the bend tracks the crash)
const GATE_BEND = 0.24;    // rad (~14°) — how far a clipped post bends down-slope and stays
const GATE_BEND_RATE = 14; // 1/s ease of the bend onto its target (a quick give, then it holds)
const _xAxis = new THREE.Vector3(1, 0, 0);

// The finish gate: charcoal posts at the OUTER piste edge (±halfW, where the
// slalom poles stand) under a checkered-flag banner — the universal finish cue.
// The posts are also engine OBSTACLES (added in SlopeBuilder), so clipping one
// wipes the skier out exactly like a tree/rock. The gate's own reaction is purely
// cosmetic: the post that was hit BENDS down-slope and stays bent for the run
// (its 'metal' took a knock), and the banner corner it carries sags to follow —
// no orphaned band, no gravity-defying topple.
//
// Built in the slope-local frame (X cross-slope, Y up, Z down-slope): a post is a
// base-pinned cylinder rotated about local-X to bend down-slope; the banner is a
// plane whose two hit-side corners track that post's top. poke() reuses
// PoleField's swept hit-test to spot WHICH post (for the bend); the crash itself
// is the engine's job.
export class FinishGate {
  constructor(group, cl, s, halfW) {
    this._s = Math.max(0, Math.min(cl.length, s));
    this._halfW = halfW;
    this._easing = false;  // any post still easing toward its bend target?

    const f = cl.sampleAt(this._s);
    const up = f.up.clone().normalize();
    const tangent = f.tangent.clone().normalize();
    const bx = new THREE.Vector3().crossVectors(up, tangent).normalize(); // local X = cross-slope (right-handed with up, tangent)
    const g = new THREE.Group();
    g.position.copy(f.pos);
    g.quaternion.setFromRotationMatrix(_basis.makeBasis(bx, up, tangent));
    group.add(g);

    const frameMat = new THREE.MeshLambertMaterial({ color: 0x161922 });
    const poleGeo = new THREE.CylinderGeometry(POST_R, POST_R, GATE_H, 8);
    poleGeo.translate(0, GATE_H / 2, 0); // origin at the BASE so a bend pivots there (PoleField does the same)
    // posts[0] = left (lat -halfW), posts[1] = right (+halfW); bend rotates about local-X
    this._posts = [-1, 1].map((side) => {
      const mesh = new THREE.Mesh(poleGeo, frameMat);
      mesh.position.set(side * halfW, 0, 0);
      g.add(mesh);
      return { mesh, side, bend: 0, target: 0 };
    });

    const cols = Math.max(8, Math.round((halfW * 2) / (GATE_BAR_H / 2))); // ~square cells
    const bar = new THREE.Mesh(
      new THREE.PlaneGeometry(halfW * 2, GATE_BAR_H), // faces local +Z = down-slope; corners sit at the post tops
      new THREE.MeshLambertMaterial({ map: checkerTexture(cols, 2), side: THREE.DoubleSide }));
    bar.position.set(0, GATE_H - GATE_BAR_H / 2, 0);
    g.add(bar);
    this._bar = bar; // PlaneGeometry verts: 0=top-left 1=top-right 2=bottom-left 3=bottom-right
  }

  // Spot which post a grounded skier clipped, using PoleField's swept tail/centre/
  // nose capsule test, and bend it. The wipeout is the engine's (the posts are
  // 'post' obstacles); this is just the visual give. `holder` stashes the
  // previous-frame s so a fast schuss can't step over the post between frames.
  poke(s, holder) {
    if (s.totalS == null) return;
    const prev = holder._gatePokeS != null ? holder._gatePokeS : s.totalS;
    holder._gatePokeS = s.totalS;
    if (s.air > 0.9) return;                    // sailing over the line
    const reach = (s.radius || 0.3) + GATE_HIT_R;
    if (Math.abs(Math.abs(s.lat) - this._halfW) > reach + SKI_HALF) return; // not near either post
    let halfS = Math.abs(s.totalS - prev) / 2;
    if (halfS > 2) halfS = 0;                   // a big jump is a reset teleport, not travel
    const mid = halfS > 0 ? (s.totalS + prev) / 2 : s.totalS;
    const hs = Math.cos(s.heading || 0), hl = -Math.sin(s.heading || 0);
    for (const p of this._posts) {
      if (p.target !== 0) continue;             // already bent — leave it
      const postLat = p.side * this._halfW;
      for (const e of [-SKI_HALF, 0, SKI_HALF]) {
        if (hitSL(this._s - (mid + e * hs), postLat - (s.lat + e * hl), reach, halfS)) {
          p.target = GATE_BEND; this._easing = true; break; // bend down-slope, stays for the run
        }
      }
    }
  }

  // Ease each clipped post onto its bend and drag the banner's matching corners
  // along, so the post + banner stay attached. Costs nothing once settled.
  update(dt) {
    if (!this._easing) return;
    const k = 1 - Math.exp(-GATE_BEND_RATE * dt);
    let easing = false;
    const pos = this._bar.geometry.attributes.position;
    for (const p of this._posts) {
      if (p.bend === p.target) continue;
      p.bend += (p.target - p.bend) * k;
      if (Math.abs(p.target - p.bend) < 1e-4) p.bend = p.target; else easing = true;
      p.mesh.quaternion.setFromAxisAngle(_xAxis, p.bend); // base-pinned → top swings down-slope
      // drag this post's two banner corners (top + bottom) to follow its top
      const c = Math.cos(p.bend), sIn = Math.sin(p.bend);
      const dy = GATE_H * (c - 1), z = GATE_H * sIn;        // top displacement from upright
      const top = p.side > 0 ? 1 : 0, bot = p.side > 0 ? 3 : 2; // PlaneGeometry corner indices for this side
      pos.setY(top, GATE_BAR_H / 2 + dy); pos.setZ(top, z);
      pos.setY(bot, -GATE_BAR_H / 2 + dy); pos.setZ(bot, z);
    }
    pos.needsUpdate = true;
    this._bar.geometry.computeVertexNormals();
    this._easing = easing;
  }

  // Straighten the gate back up (called at the start of each run, with the poles).
  reset() {
    const pos = this._bar.geometry.attributes.position;
    for (const p of this._posts) {
      p.bend = 0; p.target = 0; p.mesh.quaternion.identity();
      const top = p.side > 0 ? 1 : 0, bot = p.side > 0 ? 3 : 2;
      pos.setY(top, GATE_BAR_H / 2); pos.setZ(top, 0);
      pos.setY(bot, -GATE_BAR_H / 2); pos.setZ(bot, 0);
    }
    pos.needsUpdate = true;
    this._bar.geometry.computeVertexNormals();
    this._easing = false;
  }
}
