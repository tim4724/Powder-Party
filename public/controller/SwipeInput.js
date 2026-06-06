// SwipeInput — eyes-free touch gestures for the Powder Party controller.
//
// The player watches the TV, not the phone, so the WHOLE play surface is the
// gesture target — no buttons to aim at. Two gestures, by feel:
//
//   swipe DOWN past a small threshold and HOLD  →  TUCK (squat for speed).
//     tuck stays on (t=1) while the finger is down, even if it drifts; releasing
//     (touchend / pointerup) drops it (t=0).
//   release of a tuck-hold (crouch-release)      →  JUMP. Bump a wrapping jump
//     counter j = (j+1)&255. The DISPLAY decides how big the pop is (from how long
//     the tuck was held + whether the skier is at a ramp lip); the controller just
//     signals the release EDGE robustly. j is latest-wins-safe: the display fires
//     one pop per CHANGE, so a dropped fastlane frame just re-delivers the value.
//   swipe UP quickly                              →  HOP. Also bumps j — an instant
//     small jump even without a charged tuck.
//
// This module owns only tuck + jump; carve lives in TiltInput.js. They merge at
// the CONTROL payload boundary in main.js, never inside either module.
//
// Pointer events (not touch events) unify mouse (desktop test) + touch. The
// surface has touch-action:none (set by TiltInput on the shared #game element),
// so a swipe never scrolls/zooms the page under the thumb.
//
// Contract: exposes get state() → { t: 0|1, j: 0..255 } for the CONTROL tick, and
// a live `charge` (0..1, local estimate of how long the tuck has been held) plus
// onTuckStart / onCharge / onTuckEnd callbacks for the HUD + haptics. `charge` is
// NOT in the wire payload (the display sends its own authoritative charge); it's
// purely local eyes-free feedback.

const TUCK_THRESHOLD_PX = 44;   // downward travel before a hold counts as a tuck
const HOP_THRESHOLD_PX = 52;    // quick upward travel that fires a hop
const HOP_MAX_MS = 320;         // an upward flick must complete within this to count as a hop
const MAX_CHARGE_MS = 900;      // hold time that maps to a full local charge meter
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class SwipeInput {
  constructor({ surface, onTuckStart, onTuckEnd, onCharge } = {}) {
    this.surface = surface || (typeof document !== 'undefined' ? document.body : null);
    this.onTuckStart = onTuckStart || (() => {});   // () => …  tuck engaged
    this.onCharge = onCharge || (() => {});          // (chargeNorm) => …  live for the HUD/rumble
    this.onTuckEnd = onTuckEnd || (() => {});        // (chargeNorm) => …  fires the jump (release edge)

    this._tucking = false;
    this._charge = 0;          // 0..1 live local charge (UI/haptics only — NOT sent on the wire)
    this._jumpSeq = 0;         // wrapping one-shot counter for the jump edge (latest-wins-safe)

    this._pointerId = null;
    this._startY = 0;
    this._startT = 0;          // gesture start time (for the hop window)
    this._tuckT = 0;           // moment the tuck engaged (for the charge ramp)

    // keyboard fallback flags
    this._keyTuck = false;
    this._keyJumpDown = false;

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
    this._endTuck(false);  // never leave a tuck stuck on at run end (no jump fired)
    this._pointerId = null;
  }

  _down(e) {
    if (this._pointerId != null) return;        // single active pointer
    this._pointerId = e.pointerId;
    this._startY = e.clientY;
    this._startT = performance.now();
    e.preventDefault();                          // stop iOS pull-to-refresh / scroll
  }
  _move(e) {
    if (e.pointerId !== this._pointerId) return;
    const dy = e.clientY - this._startY;
    // Engage tuck once the finger has travelled down past the threshold.
    if (!this._tucking && dy > TUCK_THRESHOLD_PX) {
      this._tucking = true;
      this._tuckT = performance.now();
      this._charge = 0;
      this.onTuckStart();
    }
    if (this._tucking) {
      this._charge = clamp01((performance.now() - this._tuckT) / MAX_CHARGE_MS);
      this.onCharge(this._charge);
    }
  }
  _up(e) {
    if (e.pointerId !== this._pointerId) return;
    if (this._tucking) {
      // Release of a held tuck = crouch-release JUMP (charge ∝ hold time).
      this._endTuck(true);
    } else {
      // No tuck engaged — was it a quick UPWARD flick? Then it's a hop.
      const dy = e.clientY - this._startY;
      const dt = performance.now() - this._startT;
      if (dy < -HOP_THRESHOLD_PX && dt < HOP_MAX_MS) this._bumpJump();
    }
    this._pointerId = null;
  }

  // End the tuck. fireJump=true bumps the wrapping jump counter (release edge).
  _endTuck(fireJump) {
    if (!this._tucking) return;
    const charge = this._charge;
    this._tucking = false;
    this._charge = 0;
    this.onCharge(0);
    if (fireJump) this._bumpJump();
    this.onTuckEnd(charge);
  }

  // Bump the wrapping jump sequence. The display fires ONE jump per change, so a
  // dropped fastlane frame just re-delivers the same value (no double/missed pop).
  _bumpJump() { this._jumpSeq = (this._jumpSeq + 1) & 255; }

  // latest-state-wins fields the CONTROL tick reads each frame.
  //   t : tuck 0|1 (held, idempotent)   j : wrapping jump sequence 0..255
  get state() { return { t: this._tucking ? 1 : 0, j: this._jumpSeq }; }

  // live local charge (0..1) for the HUD meter — NOT part of the wire payload.
  get charge() { return +this._charge.toFixed(3); }

  // --- keyboard fallback / testing (works over plain HTTP — no touchscreen) ---
  // Hold ArrowDown/S = tuck; release fires the crouch-release jump. ArrowUp/Space
  // = an instant hop (bump j on the leading edge so auto-repeat doesn't spam).
  _bindKeys() {
    if (typeof window === 'undefined') return;
    const ramp = () => {
      if (!this._keyTuck) return;
      this._charge = clamp01((performance.now() - this._tuckT) / MAX_CHARGE_MS);
      this.onCharge(this._charge);
    };
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'arrowdown' || k === 's') {
        if (!this._keyTuck) {
          this._keyTuck = true; this._tucking = true; this._tuckT = performance.now();
          this._charge = 0; this.onTuckStart();
          // ramp the charge meter while held (the touch path ramps on pointermove,
          // but a held key emits no move events, so tick it ourselves)
          this._keyRamp = setInterval(ramp, 1000 / 30);
        }
        e.preventDefault();
      } else if (k === 'arrowup' || k === ' ') {
        if (!this._keyJumpDown) {
          // a held tuck released by the JUMP key still counts as a crouch-release;
          // otherwise it's a bare hop.
          if (this._keyTuck) this._releaseKeyTuck(true);
          else this._bumpJump();
        }
        this._keyJumpDown = true;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'arrowdown' || k === 's') { this._releaseKeyTuck(true); e.preventDefault(); }
      else if (k === 'arrowup' || k === ' ') { this._keyJumpDown = false; e.preventDefault(); }
    });
  }
  _releaseKeyTuck(fireJump) {
    if (!this._keyTuck) return;
    this._keyTuck = false;
    if (this._keyRamp) { clearInterval(this._keyRamp); this._keyRamp = null; }
    this._endTuck(fireJump);
  }
}
