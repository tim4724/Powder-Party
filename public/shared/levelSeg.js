// Shared Blue/Red/Black difficulty switch — built + painted identically on the
// host's phone (controller) and the big screen (display) so the two can't drift.
// Pure DOM: no relay, no game state, no THREE. `seg` is the #level-seg container
// element; `levels` is the shared LEVELS metadata ([{ id, label, color }]); the
// active segment fills with its tier colour via the inline --level-color.
//
// A tier changes only the MOUNTAIN (procedural geometry + obstacle/jump density),
// never the physics — see generateSlope / SET_LEVEL.

// Build the three segments once. `onPick(id)` fires on a tap; omit it for a
// read-only mirror (a pointer-less TV simply shows the state).
export function buildLevelSeg(seg, levels, onPick) {
  if (!seg || seg.childElementCount) return; // build once
  for (const lv of levels) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'level-seg__btn';
    b.dataset.level = lv.id;
    b.textContent = lv.label;
    b.style.setProperty('--level-color', lv.color);
    if (onPick) b.addEventListener('click', () => onPick(lv.id));
    seg.appendChild(b);
  }
}

// Highlight the active tier; `disabled` greys every segment (a read-only mirror,
// e.g. a non-host phone).
export function paintLevelSeg(seg, level, disabled) {
  if (!seg) return;
  for (const b of seg.children) {
    b.classList.toggle('is-active', b.dataset.level === level);
    b.disabled = !!disabled;
  }
}
