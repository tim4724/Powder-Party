// SwipeInput — eyes-free touch gestures for the Powder Party controller.
//
// The player watches the TV, not the phone, so the WHOLE play surface is the
// gesture target — no buttons to aim at. Tucked (fast) is the DEFAULT resting
// state; you only touch the pad to do something deliberate:
//
//   press DOWN and HOLD            →  BRAKE (sit up, scrub speed, sharp carve).
//     t drops to 0 while held; releasing returns to the default tuck (t=1).
//   quick FLICK in the air         →  a FLIP, fully ANALOG: the swipe ANGLE picks
//     the trick — up = back, down = front, left/right = spin, diagonals = corks —
//     and how hard you throw sets the spin rate. Every flick rides the {n,a,m}
//     edge `f` (a = angle, m = strength). On the snow a flick does nothing — there
//     is no jump gesture; RAMPS auto-launch you. An upward flick ALSO bumps a
//     legacy jump edge `j`, which the display reads ONLY in the air, as a back-flip
//     fallback for non-analog inputs (the air otherwise reads f's exact angle).
//
// A flick is a FAST swipe (released within FLICK_MAX_MS); a brake is a SUSTAINED
// downward hold. A quick down-flick therefore reads as a front flip (in the air),
// while a slow downward press reads as a brake — same direction, told apart by
// speed.
//
// Both j and f are latest-wins-safe wrapping edges: the display fires one action
// per CHANGE, so a dropped fastlane frame just re-delivers the same value.
//
// This module owns only brake + flick; carve lives in TiltInput.js. They
// merge at the CONTROL payload boundary in main.js, never inside either module.
//
// Pointer events (not touch events) unify mouse (desktop test) + touch. The
// surface has touch-action:none (set by TiltInput on the shared #game element),
// so a swipe never scrolls/zooms the page under the thumb.
//
// Contract: get state() → { t: 0|1, j: 0..255, f: {n:0..255, a, m} } for the
// CONTROL tick, plus onContact(x,y) / onBrakeStart / onBrakeEnd / onFlick(a,m)
// callbacks for the HUD + haptics (every recognized input gets a confirming buzz
// in main.js).

const BRAKE_THRESHOLD_PX = 40;  // downward travel before a hold counts as a brake
const FLICK_THRESHOLD_PX = 46;  // travel a quick swipe needs to count as a flick
const FLICK_MAX_MS = 300;       // a flick must complete within this (else it's a hold/tap)
const FLICK_MAG_SPAN = 140;     // travel (px) PAST the threshold that maps to full strength (m=1)
const UP_CONE = Math.PI / 3;    // a flick within ±60° of straight up also bumps the legacy jump edge j (air back-flip fallback)

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
// Is this flick angle "upward" enough to also count as a jump pop? (up = +π/2,
// so within ±UP_CONE of up ⇔ sin(a) ≥ cos(UP_CONE).)
function isUpFlick(a) { return Math.sin(a) >= Math.cos(UP_CONE); }

export class SwipeInput {
  constructor({ surface, onContact, onBrakeStart, onBrakeEnd, onFlick } = {}) {
    this.surface = surface || (typeof document !== 'undefined' ? document.body : null);
    this.onContact = onContact || (() => {});        // (x, y) => … any pointer touches the pad
    this.onBrakeStart = onBrakeStart || (() => {});  // () => …  brake engaged (t→0)
    this.onBrakeEnd = onBrakeEnd || (() => {});      // () => …  brake released (t→1)
    this.onFlick = onFlick || (() => {});            // (a, m) => … angle (rad) + strength (0..1)

    this._braking = false;
    this._jumpSeq = 0;         // wrapping JUMP edge (bumped by any upward flick)
    this._flickSeq = 0;        // wrapping analog trick edge
    this._flickAngle = 0;      // last flick angle (rad, up = +π/2)
    this._flickMag = 0;        // last flick strength (0..1)

    this._pointerId = null;
    this._startX = 0;
    this._startY = 0;
    this._startT = 0;          // gesture start time (for the flick window)

    // keyboard fallback flags
    this._keyBrake = false;
    this._keyUp = false;
    this._keyDown = false;
    this._keyLeft = false;
    this._keyRight = false;

    this._down = this._down.bind(this);
    this._move = this._move.bind(this);
    this._up = this._up.bind(this);
    this._bindKeys();
  }

  start() {
    if (!this.surface) return;
    this.surface.addEventListener('pointerdown', this._down);
    this.surface.addEventListener('pointermove', this._move);
    this.surface.addEventListener('pointerup', this._up);
    this.surface.addEventListener('pointercancel', this._up);
    this.surface.addEventListener('pointerleave', this._up);
  }
  stop() {
    if (this.surface) {
      this.surface.removeEventListener('pointerdown', this._down);
      this.surface.removeEventListener('pointermove', this._move);
      this.surface.removeEventListener('pointerup', this._up);
      this.surface.removeEventListener('pointercancel', this._up);
      this.surface.removeEventListener('pointerleave', this._up);
    }
    this._endBrake();      // never leave the brake stuck on at run end
    this._pointerId = null;
  }

