// SlopeBuilder — turns a dependency-free slope definition (shared/slopes.js)
// into a descending Centerline plus resolved ramp/obstacle positions. Mirrors
// the reference TrackBuilder's role (author a 1-D path, hand it to the engine +
// renderer) but builds a point-to-point downhill instead of chaining GLB tiles.
//
// Returns { centerline, length, slopeWidth, groundY, ramps, obstacles, def }.
import * as THREE from 'three';
import { Centerline } from './Centerline.js';
import { generateSlope } from '../shared/slopes.js';

const DEG = Math.PI / 180;
const STEP = 2.0; // arclength between centerline samples (Catmull-Rom smooths between)
// Flat run-out appended to the centerline PAST the finish line. The finish is no
// wall: a skier crosses it and coasts onto this level apron, braking to a stop
// (see SkiEngine FINISH_BRAKE). Without real geometry here, sampleAt() clamps at
// the finish frame and the skier slams into an invisible wall. Long enough that
// even a fast finisher stops well before the centerline's clamp at the apron end.
const FINISH_APRON = 48;

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

// Append the flat finish apron (see FINISH_APRON): level the run off from the last
// frame, continuing the run's horizontal heading at constant elevation. Returns
// the apron's end arclength. The renderer flattens the same way (SceneRenderer),
// so a finished skier stays glued to the visible piste through the level-off.
function appendOutrun(samples, fromS) {
  const fE = samples[samples.length - 1];
  const flatT = new THREE.Vector3(fE.tangent.x, 0, fE.tangent.z);
  if (flatT.lengthSq() < 1e-6) flatT.set(0, 0, 1);
  flatT.normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const lateral = flatT.clone().cross(up).normalize();
  if (lateral.dot(fE.lateral) < 0) lateral.negate(); // keep the run's side → no twist at the join
  const steps = Math.max(2, Math.round(FINISH_APRON / STEP));
  for (let k = 1; k <= steps; k++) {
    const d = (FINISH_APRON * k) / steps;
    samples.push({
      pos: new THREE.Vector3(fE.pos.x + flatT.x * d, fE.pos.y, fE.pos.z + flatT.z * d),
      tangent: flatT.clone(), up: up.clone(), lateral: lateral.clone(),
      s: fromS + d,
    });
  }
  return fromS + FINISH_APRON;
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
  const length = s; // FINISH LINE: end of the authored run (race distance, banner, features)

  // Extend the geometry with a flat apron PAST the finish so the run-out is real
  // ground, not a clamp. `length` (the finish) is unchanged; the centerline's own
  // length (the clamp bound) becomes the apron end.
  const apronEnd = appendOutrun(samples, length);
  const centerline = new Centerline(samples, apronEnd);

  let minY = Infinity;
  for (const sm of samples) minY = Math.min(minY, sm.pos.y);
  const groundY = minY - 0.4;

  const ramps = (def.ramps || []).map((r) => ({
    s: r.at * length, lat: r.lat || 0, radius: r.radius || 1.5, width: r.width || 2.4,
  }));
  const obstacles = (def.obstacles || []).map((o) => ({
    s: o.at * length, lat: o.lat || 0, radius: o.radius || (o.kind === 'rock' ? 0.85 : 0.7), kind: o.kind || 'tree',
  }));
  // The finish-gate posts (drawn by the renderer's FinishGate) are solid obstacles
  // too: clipping one at the line wipes you out like a tree/rock. At the OUTER piste
  // edge (±width/2), so only an edge-hugging line hits them. kind:'post' → the
  // renderer skips drawing a tree here.
  const pisteHalf = (def.width || 11) / 2;
  obstacles.push(
    { s: length - 0.2, lat: -pisteHalf, radius: 0.25, kind: 'post' },
    { s: length - 0.2, lat: pisteHalf, radius: 0.25, kind: 'post' },
  );

  return {
    centerline, length,
    slopeWidth: def.width || 11,
    groundY,
    ramps, obstacles,
    def,
  };
}

// Build a fresh procedural slope from a seed — returns the resolved
// { centerline, length, ramps, obstacles, … } the renderer/engine take.
export function buildGeneratedSlope(seed, opts) {
  return buildSlope(generateSlope(seed, opts));
}
