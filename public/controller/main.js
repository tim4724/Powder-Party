// Controller entry — name → lobby → run. The whole #game surface is an eyes-free
// touch-pad: tilt to CARVE, push down + hold to BRAKE, and in the air flick any
// direction to FLIP — streamed as CONTROL {s,t,j,f} to the display; a light
// position HUD comes back over PLAYER_STATE. (Ramps auto-launch; no jump input.)
import { ControllerNet } from './Net.js';
import { TiltInput } from './TiltInput.js';
import { SwipeInput } from './SwipeInput.js';
import { applyLatencyChip, renderWaitNote, renderResultsBoard } from './ui.js';
import { keepScreenOn, letScreenSleep } from '../shared/WakeLock.js';

const { MSG, RUN_STATE_MSGS, RELAY_ERRORS, ROOM_STATE, SKIER_COLORS } = window;
const el = (id) => document.getElementById(id);

const screens = { name: el('name'), lobby: el('lobby'), waiting: el('waiting'), game: el('game'), results: el('results') };
// Screen "depth": name is the entry point (0); every in-room screen sits one
// level above it (1). lobby↔waiting↔game↔results are same-level shuffles. Used
// to push a browser-history entry only on the forward step into the room, so the
// back button / phone back gesture pops cleanly back to name entry. See `show`.
const SCREEN_ORDER = { name: 0, lobby: 1, waiting: 1, game: 1, results: 1 };
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
let waitingForRun = false; // late joiner: a run is on WITHOUT us — parked on #waiting until it ends

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
    // The "game ended" bail only counts down while display_gone is the LATEST
    // link state. Any other transition supersedes it — above all our OWN socket
    // dropping ('reconnecting'/'lost'): navigating an offline phone would land
    // on a browser error page with a misleading reason. If the link recovers
    // while the display is still away, the joined snapshot re-raises
    // display_gone (see ControllerNet) and the countdown re-arms.
    if (state !== 'display_gone') disarmBail();
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
      // Terminal join errors land on the display page's device chooser with the
      // reason as a toast (like the display_gone bail) instead of stranding the
      // player on an inline error: a dead room (stale QR / old link) can never
      // be re-joined, and a relay-full room has no seat to wait on here.
      // RELAY_ERRORS (protocol.js) holds the relay's exact wire-contract
      // strings; if the relay ever rewords them, the fallthrough below still
      // surfaces the raw error inline.
      if (info === RELAY_ERRORS.ROOM_NOT_FOUND) { net.disconnect(); location.replace('/?bail=room_not_found'); return; }
      if (info === RELAY_ERRORS.ROOM_FULL) { net.disconnect(); location.replace('/?bail=game_full'); return; }
      setStatus('Error: ' + info);
    } else if (state === 'display_gone') {
      setStatus('Waiting for the big screen…');
      if (inRoom) showConn('Waiting for the big screen…', 'The host’s screen dropped — hang tight, it’ll reconnect you.', false);
      armBail(); // not back within the grace window → the game has ended (also covers a fresh join into an abandoned room, still on the name screen)
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

// ---- "game ended" bail ----
// A deliberately closed big screen announces itself (the DISPLAY_CLOSED goodbye
// → instant bail in handleMessage); this timer covers the goodbyes that never
// arrive — a crashed tab, a dead battery, an unload-time send the OS dropped.
// The display's own relay blips heal well inside the grace window (a fresh
// WELCOME disarms this), but once it's clearly not coming back, waiting forever
// behind the "hang tight" overlay is a dead end: hand the phone to the display
// page's device chooser instead, with the reason as a toast (?bail=game_ended).
const DISPLAY_GONE_BAIL_MS = 30000;
let bailTimer = null;
function armBail() {
  if (bailTimer) return;
  bailTimer = setTimeout(() => {
    net.disconnect();
    location.replace('/?bail=game_ended');
  }, DISPLAY_GONE_BAIL_MS);
}
function disarmBail() {
  clearTimeout(bailTimer);
  bailTimer = null;
}

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
  // Parked on the "run in progress" screen, the live run's broadcasts aren't
  // ours to act on — without this gate the COUNTDOWN/GAME_START handlers would
  // flip us to a game pad driving nothing. The gate blocks exactly the
  // RUN-STATE broadcasts (RUN_STATE_MSGS, defined next to the vocabulary in
  // protocol.js); room-management messages are deliberately NOT gated, because
  // they're what RELEASES this state: WELCOME (re-sync), LOBBY_UPDATE
  // (roster/host), STANDINGS (the final board carries our "next run" row and
  // clears the gate) and GAME_END.
  if (waitingForRun && RUN_STATE_MSGS[data.type]) return;
  switch (data.type) {
    case MSG.WELCOME: {
      hideConn();   // a WELCOME means we're back in (covers the display returning after display_gone)
      disarmBail(); // the display is alive — cancel any pending "game ended" exit
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
      // display stamps inRun=false when we have NO live skier in this run (we
      // joined after the field was built, our seat expired, or a rematch started
      // while we were gone): park on the "run in progress" screen until the
      // final board / GAME_END routes us onward — a game pad driving nothing is
      // a dead end. During RESULTS the WELCOME carries the final standings, so
      // we land on the same board the big screen is showing.
      const inRun = data.inRun !== false; // missing flag (older display) = assume racing
      const midRun = data.roomState === ROOM_STATE.COUNTDOWN || data.roomState === ROOM_STATE.PLAYING;
      waitingForRun = midRun && !inRun;
      if (midRun && inRun) {
        inResults = false;
        show('game');
        el('drive-hud').classList.remove('hidden');
        el('pause-btn').classList.remove('hidden');
        startDriving();   // resume streaming tilt to our still-descending skier
        setPauseOverlay(!!data.paused); // rejoining a frozen run lands behind the pause overlay, in sync with the big screen
      } else if (waitingForRun) {
        renderWaiting();
        show('waiting');
      } else if (data.roomState === ROOM_STATE.RESULTS && data.standings) {
        // Joined/reconnected during RESULTS: land on the board the big screen
        // shows. Handled inline (not by re-dispatching to the STANDINGS case)
        // so that handler can evolve without silently changing this path; the
        // host fields were already adopted from the WELCOME above.
        renderResults(data.standings);
        showResultsScreen();
      } else {
        show('lobby');    // lobby (or an old display's results) — the next countdown/board routes us onward
      }
      break;
    }
    case MSG.ROOM_FULL:
      // The display had no seat for us (room full, or every seat held for a
      // reconnect). Unlike the PRE-join fulls (the boot probe / relay-level
      // "Room is full", which bail a fresh device to the device chooser), this
      // lands after the player typed a name — and held seats free up when a
      // reconnect grace expires. Drop the relay connection (frees our
      // placeholder slot) and keep the name screen + room code so they can
      // simply retry.
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
      // DNF) or as soon as MY skier finishes — I'm on autopilot now. The final
      // (over) board also collects a parked late joiner: their unranked "next
      // run" row is on it, and clearing the gate here is what lets the rematch
      // countdown pull them into the next run with everyone else.
      hostPeerIndex = data.hostPeerIndex;
      amHost = net.isHost(data.hostPeerIndex);
      renderResults(data);
      if (data.over) waitingForRun = false;
      const mine = (data.order || []).find((o) => o.playerId === net.peerIndex);
      // (!newPlayer is defensive — a queued joiner's row is never `finished`)
      if (data.over || (mine && mine.finished && !mine.newPlayer)) showResultsScreen();
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
      waitingForRun = false; // run aborted to the lobby — the wait is over too
      stopDriving();
      setPauseOverlay(false);
      el('pause-btn').classList.add('hidden');
      show('lobby');
      break;
    case MSG.DISPLAY_CLOSED:
      // The big screen said goodbye on its way out (pagehide) — the game is
      // over for certain, so skip the display-gone grace wait and take the
      // "game ended" exit at once. The peer_left(0) that follows would only
      // arm the 30s fallback timer; same destination, just now.
      net.disconnect();
      location.replace('/?bail=game_ended');
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

// Render the standings rows + the footer (shared with the gallery preview —
// see renderResultsBoard in ui.js).
function renderResults(data) {
  const order = data.order || [];
  const rows = order.map((o) => (o.playerId === net.peerIndex ? { ...o, me: true } : o));
  const host = order.find((o) => o.playerId === hostPeerIndex);
  renderResultsBoard(rows, {
    over: !!data.over,
    isHost: amHost,
    host: host && { name: host.name, color: SKIER_COLORS[host.colorIndex] },
  }, SKIER_COLORS);
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

// Late-join screen — identity only (like the lobby); the static copy in
// index.html explains the wait and the livery dot is var(--car) via CSS.
function renderWaiting() {
  el('waiting-name').textContent = myName || 'Skier';
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
  disarmBail();   // an intentional back-out isn't a "game ended" exit
  stopDriving();
  inResults = false;
  waitingForRun = false;
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

// Probe the relay for this room BEFORE the player invests in a name: a stale
// QR / dead link bails to the device chooser now (room_not_found), and a full
// room likewise — but only for a FRESH device (a returning clientId / ?claim=
// rejoin swaps into its own existing relay slot, so "full" isn't fatal there).
// A slow probe racing a successful join must not evict the player, so the
// verdict is dropped once we've moved past the name screen. Gallery previews
// (?scenario=) never touch the relay, and a code-less page can't be probed.
if (!_scenario && net.roomCode) {
  net.probeRoom().then((state) => {
    // Already past the name screen, or a join is in flight (disabled form):
    // the display/relay's own answer wins over a possibly-stale probe.
    if (currentScreen !== 'name' || el('join-btn').disabled) return;
    if (state === 'not_found') { net.disconnect(); location.replace('/?bail=room_not_found'); }
    else if (state === 'full' && !net.isReturning) { net.disconnect(); location.replace('/?bail=game_full'); }
  });
}
