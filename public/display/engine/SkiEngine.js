// SkiEngine — authoritative ribbon-follow downhill ski simulation. Skiers are
// glued to the slope centerline: each has progress `totalS` (arclength down the
// run), lateral offset `lat`, slope speed `v`, and a carve `heading`. Gravity
// (slope steepness) drives speed; TUCK trades carve authority for speed; ramps
// launch the skier into a separate vertical `air` dimension; trees/rocks wipe
// you out. First to the finish line (s = length) wins.
//
// Contract (mirrors the reference kart engine's seams so the session/loop/AI
// reuse unchanged):
//   new SkiEngine(playerIds, { centerline, length, slopeWidth, ramps, obstacles }, { onEvent })
//   update(dtMs) / processInput(id, {s,t,j}) / getSnapshot() / getResults()
//   removeCar(id) / forfeit(id) / get raceOver
//
// Pure JS — NO `import three`. It only calls clone()/addScaledVector()/
// applyAxisAngle()/cross()/dot() on the vector frames `centerline.sampleAt`
// returns, so it loads identically in the browser and the Node test runner
// (the tests feed a lightweight centerline whose frames implement those ops).

// ---- Speed model (gravity + tuck + edge-scrub) --------------------------
// Target-speed + approach model (same envelope as the reference kart engine,
// which is stable and easy to tune). targetV is set by slope steepness, tuck,
// and how hard you're carving; v eases toward it. All STARTING VALUES — tune in
// playtest (see the test-plan notes in the README).
// `export`ed constants are imported by AiDriver — the bot plans against the
// same physics it drives, so a retune here can never silently strand it.
const VMAX = 20;            // baseline top schuss speed (u/s) for the Racer benchmark
export const SIN_REF = 0.31;       // sin(18°) — the "reference pitch" steepNorm is 1.0 at
export const STEEP_MIN = 0.40;     // speed-cap floor on a near-flat runout (still glides out)
export const STEEP_MAX = 1.85;     // speed-cap ceiling on the steepest pitch (~35° tops out;
                            // the slopes now run steeper, so the ceiling is raised to match → more speed)
const NOTUCK_CAP = 0.78;    // upright, you only reach 78% of the pitch's top speed…
const TUCK_CAP = 1.00;      // …tuck (squat) to unlock the full speed. THE core gain.
const EDGE_SCRUB = 0.42;    // hard carving scrubs up to 42% off the target (sharp turn = slow)
// Approach rates depend on SQUAT (tuck) state — the core "tuck to carry speed,
// stand up to scrub it" feel, separate from the target-speed CEILING above.
// Tucked you're slippery + aero: gravity wins fast (high accel) and you barely
// shed speed (low decel → momentum carries across flats and runouts). Standing
// up trades that away — you build speed lazily and the wind/edges brake you.
// Decel is deliberately gentle so speed reads as momentum, not a snapped ceiling.
// STARTING VALUES — tune in playtest.
const ACCEL_TUCK    = 16.0; // u/s² building speed while squatting (gravity + aero)
const ACCEL_UPRIGHT = 10.0; // u/s² upright — you build speed more lazily
const DECEL_TUCK    = 3.0;  // u/s² tuck glide: barely bleeds speed (carries momentum)
const DECEL_UPRIGHT = 7.0;  // u/s² stand up = the air brake (still gentler than before)
// Past the finish line: the skier stands up and snowplows to a stop on the flat
// run-out (the finish is no wall — see SlopeBuilder FINISH_APRON). A firm-but-tidy
// scrub that fully stops a fast finisher well within the apron.
const FINISH_BRAKE  = 7.0;  // u/s² speed bleed to a standstill after the finish

// ---- Carving (ribbon steering) ------------------------------------------
const TURN_RATE = 1.45;     // rad/s edge rate at full carve for the benchmark (the "edge" stat scales this)
const STEER_EXPO = 1.7;     // small tilt = gentle, full tilt = full lock
const MAX_HEADING = 1.15;   // ~66° clamp — can never point uphill (always some descent)
const STEER_SIGN = -1;      // tilt right → carve right (negated; matches AiDriver pursue)
export const TUCK_TURN_MUL = 0.45; // TUCK halves your carve authority — can't tuck AND turn hard
const AIR_TURN_MUL = 0.55;  // mid-air you can lean/steer, but with reduced authority

// ---- Off-piste (deep snow) ----------------------------------------------
// There are NO walls. Stray past the groomed piste edge and you plough into deep
// powder — but the penalty is GRADED by how far out you are, not a cliff at the
// edge: clipping a corner barely costs you, while a wide line into deep powder
// bogs hard. The speed ceiling and bog-down drag both ramp from nothing at the
// edge to their full values at the ski-patrol reset line. Wander a full
// half-slope-width past the edge and ski patrol resets you back onto the piste
// (snapped just inside the edge, facing down, momentum lost).
const DEEP_SNOW_SPEED = 0.34; // off-piste speed ceiling (frac of top speed) at the DEEPEST point (the reset line)
const DEEP_SNOW_DRAG = 18.0;  // u/s² bog-down bleed at the DEEPEST point (scales up with distance from the edge)
const RESET_SPEED_FRAC = 0.4; // speed kept after a ski-patrol reset
// After a ski-patrol reset the skier blinks and ghosts (passes through everyone,
// no contact, no wipeout) for this long, so a skier popped back onto the piste
// in front of the field can't instantly T-bone someone — it gives everyone time
// to steer clear. See `ghostT` on the skier + the contact/obstacle skips.
const RESET_GHOST_TIME = 2.0; // seconds of post-reset blink + collision immunity

