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
  retries: 0,
  // Each test burns a real relay room — keep local parallelism friendly.
  workers: process.env.CI ? 4 : 2,
  reporter: 'list',
  timeout: 90000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 5000,
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
