// Controller entry — name → lobby → run. The whole #game surface is an eyes-free
// touch-pad: tilt to CARVE, push down + hold to BRAKE, and in the air flick any
// direction to FLIP — streamed as CONTROL {s,t,j,f} to the display; a light
// position HUD comes back over PLAYER_STATE. (Ramps auto-launch; no jump input.)
import { ControllerNet } from './Net.js';
import { TiltInput } from './TiltInput.js';
import { SwipeInput } from './SwipeInput.js';
import { applyLatencyChip, renderWaitNote } from './ui.js';
import { keepScreenOn, letScreenSleep } from '../shared/WakeLock.js';

const { MSG, ROOM_STATE, SKIER_COLORS } = window;
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
  // In-room the phone must not dim: carving is tilt-only, so a whole run can
  // pass without a touch. The name screen lets the phone manage itself.
  if (name === 'name') letScreenSleep(); else keepScreenOn();
  // Push history only when stepping UP a level (name → lobby). Same-level and
  // back transitions don't push, so there's exactly one entry to pop: pressing
  // back from anywhere in the room returns to the name screen in one step.
  if ((SCREEN_ORDER[name] || 0) > (SCREEN_ORDER[prev] || 0)) history.pushState({ screen: name }, '');
}

// haptics — vibrate the phone (ignored where unsupported). The player's eyes are
// on the main display, not the phone, so a short buzz is how each recognized
// input (brake / jump / flip) confirms it landed. Tucked-and-fast is the silent
// default — the motor only speaks when you act.
const buzz = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (_) {} };

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
  onJoined: () => { setStatus(''); hideConn(); },
  onStatus: (state, info) => {
    // Any status callback means the clean join→lobby path didn't carry us all the
    // way through, so re-enable the join form. It's a no-op once we've moved off
    // the name screen (the button is hidden), but it prevents a player getting
    // stuck on a disabled button — display gone, kicked, or reconnect exhausted.
    setJoining(false);
    // In-room (lobby/game/results) the name-screen status line is off-screen, so a
    // dropped link needs the full-screen #conn overlay; on the name screen the
    // status text under the form is enough.
    const inRoom = currentScreen && currentScreen !== 'name';
    if (state === 'reconnecting') {
      const txt = `Reconnecting… (${Math.min(info.attempt, info.max)}/${info.max})`;
      setStatus(txt);
      if (inRoom) showConn('Reconnecting…', txt, false);
    } else if (state === 'lost') {
      setStatus('Connection lost.');
      if (inRoom) showConn('Connection lost', 'Scan the QR on the big screen to take your seat back — or try again here.', true);
    } else if (state === 'error') {
      setStatus('Error: ' + info);
    } else if (state === 'display_gone') {
      setStatus('Waiting for the big screen…');
      if (inRoom) showConn('Waiting for the big screen…', 'The host’s screen dropped — hang tight, it’ll reconnect you.', false);
    } else if (state === 'replaced') {
      setStatus('Opened on another tab.');
      if (inRoom) showConn('Opened on another tab', 'This seat is now controlled from another tab or device.', false);
    }
  },
  onMessage: handleMessage,
  onRtt: updateLatency
});

// ---- connection overlay (screen-agnostic relay-link feedback) ----
function showConn(title, msg, retry) {
  el('conn-title').textContent = title;
  el('conn-msg').textContent = msg || '';
  el('conn-retry').classList.toggle('hidden', !retry);
  el('conn').classList.remove('hidden');
}
function hideConn() { el('conn').classList.add('hidden'); }
el('conn-retry').addEventListener('click', () => {
  buzz(15);
  showConn('Reconnecting…', '', false);
  net.connect(myName);
});

// Latency chip (bottom-right). Stays hidden until the first reading lands so it
// never flashes on the pre-join name screen. See applyLatencyChip in ui.js.
const latencyEl = el('latency');
function updateLatency(halfMs, viaFastlane) { applyLatencyChip(latencyEl, halfMs, viaFastlane); }

