// DisplayNet — owns the relay connection, RoomFlow roster/host machine, and the
// controller<->display protocol. The display is slot 0 and authoritative. Game
// logic/rendering live elsewhere; this module is transport + lobby only.
// Adapted from the reference kart DisplayNet — the slope is fixed (no track
// catalog / SELECT_TRACK), so the lobby just carries the roster + skier picks.
//
// Reads partyplug + protocol globals set by the classic <script> tags loaded
// before this module (PartyConnection, RoomFlow, MSG, RELAY_URL, MAX_PLAYERS).
import { GameNet } from '../shared/GameNet.js';

const { PartyConnection, RoomFlow, MSG, ROOM_STATE, RELAY_URL, MAX_PLAYERS, SKIER_COLORS } = window;

const enc = encodeURIComponent;

// Player-name clamp shared by HELLO and SET_NAME — same wire, same limit as
// the controller's 16-char input.
const cleanName = (raw) => (raw ? String(raw).slice(0, 16) : '');

// How long a mid-run disconnect's seat is held open (showing its reconnect QR)
// before we give up and forfeit the slot. Long enough to cover PartyConnection's
// own auto-reconnect run plus a deliberate rescan, short enough that a player
// who's truly gone stops blocking the 4-seat room.
const RECONNECT_GRACE_MS = 90000;

// Zombie-link detection: controllers send a 1 Hz PING (plus ~25 Hz CONTROL in
// a run), so a "connected" seat that's been silent this long has a dead link
// the relay hasn't noticed yet (phone slept with the socket half-open). The
// last-seen stamps live in RoomFlow (opts.liveness); the sweep below pulls
// flow.expiredPeers and routes each through the normal drop path — mid-run
// that's the reconnect QR + grace window, NOT a forfeit. Lobby and results
// seats are left to the relay's own timeout: a backgrounded phone throttles
// its timers, and QR-ing a pocketed phone between runs would be worse than a
// briefly stale roster row. A seat still silent when the next run starts is
// swept within one tick.
const LIVENESS_TIMEOUT_MS = 10000;
const LIVENESS_SWEEP_MS = 2500;

export class DisplayNet extends GameNet {
  constructor(opts = {}) {
    super();
    this.onRoomReady = opts.onRoomReady || (() => {});
    this.onRosterChange = opts.onRosterChange || (() => {});
    this.onControllerMessage = opts.onControllerMessage || (() => {});
    // Fired whenever the set of dropped seats awaiting a reconnect changes; the
    // display renders a QR card per seat. Each entry: {peerIndex, name, colorIndex, url}.
    this.onReconnectChange = opts.onReconnectChange || (() => {});
    // Fired when a dropped player reconnects on a DIFFERENT device (new peerIndex):
    // (oldId, newId) so the game layer can re-key their still-descending skier onto
    // the new slot. A same-device reconnect keeps its id and never needs this.
    this.onPlayerRekey = opts.onPlayerRekey || (() => {});
    // Does this peer have a live skier in the current run? Stamped onto WELCOME as
    // `inRun` so a reconnecting phone that ISN'T racing (seat expired mid-run, or a
    // rematch started without it) waits in its lobby instead of a dead game pad.
    this.isInRun = opts.isInRun || (() => false);
    // Extra game-state fields merged into each WELCOME (or null). The game layer
    // uses this to hand a phone joining during RESULTS the final standings, so it
    // lands on the results board the big screen is showing instead of the lobby.
    this.welcomeExtras = opts.welcomeExtras || (() => null);

    // Dropped seats currently offering a reconnect QR, plus their grace timers.
    // peerIndex -> {peerIndex, name, colorIndex, url}; peerIndex -> timeout id.
    this._reconnectSeats = new Map();
    this._reconnectTimers = new Map();

    this.flow = new RoomFlow({ liveness: { timeoutMs: LIVENESS_TIMEOUT_MS } });
    setInterval(() => this._sweepLiveness(), LIVENESS_SWEEP_MS);
    this.roomCode = null;
    this.instance = null;
    this.baseUrlOverride = null;

    this._initFastlane(0, { onInput: (peerIdx, ev) => { this._seen(peerIdx); this.onControllerMessage(peerIdx, ev); } });

    // One announce per mutation: a single roster change can emit BOTH
    // hostchange and rosterchange (RoomFlow fires them back to back — and a
    // resync can remove several peers in one sweep), which would publish an
    // identical snapshot per event. Coalesce onto a microtask so each
    // mutation publishes once, with the settled roster.
    let announcePending = false;
    this._announce = () => {
      if (announcePending) return;
      announcePending = true;
      queueMicrotask(() => {
        try {
          this._broadcastLobby();
          this.onRosterChange(this.roster(), this.flow.host);
        } finally {
          announcePending = false; // a throw must not silence every later update
        }
      });
    };
    this.flow.on('rosterchange', this._announce);
    this.flow.on('hostchange', this._announce);
  }

