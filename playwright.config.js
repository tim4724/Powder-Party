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

// NOTE: the suite binds a PORT PAIR — PW_PORT for the bundled server and
// PW_SRC_PORT (default PW_PORT+1) for the source-mode one below. Concurrent
// worktree runs must pick PW_PORTs at least 2 apart (or set PW_SRC_PORT).
const PORT = process.env.PW_PORT || '4150';
// Second server in SOURCE mode (importmap + raw modules — what `npm run dev`
// serves). Only source-mode.spec.js targets it; everything else runs bundled.
const SRC_PORT = process.env.PW_SRC_PORT || String(Number(PORT) + 1);
process.env.PW_SRC_PORT = SRC_PORT; // single source of truth — specs read this, never re-derive

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
  webServer: [
    {
      // Build first: E2E exercises the content-hashed bundles — the exact
      // artifact prod serves — not the raw source modules.
      command: 'node scripts/build.js && node server/index.js',
      env: { ...process.env, PORT },
      port: Number(PORT),
      reuseExistingServer: false,
    },
    {
      // Source mode (USE_BUNDLES=0): keeps the importmap + marker-block script
      // tags honest — a broken dev page would otherwise ship with the whole
      // bundled suite green. Exercised by source-mode.spec.js only.
      command: 'node server/index.js',
      env: { ...process.env, PORT: SRC_PORT, USE_BUNDLES: '0' },
      port: Number(SRC_PORT),
      reuseExistingServer: false,
    },
  ],
});
