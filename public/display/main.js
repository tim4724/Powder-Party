// Powder Party — display (big screen) entry. Authoritative: runs the slope sim
// in the browser, renders it, and drives the lobby/run lifecycle. Phones are
// thin controllers reached over the relay (DisplayNet). Adapted from the
// reference kart display main.js — same orchestration shape, ski game logic.
import { DisplayNet, fetchQR, renderQR, renderJoinUrl, buildReconnectCard } from './Net.js';
import { SceneRenderer } from './SceneRenderer.js';
import { buildSlopeById, buildGeneratedSlope } from './SlopeBuilder.js';
import { SLOPES } from '../shared/slopes.js';
import { RunSession } from './RunSession.js';
import { AiController, AI_PERSONALITIES } from './AiDriver.js';
import { SlopeAudio } from './Audio.js';
import { keepScreenOn } from '../shared/WakeLock.js';
import { initDebugMenu } from '../shared/DebugMenu.js';
import { buildLevelSeg, paintLevelSeg } from '../shared/levelSeg.js';

const {
  MSG, ROOM_STATE, COUNTDOWN_SECONDS, MAX_PLAYERS, SKIER_COLORS, LEVELS, DEFAULT_LEVEL,
} = window;
const isLevel = (id) => LEVELS.some((l) => l.id === id);

const FIELD_SIZE = MAX_PLAYERS;     // skiers in a run (humans topped up with CPU)
const AI_PREFIX = 'ai-';
const HUD_HZ_MS = 150;              // PLAYER_STATE / HUD throttle (~6.5 Hz)
const COAST_OUT_MAX_MS = 20_000;   // failsafe cap on the post-results coast (then hold)

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// Test/scenario mode (gallery cards, snapshots) wants a STABLE slope; live play
// wants a fresh random one per run. (`scenario`/`test` are also read at boot below.)
const testMode = params.get('test') === '1' || !!params.get('scenario');

// Run difficulty (Blue/Red/Black) — the host picks it from the lobby (SET_LEVEL);
// the display is authoritative and feeds it into every generated mountain. `?level`
// pins it for previews/snapshots; otherwise it starts at DEFAULT_LEVEL and follows
// the host's choice. Only the procedural HILL changes per tier — never the physics.
let currentLevel = isLevel(params.get('level')) ? params.get('level') : DEFAULT_LEVEL;

// Build the slope for the NEXT run. Precedence: an explicit catalog id (the
// gallery's Slopes page / the `powder-bowl` reference) → the `tricks` scenario's
// straight `trick-lab` practice run → an explicit `?seed` (deterministic repro +
// tests) → a fixed seed in test mode (stable gallery + snapshots) → a fresh
// random seed (live play, a new mountain every run). Generated slopes carry the
// current difficulty tier; the catalog/lab slopes are fixed by their own data.
function makeSlope() {
  const id = params.get('slope');
  if (id && SLOPES[id]) return buildSlopeById(id);
  if (params.get('scenario') === 'tricks') return buildSlopeById('trick-lab');
  if (params.get('scenario') === 'bump') return buildSlopeById('bump-lab');
  const opts = { level: currentLevel };
  const seedParam = params.get('seed');
  if (seedParam != null && seedParam !== '') {
    const n = parseInt(seedParam, 10);
    if (Number.isNaN(n)) console.warn(`[powder] non-numeric ?seed=${seedParam} — using seed 0`);
    return buildGeneratedSlope(n >>> 0, opts);
  }
  if (testMode) return buildGeneratedSlope(1, opts);
  return buildGeneratedSlope((Math.random() * 0xffffffff) >>> 0, opts);
}
let slope = makeSlope();