  async start() {
    await this._fetchBaseUrl();
    this._connect();
  }

  // ---- roster helpers ----
  roster() {
    return this.flow.list().map((p) => ({
      peerIndex: p.peerIndex, name: p.name,
      colorIndex: p.colorIndex, connected: p.connected
    }));
  }
  _usedColors() {
    const s = new Set();
    for (const p of this.flow.list()) s.add(p.colorIndex);
    return s;
  }

  // ---- connection ----
  _connect() {
    this.fastlane.closeAll();
    const url = (this.roomCode && this.instance)
      ? RELAY_URL + '/' + enc(this.roomCode) + '?instance=' + enc(this.instance)
      : RELAY_URL;
    this.party = new PartyConnection(url, { clientId: 'display' });

    this.party.onOpen = () => {
      if (this.roomCode) this.party.join(this.roomCode);
      else this.party.create(MAX_PLAYERS + 1, this._controllerUrlTemplate()); // +1 for the display itself
    };
    this.party.onProtocol = (type, msg) => this._onProtocol(type, msg);
    this.party.onMessage = (from, data) => this._onMessage(from, data);
    this.party.connect();
  }

  _onProtocol(type, msg) {
    switch (type) {
      case 'created':
        this.roomCode = msg.room;
        this.instance = msg.instance || null;
        if (this.instance) this.party.pinInstance(RELAY_URL, this.roomCode, this.instance);
        this.onRoomReady({ roomCode: this.roomCode, joinUrl: this._joinUrl() });
        break;
      case 'joined':
        this.roomCode = msg.room;
        this._resyncPeers(msg.peers || []);
        // Republish the retained snapshot unconditionally: setState calls made
        // while OUR socket was down were silently dropped (_send no-ops when
        // closed), so the relay's blob may still name seats that mutated during
        // the blip. Coalesces with any mutations _resyncPeers just made.
        this._announce();
        this.party.resetReconnectCount();
        this.onRoomReady({ roomCode: this.roomCode, joinUrl: this._joinUrl() });
        break;
      case 'peer_joined':
        this._addPeer(msg.index);
        break;
      case 'peer_left':
        this._removePeer(msg.index);
        break;
      case 'error':
        // A rejected CREATE (bad url template, relay hiccup) would otherwise
        // dead-end silently — the socket is open, so no onclose-driven retry
        // ever fires. failAttempt() treats it as a failed attempt and drives
        // the normal backoff/reconnect, which re-creates on the next onOpen.
        // Join-phase errors (roomCode set) keep the old warn-only behavior.
        if (!this.roomCode) {
          console.warn('[relay] create rejected:', msg.message);
          this.party.failAttempt();
        } else {
          console.warn('[relay]', msg.message);
        }
        break;
    }
  }

