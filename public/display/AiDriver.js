// AiDriver — pure-pursuit autopilot for the CPU skiers that fill empty slots so
// a short-handed lobby still races a full field. Steers toward a point further
// down the slope centerline; because the target sits ON the fall line, the same
// term both recenters lateral drift and anticipates the upcoming bend.
//
// One source of truth for "follow the line," shared by the live race
// (display/main.js driveBots), the finished-skier coast (SkiEngine), and the
// no-relay gallery preview (TestHarness). Dependency-free (no THREE): it reads
// the engine skier POSES (the vectors the engine already placed on skier.pose),
// so it always reads the same frame the engine produced.

const LOOKAHEAD = 8.0;    // world units down the line a bot aims at
const STEER_GAIN = 1.7;   // carve per radian of heading error (proportional)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Local slope curvature (rad per world unit) at arclength s — the turn between
// two nearby tangents (cross/dot trick, no THREE import).
function curvatureAt(centerline, s, step = 0.7) {
  const a = centerline.sampleAt(s), b = centerline.sampleAt(s + step);
  const cross = a.tangent.clone().cross(b.tangent).dot(b.up);
  const dot = a.tangent.dot(b.tangent);
  return Math.abs(Math.atan2(cross, dot)) / step;
}

// Peak curvature in a look-ahead window (how sharp the line gets soon).
const CORNER_LOOK_NEAR = 2.0;
const CORNER_LOOK_FAR = 16.0;
const CORNER_LOOK_STEP = 1.5;
function cornerAhead(skier, centerline) {
  let k = 0;
  for (let d = CORNER_LOOK_NEAR; d <= CORNER_LOOK_FAR; d += CORNER_LOOK_STEP) {
    k = Math.max(k, curvatureAt(centerline, skier.totalS + d));
  }
  return k;
}

// Carve one skier toward the lookahead point (optionally offset to a held lane).
// Returns a carve input in [-1, 1] for engine.processInput {s}.
export function pursue(skier, centerline, { lookahead = LOOKAHEAD, gain = STEER_GAIN, laneBias = 0 } = {}) {
  if (!skier || !skier.pose) return 0;
  const f = centerline.sampleAt(skier.totalS + lookahead);
  const tgt = f.pos.clone().addScaledVector(f.lateral, laneBias);
  const up = skier.pose.up, fwd = skier.pose.forward;
  const to = tgt.sub(skier.pose.pos);
  to.addScaledVector(up, -to.dot(up)); // flatten onto the slope plane
  if (to.lengthSq() < 1e-6) return 0;
  to.normalize();
  const cross = fwd.clone().cross(to).dot(up);
  const dot = clamp(fwd.dot(to), -1, 1);
  const err = Math.atan2(cross, dot); // + = target is to the skier's left
  // The engine yaws by STEER_SIGN(-1)·f(carve), so a NEGATIVE carve turns toward
  // a LEFT target — hence the leading minus.
  return clamp(-err * gain, -1, 1);
}

// When does a bot dare to tuck? Tuck (in the engine) cuts carve authority, so a
// bot should tuck the straights and STAND UP before a bend it must hold. The
// curvature threshold scales with skill: a bold bot tucks deeper into corners.
const TUCK_CURVE_BASE = 0.045;

// A bot personality. `skill` (0..1) sets how aggressively it tucks: a low-skill
// bot stands up early (NOTUCK_CAP keeps it slower → catchable by a first-timer);
// a high-skill bot tucks deep and rails the line. `laneBias` fans bots across
// the piste so the field doesn't run nose-to-tail.
export class AiController {
  constructor({ skill = 0.9, lookahead = LOOKAHEAD, gain = STEER_GAIN, laneBias = 0 } = {}) {
    this.skill = clamp(skill, 0, 1);
    this.lookahead = lookahead;
    this.gain = gain;
    this.laneBias = laneBias;
  }
  // {s, t} ready to hand straight to engine.processInput(id, ...). (Bots launch
  // off ramps automatically — the engine's ramp trigger fires for any skier on
  // the snow — so they never need to send a jump.)
  drive(skier, centerline) {
    const s = pursue(skier, centerline, { lookahead: this.lookahead, gain: this.gain, laneBias: this.laneBias });
    const k = cornerAhead(skier, centerline);
    const tuckLimit = TUCK_CURVE_BASE * (0.5 + this.skill); // bolder skill → tucks into sharper bends
    const t = k < tuckLimit ? 1 : 0;
    return { s, t };
  }
}

// Bot field, strongest first. Bots are filled from the front, so a lobby missing
// one player gets the strong leader. STARTING VALUES — tune for the piste width.
export const AI_PERSONALITIES = [
  { name: 'Yeti',    skill: 0.96, laneBias: -1.4 },
  { name: 'Frost',   skill: 0.88, laneBias:  1.4 },
  { name: 'Powder',  skill: 0.80, laneBias: -0.6 },
  { name: 'Flurry',  skill: 0.72, laneBias:  0.6 },
];
