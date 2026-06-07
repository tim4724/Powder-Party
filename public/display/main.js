// Powder Party — display (big screen) entry. Authoritative: runs the slope sim
// in the browser, renders it, and drives the lobby/run lifecycle. Phones are
// thin controllers reached over the relay (DisplayNet). Adapted from the
// reference kart display main.js — same orchestration shape, ski game logic.
import { DisplayNet, fetchQR, renderQR, renderJoinUrl } from './Net.js';
import { SceneRenderer } from './SceneRenderer.js';
import { buildSlopeById, buildGeneratedSlope } from './SlopeBuilder.js';
import { SLOPES } from '../shared/slopes.js';
import { RunSession } from './RunSession.js';
import { AiController, AI_PERSONALITIES } from './AiDriver.js';
import { SlopeAudio } from './Audio.js';

const {
  MSG, ROOM_STATE, COUNTDOWN_SECONDS, MAX_PLAYERS, SKIER_COLORS,
} = window;

const FIELD_SIZE = MAX_PLAYERS;     // skiers in a run (humans topped up with CPU)
const AI_PREFIX = 'ai-';
const HUD_HZ_MS = 150;              // PLAYER_STATE / HUD throttle (~6.5 Hz)

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// Test/scenario mode (gallery cards, snapshots) wants a STABLE slope; live play
// wants a fresh random one per run. (`scenario`/`test` are also read at boot below.)
const testMode = params.get('test') === '1' || !!params.get('scenario');

// Build the slope for the NEXT run. Precedence: an explicit catalog id (the
// gallery's Slopes page / the `powder-bowl` reference) → the `tricks` scenario's
// straight `trick-lab` practice run → an explicit `?seed` (deterministic repro +
// tests) → a fixed seed in test mode (stable gallery + snapshots) → a fresh
// random seed (live play, a new mountain every run).
function makeSlope() {
  const id = params.get('slope');
  if (id && SLOPES[id]) return buildSlopeById(id);
  if (params.get('scenario') === 'tricks') return buildSlopeById('trick-lab');
  if (params.get('scenario') === 'bump') return buildSlopeById('bump-lab');
  const seedParam = params.get('seed');
  if (seedParam != null && seedParam !== '') {
    const n = parseInt(seedParam, 10);
    if (Number.isNaN(n)) console.warn(`[powder] non-numeric ?seed=${seedParam} — using seed 0`);
    return buildGeneratedSlope(n >>> 0);
  }
  if (testMode) return buildGeneratedSlope(1);
  return buildGeneratedSlope((Math.random() * 0xffffffff) >>> 0);
}
let slope = makeSlope();

// ---- renderer + audio ----------------------------------------------------
const scene = new SceneRenderer(el('scene'), SKIER_COLORS);
scene.orbit = true;
const audio = new SlopeAudio();
let sceneReady = false;
const scenePromise = scene.load().then(() => {
  scene.setTrack(slope, { debug: params.get('centerline') === '1' });
  sceneReady = true;
  scene.start();
});

// ---- run state -----------------------------------------------------------
let session = null;
let currentField = [];               // full roster incl. AI (for results naming)
let aiBots = new Map();              // id -> AiController
let humanIds = new Set();
let paused = false;
let raceEnded = false;
let fastForwarding = false;
let lastHud = 0;

// ---- net -----------------------------------------------------------------
const net = new DisplayNet({
  onRoomReady,
  onRosterChange: renderRoster,
  onControllerMessage,
});

function onRoomReady({ joinUrl }) {
  const code = net.roomCode || '';
  renderJoinUrl(el('joinurl'), joinUrl, code);
  fetchQR(joinUrl).then((qr) => renderQR(el('qr'), qr)).catch(() => {});
}

function onControllerMessage(from, data) {
  if (!data) return;
  if (data.type === MSG.CONTROL) { if (session) session.processInput(from, data); }
  // Host's start/rematch. From the lobby this starts the first run; from the results
  // board (run already over) it plays again on a fresh slope.
  else if (data.type === MSG.START_GAME) { if (from === net.flow.host && net.flow.connectedCount > 0) (raceEnded ? playAgain() : startRun()); }
  else if (data.type === MSG.PAUSE_GAME) pauseRun();   // any player may pause (friendly)
  else if (data.type === MSG.RESUME_GAME) resumeRun();
  // host-gated: aborting the run back to the lobby affects everyone.
  else if (data.type === MSG.RETURN_TO_LOBBY) { if (from === net.flow.host) returnToLobby(); }
}