  _onMessage(from, data) {
    if (!data || from === 0) return;
    this._seen(from);
    if (this._isSignal(from, data)) return;
    switch (data.type) {
      case MSG.HELLO: {
        // A cross-device rejoin claims its dropped seat first, so the welcome we
        // build below reflects the restored identity (livery/name/host) — not the
        // throwaway placeholder slot the relay just handed this fresh connection.
        this._claimReconnect(from, data);
        const p = this.flow.get(from);
        if (!p) {
          // No seat: _addPeer declined this peer (room full — possibly every
          // free relay slot's seat is held for a reconnect). Say so explicitly
          // instead of sending a half-empty WELCOME that strands the phone in
          // a grey-livery lobby limbo.
          this.party.sendTo(from, { type: MSG.ROOM_FULL });
          break;
        }
        // The seat change behind this HELLO (join / reconnect / rekey) already
        // announced itself through the flow events; a roster re-broadcast here
        // is only owed when the HELLO changes what everyone was just told —
        // i.e. it carries a name the seat didn't have (a fresh seat still
        // wears its "Player N" placeholder). The WELCOME always goes out, and
        // after the rename so it carries the right roster.
        const name = cleanName(data.name);
        const renamed = !!name && name !== p.name;
        if (renamed) p.name = name;
        this.party.sendTo(from, this._welcomeFor(from));
        // No-rename reconnect: flow.markReconnected already emitted
        // rosterchange → the coalesced announce broadcasts the seat's return.
        if (renamed) {
          this._broadcastLobby();
          this.onRosterChange(this.roster(), this.flow.host);
        }
        break;
      }
      case MSG.LEAVE:
        // Intentional back-out: free the seat outright (no reconnect QR).
        this._expireSeat(from);
        break;
      case MSG.SET_NAME: {
        // Live rename (the CouchPad shell's rename bar — this game has no
        // in-page rename UI). Same clamp as HELLO's name; the coalesced
        // announce republishes the roster snapshot and repaints the display.
        const p = this.flow.get(from);
        const name = cleanName(data.name);
        if (p && name && name !== p.name) { p.name = name; this._announce(); }
        break;
      }
      case MSG.PING:
        this.party.sendTo(from, { type: MSG.PONG, t: data.t });
        break;
      default:
        // CONTROL / START_GAME / pause / resume / return — hand to the game layer.
        this.onControllerMessage(from, data);
    }
  }

  _addPeer(peerIndex) {
    const existing = this.flow.get(peerIndex);
    if (existing) {
      this.flow.onSeen(peerIndex, performance.now()); // a join IS traffic — fresh sweep budget
      // Same-device reconnect: the relay keys slots by clientId, so a returning
      // phone lands back on its old index. Flip presence back on and drop its
      // reconnect QR. (A cross-device rejoin gets a NEW index instead and is
      // re-keyed onto the dropped seat in _claimReconnect via HELLO.)
      if (this.flow.isDisconnected(peerIndex)) {
        this.flow.markReconnected(peerIndex);
        this._clearReconnect(peerIndex);
      }
      return;
    }
    if (this.flow.size >= MAX_PLAYERS) return;
    const colorIndex = RoomFlow.lowestFreeSlot(this._usedColors(), MAX_PLAYERS);
    this.flow.addPlayer(peerIndex, { name: 'Player ' + (colorIndex + 1), colorIndex });
    this.flow.onSeen(peerIndex, performance.now()); // after addPlayer — onSeen ignores seatless peers
  }

  _removePeer(peerIndex) {
    if (!this.flow.has(peerIndex)) return;
    this.fastlane.close(peerIndex);
    // In the lobby a drop is forgiving — just free the seat (the lobby's own join
    // QR covers coming back). Mid-run (countdown/race/results) keep the seat AND
    // the player's skier descending — so the camera stays on it and a quick
    // reconnect resumes driving — and offer a reconnect QR for that exact seat.
    // The skier is only forfeited if the grace window elapses (playerleave) or
    // every connected human finishes first (main.js forfeits the ghost).
    if (this.roomState === ROOM_STATE.LOBBY) {
      this.flow.removePlayer(peerIndex); // emits rosterchange → announce()
    } else {
      this.flow.markDisconnected(peerIndex);
      this._showReconnect(peerIndex);
    }
  }

