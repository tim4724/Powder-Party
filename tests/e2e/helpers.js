// @ts-check
// Shared helpers for the E2E suite. Everything here drives the REAL pages over
// the REAL relay: the display page creates a live room the moment it loads,
// controllers join it by room code — exactly like live play, no mocks. The
// local game server is booted by playwright.config.js (webServer).

const PHONE_VIEWPORT = { width: 390, height: 740 };   // trips the device-choice media query
const DISPLAY_VIEWPORT = { width: 1280, height: 720 }; // must NOT trip it

// Boot a display page and wait for its live room. Returns the room code.
async function createRoom(page) {
  await page.setViewportSize(DISPLAY_VIEWPORT); // enforce, don't assume, the config default
  await page.goto('/');
  await page.waitForFunction(() => window.__net && !!window.__net.roomCode, null, { timeout: 30000 });
  return await page.evaluate(() => window.__net.roomCode);
}

// A fresh phone: its own browser context (per-phone localStorage — a shared
// context would share the per-room clientId and the relay would treat two
// phones as one device). The stored clientId for this room is cleared ONCE per
// context (sessionStorage guard), so a page.reload() inside a spec keeps its
// identity and exercises the real same-device reconnect path.
async function newPhone(browser, baseURL) {
  const context = await browser.newContext({
    baseURL,
    viewport: PHONE_VIEWPORT,
    ignoreHTTPSErrors: true, // manual contexts don't inherit the config flag
  });
  await context.addInitScript(() => {
    const room = location.pathname.split('/').filter(Boolean)[0];
    if (!room) return;
    const key = '_powder_e2e_cleared_' + room;
    if (!sessionStorage.getItem(key)) {
      localStorage.removeItem('clientId_' + room);
      sessionStorage.setItem(key, '1');
    }
  });
  return context;
}

// Join a controller into the room: name screen → lobby/waiting (whatever the
// WELCOME routes to). Returns the page; callers assert the landing screen.
async function joinController(context, roomCode, name) {
  const page = await context.newPage();
  await page.goto('/' + roomCode);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  return page;
}

const visible = (id) => `#${id}:not(.hidden)`;

// Host presses Start; resolve once the display's engine is past GO
// (session.racing), so fastForwardRun can step it synchronously.
async function startRun(hostPage, displayPage) {
  await hostPage.click('#start-btn');
  await waitForRacing(displayPage);
}

async function waitForRacing(displayPage) {
  await displayPage.waitForFunction(() => {
    const s = window.__session && window.__session();
    return !!(s && s.racing);
  }, null, { timeout: 30000 });
}

// Skip the rest of the live run in one synchronous burst — the same lever the
// display's own test harness uses. _finish() fires the real endRun, so the
// RESULTS transition and the final STANDINGS broadcast go out exactly as in
// live play. Bots are driven so the field actually crosses the line.
async function fastForwardRun(displayPage) {
  await displayPage.evaluate(() => window.__session().fastForwardToEnd(window.__driveBots));
  await displayPage.waitForSelector(visible('results'), { timeout: 20000 });
}

module.exports = {
  createRoom, newPhone, joinController, startRun, waitForRacing, fastForwardRun,
  visible, PHONE_VIEWPORT, DISPLAY_VIEWPORT,
};
