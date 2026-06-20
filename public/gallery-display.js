'use strict';

// Every display screen in one flat grid, ordered by the player's journey
// through a real session. Cards-per-row is set by the header control.
//
// Card shape:
//   { key, title, animated? }
// `animated` cards run an endless CPU-driven loop (tagged "live"); the rest are
// one-shot snapshots. The display harness reads `players`; it doesn't take a
// host marker, so there's no per-slot "view as" control here (unlike Phone).
// The device chooser is a phone-only moment (the media query never trips on a
// big screen), so its card lives in the Phone gallery, not here.
var DISPLAY_CARDS = [
  { key: 'lobby',     title: 'Lobby' },
  { key: 'countdown', title: 'Countdown', animated: true },
  { key: 'running',   title: 'Run',       animated: true },
  { key: 'reconnect', title: 'Reconnect', animated: true },
  { key: 'paused',    title: 'Paused' },
  { key: 'results',   title: 'Results (run)' },
  { key: 'results',   title: 'Results (series)', extra: { over: '1' } }
];

var state = Gallery.loadState();

// Display uses its own cards-per-row + players keys so switching between the
// display and controller pages doesn't clobber each other's preference.
var MAX_PLAYERS = 4;
var DISPLAY_MAX_COLS = 5;
var DISPLAY_DEFAULT_COLS = 3;
var DISPLAY_DEFAULT_PLAYERS = MAX_PLAYERS;
var stored = parseInt(state.displayCardsPerRow, 10);
state.displayCardsPerRow = Math.max(1, Math.min(stored || DISPLAY_DEFAULT_COLS, DISPLAY_MAX_COLS));
state.displayPlayers = Math.max(1, Math.min(parseInt(state.displayPlayers, 10) || DISPLAY_DEFAULT_PLAYERS, MAX_PLAYERS));
state.players = state.displayPlayers;

function dims() { return Gallery.DISPLAY_AR_DIMS[state.displayAR] || Gallery.DISPLAY_AR_DIMS['16x9']; }

var allCards = [];

function cardURL(c) { return Gallery.displayURL(state, c.key, c.extra); }
function cardTag(c) { return c.animated ? 'live' : ''; }

var lazyIo = null;
function render() {
  Gallery.resetQueue();
  if (lazyIo) { lazyIo.disconnect(); lazyIo = null; }
  for (var d0 = 0; d0 < allCards.length; d0++) if (allCards[d0]._destroy) allCards[d0]._destroy();
  var host = document.getElementById('display-rows');
  host.innerHTML = '';

  var strip = document.createElement('div');
  strip.className = 'scenario-strip';
  strip.style.setProperty('--row-cols', state.displayCardsPerRow);

  allCards = [];
  var d = dims();
  for (var i = 0; i < DISPLAY_CARDS.length; i++) {
    var c = DISPLAY_CARDS[i];
    var card = Gallery.makeCard({
      title: c.title,
      tag: cardTag(c),
      frameClass: 'display',
      logical: d,
      url: cardURL(c)
    });
    strip.appendChild(card);
    allCards.push(card);
  }
  host.appendChild(strip);
  lazyIo = Gallery.lazyMount(allCards);
}

// AR change only affects frame geometry — re-layout existing cards.
function updateDims() {
  var d = dims();
  for (var i = 0; i < allCards.length; i++) {
    if (allCards[i]._applyDims) allCards[i]._applyDims(d, 0);
  }
}
function updateLayout() {
  var strips = document.querySelectorAll('.scenario-strip');
  for (var i = 0; i < strips.length; i++) {
    strips[i].style.setProperty('--row-cols', state.displayCardsPerRow);
  }
}

Gallery.bindSelect(state, 'display-ar', 'displayAR', updateDims);
Gallery.bindSelect(state, 'player-count', 'displayPlayers', function() {
  state.players = state.displayPlayers;
  render();
}, function(v) { return Math.max(1, Math.min(parseInt(v, 10) || DISPLAY_DEFAULT_PLAYERS, MAX_PLAYERS)); });
Gallery.bindSelect(state, 'cards-per-row', 'displayCardsPerRow', updateLayout, function(v) {
  return Math.max(1, Math.min(parseInt(v, 10) || DISPLAY_DEFAULT_COLS, DISPLAY_MAX_COLS));
});

Gallery.autoPauseOnHeaderFocus();
Gallery.initMobileOptionsToggle();
render();