  // Free a seat for good: clear its reconnect QR/timer and drop the player. Used
  // for an intentional LEAVE and when the reconnect grace window elapses.
  _expireSeat(peerIndex) {
    this._clearReconnect(peerIndex);
    if (!this.flow.has(peerIndex)) return;
    this.fastlane.close(peerIndex);
    this.flow.removePlayer(peerIndex);
  }

  _resyncPeers(peers) {
    const present = new Set(peers);
    for (const p of this.flow.list()) {
      // The DISPLAY's relay link blipped — that says nothing about whether a
      // missing phone is gone for good (its own reconnect may be racing ours), so
      // route through the normal drop path: mid-run that holds the seat open with
      // its reconnect QR and a fresh grace window, instead of expiring it on the
      // spot and forfeiting the skier.
      if (!present.has(p.peerIndex)) this._removePeer(p.peerIndex);
    }
    // Re-welcome everyone so their controllers clear any reconnect overlay.
    // Fresh liveness stamps too — OUR blip starved everyone's, and the sweep
    // must not QR a healthy phone before its next ping lands.
    for (const p of this.flow.list()) {
      this.flow.onSeen(p.peerIndex, performance.now());
      this.party.sendTo(p.peerIndex, this._welcomeFor(p.peerIndex));
    }
  }

  // ---- liveness (zombie links) ----
  // Stamp every inbound message; a stamp also HEALS a liveness-dropped seat,
  // because its socket never actually closed — the peer_joined that flips a
  // returning seat back on (_addPeer) will never fire, so traffic is the only
  // signal it's alive again. This also covers a phone whose relay link dropped
  // while its P2P fastlane kept delivering CONTROL: the player is still
  // driving, so the seat stays live and no QR interrupts their run.
  _seen(peerIndex) {
    this.flow.onSeen(peerIndex, performance.now());
    if (this.flow.has(peerIndex) && this.flow.isDisconnected(peerIndex)) {
      this.flow.markReconnected(peerIndex);
      this._clearReconnect(peerIndex);
    }
  }

  _sweepLiveness() {
    // RESULTS gate is host policy (see LIVENESS_TIMEOUT_MS); expiredPeers
    // itself already skips LOBBY and seats that are flagged disconnected.
    if (this.roomState === ROOM_STATE.LOBBY || this.roomState === ROOM_STATE.RESULTS) return;
    for (const id of this.flow.expiredPeers(performance.now())) this._removePeer(id);
  }

  // ---- reconnect (dropped-seat) handling ----
  // A different device claims a dropped seat by carrying its old peerIndex as the
  // HELLO rejoinToken (from the QR's ?claim=). Re-key the kept seat record from
  // the old index onto this fresh connection so the returning player resumes their
  // livery/name/host slot and their still-descending skier. A same-device
  // reconnect keeps its index and never reaches here (oldId === fromId, handled in
  // _addPeer instead).
  _claimReconnect(fromId, msg) {
    const oldId = this._normIndex(msg && msg.rejoinToken);
    if (oldId == null || oldId === fromId) return false;
    if (!this.flow.has(oldId) || !this.flow.isDisconnected(oldId)) return false;
    this.fastlane.close(oldId);
    this.fastlane.close(fromId);
    this.flow.rekey(oldId, fromId);    // moves the seat record, marks it reconnected
    this.onPlayerRekey(oldId, fromId); // move their still-descending skier onto the new slot
    this._clearReconnect(oldId);
    this._clearReconnect(fromId);
    return true;
  }

