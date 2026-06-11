// TiltInput — phone CARVE steering for the Powder Party controller.
//
// Carve is absolute (no recentering): we read DeviceOrientation, rebuild the
// gravity vector, and carve by the phone's ROLL — gravity's angle in the x–z
// plane:  roll = atan2(gx, -gz)  (this equals device `gamma`).
//
// Roll is the lean signal: tip the phone left/right to carve left/right.
// Critically it's PITCH-INDEPENDENT — the cosβ in gx and gz cancels, so a 25°
// lean reads 25° whether the phone is flat or tilted back to read it. (asin(gx)
// does NOT cancel pitch and weakened the lean the more upright you held it — that
// was a bug.)
//
// A steering-wheel twist still works: held upright, a twist swings gravity in the
// screen plane and the roll runs toward ±90°, so twisting carves too (sensitively
// — it reaches full lock fast, since roll isn't proportional to the twist the way
// it is to a flat lean). Both gestures, one signal, no mode switch.
//
// Roll is screen-orientation corrected, so "left/right from the player's point of
// view" stays correct in portrait AND landscape.
//
// iOS 13+ needs requestPermission() from a user gesture (call enableMotion() in a
// tap handler). HTTPS is required for the motion sensors on real phones; the
// keyboard fallback below works over plain HTTP so desktop testing needs no TLS.
//
// Tuck + jump are NOT here — they live in SwipeInput.js (the eyes-free touch
// surface) and are merged into the CONTROL payload in main.js. This module owns
// only the carve axis, so the two input domains stay independently testable.
//
// Fallbacks (no tilt / desktop / permission denied): arrow keys or A/D carve.
// Carve = roll + keys (so the loop is testable headlessly). Calls onCarve(s) at
// ~25 Hz with s ∈ [-1,1]; main.js folds that into the {s,t,j} CONTROL payload.

const SEND_HZ = 25;
// Skiing wants a smoother, less twitchy carve than arcade kart steering, so the
// lock angle is wider (more lean for full carve) and the filter a touch heavier
// for a weightier, momentum feel. These two are the feel knobs — tune in playtest.
const ROLL_LOCK = 38;      // degrees of left/right roll for full carve
const DEADZONE = 0.06;     // normalized carve ignored around centre
// Single light low-pass on the carve output: just enough to take the edge off
// sensor jitter (raw DeviceOrientation twitches ~1-2° even held still) without
// the lag of a heavier filter. Higher = snappier; set to 1 for fully raw.
const SMOOTH = 0.4;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

// Screen rotation the OS has applied (0/90/180/270, or legacy iOS -90..180).
function screenAngle() {
  const so = (typeof screen !== 'undefined') && screen.orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  if (typeof window !== 'undefined' && typeof window.orientation === 'number') return window.orientation;
  return 0;
}

export class TiltInput {
  constructor({ onCarve, surface }) {
    this.onCarve = onCarve || (() => {});
    this.surface = surface || (typeof document !== 'undefined' ? document.body : null);
    this.haveTilt = false;
    this.motionState = 'unknown'; // unknown | granted | denied | unsupported

    // latest gravity unit vector in the device frame (overwritten each event;
    // the flat seed only stands in until the first reading arrives)
    this._g = { x: 0, y: 0, z: -1 };

    this._carve = 0;       // smoothed carve output (-1..1)
    this._key = 0;         // keyboard carve (-1/0/1)
    this._keyL = false; this._keyR = false;
    this._timer = null;

    this._onOrient = this._onOrient.bind(this);
    this._bindKeys();
    this._initSurface();
  }

