// @ts-check
// A multi-run SERIES over the real relay: the host sets a 3-run series, and the
// game plays through all three — auto-advancing between runs (no manual button) —
// landing on the overall board with a crowned champion. Runs are skipped with the
// display's own fast-forward lever (real physics, real endRun broadcast); a short
// ?intermission keeps the auto-advance wait tight.
const { test, expect } = require('@playwright/test');
const {
  createRoom, newPhone, joinController, startRun, waitForRacing, fastForwardRun, visible,
} = require('./helpers');

test('a 3-run series scores across runs and crowns an overall champion', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page, { runs: 3, intermission: 2 });

  const phone = await newPhone(browser, baseURL);
  const host = await joinController(phone, roomCode, 'Mia');
  await host.waitForSelector(visible('lobby'));
  // The host owns the series-length switch; the default preset is highlighted.
  await expect(host.locator('#runs-select')).toBeVisible();
  await expect(host.locator('#start-btn')).toHaveText(/series/i);

  // --- Run 1 of 3 → mid-series board, AUTO-ADVANCE carries it on (no button) ---
  await startRun(host, page);
  await fastForwardRun(page);
  await expect(page.locator('#results-runtag')).toHaveText('Run 1 of 3');
  await expect(page.locator('#results-champ')).toBeHidden();           // not over yet — no champion
  await expect(host.locator('#result-runtag')).toHaveText('Run 1 of 3');
  await expect(host.locator('#again-btn')).toBeHidden();               // mid-series there's no button — it auto-advances
  await waitForRacing(page);                                           // the intermission timer starts run 2 itself

  // --- Run 2 of 3 → mid-series board, AUTO-ADVANCE again ---
  await fastForwardRun(page);
  await expect(page.locator('#results-runtag')).toHaveText('Run 2 of 3');
  await expect(page.locator('#results-intermission')).toBeVisible();   // auto-advance countdown line
  await waitForRacing(page);                                           // the intermission timer starts run 3 itself

  // --- Run 3 of 3 → the OVERALL board: champion crowned, host can replay ---
  await fastForwardRun(page);
  await expect(page.locator('#results-runtag')).toHaveText(/Final standings/);
  await expect(page.locator('#results-champ')).toBeVisible();
  await expect(page.locator('#results-champ')).toContainText(/wins|Tie/);
  await expect(page.locator('#results-intermission')).toBeHidden();    // no auto-advance past the final run
  // A cumulative score rode onto every row.
  await expect(page.locator('#results-list .res__score').first()).not.toHaveText('');
  // The phone lands on the same overall board with "Play again" (a new series).
  await expect(host.locator('#result-runtag')).toHaveText(/Final standings/);
  await expect(host.locator('#again-btn')).toHaveText('Play again');

  await phone.close();
});

test('the between-runs countdown waits for the last skier across, not just the humans', async ({ page, browser, baseURL }) => {
  const roomCode = await createRoom(page, { runs: 2, intermission: 2 });
  const phone = await newPhone(browser, baseURL);
  const host = await joinController(phone, roomCode, 'Mia');
  await host.waitForSelector(visible('lobby'));
  await startRun(host, page);

  // Force the one human across the line while the CPU are still mid-slope and
  // moving: the engine reports the run NOT over, but every human is home — the
  // path where the panel goes up early. (Skiers finish when totalS crosses the
  // track length; CPU are parked near the start with speed, so they keep racing.)
  await page.evaluate(() => {
    const eng = window.__session().engine;
    for (const [id, s] of eng.skiers) {
      if (String(id).startsWith('ai-')) { s.totalS = 5; s.v = 10; }   // CPU: alive, far from home
      else { s.totalS = eng.length - 0.001; s.v = 6; }                // the human: one step from the line
    }
  });

  // The board comes up (human's home), but the series must NOT be counting down
  // yet — the CPU haven't finished, so the run isn't decided.
  await page.waitForSelector(visible('results'));
  await expect(page.locator('#results-runtag')).toHaveText('Run 1 of 2');
  await expect(page.locator('#results-intermission')).not.toContainText('Next run');
  expect(await page.evaluate(() => window.__session().engine.raceOver)).toBe(false);
  // Hold a beat and re-check: still no countdown while the CPU are out (had the
  // old bug survived, the 2s intermission would have fired by now).
  await page.waitForTimeout(2500);
  await expect(page.locator('#results-intermission')).not.toContainText('Next run');

  // Now send the CPU across too — the last one home decides the run, and the
  // countdown finally starts (then carries the series into run 2).
  await page.evaluate(() => {
    const eng = window.__session().engine;
    for (const [id, s] of eng.skiers) if (String(id).startsWith('ai-')) { s.totalS = eng.length - 0.001; s.v = 6; }
  });
  await expect(page.locator('#results-intermission')).toContainText('Next run', { timeout: 10000 });
  await waitForRacing(page); // the intermission rolls into run 2

  await phone.close();
});
