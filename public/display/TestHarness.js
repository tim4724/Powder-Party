// TestHarness — drives the display from FAKE data with NO relay, for previewing
// the slope/skiers without phones. Reached via the real display page with
// ?test=1&scenario=… (see main.js). Reuses the real SkiEngine + AiController, so
// the preview shows true physics and bot behaviour.
//
//   /?test=1&scenario=running&players=4   — full split-screen run, CPU-driven (endless)
//   /?test=1&scenario=countdown           — countdown beat
//   /?test=1&scenario=paused              — mid-run, frozen + pause overlay
//   /?test=1&scenario=results             — results board
//   /?test=1&scenario=lobby               — orbiting slope preview + fake roster
//   /?test=1&scenario=slope               — clean orbiting slope preview, CPU field (endless)
//   /?test=1&scenario=tricks              — TRICK LAB: a single full-screen skier on a
//        STRAIGHT, tree-free practice run (the `trick-lab` slope) lined with kickers,
//        driven from the KEYBOARD to feel the brake/jump/flip loop, no phone or relay:
//          A / D (or ← / →) carve · hold S brake · Space / ↑ back flip · W / ↓ front flip
//          Q spin-left · E spin-right · Z / C corks (off-axis)
//        (add &players=4 for a CPU field, or &slope=powder-bowl for the real run)
//   /?test=1&scenario=solo                — SINGLE-PLAYER on the main display, no phone: a
//        REAL race down a generated mountain against a CPU field, you in a full-screen
//        chase cell (CPU share your world). Keyboard: A / D carve · hold S brake ·
//        Q spin-left · W front flip · E spin-right · Space back flip (Z / C corks). On the
//        finish the results board holds; ENTER (or "Play again") skis it again.
//        (&players=N sizes the field — default you + 3 CPU; &seed=N picks the mountain)
//   /?test=1&scenario=bump                — BUMP LAB: a KEYBOARD skier dropped into a tight
//        pack of CPU bots (lane-bias zeroed so they converge and jostle) on a wide, straight,
//        tree/kicker-free run — for feeling skier-vs-skier contact: soft bumps + blocking
//        happen on their own; carve hard across the pack (A/D) at speed to land a T-bone.

const el = (id) => document.getElementById(id);

