// SceneRenderer — Three.js renderer for the downhill slope. Builds a procedural
// snow ribbon from the centerline, primitive skiers (no GLB assets), per-player
// split-screen chase cameras, and an orbiting lobby preview. Simplified from the
// reference kart renderer: it renders each player's viewport DIRECTLY to the
// canvas (no offscreen MSAA present pipeline) and skips the ground-conform
// raycast — the procedural ribbon means the engine's poses already sit on the
// surface (pose.pos already includes lateral offset + air height).
//
// Public API (called by main.js): constructor(container, colors), async load(),
// setTrack(track,{debug}), addSkier(id,colorIndex,name,opts), removeSkier(id),
// setSkierPose(...), setSkierHud(id,info), start(), stop(), onFrame, orbit.
import * as THREE from 'three';

// ---- camera + feel constants (starting values) --------------------------
const CHASE_DIST = 7.4;     // how far behind the skier the cam sits
const CHASE_HEIGHT = 4.4;   // how far above (raised so the slope ahead reads over the roll)
const CHASE_LOOK = 11.0;    // how far ahead it looks
const CHASE_TGT_UP = -0.6;  // aim slightly DOWN-slope (toward the piste ahead, not the horizon)
const CAM_POS_RATE = 6.0;   // position damping (1-exp(-rate*dt))
const CAM_TGT_RATE = 11.0;
const BASE_FOV = 64;
const FOV_GAIN = 0.45;      // FOV widens with speed (sells velocity)
const AIR_FOV = 6;          // extra FOV while airborne
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
    this._sSurf = new THREE.Vector3();

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
    r.shadowMap.type = THREE.PCFSoftShadowMap;
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
    key.shadow.autoUpdate = false;        // refreshed once per frame in _loop
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
    // race (up to 4 viewports) never pays for it. See _loop / _addOuterTrees.
    this.lobbyGroup = new THREE.Group(); scene.add(this.lobbyGroup);

    this.overview = new THREE.PerspectiveCamera(52, this._aspect(), 0.1, 1200);
    this.overview.position.set(30, 28, 30);
    this._ovTarget = new THREE.Vector3();
    this._orbitAngle = Math.atan2(0.9, 0.6);
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

  // No GLB assets — resolve immediately. (Kept async so main.js's load().then()
  // sequence matches the reference.)
  async load() { return Promise.resolve(); }

  // ---- world geometry --------------------------------------------------
  setTrack(track, opts = {}) {
    this._disposeGroup(this.slopeGroup);
    this._disposeGroup(this.propGroup);
    this._disposeGroup(this.lobbyGroup);

    const samples = track.centerline.samples;
    const sw = track.slopeWidth || 11;
    const pisteHalf = sw / 2;          // groomed-piste edge (where poles + deep snow begin)
    const edgeLat = sw;                // deep snow extends a half-slope-width past = the reset line

    // Extend the snow ribbon a short way BEHIND the start gate (s<0). The skiers
    // sit at the clamped s=0 frame, but the chase cam is parked UP-slope of them,
    // so without this the cam looks past the top edge into the void and the start
    // grid appears to float on nothing. We extrapolate flat back along the first
    // sample's up-slope direction (renderer-only — the physics centerline is
    // unchanged) so the groomed run continues naturally above the gate.
    const meshSamples = samples.slice();
    {
      const f0 = samples[0], BACK = 16, STEPS = 7;
      for (let k = 1; k <= STEPS; k++) {
        const d = (BACK * k) / STEPS;
        meshSamples.unshift({
          pos: f0.pos.clone().addScaledVector(f0.tangent, -d),
          tangent: f0.tangent.clone(), up: f0.up.clone(), lateral: f0.lateral.clone(),
          s: f0.s - d,
        });
      }
    }

    // Flat finish OUTRUN: level the run off into a flat apron past the finish
    // line, so it ends on a believable flat area instead of the ribbon edge
    // dropping into the sky. Renderer-only (the physics centerline is unchanged);
    // because every strip below is built from meshSamples, the groomed piste +
    // shoulders + valley walls all continue onto this flat.
    {
      const fE = samples[samples.length - 1];
      const flatT = new THREE.Vector3(fE.tangent.x, 0, fE.tangent.z);
      if (flatT.lengthSq() < 1e-6) flatT.set(0, 0, 1);
      flatT.normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const lateral = flatT.clone().cross(up).normalize();
      if (lateral.dot(fE.lateral) < 0) lateral.negate(); // align with the run's side → no twist at the join
      const OUT = 46, STEPS = 9;
      for (let k = 1; k <= STEPS; k++) {
        const d = (OUT * k) / STEPS;
        meshSamples.push({
          pos: new THREE.Vector3(fE.pos.x + flatT.x * d, fE.pos.y, fE.pos.z + flatT.z * d),
          tangent: flatT.clone(), up: up.clone(), lateral: lateral.clone(),
          s: fE.s + d,
        });
      }
    }

    // Two-tone snow ribbon: 4 verts per sample at [-edge, -piste, +piste, +edge].
    // The middle band (±piste) is bright groomed snow; the outer bands fade to a
    // colder, deeper powder — a clear visual "you've left the run" without a wall.
    // The run is carved into a snowy MOUNTAIN: a groomed piste (alternating
    // corduroy passes) + deep-snow shoulders, then snow RISING into mountainside
    // walls on each side — all built from the centerline so the whole valley
    // cross-section descends with the run. Near-white, no warm tint.
    const NB = 6;                       // groomer passes across the piste
    const PASS = 0xffffff, GROOVE = 0xf6f9fc, DEEP = 0xedf2f8, WALL = 0xf4f8fd;
    const n = samples.length;
    for (let p = 0; p < NB; p++) {      // groomed piste passes
      const a = -pisteHalf + (2 * pisteHalf) * (p / NB);
      const b = -pisteHalf + (2 * pisteHalf) * ((p + 1) / NB);
      this._addSlopeStrip(meshSamples, a, b, 0, 0, p % 2 === 0 ? PASS : GROOVE);
    }
    this._addSlopeStrip(meshSamples, -edgeLat, -pisteHalf, 0, 0, DEEP); // deep-snow shoulders
    this._addSlopeStrip(meshSamples, pisteHalf, edgeLat, 0, 0, DEEP);
    this._addSlopeStrip(meshSamples, -(edgeLat + 26), -edgeLat, 14, 0, WALL); // mountainside walls
    this._addSlopeStrip(meshSamples, -(edgeLat + 72), -(edgeLat + 26), 48, 14, WALL);
    this._addSlopeStrip(meshSamples, edgeLat, edgeLat + 26, 0, 14, WALL);
    this._addSlopeStrip(meshSamples, edgeLat + 26, edgeLat + 72, 14, 48, WALL);
    // Mountainside FLANKS: sweep from the valley-wall tops outward and DOWN to the
    // valley floor on both sides, so the elevated run sits on a solid massif
    // instead of a thin ribbon floating over the flat ground — which the rotating
    // lobby camera exposed from the side. The outer edge meets the ground plane
    // (groundY) exactly, so the whole mountain reads as one piece.
    this._addFlanks(meshSamples, edgeLat, (track.groundY != null ? track.groundY : -2));

    // Edge markers (alternating poles) along the GROOMED edge (±pisteHalf) — they
    // mark where the deep snow starts and double as depth/speed cues.
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.1, 6);
    const blue = new THREE.MeshStandardMaterial({ color: 0x2d9cdb });
    const red = new THREE.MeshStandardMaterial({ color: 0xe6492d });
    for (let i = 2; i < n - 2; i += 5) {
      const s = samples[i];
      const side = (i % 10 === 2) ? 1 : -1;
      const ex = s.pos.x + s.lateral.x * pisteHalf * side;
      const ey = s.pos.y + s.lateral.y * pisteHalf * side;
      const ez = s.pos.z + s.lateral.z * pisteHalf * side;
      const pole = new THREE.Mesh(poleGeo, side > 0 ? red : blue);
      pole.position.set(ex, ey + 0.5, ez);
      pole.quaternion.setFromUnitVectors(_up, s.up);
      this.slopeGroup.add(pole);
    }

    // Props.
    const cl = track.centerline;
    for (const r of (track.ramps || [])) this._addRamp(cl, r);
    for (const o of (track.obstacles || [])) this._addObstacle(cl, o);
    this._addBanner(cl, 0.2, 0x2bb673, 'start');
    this._addBanner(cl, track.length - 0.2, 0xf2b134, 'finish');

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
    // out past the peaks. (The default 1200² plane at the origin didn't even reach
    // the lower end of a long slope, leaving a void the flanks now drape into.) It
    // sits at the finish elevation so the flanks meet it seamlessly.
    const groundSpan = Math.max(size.x, size.z) + this._ovRadius * 3;
    this.ground.position.set(this._trackCenter.x, (track.groundY != null ? track.groundY : -2), this._trackCenter.z);
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

    // Scale fog + the overview far-plane to the ACTUAL track size. The slope is
    // procedural now — a long, tall descent — so the old fixed distances (tuned
    // for the ~300u hill) fogged the whole run AND every distant peak to flat
    // white, which is what made the lobby orbit look broken/incomplete. Key it
    // off the lobby orbit radius so the encircling peaks stay crisp up close and
    // only haze out in the far distance.
    const R = this._ovRadius || 200;
    this.scene.fog.near = R * 0.55;
    this.scene.fog.far = R * 2.9;
    this.overview.far = Math.max(1200, R * 4.4);
    this.overview.updateProjectionMatrix();

    // distant snow peaks + an alpine pine forest on the banks → a snowy mountain
    this._addPeaks(this._trackCenter, size);
    this._addScenery(samples, edgeLat);
    this._addOuterTrees(samples, edgeLat, (track.groundY != null ? track.groundY : -2));
  }

  // One snow strip from lateral offset offA→offB, optionally rising in world-Y
  // (riseA→riseB) to form mountainside terrain. computeVertexNormals so the flat
  // piste AND the tilted walls both light correctly.
  _addSlopeStrip(samples, offA, offB, riseA, riseB, color) {
    const n = samples.length;
    const pos = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      const s = samples[i], a = i * 6;
      pos[a] = s.pos.x + s.lateral.x * offA; pos[a + 1] = s.pos.y + s.lateral.y * offA + riseA; pos[a + 2] = s.pos.z + s.lateral.z * offA;
      pos[a + 3] = s.pos.x + s.lateral.x * offB; pos[a + 4] = s.pos.y + s.lateral.y * offB + riseB; pos[a + 5] = s.pos.z + s.lateral.z * offB;
    }
    const sidx = [];
    for (let i = 0; i < n - 1; i++) { const p = i * 2; sidx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(sidx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 }));
    m.receiveShadow = true;
    this.slopeGroup.add(m);
    return m;
  }

  // Mountainside flanks: a strip per side from the outer wall ring (lateral
  // ±(edgeLat+72), world-Y = sample + 48 — matching the top wall strip) sweeping
  // out and DOWN to the valley floor (absolute groundY). Closes the sky-gap under
  // the elevated run so it reads as a solid mountain from every orbit angle.
  _addFlanks(samples, edgeLat, groundY) {
    const offInner = edgeLat + 72, riseInner = 48, offOuter = edgeLat + 240;
    const mat = new THREE.MeshStandardMaterial({ color: 0xeef3f9, side: THREE.DoubleSide, roughness: 1, metalness: 0 });
    const n = samples.length;
    for (const sign of [-1, 1]) {
      const oi = sign * offInner, oo = sign * offOuter;
      const pos = new Float32Array(n * 2 * 3);
      for (let i = 0; i < n; i++) {
        const s = samples[i], a = i * 6;
        pos[a] = s.pos.x + s.lateral.x * oi; pos[a + 1] = s.pos.y + s.lateral.y * oi + riseInner; pos[a + 2] = s.pos.z + s.lateral.z * oi;
        pos[a + 3] = s.pos.x + s.lateral.x * oo; pos[a + 4] = groundY; pos[a + 5] = s.pos.z + s.lateral.z * oo;
      }
      const idx = [];
      for (let i = 0; i < n - 1; i++) { const p = i * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.slopeGroup.add(m);
    }
  }

  // Lobby-only flank forest: trees on the OUTER mountainside (between the valley
  // walls and the floor). INSTANCED — the whole forest is 4 draw calls no matter
  // the count, lives in lobbyGroup (hidden during the race → zero cost in the
  // split-screen passes), and casts no shadow. Density falls off where the flank
  // is steep (bare cliffs near the top of the run, forest lower down) for a
  // natural treeline.
  _addOuterTrees(samples, edgeLat, groundY) {
    const offInner = edgeLat + 72, riseInner = 48, span = (edgeLat + 240) - offInner; // matches _addFlanks
    const place = [];
    const n = samples.length;
    for (let i = 4; i < n - 4; i += 2) {
      const s = samples[i];
      const steep = ((s.pos.y + riseInner) - groundY) / span;   // flank height / width here
      const density = Math.max(0, 1 - steep / 2.1);             // sparse on steep upper flanks
      for (const sign of [-1, 1]) {
        if (Math.random() > density * 0.8) continue;
        const t = 0.34 + 0.62 * Math.random();                 // bias to the outer (gentler) flank, off the lip
        const off = sign * (offInner + t * span);
        place.push({
          x: s.pos.x + s.lateral.x * off,
          y: (s.pos.y + riseInner) + t * (groundY - (s.pos.y + riseInner)),
          z: s.pos.z + s.lateral.z * off,
          rotY: Math.random() * Math.PI * 2,
          scl: 0.85 + Math.random() * 1.7,
        });
      }
    }
    if (!place.length) return;

    const N = place.length;
    const bark = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
    const foliage = new THREE.MeshStandardMaterial({ color: 0x2f7d52, roughness: 1, flatShading: true });
    // one InstancedMesh per tree part, all sharing the per-tree transforms.
    const parts = [new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.24, 1.2, 6).translate(0, 0.6, 0), bark, N)];
    for (let c = 0; c < 3; c++) {
      parts.push(new THREE.InstancedMesh(new THREE.ConeGeometry(1.3 - c * 0.32, 1.5, 7).translate(0, 1.4 + c * 0.85, 0), foliage, N));
    }
    const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion();
    const p = new THREE.Vector3(), sc = new THREE.Vector3(), m4 = new THREE.Matrix4();
    for (let k = 0; k < N; k++) {
      const t = place[k];
      q.setFromAxisAngle(up, t.rotY); p.set(t.x, t.y, t.z); sc.setScalar(t.scl);
      m4.compose(p, q, sc);
      for (const im of parts) im.setMatrixAt(k, m4);
    }
    for (const im of parts) {
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = false; im.receiveShadow = false;
      im.frustumCulled = false; // instances span the whole mountain; the origin-centred bound would wrongly cull
      this.lobbyGroup.add(im);
    }
  }

  // World-Y height of the mountainside at a lateral distance |off| from centre
  // (matches the wall strips built in setTrack), for sitting trees on the banks.
  _riseAt(absO, edgeLat) {
    if (absO <= edgeLat) return 0;
    if (absO <= edgeLat + 26) return 14 * (absO - edgeLat) / 26;
    return 14 + 34 * Math.min(1, (absO - edgeLat - 26) / 46);
  }

  // A FULL ring of big low-poly snow peaks encircling the run — the distant
  // range that frames the lobby orbit from every angle. (The old sparse 8-cone
  // arc, sized for the small hill, left gaps the rotating camera exposed and sat
  // inside the new orbit radius.) Placed safely beyond the orbit and BASED ON THE
  // VALLEY FLOOR so they tower like real mountains rather than float as chips.
  _addPeaks(center, size) {
    const R = (this._ovRadius || 200) * 1.45;     // ring radius — well outside the camera orbit
    const floor = this.ground.position.y;         // valley floor (finish level)
    // emissive lifts the shaded faces toward a cool snowy white (distant peaks are
    // hazy/bright), so they read as snow mountains rather than dark grey pyramids.
    const snow = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xc6d2e0, emissiveIntensity: 0.18, roughness: 1, flatShading: true });
    const N = 16;
    for (let i = 0; i < N; i++) {
      // even spacing + alternating jitter → organic but never a gap.
      const ang = (i / N) * Math.PI * 2 + (i % 2 ? 0.17 : -0.13);
      const dist = R * (0.92 + (i % 3) * 0.16);
      const h = 210 + (i % 4) * 50 + (i % 2) * 44;  // ~210..390
      const r = h * 0.62;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5, 1), snow);
      cone.position.set(center.x + Math.cos(ang) * dist, floor + h / 2, center.z + Math.sin(ang) * dist);
      cone.rotation.y = ang * 1.7;
      this.slopeGroup.add(cone);
    }
  }

  // Scatter an alpine pine forest over the mountainside banks (decorative, not
  // collidable — the engine's obstacles are separate).
  _addScenery(samples, edgeLat) {
    const n = samples.length;
    const foliage = new THREE.MeshStandardMaterial({ color: 0x2f7d52, roughness: 1, flatShading: true });
    const bark = new THREE.MeshStandardMaterial({ color: 0x6b4a2f });
    const worldUp = new THREE.Vector3(0, 1, 0);
    for (let i = 4; i < n - 4; i += 3) {
      const s = samples[i];
      for (const side of [-1, 1]) {
        if (Math.random() < 0.5) continue;
        const off = side * (edgeLat + 3 + Math.random() * 58);
        const tree = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.2, 6), bark);
        trunk.position.y = 0.6; tree.add(trunk);
        for (let c = 0; c < 3; c++) {
          const cone = new THREE.Mesh(new THREE.ConeGeometry(1.3 - c * 0.32, 1.5, 7), foliage);
          cone.position.y = 1.4 + c * 0.85; tree.add(cone);
        }
        tree.scale.setScalar(0.8 + Math.random() * 1.9);
        tree.position.copy(s.pos).addScaledVector(s.lateral, off).addScaledVector(worldUp, this._riseAt(Math.abs(off), edgeLat));
        this.slopeGroup.add(tree);
      }
    }
  }

  _addRamp(cl, r) {
    const f = cl.sampleAt(r.s);
    // A LOW kicker, sized to the air scale (launch apex ~0.9u) so the skier
    // clears it instead of driving through a too-tall box. Built as a box, tilted
    // so its top face ramps up along the slope tangent.
    const w = (r.width || 2.4), len = 3.0, h = 0.5;
    const geo = new THREE.BoxGeometry(w, h, len);
    // shear the top forward by translating top verts — simpler: just a tilted box
    const ramp = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x7fc4ec, roughness: 0.8 }));
    ramp.castShadow = true; ramp.receiveShadow = true;
    const lateral = f.lateral.clone().normalize();
    const tangent = f.tangent.clone().normalize();
    const up = f.up.clone().normalize();
    ramp.position.copy(f.pos).addScaledVector(lateral, r.lat).addScaledVector(up, h * 0.25);
    // Build a RIGHT-handed basis (x = up × tangent, NOT `lateral` = tangent × up,
    // which would be left-handed → setFromRotationMatrix mis-orients the wedge).
    const rx = new THREE.Vector3().crossVectors(up, tangent).normalize();
    ramp.quaternion.setFromRotationMatrix(this._sBasis.makeBasis(rx, up, tangent));
    ramp.rotateX(-0.32); // tip the lip up
    this.propGroup.add(ramp);
  }

  _addObstacle(cl, o) {
    const f = cl.sampleAt(o.s);
    const up = f.up.clone().normalize();
    const g = new THREE.Group();
    if (o.kind === 'rock') {
      const rock = new THREE.Mesh(
        new THREE.IcosahedronGeometry(o.radius || 0.85, 0),
        new THREE.MeshStandardMaterial({ color: 0x8a93a1, roughness: 1, flatShading: true })
      );
      rock.castShadow = true; rock.scale.set(1, 0.7, 1);
      g.add(rock);
    } else {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.16, 0.9, 6),
        new THREE.MeshStandardMaterial({ color: 0x7a5230 })
      );
      trunk.position.y = 0.45; trunk.castShadow = true;
      g.add(trunk);
      const foliage = new THREE.MeshStandardMaterial({ color: 0x2f8f5b, roughness: 1, flatShading: true });
      for (let i = 0; i < 3; i++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.95 - i * 0.22, 1.0, 7), foliage);
        cone.position.y = 1.0 + i * 0.55; cone.castShadow = true;
        g.add(cone);
      }
    }
    g.position.copy(f.pos).addScaledVector(f.lateral, o.lat);
    g.quaternion.setFromUnitVectors(_up, up);
    this.propGroup.add(g);
  }

  _addBanner(cl, s, color, kind) {
    const f = cl.sampleAt(Math.max(0, Math.min(cl.length, s)));
    const lateral = f.lateral.clone().normalize();
    const up = f.up.clone().normalize();
    const halfW = 5.2;
    const poleGeo = new THREE.CylinderGeometry(0.12, 0.12, 3.2, 8);
    const mat = new THREE.MeshStandardMaterial({ color });
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(poleGeo, mat);
      pole.position.copy(f.pos).addScaledVector(lateral, side * halfW).addScaledVector(up, 1.6);
      pole.quaternion.setFromUnitVectors(_up, up);
      pole.castShadow = true;
      this.propGroup.add(pole);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2, 0.7, 0.18), mat);
    bar.position.copy(f.pos).addScaledVector(up, 3.0);
    const tangent = f.tangent.clone().normalize();
    const bx = new THREE.Vector3().crossVectors(up, tangent).normalize(); // right-handed
    bar.quaternion.setFromRotationMatrix(this._sBasis.makeBasis(bx, up, tangent));
    this.propGroup.add(bar);
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

    const cam = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1200);

    // soft contact shadow — a faded sprite laid flush on the slope each frame
    // (oriented in setSkierPose so it can't clip through the tilted surface)
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({ map: this._blobTex, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false })
    );

    this.scene.add(group);
    this.scene.add(blob);

    let label = null;
    const celled = opts.cell !== false;
    if (celled) {
      label = document.createElement('div');
      label.className = 'cell-label';
      label.style.setProperty('--c', this.colors[colorIndex % this.colors.length] || '#2d9cdb');
      label.innerHTML = `<span class="cell-label__name"></span><span class="cell-label__stat"></span>`;
      label.querySelector('.cell-label__name').textContent = name || '';
      this.overlay.appendChild(label);
      if (!this._order.includes(id)) this._order.push(id);
    }

    this.skiers.set(id, {
      id, group, body, cam, blob, label, name,
      colorIndex, celled,
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
    this.skiers.delete(id);
    const i = this._order.indexOf(id);
    if (i >= 0) this._order.splice(i, 1);
  }

  setSkierPose(id, pos, forward, up, carve = 0, spd = 0, airborne = false, tuck = 0, air = 0, spin = 0, crashed = false, trickAxis = 0, trickPhase = 0, trickSign = 1) {
    const c = this.skiers.get(id);
    if (!c) return;
    c.spd = spd; c.airborne = airborne;
    if (!c.pose) c.pose = { pos: new THREE.Vector3(), forward: new THREE.Vector3(), up: new THREE.Vector3() };
    c.pose.pos.copy(pos);
    c.pose.forward.copy(forward).normalize();
    c.pose.up.copy(up).normalize();

    c.group.position.copy(pos);
    // orientation basis: z = forward (down-slope), x = up × z, y = z × x
    const z = this._sz.copy(c.pose.forward);
    const x = this._sx.copy(c.pose.up).cross(z).normalize();
    const y = this._sy.copy(z).cross(x).normalize();
    c.group.quaternion.setFromRotationMatrix(this._sBasis.makeBasis(x, y, z));
    // wipeout spin about the slope normal (cosmetic)
    if (spin) c.group.rotateY(spin);
    // air trick: somersault the WHOLE skier — pitch (local x) for front/back,
    // roll (local z) for side. The chase cam tracks pose.forward, not the group,
    // so the view holds steady while the skier flips.
    if (trickAxis === 'front') c.group.rotateX(trickPhase * _TAU);
    else if (trickAxis === 'back') c.group.rotateX(-trickPhase * _TAU);
    else if (trickAxis === 'side') c.group.rotateZ(trickSign * trickPhase * _TAU);

    // body: bank INTO the carve (negated — +carve is turn-aligned, and a positive
    // local-Z roll tilts the torso the opposite way), crouch + pitch when tucking
    const dt = this._frameDt || 0.016;
    c.lean += (-carve * BANK_MAX - c.lean) * Math.min(1, dt * 12);
    c.tuckAmt += ((tuck ? 1 : 0) - c.tuckAmt) * Math.min(1, dt * 10);
    c.body.rotation.z = c.lean;
    c.body.rotation.x = c.tuckAmt * TUCK_PITCH + (airborne ? -0.2 : 0);
    // squat: shrink toward the feet (pivot is at the base) rather than dropping the
    // body — keeps the whole skier above the snow, so it can't clip the surface.
    c.body.scale.setScalar(1 - c.tuckAmt * TUCK_SHRINK);

    // contact shadow: lay it FLUSH on the (tilted) slope under the skier — normal
    // = slope up, lifted a hair ALONG that normal so it can't clip through the
    // surface (pose includes air height → subtract it to find the surface point).
    c.blob.position.copy(pos).addScaledVector(c.pose.up, -air + 0.04);
    c.blob.quaternion.setFromUnitVectors(_zAxis, c.pose.up);
    const sh = Math.max(0.35, 1 - air * 0.09); // shrink + fade with height
    c.blob.scale.set(sh, sh, 1);
    c.blob.material.opacity = 0.42 * sh;
  }

  setSkierHud(id, info) {
    const c = this.skiers.get(id);
    if (!c || !c.label) return;
    const stat = c.label.querySelector('.cell-label__stat');
    if (info.finished) {
      stat.textContent = `P${info.position} · ${info.finishTime ? info.finishTime.toFixed(1) + 's' : 'done'}`;
      c.label.classList.add('is-finished');
    } else {
      // Tucked is the default now, so don't tag it — flag only the active states:
      // a flip / airborne, or a deliberate brake (tuck released).
      let tag = '';
      if (info.airborne) tag = info.trickAxis ? ' · FLIP' : ' · AIR';
      else if (!info.tuck) tag = ' · BRAKE';
      stat.textContent = `P${info.position}/${info.of}` + tag;
    }
  }

  _updateChase(c, dt) {
    const { pos, forward, up } = c.pose;
    const want = this._sWant.copy(pos).addScaledVector(forward, -CHASE_DIST).addScaledVector(up, CHASE_HEIGHT);
    const target = this._sTarget.copy(pos).addScaledVector(forward, CHASE_LOOK).addScaledVector(up, CHASE_TGT_UP);
    const aPos = 1 - Math.exp(-CAM_POS_RATE * dt);
    const aTgt = 1 - Math.exp(-CAM_TGT_RATE * dt);
    if (!c.init) { c.camPos.copy(want); c.camTarget.copy(target); c.init = true; }
    else { c.camPos.lerp(want, aPos); c.camTarget.lerp(target, aTgt); }
    c.cam.position.copy(c.camPos);
    const wantFov = BASE_FOV + (c.spd || 0) * FOV_GAIN + (c.airborne ? AIR_FOV : 0);
    c.fov += (wantFov - c.fov) * (1 - Math.exp(-6 * dt));
    c.cam.fov = c.fov;
    c.cam.up.copy(up);
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
      this._updateChase(c, dt);
      c.cam.aspect = cw / ch; c.cam.updateProjectionMatrix();
      r.setViewport(x, yBottom, cw, ch);
      r.setScissor(x, yBottom, cw, ch);
      r.setScissorTest(true);
      r.render(this.scene, c.cam);
      // position the DOM label in the cell (CSS px, top-left origin)
      if (c.label) { c.label.style.left = (x + 14) + 'px'; c.label.style.top = (row * ch + 12) + 'px'; }
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