// A human leaving mid-run forfeits: drop their skier from the engine so the run
// can still reach raceOver (forceRemoveCar re-checks it and may end the run),
// and remove their mesh. Without this a departed skier never finishes and the
// run only ends via the MAX_RUN_MS failsafe.
net.flow.on('playerleave', ({ peerIndex }) => {
  if (session && humanIds.has(peerIndex)) {
    humanIds.delete(peerIndex);
    session.forceRemoveCar(peerIndex);
    scene.removeSkier(peerIndex);
  }
});

// ---- lobby roster --------------------------------------------------------
function renderRoster(roster, host) {
  const wrap = el('players');
  if (!wrap) return;
  wrap.innerHTML = '';
  const seats = Math.max(MAX_PLAYERS, roster.length);
  for (let i = 0; i < seats; i++) {
    const p = roster[i];
    const seat = document.createElement('div');
    seat.className = 'seat' + (p ? '' : ' seat--open');
    if (p) {
      const color = SKIER_COLORS[p.colorIndex % SKIER_COLORS.length];
      const isHost = p.peerIndex === host;
      seat.innerHTML =
        `<span class="dot" style="background:${color}"></span>` +
        `<span class="seat__name">${escapeHtml(p.name || 'Player')}</span>` +
        (isHost ? `<span class="seat__host">HOST</span>` : '');
    } else {
      seat.innerHTML = `<span class="seat__open">Open</span>`;
    }
    wrap.appendChild(seat);
  }
  const count = el('count');
  if (count) {
    count.textContent = roster.length
      ? (host != null ? 'First player is host — start the run from your phone' : 'Waiting…')
      : 'Scan the QR code to join';
  }
}

// ---- field build (humans + AI fill) -------------------------------------
function buildField(humans) {
  const used = new Set(humans.map((h) => h.colorIndex));
  // Every skier handles identically (benchmark stats — no `stats` field); players
  // are distinguished only by livery colour, AI only by personality below.
  const field = humans.map((h) => ({
    peerIndex: h.peerIndex,
    name: h.name || ('Player ' + (h.colorIndex + 1)),
    colorIndex: h.colorIndex,
    ai: false,
  }));
  let persona = 0;
  while (field.length < FIELD_SIZE && persona < AI_PERSONALITIES.length) {
    let colorIndex = 0;
    while (used.has(colorIndex) && colorIndex < SKIER_COLORS.length) colorIndex++;
    used.add(colorIndex);
    const p = AI_PERSONALITIES[persona];
    const id = AI_PREFIX + persona;
    // CPU skiers carry a smooth `glide` handicap (the difficulty dial → a beatable
    // tail, a boss at the player's pace); `edge` stays the benchmark 1.0 — no grip
    // advantage. Humans always ski the benchmark (no stats).
    field.push({ peerIndex: id, name: p.name, colorIndex, ai: true, stats: { glide: p.glide, edge: p.edge } });
    aiBots.set(id, new AiController(p));
    persona++;
  }
  return field;
}

// ---- run lifecycle -------------------------------------------------------
function startRun() {
  if (session || !sceneReady) return;
  net.flow.transitionTo(ROOM_STATE.COUNTDOWN);
  raceEnded = false; paused = false; fastForwarding = false;
  aiBots = new Map();
  const humans = net.roster().filter((p) => p.connected !== false);
  currentField = buildField(humans);
  humanIds = new Set(currentField.filter((p) => !p.ai).map((p) => p.peerIndex));

  // add skier meshes (humans get a split-screen cell; CPU share the world)
  scene.clearTrails(); // fresh snow for each run
  for (const p of currentField) scene.addSkier(p.peerIndex, p.colorIndex, p.name, { cell: !p.ai });

  session = new RunSession(currentField, slope, {
    onRaceEvent,
    onCountdownTick,
    onRaceStart,
    onRaceEnd: endRun,
  });
  audio.resume();
  showRace();
  session.startCountdown(COUNTDOWN_SECONDS);
}

function onCountdownTick(n) {
  const c = el('countdown');
  if (c) {
    if (n > 0) { c.textContent = String(n); c.classList.remove('is-go'); }
    else if (n === 0) { c.textContent = 'GO!'; c.classList.add('is-go'); }
    else { c.textContent = ''; c.classList.remove('is-go'); }
  }
  if (n >= 0) { net.broadcast({ type: MSG.COUNTDOWN, n }); audio.countdown(n); }
}

