// ControllerNet — phone-side relay connection. Derives room/instance/clientId
// from the URL, joins the room, and exchanges messages with the display (slot 0).
// CONTROL messages ride the WebRTC fastlane (PartyFastlane) when the DataChannel
// is open; all other traffic and fallback go over the WebSocket relay.
//
// Reads globals from classic scripts loaded first:
// PartyConnection, PartyFastlane, MSG, RELAY_URL, FASTLANE_TYPES.
import { GameNet } from '../shared/GameNet.js';

const { PartyConnection, MSG, RELAY_URL, FASTLANE_TYPES } = window;
const enc = encodeURIComponent;

// Relay-liveness ping cadence and the overdue-PONG threshold after which we
// surface a "no signal" reading (only when the fastlane isn't carrying its own
// live RTT). 1 Hz is plenty for a latency readout and matches the display's
// per-controller liveness expectations.
const PING_INTERVAL_MS = 1000;
const PONG_TIMEOUT_MS = 3000;

function deriveRoomCode() {
  const seg = (location.pathname || '/').split('/').filter(Boolean)[0];
  return seg || '';
}
function deriveInstance() {
  const raw = (location.hash || '').slice(1);
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}
// Reconnect claim from the display's per-seat QR (…/ROOM?claim=<peerIndex>). When
// a player rejoins on a DIFFERENT device (the original phone's clientId is gone),
// this token tells the display which dropped seat to hand this fresh connection —
// see DisplayNet._claimReconnect. A same-device reconnect keeps its relay slot by
// clientId and never needs it. Null on a normal first-time join.
function deriveClaim() {
  const raw = new URLSearchParams(location.search).get('claim');
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function loadClientId(roomCode) {
  const key = 'clientId_' + roomCode;
  try {
    const stored = localStorage.getItem(key);
    if (stored) return { id: stored, stored: true };
    const id = 'tc-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, id);
    return { id, stored: false };
  } catch (_) {
    return { id: 'tc-' + Math.random().toString(36).slice(2), stored: false };
  }
}

export class ControllerNet extends GameNet {
  constructor(opts = {}) {
    super();
    this.onMessage = opts.onMessage || (() => {});
    this.onJoined = opts.onJoined || (() => {});
    this.onStatus = opts.onStatus || (() => {}); // (state, info)
    this.onRtt = opts.onRtt || (() => {});       // (halfMs, viaFastlane); halfMs < 0 = no signal
    this.roomCode = deriveRoomCode();
    this.instance = deriveInstance();
    const cid = loadClientId(this.roomCode);
    this.clientId = cid.id;
    this.rejoinToken = deriveClaim();
    // A device the relay may already know — a clientId minted on an earlier
    // visit (same-device reconnects swap into their existing relay slot) or a
    // ?claim= rejoin token. Softens the pre-join probeRoom verdict: "full"
    // isn't fatal for a returning device, only for a fresh one.
    this.isReturning = cid.stored || this.rejoinToken != null;
    this.peerIndex = null;
    this.playerName = '';
    this._pingTimer = null;
    this._lastPong = 0;
    this._suspended = false; // parked while the page is backgrounded (see suspend/resume)
  }

  // Probe the relay over HTTP for this room's existence/occupancy, so a stale
  // QR (dead room) or a full room surfaces on the name screen immediately
  // instead of only after the player types a name and hits join. Resolves to
  // 'not_found' | 'full' | 'ok' | null — null covers an unreachable relay or
  // one without the endpoint; connect() will surface any real failure then.
  // (CSP connect-src already allows the relay's https origin.)
  async probeRoom() {
    try {
      const httpUrl = RELAY_URL.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
      const res = await fetch(httpUrl + '/room/' + enc(this.roomCode) + (this.instance ? '?instance=' + enc(this.instance) : ''));
      if (res.status === 404) return 'not_found';
      if (!res.ok) return null;
      const info = await res.json();
      return info && info.clients >= info.maxClients ? 'full' : 'ok';
    } catch (_) { return null; }
  }

  connect(playerName) {
    this.playerName = playerName || this.playerName;
    this._suspended = false; // any explicit connect (retry button, resume) leaves the parked state
    if (this.party) this.party.close();
    if (this.fastlane) this.fastlane.closeAll();
    const url = RELAY_URL + '/' + enc(this.roomCode) + (this.instance ? '?instance=' + enc(this.instance) : '');
    this.party = new PartyConnection(url, { clientId: this.clientId });

    this.party.onOpen = () => this.party.join(this.roomCode);
    this.party.onProtocol = (type, msg) => {
      if (type === 'joined') {
        this.peerIndex = msg.index;
        this.party.resetReconnectCount(); // fresh retry budget — each clean (re)join starts over
        this._openFastlane();
        // rejoinToken claims a dropped seat when this is a cross-device rejoin
        // (harmless otherwise — the display ignores a token that matches our own
        // fresh slot or names a seat that's no longer waiting).
        this.party.sendTo(0, { type: MSG.HELLO, name: this.playerName, rejoinToken: this.rejoinToken });
        this.rejoinToken = null; // one-shot: a later retry/reconnect joins as itself, not a re-claim
        this._startPing();
        this.onJoined(this.peerIndex);
        // The joined snapshot says who's in the room. Without the display
        // (slot 0) this join would otherwise hang silently — the HELLO above
        // went to nobody and no WELCOME will ever land — so surface it as
        // display_gone, same as a live peer_left(0). Covers both a fresh join
        // into an abandoned room and our own socket recovering while the
        // display is still away (peer_left only fires on a live connection).
        if (Array.isArray(msg.peers) && msg.peers.indexOf(0) < 0) this.onStatus('display_gone');
      } else if (type === 'error') {
        this.onStatus('error', msg.message);
      } else if (type === 'peer_left' && msg.index === 0) {
        this.onStatus('display_gone');
      }
    };
    this.party.onMessage = (from, data) => {
      if (from !== 0 || !data) return;
      if (this._isSignal(from, data)) return;
      if (data.type === MSG.PONG) { this._handlePong(data); return; }
      this.onMessage(data);
    };
    // Retained room snapshot (roster + host) — pushed live on each display
    // update and replayed right after `joined` on (re)join, replacing the
    // LOBBY_UPDATE fanout. Re-shaped onto the LOBBY_UPDATE envelope so the
    // existing apply path does the work. The replay can land BEFORE our
    // WELCOME (we may not be in the roster yet); the handler tolerates that,
    // and WELCOME stays the identity/screen arbiter.
    this.party.onState = (snap) => {
      if (!snap || !Array.isArray(snap.players)) return;
      this.onMessage({ type: MSG.LOBBY_UPDATE, hostPeerIndex: snap.hostPeerIndex, players: snap.players });
    };
    this.party.onClose = (attempt, max, meta) => {
      this._stopPing();
      if (meta && meta.replaced) { this.onStatus('replaced'); return; }
      // The relay tore the room down (display sent close_room on its way out,
      // or the hostless grace expired): terminal — PartyConnection has already
      // stopped reconnecting, a rejoin would only bounce off "Room not found".
      if (meta && meta.roomClosed) { this.onStatus('room_closed'); return; }
      // attempt > max: PartyConnection has stopped retrying — the link is down for
      // good until the player acts. Surface a distinct 'lost' so the UI can offer a
      // retry (and point at the big screen's reconnect QR).
      if (attempt > max) { this.onStatus('lost'); return; }
      this.onStatus('reconnecting', { attempt, max });
    };
    this.party.connect();
  }

  // Tear down the connection for good (no reconnect). Sends LEAVE first so the
  // display frees our seat outright instead of holding it open with a reconnect
  // QR — a back-out is intentional, not a drop. (peer_left follows when the
  // socket closes; the display no-ops it once the seat's already gone.) Used when
  // the player backs out of the room to the name screen.
  disconnect() {
    this._stopPing();
    this._suspended = false; // a terminal exit outranks a pending resume()
    try { if (this.party) this.party.sendTo(0, { type: MSG.LEAVE }); } catch (_) {}
    if (this.fastlane) { this.fastlane.closeAll(); this.fastlane = null; }
    if (this.party) { this.party.close(); this.party = null; }
    this.peerIndex = null;
  }

  // Park the connection while the page is backgrounded (CONTRACT.md §7 — the
  // CouchPad shell's synthetic `pagehide`, or a browser's own bfcache freeze).
  // Deliberately NOT a disconnect(): no LEAVE, so the display holds our seat
  // open behind its reconnect QR instead of freeing it — this is "back in a
  // moment", not "I'm out". PartyConnection.close() detaches its handlers
  // before closing, so no onClose fires and the UI shows no false
  // "reconnecting" while we're away. A no-op before the first join.
  suspend() {
    if (!this.party || this._suspended) return;
    this._suspended = true;
    this._stopPing();
    if (this.fastlane) this.fastlane.closeAll();
    this.party.close();
  }

  // Back in the foreground: rejoin. The same clientId reclaims the same relay
  // slot, and HELLO re-introduces us under the name we already carry, so the
  // display re-seats us exactly like any other dropped-and-returned phone.
  // Only ever undoes a suspend() — an ordinary tab-switch back is a no-op.
  resume() {
    if (this._suspended) this.connect(); // connect() clears the flag
  }

  // Live rename (the CouchPad shell's window.CouchPad.setName). Adopt the
  // name for future HELLOs — a reconnect re-introduces us with it — and tell
  // the display so the roster updates everywhere. A no-op while disconnected
  // (send() drops without a party; the adopted name still rides the next join).
  rename(name) {
    this.playerName = name;
    this.send(MSG.SET_NAME, { name });
  }

  // Send to the display. FASTLANE_TYPES messages ride the WebRTC DataChannel
  // when it's open; everything else (and fallback) goes over the WS relay.
  send(type, payload) {
    if (!this.party) return;
    const msg = payload || {};
    msg.type = type;
    if (FASTLANE_TYPES[type] && this.fastlane && this.fastlane.enqueue(0, msg) === 'p2p') return;
    this.party.sendTo(0, msg);
  }

  _openFastlane() {
    this._initFastlane(this.peerIndex, {
      emitIdleHeartbeat: true,
      // Idle heartbeats keep acks flowing even with no inputs, so this fires
      // ~continuously while the P2P channel is up — smoothed half-RTT (srtt/2),
      // lower than the WS path. viaFastlane=true so the UI lights the bolt.
      onRtt: (peerIdx, halfMs) => { if (peerIdx === 0) this.onRtt(Math.round(halfMs), true); },
      onPeerClosed: () => {
        // Display-side fastlane closed (watchdog or display reconnect); retry.
        setTimeout(() => { if (this.fastlane && this.peerIndex != null) this.fastlane.open(0); }, 2000);
      },
    });
    this.fastlane.open(0);
  }

  // ---- ping / pong (WS relay-liveness + WS-path latency) ----
  // The fastlane reports its own (lower) RTT via onRtt; this WS ping is the
  // fallback latency source and the liveness check. When the fastlane is open
  // its samples win — we don't let the 1 Hz WS reading clobber the live P2P
  // chip (the gate in _handlePong / the timeout below).
  _startPing() {
    this._stopPing();
    this._lastPong = Date.now();
    this._pingTimer = setInterval(() => {
      if (!this.party) return;
      this.send(MSG.PING, { t: Date.now() });
      if (Date.now() - this._lastPong > PONG_TIMEOUT_MS && !this._fastlaneUp()) {
        this.onRtt(-1, false);
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _handlePong(data) {
    this._lastPong = Date.now();
    // Only drive the chip from the WS reading when the fastlane isn't already
    // feeding higher-fidelity P2P samples — otherwise the 1 Hz relay RTT would
    // stomp the live bolt reading once a second.
    if (typeof data.t === 'number' && !this._fastlaneUp()) {
      this.onRtt(Math.round((Date.now() - data.t) / 2), false);
    }
  }

  _fastlaneUp() { return !!(this.fastlane && this.fastlane.isOpen(0)); }

  isHost(hostPeerIndex) { return this.peerIndex != null && this.peerIndex === hostPeerIndex; }
}
