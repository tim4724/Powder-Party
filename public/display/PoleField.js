// PoleField — the edge markers (alternating slalom poles) along the groomed
// piste, plus their break-off behaviour: a skier hitting one snaps it clean off
// its base — it inherits the skier's momentum, tumbles off-piste, and sinks
// nose-first into the deep snow, where it stays for the rest of the run (reset()
// stands every pole back up). Purely cosmetic — the engine never sees the poles;
// contact runs through the engine's hitSL, the same primitive as every other
// object. STARTING VALUES — tune by feel.
import * as THREE from 'three';
import { hitSL, SKI_HALF } from './engine/SkiEngine.js';
import { debugCircle } from './SlopeScenery.js';

const POLE_R = 0.06;        // the pole's footprint = its cylinder radius
const CAP_OFFS = [-SKI_HALF, 0, SKI_HALF]; // the engine's capsule sampling, mirrored for the pole test
const POLE_FWD = 0.75;      // fraction of skier speed the pole carries down-slope
const POLE_OUT = 3.0;       // outward knock (u/s) at POLE_REF_V — clears the piste into the powder
const POLE_POP = 4.5;       // upward pop (u/s) at POLE_REF_V
const POLE_G = 16;          // flight gravity (u/s², along the slope normal)
const POLE_SPIN = 9;        // end-over-end tumble rate (rad/s) at POLE_REF_V, varied ±25% per hit
const POLE_REF_V = 14;      // impact speed (u/s) giving the nominal knock — ~upright cruise
const POLE_KICK_MIN = 0.35; // a slow brush still snaps the pole off, it just flops nearby
const POLE_KICK_MAX = 1.4;  // full-tuck schuss sends it flying — capped so it stays in view
const POLE_SINK = 0.3;      // nose-down pitch of the landed pole (tip ends under the snow)

const _up = new THREE.Vector3(0, 1, 0);

