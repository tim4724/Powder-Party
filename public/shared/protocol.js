'use strict';

// ============================================================================
// Powder Party — wire contract shared by display and controllers.
// GAME-SIDE config (not part of the partyplug kit): the relay/STUN deployment
// URLs and this game's message vocabulary live here and are injected into the
// kit at construction. The kit reads none of these globals.
//
// The game: a downhill ski race. Phones are controllers — tucked-and-fast is the
// default; tilt to CARVE, hold to BRAKE (sit up for control), and flick in the air
// to FLIP (ramps auto-launch you). The shared screen renders the authoritative
// slope simulation; first skier to the bottom wins.
// ============================================================================

// Party-Server relay URL (signaling + game-event fallback).
var RELAY_URL = 'wss://ws.couch-games.com';

// STUN server for the WebRTC fastlane (server-reflexive candidates so
// cross-network peers connect). STUN is UDP and ignored by CSP connect-src.
var STUN_URL = 'stun:stun.couch-games.com:3478';

// Message types carried inside the Party-Server `data` field. Every message is
// a plain object with a `.type` drawn from here.
var MSG = {
  // Controller -> Display
  HELLO: 'hello',                     // {name?, rejoinToken?} sent right after join — rejoinToken claims a dropped seat (cross-device reconnect, from the big screen's QR ?claim=)
  // CONTROL — the hot path (~25Hz, fastlane). All fields are latest-wins safe:
  //   s : carve  [-1,1]  gyro roll (or air-lean while airborne). 0 = straight.
  //   t : tuck   0|1     DEFAULT 1 (tucked/fast); 0 only while BRAKING (held).
  //   j : jumpSeq 0..255  wrapping up-flick edge. Does nothing on the snow now
  //                       ("flick up to jump" was removed — ramps auto-launch). In
  //                       the AIR it's a back-flip fallback for inputs without an
  //                       analog f (keyboard/bots); real controllers send f's angle.
  //   f : { n:0..255, a, m } wrapping ANALOG AIR-trick flick. a = flick angle
  //                       (rad, up = +π/2): up→back flip, down→front, sides→spin,
  //                       diagonals→cork. m = strength 0..1 → spin rate. Air-only
  //                       (ignored on the snow). Like j, the display fires one
  //                       action per CHANGE, so a dropped fastlane frame re-delivers.
  CONTROL: 'control',
  START_GAME: 'start_game',           // host only
  RETURN_TO_LOBBY: 'return_to_lobby', // "New run" — abort back to the lobby (host)
  PAUSE_GAME: 'pause_game',           // request a pause (any player, mid-countdown/run)
  RESUME_GAME: 'resume_game',         // request resume from the pause overlay
  LEAVE: 'leave',                     // intentional exit (back-out) — display frees the seat at once (no reconnect QR)
  PING: 'ping',

  // Display -> specific controller
  WELCOME: 'welcome',                 // {peerIndex, colorIndex, hostPeerIndex, roomState, players}
  LOBBY_UPDATE: 'lobby_update',       // roster/host snapshot
  PLAYER_STATE: 'player_state',       // {position, of, progress[0..1], airborne, finished} — light HUD feed (~10Hz)
  PONG: 'pong',

  // Display -> all controllers (broadcast)
  COUNTDOWN: 'countdown',             // {n} 3..2..1..GO
  GAME_START: 'game_start',
  STANDINGS: 'standings',             // {over, hostPeerIndex, total, order:[{playerId,name,colorIndex,ai,finished,time}]}
                                      // pushed as each skier finishes (over=false) + at run end (over=true)
  GAME_END: 'game_end',               // {results} — sent on return-to-lobby; controllers go back to the lobby
  GAME_PAUSED: 'game_paused',         // run frozen — controllers show the pause overlay
  GAME_RESUMED: 'game_resumed'        // run resumed — controllers hide the pause overlay
};

// Message types that ride the low-latency WebRTC fastlane (unreliable,
// unordered, latest-wins). Only idempotent, latest-state-wins inputs belong
// here. All other traffic and WS fallback flow through the relay.
var FASTLANE_TYPES = { control: true };

// Room states (must match partyplug RoomFlow.STATES; asserted at display boot).
var ROOM_STATE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  RESULTS: 'results'
};

// ---- Game constants (shared so display + controller agree) ----
// Human seats per room. A short-handed lobby is topped up with AI ("CPU")
// skiers on the display side, so this caps PHONES, not skiers in a run.
var MAX_PLAYERS = 4;
var COUNTDOWN_SECONDS = 3;

// Skier-suit livery palette, indexed by the dense color slot
// RoomFlow.lowestFreeSlot hands out. Both sides resolve colorIndex → hex. This
// is the only thing that distinguishes players (every skier handles the same).
// (Mirrors the --car-* tokens in shared/theme.css.)
var SKIER_COLORS = [
  '#e6492d', // red
  '#f2b134', // amber
  '#2bb673', // green
  '#2d9cdb', // blue
  '#9b51e0', // purple
  '#eb5e9c', // pink
  '#f2784b', // orange
  '#56ccf2'  // cyan
];

// Export for both Node.js and browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MSG, FASTLANE_TYPES, ROOM_STATE,
    RELAY_URL, STUN_URL,
    MAX_PLAYERS, COUNTDOWN_SECONDS,
    SKIER_COLORS
  };
}