// ---- Wipeout (trees / rocks) --------------------------------------------
// Rising-edge (s,lat) overlap → spin out: steering dies, speed bleeds, tuck is
// forced off, for CRASH_TIME (scaled shorter by the `control` stat).
const CRASH_TIME = 1.1;     // seconds of lost control per wipeout (benchmark)
const SPIN_DRAG = 9.0;      // u/s² speed bleed while wiping out (coasts to a near-stop)
const SPIN_TURNS = 2;       // cosmetic whole turns over CRASH_TIME (multiple of 2π → lands on 0)

// ---- THE collision primitive ---------------------------------------------
// Every contact test in the game — skier/skier, skier/tree, skier/ramp, and the
// renderer's skier/pole — is this ONE comparison: a rounded-rectangle overlap
// in the locally-flat (s, lat) plane. A footprint is a rect core (halfS/halfLat,
// both 0 for round things) padded by `reach` — the skier's body circle plus the
// object's own radius. Contact = the gap to the core is inside `reach`. So the
// rule is always "the skier's circle touches the footprint", never a bare
// centre-point trigger. (Exported: SceneRenderer reuses it for the edge poles.)
export function hitSL(ds, dl, reach, halfS = 0, halfLat = 0) {
  const x = Math.max(0, Math.abs(ds) - halfS);
  const y = Math.max(0, Math.abs(dl) - halfLat);
  return x * x + y * y < reach * reach;
}

// ---- Skier-vs-skier contact ---------------------------------------------
// Skiers are SOFT bumpers, not hazards. Their honest contact capsule (see
// SKI_HALF / DEFAULT_STATS.radius) starts contact where the skis visually
// touch — nose-to-tail included. Overlapping in the (s,lat) plane shoves
// them apart LATERALLY (never along s — that would teleport race progress and
// is exploitable) and a trailing skier can't tunnel through the one directly
// ahead: it tucks in behind (the draft/pack feel). Contact bleeds only a LITTLE
// speed — light enough that a bump costs momentum but never stops your run.
// Only a FAST, side-on hit (a T-bone) actually wipes out — and then BOTH skiers
// on the snow spin out (it's a tangle); a plain rear-end just blocks. Air is a
// separate dimension, so a skier clearing the field overhead passes clean
// through. STARTING VALUES — tune by feel.
const BUMP_PUSH = 0.5;      // share of the lateral overlap each skier is pushed out per frame
const BUMP_EPS = 0.12;      // min lateral split (u) to unstack a dead nose-to-tail jam (ndl≈0)
const BUMP_DAMP = 0.05;     // fraction of the closing speed bled from BOTH skiers on contact (very low → a bump barely costs momentum)
const BUMP_BLOCK_NORMAL = 0.5; // contact must be at least this head-on (|nds|) to draft-block — abreast skiers are NOT speed-locked
const TBONE_LATERAL = 0.5;  // contact normal must be at least this sideways (|ndl|) to count as a T-bone vs a rear-end
const TBONE_CLOSING = 6.0;  // lateral closing speed (u/s) above which a side-on hit wipes BOTH skiers out
                            // (well clear of the ~2u/s of incidental jostle, so light side-by-side contact stays a soft bump)

// ---- Jump / air ---------------------------------------------------------
export const GRAV_AIR = 22.0;      // u/s² pulling you back to the snow while airborne (lower = more hang time for tricks)
const RAMP_POP = 7.5;       // u/s up from hitting a ramp (auto-launch, ∝ speed → ~0.9u apex). NB: "flick up to jump" on the snow was removed — ramps launch you automatically.
const RAMP_HALF_S = 1.5;    // half the down-slope length of a kicker's footprint — half the 3.0-long kicker box SlopeScenery.addRamp draws.
const LAND_CLEAN_ACROSS = 0.42; // |across| under this on touchdown = clean landing (keep speed + boost)
const LAND_BOOST = 1.18;    // clean big-air landing multiplies speed briefly
const LAND_BOOST_MIN_AIR = 1.2; // …only if the jump cleared at least this height
const LAND_SLOPPY_SCRUB = 0.62; // sloppy landing (turned sideways) scrubs speed to 62%
const LAND_WIPE_ACROSS = 0.85;  // landing this sideways = wipeout

// ---- Air tricks (analog flips) ------------------------------------------
// While airborne a flick spins a flip about an ANALOG axis built from the flick
// angle: pitch (up/down) = front/back flip, yaw (left/right) = spin, a diagonal
// blend = a cork. The flick STRENGTH scales the spin rate. The rotation MUST
// complete before touchdown — land mid-flip and you wash out (it reuses the
// wipeout spin-out). A clean landing after ≥1 flip banks a small speed boost;
// only ONE flip runs at a time. STARTING VALUES — tune by feel in the `tricks`
// test scenario (see TestHarness / README).
export const TRICK_DURATION = 0.30;   // s for one full rotation — short enough to chain (airtime/0.30 = max flips, so speed + slope + a timed pop = more flips). Test: a rollover lands a double, a timed lip pop a triple.
export const TRICK_MIN_AIR = 0.55;    // height (u) a flip arms at — keeps tiny hops (apex <0.55) from auto-crashing. Test: a plain roll-over hop must NOT arm a trick.
const TRICK_BOOST = 1.08;      // per-flip landing speed-ceiling boost (compounds, combo-capped). Test: gains from flips must stay well under a missed flip's CRASH_TIME cost.
const TRICK_BOOST_T = 0.9;     // s the trick landing boost lasts (reuses the clean-landing boost machinery)
const TRICK_MAX_COMBO = 3;     // boost compounds over at most this many flips in one air (a monster launch can't run away)