export class PoleField {
  // Stands the poles up along the GROOMED edge (±pisteHalf) — they mark where
  // the deep snow starts and double as depth/speed cues. They stand
  // WORLD-vertical (like real slalom poles): plumb posts against the tilted
  // piste are the strongest in-frame steepness cue the chase cam gets. The 0.05
  // base embed covers the downhill-edge gap a vertical pole leaves on the
  // steepest pitch.
  constructor(group, samples, pisteHalf, centerline, length, hitboxDebug) {
    this.onHit = null;             // (kick 0.35..1.4) — impact-speed scale for SFX
    this._pisteHalf = pisteHalf;
    this._cl = centerline;
    this._clLength = length;
    this._poles = [];
    this._active = new Set();      // poles currently tumbling through the air
    this._kick = new THREE.Vector3(); // scratch
    this._off = new THREE.Vector3();

    const poleGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.1, 6);
    poleGeo.translate(0, 0.55, 0); // origin at the base (flight code re-centres tumbles)
    const blue = new THREE.MeshStandardMaterial({ color: 0x2d9cdb });
    const red = new THREE.MeshStandardMaterial({ color: 0xe6492d });
    const n = samples.length;
    for (let i = 2; i < n - 2; i += 5) {
      const s = samples[i];
      const side = (i % 10 === 2) ? 1 : -1;
      const ex = s.pos.x + s.lateral.x * pisteHalf * side;
      const ey = s.pos.y + s.lateral.y * pisteHalf * side;
      const ez = s.pos.z + s.lateral.z * pisteHalf * side;
      const pole = new THREE.Mesh(poleGeo, side > 0 ? red : blue);
      pole.position.set(ex, ey - 0.05, ez); // base-origin geo: -0.05 = the embed
      group.add(pole);
      const p = {
        mesh: pole, s: s.s, lat: pisteHalf * side,
        bx: ex, by: ey - 0.05, bz: ez,       // home pose, restored on reset()
        mode: 0, // 0 standing · 1 tumbling through the air · 2 sunk in the snow
        fs: 0, flat: 0, h: 0, vs: 0, vlat: 0, vh: 0, // flight state in (s, lat, height)
        spinAxis: new THREE.Vector3(), spinRate: 0, spinAng: 0,
        hitMark: null, // ?hitbox=1 wireframe (hidden while the pole is knocked over)
      };
      if (hitboxDebug) {
        p.hitMark = debugCircle(s, pisteHalf * side, POLE_R, 0x2bb673);
        group.add(p.hitMark);
      }
      this._poles.push(p);
    }
  }

  // Break-off contact: a grounded skier reaching an edge pole snaps it off its
  // base. Same hitSL primitive + capsule sampling as every engine collision —
  // tail/centre/nose circles (radius + heading off the snapshot) vs the pole's
  // footprint. `holder` is any per-skier object that survives across frames
  // (the renderer's skier record) — the previous-frame s is stashed on it so
  // the swept test can cover the stretch travelled since last frame.
  poke(s, holder) {
    if (this._poles.length === 0 || s.totalS == null) return;
    const prev = holder._pokeS != null ? holder._pokeS : s.totalS;
    holder._pokeS = s.totalS; // track through the air too — landing must not sweep the overflown stretch
    if (s.air > 0.9) return; // sailing over — the poles are only 1.1 tall
    const reach = (s.radius || 0.3) + POLE_R;
    // a hard carve swings the ski tips up to SKI_HALF sideways — allow for it
    if (Math.abs(Math.abs(s.lat) - this._pisteHalf) > reach + SKI_HALF) return; // not near either edge line
    // Sweep the stretch covered since the last frame (as the rect core of the
    // same hitSL test) — the honest reach is narrower than one frame-step at
    // full schuss, so a point test would skip poles. A jump bigger than any
    // real step is a run-reset teleport, not travel.
    let halfS = Math.abs(s.totalS - prev) / 2;
    if (halfS > 2) halfS = 0;
    const mid = halfS > 0 ? (s.totalS + prev) / 2 : s.totalS;
    const hs = Math.cos(s.heading || 0), hl = -Math.sin(s.heading || 0); // ski direction in (s, lat)
    for (const p of this._poles) {
      if (p.mode !== 0) continue;
      let touched = false;
      for (const e of CAP_OFFS) {
        if (hitSL(p.s - (mid + e * hs), p.lat - (s.lat + e * hl), reach, halfS)) { touched = true; break; }
      }
      if (!touched) continue;
      p.mode = 1;
      if (p.hitMark) p.hitMark.visible = false; // knocked off → no contact test until reset
      p.fs = p.s; p.flat = p.lat; p.h = 0.55; // flight tracks the pole's CENTRE
      // The whole launch scales with impact speed: a braking skier nudges the
      // pole over, a tucked one at full schuss sends it cartwheeling.
      const kick = Math.min(POLE_KICK_MAX, Math.max(POLE_KICK_MIN, (s.v || 0) / POLE_REF_V));
      p.vs = (s.v || 0) * POLE_FWD;
      p.vlat = Math.sign(p.lat) * POLE_OUT * kick * (0.8 + 0.4 * Math.random()); // outward, into the powder
      p.vh = POLE_POP * kick;
      p.spinRate = POLE_SPIN * kick * (0.75 + 0.5 * Math.random());
      p.spinAng = 0;
      // end-over-end: tumble about the horizontal axis ⊥ the knock direction
      const f = this._cl.sampleAt(p.s);
      const v = this._kick.copy(f.tangent).multiplyScalar(p.vs).addScaledVector(f.lateral, p.vlat);
      p.spinAxis.crossVectors(_up, v).normalize();
      this._active.add(p);
      if (this.onHit) this.onHit(kick); // clack SFX — renderer-only event, so it can't ride onRaceEvent
    }
  }

  // Flight + respawn for broken-off poles. Flight runs in the slope's
  // (s, lat, height) frame — gravity along the local normal — so the tumble
  // follows the descending terrain and lands on the snow whatever the pitch.
  // Standing poles cost nothing: only members of _active update.
  update(dt) {
    if (this._active.size === 0) return;
    for (const p of this._active) { // active = airborne poles only
      p.vh -= POLE_G * dt;
      p.fs += p.vs * dt; p.flat += p.vlat * dt; p.h += p.vh * dt;
      p.spinAng += p.spinRate * dt;
      const f = this._cl.sampleAt(Math.max(0, Math.min(this._clLength, p.fs)));
      if (p.h < 0.1 && p.vh < 0) {
        // touchdown: lie along the knock direction, nose sunk into the snow —
        // and stay there (done moving → out of the active set)
        p.mode = 2;
        const lie = this._kick.copy(f.tangent).multiplyScalar(p.vs).addScaledVector(f.lateral, p.vlat);
        lie.addScaledVector(f.up, -POLE_SINK * lie.length()).normalize();
        p.mesh.quaternion.setFromUnitVectors(_up, lie);
        p.mesh.position.copy(f.pos).addScaledVector(f.lateral, p.flat).addScaledVector(f.up, 0.04)
          .addScaledVector(lie, -0.55); // base-origin geo: centre the lie on the landing point
        this._active.delete(p);
      } else {
        p.mesh.quaternion.setFromAxisAngle(p.spinAxis, p.spinAng);
        const off = this._off.set(0, 0.55, 0).applyQuaternion(p.mesh.quaternion); // origin → centre
        p.mesh.position.copy(f.pos).addScaledVector(f.lateral, p.flat).addScaledVector(f.up, p.h).sub(off);
      }
    }
  }

  // Stand every knocked pole back up (the start of each run resets the field).
  reset() {
    for (const p of this._poles) {
      if (p.mode === 0) continue;
      p.mode = 0;
      p.mesh.position.set(p.bx, p.by, p.bz);
      p.mesh.quaternion.identity();
      if (p.hitMark) p.hitMark.visible = true;
    }
    this._active.clear();
  }
}
