// AiDriver — autopilot for the CPU skiers that fill empty slots so a short-handed
// lobby still races a full field. It does what a decent human does on these
// hills: bombs the run tucked, DODGES the trees, claws back onto the piste when
// it strays, and throws a flip off a kicker for the landing boost.
//
// Each tree/skier ahead carves a forbidden lateral band; the planner aims for the
// lane nearest its held line that clears every band and stays on the piste, then a
// pure-pursuit carve drives toward it (steering harder, and standing up, when the
// dodge is tight). It rides tucked while the upcoming bend is holdable at speed and
// stands up for the sharp ones. Because it reads the engine's resolved features
// (obstacles/ramps in arclength `s`) and the live skier poses, the bot always
// reacts to the same frame the engine produced.
//
// One source of truth for "drive the line," shared by the live race
// (display/main.js driveBots) and the no-relay gallery preview (TestHarness).
// THREE-free: it reads the vector frames `centerline.sampleAt` returns and the
// plain scalar (s, lat) state on each skier. Its only import is the engine's
// exported tuning constants, so the bot's model of the physics (carve ceiling,
// gravity, trick gates) can never drift from the physics it actually flies.
import {
  SIN_REF, STEEP_MIN, STEEP_MAX, TUCK_TURN_MUL,
  GRAV_AIR, TRICK_MIN_AIR, TRICK_DURATION,
} from './engine/SkiEngine.js';

