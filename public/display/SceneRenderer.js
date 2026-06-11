// SceneRenderer — Three.js renderer for the downhill slope: per-player
// split-screen chase cameras, primitive skiers (no GLB assets), and an orbiting
// lobby preview. Each player's viewport renders DIRECTLY to the canvas (no
// offscreen MSAA present pipeline) and there is no ground-conform raycast — the
// engine's poses already sit on the procedural surface (pose.pos includes
// lateral offset + air height). Static world construction lives in
// SlopeScenery.js; the cosmetic edge-pole break-off in PoleField.js.
//
// Public API (called by main.js): constructor(container, colors),
// setTrack(track,{debug,hitbox}), addSkier(id,colorIndex,name,opts), removeSkier(id),
// setSkierPose(id, snap), setSkierHud(id,info), start(), stop(), onFrame, orbit.
import * as THREE from 'three';
import { SkiTrails } from './SkiTrails.js';
import { SKI_HALF } from './engine/SkiEngine.js';
import { PoleField } from './PoleField.js';
import {
  extendMeshSamples, addTerrain, addPeaks, addForests,
  addRamp, addObstacle, addBanner, debugSkierCapsule,
} from './SlopeScenery.js';

// ---- camera + feel constants (starting values) --------------------------
const CHASE_DIST = 4.2;     // how far behind the skier the cam sits (tightened twice — 7.4 then 6.0 still read far)
const CHASE_HEIGHT = 2.45;  // how far above (keeps ~the old 7.4:4.4 angle so the slope ahead still reads over the roll)
const CHASE_LOOK = 11.0;    // how far ahead it looks
const CHASE_TGT_UP = -0.6;  // aim slightly DOWN-slope (toward the piste ahead, not the horizon)
const CAM_UP_WORLD = 0.5;   // height/up blend: 0 = rig fully in the slope frame (pitch-invariant), 1 = gravity
const CAM_POS_RATE = 6.0;   // position damping (1-exp(-rate*dt))
const CAM_TGT_RATE = 11.0;
const MAX_CAM_DIST = 6.5;   // cap on cam→skier distance: the damped follow trails a moving skier by
                            // ~v/CAM_POS_RATE (≈4u at race pace, more on boost), stretching the chase
                            // well past the rig's intent — speed must not push the skier away
const BASE_FOV = 58;        // calmer lens than the old 64 — wide-angle miniaturised the skier
const FOV_GAIN = 0.3;       // FOV widens with speed (sells velocity; the counter-dolly holds the skier's size)
const AIR_FOV = 6;          // extra FOV while airborne
const TAN_HALF_BASE = Math.tan(BASE_FOV * Math.PI / 360); // counter-dolly reference (see _updateChase)
const CELL_DOLLY = 0.75;    // short-cell compensation: the WHOLE rig (cam + look target) scales by
                            // cellFrac^this in a half-height cell, recovering most of the skier's pixel
                            // size while preserving the full-screen composition (all angles unchanged —
                            // a lens-zoom was tried instead and cropped the skier at the cell bottom)
const LOBBY_ORBIT_SPEED = 0.12; // rad/s

const BANK_MAX = 0.5;       // body bank (rad) into a full carve
const TUCK_PITCH = 0.72;    // forward lean (rad) when fully tucked
const TUCK_SHRINK = 0.3;    // squat: body shrinks toward the feet when tucked (0 = none)

const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _TAU = Math.PI * 2;       // one full flip rotation

function bestGrid(n, W, H) {
  let best = { cols: 1, rows: n, cost: Infinity };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellAspect = (W / cols) / (H / rows);
    const cost = Math.abs(Math.log(cellAspect)) + (cols * rows - n) * 0.4;
    if (cost < best.cost) best = { cols, rows, cost };
  }
  return best;
}

