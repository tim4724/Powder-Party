// Slope catalog — dependency-free DATA (no THREE), an ES module so the builder,
// the gallery, and (via dynamic import) the Node tests can read it without the
// render pipeline. SlopeBuilder (browser) turns `pieces` into a descending
// centerline and resolves `ramps`/`obstacles` (placed as a fraction `at` of the
// total run length) into arclength `s`.
//
// piece kinds:
//   { kind:'straight', len, pitch }          — descend straight; pitch° below horizontal
//   { kind:'carve',    len, pitch, turn }    — descending arc; turn° of yaw (+ = right)
// features (at = 0..1 fraction of run length):
//   ramps:     [{ at, lat }]            — a kicker that launches the skier
//   obstacles: [{ at, lat, kind }]      — trees/rocks; hit one on the snow = wipeout
//
// Besides the hand-authored catalog below, `generateSlope(seed)` (bottom of file)
// synthesises a fresh random def of the SAME shape — that's what live play uses
// per run; `powder-bowl` stays as a tuned reference + the gallery/test fixture.

export const SLOPES = {
  'powder-bowl': {
    id: 'powder-bowl',
    name: 'Powder Bowl',
    chips: ['Blue', 'Jumps', 'Trees'],
    width: 11,
    pieces: [
      { kind: 'straight', len: 30, pitch: 19 },           // gentle launch — build speed
      { kind: 'carve',    len: 34, pitch: 21, turn:  48 }, // right sweeper
      { kind: 'straight', len: 38, pitch: 28 },            // steep schuss — TUCK (ramp at the end)
      { kind: 'carve',    len: 36, pitch: 22, turn: -56 }, // left
      { kind: 'straight', len: 28, pitch: 24 },
      { kind: 'carve',    len: 34, pitch: 23, turn:  52 }, // right
      { kind: 'straight', len: 40, pitch: 30 },            // steepest — big tuck straight (ramp)
      { kind: 'carve',    len: 30, pitch: 21, turn: -42 }, // left into the runout
      { kind: 'straight', len: 32, pitch: 14 },            // flattening runout to the finish
    ],
    ramps: [
      { at: 0.335, lat: 0, radius: 2.4 },
      { at: 0.72,  lat: 0, radius: 2.4 },
    ],
    obstacles: [
      { at: 0.12, lat: -2.6, kind: 'tree' },
      { at: 0.22, lat:  3.0, kind: 'tree' },
      { at: 0.47, lat: -3.0, kind: 'tree' },
      { at: 0.52, lat:  1.8, kind: 'rock' },
      { at: 0.61, lat:  2.8, kind: 'tree' },
      { at: 0.84, lat: -2.7, kind: 'tree' },
      { at: 0.90, lat:  3.0, kind: 'tree' },
    ],
  },

  // Trick Lab — a STRAIGHT practice run (no curves, no trees) lined with kickers
  // at lat 0, for drilling the brake/jump/flip loop in isolation. `test: true`
  // hides it from the public slope catalogue (SLOPE_LIST); buildSlopeById can
  // still build it by id. Used by the `tricks` test scenario (see TestHarness).
  'trick-lab': {
    id: 'trick-lab',
    name: 'Trick Lab',
    chips: ['Test', 'Straight', 'Jumps'],
    test: true,
    width: 16,                                          // wide + forgiving — no off-piste to fight
    pieces: [
      { kind: 'straight', len: 24, pitch: 14 },         // gentle ease-in to build speed
      { kind: 'straight', len: 168, pitch: 23 },        // long steep straight — bomb it, flip the kickers
      { kind: 'straight', len: 32, pitch: 12 },         // mellow runout to the finish
    ],
    ramps: [                                            // evenly spaced, all on the fall line (lat 0)
      { at: 0.16, lat: 0, radius: 2.6 },
      { at: 0.34, lat: 0, radius: 2.6 },
      { at: 0.52, lat: 0, radius: 2.6 },
      { at: 0.70, lat: 0, radius: 2.6 },
      { at: 0.84, lat: 0, radius: 2.6 },
    ],
    obstacles: [],
  },

  // Bump Lab — a WIDE, straight, tree-free, kicker-free run for feeling out
  // skier-vs-skier contact in isolation (no ramps to fling the pack apart, no
  // trees to confound a wipeout). Used by the `bump` test scenario, which drops a
  // keyboard skier into a tight pack of lane-bias-zeroed bots so soft bumps,
  // blocking, and T-bones all happen on demand (see TestHarness).
  'bump-lab': {
    id: 'bump-lab',
    name: 'Bump Lab',
    chips: ['Test', 'Straight', 'Contact'],
    test: true,
    width: 18,                                          // wide + forgiving — room to scrum without fighting off-piste
    pieces: [
      { kind: 'straight', len: 20, pitch: 16 },         // gentle ease-in
      { kind: 'straight', len: 170, pitch: 24 },        // long steep straight — the pack jostles down it at speed
      { kind: 'straight', len: 30, pitch: 12 },         // mellow runout to the finish
    ],
    ramps: [],
    obstacles: [],
  },
};