  _down(e) {
    if (this._pointerId != null) return;        // single active pointer
    this._pointerId = e.pointerId;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._startT = performance.now();
    this.onContact(e.clientX, e.clientY);        // ripple / "the whole pad is live"
    e.preventDefault();                          // stop iOS pull-to-refresh / scroll
  }
  _move(e) {
    if (e.pointerId !== this._pointerId) return;
    const dy = e.clientY - this._startY;
    // Engage the brake once a sustained press has travelled down past the
    // threshold (stays on while held, even if the finger drifts).
    if (!this._braking && dy > BRAKE_THRESHOLD_PX) { this._braking = true; this.onBrakeStart(); }
  }
  _up(e) {
    if (e.pointerId !== this._pointerId) return;
    this._pointerId = null;
    const dx = e.clientX - this._startX;
    const dy = e.clientY - this._startY;
    const dt = performance.now() - this._startT;
    const dist = Math.hypot(dx, dy);
    // A fast swipe is a FLICK (jump / flip). It overrides any brake that briefly
    // engaged on the way (a few ms of t=0 is harmless on the snow, and t is
    // ignored in the air where flips happen).
    if (dt < FLICK_MAX_MS && dist > FLICK_THRESHOLD_PX) {
      this._endBrake();
      // angle: math convention, up = +π/2 (screen y is down-positive → negate dy).
      const a = Math.atan2(-dy, dx);
      // strength: how far past the flick threshold the swipe travelled, normalized.
      const m = clamp((dist - FLICK_THRESHOLD_PX) / FLICK_MAG_SPAN, 0, 1);
      this._fireFlick(a, m);
    } else {
      // a hold or a tap — release any brake, fire nothing
      this._endBrake();
    }
  }

  // Route a flick: every flick rides the analog trick edge f; an upward flick
  // ALSO bumps the legacy jump edge j (the display reads j only in the air, as a
  // back-flip fallback — the snow has no jump gesture; ramps auto-launch).
  _fireFlick(a, m = 0.6) {
    this._flickAngle = a;
    this._flickMag = m;
    this._flickSeq = (this._flickSeq + 1) & 255;
    if (isUpFlick(a)) this._jumpSeq = (this._jumpSeq + 1) & 255;
    this.onFlick(a, m);
  }

  _endBrake() {
    if (!this._braking) return;
    this._braking = false;
    this.onBrakeEnd();
  }

  // latest-state-wins fields the CONTROL tick reads each frame.
  //   t : tuck 0|1 (1 = default tuck/fast, 0 = braking)
  //   j : wrapping JUMP edge (bumped by any upward flick)
  //   f : wrapping ANALOG trick flick { n, a, m } — a = angle (rad), m = strength
  get state() {
    return {
      t: this._braking ? 0 : 1,
      j: this._jumpSeq,
      f: { n: this._flickSeq, a: this._flickAngle, m: this._flickMag },
    };
  }

  // --- keyboard fallback / testing (works over plain HTTP — no touchscreen) ---
  // Hold S = brake. Space / ArrowUp = back flip (in the air; nothing on the snow).
  // ArrowDown = front flip, Q = spin-left, E = spin-right. (ArrowLeft/Right + A/D are carve,
  // owned by TiltInput, so they're left alone here.) Each trick key maps to the
  // same gesture angle a real flick would produce.
  _bindKeys() {
    if (typeof window === 'undefined') return;
    // Never steal keys from a text field (the name input): these are
    // window-level listeners, live from construction, and their preventDefault
    // would otherwise swallow "s"/space/arrows while typing a name — and fire
    // phantom brake/flick callbacks (buzz, HUD flashes) on every keystroke.
    const typing = (e) => {
      const t = e.target;
      return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
    };
    window.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        if (!this._keyBrake) { this._keyBrake = true; this._braking = true; this.onBrakeStart(); }
        e.preventDefault();
      } else if (k === 'arrowup' || k === ' ') {
        if (!this._keyUp) { this._keyUp = true; this._fireFlick(Math.PI / 2); }   // back flip (air); nothing on the snow
        e.preventDefault();
      } else if (k === 'arrowdown') {
        if (!this._keyDown) { this._keyDown = true; this._fireFlick(-Math.PI / 2); } // front flip
        e.preventDefault();
      } else if (k === 'q') {
        if (!this._keyLeft) { this._keyLeft = true; this._fireFlick(Math.PI); }   // spin left
        e.preventDefault();
      } else if (k === 'e') {
        if (!this._keyRight) { this._keyRight = true; this._fireFlick(0); }       // spin right
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if (k === 's') { this._keyBrake = false; this._endBrake(); e.preventDefault(); }
      else if (k === 'arrowup' || k === ' ') { this._keyUp = false; e.preventDefault(); }
      else if (k === 'arrowdown') { this._keyDown = false; e.preventDefault(); }
      else if (k === 'q') { this._keyLeft = false; e.preventDefault(); }
      else if (k === 'e') { this._keyRight = false; e.preventDefault(); }
    });
  }
}
