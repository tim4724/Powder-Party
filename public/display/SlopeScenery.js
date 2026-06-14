// SlopeScenery — static world construction for SceneRenderer: the snow ribbon,
// mountainside walls/flanks, decorative forests, distant peaks, props (ramps,
// obstacles, banners) and the (s, lat) hitbox-debug outlines. Pure mesh
// builders: every function takes the group it populates plus explicit data —
// no renderer state. SceneRenderer owns cameras/lighting/skiers and calls these
// from setTrack.
import * as THREE from 'three';
import { mulberry32 } from '../shared/slopes.js';

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
  m.receiveShadow = true;
  group.add(m);
}

// The two-tone snow ribbon + valley cross-section: groomed piste (alternating
// corduroy passes), deep-snow shoulders, then snow rising into mountainside
// walls on each side — all built from the centerline so the whole valley
// descends with the run. Near-white, no warm tint.
export function addTerrain(group, meshSamples, pisteHalf, edgeLat, groundY) {
  const NB = 6;                       // groomer passes across the piste
  const PASS = 0xffffff, GROOVE = 0xf6f9fc, DEEP = 0xedf2f8, WALL = 0xf4f8fd;
  const mat = (color) => new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
  const passMat = mat(PASS), grooveMat = mat(GROOVE), deepMat = mat(DEEP), wallMat = mat(WALL);
  for (let p = 0; p < NB; p++) {      // groomed piste passes
    const a = -pisteHalf + (2 * pisteHalf) * (p / NB);
    const b = -pisteHalf + (2 * pisteHalf) * ((p + 1) / NB);
    addSlopeStrip(group, meshSamples, a, b, 0, 0, p % 2 === 0 ? passMat : grooveMat);
  }
  addSlopeStrip(group, meshSamples, -edgeLat, -pisteHalf, 0, 0, deepMat); // deep-snow shoulders
  addSlopeStrip(group, meshSamples, pisteHalf, edgeLat, 0, 0, deepMat);
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
  const mat = new THREE.MeshStandardMaterial({ color: 0xeef3f9, side: THREE.DoubleSide, roughness: 1, metalness: 0 });
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
    m.receiveShadow = true;
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

// Scatter an alpine pine forest over the mountainside banks (decorative, not
// collidable — the engine's obstacles are separate).
function addBankForest(group, samples, edgeLat, rnd) {
  const n = samples.length;
  const foliage = new THREE.MeshStandardMaterial({ color: 0x2f7d52, roughness: 1, flatShading: true });
  const bark = new THREE.MeshStandardMaterial({ color: 0x6b4a2f });
  for (let i = 4; i < n - 4; i += 3) {
    const s = samples[i];
    for (const side of [-1, 1]) {
      if (rnd() < 0.5) continue;
      const off = side * (edgeLat + 3 + rnd() * 58);
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.2, 6), bark);
      trunk.position.y = 0.6; tree.add(trunk);
      for (let c = 0; c < 3; c++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(1.3 - c * 0.32, 1.5, 7), foliage);
        cone.position.y = 1.4 + c * 0.85; tree.add(cone);
      }
      tree.scale.setScalar(0.8 + rnd() * 1.9);
      tree.rotation.y = rnd() * Math.PI * 2; // random yaw so the bank trees don't all face the same way
      tree.position.copy(s.pos).addScaledVector(s.lateral, off).addScaledVector(_up, riseAt(Math.abs(off), edgeLat));
      group.add(tree);
    }
  }
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
  if (!place.length) return;

  const N = place.length;
  const bark = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
  const foliage = new THREE.MeshStandardMaterial({ color: 0x2f7d52, roughness: 1, flatShading: true });
  // one InstancedMesh per tree part, all sharing the per-tree transforms.
  const parts = [new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.24, 1.2, 6).translate(0, 0.6, 0), bark, N)];
  for (let c = 0; c < 3; c++) {
    parts.push(new THREE.InstancedMesh(new THREE.ConeGeometry(1.3 - c * 0.32, 1.5, 7).translate(0, 1.4 + c * 0.85, 0), foliage, N));
  }
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3(), sc = new THREE.Vector3(), m4 = new THREE.Matrix4();
  for (let k = 0; k < N; k++) {
    const t = place[k];
    q.setFromAxisAngle(_up, t.rotY); p.set(t.x, t.y, t.z); sc.setScalar(t.scl);
    m4.compose(p, q, sc);
    for (const im of parts) im.setMatrixAt(k, m4);
  }
  for (const im of parts) {
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = false; im.receiveShadow = false;
    im.frustumCulled = false; // instances span the whole mountain; the origin-centred bound would wrongly cull
    group.add(im);
  }
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
  const snow = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xc6d2e0, emissiveIntensity: 0.18, roughness: 1, flatShading: true });
  const N = 16;
  for (let i = 0; i < N; i++) {
    // even spacing + alternating jitter → organic but never a gap.
    const ang = (i / N) * Math.PI * 2 + (i % 2 ? 0.17 : -0.13);
    const dist = R * (0.92 + (i % 3) * 0.16);
    const h = 210 + (i % 4) * 50 + (i % 2) * 44;  // ~210..390
    const r = h * 0.62;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5, 1), snow);
    cone.position.set(center.x + Math.cos(ang) * dist, floorY + h / 2, center.z + Math.sin(ang) * dist);
    cone.rotation.y = ang * 1.7;
    group.add(cone);
  }
}

