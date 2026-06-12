// @ts-check
// The device-choice screen and its bail toasts: phones landing on the display
// URL get the chooser; terminal join errors (stale room via the pre-join HTTP
// probe, full room) navigate there with an allow-listed reason toast.
const { test, expect } = require('@playwright/test');
const { createRoom, newPhone, joinController, visible } = require('./helpers');

test('a stale room link bails to the device chooser with a toast', async ({ browser, baseURL }) => {
  const phone = await newPhone(browser, baseURL);
  const page = await phone.newPage();
  // Valid code shape, no such room — the boot-time relay probe 404s and bails
  // before the player ever types a name.
  await page.goto('/E2E-no-such-room');
  await page.waitForURL((u) => u.pathname === '/', { timeout: 20000, waitUntil: 'domcontentloaded' });
  await expect(page.locator('#device-choice')).toBeVisible();
  await expect(page.locator('#dc-toast')).toHaveText('Room not found — that game has ended.');
  await phone.close();
});

test('phone on the display URL: chooser shows, continue dismisses, back restores', async ({ browser, baseURL }) => {
  const phone = await newPhone(browser, baseURL);
  const page = await phone.newPage();
  await page.goto('/');
  await expect(page.locator('#device-choice')).toBeVisible();
  await page.click('#dc-continue');
  await expect(page.locator('#device-choice')).toBeHidden();
  await expect(page.locator('#lobby')).toBeVisible(); // this phone IS the display now
  await page.goBack();                                // the dismissal pushed a history entry
  await expect(page.locator('#device-choice')).toBeVisible();
  await phone.close();
});

test('closing the big screen bails joined phones out at once', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);
  const phone = await newPhone(browser, baseURL);
  const ctrl = await joinController(phone, roomCode, 'Mia');
  await ctrl.waitForSelector(visible('lobby'));
  // Navigating the display away fires its pagehide goodbye (DISPLAY_CLOSED).
  // The 20s ceiling proves the phone takes the instant exit, not the 30s
  // display-gone fallback timer.
  await page.goto('about:blank');
  await ctrl.waitForURL((u) => u.pathname === '/', { timeout: 20000, waitUntil: 'domcontentloaded' });
  await expect(ctrl.locator('#device-choice')).toBeVisible();
  await expect(ctrl.locator('#dc-toast')).toHaveText('The game has ended.');
  await phone.close();
});

test('the fifth phone bails out of a full room', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);
  const phones = [];
  for (let i = 0; i < 4; i++) {
    const phone = await newPhone(browser, baseURL);
    phones.push(phone);
    const ctrl = await joinController(phone, roomCode, 'P' + (i + 1));
    await ctrl.waitForSelector(visible('lobby'));
  }
  // Display + 4 phones fill the relay room: the fifth phone's boot probe reads
  // it as full and bails before the name screen is even usable.
  const fifth = await newPhone(browser, baseURL);
  phones.push(fifth);
  const p5 = await fifth.newPage();
  await p5.goto('/' + roomCode);
  await p5.waitForURL((u) => u.pathname === '/', { timeout: 20000, waitUntil: 'domcontentloaded' });
  await expect(p5.locator('#device-choice')).toBeVisible();
  await expect(p5.locator('#dc-toast')).toHaveText('That room is full.');
  for (const phone of phones) await phone.close();
});
