// @ts-check
// Same-device rejoin paths through WELCOME: a reload mid-run resumes the pad
// (the seat is held, inRun=true), and a reload during RESULTS lands straight
// on the board (WELCOME carries the final standings, not a misleading lobby).
const { test, expect } = require('@playwright/test');
const {
  createRoom, newPhone, joinController, startRun, fastForwardRun, visible,
} = require('./helpers');

test('reload mid-run resumes the pad; reload during results lands on the board', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);

  const phone = await newPhone(browser, baseURL);
  const host = await joinController(phone, roomCode, 'Mia');
  await host.waitForSelector(visible('lobby'));
  await startRun(host, page);
  await host.waitForSelector(visible('game'));

  // Same-device reconnect mid-run: same clientId → same seat, skier still live.
  await host.reload();
  await expect(host.locator('#name-input')).toHaveValue('Mia'); // prefilled from the first join
  await host.click('#join-btn');
  await host.waitForSelector(visible('game'));
  await expect(host.locator('#drive-hud')).toBeVisible();

  // Run over → reload again: the WELCOME hands over the final standings.
  await fastForwardRun(page);
  await host.waitForSelector(visible('results'));
  await host.reload();
  await host.click('#join-btn');
  await host.waitForSelector(visible('results'));
  await expect(host.locator('#result-list li').first()).toBeVisible();

  await phone.close();
});
