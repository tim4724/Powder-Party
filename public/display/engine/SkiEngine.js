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
//   removeCar(id) / get raceOver
//
// Pure JS — NO `import three`. It only calls clone()/addScaledVector()/
// applyAxisAngle()/cross()/dot() on the vector frames `centerline.sampleAt`
// returns, so it loads identically in the browser and the Node test runner
// (the tests feed a lightweight centerline whose frames implement those ops).

import { pursue } from '../AiDriver.js';

// ---- Speed model (gravity + tuck + edge-scrub) --------------------------
// Target-speed + approach model (same envelope as the reference kart engine,
// which is stable and easy to tune). targetV is set by slope steepness, tuck,
// and how hard you're carving; v eases toward it. All STARTING VALUES — tune in
// playtest (see the test-plan notes in the README).
const VMAX = 20;            // baseline top schuss speed (u/s) for the Racer benchmark
const SIN_REF = 0.31;       // sin(18°) — the "reference pitch" steepNorm is 1.0 at
const STEEP_MIN = 0.40;     // speed-cap floor on a near-flat runout (still glides out)
const STEEP_MAX = 1.55;     // speed-cap ceiling on the steepest pitch
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

// ---- Carving (ribbon steering) ------------------------------------------
const TURN_RATE = 1.45;     // rad/s edge rate at full carve for the benchmark (the "edge" stat scales this)
const STEER_EXPO = 1.7;     // small tilt = gentle, full tilt = full lock
const MAX_HEADING = 1.15;   // ~66° clamp — can never point uphill (always some descent)
const STEER_SIGN = -1;      // tilt right → carve right (negated; matches AiDriver pursue)
const TUCK_TURN_MUL = 0.45; // TUCK halves your carve authority — can't tuck AND turn hard
const AIR_TURN_MUL = 0.55;  // mid-air you can lean/steer, but with reduced authority

// ---- Off-piste (deep snow) ----------------------------------------------
// There are NO walls. Stray past the groomed piste edge and you plough into deep
// powder: top speed collapses and you bog down fast (a real penalty for a wide
// line). Wander a full half-slope-width past the edge and ski patrol resets you
// back onto the piste (snapped just inside the edge, facing down, momentum lost).
const DEEP_SNOW_SPEED = 0.34; // off-piste speed ceiling as a fraction of your top speed
const DEEP_SNOW_DRAG = 18.0;  // u/s² bleed when over the deep-snow ceiling (you bog down)
const RESET_SPEED_FRAC = 0.4; // speed kept after a ski-patrol reset

// ---- Wipeout (trees / rocks) --------------------------------------------
// Rising-edge (s,lat) overlap → spin out: steering dies, speed bleeds, tuck is
// forced off, for CRASH_TIME (scaled shorter by the `control` stat).
const CRASH_TIME = 1.1;     // seconds of lost control per wipeout (benchmark)
const SPIN_DRAG = 9.0;      // u/s² speed bleed while wiping out (coasts to a near-stop)
const SPIN_TURNS = 2;       // cosmetic whole turns over CRASH_TIME (multiple of 2π → lands on 0)

// ---- Jump / air ---------------------------------------------------------
const GRAV_AIR = 30.0;      // u/s² pulling you back to the snow while airborne
const POP_BASE = 4.0;       // u/s upward from a swipe-up / tuck-release hop on open snow (clears a tree)
const RAMP_POP = 7.5;       // u/s up from hitting a ramp at full speed (auto-launch, ∝ speed → ~0.9u apex)
const RAMP_JUMP_BONUS = 4.5; // extra pop for firing a jump AT the ramp lip — the timing reward
const RAMP_LIP_REACH = 1.2; // small anticipation reach BEFORE a ramp's leading edge still counts as a lip pop (units)
const LAND_CLEAN_ACROSS = 0.42; // |across| under this on touchdown = clean landing (keep speed + boost)
const LAND_BOOST = 1.18;    // clean big-air landing multiplies speed briefly
const LAND_BOOST_MIN_AIR = 1.2; // …only if the jump cleared at least this height
const LAND_SLOPPY_SCRUB = 0.62; // sloppy landing (turned sideways) scrubs speed to 62%
const LAND_WIPE_ACROSS = 0.85;  // landing this sideways = wipeout

