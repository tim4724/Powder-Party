// Controller entry — name → lobby → run. Tilt to CARVE, swipe-down-and-hold to
// TUCK, release (or swipe up) to JUMP, all streamed as CONTROL {s,t,j} to the
// display; a light position/air HUD comes back over PLAYER_STATE.
import { ControllerNet } from './Net.js';
import { TiltInput } from './TiltInput.js';
import { SwipeInput } from './SwipeInput.js';
import { applyLatencyChip, renderWaitNote } from './ui.js';

const { MSG, SKIER_COLORS } = window;
const el = (id) => document.getElementById(id);

const screens = { name: el('name'), lobby: el('lobby'), game: el('game'), results: el('results') };
// Screen "depth": name is the entry point (0); every in-room screen sits one
// level above it (1). lobby↔game↔results are same-level shuffles. Used to push a
// browser-history entry only on the forward step into the room, so the back
// button / phone back gesture pops cleanly back to name entry. See `show`.
const SCREEN_ORDER = { name: 0, lobby: 1, game: 1, results: 1 };
let currentScreen = null;
function show(name) {
  const prev = currentScreen;
  currentScreen = name;
  for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name);
  // Push history only when stepping UP a level (name → lobby). Same-level and
  // back transitions don't push, so there's exactly one entry to pop: pressing
  // back from anywhere in the room returns to the name screen in one step.
  if ((SCREEN_ORDER[name] || 0) > (SCREEN_ORDER[prev] || 0)) history.pushState({ screen: name }, '');
}

// haptics — vibrate the phone (ignored where unsupported). The player's eyes are
// on the main display, not the phone, so a buzz is how a gesture confirms it landed.
const buzz = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (_) {} };

// Tuck rumble: a *continuous*-feeling LIGHT buzz for as long as the TUCK is held —
// the player's eyes-free confirmation the tuck is engaged (squatting for speed) while
// they watch the skier on the main display. navigator.vibrate has no intensity control, so "light" is
// faked with duty cycle: a short on-pulse at a fast cycle = low average motor power
// (faint) AND pulses too quick to feel apart (they blend into one smooth hum, not
// taps). It also has no native loop, so we play a long pattern and renew it just
// before it ends — the motor never falls silent.
// Tune: raise the 8 (on-time) for a stronger rumble; raise the 22 (off-time) for
// fainter. Keep the cycle (8+22=30ms) short or the pulses stop blending.
const TUCK_PULSE = [8, 22];                              // 30ms cycle, ~27% duty: a light hum
const TUCK_PATTERN = Array(60).fill(TUCK_PULSE).flat();  // ~1.8s of rumble
const TUCK_RENEW_MS = 1500;                              // renew before it ends (1.8s > 1.5s, no gap)
let _tuckTimer = null;
function startTuckRumble() {
  if (_tuckTimer) return;
  buzz(TUCK_PATTERN);
  _tuckTimer = setInterval(() => buzz(TUCK_PATTERN), TUCK_RENEW_MS);
}
function stopTuckRumble() {
  if (!_tuckTimer) return;
  clearInterval(_tuckTimer); _tuckTimer = null;
  buzz(0); // cancel any residual vibration immediately
}

let myColorIndex = null;
let myName = '';           // this player's name, shown at the top of the lobby
let amHost = false;
let roster = [];           // latest lobby roster (for the host name in the wait text)
let hostPeerIndex = null;
let inResults = false;     // showing the results overlay (my skier finished / run over)

const NAME_KEY = 'powder_name';
const storedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } };
const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} };

const net = new ControllerNet({
  onJoined: () => setStatus(''),
  onStatus: (state, info) => {
    // Any status callback means the clean join→lobby path didn't carry us all the
    // way through, so re-enable the join form. It's a no-op once we've moved off
    // the name screen (the button is hidden), but it prevents a player getting
    // stuck on a disabled button — display gone, kicked, or reconnect exhausted.
    setJoining(false);
    if (state === 'reconnecting') setStatus(`Reconnecting… (${Math.min(info.attempt, info.max)}/${info.max})`);
    else if (state === 'error') setStatus('Error: ' + info);
    else if (state === 'display_gone') setStatus('Waiting for the big screen…');
    else if (state === 'replaced') setStatus('Opened on another tab.');
  },
  onMessage: handleMessage,
  onRtt: updateLatency
});

