// SkiTrails — two parallel grooves carved into the snow behind every skier.
// One growing ribbon mesh per skier, ring-buffered so old track drops off and
// memory stays bounded, laid FLUSH on the (tilted) slope under the skis.
//
// Renderer-only / cosmetic: it's fed pose.pos/forward/up from the engine each
// frame (the engine never knows it exists). Points are recorded by DISTANCE
// travelled, not per frame, so the ribbon density is independent of framerate
// and speed and the segment count stays bounded. No groove is laid while
// airborne; the ribbon breaks across jumps and ski-patrol resets so it never
// draws a straight line across a gap the skier flew over.
import * as THREE from 'three';

const MAX_POINTS = 2000;     // ring-buffer cap per skier (oldest points drop off)
const MIN_STEP   = 0.45;     // world units of travel between recorded points
const MAX_GAP    = 3;        // break the ribbon past this jump. A ski-patrol reset snaps
                            // the skier ~0.6×slope-width (≥6u) sideways; normal travel is
                            // ≤~1.5u/step even at top speed, so 3 cleanly separates them.
const STANCE     = 0.16;     // lateral offset of each ski from centre (matches addSkier's skis)
const HALF_W     = 0.075;    // half-width of one groove
const LIFT       = 0.03;     // raised along the slope normal so it can't z-fight the piste
const TRACK_COLOR = 0xaebccd; // compressed-snow shadow (faint cool grey-blue)

const VPP = 4;               // verts per point: left groove [outer,inner], right groove [inner,outer]
const IPP = 12;              // indices per segment: 2 grooves × 2 tris × 3

export class SkiTrails {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.trails = new Map();
    // scratch (the hot path allocates nothing)
    this._p = new THREE.Vector3();
    this._lat = new THREE.Vector3();
    this._base = new THREE.Vector3();
    this._c = new THREE.Vector3();
  }

  _make(id) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_POINTS * VPP * 3), 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX_POINTS * VPP * 3), 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(MAX_POINTS * IPP), 1));
    geom.setDrawRange(0, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: TRACK_COLOR, roughness: 1, metalness: 0,
      transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false; // it grows + wraps; always-draw is cheaper than rebounding the box
    this.group.add(mesh);
    const t = {
      mesh, geom,
      posAttr: geom.getAttribute('position'),
      nrmAttr: geom.getAttribute('normal'),
      idxAttr: geom.getIndex(),
      pen: new Uint8Array(MAX_POINTS), // 1 = this point connects back to its predecessor
      count: 0, last: new THREE.Vector3(), lastAir: true,
    };
    this.trails.set(id, t);
    return t;
  }

  // Called per skier per frame with its authoritative pose.
  addPoint(id, pos, forward, up, airborne) {
    let t = this.trails.get(id);
    if (!t) t = this._make(id);
    if (airborne) { t.lastAir = true; return; } // no groove in the air

    const p = this._p.copy(pos);
    let pen = 1;
    if (t.count === 0 || t.lastAir) pen = 0;     // first point, or just landed → start a fresh ribbon
    else {
      const d = p.distanceTo(t.last);
      if (d < MIN_STEP) return;                  // not enough travel — skip this frame
      if (d > MAX_GAP) pen = 0;                   // teleport / reset → break the ribbon
    }

    // lateral on the slope plane (matches the skier's local +x = up × forward in setSkierPose)
    const lat = this._lat.copy(up).cross(forward).normalize();
    const base = this._base.copy(p).addScaledVector(up, LIFT);

    const slot = t.count % MAX_POINTS, vb = slot * VPP * 3;
    this._writeVert(t, vb,     base, lat, up,  STANCE + HALF_W); // L outer
    this._writeVert(t, vb + 3, base, lat, up,  STANCE - HALF_W); // L inner
    this._writeVert(t, vb + 6, base, lat, up, -STANCE + HALF_W); // R inner
    this._writeVert(t, vb + 9, base, lat, up, -STANCE - HALF_W); // R outer
    t.pen[slot] = pen;
    t.last.copy(p);
    t.lastAir = false;
    t.count++;

    t.posAttr.needsUpdate = true;
    t.nrmAttr.needsUpdate = true;
    this._rebuildIndex(t);
  }

  _writeVert(t, o, base, lat, up, off) {
    const c = this._c.copy(base).addScaledVector(lat, off);
    const pos = t.posAttr.array, nrm = t.nrmAttr.array;
    pos[o] = c.x; pos[o + 1] = c.y; pos[o + 2] = c.z;
    nrm[o] = up.x; nrm[o + 1] = up.y; nrm[o + 2] = up.z; // flat on the slope → normal = slope up
  }

  // Stitch consecutive kept points into two groove quads each. Rebuilt per add
  // (≤ MAX segments, trivial) so the ring's wrap seam needs no special-casing.
  _rebuildIndex(t) {
    const total = t.count;
    const start = Math.max(0, total - MAX_POINTS) + 1; // first point whose predecessor is still in the window
    const idx = t.idxAttr.array;
    let n = 0;
    for (let L = start; L < total; L++) {
      const slotB = L % MAX_POINTS;
      if (!t.pen[slotB]) continue;             // ribbon break before this point
      const a = ((L - 1) % MAX_POINTS) * VPP, b = slotB * VPP;
      idx[n++] = a;     idx[n++] = a + 1; idx[n++] = b + 1; // left groove
      idx[n++] = a;     idx[n++] = b + 1; idx[n++] = b;
      idx[n++] = a + 2; idx[n++] = a + 3; idx[n++] = b + 3; // right groove
      idx[n++] = a + 2; idx[n++] = b + 3; idx[n++] = b + 2;
    }
    t.geom.setDrawRange(0, n);
    t.idxAttr.needsUpdate = true;
  }

  clear() {
    for (const t of this.trails.values()) {
      this.group.remove(t.mesh);
      t.geom.dispose(); t.mesh.material.dispose();
    }
    this.trails.clear();
  }
}
