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

test('a silent (zombie) phone gets the reconnect QR mid-run; its next ping heals it', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);

  const phone = await newPhone(browser, baseURL);
  const host = await joinController(phone, roomCode, 'Mia');
  await host.waitForSelector(visible('lobby'));
  await startRun(host, page);
  await host.waitForSelector(visible('game'));

  // Zombie link: the socket stays open but the phone goes silent — no PING,
  // no CONTROL (a slept phone freezes both the same way). The display's
  // liveness sweep must route the seat through the normal drop path:
  // reconnect QR up, skier kept descending — NOT a forfeit.
  await host.evaluate(() => {
    const net = /** @type {*} */ (window).__net;
    net._stopPing();
    /** @type {*} */ (window).__origSend = net.send.bind(net);
    net.send = () => {};
  });
  await page.waitForSelector('.cell-reconnect', { timeout: 25000 });

  // Traffic resumes on the SAME socket — no peer_joined will ever fire, so
  // the next ping alone must heal the seat and drop the QR card.
  await host.evaluate(() => {
    const net = /** @type {*} */ (window).__net;
    net.send = /** @type {*} */ (window).__origSend;
    net._startPing();
  });
  await page.waitForSelector('.cell-reconnect', { state: 'detached', timeout: 10000 });
  await expect(host.locator('#game')).toBeVisible(); // the phone never left the run

  await phone.close();
});
