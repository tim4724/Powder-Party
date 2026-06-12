// @ts-check
// Host lifecycle over the real relay: lobby → run → results → play again →
// new game, asserting both the big screen and the phone route correctly at
// every step. The run itself is skipped with the display's own fast-forward
// lever (real physics, real endRun broadcast).
const { test, expect } = require('@playwright/test');
const {
  createRoom, newPhone, joinController, startRun, waitForRacing, fastForwardRun, visible,
} = require('./helpers');

test('lobby → run → results → play again → new game routes every screen', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);

  const phone = await newPhone(browser, baseURL);
  const host = await joinController(phone, roomCode, 'Mia');
  await host.waitForSelector(visible('lobby'));
  await expect(host.locator('#me-name')).toHaveText('Mia');
  await expect(host.locator('#start-btn')).toBeVisible();      // first joiner is host
  await expect(page.locator('#players')).toContainText('Mia'); // display roster row

  await startRun(host, page);
  await expect(page.locator('#race')).toBeVisible();
  await host.waitForSelector(visible('game'));
  await expect(host.locator('#drive-hud')).toBeVisible();

  await fastForwardRun(page);
  await host.waitForSelector(visible('results'));
  await expect(host.locator('#again-btn')).toBeVisible();      // run over → host controls
  await expect(host.locator('#newgame-btn')).toBeVisible();

  // Play again: the rematch countdown pulls the phone straight onto the pad.
  await host.click('#again-btn');
  await waitForRacing(page);
  await host.waitForSelector(visible('game'));

  // New game from the next board: everyone back to the lobby.
  await fastForwardRun(page);
  await host.waitForSelector(visible('results'));
  await host.click('#newgame-btn');
  await host.waitForSelector(visible('lobby'));
  await expect(page.locator('#lobby')).toBeVisible();

  await phone.close();
});

test('the results board folds to the lobby when every racer has left', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);

  const phone = await newPhone(browser, baseURL);
  const host = await joinController(phone, roomCode, 'Mia');
  await host.waitForSelector(visible('lobby'));
  await startRun(host, page);
  await fastForwardRun(page);
  await host.waitForSelector(visible('results'));

  // The back gesture is an intentional leave (MSG.LEAVE — the seat is freed
  // outright, no reconnect grace). The only human who raced is gone, so the
  // board is orphaned — nobody left on it can restart it — and the display
  // folds back to its lobby front door (releaseOrphanedResults).
  await host.goBack();
  await host.waitForSelector(visible('name'));
  await expect(page.locator('#lobby')).toBeVisible();
  await expect(page.locator('#results')).toBeHidden();

  await phone.close();
});
