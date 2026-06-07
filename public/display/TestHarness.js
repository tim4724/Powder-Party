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
//          A / D (or ← / →) carve · hold S brake · Space / ↑ jump (back flip in air)
//          ↓ front flip · Q spin-left · E spin-right · Z / C corks (off-axis)
//        (add &players=4 for a CPU field, or &slope=powder-bowl for the real run)
//   /?test=1&scenario=bump                — BUMP LAB: a KEYBOARD skier dropped into a tight
//        pack of CPU bots (lane-bias zeroed so they converge and jostle) on a wide, straight,
//        tree/kicker-free run — for feeling skier-vs-skier contact: soft bumps + blocking
//        happen on their own; carve hard across the pack (A/D) at speed to land a T-bone.

const el = (id) => document.getElementById(id);

// Minimal keyboard → CONTROL {s,t,j,f} reader for the `tricks` scenario, mirroring
// the controller's TiltInput (carve) + SwipeInput (brake/jump/flip) key maps so the
// no-relay preview exercises the real engine input path. Flicks are ANALOG: each
// trick key emits an angle (rad, up = +π/2) on f, matching SwipeInput's gesture
// angles. The up key ALSO bumps j (jump on the snow / back flip in the air).
function keyboardDriver() {
  const st = { left: false, right: false, brake: false };
  let jSeq = 0, fSeq = 0, fAngle = 0;
  const fMag = 0.6; // keyboard has no flick speed → a fixed mid-strength spin rate
  const edge = { up: false, down: false, q: false, e: false, z: false, c: false };
  const flick = (a) => { fSeq = (fSeq + 1) & 255; fAngle = a; };
  const down = (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') st.left = true;
    else if (k === 'arrowright' || k === 'd') st.right = true;
    else if (k === 's') st.brake = true;
    else if (k === 'arrowup' || k === ' ') { if (!edge.up) { edge.up = true; jSeq = (jSeq + 1) & 255; flick(Math.PI / 2); } e.preventDefault(); } // jump / back flip
    else if (k === 'arrowdown') { if (!edge.down) { edge.down = true; flick(-Math.PI / 2); } e.preventDefault(); } // front flip
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
    else if (k === 'q') edge.q = false;
    else if (k === 'e') edge.e = false;
    else if (k === 'z') edge.z = false;
    else if (k === 'c') edge.c = false;
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  return { read: () => ({ s: (st.right ? 1 : 0) - (st.left ? 1 : 0), t: st.brake ? 0 : 1, j: jSeq, f: { n: fSeq, a: fAngle, m: fMag } }) };
}

export async function runDisplayScenario(cfg, ctx) {
  const { scene, slope, scenePromise, SKIER_COLORS, AiController, AI_PERSONALITIES, RunSession } = ctx;
  await scenePromise;

  const N = Math.max(1, Math.min(4, cfg.players || 4));
  const scn = cfg.scenario || 'running';
  const human = scn === 'tricks' || scn === 'bump'; // skier 0 is keyboard-driven, the rest CPU
  const kb = human ? keyboardDriver() : null;

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
  // they're already overlapping (lanes ~0.8u apart < the ~1.1u contact footprint)
  // and start jostling the instant the run begins — no waiting for a chance scrum.
  function seedCluster(sess) {
    const ids = field.map((p) => p.peerIndex);
    ids.forEach((id, i) => {
      const sk = sess.engine.skiers.get(id);
      if (!sk) return;
      sk.totalS = 6;
      sk.lat = (i - (ids.length - 1) / 2) * 0.8; // symmetric about the fall line
      sk.heading = 0; sk.v = 0;
    });
  }
  const seedField = (sess) => (scn === 'bump' ? seedCluster(sess) : seedHuman(sess));

  if (scn === 'lobby' || scn === 'welcome') {
    scene.orbit = true;
    el('lobby') && el('lobby').classList.remove('hidden');
    el('race') && el('race').classList.add('hidden');
    const wrap = el('players');
    if (wrap) {
      wrap.innerHTML = '';
      field.forEach((p, i) => {
        const seat = document.createElement('div');
        seat.className = 'seat';
        seat.innerHTML = `<span class="dot" style="background:${SKIER_COLORS[i % SKIER_COLORS.length]}"></span>` +
          `<span class="seat__name">${p.name}</span>` + (i === 0 ? `<span class="seat__host">HOST</span>` : '');
        wrap.appendChild(seat);
      });
    }
    el('count') && (el('count').textContent = 'Preview — scan to join');
    return;
  }

  // `slope` is a clean turntable preview: orbit camera, no lobby/run overlays,
  // and skiers share the world with no split-screen cells. Every other scenario
  // below is a chase-cam split-screen run.
  const orbitPreview = scn === 'slope';
  scene.orbit = orbitPreview;
  el('lobby') && el('lobby').classList.add('hidden');
  el('race') && el('race').classList.toggle('hidden', orbitPreview);
  for (const p of field) scene.addSkier(p.peerIndex, p.colorIndex, p.name, { cell: !orbitPreview });

  let session = newSession();
  seedField(session);
  window.__harness = () => session;       // current session (reassigned on restart) — for automated checks
  function newSession() {
    const s = new RunSession(field, slope, {
      onRaceEvent: () => {},
      onCountdownTick: (n) => {
        const c = el('countdown');
        if (c) { c.textContent = n > 0 ? String(n) : n === 0 ? 'GO!' : ''; c.classList.toggle('is-go', n === 0); }
      },
      onRaceStart: () => {},
      onRaceEnd: () => {},
    });
    return s;
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
        sess.processInput(id, bot.drive(sk, slope.centerline)); // stays tucked/fast → matches a tucking human
      } else {
        sess.processInput(id, bot.drive(sk, slope.centerline));
      }
    }
  }

  scene.onFrame = (dt) => {
    if (human) session.processInput('me', kb.read());
    driveBots(session);
    session.update(dt * 1000);
    const snap = session.getSnapshot();
    for (const s of snap.skiers) {
      if (s.pose) scene.setSkierPose(s.id, s.pose.pos, s.pose.forward, s.pose.up, s.carve, s.v, s.airborne, s.tuck, s.air, s.spin, s.crashed, s.trickActive, s.trickAngle, s.trickPhase, s.carveInput);
      scene.setSkierHud(s.id, s);
    }
    if ((scn === 'running' || scn === 'slope' || scn === 'tricks' || scn === 'bump') && session.engine.raceOver) {
      session.dispose();
      scene.clearTrails(); // fresh snow when the preview loops the run
      session = newSession();
      seedField(session);
      session.startCountdown(1);
    }
  };

  if (scn === 'countdown') {
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
    showResults(session.getResults(), field, SKIER_COLORS);
  } else { // running / slope (default) — start the run, onFrame loops it
    session.startCountdown(1);
  }
}

function showResults(results, field, colors) {
  const byId = new Map(field.map((p) => [p.peerIndex, p]));
  const list = el('results-list');
  if (list) {
    list.innerHTML = '';
    for (const r of results.results) {
      const p = byId.get(r.playerId) || {};
      const li = document.createElement('li');
      li.innerHTML = `<span class="res__rank">${r.rank}</span>` +
        `<span class="dot" style="background:${colors[(p.colorIndex || 0) % colors.length]}"></span>` +
        `<span class="res__name">${p.name || 'Skier'} <span class="res__cpu">CPU</span></span>` +
        `<span class="res__time">${r.finished && r.time != null ? r.time.toFixed(1) + 's' : 'DNF'}</span>`;
      list.appendChild(li);
    }
  }
  el('results') && el('results').classList.remove('hidden');
}
