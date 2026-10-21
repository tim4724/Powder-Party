// @ts-check
// Paper Balloon shell contract (PaperBalloon-Controller CONTRACT.md v1): with
// ?pbv=1&pbName=… the controller skips name entry and joins as the injected
// name (never persisting it), window.PaperBalloon.setName renames live, terminal
// session ends land on window.PaperBalloonHost.gameEnded(reason) instead of the
// plain-browser ?bail= navigation, and backgrounding the launcher (a synthetic
// persisted `pagehide`) drops the relay socket at once.
const { test, expect } = require('@playwright/test');
const { createRoom, newPhone, visible } = require('./helpers');

// A shell-hosted controller: the launcher's JS interface is stubbed BEFORE the
// page boots (in the real WebView addJavascriptInterface / the injected iOS
// shim both exist pre-load).
async function shellController(context, path, name) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__pbEnded = [];
    window.PaperBalloonHost = { gameEnded: (reason) => window.__pbEnded.push(String(reason)) };
  });
  await page.goto(path + '?pbv=1&pbName=' + encodeURIComponent(name));
  return page;
}

test('shell join skips name entry, renames live, and hands the end to the launcher', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);
  const phone = await newPhone(browser, baseURL);
  const ctrl = await shellController(phone, '/' + roomCode, 'Mia');

  // §1 — no name entry: straight to the lobby as pbName, with the form hidden.
  await ctrl.waitForSelector(visible('lobby'));
  await expect(ctrl.locator('#me-name')).toHaveText('Mia');
  await expect(ctrl.locator('#name-form')).toBeHidden();
  // …and the injected name never lands in the game's own storage.
  expect(await ctrl.evaluate(() => localStorage.getItem('powder_name'))).toBeNull();
  await page.waitForFunction(() => {
    const net = /** @type {any} */ (window).__net;
    return !!net && net.roster().some((p) => p.name === 'Mia');
  }, null, { timeout: 20000 });

  // §2 — live rename from the launcher: local UI + broadcast to the display.
  await ctrl.evaluate(() => window.PaperBalloon.setName('Zoe'));
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
