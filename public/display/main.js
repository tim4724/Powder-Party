// Powder Party — display (big screen) entry. Authoritative: runs the slope sim
// in the browser, renders it, and drives the lobby/run lifecycle. Phones are
// thin controllers reached over the relay (DisplayNet). Adapted from the
// reference kart display main.js — same orchestration shape, ski game logic.
import { DisplayNet, fetchQR, renderQR, renderJoinUrl, buildReconnectCard } from './Net.js';
import { SceneRenderer } from './SceneRenderer.js';
import { buildGeneratedSlope } from './SlopeBuilder.js';
import { RunSession } from './RunSession.js';
import { AiController, AI_PERSONALITIES } from './AiDriver.js';
import { SlopeAudio } from './Audio.js';
import { SeriesTally } from './SeriesTally.js';
import { keepScreenOn } from '../shared/WakeLock.js';
import { initDebugMenu } from '../shared/DebugMenu.js';
import { buildLevelSeg, paintLevelSeg } from '../shared/levelSeg.js';
import { runTag } from '../shared/seriesFormat.js';

const {
  MSG, ROOM_STATE, COUNTDOWN_SECONDS, MAX_PLAYERS, SKIER_COLORS, LEVELS, DEFAULT_LEVEL,
  RUN_COUNTS, DEFAULT_RUNS, INTERMISSION_SECONDS, seriesPoints,
} = window;
const isLevel = (id) => LEVELS.some((l) => l.id === id);
const isRunCount = (n) => RUN_COUNTS.includes(n);

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

// Series length — how many runs make up one head-to-head session. The host picks
// it in the lobby (SET_RUNS, restricted to the RUN_COUNTS presets); the display is
// authoritative. `?runs=N` pins it for previews/snapshots/tests and accepts ANY
// positive integer (e.g. ?runs=1 for a one-run series, the old single-run flow);
// otherwise it starts at DEFAULT_RUNS and follows the host's choice. Locked once a
// series starts (the selector is lobby-only).
const runsParam = parseInt(params.get('runs'), 10);
const initialRuns = Number.isInteger(runsParam) && runsParam >= 1 ? runsParam : DEFAULT_RUNS;
// Between-runs auto-advance countdown (seconds). `?intermission=N` shortens it for
// tests/previews; live play uses the INTERMISSION_SECONDS default.
const interParam = parseInt(params.get('intermission'), 10);
const intermissionSeconds = Number.isInteger(interParam) && interParam >= 1 ? interParam : INTERMISSION_SECONDS;

// Build the slope for the NEXT run — always procedural. Precedence: an explicit
// `?seed` (deterministic repro + tests) → a fixed seed in test mode (stable gallery
// + snapshots) → a fresh random seed (live play, a new mountain every run). The
// mountain always carries the current difficulty tier.
// `reroll` is a "Play again" build: it skips test mode's seed-1 pin (so a solo
// rematch is a NEW mountain, not the same one) while still honouring an explicit
// `?seed=` — a deliberately pinned mountain replays identically for repro.
function makeSlope({ reroll = false } = {}) {
  const opts = { level: currentLevel };
  const seedParam = params.get('seed');
  if (seedParam != null && seedParam !== '') {
    const n = parseInt(seedParam, 10);
    if (Number.isNaN(n)) console.warn(`[powder] non-numeric ?seed=${seedParam} — using seed 0`);
    return buildGeneratedSlope(n >>> 0, opts);
  }
  if (testMode && !reroll) return buildGeneratedSlope(1, opts);
  return buildGeneratedSlope((Math.random() * 0xffffffff) >>> 0, opts);
}
let slope = makeSlope();

