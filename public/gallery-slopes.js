// Slope gallery — one card per DIFFICULTY TIER (Blue / Red / Black), each an
// iframe loading the real display in slope-preview mode
// (/?test=1&scenario=slope&level=<tier>): the whole layout under a slowly
// orbiting overview camera with a small CPU field carving it. The tiers are what
// live play actually rolls (procedural per-grade mountains), so previewing them
// — rather than the legacy single catalog slope — shows what players really ski.
// Reuses the shared Gallery helpers (card factory, lazy mount, AR scaling).
//
// This is an ES module (so it can import the tier list directly) but it still
// leans on the classic-script `window.Gallery` loaded just before it.
import { LEVELS } from '/shared/slopes.js';

const Gallery = window.Gallery;
const state = Gallery.loadState();

// Per-tier card copy. Ordered/keyed by slopes.js LEVELS so a new tier there shows
// up here too (with a capitalised-id fallback). The chips read the real-piste
// grade meaning that the LEVEL_TUNING knobs encode (wider+sparser → narrower+denser).
const TIER_INFO = {
  blue:  { name: 'Blue Run',  chips: ['Easy', 'Wide', 'Sparse'] },
  red:   { name: 'Red Run',   chips: ['Intermediate', 'Steeper'] },
  black: { name: 'Black Run', chips: ['Expert', 'Steep', 'Jumps'] },
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const TIERS = LEVELS.map((id) => ({
  id,
  name: (TIER_INFO[id] || {}).name || `${cap(id)} Run`,
  chips: (TIER_INFO[id] || {}).chips || [cap(id)],
}));

// Slopes use their own columns key so this page doesn't clobber the display /
// controller galleries' layout preference. Slopes render wide (16:9) → 2 up.
const SLOPE_DEFAULT_COLS = 2;
const SLOPE_MAX_COLS = 4;
const storedCols = parseInt(state.slopeCardsPerRow, 10);
state.slopeCardsPerRow = Math.max(1, Math.min(storedCols || SLOPE_DEFAULT_COLS, SLOPE_MAX_COLS));
state.showCenterline = !!state.showCenterline;

function dims() { return Gallery.DISPLAY_AR_DIMS[state.displayAR] || Gallery.DISPLAY_AR_DIMS['16x9']; }

function cardURL(level) {
  return Gallery.displayURL(state, 'slope', {
    level, // procedural tier (no catalog `slope` id) → makeSlope() rolls this grade
    centerline: state.showCenterline ? 1 : undefined // qs() drops undefined → omitted when off
  });
}

let allCards = [];
let lazyIo = null;

function render() {
  Gallery.resetQueue();
  if (lazyIo) { lazyIo.disconnect(); lazyIo = null; }
  for (const c of allCards) if (c._destroy) c._destroy();
  const host = document.getElementById('slope-rows');
  host.innerHTML = '';

  const strip = document.createElement('div');
  strip.className = 'scenario-strip';
  strip.style.setProperty('--row-cols', state.slopeCardsPerRow);

  allCards = [];
  const d = dims();
  for (const t of TIERS) {
    const card = Gallery.makeCard({
      title: t.name,
      tag: t.chips.join(' · '),
      frameClass: 'display',
      logical: d,
      url: cardURL(t.id)
    });
    strip.appendChild(card);
    allCards.push(card);
  }
  host.appendChild(strip);
  lazyIo = Gallery.lazyMount(allCards);
}

// AR change only affects frame geometry — re-layout existing cards in place.
function updateDims() {
  const d = dims();
  for (const c of allCards) if (c._applyDims) c._applyDims(d, 0);
}
function updateLayout() {
  document.querySelectorAll('.scenario-strip')
    .forEach((s) => s.style.setProperty('--row-cols', state.slopeCardsPerRow));
}

Gallery.bindSelect(state, 'display-ar', 'displayAR', updateDims);
Gallery.bindSelect(state, 'cards-per-row', 'slopeCardsPerRow', updateLayout, (v) =>
  Math.max(1, Math.min(parseInt(v, 10) || SLOPE_DEFAULT_COLS, SLOPE_MAX_COLS)));
// Centerline toggle changes the iframe URL (?centerline=…) → rebuild the cards.
Gallery.bindCheckbox(state, 'show-centerline', 'showCenterline', render);

Gallery.autoPauseOnHeaderFocus();
Gallery.initMobileOptionsToggle();
render();
