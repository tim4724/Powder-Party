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
//          ↓ front flip · Q side-left · E side-right
//        (add &players=4 for a CPU field, or &slope=powder-bowl for the real run)

const el = (id) => document.getElementById(id);

// Minimal keyboard → CONTROL {s,t,j,f} reader for the `tricks` scenario, mirroring
// the controller's TiltInput (carve) + SwipeInput (brake/jump/flip) key maps so the
// no-relay preview exercises the real engine input path.
function keyboardDriver() {
  const st = { left: false, right: false, brake: false };
  let jSeq = 0, fSeq = 0, fDir = null;
  const edge = { up: false, down: false, q: false, e: false };
  const down = (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') st.left = true;
    else if (k === 'arrowright' || k === 'd') st.right = true;
    else if (k === 's') st.brake = true;
    else if (k === 'arrowup' || k === ' ') { if (!edge.up) { edge.up = true; jSeq = (jSeq + 1) & 255; } e.preventDefault(); }
    else if (k === 'arrowdown') { if (!edge.down) { edge.down = true; fSeq = (fSeq + 1) & 255; fDir = 'front'; } e.preventDefault(); }
    else if (k === 'q') { if (!edge.q) { edge.q = true; fSeq = (fSeq + 1) & 255; fDir = 'left'; } }
    else if (k === 'e') { if (!edge.e) { edge.e = true; fSeq = (fSeq + 1) & 255; fDir = 'right'; } }
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
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  return { read: () => ({ s: (st.right ? 1 : 0) - (st.left ? 1 : 0), t: st.brake ? 0 : 1, j: jSeq, f: { n: fSeq, d: fDir } }) };
}

export async function runDisplayScenario(cfg, ctx) {
  const { scene, slope, scenePromise, SKIER_COLORS, AiController, AI_PERSONALITIES, RunSession } = ctx;
  await scenePromise;

  const N = Math.max(1, Math.min(4, cfg.players || 4));
  const scn = cfg.scenario || 'running';
  const human = scn === 'tricks';        // skier 0 is keyboard-driven, the rest CPU
  const kb = human ? keyboardDriver() : null;

  // build the field — CPU, except skier 0 when a human drives (the `tricks` lab)
  const field = [];
  const bots = new Map();
  for (let i = 0; i < N; i++) {
    if (human && i === 0) { field.push({ peerIndex: 'me', name: 'You (keys)', colorIndex: 0, ai: false }); continue; }
    const persona = AI_PERSONALITIES[i % AI_PERSONALITIES.length];
    const id = 'cpu-' + i;
    field.push({ peerIndex: id, name: persona.name, colorIndex: i, ai: true });
    bots.set(id, new AiController(persona));
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
  seedHuman(session);
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
  function driveBots(sess) {
    for (const [id, bot] of bots) {
      const sk = sess.engine.skiers.get(id);
      if (!sk || sk.finished) continue;
      sess.processInput(id, bot.drive(sk, slope.centerline));
    }
  }

  scene.onFrame = (dt) => {
    if (human) session.processInput('me', kb.read());
    driveBots(session);
    session.update(dt * 1000);
    const snap = session.getSnapshot();
    for (const s of snap.skiers) {
      if (s.pose) scene.setSkierPose(s.id, s.pose.pos, s.pose.forward, s.pose.up, s.carve, s.v, s.airborne, s.tuck, s.air, s.spin, s.crashed, s.trickAxis, s.trickPhase, s.trickSign);
      scene.setSkierHud(s.id, s);
    }
    if ((scn === 'running' || scn === 'slope' || scn === 'tricks') && session.engine.raceOver) {
      session.dispose();
      session = newSession();
      seedHuman(session);
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
