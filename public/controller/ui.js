// Small controller-UI helpers shared by the live phone (main.js) and the gallery
// preview (TestHarness.js) so the two can't drift. No globals, no relay — pure DOM.
import { buildLevelSeg as buildSeg, paintLevelSeg } from '../shared/levelSeg.js';
import { runTag } from '../shared/seriesFormat.js';

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
// `rows` come in board order: { name, colorIndex, ai, me, finished, dnf, time,
// points, score, champion }; late joiners trail as unranked { newPlayer } rows.
// Series opts: `runIndex`/`runTotal` drive the "Run X of N" tag; `seriesOver`
// switches to the overall board (champion banner, sorted-by-score). `host` is
// { name, color } (or falsy → "the host"), shown to non-hosts once a run is over.
// The between-runs countdown line (#result-intermission) is owned by the live
// INTERMISSION handler, not this render, so a re-broadcast can't blank it.
export function renderResultsBoard(rows, { over, seriesOver, runIndex, runTotal, isHost, host }, colors) {
  const list = document.getElementById('result-list');
  list.innerHTML = '';
  for (const o of rows) {
    const li = document.createElement('li');
    if (o.me) li.classList.add('is-me');
    if (o.champion) li.classList.add('is-champ');
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
    // Series columns: this run's points (+N, quiet) and the cumulative score
    // (prominent). Omitted on a late joiner's "next run" row; the per-run "+N" is
    // dropped on the overall board, where the score column tells the story.
    if (!o.newPlayer && o.score != null) {
      const pts = document.createElement('span');
      pts.className = 'res-pts';
      pts.textContent = !seriesOver && o.finished ? `+${o.points}` : '';
      const score = document.createElement('span');
      score.className = 'res-score';
      score.textContent = o.score;
      li.append(pts, score);
    }
    list.appendChild(li);
  }

  // Header tag + champion banner (overall board only).
  const tag = document.getElementById('result-runtag');
  if (tag) tag.textContent = runTotal ? runTag(runIndex, runTotal, seriesOver) : '';
  const champEl = document.getElementById('result-champ');
  if (champEl) {
    const winners = seriesOver ? rows.filter((r) => r.champion) : [];
    if (winners.length) {
      const names = winners.map((w) => w.name + (w.me ? ' (You)' : '')).join(' & ');
      champEl.textContent = winners.length === 1 ? `🏆 ${names} wins!` : `🏆 Tie — ${names}!`;
      champEl.classList.remove('hidden');
    } else champEl.classList.add('hidden');
  }

  // Footer: while skiers are still out, a waiting note for everyone. Mid-series the
  // board auto-advances (the countdown line speaks; no button). Only the FINAL board
  // gets the host's "Play again" button; "New game" stays available to the host on
  // any over board so they can abort the series.
  const hostControls = over && isHost;
  const again = document.getElementById('again-btn');
  again.classList.toggle('hidden', !(hostControls && seriesOver));
  again.textContent = 'Play again';
  document.getElementById('newgame-btn').classList.toggle('hidden', !hostControls);
  const wait = document.getElementById('result-wait');
  if (!over) {
    wait.classList.remove('hidden');
    wait.textContent = 'Waiting for the other skiers to finish…';
  } else if (isHost || !seriesOver) {
    wait.classList.add('hidden'); // host has buttons; mid-series the countdown line speaks for non-hosts
  } else {
    wait.classList.remove('hidden');
    renderWaitNote(wait, host || {}, ' to play again…');
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

// Series-length selector (3 / 5 / 7 runs) — the same shared segment widget as the
// difficulty switch, also HOST-ONLY on the phone. `runCounts` is the RUN_COUNTS
// array; segments reuse the LEVELS { id, label, color } shape with a neutral
// brand fill. `onPick(id)` is the host's tap (omitted in static previews).
export function buildRunsSeg(runCounts, onPick) {
  buildSeg(document.getElementById('runs-seg'), runCounts.map((n) => ({ id: String(n), label: String(n), color: 'var(--brand)' })), onPick);
}
export function renderRunsSeg(runs, isHost) {
  paintLevelSeg(document.getElementById('runs-seg'), String(runs), false);
  const wrap = document.getElementById('runs-select');
  if (wrap) wrap.classList.toggle('hidden', !isHost); // non-hosts don't pick the series length
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

