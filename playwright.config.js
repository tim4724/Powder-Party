// @ts-check
// E2E suite — real pages, real relay. The webServer below boots the actual
// game server; specs open the display page (which creates a live room on
// wss://ws.couch-games.com) and join phone-viewport controller pages to it by
// room code, mirroring HexStacker-Party's E2E setup. Browsers via
// `npx playwright install chromium` (or PLAYWRIGHT_BROWSERS_PATH).
//
//   npm run test:e2e            # whole suite
//   npx playwright test late    # one spec
const { defineConfig } = require('@playwright/test');

const PORT = process.env.PW_PORT || '4150';

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // One retry absorbs a live-relay hiccup on a shared runner; a deterministic
  // failure still fails twice, so real bugs aren't masked.
  retries: 1,
  // Each test burns a real relay room, and every display page renders WebGL
  // (SwiftShader in CI — heavy). More than 2 workers starves a shared runner
  // to the point of flaky clicks and stalled load events.
  workers: 2,
  reporter: 'list',
  // Generous budgets: every join/board-flip rides the real relay, and shared
  // CI runners add seconds of latency that never show locally.
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 15000,
    // The pages talk TLS to the live relay; behind a TLS-intercepting proxy
    // (CI sandboxes / corporate networks) the chain is rewritten — accept it.
    // Local game traffic is plain http either way.
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 }, // desktop display by default; controllers resize per page
  },
  webServer: {
    command: 'node server/index.js',
    env: { ...process.env, PORT },
    port: Number(PORT),
    reuseExistingServer: false,
  },
});