// Default per-skier stats = the benchmark. glide/edge/control are multipliers
// (1 = unchanged); radius is the obstacle-overlap footprint (world units).
const DEFAULT_STATS = { glide: 1, edge: 1, control: 1, radius: 0.55 };
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
    // obstacles wipe you out. Both are circles in the (s, lat) plane.
    this.ramps = (track.ramps || []).map((r) => ({
      s: r.s, lat: r.lat || 0, radius: r.radius || 1.4, width: r.width || 2.2
    }));
    this.obstacles = (track.obstacles || []).map((o) => ({
      s: o.s, lat: o.lat || 0, radius: o.radius || 0.7, kind: o.kind || 'tree'
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
        tuck: 0,         // input t (0|1)
        jumpSeq: -1,     // last-seen j (dedup the wrapping counter)
        wantJump: false, // a fresh release/hop edge queued for this frame
        airborne: false,
        air: 0,          // height above the slope surface (world units)
        vAir: 0,         // vertical velocity while airborne
        airPeak: 0,      // max height reached this jump (for clean-landing boost)
        landScrubT: 0,   // brief speed-scrub timer after a sloppy landing
        spin: 0,         // cosmetic wipeout angle (rad)
        spinT: 0,        // seconds of lost control left (0 = in control)
        spinDur: CRASH_TIME, // total duration of the current spin (so it lands on a whole turn)
        boostT: 0,       // seconds left on a clean-landing speed boost
        boostMul: 1,     // current speed-ceiling multiplier from a landing boost
        rampIn: new Set(),
        obsIn: new Set(),
        offPiste: false,
        finished: false,
        finishTime: null,
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
    if (!c || c.finished) return;
    // Validate FINITENESS, not just type — `typeof NaN === 'number'`, and one
    // bad packet (NaN/Infinity) would propagate through every later arithmetic
    // op and permanently corrupt the skier. The phone is an untrusted boundary.
    if (Number.isFinite(msg.s)) c.carve = clamp(msg.s, -1, 1);
    if (typeof msg.t === 'number') c.tuck = msg.t > 0.5 ? 1 : 0;
    else if (typeof msg.t === 'boolean') c.tuck = msg.t ? 1 : 0;
    // Jump: a wrapping counter (rides the latest-wins fastlane — a dropped frame
    // just re-delivers the same value). Fire once per fresh value.
    if (Number.isFinite(msg.j) && msg.j !== c.jumpSeq) { c.jumpSeq = msg.j; c.wantJump = true; }
  }

  removeCar(id) {
    if (!this.skiers.has(id)) return false;
    this.skiers.delete(id);
    const i = this.finishedOrder.indexOf(id);
    if (i >= 0) this.finishedOrder.splice(i, 1);
    this._rank();
    return true;
  }

  update(dtMs) {
    const dt = Math.min(dtMs / 1000, 0.05);
    if (dt <= 0) return;
    this.elapsed += dt;

    for (const c of this.skiers.values()) {
      // off-piste = past the groomed edge → deep snow slows you (no walls)
      c.offPiste = Math.abs(c.lat) > this.pisteHalf;

      // A finished skier coasts the racing line to the runout on autopilot so
      // the scene stays alive; its phone no longer drives it.
      if (c.finished) { c.carve = pursue(c, this.centerline); c.tuck = 0; }

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
      if (!c.finished && !c.airborne) {
        if (this._enterObstacle(c) && !spinning) {
          c.spinT = c.spinDur = CRASH_TIME / c.control;   // better control = quicker recovery
          c.spin = 0; spinning = true;
          c.tuck = 0;
          c.boostT = 0; c.boostMul = 1;
          this.onEvent({ type: 'crash', id: c.id });
        }
      }

      // --- JUMP / AIR ------------------------------------------------------
      // No charge meter: TUCK is purely a speed mode now. Air comes from ramps,
      // plus a small hop to clear an obstacle. Firing a jump AT a ramp lip is the
      // reward — a base launch (∝ speed) PLUS a timing bonus.
      let launch = 0;
      let popped = false; // player fired a jump this frame → suppress the ramp auto-launch
      if (c.wantJump) {
        c.wantJump = false;
        if (!c.airborne && !spinning && !c.finished) {
          popped = true;
          if (this._nearRamp(c)) {
            launch += RAMP_POP * (0.45 + 0.55 * (c.v / c.vmax)) + RAMP_JUMP_BONUS;
          } else {
            launch += POP_BASE; // a small hop on open snow (enough to clear a tree)
          }
        }
      }
      // A ramp lip auto-launches anyone who DIDN'T pop it themselves — you always
      // catch some air off a kicker (∝ speed), you just miss the timing bonus. The
      // `popped` guard keeps the two sources mutually exclusive (no double launch:
      // a self-pop already went airborne below, so it can't also auto-launch).
      if (!popped && !c.finished && !c.airborne && !spinning && this._enterRamp(c)) {
        launch += RAMP_POP * (0.45 + 0.55 * (c.v / c.vmax));
      }
      if (launch > 0) {
        c.airborne = true;
        c.vAir = launch;
        c.air = 0.0001;
        c.airPeak = 0;
        this.onEvent({ type: 'jump', id: c.id, power: launch });
      }
      // Integrate the ballistic arc.
      if (c.airborne) {
        c.air += c.vAir * dt;
        c.vAir -= GRAV_AIR * dt;
        if (c.air > c.airPeak) c.airPeak = c.air;
        if (c.air <= 0) {
          // TOUCHDOWN — judge the landing by how sideways the skis point.
          c.air = 0; c.airborne = false; c.vAir = 0;
          const across = Math.abs(Math.sin(c.heading));
          if (across > LAND_WIPE_ACROSS) {
            c.spinT = c.spinDur = CRASH_TIME / c.control; c.spin = 0; spinning = true; c.tuck = 0;
            this.onEvent({ type: 'crash', id: c.id });
          } else if (across > LAND_CLEAN_ACROSS) {
            c.landScrubT = 0.4; // wobble: brief speed scrub
            this.onEvent({ type: 'land', id: c.id, clean: false, air: c.airPeak });
          } else {
            if (c.airPeak >= LAND_BOOST_MIN_AIR) { c.boostMul = LAND_BOOST; c.boostT = 0.9; }
            this.onEvent({ type: 'land', id: c.id, clean: true, air: c.airPeak });
          }
        }
      }

      // --- LONGITUDINAL (gravity + tuck + edge-scrub) ----------------------
      if (c.boostT > 0) { c.boostT -= dt; if (c.boostT <= 0) { c.boostT = 0; c.boostMul = 1; } }
      if (c.landScrubT > 0) c.landScrubT -= dt;
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
      } else {
        const tuckMul = c.tuck ? TUCK_CAP : NOTUCK_CAP;
        const edgeMul = 1 - EDGE_SCRUB * across;
        const scrub = c.landScrubT > 0 ? LAND_SLOPPY_SCRUB : 1;
        let targetV = c.vmax * c.boostMul * steepNorm * tuckMul * edgeMul * scrub;
        // Squat state sets HOW FAST you approach the target, not just the ceiling.
        let accel = c.tuck ? ACCEL_TUCK : ACCEL_UPRIGHT;
        let decel = c.tuck ? DECEL_TUCK : DECEL_UPRIGHT;
        // Deep snow off-piste: hard speed cap + a heavy bog-down drag (tuck can't save you).
        if (c.offPiste) { targetV = Math.min(targetV, c.vmax * DEEP_SNOW_SPEED); decel = DEEP_SNOW_DRAG; }
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

      const before = this.centerline.sampleAt(Math.max(0, c.totalS));
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
        this.onEvent({ type: 'reset', id: c.id });
      }

      // --- FINISH (single line crossing at s = length) ---------------------
      if (!c.finished && prevTotal < this.length && c.totalS >= this.length) {
        c.finished = true;
        c.finishTime = this.elapsed;
        c.tuck = 0;
        // settle out of any jump so the post-finish coast can't crash-land or
        // emit spurious land/crash events for a skier whose run is decided.
        c.airborne = false; c.air = 0; c.vAir = 0;
        this.finishedOrder.push(c.id);
        this.onEvent({ type: 'finish', id: c.id, rank: this.finishedOrder.length, time: c.finishTime });
        if (this.finishedOrder.length >= this.skiers.size) this.onEvent({ type: 'race_over' });
      }
    }

    this._recomputePoses();
    this._rank();
  }

  // Rising-edge overlap of a ramp (open run → no lap wrap on ds).
  _enterRamp(c) {
    if (!this.ramps.length) return false;
    let entered = false;
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      const ds = c.totalS - r.s, dl = c.lat - r.lat;
      const inside = (ds * ds + dl * dl) < (r.radius * r.radius);
      if (inside) { if (!c.rampIn.has(i)) { c.rampIn.add(i); entered = true; } }
      else c.rampIn.delete(i);
    }
    return entered;
  }

  // Is the skier ON or just SHORT OF a ramp lip — close enough that a jump input
  // counts as a "pop at the lip"? A LEVEL check (not _enterRamp's rising edge)
  // with a little forward reach, so an anticipatory release still earns the bonus.
  _nearRamp(c) {
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      const ds = r.s - c.totalS;                 // >0 = ramp still ahead
      const dl = c.lat - r.lat;
      // on/just-short-of the lip (small forward reach), within the kicker's footprint
      if (ds >= -r.radius && ds <= r.radius + RAMP_LIP_REACH && Math.abs(dl) <= r.radius) return true;
    }
    return false;
  }

  // Rising-edge overlap of a tree/rock (footprint = skier radius + obstacle radius).
  _enterObstacle(c) {
    if (!this.obstacles.length) return false;
    let entered = false;
    for (let i = 0; i < this.obstacles.length; i++) {
      const o = this.obstacles[i];
      const ds = c.totalS - o.s, dl = c.lat - o.lat;
      const rr = o.radius + c.radius;
      const inside = (ds * ds + dl * dl) < rr * rr;
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
        id: c.id, pose: c.pose, lat: c.lat, v: c.v,
        spd: c.v / c.vmax,                 // normalized 0..~1.5
        progress: clamp(c.totalS / this.length, 0, 1),
        position: c.rank, of: this.skiers.size,
        finished: c.finished, finishTime: c.finishTime,
        // carve is TURN-ALIGNED (sign matches the actual turn so the renderer
        // leans the body the right way without knowing STEER_SIGN); carveInput
        // is the raw phone input (drives the on-screen carve bar).
        carve: STEER_SIGN * c.carve, carveInput: c.carve,
        tuck: c.tuck,
        airborne: c.airborne, air: c.air,
        spin: c.spin, crashed: c.spinT > 0, offPiste: !!c.offPiste,
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
        playerId: c.id, rank: i + 1, finished: c.finished, time: c.finishTime
      }))
    };
  }

  get raceOver() { return this.finishedOrder.length >= this.skiers.size; }
}
