// SlopeBuilder — turns a dependency-free slope definition (shared/slopes.js)
// into a descending Centerline plus resolved ramp/obstacle positions. Mirrors
// the reference TrackBuilder's role (author a 1-D path, hand it to the engine +
// renderer) but builds a point-to-point downhill instead of chaining GLB tiles.
//
// Returns { centerline, length, slopeWidth, groundY, ramps, obstacles, def }.
import * as THREE from 'three';
import { Centerline } from './Centerline.js';
import { SLOPES, generateSlope } from '../shared/slopes.js';

const DEG = Math.PI / 180;
const STEP = 2.0; // arclength between centerline samples (Catmull-Rom smooths between)

// Walk one piece, appending samples. Mutates the cursor {pos, psi} in place and
// returns the new running arclength `s`.
function walkPiece(piece, cursor, s, out) {
  const steps = Math.max(2, Math.round(piece.len / STEP));
  const ds = piece.len / steps;
  const pitch = (piece.pitch || 12) * DEG;
  const turn = (piece.turn || 0) * DEG;
  const dpsi = turn / steps; // yaw added per step (carve)

  for (let i = 0; i < steps; i++) {
    // advance heading first for carves so the arc curves smoothly
    cursor.psi += dpsi;
    const sinPsi = Math.sin(cursor.psi), cosPsi = Math.cos(cursor.psi);
    const sinP = Math.sin(pitch), cosP = Math.cos(pitch);
    // tangent points down-slope (y negative as we descend)
    const tangent = new THREE.Vector3(cosP * sinPsi, -sinP, cosP * cosPsi);
    // horizontal sideways axis
    const lateralH = new THREE.Vector3(cosPsi, 0, -sinPsi);
    // slope normal (perpendicular to tangent + lateral, pointing up)
    const up = tangent.clone().cross(lateralH).normalize();
    if (up.y < 0) up.negate();
    const lateral = tangent.clone().cross(up).normalize();

    cursor.pos.addScaledVector(tangent, ds);
    s += ds;
    out.push({
      pos: cursor.pos.clone(),
      tangent: tangent.clone(),
      up,
      lateral,
      s,
    });
  }
  return s;
}

export function buildSlope(def) {
  const samples = [];
  const cursor = { pos: new THREE.Vector3(0, 0, 0), psi: 0 };
  // seed sample at the very top (s=0) so the start gate / grid (s<0 clamps to 0)
  // has a frame to sit on.
  {
    const pitch = ((def.pieces[0] && def.pieces[0].pitch) || 14) * DEG;
    const tangent = new THREE.Vector3(0, -Math.sin(pitch), Math.cos(pitch));
    const lateralH = new THREE.Vector3(1, 0, 0);
    const up = tangent.clone().cross(lateralH).normalize();
    if (up.y < 0) up.negate();
    const lateral = tangent.clone().cross(up).normalize();
    samples.push({ pos: cursor.pos.clone(), tangent: tangent.clone(), up, lateral, s: 0 });
  }

  let s = 0;
  for (const piece of def.pieces) s = walkPiece(piece, cursor, s, samples);
  const length = s;

  const centerline = new Centerline(samples, length);

  let minY = Infinity;
  for (const sm of samples) minY = Math.min(minY, sm.pos.y);
  const groundY = minY - 0.4;

  const ramps = (def.ramps || []).map((r) => ({
    s: r.at * length, lat: r.lat || 0, radius: r.radius || 1.5, width: r.width || 2.4,
  }));
  const obstacles = (def.obstacles || []).map((o) => ({
    s: o.at * length, lat: o.lat || 0, radius: o.radius || (o.kind === 'rock' ? 0.85 : 0.7), kind: o.kind || 'tree',
  }));

  return {
    centerline, length,
    slopeWidth: def.width || 11,
    groundY,
    ramps, obstacles,
    def,
  };
}

export function buildSlopeById(id) {
  const def = SLOPES[id] || SLOPES[Object.keys(SLOPES)[0]];
  return buildSlope(def);
}

// Build a fresh procedural slope from a seed (mirrors buildSlopeById — same
// resolved { centerline, length, ramps, obstacles, … } the renderer/engine take).
export function buildGeneratedSlope(seed, opts) {
  return buildSlope(generateSlope(seed, opts));
}

export { SLOPES };