export class SceneRenderer {
  constructor(container, colors) {
    this.container = container;
    this.colors = colors || [];
    this.skiers = new Map();
    this._order = [];          // celled (human) skiers, stable split-screen order
    this.onFrame = null;
    this.onPoleHit = null;     // (kick 0.35..1.4) — an edge pole snapped off; impact-speed scale for SFX
    this.poles = null;         // PoleField, built per setTrack
    this.orbit = false;
    this._running = false;
    this._last = 0;
    this._frameDt = 0;

    // scratch (hot path allocates nothing)
    this._sx = new THREE.Vector3();
    this._sy = new THREE.Vector3();
    this._sz = new THREE.Vector3();
    this._sBasis = new THREE.Matrix4();
    this._sWant = new THREE.Vector3();
    this._sTarget = new THREE.Vector3();
    this._sTrickAxis = new THREE.Vector3();
    this._sCamUp = new THREE.Vector3();

    this._initThree();
    this._initOverlay();
    window.addEventListener('resize', () => this._onResize());
  }

  _initThree() {
    const r = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setSize(window.innerWidth, window.innerHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping rolls bright values off smoothly instead of hard-clipping to
    // flat white — so bright snow stays white BUT keeps a light→shadow gradient
    // (the mountain shapes stay readable). Khronos "Neutral" keeps whites neutral
    // (ACES/Filmic would add the beige cast we don't want).
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.25;
    r.autoClear = false;                  // we clear once per frame, then render N viewports
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap; // (PCFSoft is deprecated in the vendored three and falls back to this)
    this.container.appendChild(r.domElement);
    this.renderer = r;
    this._blobTex = this._makeBlobTexture(); // soft contact-shadow sprite

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xbfe3f7);              // bright alpine sky
    scene.fog = new THREE.Fog(0xf1f6fc, 110, 360);            // bright snowy haze (far enough for the peaks)
    this.scene = scene;

    // Three.js uses physically-based lights: a light of intensity 1 yields only
    // ~1/π (~0.32) diffuse on a white surface, so modest intensities leave white
    // snow at flat grey (~0.5–0.6). We push intensities ~π× higher so white snow
    // actually renders white, with a STRONG sky fill (physically right — snow
    // bounces ~90% of light, so its shadows stay bright, not grey) and a softer
    // sun on top for mountainside form.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xeaf2fb, 1.9)); // sky fill (keeps shadows light, not grey)
    const key = new THREE.DirectionalLight(0xffffff, 2.7);         // strong neutral sun → shape-defining gradient
    key.position.set(8, 15, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.autoUpdate = false;        // refreshed once per frame in _loop (not once per viewport)
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.06;
    scene.add(key); scene.add(key.target);
    this._key = key;

    // Surrounding snow field (the slope ribbon sits on top of it).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1200),
      new THREE.MeshStandardMaterial({ color: 0xf4f8fc, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.ground = ground;

    this.slopeGroup = new THREE.Group(); scene.add(this.slopeGroup);
    this.propGroup = new THREE.Group(); scene.add(this.propGroup);
    // Lobby-only decoration (instanced flank forest). Shown under the single
    // overview camera, hidden the moment skiers render in split-screen — so the
    // race (up to 4 viewports) never pays for it. See _loop / addForests.
    this.lobbyGroup = new THREE.Group(); scene.add(this.lobbyGroup);

    this.overview = new THREE.PerspectiveCamera(52, this._aspect(), 0.1, 1200);
    this.overview.position.set(30, 28, 30);
    this._ovTarget = new THREE.Vector3();
    this._orbitAngle = Math.atan2(0.9, 0.6);

    // Ski tracks carved into the snow behind every skier (cosmetic; fed from
    // setSkierPose, cleared on setTrack + at the start of each run).
    this.trails = new SkiTrails(scene);
  }

  _initOverlay() {
    const o = document.createElement('div');
    o.className = 'race-labels';
    o.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:3;';
    this.container.appendChild(o);
    this.overlay = o;
  }

  // Soft radial blob (dark centre fading to transparent) for a subtle contact
  // shadow with no hard edge.
  _makeBlobTexture() {
    const s = 64;
    const c = document.createElement('canvas'); c.width = c.height = s;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(38,64,92,0.5)');
    g.addColorStop(0.55, 'rgba(38,64,92,0.22)');
    g.addColorStop(1, 'rgba(38,64,92,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _aspect() { return window.innerWidth / Math.max(1, window.innerHeight); }
  _onResize() { this.renderer.setSize(window.innerWidth, window.innerHeight); }

  // ---- world geometry --------------------------------------------------
  setTrack(track, opts = {}) {
    this._disposeGroup(this.slopeGroup);
    this._disposeGroup(this.propGroup);
    this._disposeGroup(this.lobbyGroup);
    if (this.trails) this.trails.clear();
    this._hitboxDebug = !!opts.hitbox; // ?hitbox=1 — wireframe collision footprints

    const samples = track.centerline.samples;
    const sw = track.slopeWidth || 11;
    const pisteHalf = sw / 2;          // groomed-piste edge (where poles + deep snow begin)
    const edgeLat = sw;                // deep snow extends a half-slope-width past = the reset line
    const groundY = track.groundY != null ? track.groundY : -2;
    this._pisteHalf = pisteHalf;

    // Terrain ribbon + valley walls/flanks (renderer-extended samples), the
    // breakable edge poles, then the props — all collidable footprints match
    // what the engine resolves from the same track data.
    addTerrain(this.slopeGroup, extendMeshSamples(samples), pisteHalf, edgeLat, groundY);
    this.poles = new PoleField(this.slopeGroup, samples, pisteHalf, track.centerline, track.length, this._hitboxDebug);
    this.poles.onHit = (kick) => { if (this.onPoleHit) this.onPoleHit(kick); };

    const cl = track.centerline;
    for (const r of (track.ramps || [])) addRamp(this.propGroup, cl, r, this._hitboxDebug);
    for (const o of (track.obstacles || [])) addObstacle(this.propGroup, cl, o, this._hitboxDebug);
    addBanner(this.propGroup, cl, 0.2, 0x2bb673);                 // start
    addBanner(this.propGroup, cl, track.length - 0.2, 0xf2b134);  // finish

    // Overview framing for the lobby turntable + size the shadow camera.
    const box = new THREE.Box3();
    for (const s of samples) box.expandByPoint(s.pos);
    this._trackCenter = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z) * 0.5 + 12;
    const dist = radius / Math.tan((this.overview.fov * Math.PI / 180) / 2) * 0.95;
    const ovDir = new THREE.Vector3(0.5, 0.7, 0.9).normalize();
    this._ovPos = this._trackCenter.clone().add(ovDir.clone().multiplyScalar(dist));
    this._ovTarget = this._trackCenter.clone();
    const ovOff = this._ovPos.clone().sub(this._trackCenter);
    this._ovRadius = Math.hypot(ovOff.x, ovOff.z);
    this._ovHeight = ovOff.y;
    this._orbitAngle = Math.atan2(ovOff.z, ovOff.x); // start the orbit where the static frame sits (no first-frame snap)

    // Valley floor: centre the snow plane UNDER the whole run and grow it to cover
    // out past the peaks. It sits at the finish elevation so the flanks meet it
    // seamlessly.
    const groundSpan = Math.max(size.x, size.z) + this._ovRadius * 3;
    this.ground.position.set(this._trackCenter.x, groundY, this._trackCenter.z);
    this.ground.scale.set(groundSpan / 1200, groundSpan / 1200, 1);

    const half = Math.max(size.x, size.y, size.z) * 0.5 + 6;
    const k = this._key;
    k.target.position.copy(this._trackCenter); k.target.updateMatrixWorld();
    k.position.copy(this._trackCenter).add(new THREE.Vector3(8, 16, 6).normalize().multiplyScalar(half * 2.2));
    const sc = k.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = half * 0.5; sc.far = half * 4 + 16;
    sc.updateProjectionMatrix();
    k.shadow.needsUpdate = true;

    // Scale fog + the far-planes to the ACTUAL track size, keyed off the lobby
    // orbit radius — so the encircling peaks stay crisp up close and only haze
    // out in the far distance, on any length of run.
    const R = this._ovRadius || 200;
    this.scene.fog.near = R * 0.55;
    this.scene.fog.far = R * 2.9;
    this._camFar = Math.max(1200, R * 4.4);
    this.overview.far = this._camFar;
    this.overview.updateProjectionMatrix();
    // Per-skier chase cams must reach as far as the overview, or the distant
    // peaks/flanks clip out of the gameplay view on a tall slope. Update any that
    // already exist (skiers are normally added after setTrack, but be safe).
    for (const c of this.skiers.values()) { if (c.cam) { c.cam.far = this._camFar; c.cam.updateProjectionMatrix(); } }

    // distant snow peaks + the alpine forests → a snowy mountain
    addPeaks(this.slopeGroup, this._trackCenter, this._ovRadius, this.ground.position.y);
    addForests(this.slopeGroup, this.lobbyGroup, samples, edgeLat, groundY, track.def && track.def.id);
  }

  // ---- skiers ----------------------------------------------------------
  addSkier(id, colorIndex, name, opts = {}) {
    const color = new THREE.Color(this.colors[colorIndex % this.colors.length] || '#2d9cdb');
    const group = new THREE.Group();

    // skis. The skier casts NO hard sun-shadow — only the soft contact blob below
    // (added further down) marks its position. A cast shadow would somersault and
    // detach during a flip, reading as a confusing second shadow; the blob stays a
    // clean disc on the snow and shows height via its size/fade. (Props + terrain
    // keep their cast shadows for scene depth.)
    const skiMat = new THREE.MeshStandardMaterial({ color: 0x26313f, roughness: 0.6 });
    for (const sx of [-0.16, 0.16]) {
      const ski = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 1.5), skiMat);
      ski.position.set(sx, 0.03, 0.15);
      group.add(ski);
    }
    // body pivot (banks + tucks)
    const body = new THREE.Group();
    body.position.y = 0.0;
    group.add(body);

    const suit = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xf0c9a0, roughness: 0.8 });
    // ONE rounded body (no separate legs) — short + stout, base resting on the
    // skis. The body-group origin sits at the feet, so banking + the squat shrink
    // pivot around the base and the body never dips through the snow.
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.28, 5, 12), suit);
    torso.position.y = 0.41; body.add(torso); // base ≈ y=0.03 (no cast shadow — see skis above)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 12), skin);
    head.position.y = 0.8; body.add(head);
    const hat = new THREE.Mesh(new THREE.SphereGeometry(0.21, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), suit);
    hat.position.y = 0.85; body.add(hat);

    const cam = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, this._camFar || 1200);

    // soft contact shadow — a faded sprite laid flush on the slope each frame
    // (oriented in setSkierPose so it can't clip through the tilted surface)
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({ map: this._blobTex, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false })
    );

    this.scene.add(group);
    this.scene.add(blob);

    let label = null, steerBar = null, steerFill = null;
    const celled = opts.cell !== false;
    if (celled) {
      const hex = this.colors[colorIndex % this.colors.length] || '#2d9cdb';
      label = document.createElement('div');
      label.className = 'cell-label';
      label.style.setProperty('--c', hex);
      label.innerHTML = `<span class="cell-label__name"></span><span class="cell-label__stat"></span>`;
      label.querySelector('.cell-label__name').textContent = name || '';
      this.overlay.appendChild(label);
      // on-screen steer indicator for this cell (mirrors the phone's carve bar):
      // a centre-anchored fill that slides with the lean, in the player's livery.
      steerBar = document.createElement('div');
      steerBar.className = 'cell-steer';
      steerBar.style.setProperty('--c', hex);
      steerBar.innerHTML = `<div class="cell-steer__fill"></div>`;
      this.overlay.appendChild(steerBar);
      steerFill = steerBar.querySelector('.cell-steer__fill');
      if (!this._order.includes(id)) this._order.push(id);
    }

    this.skiers.set(id, {
      id, group, body, cam, blob, label, steerBar, steerFill, name,
      colorIndex, celled,
      reconnecting: false, reconnectEl: null, // dropped-player reconnect card, centred in this cell by _loop
      camPos: new THREE.Vector3(), camTarget: new THREE.Vector3(),
      fov: BASE_FOV, init: false, lean: 0, tuckAmt: 0, pose: null, finished: false,
    });
  }

  removeSkier(id) {
    const c = this.skiers.get(id);
    if (!c) return;
    this.scene.remove(c.group); this.scene.remove(c.blob);
    this._disposeGroup(c.group);
    c.blob.geometry.dispose(); c.blob.material.dispose();
    if (c.label && c.label.parentNode) c.label.parentNode.removeChild(c.label);
    if (c.steerBar && c.steerBar.parentNode) c.steerBar.parentNode.removeChild(c.steerBar);
    if (c.reconnectEl && c.reconnectEl.parentNode) c.reconnectEl.parentNode.removeChild(c.reconnectEl);
    this.skiers.delete(id);
    const i = this._order.indexOf(id);
    if (i >= 0) this._order.splice(i, 1);
  }

  // Re-key a skier's render entry from one id to another (a dropped player
  // reconnects on a different device). Keeps the same meshes, label and
  // split-screen cell — only the id it's filed under changes, so the chase camera
  // keeps following it. The reconnect card is dropped: a re-key means the seat's back.
  rekeySkier(oldId, newId) {
    if (oldId === newId) return false;
    const c = this.skiers.get(oldId);
    if (!c || this.skiers.has(newId)) return false;
    this.setSkierReconnect(oldId, null);
    c.id = newId;
    this.skiers.delete(oldId);
    this.skiers.set(newId, c);
    for (let i = 0; i < this._order.length; i++) {
      if (this._order[i] === oldId) this._order[i] = newId;
    }
    return true;
  }

  // Show (el) or clear (null) a dropped player's reconnect card, centred in their
  // split-screen cell by _loop. `el` is the card DOM built by the display layer
  // (carries the rejoin QR). No-op if the skier has no cell (e.g. a CPU racer or
  // an unknown id) — reconnect cards only show in a human's cell.
  setSkierReconnect(id, el) {
    const c = this.skiers.get(id);
    if (!c || !c.label) return false; // cell-less / unknown skier → nowhere to centre it
    if (c.reconnectEl && c.reconnectEl !== el && c.reconnectEl.parentNode) {
      c.reconnectEl.parentNode.removeChild(c.reconnectEl);
    }
    if (!el) { c.reconnectEl = null; c.reconnecting = false; return true; }
    c.reconnectEl = el;
    c.reconnecting = true;
    if (el.parentNode !== this.overlay) this.overlay.appendChild(el);
    return true;
  }

  // Pose + per-frame visual state, fed one engine-snapshot skier (getSnapshot()
  // shape): pose {pos,forward,up}, v, carve (turn-aligned) / carveInput (raw),
  // tuck, airborne, air, spin, trickActive/trickAngle/trickPhase, plus
  // totalS/lat/heading/radius for the edge-pole contact test.
  setSkierPose(id, s) {
    const c = this.skiers.get(id);
    if (!c) return;
    if (this._hitboxDebug && !c.hitRing) {
      // Built here, not in addSkier: the per-skier radius rides the snapshot.
      // ONE capsule — the footprint every contact (skier/tree/ramp/pole) uses.
      c.hitRing = debugSkierCapsule(s.radius || 0.3, SKI_HALF, 0xff8c00);
      c.group.add(c.hitRing);
    }
    const pos = s.pose.pos;
    c.spd = s.v; c.airborne = s.airborne;
    if (!c.pose) c.pose = { pos: new THREE.Vector3(), forward: new THREE.Vector3(), up: new THREE.Vector3() };
    c.pose.pos.copy(pos);
    c.pose.forward.copy(s.pose.forward).normalize();
    c.pose.up.copy(s.pose.up).normalize();

    c.group.position.copy(pos);
    // orientation basis: z = forward (down-slope), x = up × z, y = z × x
    const z = this._sz.copy(c.pose.forward);
    const x = this._sx.copy(c.pose.up).cross(z).normalize();
    const y = this._sy.copy(z).cross(x).normalize();
    c.group.quaternion.setFromRotationMatrix(this._sBasis.makeBasis(x, y, z));
    // wipeout spin about the slope normal (cosmetic)
    if (s.spin) c.group.rotateY(s.spin);
    // air trick: somersault the WHOLE skier about an ANALOG axis built from the
    // flick angle — pitch (local x) = front/back flip, yaw (local y) = spin, a
    // blend = a cork. The chase cam tracks pose.forward (not the group), so the
    // view holds steady while the skier flips.
    if (s.trickActive) {
      const tax = this._sTrickAxis.set(-Math.sin(s.trickAngle), Math.cos(s.trickAngle), 0).normalize();
      c.group.rotateOnAxis(tax, s.trickPhase * _TAU);
    }

    // body: bank INTO the carve (negated — +carve is turn-aligned, and a positive
    // local-Z roll tilts the torso the opposite way), crouch + pitch when tucking
    const dt = this._frameDt || 0.016;
    c.lean += (-s.carve * BANK_MAX - c.lean) * Math.min(1, dt * 12);
    c.tuckAmt += ((s.tuck ? 1 : 0) - c.tuckAmt) * Math.min(1, dt * 10);
    c.body.rotation.z = c.lean;
    c.body.rotation.x = c.tuckAmt * TUCK_PITCH + (s.airborne ? -0.2 : 0);
    // squat: shrink toward the feet (pivot is at the base) rather than dropping the
    // body — keeps the whole skier above the snow, so it can't clip the surface.
    c.body.scale.setScalar(1 - c.tuckAmt * TUCK_SHRINK);

    // contact shadow: lay it FLUSH on the (tilted) slope under the skier — normal
    // = slope up, lifted a hair ALONG that normal so it can't clip through the
    // surface (pose includes air height → subtract it to find the surface point).
    c.blob.position.copy(pos).addScaledVector(c.pose.up, -s.air + 0.04);
    c.blob.quaternion.setFromUnitVectors(_zAxis, c.pose.up);
    const sh = Math.max(0.35, 1 - s.air * 0.09); // shrink + fade with height
    c.blob.scale.set(sh, sh, 1);
    c.blob.material.opacity = 0.42 * sh;

    // on-screen steer bar: mirror the player's RAW carve input (the way they tilt),
    // not the turn-aligned value — same convention as the phone's carve bar.
    if (c.steerFill) c.steerFill.style.transform = `translateX(${(s.carveInput * 50).toFixed(1)}%)`;

    // ski tracks: carve a groove into the snow under the skis (no-op while
    // airborne — fed the already-normalised pose basis, surface point when grounded).
    if (this.trails) this.trails.addPoint(id, pos, c.pose.forward, c.pose.up, s.airborne);

    if (this.poles) this.poles.poke(s, c);
  }

  // Wipe all tracks + stand every knocked pole back up (called at the start of
  // each run so a fresh race starts on fresh snow).
  clearTrails() {
    if (this.trails) this.trails.clear();
    if (this.poles) this.poles.reset();
  }

  setSkierHud(id, info) {
    const c = this.skiers.get(id);
    if (!c || !c.label) return;
    c.finished = !!(info.finished || info.dnf); // gates the steer bar (autopilot/parked skiers don't steer, in _loop)
    const stat = c.label.querySelector('.cell-label__stat');
    if (info.dnf) {
      stat.textContent = 'DNF';
      c.label.classList.add('is-finished');
    } else if (info.finished) {
      stat.textContent = `P${info.position} · ${info.finishTime ? info.finishTime.toFixed(1) + 's' : 'done'}`;
      c.label.classList.add('is-finished');
    } else {
      // Tucked is the default now, so don't tag it — flag only the active states:
      // a flip / airborne, or a deliberate brake (tuck released).
      let tag = '';
      if (info.airborne) tag = info.trickActive ? ' · FLIP' : ' · AIR';
      else if (!info.tuck) tag = ' · BRAKE';
      stat.textContent = `P${info.position}/${info.of}` + tag;
    }
  }

  _updateChase(c, dt, cellFrac = 1) {
    const { pos, forward, up } = c.pose;
    // FOV first — it feeds the counter-dolly below.
    const wantFov = BASE_FOV + (c.spd || 0) * FOV_GAIN + (c.airborne ? AIR_FOV : 0);
    c.fov += (wantFov - c.fov) * (1 - Math.exp(-6 * dt));
    // Cell compensation: a half-height cell (the 2×2 grid) renders the same view
    // in half the pixels, so the skier reads twice as far away. Scale the whole
    // rig (cam offset AND look target) in — a uniform scale preserves every
    // angle of the full-screen composition, just from closer up.
    const cell = Math.pow(cellFrac, CELL_DOLLY);
    // Counter-dolly: as the FOV widens with speed, pull the chase offset in so
    // the skier holds a constant angular size — speed reads as the world
    // stretching wide (mild vertigo-zoom), not as the skier drifting away.
    const dolly = (TAN_HALF_BASE / Math.tan(c.fov * Math.PI / 360)) * cell;
    // Gravity-blended camera up: a rig built purely from the slope frame rotates
    // WITH the terrain, so a 30° schuss framed identically to the 14° runout.
    // Blending the height offset + cam.up toward world-up keeps the horizon
    // honest and lets the piste visibly fall away on steeps.
    const camUp = this._sCamUp.copy(up).lerp(_up, CAM_UP_WORLD).normalize();
    const want = this._sWant.copy(pos).addScaledVector(forward, -CHASE_DIST * dolly).addScaledVector(camUp, CHASE_HEIGHT * dolly);
    const target = this._sTarget.copy(pos).addScaledVector(forward, CHASE_LOOK * cell).addScaledVector(up, CHASE_TGT_UP * cell);
    const aPos = 1 - Math.exp(-CAM_POS_RATE * dt);
    const aTgt = 1 - Math.exp(-CAM_TGT_RATE * dt);
    if (!c.init) { c.camPos.copy(want); c.camTarget.copy(target); c.init = true; }
    else { c.camPos.lerp(want, aPos); c.camTarget.lerp(target, aTgt); }
    // Speed-lag cap (persistent, so the lag can't wind up past it; scaled with
    // the cell rig like everything else).
    const maxD = MAX_CAM_DIST * cell;
    const d = c.camPos.distanceTo(pos);
    if (d > maxD) c.camPos.sub(pos).multiplyScalar(maxD / d).add(pos);
    c.cam.position.copy(c.camPos);
    c.cam.fov = c.fov;
    c.cam.up.copy(camUp);
    c.cam.lookAt(c.camTarget);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }
  stop() { this._running = false; }

  _loop(t) {
    if (!this._running) return;
    const rawMs = t - this._last;
    const dt = Math.min(rawMs / 1000, 0.05);
    this._last = t;
    this._frameDt = dt;
    if (this.onFrame) this.onFrame(dt);
    if (this.poles) this.poles.update(dt); // after onFrame: same-frame response to this tick's pokes

    const W = window.innerWidth, H = window.innerHeight;
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
    r.clear();
    if (this._key) this._key.shadow.needsUpdate = true;

    const ids = this._order.filter((id) => this.skiers.has(id));
    // Flank forest renders only under the single overview camera (lobby + the
    // all-CPU preview) — `_order` is empty when there are no human/celled skiers.
    // The moment humans render in split-screen chase cams it's hidden, so the
    // race pays nothing. `visible=false` skips it entirely in render traversal.
    this.lobbyGroup.visible = ids.length === 0;
    if (ids.length === 0) {
      // lobby / attract: single overview camera, slow orbit
      this.overview.aspect = W / H; this.overview.updateProjectionMatrix();
      if (this.orbit && this._trackCenter) {
        this._orbitAngle += LOBBY_ORBIT_SPEED * dt;
        this.overview.position.set(
          this._trackCenter.x + Math.cos(this._orbitAngle) * this._ovRadius,
          this._trackCenter.y + this._ovHeight,
          this._trackCenter.z + Math.sin(this._orbitAngle) * this._ovRadius);
      } else if (this._ovPos) {
        this.overview.position.lerp(this._ovPos, 0.05);
      }
      this.overview.lookAt(this._ovTarget);
      r.render(this.scene, this.overview);
      requestAnimationFrame((tt) => this._loop(tt));
      return;
    }

    const { cols, rows } = bestGrid(ids.length, W, H);
    const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
    ids.forEach((id, i) => {
      const c = this.skiers.get(id);
      if (!c.pose) return;
      const col = i % cols, row = Math.floor(i / cols);
      const x = col * cw;
      const yBottom = H - (row + 1) * ch; // GL viewport origin = lower-left
      this._updateChase(c, dt, ch / H);
      c.cam.aspect = cw / ch; c.cam.updateProjectionMatrix();
      r.setViewport(x, yBottom, cw, ch);
      r.setScissor(x, yBottom, cw, ch);
      r.setScissorTest(true);
      r.render(this.scene, c.cam);
      // While a dropped player's reconnect card owns the cell, the live HUD
      // (label + steer bar) is hidden so the card is the whole story for that seat.
      const rc = c.reconnecting && !!c.reconnectEl;
      // position the DOM label in the cell (CSS px, top-left origin)
      if (c.label) {
        c.label.style.display = rc ? 'none' : 'flex';
        c.label.style.left = (x + 14) + 'px'; c.label.style.top = (row * ch + 12) + 'px';
      }
      // steer bar: centred along the cell bottom, hidden once the skier finishes
      // (it's on autopilot then — the finish stat in the label says it all).
      if (c.steerBar) {
        c.steerBar.style.display = (c.finished || rc) ? 'none' : 'block';
        c.steerBar.style.left = (x + cw / 2) + 'px';
        c.steerBar.style.top = (row * ch + ch - 56) + 'px';
      }
      // Reconnect QR: centred in the dropped player's cell while their skier keeps
      // its place on the slope, so they (or a fresh phone) can scan and drop back in.
      if (c.reconnectEl) {
        c.reconnectEl.style.display = rc ? 'flex' : 'none';
        if (rc) {
          c.reconnectEl.style.left = (x + cw / 2) + 'px';
          c.reconnectEl.style.top = (row * ch + ch / 2) + 'px';
        }
      }
    });

    requestAnimationFrame((tt) => this._loop(tt));
  }

  _disposeGroup(g) {
    // Dedupe: geometries (e.g. the shared pole geo) and materials (shared across
    // peaks / flanks / the instanced forest) are reused by many meshes — dispose
    // each exactly once so we don't fire redundant 'dispose' events at the renderer.
    const geos = new Set(), mats = new Set();
    const disposeMat = (x) => { if (x && !mats.has(x)) { mats.add(x); x.dispose(); } };
    for (let i = g.children.length - 1; i >= 0; i--) {
      const o = g.children[i];
      o.traverse((m) => {
        if (m.geometry && !geos.has(m.geometry)) { geos.add(m.geometry); m.geometry.dispose(); }
        if (m.material) { Array.isArray(m.material) ? m.material.forEach(disposeMat) : disposeMat(m.material); }
        if (m.isInstancedMesh && m.dispose) m.dispose(); // free the GPU instance buffer
      });
      g.remove(o);
    }
  }
}
