// @ts-check
// The late-join flow end to end: a phone joining a LIVE run parks on the
// "run in progress" screen (never a dead game pad), trails the final board as
// an unranked "next run" row on every screen, and is folded into the rematch.
const { test, expect } = require('@playwright/test');
const {
  createRoom, newPhone, joinController, startRun, waitForRacing, fastForwardRun, visible,
} = require('./helpers');

test('mid-run joiner waits, lands on the boards as "next run", and rides the rematch', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page);

  const hostPhone = await newPhone(browser, baseURL);
  const host = await joinController(hostPhone, roomCode, 'Mia');
  await host.waitForSelector(visible('lobby'));
  await startRun(host, page);

  // Joins while the run is live → the waiting screen, not the pad or lobby.
  const latePhone = await newPhone(browser, baseURL);
  const late = await joinController(latePhone, roomCode, 'Zoe');
  await late.waitForSelector(visible('waiting'));
  await expect(late.locator('.waiting-pill')).toContainText('Run in progress');
  await expect(late.locator('#waiting-name')).toHaveText('Zoe');
  await expect(late.locator('#game')).toBeHidden(); // run broadcasts are gated off

  await fastForwardRun(page);

  // Late joiner's own board: their unranked row + the host wait note, no host controls.
  await late.waitForSelector(visible('results'));
  const lateRow = late.locator('#result-list li.is-joining');
  await expect(lateRow).toHaveCount(1);
  await expect(lateRow).toContainText('Zoe (You)');
  await expect(lateRow).toContainText('next run');
  await expect(late.locator('#again-btn')).toBeHidden();
  await expect(late.locator('#result-wait')).toBeVisible();

  // The racer's board and the big screen carry the queued row too.
  await host.waitForSelector(visible('results'));
  await expect(host.locator('#result-list li.is-joining')).toContainText('Zoe');
  const displayRow = page.locator('#results-list li.res--joining');
  await expect(displayRow).toContainText('Zoe');
  await expect(displayRow).toContainText('next run');

  // Rematch: startRun rebuilds the field from the roster → the joiner's phone
  // flips onto the pad and their skier is really in the new run.
  await host.click('#again-btn');
  await waitForRacing(page);
  await late.waitForSelector(visible('game'));
  await expect(late.locator('#drive-hud')).toBeVisible();
  const humanSkiers = await page.evaluate(() => {
    const ids = [...window.__session().engine.skiers.keys()];
    return ids.filter((id) => typeof id === 'number').length;
  });
  expect(humanSkiers).toBe(2);

  await hostPhone.close();
  await latePhone.close();
});