// --- input: carve (gyro) + brake/jump/flip (swipe), merged into one CONTROL payload ---
// The whole #game surface is the eyes-free swipe target (TiltInput sets
// touch-action:none on it). Carve owns the 25 Hz tick; each tick it folds in the
// latest swipe state and sends {s,t,j,f} — every field every tick, all latest-wins
// safe (s/t continuous + idempotent, j/f wrapping one-shot edges).
const swipe = new SwipeInput({
  surface: el('game'),
  onContact: (x, y) => spawnRipple(x, y),
  onBrakeStart: () => { buzz(15); el('play').classList.add('braking'); },
  onBrakeEnd: () => { el('play').classList.remove('braking'); },
  onFlick: () => { buzz(15); flashFlick(); }
});
const tilt = new TiltInput({
  surface: el('game'),
  onCarve: (s) => { const sw = swipe.state; net.send(MSG.CONTROL, { s, t: sw.t, j: sw.j, f: sw.f }); }
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
      hideConn();   // a WELCOME means we're back in (covers the display returning after display_gone)
      myColorIndex = data.colorIndex;
      applyLivery();
      roster = data.players || [];
      hostPeerIndex = data.hostPeerIndex;
      amHost = net.isHost(data.hostPeerIndex);
      const me = roster.find((p) => p.peerIndex === net.peerIndex);
      if (me && me.name) myName = me.name;
      renderLobby();
      // Land on the screen matching the live room state. Normally that's the
      // lobby, but a player who rejoins mid-run (reconnected, or scanned the
      // reconnect QR) must drop straight back into the run instead of stalling on
      // the lobby — their skier is still on the slope waiting for input. The
      // display stamps inRun=false when we have NO live skier in this run (our
      // seat expired, or a rematch started while we were gone): wait in the lobby
      // then — a game pad driving nothing is a dead end.
      const inRun = data.inRun !== false; // missing flag (older display) = assume racing
      if ((data.roomState === ROOM_STATE.COUNTDOWN || data.roomState === ROOM_STATE.PLAYING) && inRun) {
        inResults = false;
        show('game');
        el('drive-hud').classList.remove('hidden');
        el('pause-btn').classList.remove('hidden');
        startDriving();   // resume streaming tilt to our still-descending skier
      } else {
        show('lobby');    // lobby, results or a run we're not in — the next countdown/board routes us onward
      }
      break;
    }
    case MSG.ROOM_FULL:
      // The display had no seat for us (room full / seats held for reconnects).
      // Drop the relay connection (frees our placeholder slot) and put the name
      // screen back so the player can retry once a seat opens.
      net.disconnect();
      setJoining(false);
      setStatus('Room is full — wait for a seat to open, then try again.');
      show('name');
      break;
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
      // Light HUD feed (~6.5 Hz): {position, of, progress, airborne, finished}
      el('pos').textContent = data.finished ? `Done P${data.position}` : `P${data.position}`;
      el('pos').classList.toggle('leader', data.position === 1);
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
    if (!o.finished && !o.dnf) li.classList.add('is-racing');
    const dot = document.createElement('span');
    dot.className = 'res-dot';
    dot.style.background = SKIER_COLORS[o.colorIndex] || '#888';
    const name = document.createElement('span');
    name.className = 'res-name';
    name.textContent = o.name + (o.ai ? ' (CPU)' : isMe ? ' (You)' : '');
    const time = document.createElement('span');
    time.className = 'res-time';
    time.textContent = o.finished ? `${o.time.toFixed(1)}s` : (o.dnf || data.over ? 'DNF' : 'Skiing…');
    li.append(dot, name, time);
    list.appendChild(li);
  });
  renderResultFoot(data);
}

// Footer: while skiers are still out, a waiting note for everyone. Once the run is
// over, the host gets "Play again" (rematch, fresh slope) + "New game" (back to the
// lobby); everyone else is told who to wait on.
function renderResultFoot(data) {
  const again = el('again-btn');
  const btn = el('newgame-btn');
  const wait = el('result-wait');
  const hostControls = data.over && amHost;
  again.classList.toggle('hidden', !hostControls);
  btn.classList.toggle('hidden', !hostControls);
  if (!data.over) {
    wait.classList.remove('hidden');
    wait.textContent = 'Waiting for the other skiers to finish…';
  } else if (amHost) {
    wait.classList.add('hidden');
  } else {
    wait.classList.remove('hidden');
    const host = (data.order || []).find((o) => o.playerId === hostPeerIndex);
    renderWaitNote(wait, { name: host && host.name, color: host && SKIER_COLORS[host.colorIndex] }, ' to start the next run…');
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
  // fresh run → clear any stale brake/flick state from a previous run
  const play = el('play'); if (play) play.classList.remove('braking', 'flick');
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
  const p = el('play'); if (p) p.classList.remove('braking', 'flick');
  if (carveRaf) cancelAnimationFrame(carveRaf);
  carveRaf = null;
}

// brief pulse on the pad ring each time a flick (jump / flip) fires. Eyes-free
// the buzz is the real confirmation; this is the eyes-on echo for a glance down.
function flashFlick() {
  const p = el('play');
  if (!p) return;
  p.classList.remove('flick'); void p.offsetWidth; p.classList.add('flick');
}
// A quick expanding disc at the contact point, so a glance reads "the whole pad
// is live, not a button". The element removes itself when its animation ends.
function spawnRipple(x, y) {
  const play = el('play');
  if (!play) return;
  const r = play.getBoundingClientRect();
  const dot = document.createElement('span');
  dot.className = 'play__ripple';
  dot.style.left = (x - r.left) + 'px';
  dot.style.top = (y - r.top) + 'px';
  play.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove());
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
  hideConn();   // a back-out from the "Connection lost" overlay must clear it, not leave it over the name form
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

// Results overlay: host-only. "Play again" rematches on a fresh slope (display turns
// START_GAME from a finished run into a replay); "New game" sends everyone to the lobby.
el('again-btn').addEventListener('click', () => { if (amHost) { buzz(15); net.send(MSG.START_GAME); } });
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
