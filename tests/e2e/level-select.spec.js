// @ts-check
// Run difficulty (Blue/Red/Black) over the real relay. The pick is HOST-ONLY: the
// host owns the switch from their phone, the display is authoritative (it re-rolls
// the previewed mountain + repaints the TV switch), and every OTHER phone shows no
// switch at all — the big screen tells the room the tier. WELCOME still carries the
// tier so a late joiner who is later promoted to host lands on the right one. A tier
// changes only the mountain — physics are identical, so there's nothing to assert
// about the run itself.
const { test, expect } = require('@playwright/test');
const { createRoom, newPhone, joinController, visible } = require('./helpers');

const seg = (id) => `#level-seg button[data-level="${id}"]`;

test('host picks Black: the display re-rolls; a non-host phone never sees the switch', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);

  // Default tier before anyone touches it: Blue on both the TV switch and the
  // generated mountain. (The big screen runs the SAME segmented switch as a phone.)
  await expect(page.locator(seg('blue'))).toHaveClass(/is-active/);
  expect(await page.evaluate(() => window.__slope.def.level)).toBe('blue');

  const hostPhone = await newPhone(browser, baseURL);
  const host = await joinController(hostPhone, roomCode, 'Mia');
  await host.waitForSelector(visible('lobby'));

  const guestPhone = await newPhone(browser, baseURL);
  const guest = await joinController(guestPhone, roomCode, 'Theo');
  await guest.waitForSelector(visible('lobby'));

  // Only the HOST sees the switch (live, Blue active). The guest sees none.
  await expect(host.locator('#level-select')).toBeVisible();
  await expect(host.locator(seg('blue'))).toHaveClass(/is-active/);
  await expect(host.locator(seg('black'))).toBeEnabled();
  await expect(guest.locator('#level-select')).toBeHidden();

  // The pick: host taps Black.
  await host.click(seg('black'));

  // Display is authoritative — the previewed mountain re-rolls to the new tier
  // and the TV switch repaints. (idle lobby → makeSlope re-runs with level=black.)
  await page.waitForFunction(() => window.__slope && window.__slope.def.level === 'black', null, { timeout: 10000 });
  await expect(page.locator(seg('black'))).toHaveClass(/is-active/);
  await expect(page.locator(seg('blue'))).not.toHaveClass(/is-active/);

  // The host's optimistic highlight stuck; the guest still sees no switch.
  await expect(host.locator(seg('black'))).toHaveClass(/is-active/);
  await expect(guest.locator('#level-select')).toBeHidden();

  await hostPhone.close();
  await guestPhone.close();
});

test('a late joiner inherits the tier via WELCOME — shown only once they become host', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);

  const hostPhone = await newPhone(browser, baseURL);
  const host = await joinController(hostPhone, roomCode, 'Mia');
  await host.waitForSelector(visible('lobby'));

  // Host sets Black BEFORE the late phone exists — so the only way the joiner can
  // learn the tier is the WELCOME level field (not a live LEVEL_UPDATE).
  await host.click(seg('black'));
  await page.waitForFunction(() => window.__slope && window.__slope.def.level === 'black', null, { timeout: 10000 });

  const latePhone = await newPhone(browser, baseURL);
  const late = await joinController(latePhone, roomCode, 'Zoe');
  await late.waitForSelector(visible('lobby'));

  // A non-host sees no difficulty switch at all.
  await expect(late.locator('#level-select')).toBeHidden();

  // Host leaves → Zoe inherits the host seat. Her switch now appears, landing on
  // Black: proof she cached the tier from WELCOME (she never saw the live pick).
  await host.goBack();
  await host.waitForSelector(visible('name'));
  await late.waitForSelector(visible('lobby'));
  await expect(late.locator('#start-btn')).toBeVisible();
  await expect(late.locator('#level-select')).toBeVisible();
  await expect(late.locator(seg('black'))).toHaveClass(/is-active/);

  await hostPhone.close();
  await latePhone.close();
});

test('the big-screen switch is live: a tap on the display sets the room tier', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);

  const phone = await newPhone(browser, baseURL);
  const host = await joinController(phone, roomCode, 'Theo');
  await host.waitForSelector(visible('lobby'));
  // Theo is the lone (host) phone, but the pick is driven from the BIG SCREEN here.
  await expect(host.locator(seg('blue'))).toHaveClass(/is-active/);

  // Click the display's own Black segment (the display is authoritative — its
  // switch routes straight into setLevel, no phone involved).
  await page.click(seg('black'));

  // The mountain re-rolls and the broadcast reaches the host's phone, which mirrors it.
  await page.waitForFunction(() => window.__slope && window.__slope.def.level === 'black', null, { timeout: 10000 });
  await expect(page.locator(seg('black'))).toHaveClass(/is-active/);
  await expect(host.locator(seg('black'))).toHaveClass(/is-active/);

  await phone.close();
});