// ---- renderer + audio ----------------------------------------------------
const scene = new SceneRenderer(el('scene'), SKIER_COLORS);
scene.orbit = true;
const audio = new SlopeAudio();
// Pole break-offs are renderer-only (the engine never sees the edge poles), so
// their clack hooks in here rather than through onRaceEvent. Only during a live
// run (`session`) — the lobby attract race is silent — and quiet once the results
// panel is up, like every other run sound.
scene.onPoleHit = (kick) => { if (session && !raceEnded) audio.pole(kick); };
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
  // Some displays allow audio without a gesture (kiosk autoplay permission) — then
  // the context unlocks on its own and the hint clears itself. Bounded to ~30s so a
  // display that never unlocks (no gesture, no autoplay) doesn't poll forever; a
  // later gesture still clears the hint via the unlockAudio listeners above.
  let ticks = 0;
  const t = setInterval(() => {
    if (audio.ready) { d.remove(); clearInterval(t); }
    else if (++ticks >= 60) clearInterval(t);
  }, 500);
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

// Roll a FRESH slope at the current grade and rebuild the track for it — what
// "Play again" pulls. Returns the new built slope so a caller holding its own
// reference (the solo harness) can re-point it. Live play already re-rolls via
// makeSlope(); the `reroll` flag also breaks test mode's seed-1 pin so a solo
// rematch is a new mountain at the same difficulty, never the same hill twice.
function rerollSlope() {
  slope = makeSlope({ reroll: true });
  window.__slope = slope;
  applyTrack();
  return slope;
}
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

// ---- series state --------------------------------------------------------
// A series is `tally.runsTotal` head-to-head runs with points accumulating to an
// overall champion. The SeriesTally (display/SeriesTally.js) owns the run index,
// length, over-flag, per-player banked scores and the points/folding/row derivation
// — a dependency-free, unit-tested unit (tests/seriesTally.test.js). main.js keeps
// the lifecycle/IO around it: the intermission timer, net broadcasts and DOM. The
// live run's points layer on top of the banked tally each render, so the final run
// is never double-counted. Between runs the display auto-advances after a short
// intermission countdown.
const tally = new SeriesTally(seriesPoints, initialRuns);
let intermissionTimer = null;

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
    // Every WELCOME carries the room's current difficulty + series length so a
    // joiner's lobby selectors land on the right tier/count; mid-run/results
    // extras ride alongside.
    const extra = { level: currentLevel, runs: tally.runsTotal };
    if (session) {
      if (raceEnded) extra.standings = standingsPayload(true);
      else if (paused) extra.paused = true;
    }
    return extra;
  },
});

let currentJoinUrl = '';   // full join link (the string the QR encodes); the chip copies it
function onRoomReady({ joinUrl }) {
  const code = net.roomCode || '';
  currentJoinUrl = joinUrl;
  renderJoinUrl(el('joinurl'), joinUrl, code);
  fetchQR(joinUrl).then((qr) => renderQR(el('qr'), qr)).catch(() => {});
}

function onControllerMessage(from, data) {
  if (!data) return;
  if (data.type === MSG.CONTROL) { if (session) session.processInput(from, data); }
  // Host's start button. From the lobby it kicks off a fresh series; from the final
  // overall board it starts a brand-new series. Mid-series there's no button (the
  // board auto-advances), so a mid-series press is ignored. See onStartPressed.
  else if (data.type === MSG.START_GAME) { if (from === net.flow.host && net.flow.connectedCount > 0) onStartPressed(); }
  // Host picks the run difficulty from the lobby. Honoured only in the lobby (the
  // selector is lobby-only) — it re-rolls the orbiting preview to the chosen tier.
  else if (data.type === MSG.SET_LEVEL) { if (from === net.flow.host && net.roomState === ROOM_STATE.LOBBY) setLevel(data.level); }
  // Host picks the series length from the lobby (lobby-only, like difficulty).
  else if (data.type === MSG.SET_RUNS) { if (from === net.flow.host && net.roomState === ROOM_STATE.LOBBY) setRuns(data.runs); }
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
  // Carry their accumulated series points onto the new slot so a cross-device
  // reconnect mid-series doesn't lose the score they've banked.
  tally.rekey(oldId, newId);
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
// widget) and the attract race re-rolls to the chosen tier, so the
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
  if (!session) lobbyCrossfade(() => { slope = makeSlope(); window.__slope = slope; applyTrack(); startLobbyRace(); });
}