// Latency chip (bottom-right). Stays hidden until the first reading lands so it
// never flashes on the pre-join name screen. See applyLatencyChip in ui.js.
const latencyEl = el('latency');
function updateLatency(halfMs, viaFastlane) { applyLatencyChip(latencyEl, halfMs, viaFastlane); }

// --- input: carve (gyro) + tuck/jump (swipe), merged into one CONTROL payload ---
// The whole #game surface is the eyes-free swipe target (TiltInput sets
// touch-action:none on it). Carve owns the 25 Hz tick; each tick it folds in the
// latest swipe state and sends {s,t,j} — all three fields every tick, all
// latest-wins safe (s/t continuous + idempotent, j a wrapping one-shot counter).
const swipe = new SwipeInput({
  surface: el('game'),
  onTuckStart: () => { buzz(15); startTuckRumble(); el('play-glyph').classList.add('tucking'); },
  onTuckEnd: () => { stopTuckRumble(); buzz([0, 55]); el('play-glyph').classList.remove('tucking'); flashJump(); }
});
const tilt = new TiltInput({
  surface: el('game'),
  onCarve: (s) => { const sw = swipe.state; net.send(MSG.CONTROL, { s, t: sw.t, j: sw.j }); }
});

function setStatus(t) { el('name-status').textContent = t; }
// Lock the join form while a connection is in flight so a double-tap can't fire
// two joins; unlocked again only if the attempt errors out (success navigates
// away to the lobby).
function setJoining(on) {
  el('join-btn').disabled = on;
  el('name-input').disabled = on;
}

function handleMessage(data) {
  switch (data.type) {
    case MSG.WELCOME: {
      myColorIndex = data.colorIndex;
      applyLivery();
      roster = data.players || [];
      hostPeerIndex = data.hostPeerIndex;
      amHost = net.isHost(data.hostPeerIndex);
      const me = roster.find((p) => p.peerIndex === net.peerIndex);
      if (me && me.name) myName = me.name;
      renderLobby();
      if (data.roomState === 'lobby') show('lobby');
      break;
    }
    case MSG.LOBBY_UPDATE: {
      roster = data.players || [];
      hostPeerIndex = data.hostPeerIndex;
      amHost = net.isHost(data.hostPeerIndex);
      // The display is authoritative — adopt the colour it auto-assigned us.
      const me = (data.players || []).find((p) => p.peerIndex === net.peerIndex);
      if (me) {
        myColorIndex = me.colorIndex;
        if (me.name) myName = me.name;
        applyLivery();
      }
      renderLobby();
      break;
    }
    case MSG.COUNTDOWN:
      inResults = false;               // a fresh run clears any leftover results overlay
      show('game');
      el('drive-hud').classList.remove('hidden'); // full HUD up front — the countdown lives on the display
      if (data.n >= 0) buzz(data.n > 0 ? 20 : [0, 90]); // haptic tick on counts, stronger on GO
      setPauseOverlay(false);          // a fresh countdown clears any stale pause UI
      el('pause-btn').classList.remove('hidden');
      startDriving();                  // stream input during the countdown (display reacts)
      break;
    case MSG.GAME_START:
      // Fires on the "GO!" beat. The HUD is already up from COUNTDOWN; this just
      // covers a player who joined too late to get the countdown messages.
      show('game');
      el('drive-hud').classList.remove('hidden');
      el('pause-btn').classList.remove('hidden');
      startDriving();
      break;
    case MSG.PLAYER_STATE:
      if (inResults) break;            // finished → results overlay owns the screen now
      // Light HUD feed (~10Hz): {position, of, progress, airborne, finished}
      el('pos').textContent = data.finished ? `Done P${data.position}` : `P${data.position}`;
      el('pos').classList.toggle('leader', data.position === 1);
      el('air').classList.toggle('hidden', !data.airborne);
      break;
    case MSG.STANDINGS: {
      // Live finish board. Refresh who's host (may have shifted if someone left)
      // and render; flip to the overlay once the run is over (everyone, incl.
      // DNF) or as soon as MY skier finishes — I'm on autopilot now.
      hostPeerIndex = data.hostPeerIndex;
      amHost = net.isHost(data.hostPeerIndex);
      renderResults(data);
      const mine = (data.order || []).find((o) => o.playerId === net.peerIndex);
      if (data.over || (mine && mine.finished)) showResultsScreen();
      break;
    }
    case MSG.GAME_PAUSED:
      if (inResults) break;            // finished skiers watch results, not the pause overlay
      stopTuckRumble();                // the overlay covers the surface — don't hum through the pause
      setPauseOverlay(true);
      break;
    case MSG.GAME_RESUMED:
      if (inResults) break;
      setPauseOverlay(false);
      break;
    case MSG.GAME_END:
      inResults = false;
      stopDriving();
      setPauseOverlay(false);
      el('pause-btn').classList.add('hidden');
      show('lobby');
      break;
  }
}

