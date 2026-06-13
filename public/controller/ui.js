// Small controller-UI helpers shared by the live phone (main.js) and the gallery
// preview (TestHarness.js) so the two can't drift. No globals, no relay — pure DOM.
import { buildLevelSeg as buildSeg, paintLevelSeg } from '../shared/levelSeg.js';

// Latency chip (bottom-right). halfMs is one-way (RTT/2); halfMs < 0 means the
// PONG is overdue (no signal). viaFastlane lights the bolt when the reading came
// off the P2P DataChannel rather than the WS relay. Quality thresholds: <50 good,
// <100 ok, else bad.
export function applyLatencyChip(chipEl, halfMs, viaFastlane) {
  if (!chipEl) return;
  chipEl.classList.remove('hidden', 'latency--good', 'latency--ok', 'latency--bad');
  chipEl.classList.toggle('latency--fastlane', !!viaFastlane);
  const textEl = chipEl.querySelector('.latency__text');
  if (halfMs < 0) {
    textEl.textContent = 'no signal';
    chipEl.classList.add('latency--bad');
  } else {
    textEl.textContent = halfMs + ' ms';
    chipEl.classList.add(halfMs < 50 ? 'latency--good' : halfMs < 100 ? 'latency--ok' : 'latency--bad');
  }
}

// The results board: standings rows into #result-list + the footer (host's
// "Play again"/"New game" vs a waiting note). ONE render path for the live
// phone (main.js) and the gallery preview (TestHarness.js).
// `rows` come in rank order: { name, colorIndex, ai, me, finished, dnf, time };
// late joiners trail the field as unranked { newPlayer } rows ("next run").
// `host` is { name, color } (or falsy → "the host"), shown to non-hosts once
// the run is over.
export function renderResultsBoard(rows, { over, isHost, host }, colors) {
  const list = document.getElementById('result-list');
  list.innerHTML = '';
  for (const o of rows) {
    const li = document.createElement('li');
    if (o.me) li.classList.add('is-me');
    if (o.newPlayer) li.classList.add('is-joining');
    else if (!o.finished && !o.dnf) li.classList.add('is-racing');
    const dot = document.createElement('span');
    dot.className = 'res-dot';
    dot.style.background = colors[o.colorIndex] || '#888';
    const name = document.createElement('span');
    name.className = 'res-name';
    name.textContent = o.name + (o.ai ? ' (CPU)' : o.me ? ' (You)' : '');
    const time = document.createElement('span');
    time.className = 'res-time';
    time.textContent = o.newPlayer ? 'next run' : o.finished ? `${o.time.toFixed(1)}s` : (o.dnf || over ? 'DNF' : 'Skiing…');
    li.append(dot, name, time);
    list.appendChild(li);
  }
  // Footer: while skiers are still out, a waiting note for everyone. Once the
  // run is over, the host gets the restart buttons; everyone else is told who
  // to wait on.
  const hostControls = over && isHost;
  document.getElementById('again-btn').classList.toggle('hidden', !hostControls);
  document.getElementById('newgame-btn').classList.toggle('hidden', !hostControls);
  const wait = document.getElementById('result-wait');
  if (!over) {
    wait.classList.remove('hidden');
    wait.textContent = 'Waiting for the other skiers to finish…';
  } else if (isHost) {
    wait.classList.add('hidden');
  } else {
    wait.classList.remove('hidden');
    renderWaitNote(wait, host || {}, ' to start the next run…');
  }
}

// Difficulty selector (Blue/Red/Black piste grades) — the shared widget (build +
// paint) lives in ../shared/levelSeg.js so the controller and the display can't
// drift. The pick is HOST-ONLY on the phone: only the host sees the switch (live);
// every other phone hides it entirely (the big screen shows the tier to the room).
// `onPick(id)` is the host's tap handler (omitted in static previews).
export function buildLevelSeg(levels, onPick) {
  buildSeg(document.getElementById('level-seg'), levels, onPick);
}
export function renderLevelSeg(level, isHost) {
  paintLevelSeg(document.getElementById('level-seg'), level, false); // host-only → always live
  const wrap = document.getElementById('level-select');
  if (wrap) wrap.classList.toggle('hidden', !isHost); // non-hosts don't see difficulty at all
}

// "Waiting for NAME<suffix>" — NAME is the host, tinted in their livery colour
// (matching the in-race name plate). Built from DOM nodes so a player-supplied
// name is always inserted as text, never markup. Falls back to "the host" until
// the roster naming the host has arrived. `color` is a CSS colour string (or
// falsy to leave the default).
export function renderWaitNote(waitEl, { name, color } = {}, suffix) {
  const nameEl = document.createElement('span');
  nameEl.className = 'host-name';
  nameEl.textContent = name || 'the host';
  if (color) nameEl.style.color = color;
  waitEl.textContent = 'Waiting for ';
  waitEl.append(nameEl, suffix);
}