// ---- series length (number of runs) --------------------------------------
// A "Runs" segmented switch (3 / 5 / 7) sits next to Difficulty in the lobby,
// reusing the same shared segment widget. Like the difficulty pick it's host-set
// and display-authoritative: the host's phone (SET_RUNS) and a big-screen tap
// both land in `setRuns`, which stores the count, repaints, and broadcasts
// RUNS_UPDATE. Changing it has no scene side-effect (it's not a per-tier mountain).
function renderRuns() {
  const seg = el('runs-seg');
  if (!seg) return;
  // Items reuse the LEVELS shape ({ id, label, color }); the brand colour fills
  // the active segment (runs have no per-option colour like the piste grades).
  buildLevelSeg(seg, RUN_COUNTS.map((n) => ({ id: String(n), label: String(n), color: 'var(--brand)' })), setRuns);
  paintLevelSeg(seg, String(tally.runsTotal), false); // always live on the big screen — no host gate
}

function setRuns(runs) {
  const n = parseInt(runs, 10);
  if (!isRunCount(n) || n === tally.runsTotal) return;
  tally.setRunsTotal(n);
  renderRuns();
  net.broadcast({ type: MSG.RUNS_UPDATE, runs: tally.runsTotal });
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

// ---- idle lobby backdrop -------------------------------------------------
// A looping CPU-only AI race down the real slope, behind the lobby card, with the
// camera following the pack. Reuses the run path wholesale: buildField + AiController
// bots + RunSession, driven each frame by scene.onFrame (driveLobbyRace below). No
// humans → no split-screen cells → it renders under the single follow camera. Torn
// down the instant a real run starts (its CPU reuse the same ids).
let lobbyField = [];
let lobbySession = null;
let lobbyFading = false;
let lobbyFadeTimer = null;          // pending overlay-clear timer (cancelable — see cancelLobbyCrossfade)
function startLobbyRace() {
  stopLobbyRace();
  if (session) return;                            // a live run owns the scene
  aiBots = new Map();
  lobbyField = buildField([], []);                // all-CPU; buildField fills aiBots
  for (const p of lobbyField) scene.addSkier(p.peerIndex, p.colorIndex, p.name, { cell: false });
  lobbySession = new RunSession(lobbyField, slope, {}); // the lobby attract is silent (no game sound)
  lobbySession.racing = true;                     // ski immediately — no countdown overlay in the lobby
  // Pose the fresh field NOW so the follow cam has skiers to lock onto this very
  // frame — otherwise a re-roll (difficulty pick) flashes the orbit cam.
  for (const s of lobbySession.getSnapshot().skiers) if (s.pose) scene.setSkierPose(s.id, s);
  scene.setLobbyView('race');                     // follow cam (snaps to the fresh pack)
}
function stopLobbyRace() {
  // Tear down the attract race ENTITIES only — never the #lobby-fade overlay. A
  // crossfade runs its swap (this, via `mid`) BEHIND the frozen frame, so clearing
  // the overlay here would reveal the swap mid-dissolve. The fade lifecycle is owned
  // solely by lobbyCrossfade (set up + auto-clear) and cancelLobbyCrossfade (abort).
  for (const p of lobbyField) scene.removeSkier(p.peerIndex);
  lobbyField = [];
  if (lobbySession) { lobbySession.dispose(); lobbySession = null; }
}
// Cross-DISSOLVE the attract straight from the old slope to the new one — no flash
// to a flat colour. Freeze the current frame onto #lobby-fade (opaque, instant —
// indistinguishable from the live canvas), run `mid` (re-roll + restart the race)
// BEHIND it, then fade the frozen frame out to reveal the new scene. The overlay
// covers the 3D scene only, so the lobby cards stay crisp. Used by the attract loop
// (finish → fresh race) AND the difficulty switch (re-roll).
function lobbyCrossfade(mid) {
  if (lobbyFading) return;
  lobbyFading = true;
  const fade = el('lobby-fade');
  const shot = scene.snapshot();
  if (!fade || !shot) { mid(); lobbyFading = false; return; } // no overlay / readback failed → hard swap
  fade.style.backgroundImage = `url("${shot}")`;
  fade.classList.add('is-frozen');  // opaque NOW, no transition — hides the swap that follows
  void fade.offsetWidth;            // commit the opaque state so removing it animates from opacity:1
  mid();                            // swap the scene behind the frozen frame
  fade.classList.remove('is-frozen'); // base rule transitions opacity 1 → 0: the old frame dissolves away
  lobbyFadeTimer = setTimeout(() => {
    lobbyFadeTimer = null;
    fade.style.backgroundImage = '';
    lobbyFading = false;
  }, 450);
}
// Abort an in-flight dissolve: cancel the pending overlay-clear timer and drop the
// frozen snapshot NOW, so it can't linger over the countdown/race (and reset the
// guard). The slope swap itself already ran synchronously inside lobbyCrossfade —
// this only tidies the overlay. Called from startRun and the lobby front door.
function cancelLobbyCrossfade() {
  if (lobbyFadeTimer) { clearTimeout(lobbyFadeTimer); lobbyFadeTimer = null; }
  lobbyFading = false;
  const f = el('lobby-fade'); if (f) { f.classList.remove('is-frozen'); f.style.backgroundImage = ''; }
}
function driveLobbyRace(dt) {
  if (!lobbySession) return;
  for (const [id, bot] of aiBots) {
    const sk = lobbySession.engine.skiers.get(id);
    if (sk && !sk.finished) lobbySession.processInput(id, bot.drive(sk, lobbySession.engine));
  }
  lobbySession.update(dt * 1000);
  for (const s of lobbySession.getSnapshot().skiers) if (s.pose) scene.setSkierPose(s.id, s);
  if (lobbySession.engine.raceOver) lobbyCrossfade(startLobbyRace); // whole field home → loop with a fade
}

// ---- run lifecycle -------------------------------------------------------
// The host's Start button funnels here: from the lobby it begins a fresh series,
// and from the final overall board it begins a NEW series. Mid-series there's no
// manual control — the board auto-advances — so a mid-series START_GAME is ignored.
// A stray START_GAME mid-run is ignored too (startRun guards on `session`, and we
// only kick a series off from the lobby with no live session — scores can't be
// wiped mid-run).
function onStartPressed() {
  if (raceEnded) { if (tally.seriesOver) newSeriesFromResults(); return; }
  if (!session && net.roomState === ROOM_STATE.LOBBY) startSeries();
}

// Kick off a fresh series: wipe the tally and drop into run 1. From the lobby
// (host Start) or the final board ("Play again", via newSeriesFromResults).
function startSeries() {
  tally.reset();
  startNextRun();
}

function startNextRun() {
  tally.startNextRun();
  startRun();
}

// Advance the series by one run: bank the just-finished run's points (before its
// session is torn down), then roll into the next. Fired by the intermission timer
// when the countdown elapses. Guarded so a double-fire no-ops: once startRun flips
// raceEnded back to false a re-entry returns early.
function advanceToNextRun() {
  if (!raceEnded || tally.seriesOver) return;
  clearIntermission();
  if (session) tally.fold(currentField, session.getResults()); // bank this run's points before teardown
  teardownRun();
  startNextRun();
}

// "Play again" from the final board → a brand-new series on a fresh mountain.
function newSeriesFromResults() {
  if (!session) return;
  clearIntermission();
  teardownRun();
  startSeries();
}

function startRun() {
  if (session) return;
  stopLobbyRace();        // the attract CPU reuse the same ids — drop them first
  // A difficulty pick moments before Start may still be mid-dissolve: clear its
  // frozen-frame overlay now so it doesn't linger over the countdown. And if a rapid
  // re-pick was dropped by the in-progress-dissolve guard, `slope` still sits on the
  // OLD tier while currentLevel moved on — rebuild so the run is on the chosen tier
  // before the session binds to its centerline.
  cancelLobbyCrossfade();
  if (!slope.def || slope.def.level !== currentLevel) { slope = makeSlope(); window.__slope = slope; applyTrack(); }
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
  if (paused) return;
  if (!session) { driveLobbyRace(dt); return; } // lobby attract: loop the CPU race

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
    if (!coastSettled) {
      coastSettled = true;
      showResults(session.getResults(), currentField, true);
      maybeStartIntermission(); // timeout / stuck-skier end: the field is settled (DNFs shown) → start the countdown
    }
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
    if (raceEnded && session) {
      showResults(session.getResults());
      maybeStartIntermission(); // this crossing may be the last skier in → start the countdown now
    }
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

// The cumulative tally (run index/length/over-flag, banked scores, points folding
// and the standings-row derivation) lives in the SeriesTally `tally` — see the
// series-state block above. main.js only wires it to the net/DOM below.

function standingsPayload(over) {
  const rows = tally.buildRows(session.getResults(), currentField);
  return {
    type: MSG.STANDINGS,
    over, seriesOver: tally.seriesOver, runIndex: tally.runIndex, runTotal: tally.runsTotal,
    hostPeerIndex: net.flow.host,
    total: rows.length,
    // Late joiners ride along under the board (newPlayer) so their own phone —
    // and everyone else's — shows who's queued up for the next run.
    order: rows.concat(lateJoiners().map((p) => ({
      playerId: p.peerIndex, name: p.name || 'Skier',
      colorIndex: p.colorIndex || 0, ai: false,
      finished: false, dnf: false, newPlayer: true,
    }))),
  };
}
function broadcastStandings(over) { if (session) net.broadcast(standingsPayload(over)); }

// ---- between-runs intermission (auto-advance) ----------------------------
// Start the countdown ONLY once the run is fully decided — every skier across the
// line or DNF (engine.raceOver), or the coast-out/timeout has forced the final
// reading (coastSettled, which DNFs anyone still stuck). Called when the panel goes
// up, on each later finish (a CPU coasting in may be the last one home) and at the
// settle point; the intermissionTimer guard keeps it to a single start. No-op on
// the final run (the overall board never advances) or once the field has emptied.
function maybeStartIntermission() {
  if (!raceEnded || tally.seriesOver || intermissionTimer) return;
  if (!session || !(session.engine.raceOver || coastSettled)) return;
  startIntermission();
}

// After a non-final run the board holds the scores for a beat, then the series
// rolls on automatically. The countdown ticks to every phone (INTERMISSION) and
// the big screen, mirroring the pre-run COUNTDOWN beat.
function startIntermission() {
  clearIntermission();
  let n = intermissionSeconds;
  pushIntermission(n);
  intermissionTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) { advanceToNextRun(); return; } // advanceToNextRun clears the timer
    pushIntermission(n);
  }, 1000);
}
function pushIntermission(n) {
  net.broadcast({ type: MSG.INTERMISSION, n, runIndex: tally.runIndex, runTotal: tally.runsTotal });
  const line = el('results-intermission');
  if (line) line.textContent = `Next run in ${n}…`;
}
function clearIntermission() {
  if (intermissionTimer) { clearInterval(intermissionTimer); intermissionTimer = null; }
}

