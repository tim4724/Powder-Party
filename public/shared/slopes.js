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

export const SLOPES = {
  'powder-bowl': {
    id: 'powder-bowl',
    name: 'Powder Bowl',
    chips: ['Blue', 'Jumps', 'Trees'],
    width: 11,
    pieces: [
      { kind: 'straight', len: 30, pitch: 15 },           // gentle launch — build speed
      { kind: 'carve',    len: 34, pitch: 17, turn:  48 }, // right sweeper
      { kind: 'straight', len: 38, pitch: 24 },            // steep schuss — TUCK (ramp at the end)
      { kind: 'carve',    len: 36, pitch: 18, turn: -56 }, // left
      { kind: 'straight', len: 28, pitch: 20 },
      { kind: 'carve',    len: 34, pitch: 19, turn:  52 }, // right
      { kind: 'straight', len: 40, pitch: 26 },            // steepest — big tuck straight (ramp)
      { kind: 'carve',    len: 30, pitch: 16, turn: -42 }, // left into the runout
      { kind: 'straight', len: 32, pitch: 11 },            // flattening runout to the finish
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
};

export const SLOPE_LIST = Object.keys(SLOPES)
  .filter((id) => !SLOPES[id].test)        // hide test/practice slopes from the public catalogue
  .map((id) => ({ id, name: SLOPES[id].name, chips: SLOPES[id].chips }));

export const DEFAULT_SLOPE = 'powder-bowl';