// ---- renderer + audio ----------------------------------------------------
const scene = new SceneRenderer(el('scene'), SKIER_COLORS);
scene.orbit = true;
const audio = new SlopeAudio();
// Pole break-offs are renderer-only (the engine never sees the edge poles), so
// their clack hooks in here rather than through onRaceEvent. Quiet once the
// results panel is up, like every other run sound.
scene.onPoleHit = (kick) => { if (!raceEnded) audio.pole(kick); };
// Web Audio unlocks only via a user gesture ON THIS page — startRun is driven
// by a phone message, which doesn't count, so without this the race can stay
// silent until someone touches the display. Either gesture unlocks audio and
// clears the hint toast (each listener is `once`; the survivor firing later is
// a harmless idempotent repeat).
const unlockAudio = () => { audio.resume(); const h = el('sound-hint'); if (h) h.remove(); };
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });
// A run starting while audio is still locked would just be silently silent —
// say why, until the first gesture lifts both the lock and the hint.
function showSoundHint() {
  if (audio.ready || el('sound-hint')) return;
  const d = document.createElement('div');
  d.id = 'sound-hint';
  d.textContent = '🔈 Click or press a key for sound';
  document.body.appendChild(d);
  // Some displays allow audio without a gesture (kiosk autoplay permission) —
  // then the context unlocks on its own and the hint should clear itself.
  const t = setInterval(() => { if (audio.ready) { d.remove(); clearInterval(t); } }, 500);
}
const trackOpts = { hitbox: params.get('hitbox') === '1' }; // ?hitbox=1 — wireframe collision footprints
// The grade colour for the run's tier (Blue/Red/Black), used to cap the edge
// poles so the difficulty reads at a glance mid-run. Keyed off the slope's own
// def.level when it has one (a catalog/by-id preview), else the live tier.
const levelColor = (id) => (LEVELS.find((l) => l.id === id) || {}).color;
const applyTrack = () => scene.setTrack(slope, {
  ...trackOpts,
  poleColor: levelColor((slope.def && slope.def.level) || currentLevel),
});
applyTrack();
scene.start();

// ---- run state -----------------------------------------------------------
let session = null;
let currentField = [];               // full roster incl. AI (for results naming)
let aiBots = new Map();              // id -> AiController
let humanIds = new Set();
let paused = false;
let raceEnded = false;       // results panel up (every human across) — world may still be coasting
let raceEndedAt = 0;         // performance.now() when the panel went up — bounds the coast-out
let coastSettled = false;    // one-shot: final board refresh once the coast-out comes to rest
let lastHud = 0;