// Minimal keyboard → CONTROL {s,t,j,f} reader for the `tricks` scenario, mirroring
// the controller's TiltInput (carve) + SwipeInput (brake/jump/flip) key maps so the
// no-relay preview exercises the real engine input path. Flicks are ANALOG: each
// trick key emits an angle (rad, up = +π/2) on f, matching SwipeInput's gesture
// angles. The up key ALSO bumps j (ignored on the snow, where ramps auto-launch;
// a back-flip fallback in the air).
function keyboardDriver() {
  const st = { left: false, right: false, brake: false };
  let jSeq = 0, fSeq = 0, fAngle = 0;
  const fMag = 0.6; // keyboard has no flick speed → a fixed mid-strength spin rate
  const edge = { up: false, down: false, w: false, q: false, e: false, z: false, c: false };
  const flick = (a) => { fSeq = (fSeq + 1) & 255; fAngle = a; };
  const down = (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') st.left = true;
    else if (k === 'arrowright' || k === 'd') st.right = true;
    else if (k === 's') st.brake = true;
    else if (k === 'arrowup' || k === ' ') { if (!edge.up) { edge.up = true; jSeq = (jSeq + 1) & 255; flick(Math.PI / 2); } e.preventDefault(); } // jump / back flip
    else if (k === 'arrowdown') { if (!edge.down) { edge.down = true; flick(-Math.PI / 2); } e.preventDefault(); } // front flip
    else if (k === 'w') { if (!edge.w) { edge.w = true; flick(-Math.PI / 2); } }        // front flip (WASD-friendly ↓)
    else if (k === 'q') { if (!edge.q) { edge.q = true; flick(Math.PI); } }            // spin left (yaw)
    else if (k === 'e') { if (!edge.e) { edge.e = true; flick(0); } }                  // spin right (yaw)
    else if (k === 'z') { if (!edge.z) { edge.z = true; flick(3 * Math.PI / 4); } }    // back-left cork
    else if (k === 'c') { if (!edge.c) { edge.c = true; flick(Math.PI / 4); } }        // back-right cork
    else return;
  };
  const up = (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') st.left = false;
    else if (k === 'arrowright' || k === 'd') st.right = false;
    else if (k === 's') st.brake = false;
    else if (k === 'arrowup' || k === ' ') edge.up = false;
    else if (k === 'arrowdown') edge.down = false;
    else if (k === 'w') edge.w = false;
    else if (k === 'q') edge.q = false;
    else if (k === 'e') edge.e = false;
    else if (k === 'z') edge.z = false;
    else if (k === 'c') edge.c = false;
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  return { read: () => ({ s: (st.right ? 1 : 0) - (st.left ? 1 : 0), t: st.brake ? 0 : 1, j: jSeq, f: { n: fSeq, a: fAngle, m: fMag } }) };
}

export function runDisplayScenario(cfg, ctx) {
  const { scene, slope, AiController, AI_PERSONALITIES, RunSession, renderRoster, renderLevel, showResults, buildReconnectCard, audio, showSoundHint } = ctx;

  const N = Math.max(1, Math.min(4, cfg.players || 4));
  const scn = cfg.scenario || 'running';
  const human = scn === 'tricks' || scn === 'bump' || scn === 'solo'; // skier 0 is keyboard-driven, the rest CPU
  const kb = human ? keyboardDriver() : null;

  // Camera: ?cam=side starts in the profile rig (great for eyeballing the ramp
  // launch / flips side-on); 'V' toggles chase ⇄ side live in any preview.
  scene.setCamMode(cfg.cam === 'side' ? 'side' : 'chase');
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'v' && !e.repeat) scene.cycleCamMode();
  });

  // build the field — CPU, except skier 0 when a human drives (the `tricks`/`bump` labs)
  const field = [];
  const bots = new Map();
  for (let i = 0; i < N; i++) {
    if (human && i === 0) { field.push({ peerIndex: 'me', name: 'You (keys)', colorIndex: 0, ai: false }); continue; }
    const persona = AI_PERSONALITIES[i % AI_PERSONALITIES.length];
    const id = 'cpu-' + i;
    field.push({ peerIndex: id, name: persona.name, colorIndex: i, ai: true, stats: { glide: persona.glide, edge: persona.edge } });
    // `bump` zeroes laneBias AND disables avoidance so the bots ignore each other
    // and pile up on the fall line (their normal fanned lanes + dodging exist
    // precisely to AVOID contact — the opposite of the demolition derby).
    bots.set(id, new AiController(scn === 'bump' ? { ...persona, laneBias: 0, avoid: false } : persona));
  }

  // Drop the keyboard skier in just above the first ramp so the launch is a
  // second away — fast iteration on flip-duration / air-gate / boost by feel.
  function seedHuman(sess) {
    if (!human) return;
    const me = sess.engine.skiers.get('me');
    // Only CENTRE the human on the fall line (the kickers sit at lat 0; the start
    // grid fans players out). No seeded position or speed — a normal top-of-slope
    // start from rest, so there's a calm run-in to the first kicker rather than a
    // jump right off the line. Bombing straight down then hits every ramp in turn.
    if (me) { me.lat = 0; me.heading = 0; }
  }
  // `bump` lab: pack the whole field into ONE tight cluster just below the gate so
  // they're already overlapping (lanes ~0.55u apart < the ~0.8u contact footprint)
  // and start jostling the instant the run begins — no waiting for a chance scrum.
  function seedCluster(sess) {
    const ids = field.map((p) => p.peerIndex);
    ids.forEach((id, i) => {
      const sk = sess.engine.skiers.get(id);
      if (!sk) return;
      sk.totalS = 6;
      sk.lat = (i - (ids.length - 1) / 2) * 0.55; // symmetric about the fall line
      sk.heading = 0; sk.v = 0;
    });
  }
  // `solo` starts from the normal engine grid (a real race start); only the trick
  // lab centres the human on the fall line, only the bump lab packs the cluster.
  const seedField = (sess) => (scn === 'bump' ? seedCluster(sess) : scn === 'tricks' ? seedHuman(sess) : undefined);

  if (scn === 'lobby' || scn === 'welcome') {
    scene.orbit = true;
    el('lobby') && el('lobby').classList.remove('hidden');
    el('race') && el('race').classList.add('hidden');
    // Share the REAL roster render — pads open seats, applies the live count copy,
    // escapes names. First skier is host (matches the live "first to join" rule).
    renderRoster(field, field[0] && field[0].peerIndex);
    renderLevel && renderLevel(); // mirror the difficulty badge (?level= pins the tier)
    return;
  }

  // `device-choice` — the chooser a phone gets landing on this big-screen page.
  // The gallery iframe is itself a cramped viewport, so the display.css media
  // query surfaces the overlay on its own (main.js skips its test-mode
  // pre-dismiss for this scenario), and an &bail=game_ended URL param stages
  // the toast through the live path. Nothing to drive — the opaque overlay
  // owns the frame.
  if (scn === 'device-choice') { scene.orbit = true; return; }

  // `slope` is a clean turntable preview: orbit camera, no lobby/run overlays,
  // and skiers share the world with no split-screen cells. Every other scenario
  // below is a chase-cam split-screen run.
  const orbitPreview = scn === 'slope';
  scene.orbit = orbitPreview;
  el('lobby') && el('lobby').classList.add('hidden');
  el('race') && el('race').classList.toggle('hidden', orbitPreview);
  // `solo` cells only the human (full-screen chase); the CPU share that world, exactly
  // like a real single-human run. Every other run scenario split-screens all skiers.
  for (const p of field) scene.addSkier(p.peerIndex, p.colorIndex, p.name, { cell: orbitPreview ? false : (scn === 'solo' ? !p.ai : true) });

  // `reconnect` lab: one celled skier has dropped — its still-descending ghost
  // shows the rejoin QR centred in its cell (the live display path: a dropped seat
  // → buildReconnectCard → scene.setSkierReconnect). The rest race on as normal.
  if (scn === 'reconnect' && buildReconnectCard) {
    const dropped = field.find((p) => p.peerIndex !== 'me') || field[0];
    if (dropped) scene.setSkierReconnect(dropped.peerIndex, buildReconnectCard({
      name: dropped.name, colorIndex: dropped.colorIndex,
      url: (window.location.origin + '/POWDER?claim=' + dropped.colorIndex)
    }));
  }

  // `solo` latches its results board once (shown from onRaceEnd below) so it isn't
  // re-rendered every frame; cleared on replay.
  let soloOver = false;
  // main.js gates pole clacks on ITS raceEnded (always false in test mode) —
  // re-gate on solo's results board so coasting CPU stay quiet behind it.
  scene.onPoleHit = (kick) => { if (!soloOver) audio.pole(kick); };
  let session = newSession();
  seedField(session);
  window.__harness = () => session;       // current session (reassigned on restart) — for automated checks
  window.__scene = scene;                 // renderer handle (pole flex etc.) — for automated checks
  function newSession() {
    const s = new RunSession(field, slope, {
      // Same SFX as live play (Audio.raceEvent) — the labs exist to FEEL the
      // jump/flip/bump loop, and sound is half of that feedback.
      onRaceEvent: (e) => audio.raceEvent(e),
      onCountdownTick: (n) => {
        const c = el('countdown');
        if (c) { c.textContent = n > 0 ? String(n) : n === 0 ? 'GO!' : ''; c.classList.toggle('is-go', n === 0); }
        if (n >= 0) audio.countdown(n);
      },
      onRaceStart: () => audio.startWind(),
      // `solo` lands on the real results board the instant the run ends. This fires on
      // a normal finish (whole field across → real times) AND on the MAX_RUN_MS
      // failsafe, so a stuck run still shows results instead of freezing on a dead
      // frame. The other previews ignore this and auto-loop from onFrame instead.
      onRaceEnd: (results) => { if (scn === 'solo' && !soloOver) { soloOver = true; audio.stopWind(); audio.finish(); showResults(results, field); } },
    });
    return s;
  }
  // `solo` replay: rather than auto-looping like the other run previews, the results
  // board holds (shown above) until the player skis the SAME mountain again — ENTER or
  // the board's "Play again". (No lobby in solo, so "New game" is hidden.) Pass
  // &seed=N for a different mountain.
  function restartSolo() {
    el('results') && el('results').classList.add('hidden');
    session.dispose();
    scene.clearTrails();
    session = newSession();
    seedField(session);
    session.startCountdown(3);
    soloOver = false;
  }
  if (scn === 'solo') {
    el('results-newgame') && el('results-newgame').classList.add('hidden');
    const again = () => { if (soloOver) restartSolo(); };
    window.addEventListener('keydown', (e) => { if (e.key === 'Enter') again(); });
    el('results-again') && el('results-again').addEventListener('click', again);
  }

  // `bump` lab: stable per-bot phase so the cross-sweep is deterministic.
  const bumpIdx = new Map();
  field.filter((p) => p.peerIndex !== 'me').forEach((p, i) => bumpIdx.set(p.peerIndex, i));
  function driveBots(sess) {
    for (const [id, bot] of bots) {
      const sk = sess.engine.skiers.get(id);
      if (!sk || sk.finished) continue;
      if (scn === 'bump') {
        // DEMOLITION DERBY: sweep the target lane back and forth across the piste,
        // out of phase per bot (alternating bots mirror each other so they meet at
        // the fall line from opposite sides). Running straight can never build the
        // ~9u/s lateral closing a T-bone needs; slicing ACROSS at speed does — and
        // the lateral motion also keeps them from knotting up in a mutual block.
        const idx = bumpIdx.get(id) || 0;
        const dir = idx % 2 ? 1 : -1;
        bot.laneBias = dir * 4.5 * Math.sin(1.3 * sess.engine.elapsed + idx * 0.7);
        sess.processInput(id, bot.drive(sk, sess.engine)); // stays tucked/fast → matches a tucking human
      } else {
        // Hand the bot the full engine (not just the centerline) so its tree/skier
        // avoidance + air tricks run exactly as in real play — matches main.js.
        sess.processInput(id, bot.drive(sk, sess.engine));
      }
    }
  }

  scene.onFrame = (dt) => {
    if (human) session.processInput('me', kb.read());
    driveBots(session);
    session.update(dt * 1000);
    const snap = session.getSnapshot();
    let packSpd = 0;
    for (const s of snap.skiers) {
      if (s.pose) scene.setSkierPose(s.id, s);
      scene.setSkierHud(s.id, s);
      packSpd = Math.max(packSpd, s.v);
      if (!soloOver && (s.offPiste || (s.crashed && s.spin))) audio.scrape(0.8); // deep-snow hiss / wipeout
    }
    // Wind tracks pack speed exactly as in live play; once solo's results board
    // is up the run goes quiet (stopWind fired from onRaceEnd, skip the scrapes).
    if (!soloOver) audio.setWind(Math.min(1, packSpd / 26));
    // Run-over: auto-looping previews roll a fresh run; `solo` instead holds the
    // results board (shown from onRaceEnd) until the player replays.
    if ((scn === 'running' || scn === 'slope' || scn === 'tricks' || scn === 'bump' || scn === 'reconnect') && session.engine.raceOver) {
      session.dispose();
      scene.clearTrails(); // fresh snow when the preview loops the run
      session = newSession();
      seedField(session);
      session.startCountdown(1);
    }
  };

  if (scn === 'countdown') {
    showSoundHint();
    session.startCountdown(3);
  } else if (scn === 'paused') {
    session.racing = true; // skip the countdown delay; step synchronously
    for (let i = 0; i < 240; i++) { driveBots(session); session.update(1000 / 60); }
    session.pause();
    el('pause-overlay') && el('pause-overlay').classList.remove('hidden');
  } else if (scn === 'results') {
    session.racing = true; // skip the countdown delay so fast-forward actually runs
    driveBots(session);
    session.fastForwardToEnd(() => driveBots(session));
    // One fabricated late joiner so the preview exercises the unranked
    // "next run" row (live play derives these from the roster).
    showResults(session.getResults(), field, false, [{ name: 'Nova', colorIndex: 4 }]);
  } else { // running / slope / tricks / bump / solo — start the run, onFrame loops it
    showSoundHint();
    session.startCountdown(scn === 'solo' ? 3 : 1); // solo gets a real 3-2-1 race start
  }
}