function endRun(results) {
  if (raceEnded) return; // panel already up (humans done) — onRaceEvent keeps it refreshed
  raceEnded = true;
  raceEndedAt = performance.now();
  tally.endCurrentRun(); // the final run is in the books → overall board
  net.flow.transitionTo(ROOM_STATE.RESULTS);
  broadcastStandings(true);
  audio.stopWind();
  audio.finish();
  showResults(results);
  releaseOrphanedResults(); // the whole field may have walked out mid-run
  // Mid-series the next run auto-starts after a breather — but the countdown only
  // begins once the WHOLE field is in (every skier across the line or DNF), not the
  // instant the humans are home: the panel can go up with CPU still coasting down.
  // maybeStartIntermission no-ops until then, and fires again on each later finish
  // and at the coast-out's end. (If the field just emptied, releaseOrphanedResults
  // folds to the lobby and the intermission is cleared in returnToLobby.)
  maybeStartIntermission();
}

// `field` is the full roster (incl. AI) used to name + colour the rows; defaults
// to the live `currentField` but is passed explicitly by the test harness so the
// preview shares this exact render path instead of re-implementing it. `settled`
// forces the fully-over reading once the coast-out has come to rest (nothing can
// finish anymore), covering the timeout end where raceOver never trips. `joiners`
// lets the harness preview late-join rows; live renders derive them themselves.
function showResults(results, field = currentField, settled = false, joiners = null) {
  const rows = tally.buildRows(results, field);
  const list = el('results-list');
  if (list) {
    list.innerHTML = '';
    // While the panel is up but skiers are still coasting in, an unfinished row is
    // "still going" (…), not a DNF. DNF is reserved for a forfeited (dropped)
    // skier and for when the run is fully over and someone truly never crossed.
    const fullyOver = settled || !session || session.engine.raceOver;
    for (const r of rows) {
      const li = document.createElement('li');
      if (r.champion) li.className = 'res--champ';
      const color = SKIER_COLORS[(r.colorIndex || 0) % SKIER_COLORS.length];
      const time = r.finished && r.time != null ? r.time.toFixed(1) + 's' : (r.dnf || fullyOver ? 'DNF' : '…');
      // Per-run board shows the run's place + this run's points won; the overall
      // board shows the series place and drops the per-run "+pts" (the score column
      // is the story). The cumulative score column rides on the right of both.
      li.innerHTML =
        `<span class="res__rank">${r.place}</span>` +
        `<span class="dot" style="background:${color}"></span>` +
        `<span class="res__name">${escapeHtml(r.name)}${r.ai ? ' <span class="res__cpu">CPU</span>' : ''}</span>` +
        `<span class="res__time">${time}</span>` +
        `<span class="res__pts">${tally.seriesOver ? '' : (r.finished ? '+' + r.points : '')}</span>` +
        `<span class="res__score">${r.score}</span>`;
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
        `<span class="res__time">next run</span>` +
        `<span class="res__pts"></span>` +
        `<span class="res__score"></span>`;
      list.appendChild(li);
    }
  }

  // Header: "Run X of N" mid-series, "Final standings" once it's over (shared
  // wording with the phone board via shared/seriesFormat.js).
  const tag = el('results-runtag');
  if (tag) tag.textContent = tally.runIndex ? runTag(tally.runIndex, tally.runsTotal, tally.seriesOver) : '';

  // Champion banner — only on the overall board. Co-champions on a points tie.
  const champ = el('results-champ');
  if (champ) {
    const winners = tally.seriesOver ? rows.filter((r) => r.champion) : [];
    if (winners.length) {
      champ.classList.remove('hidden');
      // Assigned via textContent (below), so names need no escaping — the browser
      // never parses them as markup.
      const names = winners.map((w) => w.name).join(' & ');
      champ.textContent = winners.length === 1 ? `🏆 ${names} wins the series!` : `🏆 It's a tie — ${names}!`;
    } else { champ.classList.add('hidden'); champ.textContent = ''; }
  }

  // Buttons + intermission line. Mid-series the board auto-advances on its own —
  // no button, just the intermission countdown; only the final board offers a
  // button ("Play again" → a brand-new series).
  const again = el('results-again');
  if (again) { again.textContent = 'Play again'; again.classList.toggle('hidden', !tally.seriesOver); }
  const line = el('results-intermission');
  if (line) line.classList.toggle('hidden', tally.seriesOver);

  const res = el('results');
  if (res) res.classList.remove('hidden');
}