// ---- net -----------------------------------------------------------------
const net = new DisplayNet({
  onRoomReady,
  onRosterChange: renderRoster,
  onReconnectChange: renderReconnect,   // dropped seats awaiting a rejoin → QR cards
  onPlayerRekey: rekeyPlayer,           // cross-device rejoin: move their skier to the new slot
  onControllerMessage,
  // WELCOME's inRun flag: does this peer have a live (non-DNF) skier in the
  // current run? A reconnecting phone that doesn't — its seat expired, or a
  // rematch started without it — waits in its lobby instead of a dead game pad.
  isInRun: (id) => { const s = session && session.engine.skiers.get(id); return !!s && !s.dnf; },
  // Once the run is decided, stamp the final standings onto every WELCOME so a
  // phone arriving during RESULTS (fresh joiner or a reconnect) lands on the
  // results board the big screen is showing, not a misleading lobby. Mid-run,
  // stamp the frozen state instead, so a rejoiner's phone comes back showing
  // the pause overlay rather than a live HUD over a frozen world.
  welcomeExtras: () => {
    // Every WELCOME carries the room's current difficulty so a joiner's lobby
    // selector lands on the right tier; mid-run/results extras ride alongside.
    const extra = { level: currentLevel };
    if (session) {
      if (raceEnded) extra.standings = standingsPayload(true);
      else if (paused) extra.paused = true;
    }
    return extra;
  },
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
  // Host picks the run difficulty from the lobby. Honoured only in the lobby (the
  // selector is lobby-only) — it re-rolls the orbiting preview to the chosen tier.
  else if (data.type === MSG.SET_LEVEL) { if (from === net.flow.host && net.roomState === ROOM_STATE.LOBBY) setLevel(data.level); }
  else if (data.type === MSG.PAUSE_GAME) pauseRun();   // any player may pause (friendly)
  else if (data.type === MSG.RESUME_GAME) resumeRun();
  // host-gated: aborting the run back to the lobby affects everyone.
  else if (data.type === MSG.RETURN_TO_LOBBY) { if (from === net.flow.host) returnToLobby(); }
}

// Forfeit a human's skier out of the live run: the engine marks it DNF so the
// run can still reach raceOver (session.forfeit re-checks it and may end the
// run). The skier is NOT removed — it keeps its split-screen cell (no layout
// reshuffle for everyone else) and its DNF row in the results. Without this a
// departed skier never finishes and the run only ends via the MAX_RUN_MS
// failsafe. Fires on playerleave — a clean back-out (LEAVE) or a dropped seat
// whose reconnect grace window elapsed — and when every connected human is home
// but a dropped ghost is still "on track" (see onFrame). Once the run is decided
// (raceEnded) or the skier already CROSSED THE LINE there is nothing to forfeit:
// an earned result stands — rewriting the board after the fact is exactly the
// "vanishing player" bug this guards against. A brief mid-run disconnect does
// NOT come through here: the skier is kept descending (camera stays on it) so a
// quick reconnect resumes driving.
function forfeitSkier(peerIndex) {
  if (!session || !humanIds.has(peerIndex)) return;
  const s = session.engine.skiers.get(peerIndex);
  if (raceEnded || !s || s.finished) return;
  humanIds.delete(peerIndex);
  session.forfeit(peerIndex);
  // Flip the ghost to DNF on the phones' live board now — the next finish event
  // may be a long way off. forfeit() may have just ended the run (last skier out),
  // in which case endRun already broadcast the final (over) standings.
  if (!raceEnded) broadcastStandings(false);
}
net.flow.on('playerleave', ({ peerIndex }) => { forfeitSkier(peerIndex); releaseOrphanedResults(); });

// A results board needs a host to restart it, and during RESULTS host duty is
// restricted to the run's participants (RoomFlow) — a late joiner can't inherit
// it. So once every human who raced is GONE from the roster (left, or their
// reconnect grace expired — a held seat still counts as present), the board is
// orphaned: nobody on it can press anything, and a phone joining later would be
// stuck "waiting for the host". Fold the room back to the lobby — late joiners
// land there with host duty unrestricted (oldest gets the Start button), and an
// emptied room shows the join QR front door instead of an abandoned board.
// Checked on every leave and at run end (the field may already have walked out
// mid-run). The fieldIds.size guard keeps the all-CPU dev run ('g' key, no
// humans) holding its board as before.
function releaseOrphanedResults() {
  const orphaned = () => {
    if (!raceEnded || net.roomState !== ROOM_STATE.RESULTS) return false;
    const fieldIds = new Set(currentField.filter((p) => !p.ai).map((p) => p.peerIndex));
    return fieldIds.size > 0 && !net.roster().some((p) => fieldIds.has(p.peerIndex));
  };
  if (!orphaned()) return;
  // Deferred a tick: endRun fires from inside session.update (mid-frame), and
  // returnToLobby tears the session down — yanked out from under onFrame it
  // would null-deref. Re-checked on fire in case a racer re-seated meanwhile.
  setTimeout(() => { if (orphaned()) returnToLobby(); }, 0);
}

// A dropped player reconnected on a different device (new peerIndex): move their
// still-descending skier — engine, render entry and results identity — onto the
// new slot so that phone drives it and the camera keeps following the same skier.
function rekeyPlayer(oldId, newId) {
  if (!session || !session.rekeyCar(oldId, newId)) return;
  scene.rekeySkier(oldId, newId);
  if (humanIds.delete(oldId)) humanIds.add(newId);
  if (_rcShown.delete(oldId)) _rcShown.add(newId);
  for (const p of currentField) { if (p.peerIndex === oldId) p.peerIndex = newId; }
}

// Dropped-seat reconnect cards: a QR centred in each disconnected player's
// split-screen cell so they can scan — their own phone OR a new one — and drop
// back into their exact seat. The card rides on their still-descending skier via
// the renderer; SceneRenderer._loop keeps it centred. Driven by
// DisplayNet.onReconnectChange; diffed against what's shown so a roster reshuffle
// only adds/removes the cards that changed.
const _rcShown = new Set(); // skier ids currently showing a reconnect card
function renderReconnect(seats) {
  const want = new Set(seats.map((s) => s.peerIndex));
  for (const id of [..._rcShown]) {
    if (!want.has(id)) { scene.setSkierReconnect(id, null); _rcShown.delete(id); }
  }
  for (const s of seats) {
    if (_rcShown.has(s.peerIndex)) continue;             // already showing this seat's card
    if (scene.setSkierReconnect(s.peerIndex, buildReconnectCard(s))) _rcShown.add(s.peerIndex);
  }
}

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

// ---- run difficulty (Blue/Red/Black) -------------------------------------
// The lobby shows the SAME Blue/Red/Black switch as the host's phone (shared
// widget) and the orbiting slope preview re-rolls to the chosen tier, so the
// difficulty reads before anyone starts. The big screen is authoritative, so its
// switch is LIVE: a tap routes straight into `setLevel` (on a pointer-less TV
// it's an inert mirror of the host's pick). `setLevel` is the one authoritative
// entry point — host phone (SET_LEVEL) and big screen alike land here: it stores
// the tier, repaints, tells every phone (LEVEL_UPDATE) and — while idle in the
// lobby — rebuilds the previewed mountain. Only the HILL changes per tier; the
// physics every skier rides are identical.
function renderLevel() {
  const seg = el('level-seg');
  if (!seg) return;
  buildLevelSeg(seg, LEVELS, setLevel); // idempotent build; tap → setLevel (authoritative)
  paintLevelSeg(seg, currentLevel, false); // always live on the big screen — no host gate
}

function setLevel(level) {
  if (!isLevel(level) || level === currentLevel) return;
  currentLevel = level;
  renderLevel();
  net.broadcast({ type: MSG.LEVEL_UPDATE, level: currentLevel });
  // Re-roll the lobby preview to the new tier (idle only — at results the live
  // world owns the scene; the pick still lands on the next slope at teardown).
  if (!session) { slope = makeSlope(); window.__slope = slope; applyTrack(); }
}

// ---- field build (humans + AI fill) -------------------------------------
// `reservedColors` keeps CPU liveries off colours owned by seats that aren't in
// this field — a disconnected player still inside their reconnect grace window
// must not come back to find a bot wearing their colour.
function buildField(humans, reservedColors) {
  const used = new Set(reservedColors || humans.map((h) => h.colorIndex));
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
  if (session) return;
  net.flow.transitionTo(ROOM_STATE.COUNTDOWN);
  raceEnded = false; paused = false; coastSettled = false;
  aiBots = new Map();
  const roster = net.roster();
  const humans = roster.filter((p) => p.connected !== false);
  currentField = buildField(humans, roster.map((p) => p.colorIndex));
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
  showSoundHint();
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
  let live = 0;
  for (const id of humanIds) {
    if (net.flow.isDisconnected(id)) continue; // a dropped ghost can't finish — don't let it hold up the run
    live++;
    const s = session.engine.skiers.get(id);
    if (s && !s.finished) return false;
  }
  return live > 0; // false when every remaining human is dropped (MAX_RUN_MS failsafe covers that)
}

// Are any skiers still sliding? Drives the post-results coast-out: once the panel
// is up we keep stepping the world until the whole field has glided to a stop
// (bounded by COAST_OUT_MAX_MS so a freak non-finisher can't loop forever).
function worldMoving() {
  if (!session) return false;
  if (performance.now() - raceEndedAt > COAST_OUT_MAX_MS) return false;
  for (const s of session.engine.skiers.values()) if (s.v > 0.3) return true;
  return false;
}

scene.onFrame = (dt) => {
  if (!session || paused) return;

  if (!raceEnded) {
    // Live race. session.update can end the run itself (raceOver/timeout → _finish
    // → endRun), so re-check raceEnded before the humans-done trigger fires too.
    driveBots();
    session.update(dt * 1000);
    if (!raceEnded && session.racing && humansAllDone()) {
      // Every connected human is home. A dropped racer's UNFINISHED ghost can never
      // cross the line (no input), so forfeit it now — it stays on the board as a
      // DNF row in its own cell — otherwise the run would hang on it (raceOver
      // never trips) until the MAX_RUN_MS failsafe. A ghost that already finished
      // keeps its real result (forfeitSkier refuses to touch it).
      for (const [id, s] of session.engine.skiers) {
        if (!aiBots.has(id) && net.flow.isDisconnected(id) && !s.finished) forfeitSkier(id);
      }
      if (!raceEnded) endRun(session.getResults()); // forfeiting the last ghost may have ended it
    }
  } else if (worldMoving()) {
    // Results panel is up but the field is still in motion: keep stepping so the
    // just-finished skier glides to a natural stop and any CPU still out race in,
    // all behind the translucent panel — instead of the world snapping to a halt.
    // Step the engine directly: `racing` may already be false (raceOver ended it).
    driveBots();
    session.engine.update(dt * 1000);
  } else {
    // Settled — hold the final frame under the results panel. One last board
    // render flips any lingering "…" (still skiing) rows to DNF: nothing can
    // finish anymore, even when the engine's raceOver never tripped (timeout).
    if (!coastSettled) { coastSettled = true; showResults(session.getResults(), currentField, true); }
    return;
  }

  const snap = session.getSnapshot();
  let packSpd = 0;
  for (const s of snap.skiers) {
    if (s.pose) scene.setSkierPose(s.id, s);
    packSpd = Math.max(packSpd, s.v);
    if (!raceEnded && (s.offPiste || (s.crashed && s.spin))) audio.scrape(0.8); // deep-snow hiss / wipeout
  }

  // Run decided (results panel up): keep posing the coasting skiers, but go quiet —
  // no wind, no HUD — so it reads as a results screen, not a live race.
  if (raceEnded) return;
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
  // Standings tick on every crossing. Once the panel is up (all humans across),
  // keep refreshing it so the CPU still coasting in fill their DNFs with real
  // times on the live board.
  if (e.type === 'finish') {
    broadcastStandings(raceEnded);
    if (raceEnded && session) showResults(session.getResults());
    return;
  }
  // Run decided: the world keeps moving behind the results panel, but stay silent
  // so a stray CPU jump/crash doesn't rattle over the board.
  if (raceEnded) return;
  audio.raceEvent(e);
}

// Connected humans with a seat but NO skier in the current run — phones that
// joined after the field was built. They wait out the run (their controller
// shows the "run in progress" screen) and are folded into the next one, since
// startRun rebuilds the field from the live roster.
function lateJoiners() {
  const inField = new Set(currentField.map((p) => p.peerIndex));
  return net.roster().filter((p) => p.connected !== false && !inField.has(p.peerIndex));
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
        finished: r.finished, time: r.time, dnf: !!r.dnf,
      };
    // Late joiners ride along under the board (newPlayer) so their own phone —
    // and everyone else's — shows who's queued up for the next run.
    }).concat(lateJoiners().map((p) => ({
      playerId: p.peerIndex, name: p.name || 'Skier',
      colorIndex: p.colorIndex || 0, ai: false,
      finished: false, dnf: false, newPlayer: true,
    }))),
  };
}
function broadcastStandings(over) { if (session) net.broadcast(standingsPayload(over)); }

