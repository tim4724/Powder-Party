// @ts-check
// Paper Balloon shell contract (PaperBalloon-Controller CONTRACT.md v1): with
// window.PaperBalloonHost present the controller skips name entry and joins as
// PaperBalloonHost.name (never persisting it), renames through editName(),
// offers a close that calls leave(), lands terminal session ends on
// gameEnded(reason) instead of the plain-browser ?bail= navigation, turns
// system back off while the run's touch-pad is up, and drops the relay socket
// at once when the launcher is backgrounded (a synthetic persisted `pagehide`).
const { test, expect } = require('@playwright/test');
const { createRoom, newPhone, startRun, visible } = require('./helpers');

// A shell-hosted controller: the launcher's JS interface is stubbed BEFORE the
// page boots (the real launchers define it at document start). Every call is
// recorded; editName() resolves with the next name queued in __pbNextName.
async function shellController(context, path, name) {
  const page = await context.newPage();
  await page.addInitScript((initialName) => {
    let current = initialName;
    window.__pbEnded = [];
    window.__pbLeft = 0;
    window.__pbBack = [];
    window.__pbNextName = null;
    window.PaperBalloonHost = {
      get name() { return current; },
      editName: () => Promise.resolve(window.__pbNextName).then((n) => { if (n) current = n; return n; }),
      gameEnded: (reason) => window.__pbEnded.push(String(reason)),
      leave: () => { window.__pbLeft++; },
      setBackMode: (mode) => window.__pbBack.push(String(mode)),
    };
  }, name);
  await page.goto(path);
  return page;
}
const lastBackMode = (ctrl) => ctrl.evaluate(() => window.__pbBack[window.__pbBack.length - 1]);

test('shell join skips name entry, renames live, and hands the end to the launcher', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);
  const phone = await newPhone(browser, baseURL);
  const ctrl = await shellController(phone, '/' + roomCode, 'Mia');

  // §1 — no name entry: straight to the lobby as PaperBalloonHost.name, with the form hidden.
  await ctrl.waitForSelector(visible('lobby'));
  await expect(ctrl.locator('#me-name')).toHaveText('Mia');
  await expect(ctrl.locator('#name-form')).toBeHidden();
  // …and the injected name never lands in the game's own storage.
  expect(await ctrl.evaluate(() => localStorage.getItem('powder_name'))).toBeNull();
  await page.waitForFunction(() => {
    const net = /** @type {any} */ (window).__net;
    return !!net && net.roster().some((p) => p.name === 'Mia');
  }, null, { timeout: 20000 });

  // §3 + §9 — the lobby offers the way out, and back there leaves the game.
  await expect(ctrl.locator('#pb-close')).toBeVisible();
  expect(await lastBackMode(ctrl)).toBe('leave');

  // §2 — rename through the launcher's sheet: a dismissal changes nothing…
  await ctrl.click('#rename-btn');
  await expect(ctrl.locator('#me-name')).toHaveText('Mia');
  // …a saved name updates the local UI + broadcasts to the display.
  await ctrl.evaluate(() => { window.__pbNextName = 'Zoe'; });
  await ctrl.click('#rename-btn');
  await expect(ctrl.locator('#me-name')).toHaveText('Zoe');
  await page.waitForFunction(() => {
    const net = /** @type {any} */ (window).__net;
    return net.roster().some((p) => p.name === 'Zoe');
  }, null, { timeout: 20000 });

  // §3 — the display closing for good is a terminal session end: exactly one
  // gameEnded('game_ended'), and the page must NOT also navigate itself (in a
  // plain browser this same goodbye redirects to the device chooser).
  await page.goto('about:blank'); // fires the display's pagehide goodbye
  await ctrl.waitForFunction(() => window.__pbEnded.length > 0, null, { timeout: 20000 });
  expect(await ctrl.evaluate(() => window.__pbEnded)).toEqual(['game_ended']);
  expect(new URL(ctrl.url()).pathname).toBe('/' + roomCode);
  await phone.close();
});

test('a stale room in the shell reports room_not_found without navigating', async ({ browser, baseURL }) => {
  const phone = await newPhone(browser, baseURL);
  const ctrl = await shellController(phone, '/E2E-no-such-room', 'Mia');
  await ctrl.waitForFunction(() => window.__pbEnded.length > 0, null, { timeout: 20000 });
  expect(await ctrl.evaluate(() => window.__pbEnded)).toEqual(['room_not_found']);
  expect(new URL(ctrl.url()).pathname).toBe('/E2E-no-such-room');
  await phone.close();
});

