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

const el = (id) => document.getElementById(id);

export async function runDisplayScenario(cfg, ctx) {
  const { scene, slope, scenePromise, SKIER_COLORS, AiController, AI_PERSONALITIES, RunSession } = ctx;
  await scenePromise;

  const N = Math.max(1, Math.min(4, cfg.players || 4));
  const scn = cfg.scenario || 'running';

  // build a CPU field
  const field = [];
  const bots = new Map();
  for (let i = 0; i < N; i++) {
    const persona = AI_PERSONALITIES[i % AI_PERSONALITIES.length];
    const id = 'cpu-' + i;
    field.push({ peerIndex: id, name: persona.name, colorIndex: i, ai: true });
    bots.set(id, new AiController(persona));
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

  scene.orbit = false;
  el('lobby') && el('lobby').classList.add('hidden');
  el('race') && el('race').classList.remove('hidden');
  for (const p of field) scene.addSkier(p.peerIndex, p.colorIndex, p.name, { cell: true });

  let session = newSession();
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
    driveBots(session);
    session.update(dt * 1000);
    const snap = session.getSnapshot();
    for (const s of snap.skiers) {
      if (s.pose) scene.setSkierPose(s.id, s.pose.pos, s.pose.forward, s.pose.up, s.carve, s.v, s.airborne, s.tuck, s.air, s.spin, s.crashed);
      scene.setSkierHud(s.id, s);
    }
    if (scn === 'running' && session.engine.raceOver) {
      session.dispose();
      session = newSession();
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
  } else { // running (default)
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