function endRun(results) {
  if (raceEnded) return; // panel already up (humans done) — onRaceEvent keeps it refreshed
  raceEnded = true;
  raceEndedAt = performance.now();
  net.flow.transitionTo(ROOM_STATE.RESULTS);
  broadcastStandings(true);
  audio.stopWind();
  audio.finish();
  showResults(results);
  releaseOrphanedResults(); // the whole field may have walked out mid-run
}

// `field` is the full roster (incl. AI) used to name + colour the rows; defaults
// to the live `currentField` but is passed explicitly by the test harness so the
// preview shares this exact render path instead of re-implementing it. `settled`
// forces the fully-over reading once the coast-out has come to rest (nothing can
// finish anymore), covering the timeout end where raceOver never trips. `joiners`
// lets the harness preview late-join rows; live renders derive them themselves.
function showResults(results, field = currentField, settled = false, joiners = null) {
  const list = el('results-list');
  if (list) {
    list.innerHTML = '';
    const byId = new Map(field.map((p) => [p.peerIndex, p]));
    // While the panel is up but skiers are still coasting in, an unfinished row is
    // "still going" (…), not a DNF. DNF is reserved for a forfeited (dropped)
    // skier and for when the run is fully over and someone truly never crossed.
    const fullyOver = settled || !session || session.engine.raceOver;
    for (const r of results.results) {
      const p = byId.get(r.playerId) || {};
      const li = document.createElement('li');
      const color = SKIER_COLORS[(p.colorIndex || 0) % SKIER_COLORS.length];
      const time = r.finished && r.time != null ? r.time.toFixed(1) + 's' : (r.dnf || fullyOver ? 'DNF' : '…');
      li.innerHTML =
        `<span class="res__rank">${r.rank}</span>` +
        `<span class="dot" style="background:${color}"></span>` +
        `<span class="res__name">${escapeHtml(p.name || 'Skier')}${p.ai ? ' <span class="res__cpu">CPU</span>' : ''}</span>` +
        `<span class="res__time">${time}</span>`;
      list.appendChild(li);
    }
    // Late joiners (seated but not in this run) close out the board as unranked
    // "next run" rows, so the room sees the newcomer is in for the rematch.
    // joiners=null = derive from the live roster (empty in harness mode, where
    // the flow has no players); the harness passes its preview rows explicitly.
    for (const p of joiners ?? lateJoiners()) {
      const li = document.createElement('li');
      li.className = 'res--joining';
      const color = SKIER_COLORS[(p.colorIndex || 0) % SKIER_COLORS.length];
      li.innerHTML =
        `<span class="res__rank">–</span>` +
        `<span class="dot" style="background:${color}"></span>` +
        `<span class="res__name">${escapeHtml(p.name || 'Skier')}</span>` +
        `<span class="res__time">next run</span>`;
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
  _rcShown.clear(); // drop any stale reconnect-card bookkeeping before the next run
  currentField = []; aiBots = new Map(); humanIds = new Set();
  raceEnded = false; paused = false; coastSettled = false;
  audio.stopWind();
  slope = makeSlope();
  window.__slope = slope;
  applyTrack();
}

function returnToLobby() {
  teardownRun();
  net.flow.transitionTo(ROOM_STATE.LOBBY);
  net.broadcast({ type: MSG.GAME_END });
  scene.orbit = true;
  showLobby();
}

// Rematch from the results screen: fresh random slope, same lobby, straight into a
// new run (RESULTS → COUNTDOWN is a valid flow transition). Only from a finished
// run; startRun rebuilds the field from the current roster and broadcasts the
// countdown, which pulls every phone off its results board into the new race.
function playAgain() {
  if (!session) return;
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
// html.in-session keeps the device-choice overlay (below) from resurfacing over
// a live run when a desktop window is resized into the cramped-viewport media
// query; the lobby is this page's "front door", where the chooser may show.
function showLobby() {
  el('lobby').classList.remove('hidden');
  el('race').classList.add('hidden');
  el('results') && el('results').classList.add('hidden');
  el('pause-overlay') && el('pause-overlay').classList.add('hidden');
  const c = el('countdown'); if (c) c.textContent = '';
  document.documentElement.classList.remove('in-session');
  renderLevel(); // keep the difficulty badge current whenever the lobby surfaces
}
function showRace() {
  el('lobby').classList.add('hidden');
  el('race').classList.remove('hidden');
  el('results') && el('results').classList.add('hidden');
  scene.orbit = false;
  document.documentElement.classList.add('in-session');
}

// ---- device choice --------------------------------------------------------
// This is the big-screen page, but phones land on it too — a shared link, or a
// controller bailing out of a dead room (/?bail=game_ended from the phone's
// "game ended" path). A CSS media query (display.css) surfaces the #device-choice
// overlay on cramped viewports; here we wire its buttons and the bail toast.
// Visibility is driven purely by root classes so dismissal survives re-layouts.
function dismissDeviceChoice() {
  document.documentElement.classList.add('device-choice-dismissed');
}
// Continuing on this device is a navigation step: push a history entry so the
// phone's back gesture restores the chooser (the popstate below syncs the root
// class with the entry's state) instead of leaving the site. The test-mode
// pre-dismiss at boot stays history-less on purpose — gallery iframes never
// navigate. try: pushState can throw in a sandboxed iframe.
el('dc-continue') && el('dc-continue').addEventListener('click', () => {
  dismissDeviceChoice();
  try { history.pushState({ dcDismissed: true }, ''); } catch (_) { /* sandboxed iframe */ }
});
window.addEventListener('popstate', (e) => {
  // testMode guard: a spurious popstate (old Safari fires one on load) must
  // never strip the boot pre-dismiss off a gallery/preview iframe.
  if (!testMode) document.documentElement.classList.toggle('device-choice-dismissed', !!(e.state && e.state.dcDismissed));
});
// "Open on a large screen": hand the bare site URL to the native share sheet, or
// copy it where share isn't available — either way the phone's job is just to
// ferry the link to a TV/laptop browser.
const dcShare = el('dc-share');
dcShare && dcShare.addEventListener('click', async () => {
  const url = window.location.origin;
  try {
    if (navigator.share) { await navigator.share({ title: 'Powder Party', url }); return; }
    await navigator.clipboard.writeText(url);
    dcShare.textContent = 'Link copied — open it on a big screen';
  } catch (_) { /* share sheet dismissed / clipboard blocked — leave the button as is */ }
});
// A controller that hit a dead end navigates here with ?bail=<reason>; surface
// it as a toast over the chooser. Reasons are allow-listed so a crafted URL
// can't inject arbitrary text, and the param is stripped so a reload is clean.
const BAIL_REASONS = {
  game_ended: 'The game has ended.',
  room_not_found: 'Room not found — that game has ended.',
  game_full: 'That room is full.',
};
// Auto-hide so the chooser doesn't keep advertising a stale reason after the
// user has had a chance to read it; held open in test mode so the gallery's
// device-choice snapshot keeps showing it.
let bailToastTimer = null;
function showBailToast(text) {
  const toast = el('dc-toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(bailToastTimer);
  if (!testMode) bailToastTimer = setTimeout(() => toast.classList.add('hidden'), 5000);
}
{
  const reason = BAIL_REASONS[params.get('bail')];
  if (reason) {
    showBailToast(reason);
    // The bail must be SEEN: a chooser dismissed earlier in this tab comes
    // back, and focus lands on the primary action for keyboard/screen-reader
    // users — skipped while the media query keeps the overlay hidden (desktop
    // viewports land on the lobby silently, which is the intended behaviour).
    document.documentElement.classList.remove('device-choice-dismissed');
    // Focus after the first layout pass (rAF): measured synchronously at load
    // the overlay may not be laid out yet, and the width guard — which skips
    // the focus when the media query keeps the chooser hidden — would also
    // skip it on a real phone.
    if (dcShare) requestAnimationFrame(() => {
      if (dcShare.getBoundingClientRect().width > 0) { try { dcShare.focus(); } catch (_) { /* old browsers */ } }
    });
    const clean = new URLSearchParams(location.search);
    clean.delete('bail');
    const qs = clean.toString();
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '')); } catch (_) { /* sandboxed iframe */ }
  }
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
// Keep the shared screen awake for the whole session — the lobby QR is the
// party's front door, so the lock isn't scoped to active races.
keepScreenOn();
const scenario = params.get('scenario');
// Test/gallery iframes are small enough to trip the device-choice media query —
// pre-dismiss the chooser so it doesn't blanket every preview card. Its own
// scenario is the one preview that wants it up (the iframe IS a cramped
// viewport, so the media query shows it there with no further staging).
if (testMode && scenario !== 'device-choice') dismissDeviceChoice();
if (params.get('test') === '1' || scenario) {
  import('./TestHarness.js').then(({ runDisplayScenario }) => runDisplayScenario(
    // tricks defaults to a single full-screen skier (just you, drilling flips); add ?players=N for a CPU field
    { scenario: scenario || 'running', players: parseInt(params.get('players'), 10) || (scenario === 'tricks' ? 1 : 4), host: parseInt(params.get('host'), 10) || 0 },
    // Inject the REAL render fns so the harness previews the live DOM path rather
    // than a hand-copy (which drifts — see renderRoster/showResults).
    { scene, slope, AiController, AI_PERSONALITIES, RunSession, renderRoster, renderLevel, showResults, buildReconnectCard, audio, showSoundHint }
  ));
} else {
  showLobby();
  renderRoster([], null);
  net.start();
  // Goodbye on the way out: closing/navigating the big screen ends the game
  // (a reload creates a brand-new room), so tell the phones NOW — they bail
  // straight to the device chooser instead of sitting out the display-gone
  // grace window. Best-effort: an unload-time WS send can be dropped (crash,
  // dead battery, iOS killing the page), which is exactly what the
  // controller's bail timer still covers.
  window.addEventListener('pagehide', () => net.broadcast({ type: MSG.DISPLAY_CLOSED }));
}

// debug hooks
window.__net = net; window.__scene = scene; window.__slope = slope; window.__audio = audio;
window.__startRun = startRun; window.__session = () => session;
window.__driveBots = driveBots; // lets the E2E suite fast-forward a LIVE run: __session().fastForwardToEnd(__driveBots)

// ⚙ debug menu — every query param this page reads (see makeSlope + the boot
// branch above; scenario docs live atop TestHarness.js). Bare ?test=1 boots the
// 'running' scenario, so show it as such (and keep it on a Go that tweaks
// another field — rebuilt URLs say scenario=running explicitly).
initDebugMenu([
  { key: 'scenario', label: 'Scenario', type: 'select', hint: 'no-relay preview/lab — overrides live play',
    value: params.get('test') === '1' && !scenario ? 'running' : undefined, options: [
    ['', 'live (off)'],
    ['running', 'running — CPU split-screen run'],
    ['solo', 'solo — keyboard race vs CPU'],
    ['tricks', 'tricks — trick lab (keyboard)'],
    ['bump', 'bump — contact lab (keyboard)'],
    ['slope', 'slope — orbiting slope preview'],
    ['lobby', 'lobby — fake roster'],
    ['countdown', 'countdown beat'],
    ['paused', 'paused overlay'],
    ['results', 'results board'],
    ['reconnect', 'reconnect — rejoin QR card'],
    ['device-choice', 'device choice — phone-on-display chooser'],
  ] },
  { key: 'players', label: 'Players', type: 'number', min: 1, max: 4, hint: 'field size in scenarios (default 4, tricks 1)' },
  { key: 'slope', label: 'Slope', type: 'select', hint: 'catalog slope — else a generated mountain', options: [['', 'generated'], ...Object.keys(SLOPES)] },
  { key: 'level', label: 'Difficulty', type: 'select', hint: 'procedural tier — host picks live; this pins it', options: [['', `default (${DEFAULT_LEVEL})`], ...LEVELS.map((l) => [l.id, l.label])] },
  { key: 'seed', label: 'Seed', type: 'number', hint: 'pins the generated mountain (deterministic repro)' },
  { key: 'hitbox', label: 'Hitbox overlay', type: 'check', hint: 'wireframe collision footprints in the (s, lat) plane' },
]);
