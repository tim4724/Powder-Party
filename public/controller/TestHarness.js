// Controller Test Harness — drives a single phone screen in isolation for the
// gallery (/gallery-controller.html), with NO relay connection. main.js
// delegates here when the URL carries ?scenario=…; we apply the player's
// livery and lay out the requested screen from fake data.
//
// Pure DOM: the controller has no 3D scene, so nothing async to await.
import { applyLatencyChip, renderWaitNote, renderResultsBoard, buildLevelSeg, renderLevelSeg } from './ui.js';

const FAKE_NAMES = ['Mia', 'Theo', 'Ava', 'Leo', 'Zoe', 'Max', 'Ivy', 'Sam'];

const el = (id) => document.getElementById(id);

export function runControllerScenario(opts) {
  const COLORS = window.SKIER_COLORS || ['#2bb673'];
  const LEVELS = window.LEVELS || [];
  const scenario = opts.scenario;
  const color = Math.max(0, Math.min(opts.color || 0, COLORS.length - 1));

  const screens = { name: el('name'), lobby: el('lobby'), waiting: el('waiting'), game: el('game'), results: el('results') };
  const show = (name) => { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); };

  // Apply the player's livery (the --car custom property tints the HUD, the play
  // surface glow, the carve fill, and the skier-picker tiles).
  const myColor = COLORS[color % COLORS.length];
  document.documentElement.style.setProperty('--car', myColor);

  // Results board — the REAL render path (ui.js renderResultsBoard) fed fake
  // rows. `over=false` is the "you just finished, others still out" state;
  // `over=true` is the final board. A finisher other than this player is
  // fabricated as host so the non-host footer shows the tinted name treatment.
  function showBoard(order, over, isHost) {
    show('results');
    const host = order.find((o) => !o.me);
    renderResultsBoard(order, {
      over, isHost,
      host: host && { name: host.name, color: COLORS[host.colorIndex] },
    }, COLORS);
  }

  // Latency chip preview — no relay here, so feed it a static reading.
  const setLatency = (halfMs, fastlane) => applyLatencyChip(el('latency'), halfMs, fastlane);

  const setCarve = (v) => { const f = el('carve-fill'); if (f) f.style.transform = `translateX(${v * 50}%)`; };
  function setHud(pos, finished) {
    el('pos').textContent = finished ? `Done P${pos}` : `P${pos}`;
    el('pos').classList.toggle('leader', pos === 1);
  }
  function showDriveHud() {
    show('game');
    el('drive-hud').classList.remove('hidden');
    el('pause-btn').classList.remove('hidden'); // present the whole time you drive (main.js COUNTDOWN/GAME_START)
  }

  // The #conn overlay covers whatever in-room screen the drop interrupted —
  // previewed over the drive HUD, with the latency chip reading "no signal".
  function showConnOverlay(title, msg, retry) {
    showDriveHud();
    setCarve(0.2);
    setHud(2, false);
    setLatency(-1, false);
    el('conn-title').textContent = title;
    el('conn-msg').textContent = msg;
    el('conn-retry').classList.toggle('hidden', !retry);
    el('conn').classList.remove('hidden');
  }

  switch (scenario) {
    case 'name':
      show('name');
      el('name-input').value = '';
      el('name-status').textContent = '';
      break;

    case 'name-connecting':
      show('name');
      el('name-input').value = FAKE_NAMES[color];
      el('name-input').disabled = true;
      el('name-form').querySelector('button').disabled = true;
      el('name-status').textContent = '';
      break;

    case 'lobby-host':
      show('lobby');
      el('me-name').textContent = FAKE_NAMES[color];
      el('start-btn').classList.remove('hidden');     // the host can start any time (fixed slope)
      el('wait-host').classList.add('hidden');
      // Host owns the difficulty pick — live segments, default tier highlighted.
      buildLevelSeg(LEVELS, null);
      renderLevelSeg(window.DEFAULT_LEVEL, true);
      break;

    case 'lobby-waiting': {
      show('lobby');
      el('me-name').textContent = FAKE_NAMES[color];
      el('start-btn').classList.add('hidden');
      const waitEl = el('wait-host');
      waitEl.classList.remove('hidden');
      // Fabricate a host (someone other than this player) so the preview shows
      // the tinted name treatment, mirroring main.js renderWaitHost.
      const hostColor = (color + 1) % COLORS.length;
      renderWaitNote(waitEl, { name: FAKE_NAMES[hostColor], color: COLORS[hostColor] }, ' to start…');
      // A non-host doesn't see the difficulty — only the host picks (the big
      // screen shows the tier to the room).
      el('level-select').classList.add('hidden');
      break;
    }

    case 'late-join':
      // Joined while a run was underway: parked on the "run in progress" screen
      // until the final board (your unranked row) or GAME_END routes you onward.
      show('waiting');
      el('waiting-name').textContent = FAKE_NAMES[color];
      setLatency(24, false);   // pre-fastlane: nothing to drive yet
      break;

    case 'countdown':
      // No countdown on the controller — the full HUD is up from the first beat
      // (the 3..2..1..GO lives on the display). Same as 'playing' but pre-fastlane.
      showDriveHud();
      setCarve(0);
      setHud(1, false);
      setLatency(24, false);   // pre-fastlane: WS reading, no bolt
      break;

    case 'playing':
      showDriveHud();
      setCarve(0.4);  // mid-right lean, so the carve bar reads off-centre
      setHud(2, false);
      setLatency(16, true);    // fastlane up: low RTT + bolt
      break;

    case 'brake':
      // Braking: touch & hold. The pad warms toward the livery and the brake
      // label lights up. Eyeball the eyes-free touch-pad surface.
      showDriveHud();
      setCarve(-0.2);
      el('play').classList.add('braking');
      setHud(2, false);
      setLatency(15, true);
      break;

    case 'finished':
      // Your skier crossed the line — the phone flips to the results board with
      // your finished row while the rest are still out (not the drive HUD).
      setLatency(19, true);
      showBoard([
        { name: FAKE_NAMES[color], colorIndex: color, time: 31.2, me: true, finished: true },
        { name: FAKE_NAMES[(color + 1) % FAKE_NAMES.length], colorIndex: (color + 1) % COLORS.length, finished: false },
        { name: 'Bolt', colorIndex: (color + 2) % COLORS.length, ai: true, finished: false },
        { name: FAKE_NAMES[(color + 3) % FAKE_NAMES.length], colorIndex: (color + 3) % COLORS.length, finished: false }
      ], false, false);
      break;

    case 'paused':
      showDriveHud();
      setCarve(0.2);
      setHud(2, false);
      setLatency(18, true);
      el('pause-btn').classList.remove('hidden');
      el('pause-btn').disabled = true;     // overlay covers it while paused
      el('pause-overlay').classList.remove('hidden');
      break;

    case 'results':
      // Final board (run over), viewed as the host so "Play again" + "New game" show.
      setLatency(20, true);
      showBoard([
        { name: FAKE_NAMES[(color + 1) % FAKE_NAMES.length], colorIndex: (color + 1) % COLORS.length, time: 28.4, finished: true },
        { name: FAKE_NAMES[color],                           colorIndex: color,                       time: 31.2, me: true, finished: true },
        { name: 'Bolt',                                      colorIndex: (color + 2) % COLORS.length, time: 33.9, ai: true, finished: true },
        { name: FAKE_NAMES[(color + 3) % FAKE_NAMES.length], colorIndex: (color + 3) % COLORS.length, time: 36.5, finished: true }
      ], true, true);
      break;

    case 'results-waiting':
      // Final board (run over), viewed as a non-host: no restart buttons, just the
      // "Waiting for <host> to start the next run…" note (the leading finisher is
      // the fabricated host, so the tinted name treatment shows).
      setLatency(20, true);
      showBoard([
        { name: FAKE_NAMES[(color + 1) % FAKE_NAMES.length], colorIndex: (color + 1) % COLORS.length, time: 28.4, finished: true },
        { name: FAKE_NAMES[color],                           colorIndex: color,                       time: 31.2, me: true, finished: true },
        { name: 'Bolt',                                      colorIndex: (color + 2) % COLORS.length, time: 33.9, ai: true, finished: true },
        { name: FAKE_NAMES[(color + 3) % FAKE_NAMES.length], colorIndex: (color + 3) % COLORS.length, time: 36.5, finished: true }
      ], true, false);
      break;

    case 'results-join':
      // Final board as the LATE JOINER sees it: the FULL field's results (4
      // skiers — humans topped up with CPU) plus your own unranked trailing row
      // ("next run"), so a one-joiner board is 5 rows. The footer waits on the
      // host — the rematch countdown is what pulls you in.
      setLatency(22, false);
      showBoard([
        { name: FAKE_NAMES[(color + 1) % FAKE_NAMES.length], colorIndex: (color + 1) % COLORS.length, time: 28.4, finished: true },
        { name: 'Bolt',                                      colorIndex: (color + 2) % COLORS.length, time: 33.9, ai: true, finished: true },
        { name: FAKE_NAMES[(color + 3) % FAKE_NAMES.length], colorIndex: (color + 3) % COLORS.length, time: 36.1, finished: true },
        { name: 'Wedge',                                     colorIndex: (color + 4) % COLORS.length, ai: true, finished: false, dnf: true },
        { name: FAKE_NAMES[color],                           colorIndex: color,                       me: true, newPlayer: true }
      ], true, false);
      break;

    // --- connection overlay states (#conn) ---
    // The screen-agnostic relay-link overlay over the in-room screens; copy
    // mirrors main.js onStatus exactly so the preview can't drift from live.
    case 'conn-reconnecting':
      showConnOverlay('Reconnecting…', 'Reconnecting… (2/8)', false);
      break;
    case 'conn-lost':
      showConnOverlay('Connection lost', 'Scan the QR on the big screen to take your seat back — or try again here.', true);
      break;
    case 'conn-display-gone':
      showConnOverlay('Waiting for the big screen…', 'The host’s screen dropped — hang tight, it’ll reconnect you.', false);
      break;
    case 'conn-replaced':
      showConnOverlay('Opened on another tab', 'This seat is now controlled from another tab or device.', false);
      break;

    default:
      console.warn('[ControllerTestHarness] unknown scenario:', scenario);
  }
}
