// Controller Test Harness — drives a single phone screen in isolation for the
// gallery (/gallery-controller.html), with NO relay connection. main.js
// delegates here when the URL carries ?scenario=…; we apply the player's
// livery and lay out the requested screen from fake data.
//
// Pure DOM: the controller has no 3D scene, so nothing async to await.
import { applyLatencyChip, renderWaitNote } from './ui.js';

const FAKE_NAMES = ['Mia', 'Theo', 'Ava', 'Leo', 'Zoe', 'Max', 'Ivy', 'Sam'];

const el = (id) => document.getElementById(id);

// runControllerScenario({ scenario, color })
export function runControllerScenario(opts) {
  const COLORS = window.SKIER_COLORS || ['#2bb673'];
  const scenario = opts.scenario;
  const color = Math.max(0, Math.min(opts.color || 0, COLORS.length - 1));

  const screens = { name: el('name'), lobby: el('lobby'), game: el('game'), results: el('results') };
  const show = (name) => { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); };

  // Apply the player's livery (the --car custom property tints the HUD, the play
  // surface glow, the carve/charge fills, and the skier-picker tiles).
  const myColor = COLORS[color % COLORS.length];
  document.documentElement.style.setProperty('--car', myColor);

  window.__TEST__ = window.__TEST__ || {};

  // Results board — mirrors main.js renderResults + renderResultFoot. `over=false`
  // is the "you just finished, others still out" state (some rows "Skiing…", a
  // waiting footer); `over=true` is the final board (host gets "New run").
  function renderResultsBoard(order, over) {
    show('results');
    const list = el('result-list'); list.innerHTML = '';
    order.forEach((o) => {
      const li = document.createElement('li');
      if (o.me) li.classList.add('is-me');
      if (!o.finished) li.classList.add('is-racing');
      const dot = document.createElement('span'); dot.className = 'res-dot';
      dot.style.background = COLORS[o.colorIndex] || '#888';
      const name = document.createElement('span'); name.className = 'res-name';
      name.textContent = o.name + (o.ai ? ' (CPU)' : o.me ? ' (You)' : '');
      const time = document.createElement('span'); time.className = 'res-time';
      time.textContent = o.finished ? `${o.time.toFixed(1)}s` : (over ? 'DNF' : 'Skiing…');
      li.append(dot, name, time);
      list.appendChild(li);
    });
    el('newgame-btn').classList.toggle('hidden', !over);   // host gets "New run" once over
    const wait = el('result-wait');
    wait.classList.toggle('hidden', !!over);
    if (!over) wait.textContent = 'Waiting for the other skiers to finish…';
  }

  // Latency chip preview — no relay here, so feed it a static reading.
  const setLatency = (halfMs, fastlane) => applyLatencyChip(el('latency'), halfMs, fastlane);

  const setCarve = (v) => { const f = el('carve-fill'); if (f) f.style.transform = `translateX(${v * 50}%)`; };
  const setCharge = (v) => { const f = el('charge-fill'); if (f) f.style.transform = `scaleY(${v})`; };
  function setHud(pos, finished, airborne) {
    el('pos').textContent = finished ? `Done P${pos}` : `P${pos}`;
    el('pos').classList.toggle('leader', pos === 1);
    el('air').classList.toggle('hidden', !airborne);
  }
  function showDriveHud() {
    show('game');
    el('drive-hud').classList.remove('hidden');
    el('motion-tip').classList.add('hidden');
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
      break;
    }

    case 'countdown':
      // No countdown on the controller — the full HUD is up from the first beat
      // (the 3..2..1..GO lives on the display). Same as 'playing' but pre-fastlane.
      showDriveHud();
      setCarve(0); setCharge(0);
      setHud(1, false, false);
      setLatency(24, false);   // pre-fastlane: WS reading, no bolt
      break;

    case 'playing':
      showDriveHud();
      setCarve(0.4);  // mid-right lean, so the carve bar reads off-centre
      setCharge(0.15);
      setHud(2, false, false);
      setLatency(16, true);    // fastlane up: low RTT + bolt
      break;

    case 'tuck':
      // Mid-tuck: the charge meter is well filled and the play glyph is in its
      // "ready to pop" (up-chevron) state. Eyeball the new eyes-free surface.
      showDriveHud();
      setCarve(-0.2);
      setCharge(0.72);
      el('charge').classList.add('charging');
      el('play-glyph').classList.add('tucking');
      setHud(2, false, false);
      setLatency(15, true);
      break;

    case 'air':
      // Airborne after a big release — the AIR badge pulses, charge spent.
      showDriveHud();
      setCarve(0.1);
      setCharge(0);
      setHud(1, false, true);
      setLatency(17, true);
      break;

    case 'finished':
      // Your skier crossed the line — the phone flips to the results board with
      // your finished row while the rest are still out (not the drive HUD).
      setLatency(19, true);
      renderResultsBoard([
        { name: FAKE_NAMES[color], colorIndex: color, time: 31.2, me: true, finished: true },
        { name: FAKE_NAMES[(color + 1) % FAKE_NAMES.length], colorIndex: (color + 1) % COLORS.length, finished: false },
        { name: 'Bolt', colorIndex: (color + 2) % COLORS.length, ai: true, finished: false },
        { name: FAKE_NAMES[(color + 3) % FAKE_NAMES.length], colorIndex: (color + 3) % COLORS.length, finished: false }
      ], false);
      break;

    case 'paused':
      showDriveHud();
      setCarve(0.2); setCharge(0);
      setHud(2, false, false);
      setLatency(18, true);
      el('pause-btn').classList.remove('hidden');
      el('pause-btn').disabled = true;     // overlay covers it while paused
      el('pause-overlay').classList.remove('hidden');
      break;

    case 'results':
      // Final board (run over), viewed as the host so the "New run" button shows.
      setLatency(20, true);
      renderResultsBoard([
        { name: FAKE_NAMES[(color + 1) % FAKE_NAMES.length], colorIndex: (color + 1) % COLORS.length, time: 28.4, finished: true },
        { name: FAKE_NAMES[color],                           colorIndex: color,                       time: 31.2, me: true, finished: true },
        { name: 'Bolt',                                      colorIndex: (color + 2) % COLORS.length, time: 33.9, ai: true, finished: true },
        { name: FAKE_NAMES[(color + 3) % FAKE_NAMES.length], colorIndex: (color + 3) % COLORS.length, time: 36.5, finished: true }
      ], true);
      break;

    default:
      console.warn('[ControllerTestHarness] unknown scenario:', scenario);
  }
}