// --- results overlay ---
// Switch the phone to the results board. Stops driving (the skier is on autopilot
// now) and clears the pause UI so a still-racing player's pause can't surface
// over the board.
function showResultsScreen() {
  if (!inResults) { inResults = true; stopDriving(); }
  setPauseOverlay(false);
  el('pause-btn').classList.add('hidden');
  show('results');
}

// Render the standings rows + the footer (host's "New run" vs a waiting note).
function renderResults(data) {
  const list = el('result-list');
  list.innerHTML = '';
  (data.order || []).forEach((o) => {
    const li = document.createElement('li');
    const isMe = o.playerId === net.peerIndex;
    if (isMe) li.classList.add('is-me');
    if (!o.finished) li.classList.add('is-racing');
    const dot = document.createElement('span');
    dot.className = 'res-dot';
    dot.style.background = SKIER_COLORS[o.colorIndex] || '#888';
    const name = document.createElement('span');
    name.className = 'res-name';
    name.textContent = o.name + (o.ai ? ' (CPU)' : isMe ? ' (You)' : '');
    const time = document.createElement('span');
    time.className = 'res-time';
    time.textContent = o.finished ? `${o.time.toFixed(1)}s` : (data.over ? 'DNF' : 'Skiing…');
    li.append(dot, name, time);
    list.appendChild(li);
  });
  renderResultFoot(data);
}

// Footer: while skiers are still out, a waiting note for everyone. Once the run is
// over, the host gets the "New run" button; everyone else is told who to wait on.
function renderResultFoot(data) {
  const btn = el('newgame-btn');
  const wait = el('result-wait');
  if (!data.over) {
    btn.classList.add('hidden');
    wait.classList.remove('hidden');
    wait.textContent = 'Waiting for the other skiers to finish…';
  } else if (amHost) {
    btn.classList.remove('hidden');
    wait.classList.add('hidden');
  } else {
    btn.classList.add('hidden');
    wait.classList.remove('hidden');
    const host = (data.order || []).find((o) => o.playerId === hostPeerIndex);
    renderWaitNote(wait, { name: host && host.name, color: host && SKIER_COLORS[host.colorIndex] }, ' to start a new run…');
  }
}

function applyLivery() {
  const c = SKIER_COLORS[myColorIndex] || '#888';
  document.documentElement.style.setProperty('--car', c);
}

// Lobby — just your identity (the shared display owns the roster + auto-assigns
// your livery colour) plus the host's Start button (the slope is fixed — every
// skier handles the same, so there's nothing to pick).
function renderLobby() {
  el('me-name').textContent = myName || 'Skier'; // who you are, up top (livery dot is var(--car))
  el('start-btn').classList.toggle('hidden', !amHost);
  const waitEl = el('wait-host');
  waitEl.classList.toggle('hidden', amHost);
  if (!amHost) renderWaitHost(waitEl);
}