// ---- props ----------------------------------------------------------------
export function addRamp(group, cl, r, hitboxDebug) {
  const f = cl.sampleAt(r.s);
  // A LOW kicker, sized to the air scale (launch apex ~0.9u) so the skier
  // clears it instead of driving through a too-tall box. Built as a box, tilted
  // so its top face ramps up along the slope tangent.
  const w = (r.width || 2.4), len = 3.0, h = 0.5;
  const geo = new THREE.BoxGeometry(w, h, len);
  const ramp = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x7fc4ec, roughness: 0.8 }));
  ramp.castShadow = true; ramp.receiveShadow = true;
  const lateral = f.lateral.clone().normalize();
  const tangent = f.tangent.clone().normalize();
  const up = f.up.clone().normalize();
  ramp.position.copy(f.pos).addScaledVector(lateral, r.lat).addScaledVector(up, h * 0.25);
  // Build a RIGHT-handed basis (x = up × tangent, NOT `lateral` = tangent × up,
  // which would be left-handed → setFromRotationMatrix mis-orients the wedge).
  const rx = new THREE.Vector3().crossVectors(up, tangent).normalize();
  ramp.quaternion.setFromRotationMatrix(_basis.makeBasis(rx, up, tangent));
  ramp.rotateX(-0.32); // tip the lip up
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
      new THREE.MeshStandardMaterial({ color: 0x8a93a1, roughness: 1, flatShading: true })
    );
    rock.castShadow = true; rock.scale.set(1, 0.7, 1);
    g.add(rock);
  } else {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, 0.9, 6),
      new THREE.MeshStandardMaterial({ color: 0x7a5230 })
    );
    trunk.position.y = 0.45; trunk.castShadow = true;
    g.add(trunk);
    const foliage = new THREE.MeshStandardMaterial({ color: 0x2f8f5b, roughness: 1, flatShading: true });
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.95 - i * 0.22, 1.0, 7), foliage);
      cone.position.y = 1.0 + i * 0.55; cone.castShadow = true;
      g.add(cone);
    }
  }
  g.position.copy(f.pos).addScaledVector(f.lateral, o.lat);
  g.quaternion.setFromUnitVectors(_up, up);
  group.add(g);
  if (hitboxDebug) {
    group.add(debugCircle(f, o.lat || 0, o.radius || (o.kind === 'rock' ? 0.7 : 0.8), 0xff2244));
  }
}

// A grey-tinted band of snow ACROSS the piste (start marker). An overhead gate
// was unreadable in split-screen — a flat surface marking is clear from the low
// chase cam without any 3D clutter. Built the SAME way as the snow ribbon: a
// strip stitched from centerline cross-sections (each edge placed off its own
// frame), so it hugs the slope exactly — following the pitch instead of floating
// as one rigid quad. computeVertexNormals makes it light identically to the
// piste, so it reads as tinted snow, not a panel. transparent + depthWrite:false
// makes it a decal the (opaque) skiers always render on top of.
export function addStartLine(group, cl, s, halfW) {
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
  const line = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: 0x6b7079, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    transparent: true, opacity: 0.5, depthWrite: false,
  }));
  line.receiveShadow = true;
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
  _checkerCache.set(key, tex);
  return tex;
}

// The finish gate: charcoal posts at the OUTER piste edge (±halfW, where the
// slalom poles stand) under a checkered-flag banner — the universal finish cue.
export function addFinishGate(group, cl, s, halfW) {
  const f = cl.sampleAt(Math.max(0, Math.min(cl.length, s)));
  const lateral = f.lateral.clone().normalize();
  const up = f.up.clone().normalize();
  const tangent = f.tangent.clone().normalize();
  const H = 3.4; // post height
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x161922, roughness: 0.6 });
  const poleGeo = new THREE.CylinderGeometry(0.13, 0.13, H, 8);
  for (const side of [-1, 1]) {
    const pole = new THREE.Mesh(poleGeo, frameMat);
    pole.position.copy(f.pos).addScaledVector(lateral, side * halfW).addScaledVector(up, H / 2);
    pole.quaternion.setFromUnitVectors(_up, up);
    pole.castShadow = true;
    group.add(pole);
  }
  const barH = 0.9;
  const cols = Math.max(8, Math.round((halfW * 2) / (barH / 2))); // ~square cells
  const bar = new THREE.Mesh(
    new THREE.PlaneGeometry(halfW * 2, barH), // a flat checkered band, not a 3D bar
    new THREE.MeshStandardMaterial({ map: checkerTexture(cols, 2), roughness: 0.7, side: THREE.DoubleSide }));
  bar.position.copy(f.pos).addScaledVector(up, H - barH / 2);
  const bx = new THREE.Vector3().crossVectors(up, tangent).normalize(); // right-handed
  // plane faces +Z → map X→cross-slope, Y→up, Z(normal)→tangent so the band stands vertical across the gate
  bar.quaternion.setFromRotationMatrix(_basis.makeBasis(bx, up, tangent));
  group.add(bar);
}