export const SLOPE_LIST = Object.keys(SLOPES)
  .filter((id) => !SLOPES[id].test)        // hide test/practice slopes from the public catalogue
  .map((id) => ({ id, name: SLOPES[id].name, chips: SLOPES[id].chips }));

export const DEFAULT_SLOPE = 'powder-bowl';

// ---- Procedural generator -------------------------------------------------
// A seeded PRNG + slope synth so every run can be a fresh, believable hill. Emits
// the SAME { pieces, ramps, obstacles } DATA shape the hand-authored slopes use,
// so SlopeBuilder / SceneRenderer / SkiEngine consume it unchanged — and because
// scenery (peaks, forest, mountainside walls) is all centerline-derived, a sane
// random centerline keeps the world realistic for free. THREE-free + fully
// deterministic (same seed → identical def), so it loads in the Node tests and
// the gallery alike.

// mulberry32 — tiny, fast, well-distributed 32-bit PRNG (one uint32 of state).
// Seed it directly (no `|| 1` guard — that would alias seed 0 to seed 1; the
// first +constant step lifts a 0 seed off the degenerate state on its own).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const r1 = (x) => Math.round(x * 10) / 10;     // one decimal
const r3 = (x) => Math.round(x * 1000) / 1000; // three decimals

// Tune the run LENGTH (units) to hit the ~1-minute target. ~3× the old
// hand-authored 302u hill. Tuned against CPU finish times: ~940u → benchmark
// bots finish ~56s, so a typical (slower, wider-line) human run lands near 60s.
const TARGET_LENGTH = 940;
const RUNOUT = 32;   // flattening straight reserved for the finish
const YAW_CAP = 75;  // cap cumulative heading (deg) so the run never spirals back
                     // on itself — keeps the valley/walls/forest reading as one face

