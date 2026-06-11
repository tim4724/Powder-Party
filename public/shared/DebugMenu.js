// DebugMenu — a discreet ⚙ button (bottom-left, above the build badge) that
// opens an interactive panel of the page's debug query params. Each page passes
// its own field schema (the display and controller support different params);
// the panel prefills from the current URL, previews the URL it will load, and
// "Go" navigates there (a reload — every debug param is read at boot). Fully
// self-contained: injects its own DOM + <style> (CSP allows inline styles),
// so neither page's HTML or CSS needs to know about it.
//
// Field schema: { key, label, hint?, type: 'select'|'number'|'check',
//                 options?: [value|[value,label]…] (select), min?, max? (number),
//                 value? — initial value override, for params the page aliases
//                 (the display maps bare ?test=1 onto the 'running' scenario) }
// An empty value means "leave the param off the URL".

const STYLE = `
.dbg-btn {
  position: fixed; z-index: 900;
  left: calc(0.5rem + env(safe-area-inset-left));
  bottom: calc(2.1rem + env(safe-area-inset-bottom)); /* clears the build badge */
  width: 2.1rem; height: 2.1rem; padding: 0;
  border: 2px solid var(--hairline); border-radius: 50%;
  background: var(--surface); color: var(--ink-3);
  font-size: 1.05rem; line-height: 1; cursor: pointer;
  opacity: 0.35; transition: opacity 0.15s ease;
}
.dbg-btn:hover, .dbg-btn:focus-visible, .dbg-btn.is-open { opacity: 1; }
.dbg-btn.is-active { opacity: 0.9; color: var(--brand); border-color: var(--brand); }
.dbg-panel {
  position: fixed; z-index: 901;
  left: calc(0.5rem + env(safe-area-inset-left));
  bottom: calc(4.6rem + env(safe-area-inset-bottom));
  width: min(21rem, calc(100vw - 1rem));
  max-height: calc(100vh - 6.5rem); overflow: auto;
  background: var(--surface); border-radius: var(--r-sm);
  box-shadow: var(--shadow-card);
  padding: 0.8rem 0.9rem;
  font-family: var(--font-body); font-size: 0.8rem; color: var(--ink);
  text-align: left;
}
.dbg-panel h3 {
  margin: 0 0 0.6rem; font-family: var(--font-display);
  font-size: 0.95rem; font-weight: 600; color: var(--ink);
}
.dbg-row { margin-bottom: 0.55rem; }
.dbg-row label { display: block; font-weight: 800; margin-bottom: 0.15rem; }
.dbg-row select, .dbg-row input[type="number"] {
  width: 100%; padding: 0.3rem 0.45rem;
  background: var(--surface-2); border: 2px solid var(--hairline);
  border-radius: 8px; color: var(--ink);
  font: inherit; font-weight: 700;
}
.dbg-row--check label { display: flex; align-items: center; gap: 0.45rem; cursor: pointer; }
.dbg-row--check input { width: 1rem; height: 1rem; accent-color: var(--brand); }
.dbg-hint { margin-top: 0.15rem; font-size: 0.7rem; font-weight: 600; color: var(--ink-3); }
.dbg-url {
  margin: 0.6rem 0; padding: 0.4rem 0.5rem;
  background: var(--surface-2); border-radius: 8px;
  font-family: ui-monospace, monospace; font-size: 0.68rem; color: var(--ink-2);
  word-break: break-all;
}
.dbg-btns { display: flex; gap: 0.5rem; }
.dbg-btns .btn { flex: 1; padding: 0.45rem 0.6rem; font-size: 0.8rem; }
`;

export function initDebugMenu(fields) {
  const current = new URLSearchParams(location.search);
  const initial = (f) => f.value ?? current.get(f.key) ?? '';

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dbg-btn';
  btn.textContent = '⚙';
  btn.title = 'Debug options';
  btn.setAttribute('aria-label', 'Debug options');
  // Tint the gear whenever any debug param is live, so an accidentally-shared
  // debug URL is visible at a glance.
  if (fields.some((f) => initial(f))) btn.classList.add('is-active');

  const panel = document.createElement('div');
  panel.className = 'dbg-panel hidden';
  panel.innerHTML = '<h3>Debug</h3>';

  const controls = new Map(); // key -> input/select element
  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'dbg-row' + (f.type === 'check' ? ' dbg-row--check' : '');
    const label = document.createElement('label');
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const opt of f.options) {
        const [value, text] = Array.isArray(opt) ? opt : [opt, opt];
        const o = document.createElement('option');
        o.value = value; o.textContent = text;
        input.appendChild(o);
      }
      input.value = initial(f);
      label.textContent = f.label;
      row.append(label, input);
    } else if (f.type === 'check') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = initial(f) === '1';
      label.append(input, document.createTextNode(f.label));
      row.append(label);
    } else { // number
      input = document.createElement('input');
      input.type = 'number';
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      input.placeholder = 'default';
      input.value = initial(f);
      label.textContent = f.label;
      row.append(label, input);
    }
    if (f.hint) {
      const hint = document.createElement('div');
      hint.className = 'dbg-hint';
      hint.textContent = f.hint;
      row.append(hint);
    }
    controls.set(f.key, input);
    panel.appendChild(row);
  }

  // Live preview of the URL "Go" will load. Params outside the schema are
  // dropped on purpose — one-shot things like ?claim shouldn't stick around.
  function buildUrl() {
    const qs = new URLSearchParams();
    for (const f of fields) {
      const c = controls.get(f.key);
      const v = f.type === 'check' ? (c.checked ? '1' : '') : c.value.trim();
      if (v !== '') qs.set(f.key, v);
    }
    const s = qs.toString();
    return location.pathname + (s ? '?' + s : '');
  }

  const urlPreview = document.createElement('div');
  urlPreview.className = 'dbg-url';
  urlPreview.textContent = buildUrl();
  panel.addEventListener('input', () => { urlPreview.textContent = buildUrl(); });

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'btn btn--brand';
  go.textContent = 'Go';
  go.addEventListener('click', () => { location.href = buildUrl(); });

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn btn--ghost';
  clear.textContent = 'Clear';
  clear.addEventListener('click', () => { location.href = location.pathname; });

  const btns = document.createElement('div');
  btns.className = 'dbg-btns';
  btns.append(go, clear);
  panel.append(urlPreview, btns);

  function setOpen(open) {
    panel.classList.toggle('hidden', !open);
    btn.classList.toggle('is-open', open);
  }
  btn.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
  // Capture phase + stopPropagation: an Escape that closes the panel must not
  // also reach the page's own Escape handler (the display toggles pause on it).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) { e.stopPropagation(); setOpen(false); }
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !btn.contains(e.target)) setOpen(false);
  });

  document.body.append(btn, panel);
}