  _showReconnect(peerIndex) {
    const p = this.flow.get(peerIndex);
    if (!p) return;
    this._reconnectSeats.set(peerIndex, {
      peerIndex, name: p.name, colorIndex: p.colorIndex, url: this._claimUrl(peerIndex)
    });
    clearTimeout(this._reconnectTimers.get(peerIndex));
    this._reconnectTimers.set(peerIndex, setTimeout(() => this._expireSeat(peerIndex), RECONNECT_GRACE_MS));
    this.onReconnectChange([...this._reconnectSeats.values()]);
  }

  _clearReconnect(peerIndex) {
    if (this._reconnectTimers.has(peerIndex)) {
      clearTimeout(this._reconnectTimers.get(peerIndex));
      this._reconnectTimers.delete(peerIndex);
    }
    if (this._reconnectSeats.delete(peerIndex)) this.onReconnectChange([...this._reconnectSeats.values()]);
  }

  // Join URL with ?claim=<peerIndex> spliced in BEFORE the #instance fragment so
  // the relay-shard pin survives (cf. _joinUrl). Scanning this lands a fresh device
  // on the room with the token that reclaims this exact seat.
  _claimUrl(peerIndex) {
    const u = this._joinUrl();
    const h = u.indexOf('#');
    const base = h >= 0 ? u.slice(0, h) : u;
    const frag = h >= 0 ? u.slice(h) : '';
    const sep = base.indexOf('?') >= 0 ? '&' : '?';
    return base + sep + 'claim=' + enc(peerIndex) + frag;
  }

  _normIndex(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  // ---- outbound protocol ----
  _welcomeFor(peerIndex) {
    const p = this.flow.get(peerIndex) || {};
    // The extras hook is best-effort sugar — if it throws, the joining phone
    // must still get its WELCOME (a dropped one hangs the join silently).
    let extras = null;
    try { extras = this.welcomeExtras(peerIndex); } catch (e) { console.warn('[DisplayNet] welcomeExtras threw', e); }
    return {
      type: MSG.WELCOME,
      peerIndex,
      colorIndex: p.colorIndex,
      hostPeerIndex: this.flow.host,
      roomState: this.roomState,
      inRun: this.isInRun(peerIndex),
      players: this.roster(),
      ...(extras || {})
    };
  }
  // Publish the retained room snapshot (Party-Sockets set_state) instead of
  // fanning out a per-recipient LOBBY_UPDATE: the relay pushes it live to
  // connected controllers and replays it to any (re)joining peer right after
  // `joined`, so N messages collapse to one and a briefly-dropped controller
  // catches up for free. ControllerNet re-shapes it onto the LOBBY_UPDATE
  // apply path; WELCOME stays the per-recipient identity/screen arbiter. An
  // EMPTY roster still publishes — the retained snapshot must not keep naming
  // a departed player (or a stale host) to the next (re)joiner.
  _broadcastLobby() {
    this.party.setState({ hostPeerIndex: this.flow.host, players: this.roster() });
  }

  broadcast(data) { if (this.party) this.party.broadcast(data); }
  sendTo(id, data) { if (this.party) this.party.sendTo(id, data); }
  get roomState() { return this.flow.state; }

  // Goodbye on intentional close/navigate-away: tear the room down on the
  // relay. Every controller socket gets a 4001 "room closed" (surfaced as
  // onClose {roomClosed} — their terminal party-over signal) and GET
  // /room/:code turns 404 right away, so stale rejoin/claim QRs die with the
  // room. Best-effort on pagehide (bfcache freeze may drop the send); the
  // DISPLAY_CLOSED broadcast and the controllers' display-gone bail cover
  // whatever doesn't land. close() last so no auto-reconnect resurrects us.
  closeRoom() {
    if (!this.party) return;
    try { this.party.closeRoom(); } catch (_) {}
    this.party.close();
  }

  // ---- join URL / QR base ----
  _joinUrl() {
    const base = this.baseUrlOverride || window.location.origin;
    return base + '/' + this.roomCode + (this.instance ? '#' + enc(this.instance) : '');
  }
  // Controller-URL template registered with the relay on room create. The relay
  // fills {room}/{instance} and hands the result to anyone holding only the
  // room code (native shells via GET /room/:code, controllers in `joined`), so
  // a code-only join can still resolve which page to load. Mirrors _joinUrl's
  // shape: instance in the fragment, kept out of request logs. The relay
  // accepts only absolute https templates and rejects the whole create on an
  // invalid one, so plain-http origins (local dev, e2e) register none.
  _controllerUrlTemplate() {
    const base = (this.baseUrlOverride || window.location.origin).replace(/\/+$/, '');
    if (!base.startsWith('https://')) return undefined;
    return base + '/{room}#{instance}';
  }
  async _fetchBaseUrl() {
    const host = window.location.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') return;
    try {
      const r = await fetch('/api/baseurl');
      const d = await r.json();
      if (d.baseUrl) this.baseUrlOverride = d.baseUrl;
    } catch (_) { /* fall back to origin */ }
  }
}

// Render a join URL into `el`, wrapping the trailing room code in a
// <span class="join__code"> so it can be tinted. Built with DOM nodes (not
// innerHTML) so the code is always treated as text.
export function renderJoinUrl(el, fullText, code) {
  el.textContent = '';
  const shown = fullText.replace(/^https?:\/\//, ''); // display without the scheme
  if (code && shown.endsWith(code)) {
    el.append(shown.slice(0, shown.length - code.length));
    const span = document.createElement('span');
    span.className = 'join__code';
    span.textContent = code;
    el.appendChild(span);
  } else {
    el.textContent = shown;
  }
}

export async function fetchQR(text) {
  const r = await fetch('/api/qr?text=' + enc(text));
  return r.json();
}
// `bg` is the quiet-zone fill (default white). Pass a falsy bg for a transparent
// background — black modules sit straight on whatever's behind the canvas.
export function renderQR(canvas, qr, px = 480, bg = '#ffffff') {
  if (!qr || !qr.size) return;
  const n = qr.size, cell = Math.floor(px / n), size = cell * n;
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size); }
  else ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#0b0f17';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.modules[r * n + c]) ctx.fillRect(c * cell, r * cell, cell, cell);
  }
}