const LOOKAHEAD = 8.0;    // world units down the line a bot aims at
const STEER_GAIN = 1.7;   // carve per radian of heading error (proportional)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Local slope curvature (rad per world unit) at arclength s — the turn between
// two nearby tangents (cross/dot trick, no THREE import).
function curvatureAt(centerline, s, step = 1.5) {
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

// When does a bot dare to tuck? Tuck cuts carve authority (engine TUCK_TURN_MUL),
// so on a bend the bot can only rail the line tucked while the centerline's turn
// rate (curvature k × speed v) stays under what it can still carve squatted. Past
// that it would understeer off the line, so it STANDS UP (the brake) for full
// authority. Bots ski the benchmark `edge` (1.0, SAME grip as a human) — no grip
// cheat — but the RACING LINE (below) straightens the corners so they rarely need to:
// braking ends up light (~10%), reserved for the genuinely tight bends. The decision
// is judged against a STABLE speed (vmax·steepNorm), NOT the live speed — else braking
// would drop v, un-trip the test, and limit-cycle — so it flips only at real curve-in /
// curve-out transitions, in sustained phases (not a per-frame flutter).
// (TUCK_TURN_MUL / SIN_REF / STEEP_* are imported from the engine above.)
const HOLD_FRAC = 1.40;      // brake once the bend needs this fraction of the tucked carve ceiling
                            // (lower → brakes earlier/more for turns, fewer understeer crashes)
const TUCK_RESUME = 0.7;     // …re-tuck only once it eases back under this fraction of that (deadband)

// ---- Line selection (clear-lane planning) -------------------------------
// A tree/skier carves a FORBIDDEN lateral band [lat ± need] for the stretch it
// occupies. The plan picks the lateral target nearest the held line that sits
// OUTSIDE every band in the decision window and on the groomed piste — committing
// to clear the field rather than chasing a per-frame grid choice (which thrashed
// and lagged on curves). When dodging, the carve steers harder (shorter lookahead)
// and — if the tree is close — stands up for full authority so the bot actually
// reaches the lane instead of clipping the trunk it "chose" to avoid.
const EDGE_MARGIN = 1.0;     // never target a lane nearer than this to the deep-snow edge
const SOFT_EDGE = 1.8;       // lanes within this of the edge cost a little (nudge inward)
const CLEAR_BASE = 0.95;      // base extra clearance carried around a hazard (skill widens it) —
                            // also the buffer that absorbs steering lag so a small miss still clears
const DECIDE_LOOK = 18.0;    // floor on the decision window (world units)…
const DECIDE_TIME = 1.5;     // …grown to v·this so a fast bot commits to the dodge just as early (s)
const URGENT_TIME = 0.35;    // a tree within v·this AND needing a big swerve → stand up NOW
const URGENT_MOVE = 1.0;     // …only when the lane is still this far off (else dodge it TUCKED) —
                            // keeps the stand-up rare: small dodges are carved without braking
const SKIER_LOOK = 8.0;      // give a skier this far ahead room (pick a passing line)
const SKIER_ABREAST = 2.0;   // a skier within this |Δs| is riding ALONGSIDE — dodge it too, so the pair doesn't lock together
const PEEL_STACK = 1.2;      // …and if it's also within this of our lane we're stacked: peel deterministically apart
const PEEL_BIAS = 1.6;       // how far (u) that peel shoves our preferred lane to its assigned (by-id) side
const RAMP_LOOK = 16.0;      // a reachable kicker within this pulls the bolder bots in
const RAMP_REACH = 2.2;      // …but only if it's already within this of the current line
// Racing line: the preferred lateral leans toward the INSIDE of the bend ahead (the
// way the centerline drifts), so the bot cuts the corner. A straighter actual path
// needs less carving → less speed scrubbed AND it can hold the bend tucked instead of
// braking. Skill scales how cleanly the line is taken, so a stronger bot is faster
// purely by DRIVING better — the legit alternative to a grip/speed cheat.
const RACE_LOOK = 18.0;      // how far ahead the bend is read (world units)
const RACE_GAIN = 0.65;      // centerline lateral drift → inside offset
const RACE_MAX = 3.0;        // cap the inside offset (stay well on the piste)
const LANE_HOLD = 0.35;      // how much of the personality lane survives (keeps the field fanned out)
const EDGE_W = 8;            // skiing the very edge of the groomed piste
const PREF_W = 2.2;          // stray from the personality's held line…
const SWERVE_W = 1.6;        // …and weave further than needed (also damps side flip-flop)
const DODGE_LOOK = 4.5;      // pursue lookahead while dodging — short = a harder, faster carve
const HARD_DODGE_S = 7.0;    // a tree this close while dodging → stand up for full carve

// ---- Air tricks ----------------------------------------------------------
// GRAV_AIR / TRICK_MIN_AIR / TRICK_DURATION come from the engine import above.
const FLIP_MIN_AIR = TRICK_MIN_AIR + 0.05; // only flip once clearly above the engine's arm gate
const FLIP_DUR = TRICK_DURATION; // ≥ one back-flip rotation (the engine's m=0.6 fallback spins a hair faster — errs safe)
const FLIP_MARGIN = 0.22;    // airtime to spare beyond the rotation → never land mid-flip (a crash
                             // costs far more than the 8% boost, so the bot only flips when it's safe)
const TRICK_SKILL_MIN = 0.78;// only the bolder bots bother seeking kickers / throwing a flip

// A bot personality. `skill` (0..1) sets how cleanly it skis: it drives a stronger
// racing line, dodges with more clearance, seeks kickers, and throws flips.
// `laneBias` is its preferred line — fanning the bots across the piste so the field
// doesn't run nose-to-tail.
export class AiController {
  constructor({ skill = 0.9, lookahead = LOOKAHEAD, gain = STEER_GAIN, laneBias = 0, avoid = true } = {}) {
    this.skill = clamp(skill, 0, 1);
    this.lookahead = lookahead;
    this.gain = gain;
    this.laneBias = laneBias;
    this.avoid = avoid;             // false → ignore trees/skiers, just hold laneBias (bump-lab derby)
    this.tricks = this.skill >= TRICK_SKILL_MIN;
    this.jSeq = 0;                  // wrapping jump/flip counter (latest-wins, matches the engine idle 0)
    this._tuck = 1;                 // sticky tuck state for the stand-up-for-bends deadband
  }

  // {s, t, j} ready to hand straight to engine.processInput(id, ...). `world` is the
  // SkiEngine (it exposes centerline/obstacles/ramps/skiers/pisteHalf); a bare
  // centerline is also accepted and degrades to plain line-following (no avoidance).
  drive(skier, world) {
    const engine = world && world.centerline ? world : null;
    const centerline = engine ? engine.centerline : world;

    // Plan a clear lateral target, then pure-pursuit carve toward it. When a dodge
    // is on, steer harder (shorter lookahead) so the bot actually reaches the lane.
    const plan = (engine && this.avoid) ? this._plan(skier, engine) : { lat: this.laneBias, urgent: false };
    const dodging = Math.abs(plan.lat - skier.lat) > 0.6 || plan.urgent;
    const look = dodging ? DODGE_LOOK : this.lookahead;
    const s = pursue(skier, centerline, { lookahead: look, gain: this.gain, laneBias: plan.lat });

    // Tuck = the fast mode; the bot rides tucked and only STANDS UP for a bend it
    // can't rail tucked — when the bend's turn rate (k · cruise speed) would exceed
    // its squatted carve ceiling (skier.turn·TUCK_TURN_MUL). The racing line keeps
    // most bends railable, so this rarely trips. Judged at a STABLE speed
    // (vmax·steepNorm) with a deadband, so braking is sustained, not fluttering.
    const fr = centerline.sampleAt(Math.max(0, skier.totalS));
    const steepNorm = clamp(Math.max(0, -fr.tangent.y) / SIN_REF, STEEP_MIN, STEEP_MAX);
    const kv = cornerAhead(skier, centerline) * skier.vmax * steepNorm;
    const tuckCeil = skier.turn * TUCK_TURN_MUL;            // rad/s it can carve while tucked
    if (kv > tuckCeil * HOLD_FRAC) this._tuck = 0;
    else if (kv < tuckCeil * HOLD_FRAC * TUCK_RESUME) this._tuck = 1; // between → hold current state
    let t = this._tuck;
    // Easy dodges are carved while TUCKED; the bot only stands up to claw out of deep
    // snow or for an URGENT, big last-moment swerve — so braking stays rare and
    // event-driven, never a per-corner flutter.
    if (skier.offPiste || plan.urgent) t = 0;

    // Throw ONE back-flip per launch for the landing boost — but only with airtime
    // clearly to spare so the bot never washes out mid-rotation. Bots auto-launch
    // off ramps (no jump needed on the snow); `j` only bites in the air.
    if (engine && this.tricks && skier.airborne &&
        !skier.trickActive && skier.trickCount === 0 &&
        skier.air >= FLIP_MIN_AIR && this._airtimeLeft(skier) >= FLIP_DUR + FLIP_MARGIN) {
      this.jSeq = (this.jSeq + 1) & 255;
    }
    return { s, t, j: this.jSeq };
  }

  // Plan a lateral target: the lane nearest the held line that clears every hazard
  // band in the decision window and stays on the groomed piste. `urgent` = the
  // nearest hazard is close and we still have to move to clear it.
  _plan(skier, engine) {
    const { obstacles, ramps, skiers, pisteHalf } = engine;
    const s0 = skier.totalS, cur = skier.lat;
    const maxLane = Math.max(0.5, pisteHalf - EDGE_MARGIN);
    const softEdge = Math.max(0, pisteHalf - SOFT_EDGE);
    const clear = CLEAR_BASE + 0.5 * this.skill;     // bolder bots clear wider
    const decideLook = Math.max(DECIDE_LOOK, skier.v * DECIDE_TIME); // commit earlier when fast

    // Forbidden lateral bands [lo, hi] from trees (decision window) + nearby skiers.
    const bands = [];
    let nearestDs = Infinity;
    for (const o of obstacles) {
      const ds = o.s - s0;
      if (ds <= 0 || ds > decideLook) continue;
      const need = o.radius + skier.radius + clear;
      bands.push({ lo: o.lat - need, hi: o.lat + need });
      if (ds < nearestDs) nearestDs = ds;
    }
    // Other skiers carve a forbidden band too — but a pure "look AHEAD" scan misses a
    // rival riding right ALONGSIDE (|ds|≈0): the pair locks together and neither peels
    // off (the "two skiers stuck" bug). So treat near-abreast skiers as a hazard as
    // well, and when we're stacked almost dead on someone's line, peel our preferred
    // lane AWAY from them — toward the side we're already on, so the move cooperates
    // with the physics push-apart rather than fighting it. Dead-even (same lat) breaks
    // the tie by id so the pair always splits to OPPOSITE sides, never chase the same.
    let peel = 0;
    for (const b of skiers.values()) {
      if (b === skier || b.finished || b.airborne) continue;
      const ds = b.totalS - s0;
      const ahead = ds > 0 && ds <= SKIER_LOOK;
      const abreast = Math.abs(ds) < SKIER_ABREAST;
      if (!ahead && !abreast) continue;
      const need = skier.radius + b.radius + 0.4;
      bands.push({ lo: b.lat - need, hi: b.lat + need });
      if (abreast && Math.abs(b.lat - cur) < PEEL_STACK) {
        const side = cur - b.lat; // which side of them we're already on
        peel += Math.abs(side) > 1e-3 ? Math.sign(side)
              : (String(skier.id) < String(b.id) ? -1 : 1); // string-compare → works for numeric or 'me'-style ids
      }
    }

    // Preferred line: a RACING LINE — lean toward the inside of the bend ahead so the
    // bot cuts the corner (straighter path → less scrub, holds it tucked). Blended with
    // the personality lane so the field still fans out. A reachable kicker overrides.
    const cl = engine.centerline;
    const f0 = cl.sampleAt(Math.max(0, s0));
    const drift = cl.sampleAt(s0 + RACE_LOOK).pos.clone().sub(f0.pos).dot(f0.lateral);
    const raceLat = clamp(drift * RACE_GAIN * (0.5 + 0.6 * this.skill), -RACE_MAX, RACE_MAX);
    let pref = this.laneBias * LANE_HOLD + raceLat;
    if (this.tricks) {
      for (const r of ramps) {
        const ds = r.s - s0;
        if (ds > 0 && ds < RAMP_LOOK && Math.abs(r.lat - cur) < RAMP_REACH) { pref = r.lat; break; }
      }
    }
    if (peel) pref += peel * PEEL_BIAS;   // shove off a skier we're riding right on top of
    pref = clamp(pref, -maxLane, maxLane);
    if (!bands.length) return { lat: pref, urgent: false };

    // Candidate targets: the preferred line, where we already are, the piste edges,
    // and each band boundary. Keep the cheapest one that clears every band.
    const cands = [pref, cur, -maxLane, maxLane];
    for (const b of bands) { cands.push(b.lo, b.hi); }
    let best = null, bestCost = Infinity;
    for (let L of cands) {
      L = clamp(L, -maxLane, maxLane);
      let blocked = false;
      for (const b of bands) { if (L > b.lo + 1e-6 && L < b.hi - 1e-6) { blocked = true; break; } }
      if (blocked) continue;
      let cost = PREF_W * Math.abs(L - pref) + SWERVE_W * Math.abs(L - cur);
      if (Math.abs(L) > softEdge) cost += EDGE_W * (Math.abs(L) - softEdge);
      if (cost < bestCost) { bestCost = cost; best = L; }
    }
    // No clear lane (a true gauntlet): aim for the preferred line and take the hit.
    if (best == null) best = pref;
    const urgentDist = Math.max(HARD_DODGE_S, skier.v * URGENT_TIME);
    return { lat: best, urgent: nearestDs < urgentDist && Math.abs(best - cur) > URGENT_MOVE };
  }

  // Seconds until touchdown for the current ballistic arc (h + v·t − ½g·t² = 0).
  _airtimeLeft(skier) {
    const h = skier.air, v = skier.vAir;
    return (v + Math.sqrt(Math.max(0, v * v + 2 * GRAV_AIR * h))) / GRAV_AIR;
  }
}

// Bot field, strongest first. Bots are filled from the front, so a lobby missing
// one player gets the strong leader. Flurry sits just under TRICK_SKILL_MIN, so it
// skips kickers/flips and dodges with the tightest margin — the catchable rival.
// `laneBias` runs left→right in field order so the bots' preferred lines match the
// start grid's left→right spread — they fan out cleanly instead of crossing paths
// (and jamming) at the gate. The field builders pass `glide`/`edge` through as the
// skier's engine `stats`:
//   glide = top-speed multiplier — the ONLY handicap and the difficulty dial; the
//           boss matches the player's pace, the tail is a touch slower. Capped at
//           1.0 so a bot is never faster than a human flat-out.
//   edge  = carve grip — kept at the benchmark 1.0, SAME as a human: no grip edge,
//           so bots must scrub/brake through the sharp turns just like you do.
// STARTING VALUES — tune for the piste. `glide` is the difficulty dial.
export const AI_PERSONALITIES = [
  { name: 'Yeti',    skill: 0.96, laneBias: -1.4, glide: 1.00, edge: 1.0 },
  { name: 'Powder',  skill: 0.80, laneBias: -0.6, glide: 0.92, edge: 1.0 },
  { name: 'Flurry',  skill: 0.72, laneBias:  0.6, glide: 0.88, edge: 1.0 },
  { name: 'Frost',   skill: 0.88, laneBias:  1.4, glide: 0.96, edge: 1.0 },
];