// generateSlope(seed) → a slope `def` (same shape as the entries in SLOPES).
// Bounded & fair: a believable blue/red descent — monotonic pitch in a sane
// band, smooth alternating switchback turns (never uphill, never a spiral), a
// clean launch + a flattening runout, kickers on the steep straights, and a
// spaced obstacle field that leaves the start/finish clear.
export function generateSlope(seed, opts = {}) {
  const rnd = mulberry32(seed >>> 0);
  const rng = (lo, hi) => lo + (hi - lo) * rnd();
  const target = opts.targetLength || TARGET_LENGTH;
  const width = r1(rng(10, 12));

  const pieces = [];
  // 1) gentle launch straight — clean build-up (kept obstacle-free below).
  let prevPitch = rng(17, 21);
  pieces.push({ kind: 'straight', len: Math.round(rng(28, 34)), pitch: Math.round(prevPitch) });
  let total = pieces[0].len;

  // 2) alternate carve / straight until we near the target, leaving room for the
  //    runout. Carves alternate direction (switchbacks) with the occasional
  //    sweeping repeat; YAW_CAP forces a turn-back before the run can spiral.
  let psi = 0;
  let lastSign = rnd() < 0.5 ? 1 : -1;
  while (total < target - RUNOUT) {
    const addCarve = pieces[pieces.length - 1].kind === 'straight'; // alternate straight ↔ carve
    let pitch = _clamp(prevPitch + rng(-4, 4), 17, 30);
    if (addCarve) {
      let sign = -lastSign;
      // occasional sweeping repeat (same direction) for variety, only if it stays
      // clear of the yaw cap even at the MAX turn magnitude (58°)…
      if (rnd() < 0.25 && Math.abs(psi + lastSign * 58) < YAW_CAP) sign = lastSign;
      // …and a hard turn-back once we drift too far off the fall line.
      if (Math.abs(psi) > YAW_CAP) sign = -Math.sign(psi) || 1;
      lastSign = sign;
      const turn = Math.round(sign * rng(36, 58));
      psi += turn;
      const len = Math.round(rng(30, 40));
      pieces.push({ kind: 'carve', len, pitch: Math.round(pitch), turn });
      total += len;
    } else {
      if (rnd() < 0.3) pitch = _clamp(pitch + rng(2, 4), 17, 32); // occasional steep tuck schuss
      const len = Math.round(rng(28, 42));
      pieces.push({ kind: 'straight', len, pitch: Math.round(pitch) });
      total += len;
    }
    prevPitch = pitch;
  }
  // 3) flattening runout to the finish line.
  pieces.push({ kind: 'straight', len: RUNOUT, pitch: Math.round(rng(12, 15)) });
  total += RUNOUT;
  const length = total;

  // Piece-end arclengths → `at` fractions for placing features.
  const ends = [];
  { let acc = 0; for (const p of pieces) { acc += p.len; ends.push(acc); } }

  // ramps: kickers near the END of the longer straights (you launch off the
  // bottom of a schuss), spaced apart, clear of the launch/finish.
  const cand = [];
  for (let i = 1; i < pieces.length - 1; i++) {
    if (pieces[i].kind === 'straight' && pieces[i].len >= 28) {
      const at = (ends[i] - 4) / length; // lip ~4u before the piece end
      if (at > 0.12 && at < 0.9) cand.push(at);
    }
  }
  for (let i = cand.length - 1; i > 0; i--) { // Fisher–Yates with the seeded rng
    const j = Math.floor(rnd() * (i + 1)); const t = cand[i]; cand[i] = cand[j]; cand[j] = t;
  }
  const rampCount = Math.min(cand.length, 2 + (rnd() < 0.5 ? 1 : 0));
  const ramps = [];
  for (const at of cand) {
    if (ramps.length >= rampCount) break;
    if (ramps.every((r) => Math.abs(r.at - at) > 0.12)) ramps.push({ at: r3(at), lat: 0, radius: 2.4 });
  }
  ramps.sort((a, b) => a.at - b.at);

  // obstacles: 6–10 trees/rocks spread down the run, min-spaced, clear of the
  // launch (<0.12) / finish (>0.92) and of every ramp.
  const obstacles = [];
  const obsTarget = 6 + Math.floor(rnd() * 5);
  for (let guard = 0; obstacles.length < obsTarget && guard < 300; guard++) {
    const at = rng(0.12, 0.92);
    if (ramps.some((r) => Math.abs(r.at - at) < 0.06)) continue; // keep margin over the 0.05 test bar

    if (obstacles.some((o) => Math.abs(o.at - at) < 0.035)) continue;
    obstacles.push({ at: r3(at), lat: r1(rng(-3.2, 3.2)), kind: rnd() < 0.78 ? 'tree' : 'rock' });
  }
  obstacles.sort((a, b) => a.at - b.at);

  return { id: 'gen-' + (seed >>> 0), name: 'Random Run', chips: ['Random'], width, pieces, ramps, obstacles };
}