// Build a dropped-player reconnect card — name + "Disconnected" + the rejoin QR —
// to be centred in that player's split-screen cell by the renderer (see
// SceneRenderer.setSkierReconnect / _loop). `seat` is {name, colorIndex, url}.
// Shared by the live display (main.js) and the gallery harness so the markup
// stays in one place. QR matrices are cached by url.
const _rcQrCache = new Map();
export function buildReconnectCard(seat) {
  const card = document.createElement('div');
  card.className = 'cell-reconnect';
  card.style.setProperty('--c', (SKIER_COLORS && SKIER_COLORS[seat.colorIndex]) || '#888');

  const head = document.createElement('div');
  head.className = 'rc-card__head';
  const nm = document.createElement('span'); nm.className = 'rc-card__name'; nm.textContent = seat.name;
  head.append(nm);

  const sub = document.createElement('div');
  sub.className = 'rc-card__sub'; sub.textContent = 'Disconnected';

  const qr = document.createElement('canvas');
  qr.className = 'rc-card__qr';

  card.append(head, sub, qr);

  // Transparent QR background → black modules sit straight on the frosted card.
  // Rendered well above the max CSS size (360px) so it stays crisp on hi-DPI screens.
  const cached = _rcQrCache.get(seat.url);
  if (cached) renderQR(qr, cached, 640, null);
  else fetchQR(seat.url)
    .then((m) => { _rcQrCache.set(seat.url, m); renderQR(qr, m, 640, null); })
    .catch((e) => console.warn('reconnect QR failed', e));

  return card;
}