function renderWaitHost(waitEl) {
  const host = roster.find((p) => p.peerIndex === hostPeerIndex);
  renderWaitNote(waitEl, { name: host && host.name, color: host && SKIER_COLORS[host.colorIndex] }, ' to start…');
}

// --- driving ---
let carveRaf = null;
function startDriving() {
  if (carveRaf) return; // already running (may have begun during the countdown)
  tilt.start();
  swipe.start();
  const fill = el('carve-fill');
  const tip = el('motion-tip');
  tip.classList.toggle('hidden', tilt.motionState === 'granted');
  const loop = () => {
    fill.style.transform = `translateX(${tilt.state.carve * 50}%)`;
    carveRaf = requestAnimationFrame(loop);
  };
  loop();
}
function stopDriving() {
  tilt.stop();
  swipe.stop();
  stopTuckRumble(); // never leave the motor humming if a tuck was held at run end
  el('air').classList.add('hidden');
  el('play-glyph').classList.remove('tucking');
  if (carveRaf) cancelAnimationFrame(carveRaf);
  carveRaf = null;
}

// brief pop on the play glyph each time a jump fires (eyes-on confirmation).
function flashJump() {
  const g = el('play-glyph');
  g.classList.remove('jumped'); void g.offsetWidth; g.classList.add('jumped');
}

// --- name screen ---
el('name-input').value = storedName();

// Back out of the room (back button / phone back gesture) → name entry. Drops
// the relay connection so the display removes us from the roster, resets the
// transient in-room UI, and re-fills the name input so the player can edit it
// and re-join. The history entry pushed by `show` on name → lobby is what the
// pop lands on; here we just react to it.
function leaveToName() {
  net.disconnect();
  stopDriving();
  inResults = false;
  amHost = false;
  roster = [];
  setPauseOverlay(false);
  el('pause-btn').classList.add('hidden');
  setJoining(false);
  setStatus('');
  el('name-input').value = storedName();
  show('name');
  el('name-input').focus();
}
window.addEventListener('popstate', () => {
  if (currentScreen && currentScreen !== 'name') leaveToName();
});

el('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = el('name-input').value.trim().slice(0, 16) || 'Skier';
  myName = n;
  saveName(n);
  // Request motion permission within this user gesture (iOS requirement; HTTPS is
  // required for the sensors on a real phone — desktop falls back to keys).
  tilt.enableMotion();
  setStatus('');           // the disabled button signals the in-flight join
  setJoining(true);
  net.connect(n);
});

el('start-btn').addEventListener('click', () => { if (amHost) net.send(MSG.START_GAME); });

// --- pause ---
// The display is authoritative over the paused state; the controller just
// requests a change and reacts to the GAME_PAUSED / GAME_RESUMED broadcast.
// While paused the overlay covers the screen, so the pause button is disabled.
function setPauseOverlay(on) {
  el('pause-overlay').classList.toggle('hidden', !on);
  el('pause-btn').disabled = on;
}
el('pause-btn').addEventListener('click', () => { buzz(15); net.send(MSG.PAUSE_GAME); });
el('pause-continue').addEventListener('click', () => { buzz(15); net.send(MSG.RESUME_GAME); });
el('pause-newgame').addEventListener('click', () => { buzz(15); net.send(MSG.RETURN_TO_LOBBY); });

// Results overlay: only the host gets the button; it sends everyone to the lobby.
el('newgame-btn').addEventListener('click', () => { if (amHost) { buzz(15); net.send(MSG.RETURN_TO_LOBBY); } });

show('name');

// Gallery / test mode: ?scenario=… lays out a single screen from fake data
// without connecting to the relay (the controller never auto-connects, so
// there's nothing to suppress — we just drive the screens directly).
const _params = new URLSearchParams(location.search);
const _scenario = _params.get('scenario');
if (_scenario) {
  const _int = (v, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : n; };
  import('./TestHarness.js').then(({ runControllerScenario }) => runControllerScenario({
    scenario: _scenario,
    color: _int(_params.get('color'), 0)
  }));
}
