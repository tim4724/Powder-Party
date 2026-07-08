// @ts-check
// Couch Games shell contract (Couch-Games-Controller CONTRACT.md v1): with
// ?cgv=1&cgName=… the controller skips name entry and joins as the injected
// name (never persisting it), window.CouchGames.setName renames live, and
// terminal session ends land on window.CouchGamesHost.gameEnded(reason)
// instead of the plain-browser ?bail= navigation.
const { test, expect } = require('@playwright/test');
const { createRoom, newPhone, visible } = require('./helpers');

// A shell-hosted controller: the launcher's JS interface is stubbed BEFORE the
// page boots (in the real WebView addJavascriptInterface exists pre-load).
async function shellController(context, path, name) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__cgEnded = [];
    window.CouchGamesHost = { gameEnded: (reason) => window.__cgEnded.push(String(reason)) };
  });
  await page.goto(path + '?cgv=1&cgName=' + encodeURIComponent(name));
  return page;
}

test('shell join skips name entry, renames live, and hands the end to the launcher', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);
  const phone = await newPhone(browser, baseURL);
  const ctrl = await shellController(phone, '/' + roomCode, 'Mia');

  // §1 — no name entry: straight to the lobby as cgName, with the form hidden.
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
  await ctrl.evaluate(() => window.CouchGames.setName('Zoe'));
  await expect(ctrl.locator('#me-name')).toHaveText('Zoe');
  await page.waitForFunction(() => {
    const net = /** @type {any} */ (window).__net;
    return net.roster().some((p) => p.name === 'Zoe');
  }, null, { timeout: 20000 });

  // §3 — the display closing for good is a terminal session end: exactly one
  // gameEnded('game_ended'), and the page must NOT also navigate itself (in a
  // plain browser this same goodbye redirects to the device chooser).
  await page.goto('about:blank'); // fires the display's pagehide goodbye
  await ctrl.waitForFunction(() => window.__cgEnded.length > 0, null, { timeout: 20000 });
  expect(await ctrl.evaluate(() => window.__cgEnded)).toEqual(['game_ended']);
  expect(new URL(ctrl.url()).pathname).toBe('/' + roomCode);
  await phone.close();
});

test('a stale room in the shell reports room_not_found without navigating', async ({ browser, baseURL }) => {
  const phone = await newPhone(browser, baseURL);
  const ctrl = await shellController(phone, '/E2E-no-such-room', 'Mia');
  await ctrl.waitForFunction(() => window.__cgEnded.length > 0, null, { timeout: 20000 });
  expect(await ctrl.evaluate(() => window.__cgEnded)).toEqual(['room_not_found']);
  expect(new URL(ctrl.url()).pathname).toBe('/E2E-no-such-room');
  await phone.close();
});
