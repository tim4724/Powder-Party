// Slope gallery — one card per named slope, each an iframe loading the real
// display in slope-preview mode (/?test=1&scenario=slope&slope=<id>): the whole
// layout under a slowly orbiting overview camera with a small CPU field carving
// it. Reuses the shared Gallery helpers (card factory, lazy mount, AR scaling).
//
// This is an ES module (so it can import the slope catalogue directly) but it
// still leans on the classic-script `window.Gallery` loaded just before it.
import { SLOPE_LIST } from '/shared/slopes.js';

const Gallery = window.Gallery;
const state = Gallery.loadState();

// Slopes use their own columns key so this page doesn't clobber the display /
// controller galleries' layout preference. Slopes render wide (16:9) → 2 up.
const SLOPE_DEFAULT_COLS = 2;
const SLOPE_MAX_COLS = 4;
const storedCols = parseInt(state.slopeCardsPerRow, 10);
state.slopeCardsPerRow = Math.max(1, Math.min(storedCols || SLOPE_DEFAULT_COLS, SLOPE_MAX_COLS));
state.showCenterline = !!state.showCenterline;

function dims() { return Gallery.DISPLAY_AR_DIMS[state.displayAR] || Gallery.DISPLAY_AR_DIMS['16x9']; }

function cardURL(id) {
  return Gallery.displayURL(state, 'slope', {
    slope: id,
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
  for (const s of SLOPE_LIST) {
    const card = Gallery.makeCard({
      title: s.name,
      tag: Array.isArray(s.chips) ? s.chips.join(' · ') : '',
      frameClass: 'display',
      logical: d,
      url: cardURL(s.id)
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