// Default per-skier stats = the benchmark. glide/edge/control are multipliers
// (1 = unchanged); radius is the half-WIDTH of the skier's contact capsule —
// sized to the actual asset (torso 0.24 / ski half-span 0.24, plus slack), so
// contact starts roughly where things visually touch.
const DEFAULT_STATS = { glide: 1, edge: 1, control: 1, radius: 0.3 };

// The skier's footprint is a CAPSULE along the heading (skis are long and
// narrow — a circle either ghosts through ski-tip touches or bumps at a visible
// gap), approximated as three radius-`radius` hitSL circles at these offsets
// along the ski direction. Tip reach = SKI_HALF + radius = 0.75, the rendered
// ski half-length; width stays 2×radius. Exported for the renderer (pole
// contact + the ?hitbox=1 outline).
export const SKI_HALF = 0.45;
const CAP_OFFS = [-SKI_HALF, 0, SKI_HALF];
function normStats(s) {
  const o = { ...DEFAULT_STATS, ...(s || {}) };
  o.glide = Math.max(0.2, o.glide);
  o.edge = Math.max(0.2, o.edge);
  o.control = Math.max(0.2, o.control);
  o.radius = Math.max(0.1, o.radius);
  return o;
}

// Run order: finished skiers first (by finish time), then by distance down the
// slope. Shared by the live ranker and the final results so they can't disagree.
function byRunOrder(a, b) {
  if (a.finished && b.finished) return a.finishTime - b.finishTime;
  if (a.finished) return -1;
  if (b.finished) return 1;
  return b.totalS - a.totalS;
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export class SkiEngine {
  constructor(playerIds, track, callbacks = {}) {
    this.centerline = track.centerline;
    this.length = track.length;
    this.slopeWidth = track.slopeWidth || track.roadWidth || 10;
    this.pisteHalf = this.slopeWidth / 2;                 // groomed-piste edge: deep snow beyond
    this.resetLat = this.pisteHalf + this.slopeWidth * 0.5; // half a slope-width out → ski-patrol reset
    this.onEvent = callbacks.onEvent || (() => {});
    this.elapsed = 0;
    this.finishedOrder = [];
    this.skiers = new Map();

    // Course features, resolved to arclength `s` (the display passes them as a
    // fraction of run length → s; tests pass s directly). Ramps launch you;
    // obstacles wipe you out. Both collide via hitSL: a ramp's footprint is the
    // rendered kicker BOX (3.0 long × `width` wide — SlopeScenery.addRamp
    // draws the same numbers), an obstacle's its radius; you're on either the
    // moment your body circle touches it.
    this.ramps = (track.ramps || []).map((r) => ({
      s: r.s, lat: r.lat || 0, halfS: RAMP_HALF_S, halfW: (r.width || 2.4) / 2
    }));
    this.obstacles = (track.obstacles || []).map((o) => ({
      // the builder supplies per-kind radius (slopes.obstacleRadius); this is only
      // a degenerate fallback for hand-built tracks/tests.
      s: o.s, lat: o.lat || 0, radius: o.radius || 0.8, kind: o.kind || 'tree'
    }));

    // Start line: spread the field evenly across the groomed piste in DISTINCT
    // lanes, symmetric about the centerline, all on ONE line just behind the gate
    // so everyone starts level and crosses s=0 together. The outermost lane sits
    // at 60% of the half-width — well separated, but clear of the deep snow.
    // (A single negative totalS clamps to the s=0 frame for the pose, so a depth
    // stagger would collapse skiers onto the same top frame — the LATERAL spread
    // is what keeps the grid visibly distinct.)
    const N = playerIds.length;
    const laneSpread = this.pisteHalf * 0.6;
    playerIds.forEach((desc, i) => {
      const id = (desc && typeof desc === 'object') ? desc.id : desc;
      const st = normStats(desc && typeof desc === 'object' ? desc.stats : null);
      const lane = N > 1 ? ((i / (N - 1)) * 2 - 1) * laneSpread : 0;
      this.skiers.set(id, {
        id,
        totalS: -1.0,
        lat: lane,
        v: 0,
        heading: 0,
        carve: 0,        // input s (carve, or air-lean while airborne)
        tuck: 1,         // input t (0|1). DEFAULT 1 = tucked/fast; the phone sends 0 only while braking.
        jumpSeq: 0,      // last-seen j. Starts at the controllers' IDLE value (0) so the
                         // first idle frame isn't read as a jump edge (-1 → a phantom start hop).
        wantJump: false, // a fresh release/hop edge queued for this frame
        airborne: false,
        air: 0,          // height above the slope surface (world units)
        vAir: 0,         // vertical velocity while airborne
        airPeak: 0,      // max height reached this jump (for clean-landing boost)
        landScrubT: 0,   // brief speed-scrub timer after a sloppy landing
        // air tricks (analog flips): one rotation at a time, must finish before landing
        trickActive: false, // is a rotation in progress
        trickAngle: 0,   // flick angle (rad, up=+π/2): pitch = flip, yaw = spin, blend = cork
        trickPhase: 0,   // 0..1 progress of the current rotation
        trickRate: 0,    // 1/duration (scaled by flick strength) — trickPhase advances by trickRate*dt
        trickCount: 0,   // flips completed THIS air (combo → compounding boost, capped)
        trickSeq: 0,     // last-seen f.n — also starts at the idle value (0), same reason as jumpSeq
        wantTrick: null, // a fresh analog air-trick command this frame ({ a, m })
        spin: 0,         // cosmetic wipeout angle (rad)
        spinT: 0,        // seconds of lost control left (0 = in control)
        ghostT: 0,       // seconds of post-reset blink + collision immunity left (0 = solid)
        spinDur: CRASH_TIME, // total duration of the current spin (so it lands on a whole turn)
        boostT: 0,       // seconds left on a clean-landing speed boost
        boostMul: 1,     // current speed-ceiling multiplier from a landing boost
        rampIn: new Set(),
        obsIn: new Set(),
        contactIn: new Set(), // ids of skiers overlapped LAST frame (rising-edge `bump` events)
        offPiste: false,
        finished: false,
        finishTime: null,
        dnf: false,      // forfeited (dropped player, seat gone) — parked, but stays in the field/results
        rank: i + 1,
        pose: null,
        // resolved per-skier handling
        vmax: VMAX * st.glide,
        turn: TURN_RATE * st.edge,
        control: st.control,
        radius: st.radius
      });
    });
    this._recomputePoses();
    this._rank();
  }

  processInput(id, msg) {
    const c = this.skiers.get(id);
    if (!c) return;
    // Validate FINITENESS, not just type — `typeof NaN === 'number'`, and one
    // bad packet (NaN/Infinity) would propagate through every later arithmetic
    // op and permanently corrupt the skier. The phone is an untrusted boundary.
    // Past the finish the run is decided: the phone can still STEER a little as
    // the skier coasts to a stop on the run-out, but tuck/jump/tricks are locked
    // out (no speeding up, no air) — "steer a bit, nothing more".
    if (c.dnf) return; // forfeited seat — nobody drives this skier anymore
    if (c.finished) { if (Number.isFinite(msg.s)) c.carve = clamp(msg.s, -1, 1); return; }
    if (Number.isFinite(msg.s)) c.carve = clamp(msg.s, -1, 1);
    if (typeof msg.t === 'number') c.tuck = msg.t > 0.5 ? 1 : 0;
    else if (typeof msg.t === 'boolean') c.tuck = msg.t ? 1 : 0;
    // Jump edge: a wrapping counter (rides the latest-wins fastlane — a dropped
    // frame just re-delivers the same value). Fire once per fresh value. On the
    // snow it does nothing (ramps auto-launch); airborne it spins a BACK flip
    // (resolved in update()).
    if (Number.isFinite(msg.j) && msg.j !== c.jumpSeq) { c.jumpSeq = msg.j; c.wantJump = true; }
    // Trick flick: a wrapping {n,a,m} edge (same latest-wins dedup), AIR-ONLY and
    // ANALOG — a = flick angle (rad, up=+π/2): up→back, down→front, sides→spin,
    // diagonals→cork; m = flick strength 0..1 → spin rate. (An up-flick also bumps
    // j, but j is air-only here — a back-flip fallback; the snow ignores it.)
    if (msg.f && Number.isFinite(msg.f.n) && msg.f.n !== c.trickSeq) {
      c.trickSeq = msg.f.n;
      if (Number.isFinite(msg.f.a)) {
        c.wantTrick = { a: msg.f.a, m: Number.isFinite(msg.f.m) ? clamp(msg.f.m, 0, 1) : 0.5 };
      }
    }
  }

  removeCar(id) {
    if (!this.skiers.has(id)) return false;
    this.skiers.delete(id);
    const i = this.finishedOrder.indexOf(id);
    if (i >= 0) this.finishedOrder.splice(i, 1);
    this._rank();
    return true;
  }

  // Forfeit a skier whose player isn't coming back: mark it DNF so the run can
  // end without it, but KEEP it in the field — it stays in getSnapshot/getResults
  // (a DNF row, not a vanished player) and its split-screen cell survives. The
  // skier brakes to a stop like a finisher and is locked out of input, the finish
  // line, obstacles/ramps and skier contacts. No-op for a finished skier — a
  // crossed line is an earned result, never rewritten. May tip raceOver, so the
  // race_over event fires here exactly like it does on a final finish crossing.
  forfeit(id) {
    const c = this.skiers.get(id);
    if (!c || c.finished || c.dnf) return false;
    c.dnf = true;
    c.tuck = 0;
    c.wantJump = false;
    c.wantTrick = null;
    if (this.raceOver) this.onEvent({ type: 'race_over' });
    return true;
  }

  // Re-key a live skier from one id to another — a dropped player reconnects on a
  // DIFFERENT device (new peerIndex) but their skier keeps descending. Preserves
  // all skier state; updates the map key, the skier's own id and its place in the
  // finish order so nothing dangles on the old id. No-op (false) if the source
  // skier is gone or the target id is already taken.
  rekeyCar(oldId, newId) {
    if (oldId === newId) return false;
    const c = this.skiers.get(oldId);
    if (!c || this.skiers.has(newId)) return false;
    this.skiers.delete(oldId);
    c.id = newId;
    this.skiers.set(newId, c);
    for (let i = 0; i < this.finishedOrder.length; i++) {
      if (this.finishedOrder[i] === oldId) this.finishedOrder[i] = newId;
    }
    return true;
  }

  update(dtMs) {
    const dt = Math.min(dtMs / 1000, 0.05);
    if (dt <= 0) return;
    this.elapsed += dt;

    for (const c of this.skiers.values()) {
      // off-piste = past the groomed edge → deep snow slows you (no walls)
      c.offPiste = Math.abs(c.lat) > this.pisteHalf;

      // Past the finish the run is decided: stand up (no tuck) and scrub to a stop
      // on the flat run-out (the brake lives in the longitudinal block below). The
      // phone can still steer a little, but with nothing else to do, let the carve
      // relax toward straight so a finished skier — a bot, or a hands-off phone —
      // coasts straight to a halt instead of drifting off on a stale input.
      if (c.finished || c.dnf) { c.tuck = 0; c.carve *= Math.max(0, 1 - 6 * dt); }

      // --- WIPEOUT TICK (tree/rock spin-out) -------------------------------
      let spinning = c.spinT > 0;
      if (spinning) {
        c.spinT -= dt;
        // rate keyed to THIS spin's duration so the cosmetic angle lands exactly
        // on SPIN_TURNS whole turns (= 0 mod 2π) regardless of the control stat.
        c.spin += (SPIN_TURNS * 2 * Math.PI / c.spinDur) * dt;
        if (c.spinT <= 0) { c.spinT = 0; c.spin = 0; spinning = false; }
      }
      // Obstacles only bite on the snow (you can fly over a tree). Rising-edge.
      // A ghosting (just-reset) skier passes clean through them too.
      if (!c.finished && !c.dnf && !c.airborne && c.ghostT <= 0) {
        if (this._enterObstacle(c) && !spinning) {
          c.spinT = c.spinDur = CRASH_TIME / c.control;   // better control = quicker recovery
          c.spin = 0; spinning = true;
          c.tuck = 0;
          c.boostT = 0; c.boostMul = 1;
          this.onEvent({ type: 'crash', id: c.id });
        }
      }

      // --- AIR / TRICKS ----------------------------------------------------
      // TUCK is purely a speed mode. Air comes from RAMPS (auto-launch, ∝ speed):
      // "flick up to jump" on the snow was removed. An up-flick in the AIR still
      // back-flips, so resolve an up-flick edge that arrives mid-air into a trick.
      let trickCmd = null; // { a, m } | null
      if (!spinning && !c.finished && c.airborne) {
        if (c.wantTrick) trickCmd = c.wantTrick;
        // A bare up-flick (j only, no analog f — keyboard/bot/legacy) = a back flip.
        else if (c.wantJump) trickCmd = { a: Math.PI / 2, m: 0.6 };
      }
      c.wantTrick = null; // air-only intent; never lingers onto the snow

      let launch = 0;
      // Up-flicks no longer pop a jump on the snow (feature removed); just clear the
      // edge so it can't linger (the in-air back-flip is resolved above).
      c.wantJump = false;
      // Ramps auto-launch anyone crossing them on the snow — you always catch air
      // off a kicker (∝ speed), no input needed.
      if (!c.finished && !c.dnf && !c.airborne && !spinning && this._enterRamp(c)) {
        launch += RAMP_POP * (0.45 + 0.55 * (c.v / c.vmax));
      }
      if (launch > 0) {
        c.airborne = true;
        c.vAir = launch;
        c.air = 0.0001;
        c.airPeak = 0;
        c.trickActive = false; c.trickAngle = 0; c.trickPhase = 0; c.trickCount = 0; // fresh air → fresh combo
        this.onEvent({ type: 'jump', id: c.id, power: launch });
      }
      // Integrate the ballistic arc + run any flip in progress.
      if (c.airborne) {
        c.air += c.vAir * dt;
        c.vAir -= GRAV_AIR * dt;
        if (c.air > c.airPeak) c.airPeak = c.air;

        // Start a flip: commanded, high enough to arm, and none already spinning.
        // The flick STRENGTH scales the spin rate (a harder throw spins faster, so
        // more rotation fits the same airtime — but is tighter to land clean).
        if (trickCmd && !c.trickActive && c.air >= TRICK_MIN_AIR) {
          c.trickActive = true;
          c.trickAngle = trickCmd.a;
          c.trickPhase = 0;
          c.trickRate = (1 / TRICK_DURATION) * (0.8 + 0.4 * clamp(trickCmd.m, 0, 1));
          this.onEvent({ type: 'trick_start', id: c.id, angle: c.trickAngle });
        }
        // Advance the rotation; a completed flip banks toward the combo and frees
        // the next flick (chainable in big air).
        if (c.trickActive) {
          c.trickPhase += c.trickRate * dt;
          if (c.trickPhase >= 1) {
            c.trickPhase = 0; c.trickActive = false;
            c.trickCount = Math.min(TRICK_MAX_COMBO, c.trickCount + 1);
            this.onEvent({ type: 'trick_done', id: c.id, count: c.trickCount });
          }
        }

        if (c.air <= 0) {
          // TOUCHDOWN — caught mid-rotation = wash out; otherwise judge by how
          // sideways the skis point, and reward a clean landing after a flip.
          c.air = 0; c.airborne = false; c.vAir = 0;
          const across = Math.abs(Math.sin(c.heading));
          if (c.trickActive) {
            c.trickActive = false; c.trickPhase = 0; c.trickCount = 0;
            c.spinT = c.spinDur = CRASH_TIME / c.control; c.spin = 0; spinning = true; c.tuck = 0;
            this.onEvent({ type: 'crash', id: c.id, trick: true });
          } else if (across > LAND_WIPE_ACROSS) {
            c.trickCount = 0;
            c.spinT = c.spinDur = CRASH_TIME / c.control; c.spin = 0; spinning = true; c.tuck = 0;
            this.onEvent({ type: 'crash', id: c.id });
          } else if (across > LAND_CLEAN_ACROSS) {
            c.trickCount = 0;
            c.landScrubT = 0.4; // wobble: brief speed scrub
            this.onEvent({ type: 'land', id: c.id, clean: false, air: c.airPeak });
          } else if (c.trickCount > 0) {
            // clean landing AND ≥1 completed flip → compounding trick boost
            // (replaces the plain clean-air boost so a flip jump can't double-dip).
            c.boostMul = Math.pow(TRICK_BOOST, Math.min(c.trickCount, TRICK_MAX_COMBO));
            c.boostT = TRICK_BOOST_T;
            const tricks = c.trickCount; c.trickCount = 0;
            this.onEvent({ type: 'land', id: c.id, clean: true, air: c.airPeak, tricks });
          } else {
            if (c.airPeak >= LAND_BOOST_MIN_AIR) { c.boostMul = LAND_BOOST; c.boostT = 0.9; }
            this.onEvent({ type: 'land', id: c.id, clean: true, air: c.airPeak });
          }
        }
      }

      // --- LONGITUDINAL (gravity + tuck + edge-scrub) ----------------------
      if (c.boostT > 0) { c.boostT -= dt; if (c.boostT <= 0) { c.boostT = 0; c.boostMul = 1; } }
      if (c.landScrubT > 0) c.landScrubT -= dt;
      if (c.ghostT > 0) { c.ghostT -= dt; if (c.ghostT < 0) c.ghostT = 0; }
      // steepness of the slope under the skier (tangent points down-slope → y<0)
      const frame = this.centerline.sampleAt(Math.max(0, c.totalS));
      const sinSlope = Math.max(0, -frame.tangent.y);
      const steepNorm = clamp(sinSlope / SIN_REF, STEEP_MIN, STEEP_MAX);
      const across = Math.abs(Math.sin(c.heading));
      if (spinning) {
        c.v = Math.max(0, c.v - SPIN_DRAG * dt);
      } else if (c.airborne) {
        // No snow contact: hold speed (a hair of air drag).
        c.v = Math.max(0, c.v - 0.4 * dt);
      } else if (c.finished || c.dnf) {
        // Flat run-out past the line: stand up and scrub to a standstill. Brake at
        // FINISH_BRAKE normally, but firm up if a fast finisher would otherwise run
        // out of apron — so we ALWAYS halt before the centerline clamps (the whole
        // point: the finish is no wall, and neither is the apron's end).
        const room = this.centerline.length - c.totalS - 1.0; // aim to stop ~1u short of the clamp
        const need = room > 0.1 ? (c.v * c.v) / (2 * room) : Infinity;
        const brake = Math.min(40, Math.max(FINISH_BRAKE, need));
        c.v = Math.max(0, c.v - brake * dt);
      } else {
        const tuckMul = c.tuck ? TUCK_CAP : NOTUCK_CAP;
        const edgeMul = 1 - EDGE_SCRUB * across;
        const scrub = c.landScrubT > 0 ? LAND_SLOPPY_SCRUB : 1;
        let targetV = c.vmax * c.boostMul * steepNorm * tuckMul * edgeMul * scrub;
        // Squat state sets HOW FAST you approach the target, not just the ceiling.
        let accel = c.tuck ? ACCEL_TUCK : ACCEL_UPRIGHT;
        let decel = c.tuck ? DECEL_TUCK : DECEL_UPRIGHT;
        // Deep snow off-piste: a GRADED bog-down. The penalty scales with how far
        // past the groomed edge you are — 0 at the edge, full at the ski-patrol
        // reset line — so clipping a corner barely costs you while a wide line into
        // deep powder caps your speed hard (tuck can't save you out there).
        if (c.offPiste) {
          const depth = clamp((Math.abs(c.lat) - this.pisteHalf) / (this.resetLat - this.pisteHalf), 0, 1);
          targetV = Math.min(targetV, c.vmax * (1 - (1 - DEEP_SNOW_SPEED) * depth));
          decel = Math.max(decel, DEEP_SNOW_DRAG * depth);
        }
        // Accel still scales with steepness (gravity pulls harder on a steep pitch).
        if (c.v < targetV) c.v = Math.min(targetV, c.v + accel * (0.4 + 0.6 * steepNorm) * dt);
        else c.v = Math.max(targetV, c.v - decel * dt);
      }

      // --- CARVING (ribbon steering) ---------------------------------------
      // Heading = your edge angle relative to the fall line. Neutral input holds
      // a straight WORLD line (we subtract the slope's own turn), so you must
      // actively carve through the bends. TUCK and AIR cut your authority.
      const turnMul = spinning ? 0 : (c.airborne ? AIR_TURN_MUL : (c.tuck ? TUCK_TURN_MUL : 1));
      const authority = 0.45 + 0.55 * Math.min(1, c.v / (c.vmax * 0.5));
      const steerIn = Math.sign(c.carve) * Math.pow(Math.abs(c.carve), STEER_EXPO);
      c.heading += STEER_SIGN * steerIn * c.turn * turnMul * authority * dt;

      const before = frame; // same s as the slope sample above — totalS hasn't moved yet
      const along = Math.cos(c.heading), acrossSign = Math.sin(c.heading);
      const prevTotal = c.totalS;
      c.totalS += c.v * Math.max(0.1, along) * dt; // always some forward progress
      c.lat -= c.v * acrossSign * dt;              // move the way you point

      // Subtract the slope's own turn so NEUTRAL holds a world heading, then
      // clamp so the skier can never point uphill.
      const after = this.centerline.sampleAt(Math.max(0, c.totalS));
      const dTheta = Math.atan2(
        before.tangent.clone().cross(after.tangent).dot(after.up),
        before.tangent.dot(after.tangent)
      );
      c.heading -= dTheta;
      if (c.heading > MAX_HEADING) c.heading = MAX_HEADING;
      else if (c.heading < -MAX_HEADING) c.heading = -MAX_HEADING;

      // No walls. Deep snow (the speed model above) already punishes a wide line;
      // stray a full half-slope-width past the edge and ski patrol resets you onto
      // the piste — snapped just inside the groomed edge, facing down, momentum lost.
      c.offPiste = Math.abs(c.lat) > this.pisteHalf;
      if (Math.abs(c.lat) > this.resetLat) {
        c.lat = Math.sign(c.lat) * this.pisteHalf * 0.8;
        c.heading = 0;
        c.v *= RESET_SPEED_FRAC;
        c.offPiste = false;
        c.ghostT = RESET_GHOST_TIME; // blink + pass through everyone while the field steers clear
        this.onEvent({ type: 'reset', id: c.id });
      }

      // --- FINISH (single line crossing at s = length) ---------------------
      if (!c.finished && !c.dnf && prevTotal < this.length && c.totalS >= this.length) {
        c.finished = true;
        c.finishTime = this.elapsed;
        c.tuck = 0;
        // settle out of any jump/flip so the post-finish coast can't crash-land or
        // emit spurious land/crash events for a skier whose run is decided.
        c.airborne = false; c.air = 0; c.vAir = 0;
        c.trickActive = false; c.trickAngle = 0; c.trickPhase = 0; c.trickCount = 0;
        this.finishedOrder.push(c.id);
        this.onEvent({ type: 'finish', id: c.id, rank: this.finishedOrder.length, time: c.finishTime });
        if (this.raceOver) this.onEvent({ type: 'race_over' });
      }
    }

    this._resolveContacts();
    this._recomputePoses();
    this._rank();
  }

  // Skier-vs-skier soft contact: one relaxation pass over all pairs (N is tiny,
  // so O(N²) is free), run AFTER every skier has integrated this frame so it acts
  // on settled positions. Pushes overlapping skiers apart laterally, drafts a
  // trailing skier behind the one directly ahead, bleeds a little speed, and spins
  // BOTH skiers out on a fast side-on hit (T-bone). Never moves anyone along s. See
  // the contact constants above.
  _resolveContacts() {
    const arr = [...this.skiers.values()];
    // Build this frame's contact sets fresh; `bump` events fire on the rising
    // edge (first frame of an overlap) so persistent contact can't spam audio.
    const next = new Map(arr.map((c) => [c.id, new Set()]));
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (a.finished || a.dnf || a.ghostT > 0) continue; // finished/parked/just-reset (ghosting) skiers don't jostle
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        if (b.finished || b.dnf || b.ghostT > 0) continue; // …and nobody collides with a ghosting skier
        const rr = a.radius + b.radius; // same capsules as every other contact
        if (Math.abs(a.air - b.air) > rr) continue;   // one is flying clean over the other
        // Capsule vs capsule: the closest pair among each skier's sample
        // circles. Its offset is the contact normal; the centre ds still
        // decides who leads for the draft block below.
        const ahs = Math.cos(a.heading), ahl = -Math.sin(a.heading);
        const bhs = Math.cos(b.heading), bhl = -Math.sin(b.heading);
        let ds = 0, dl = 0, d2 = Infinity;
        for (const ea of CAP_OFFS) {
          for (const eb of CAP_OFFS) {
            const ts = (a.totalS + ea * ahs) - (b.totalS + eb * bhs);
            const tl = (a.lat + ea * ahl) - (b.lat + eb * bhl);
            const t2 = ts * ts + tl * tl;
            if (t2 < d2) { d2 = t2; ds = ts; dl = tl; }
          }
        }
        if (!hitSL(ds, dl, rr)) continue;             // no overlap
        const dist = Math.sqrt(d2) || 1e-4;
        const nds = ds / dist, ndl = dl / dist;       // contact normal, pointing b → a
        const pen = rr - dist;
        next.get(a.id).add(b.id); next.get(b.id).add(a.id);

        // (s,lat) velocities — the same decomposition update() integrates with.
        const aSV = a.v * Math.cos(a.heading), aLatV = -a.v * Math.sin(a.heading);
        const bSV = b.v * Math.cos(b.heading), bLatV = -b.v * Math.sin(b.heading);

        // --- LATERAL separation (never touch s) ----------------------------
        // Split the overlap's lateral share between the pair. If they're nearly
        // dead-stacked in one lane (ndl≈0) the lateral push vanishes, so add a
        // fixed nudge to unstack them — they ease apart over the next few frames.
        let dLat = BUMP_PUSH * pen * ndl;
        if (Math.abs(ndl) < 0.2) dLat += BUMP_EPS * (String(a.id) < String(b.id) ? 1 : -1); // string-compare → stable for numeric or 'me'-style ids
        a.lat += dLat; b.lat -= dLat;

        // --- LONGITUDINAL draft block (rear-ends only) ---------------------
        // A trailing skier can't pass THROUGH the one directly ahead: clamp its
        // speed to the leader's so it tucks in behind. ONLY when the contact is more
        // along-slope than sideways (|nds| ≥ BUMP_BLOCK_NORMAL, i.e. within ~60° of
        // straight-behind) — abreast skiers must not be speed-locked, which is
        // exactly what knots two of them together riding side by side.
        if (Math.abs(nds) >= BUMP_BLOCK_NORMAL) {
          if (a.totalS > b.totalS) { if (b.v > a.v) b.v = a.v; } // a leads, b trails
          else { if (a.v > b.v) a.v = b.v; }                     // b leads, a trails
        }

        // --- SPEED scrub on contact ----------------------------------------
        // Bleed a small share of the closing speed from both — light enough that a
        // bump costs a little momentum but never stops you dead.
        const closing = Math.max(0, (bSV - aSV) * nds + (bLatV - aLatV) * ndl);
        const scrub = BUMP_DAMP * closing;
        a.v = Math.max(0, a.v - scrub);
        b.v = Math.max(0, b.v - scrub);

        // --- T-BONE wipeout -------------------------------------------------
        // A fast, side-on hit is a tangle: BOTH skiers spin out (only those on the
        // snow — you can't wipe out someone clearing you in the air). A rear-end
        // (mostly-longitudinal normal) just blocks/drafts, no crash.
        const aInto = -Math.sign(dl || 1) * aLatV;    // a's lateral speed toward b (>0 = closing)
        const bInto = Math.sign(dl || 1) * bLatV;     // b's lateral speed toward a
        const latClose = Math.max(0, aInto) + Math.max(0, bInto);
        if (Math.abs(ndl) >= TBONE_LATERAL && latClose >= TBONE_CLOSING) {
          // Spin out every grounded skier in the tangle FIRST, then announce — so
          // each crash event reflects the final state (both already down).
          const downed = [];
          for (const c of [a, b]) {
            if (!c.airborne && c.spinT <= 0) {
              c.spinT = c.spinDur = CRASH_TIME / c.control;
              c.spin = 0; c.tuck = 0;
              c.boostT = 0; c.boostMul = 1;
              downed.push(c);
            }
          }
          for (const c of downed) this.onEvent({ type: 'crash', id: c.id, tbone: true, with: (c === a ? b : a).id });
        } else if (!a.contactIn.has(b.id)) {
          this.onEvent({ type: 'bump', a: a.id, b: b.id, force: closing });
        }
      }
    }
    for (const c of arr) c.contactIn = next.get(c.id);
  }

  // Rising-edge overlap of a ramp (open run → no lap wrap on ds). Skier capsule
  // vs the kicker box — ski tips touching the lip count, same as everywhere.
  _enterRamp(c) {
    if (!this.ramps.length) return false;
    const hs = Math.cos(c.heading), hl = -Math.sin(c.heading);
    let entered = false;
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      let inside = false;
      for (const e of CAP_OFFS) {
        if (hitSL(c.totalS + e * hs - r.s, c.lat + e * hl - r.lat, c.radius, r.halfS, r.halfW)) { inside = true; break; }
      }
      if (inside) { if (!c.rampIn.has(i)) { c.rampIn.add(i); entered = true; } }
      else c.rampIn.delete(i);
    }
    return entered;
  }

  // Rising-edge overlap of a tree/rock (skier capsule vs obstacle circle).
  _enterObstacle(c) {
    if (!this.obstacles.length) return false;
    const hs = Math.cos(c.heading), hl = -Math.sin(c.heading); // ski direction in (s, lat)
    let entered = false;
    for (let i = 0; i < this.obstacles.length; i++) {
      const o = this.obstacles[i];
      let inside = false;
      for (const e of CAP_OFFS) {
        if (hitSL(c.totalS + e * hs - o.s, c.lat + e * hl - o.lat, c.radius + o.radius)) { inside = true; break; }
      }
      if (inside) { if (!c.obsIn.has(i)) { c.obsIn.add(i); entered = true; } }
      else c.obsIn.delete(i);
    }
    return entered;
  }

  _recomputePoses() {
    for (const c of this.skiers.values()) {
      const f = this.centerline.sampleAt(Math.max(0, c.totalS));
      // pos = centerline + lateral offset + air height (along the slope normal).
      c.pose = {
        pos: f.pos.clone().addScaledVector(f.lateral, c.lat).addScaledVector(f.up, c.air),
        forward: f.tangent.clone().applyAxisAngle(f.up, c.heading), // face the carve heading
        up: f.up
      };
    }
  }

  _rank() {
    const arr = [...this.skiers.values()].sort(byRunOrder);
    arr.forEach((c, i) => { c.rank = i + 1; });
  }

  getSnapshot() {
    const skiers = [];
    for (const c of this.skiers.values()) {
      skiers.push({
        id: c.id, pose: c.pose, lat: c.lat, totalS: c.totalS, v: c.v, radius: c.radius, heading: c.heading,
        spd: c.v / c.vmax,                 // normalized 0..~1.5
        progress: clamp(c.totalS / this.length, 0, 1),
        position: c.rank, of: this.skiers.size,
        finished: c.finished, finishTime: c.finishTime, dnf: c.dnf,
        // carve is TURN-ALIGNED (sign matches the actual turn so the renderer
        // leans the body the right way without knowing STEER_SIGN); carveInput
        // is the raw phone input (drives the on-screen carve bar).
        carve: STEER_SIGN * c.carve, carveInput: c.carve,
        tuck: c.tuck,
        airborne: c.airborne, air: c.air,
        // Launch pitch (rad): nose-up to match the takeoff off the lip — the angle
        // the RISING velocity makes above the slope plane, atan2(vertical, horizontal).
        // Tapers to 0 by the apex (vAir→0) and stays 0 on the way down: we pitch the
        // model UP off the ramp (so a kicker launches you instead of elevating you
        // flat) but DON'T nose it down into the landing — the fix is the on-ramp lift
        // only. The renderer follows this; the chase cam ignores it. Floor the
        // horizontal term so a near-vertical pop can't read as a 90° backflip.
        airPitch: c.airborne && c.vAir > 0 ? Math.atan2(c.vAir, Math.max(8, c.v)) : 0,
        // current flip (for the renderer's somersault + the HUD tag)
        trickActive: c.trickActive, trickAngle: c.trickAngle, trickPhase: c.trickPhase,
        spin: c.spin, crashed: c.spinT > 0, offPiste: !!c.offPiste,
        ghostT: c.ghostT, ghosting: c.ghostT > 0, // post-reset blink + collision immunity (renderer blinks the skier)
        boostActive: c.boostT > 0
      });
    }
    return { skiers, elapsed: this.elapsed };
  }

  getResults() {
    const ranked = [...this.skiers.values()].sort(byRunOrder);
    return {
      elapsed: this.elapsed,
      results: ranked.map((c, i) => ({
        playerId: c.id, rank: i + 1, finished: c.finished, time: c.finishTime, dnf: c.dnf
      }))
    };
  }

  // Over when nobody is still racing — DNF skiers don't hold the run open.
  get raceOver() {
    for (const c of this.skiers.values()) if (!c.finished && !c.dnf) return false;
    return true;
  }
}