// §7 — backgrounding the launcher (home / app switch / lock) arrives as a
// synthetic persisted `pagehide`; returning is the engine's own
// visibilitychange → visible. The display must see the seat go the moment the
// player leaves — not whenever the OS eventually freezes the socket — and see
// it come back on return, with no session end reported to the launcher.
test('backgrounding the launcher drops the seat at once, and returning takes it back', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);
  const phone = await newPhone(browser, baseURL);
  const ctrl = await shellController(phone, '/' + roomCode, 'Mia');
  await ctrl.waitForSelector(visible('lobby'));
  await page.waitForFunction(() => {
    const net = /** @type {any} */ (window).__net;
    return !!net && net.roster().some((p) => p.name === 'Mia');
  }, null, { timeout: 20000 });

  await ctrl.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  // A lobby drop frees the seat outright (mid-run it would be held behind the
  // reconnect QR) — either way the display stops counting us as present.
  await page.waitForFunction(() => {
    const net = /** @type {any} */ (window).__net;
    return net.roster().every((p) => p.name !== 'Mia');
  }, null, { timeout: 20000 });

  await ctrl.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => {
    const net = /** @type {any} */ (window).__net;
    return net.roster().some((p) => p.name === 'Mia');
  }, null, { timeout: 20000 });
  await ctrl.waitForSelector(visible('lobby'));
  // A background is not a session end — the launcher was told nothing.
  expect(await ctrl.evaluate(() => window.__pbEnded)).toEqual([]);
  await phone.close();
});

// §9 + §3 — mid-run the whole screen is the touch-pad, so system back is off and
// the close button is out of the way (it surfaces behind the pause overlay);
// back in the lobby back leaves again. The close itself hands the exit to the
// launcher and frees the seat on the display at once, without navigating.
test('system back is off during a run, and the close button leaves', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);
  const phone = await newPhone(browser, baseURL);
  const ctrl = await shellController(phone, '/' + roomCode, 'Mia');
  await ctrl.waitForSelector(visible('lobby'));
  expect(await lastBackMode(ctrl)).toBe('leave');

  await startRun(ctrl, page);
  await ctrl.waitForSelector(visible('game'));
  expect(await lastBackMode(ctrl)).toBe('off');
  await expect(ctrl.locator('#pb-close')).toBeHidden();

  await ctrl.click('#pause-btn');
  await expect(ctrl.locator('#pause-overlay')).toBeVisible();
  await expect(ctrl.locator('#pb-close')).toBeVisible();
  expect(await lastBackMode(ctrl)).toBe('off'); // still the run's screen
  await ctrl.waitForTimeout(900);               // the overlay's anti-misclick guard
  await ctrl.click('#pause-newgame');
  await ctrl.waitForSelector(visible('lobby'));
  expect(await lastBackMode(ctrl)).toBe('leave');

  await ctrl.click('#pb-close');
  expect(await ctrl.evaluate(() => window.__pbLeft)).toBe(1);
  await page.waitForFunction(() => {
    const net = /** @type {any} */ (window).__net;
    return net.roster().every((p) => p.name !== 'Mia');
  }, null, { timeout: 20000 });
  expect(await ctrl.evaluate(() => window.__pbEnded)).toEqual([]);
  expect(new URL(ctrl.url()).pathname).toBe('/' + roomCode);
  await phone.close();
});

// An Android WebView too old for document-start scripts has the host bridge but
// no name: the player types one as in a browser, and the shell exits still apply.
test('a shell without a name falls back to name entry', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);
  const phone = await newPhone(browser, baseURL);
  const ctrl = await shellController(phone, '/' + roomCode, undefined);
  await expect(ctrl.locator('#name-form')).toBeVisible();
  await expect(ctrl.locator('#pb-close')).toBeVisible();
  await ctrl.fill('#name-input', 'Ola');
  await ctrl.click('#join-btn');
  await ctrl.waitForSelector(visible('lobby'));
  await expect(ctrl.locator('#me-name')).toHaveText('Ola');
  expect(await lastBackMode(ctrl)).toBe('leave');
  await phone.close();
});