function onRaceStart() {
  net.flow.transitionTo(ROOM_STATE.PLAYING);
  net.broadcast({ type: MSG.GAME_START });
  audio.startWind();
}

function driveBots() {
  if (!aiBots.size || !session) return;
  for (const [id, bot] of aiBots) {
    const skier = session.engine.skiers.get(id);
    if (!skier || skier.finished) continue;
    session.processInput(id, bot.drive(skier, session.engine));
  }
}

function humansAllDone() {
  if (!humanIds.size) return false; // all-CPU preview: never fast-forward
  for (const id of humanIds) {
    const s = session.engine.skiers.get(id);
    if (s && !s.finished) return false;
  }
  return true;
}

scene.onFrame = (dt) => {
  if (!session || paused || raceEnded) return;
  driveBots();
  session.update(dt * 1000);

  if (session.racing && humansAllDone()) {
    fastForwarding = true;
    session.fastForwardToEnd(driveBots);
    fastForwarding = false;
    return;
  }

  const snap = session.getSnapshot();
  let packSpd = 0;
  for (const s of snap.skiers) {
    if (s.pose) scene.setSkierPose(s.id, s.pose.pos, s.pose.forward, s.pose.up, s.carve, s.v, s.airborne, s.tuck, s.air, s.spin, s.crashed, s.trickActive, s.trickAngle, s.trickPhase, s.carveInput);
    packSpd = Math.max(packSpd, s.v);
    if (s.offPiste || (s.crashed && s.spin)) audio.scrape(0.8); // deep-snow hiss / wipeout
  }
  audio.setWind(Math.min(1, packSpd / 26));

  if (!session.racing) return; // countdown: posed + steerable, no HUD yet

  const now = performance.now();
  if (now - lastHud > HUD_HZ_MS) {
    lastHud = now;
    for (const s of snap.skiers) {
      scene.setSkierHud(s.id, s);
      if (!humanIds.has(s.id)) continue; // no phone behind a CPU skier
      net.sendTo(s.id, {
        type: MSG.PLAYER_STATE,
        position: s.position, of: s.of, progress: s.progress,
        airborne: s.airborne, finished: s.finished,
      });
    }
  }
};

function onRaceEvent(e) {
  // During the synchronous fast-forward burst we don't push per-event standings
  // or play SFX — endRun broadcasts the final board once it's done.
  if (fastForwarding) return;
  if (e.type === 'finish') broadcastStandings(false);
  else if (e.type === 'jump') audio.jump();
  else if (e.type === 'trick_start') audio.trick();             // whoosh as the flip kicks off
  else if (e.type === 'trick_done') audio.trickLand();          // chime per completed rotation
  else if (e.type === 'land') audio.land(!!e.clean);
  else if (e.type === 'crash') audio.scrape(1);
  else if (e.type === 'bump') audio.bump();       // soft skier-on-skier contact
  else if (e.type === 'reset') audio.land(false); // ski-patrol plop back onto the piste
}

function standingsPayload(over) {
  const byId = new Map(currentField.map((p) => [p.peerIndex, p]));
  const results = session.getResults().results;
  return {
    type: MSG.STANDINGS,
    over,
    hostPeerIndex: net.flow.host,
    total: results.length,
    order: results.map((r) => {
      const p = byId.get(r.playerId) || {};
      return {
        playerId: r.playerId, name: p.name || 'Skier',
        colorIndex: p.colorIndex || 0, ai: !!p.ai,
        finished: r.finished, time: r.time,
      };
    }),
  };
}
function broadcastStandings(over) { if (session) net.broadcast(standingsPayload(over)); }

function endRun(results) {
  raceEnded = true;
  net.flow.transitionTo(ROOM_STATE.RESULTS);
  broadcastStandings(true);
  audio.stopWind();
  audio.finish();
  showResults(results);
}

// `field` is the full roster (incl. AI) used to name + colour the rows; defaults
// to the live `currentField` but is passed explicitly by the test harness so the
// preview shares this exact render path instead of re-implementing it.
function showResults(results, field = currentField) {
  const list = el('results-list');
  if (list) {
    list.innerHTML = '';
    const byId = new Map(field.map((p) => [p.peerIndex, p]));
    for (const r of results.results) {
      const p = byId.get(r.playerId) || {};
      const li = document.createElement('li');
      const color = SKIER_COLORS[(p.colorIndex || 0) % SKIER_COLORS.length];
      li.innerHTML =
        `<span class="res__rank">${r.rank}</span>` +
        `<span class="dot" style="background:${color}"></span>` +
        `<span class="res__name">${escapeHtml(p.name || 'Skier')}${p.ai ? ' <span class="res__cpu">CPU</span>' : ''}</span>` +
        `<span class="res__time">${r.finished && r.time != null ? r.time.toFixed(1) + 's' : 'DNF'}</span>`;
      list.appendChild(li);
    }
  }
  const res = el('results');
  if (res) res.classList.remove('hidden');
}

