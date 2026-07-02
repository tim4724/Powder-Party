// @ts-check
// Source-mode smoke: the rest of the suite runs against the built bundles, so
// nothing else would catch a broken dev page — a typo inside a build:scripts
// marker block (importmap JSON, a /partyplug/ src path, classic-script order)
// ships with the whole suite green and breaks `npm run dev` at runtime. This
// spec drives the second webServer (playwright.config.js, USE_BUNDLES=0) and
// stays relay-free via the TestHarness route.
const { test, expect } = require('@playwright/test');

// Resolved by playwright.config.js (PW_SRC_PORT, default PW_PORT+1) and
// exported to the worker env — read it, never re-derive.
const SRC = `http://localhost:${process.env.PW_SRC_PORT}`;

test('display page boots from raw source modules (importmap + classic scripts)', async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  // Relay-free single-screen preview — exercises the importmap (three),
  // the classic boot scripts, and the module entry, without a live room.
  await page.goto(SRC + '/?test=1&scenario=lobby');
  await page.waitForFunction(() => !!window.__session, null, { timeout: 30000 });

  // Source mode really served: the importmap survived (bundled pages swap it out).
  expect(await page.locator('script[type="importmap"]').count()).toBe(1);
  // The classic boot scripts set the window globals the module graph reads.
  const globals = await page.evaluate(() => ({
    msg: typeof window.MSG,
    party: typeof window.PartyConnection,
    flow: typeof window.RoomFlow,
    fastlane: typeof window.PartyFastlane,
  }));
  expect(globals).toEqual({ msg: 'object', party: 'function', flow: 'function', fastlane: 'function' });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('controller page serves its classic scripts un-swapped in source mode', async ({ request }) => {
  // No browser needed: joining a room would burn a live relay room. Assert the
  // served HTML kept its marker-block scripts (source mode) — the boot chain
  // the display test exercises is the same partyplug/protocol code.
  const html = await (await request.get(SRC + '/controller/index.html')).text();
  expect(html).toContain('<script src="/shared/protocol.js');
  expect(html).toContain('<script src="/partyplug/PartyConnection.js');
  expect(html).toContain('<script type="module" src="/controller/main.js');
});