  // Call from a user gesture (e.g. the Join tap). Returns the permission state.
  async enableMotion() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { this.motionState = 'unsupported'; return this.motionState; }
    try {
      if (typeof DOE.requestPermission === 'function') {
        const res = await DOE.requestPermission(); // iOS
        this.motionState = res === 'granted' ? 'granted' : 'denied';
      } else {
        this.motionState = 'granted'; // Android/desktop: just attach
      }
    } catch (_) {
      this.motionState = 'denied';
    }
    if (this.motionState === 'granted') window.addEventListener('deviceorientation', this._onOrient);
    return this.motionState;
  }

  _onOrient(e) {
    if (e.beta == null && e.gamma == null) return;
    this.haveTilt = true;

    // Gravity (unit, pointing down) in the device frame from the W3C Z-X'-Y''
    // Euler angles. alpha (compass yaw) doesn't tilt gravity, so it drops out —
    // which is exactly why carve needs no compass and no recentering.
    const b = (e.beta || 0) * DEG, g = (e.gamma || 0) * DEG;
    const cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    // Store gravity straight from this sample — no smoothing here. The only
    // low-pass is the one on the carve output (SMOOTH), so there's no startup
    // ramp and no stacked latency; "level" is wherever gravity actually points.
    this._g.x = cb * sg;
    this._g.y = -sb;
    this._g.z = -cb * cg;
  }

  start() {
    if (this._timer) return;
    const interval = 1000 / SEND_HZ;
    this._timer = setInterval(() => this._tick(), interval);
  }
  stop() {
    clearInterval(this._timer); this._timer = null;
  }

  // Rotate the device-frame gravity x/y into the player's frame so "left/right"
  // is consistent whichever way the phone is held. z is unchanged by a screen
  // rotation (it spins about the viewing axis).
  _userGravity() {
    const a = screenAngle() * DEG;
    const ca = Math.cos(a), sa = Math.sin(a);
    const { x, y, z } = this._g;
    return { ux: x * ca + y * sa, uy: -x * sa + y * ca, uz: z };
  }

  // Carve = roll = gravity's angle in the x–z plane = atan2(gx, -gz). Equals
  // device gamma; pitch-independent (cosβ cancels), so the lean is full-strength
  // at any hold angle. An upright twist runs gz→0, so roll heads toward ±90° and
  // twisting carves too (just not proportionally).
  _sensorCarve() {
    if (!this.haveTilt) return 0;
    const { ux, uz } = this._userGravity();
    const rollDeg = Math.atan2(ux, -uz) * RAD;
    return clamp1(rollDeg / ROLL_LOCK);
  }

  _tick() {
    let target = this._sensorCarve();
    // dead-zone the centre, then re-expand so full lock still reaches ±1
    if (Math.abs(target) < DEADZONE) target = 0;
    else target = (target - Math.sign(target) * DEADZONE) / (1 - DEADZONE);
    this._carve += (target - this._carve) * SMOOTH;

    const s = clamp1(this._carve + this._key);
    this.onCarve(Math.round(s * 1000) / 1000); // 3-decimal quantise, no string round-trip
  }

  // current carve (for the on-screen carve indicator)
  get state() {
    return { carve: clamp1(this._carve + this._key) };
  }

  // --- keyboard fallback / testing (works over plain HTTP — no sensors) ---
  _bindKeys() {
    if (typeof window === 'undefined') return;
    const set = (e, down) => {
      // Never steal keys from a text field (the name input) — the
      // preventDefault below would swallow "a"/"d"/arrows while typing a name.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'a') { this._keyL = down; e.preventDefault(); }
      else if (k === 'arrowright' || k === 'd') { this._keyR = down; e.preventDefault(); }
      else return;
      this._key = (this._keyR ? 1 : 0) - (this._keyL ? 1 : 0);
    };
    window.addEventListener('keydown', (e) => set(e, true));
    window.addEventListener('keyup', (e) => set(e, false));
  }

  // Carve is via tilt; the control surface just needs to not scroll/zoom under
  // the player's thumb while they ski (the swipe gestures share this surface).
  _initSurface() {
    if (this.surface) this.surface.style.touchAction = 'none';
  }
}
