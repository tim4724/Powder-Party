// SwipeInput — eyes-free touch gestures for the Powder Party controller.
//
// The player watches the TV, not the phone, so the WHOLE play surface is the
// gesture target — no buttons to aim at. Tucked (fast) is the DEFAULT resting
// state; you only touch the pad to do something deliberate:
//
//   press DOWN and HOLD            →  BRAKE (sit up, scrub speed, sharp carve).
//     t drops to 0 while held; releasing returns to the default tuck (t=1).
//   quick FLICK UP                 →  JUMP (a wrapping counter j; bigger at a
//     ramp lip). The display turns the SAME up-flick into a BACK flip when the
//     skier is already airborne — it owns the jump-vs-trick decision (it has the
//     authoritative air state), so this module just reports the gesture.
//   quick FLICK in the air         →  a FLIP. up = back, down = front, left/right
//     = side. The non-up directions ride a separate wrapping {n,d} edge `f`
//     (air-only; the display ignores them on the snow). j carries the up-flick.
//
// A flick is a FAST directional swipe (released within FLICK_MAX_MS); a brake is
// a SUSTAINED downward hold. A quick down-flick therefore reads as a flip, while
// a slow downward press reads as a brake — same direction, told apart by speed.
//
// Both j and f are latest-wins-safe wrapping edges: the display fires one action
// per CHANGE, so a dropped fastlane frame just re-delivers the same value.
//
// This module owns only brake + jump + flip; carve lives in TiltInput.js. They
// merge at the CONTROL payload boundary in main.js, never inside either module.
//
// Pointer events (not touch events) unify mouse (desktop test) + touch. The
// surface has touch-action:none (set by TiltInput on the shared #game element),
// so a swipe never scrolls/zooms the page under the thumb.
//
// Contract: get state() → { t: 0|1, j: 0..255, f: {n:0..255, d} } for the CONTROL
// tick, plus onBrakeStart / onBrakeEnd / onFlick(dir) callbacks for the HUD +
// haptics (every recognized input gets a short confirming buzz in main.js).

const BRAKE_THRESHOLD_PX = 40;  // downward travel before a hold counts as a brake
const FLICK_THRESHOLD_PX = 46;  // travel a quick swipe needs to count as a flick
const FLICK_MAX_MS = 300;       // a flick must complete within this (else it's a hold/tap)

export class SwipeInput {
  constructor({ surface, onBrakeStart, onBrakeEnd, onFlick } = {}) {
    this.surface = surface || (typeof document !== 'undefined' ? document.body : null);
    this.onBrakeStart = onBrakeStart || (() => {});  // () => …  brake engaged (t→0)
    this.onBrakeEnd = onBrakeEnd || (() => {});      // () => …  brake released (t→1)
    this.onFlick = onFlick || (() => {});            // (dir) => … 'up'|'down'|'left'|'right'

    this._braking = false;
    this._jumpSeq = 0;         // wrapping up-flick edge (jump / back flip)
    this._flickSeq = 0;        // wrapping non-up flick edge (front / side flips)
    this._flickDir = null;     // last non-up flick direction ('front'|'left'|'right')

    this._pointerId = null;
    this._startX = 0;
    this._startY = 0;
    this._startT = 0;          // gesture start time (for the flick window)

    // keyboard fallback flags
    this._keyBrake = false;
    this._keyUp = false;
    this._keyFront = false;
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
    // A fast directional swipe is a FLICK (jump / flip). It overrides any brake
    // that briefly engaged on the way (a few ms of t=0 is harmless on the snow,
    // and t is ignored in the air where flips happen).
    if (dt < FLICK_MAX_MS && (dx * dx + dy * dy) > FLICK_THRESHOLD_PX * FLICK_THRESHOLD_PX) {
      this._endBrake();
      let dir;
      if (Math.abs(dy) >= Math.abs(dx)) dir = dy < 0 ? 'up' : 'down';
      else dir = dx < 0 ? 'left' : 'right';
      this._fireFlick(dir);
    } else {
      // a hold or a tap — release any brake, fire nothing
      this._endBrake();
    }
  }

  // Route a flick: up rides the jump counter j (jump on snow / back flip in air);
  // the rest ride the air-only trick edge f.
  _fireFlick(dir) {
    if (dir === 'up') {
      this._jumpSeq = (this._jumpSeq + 1) & 255;
    } else {
      this._flickDir = dir === 'down' ? 'front' : dir; // 'front' | 'left' | 'right'
      this._flickSeq = (this._flickSeq + 1) & 255;
    }
    this.onFlick(dir);
  }

  _endBrake() {
    if (!this._braking) return;
    this._braking = false;
    this.onBrakeEnd();
  }

  // latest-state-wins fields the CONTROL tick reads each frame.
  //   t : tuck 0|1 (1 = default tuck/fast, 0 = braking)
  //   j : wrapping up-flick edge (jump / back flip)
  //   f : wrapping air-trick edge { n, d } for the non-up flicks (front / side)
  get state() {
    return {
      t: this._braking ? 0 : 1,
      j: this._jumpSeq,
      f: { n: this._flickSeq, d: this._flickDir },
    };
  }

  // --- keyboard fallback / testing (works over plain HTTP — no touchscreen) ---
  // Hold S = brake. Space / ArrowUp = jump (or back flip in the air). ArrowDown =
  // front flip, Q = side-left, E = side-right. (ArrowLeft/Right + A/D are carve,
  // owned by TiltInput, so they're left alone here.)
  _bindKeys() {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === 's') {
        if (!this._keyBrake) { this._keyBrake = true; this._braking = true; this.onBrakeStart(); }
        e.preventDefault();
      } else if (k === 'arrowup' || k === ' ') {
        if (!this._keyUp) { this._keyUp = true; this._fireFlick('up'); }
        e.preventDefault();
      } else if (k === 'arrowdown') {
        if (!this._keyFront) { this._keyFront = true; this._fireFlick('down'); }
        e.preventDefault();
      } else if (k === 'q') {
        if (!this._keyLeft) { this._keyLeft = true; this._fireFlick('left'); }
        e.preventDefault();
      } else if (k === 'e') {
        if (!this._keyRight) { this._keyRight = true; this._fireFlick('right'); }
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k === 's') { this._keyBrake = false; this._endBrake(); e.preventDefault(); }
      else if (k === 'arrowup' || k === ' ') { this._keyUp = false; e.preventDefault(); }
      else if (k === 'arrowdown') { this._keyFront = false; e.preventDefault(); }
      else if (k === 'q') { this._keyLeft = false; e.preventDefault(); }
      else if (k === 'e') { this._keyRight = false; e.preventDefault(); }
    });
  }
}