// Tear down the current run and roll a FRESH random slope for the next one (live
// play only — test mode pins a stable seed). Shared by "New game" (→ lobby) and
// "Play again" (→ straight into the next run); both get a new mountain.
function teardownRun() {
  if (session) { session.dispose(); session = null; }
  for (const p of currentField) scene.removeSkier(p.peerIndex);
  currentField = []; aiBots = new Map(); humanIds = new Set();
  raceEnded = false; paused = false;
  audio.stopWind();
  slope = makeSlope();
  window.__slope = slope;
  if (sceneReady) scene.setTrack(slope, { debug: params.get('centerline') === '1' });
}

function returnToLobby() {
  teardownRun();
  net.flow.transitionTo(ROOM_STATE.LOBBY);
  net.broadcast({ type: MSG.GAME_END, results: null });
  scene.orbit = true;
  showLobby();
}

// Rematch from the results screen: fresh random slope, same lobby, straight into a
// new run (RESULTS → COUNTDOWN is a valid flow transition). Only from a finished
// run; startRun rebuilds the field from the current roster and broadcasts the
// countdown, which pulls every phone off its results board into the new race.
function playAgain() {
  if (!sceneReady || !session) return;
  teardownRun();
  startRun();
}

function pauseRun() {
  if (!session || raceEnded || paused) return;
  paused = true; session.pause();
  el('pause-overlay') && el('pause-overlay').classList.remove('hidden');
  net.broadcast({ type: MSG.GAME_PAUSED });
}
function resumeRun() {
  if (!session || !paused) return;
  paused = false; session.resume();
  el('pause-overlay') && el('pause-overlay').classList.add('hidden');
  net.broadcast({ type: MSG.GAME_RESUMED });
}

// ---- screen toggles ------------------------------------------------------
function showLobby() {
  el('lobby').classList.remove('hidden');
  el('race').classList.add('hidden');
  el('results') && el('results').classList.add('hidden');
  el('pause-overlay') && el('pause-overlay').classList.add('hidden');
  const c = el('countdown'); if (c) c.textContent = '';
}
function showRace() {
  el('lobby').classList.add('hidden');
  el('race').classList.remove('hidden');
  el('results') && el('results').classList.add('hidden');
  scene.orbit = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- pause / results buttons + dev keys ----------------------------------
el('pause-btn') && el('pause-btn').addEventListener('click', () => (paused ? resumeRun() : pauseRun()));
el('pause-continue') && el('pause-continue').addEventListener('click', resumeRun);
el('pause-newgame') && el('pause-newgame').addEventListener('click', returnToLobby);
el('results-again') && el('results-again').addEventListener('click', playAgain);
el('results-newgame') && el('results-newgame').addEventListener('click', returnToLobby);
window.addEventListener('keydown', (e) => {
  if (e.key === 'g' && net.roomState === ROOM_STATE.LOBBY) startRun(); // dev: start without a phone
  else if (e.key === 'Escape') { if (session && !raceEnded) (paused ? resumeRun() : pauseRun()); }
});

// ---- boot: test harness (no relay) OR live play --------------------------
const scenario = params.get('scenario');
if (params.get('test') === '1' || scenario) {
  import('./TestHarness.js').then(({ runDisplayScenario }) => runDisplayScenario(
    // tricks defaults to a single full-screen skier (just you, drilling flips); add ?players=N for a CPU field
    { scenario: scenario || 'running', players: parseInt(params.get('players'), 10) || (scenario === 'tricks' ? 1 : 4), host: parseInt(params.get('host'), 10) || 0 },
    // Inject the REAL render fns so the harness previews the live DOM path rather
    // than a hand-copy (which drifts — see renderRoster/showResults).
    { scene, slope, scenePromise, SKIER_COLORS, AiController, AI_PERSONALITIES, RunSession, renderRoster, showResults }
  ));
} else {
  showLobby();
  renderRoster([], null);
  net.start();
}

// debug hooks
window.__net = net; window.__scene = scene; window.__slope = slope;
window.__startRun = startRun; window.__session = () => session;