// Stage series state for a no-relay preview (the gallery 'results' scenario) so
// showResults renders a mid-series or final board through the live path. Injected
// into the TestHarness — never used in live play.
function setSeriesPreview(opts = {}) {
  tally.stagePreview(opts);
}

// Tear down the current run and roll a FRESH random slope for the next one (live
// play only — test mode pins a stable seed). Shared by "New game" (→ lobby),
// the between-runs auto-advance, and "Play again" (→ a new series); all get a new
// mountain. Does NOT touch the tally — advanceToNextRun banks the run's points
// (tally.fold) before calling this, and startSeries/returnToLobby reset the tally.
function teardownRun() {
  clearIntermission();
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
  // Abort the series outright: reset the tally so the lobby (and the next series)
  // starts clean.
  tally.reset();
  net.flow.transitionTo(ROOM_STATE.LOBBY);
  net.broadcast({ type: MSG.GAME_END });
  scene.orbit = true;
  showLobby();
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
  cancelLobbyCrossfade(); // front door: clear any stale dissolve overlay/guard (never a crossfade mid itself)
  startLobbyRace(); // a looping CPU AI race behind the card, camera following the pack
  renderLevel(); // keep the difficulty badge current whenever the lobby surfaces
  renderRuns();  // and the series-length switch
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

// ---- join link → clipboard -----------------------------------------------
// The bottom join chip is a button: a click (or Enter/Space) copies the full
// join link, confirmed by a brief toast. copyText falls back to a hidden
// textarea on non-secure contexts where the async Clipboard API is unavailable.
let copyToastTimer = null;
function showToast(msg) {
  const t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => t.classList.remove('is-on'), 1600);
}
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}
el('joinbox') && el('joinbox').addEventListener('click', async () => {
  if (!currentJoinUrl) return;
  showToast(await copyText(currentJoinUrl) ? 'Copied' : 'Copy failed');
});

