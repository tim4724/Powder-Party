// Small controller-UI helpers shared by the live phone (main.js) and the gallery
// preview (TestHarness.js) so the two can't drift. No globals, no relay — pure DOM.

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
// `rows` come in rank order: { name, colorIndex, ai, me, finished, dnf, time }.
// `host` is { name, color } (or falsy → "the host"), shown to non-hosts once
// the run is over.
export function renderResultsBoard(rows, { over, isHost, host }, colors) {
  const list = document.getElementById('result-list');
  list.innerHTML = '';
  for (const o of rows) {
    const li = document.createElement('li');
    if (o.me) li.classList.add('is-me');
    if (!o.finished && !o.dnf) li.classList.add('is-racing');
    const dot = document.createElement('span');
    dot.className = 'res-dot';
    dot.style.background = colors[o.colorIndex] || '#888';
    const name = document.createElement('span');
    name.className = 'res-name';
    name.textContent = o.name + (o.ai ? ' (CPU)' : o.me ? ' (You)' : '');
    const time = document.createElement('span');
    time.className = 'res-time';
    time.textContent = o.finished ? `${o.time.toFixed(1)}s` : (o.dnf || over ? 'DNF' : 'Skiing…');
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