// ---- pause / results buttons + dev keys ----------------------------------
el('pause-btn') && el('pause-btn').addEventListener('click', () => (paused ? resumeRun() : pauseRun()));
el('pause-continue') && el('pause-continue').addEventListener('click', resumeRun);
el('pause-newgame') && el('pause-newgame').addEventListener('click', returnToLobby);
// The big-screen results button shows only on the final board ("Play again" → a
// brand-new series); mid-series the board auto-advances with no button.
el('results-again') && el('results-again').addEventListener('click', () => { if (tally.seriesOver) newSeriesFromResults(); });
el('results-newgame') && el('results-newgame').addEventListener('click', returnToLobby);
window.addEventListener('keydown', (e) => {
  if (e.key === 'g' && net.roomState === ROOM_STATE.LOBBY) startSeries(); // dev: start without a phone
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
    // scenarios default to a 4-skier field (solo = you + 3 CPU); ?players=N overrides.
    // `runsTotal`/`seriesOver` stage the results scenario as a mid-series or final board.
    { scenario: scenario || 'running', players: parseInt(params.get('players'), 10) || 4, host: parseInt(params.get('host'), 10) || 0, cam: params.get('cam'), runsTotal: tally.runsTotal, seriesOver: params.get('over') === '1', intermission: intermissionSeconds },
    // Inject the REAL render fns so the harness previews the live DOM path rather
    // than a hand-copy (which drifts — see renderRoster/showResults).
    { scene, slope, AiController, AI_PERSONALITIES, RunSession, renderRoster, renderLevel, renderRuns, showResults, setSeriesPreview, buildReconnectCard, audio, showSoundHint, rerollSlope, lobbyCrossfade }
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
    ['slope', 'slope — orbiting slope preview'],
    ['lobby', 'lobby — fake roster'],
    ['countdown', 'countdown beat'],
    ['paused', 'paused overlay'],
    ['results', 'results board'],
    ['reconnect', 'reconnect — rejoin QR card'],
    ['device-choice', 'device choice — phone-on-display chooser'],
  ] },
  { key: 'players', label: 'Players', type: 'number', min: 1, max: 4, hint: 'field size in scenarios (default 4)' },
  { key: 'level', label: 'Difficulty', type: 'select', hint: 'procedural tier — host picks live; this pins it', options: [['', `default (${DEFAULT_LEVEL})`], ...LEVELS.map((l) => [l.id, l.label])] },
  { key: 'runs', label: 'Runs', type: 'number', min: 1, max: 9, hint: `series length — host picks live; this pins it (default ${DEFAULT_RUNS})` },
  { key: 'over', label: 'Series over', type: 'check', hint: 'results scenario → the overall (final) board, champion crowned' },
  { key: 'intermission', label: 'Intermission', type: 'number', min: 1, hint: 'between-runs auto-advance seconds (default for tests/previews)' },
  { key: 'seed', label: 'Seed', type: 'number', hint: 'pins the generated mountain (deterministic repro)' },
  { key: 'hitbox', label: 'Hitbox overlay', type: 'check', hint: 'wireframe collision footprints in the (s, lat) plane' },
]);
