'use strict';

// Capture a 2x2 split-screen hero shot of a 4-player run for the artwork/ dir.
//
// There's no E2E harness, but the display already renders itself in isolation
// from fake data: `/?test=1&scenario=running&players=4` stands up the real
// Three.js scene with four self-driving CPU skiers — one per livery — laid out in
// the same split-screen grid the live game uses (4 players → 2x2 on 16:9). This
// script spins up the static server, drives that page in headless Chromium at a
// 16:9 viewport, lets the run develop for a beat so the skiers fan out down the
// fall line, and screenshots the canvas to a PNG.
//
//   node scripts/capture-artwork.js                      # → artwork/splitscreen-4p.png (1920x1080)
//   node scripts/capture-artwork.js --slope powder-bowl  # pin a named slope (default: test seed)
//   node scripts/capture-artwork.js --width 2560 --height 1440 --wait 6000
//   node scripts/capture-artwork.js --out artwork/hero.png
//
// Flags (all optional): --out, --width, --height, --players, --slope, --seed,
// --scenario, --wait (ms to let the run develop before the shot), --port, --headed.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..');

// --- tiny flag parser: --key value, plus boolean --headed ---
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'headed') { out.headed = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const WIDTH = parseInt(args.width, 10) || 1920;        // 16:9 by default
const HEIGHT = parseInt(args.height, 10) || 1080;
const PLAYERS = parseInt(args.players, 10) || 4;       // 4 → 2x2 grid
const SCENARIO = args.scenario || 'running';
const WAIT_MS = parseInt(args.wait, 10) || 11000;      // let skiers get mid-slope, clear of the start gate
const PORT = parseInt(args.port, 10) || 4319;          // off the default 4000 dev port
const OUT = path.resolve(ROOT, args.out || 'artwork/splitscreen-4p.png');

function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`server never came up on :${port}`));
        else setTimeout(ping, 150);
      });
    })();
  });
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // Own static server on its own port so a running dev server isn't disturbed.
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const killServer = () => { try { server.kill('SIGTERM'); } catch (_) {} };
  process.on('exit', killServer);

  let browser;
  try {
    await waitForServer(PORT);

    browser = await chromium.launch({ headless: !args.headed });
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1, // canvas drawing buffer == WIDTHxHEIGHT (exact 16:9 PNG)
    });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });

    let url = `http://127.0.0.1:${PORT}/?test=1&scenario=${SCENARIO}&players=${PLAYERS}`;
    if (args.slope) url += `&slope=${args.slope}`;
    if (args.seed != null) url += `&seed=${args.seed}`;
    await page.goto(url, { waitUntil: 'networkidle' });

    // The harness builds the engine + scene once the slope GLBs load; wait for the
    // full field to exist (and the WebGL context to be live) before shooting.
    await page.waitForFunction((n) => {
      const s = window.__scene;
      if (!s || !s.skiers || s.skiers.size < n) return false;
      const gl = s.renderer && s.renderer.getContext && s.renderer.getContext();
      return !gl || !gl.isContextLost();
    }, PLAYERS, { timeout: 20000 });

    // HUD/name plates render with the self-hosted face — wait so text isn't a fallback.
    await page.evaluate(() => document.fonts && document.fonts.ready);

    // Let the self-driving run develop a beat so skiers fan out down the fall line
    // rather than sitting stacked at the start gate.
    await page.waitForTimeout(WAIT_MS);

    await page.screenshot({ path: OUT });
    console.log(`Captured ${PLAYERS}-player ${WIDTH}x${HEIGHT} split-screen → ${path.relative(ROOT, OUT)}`);
  } finally {
    if (browser) await browser.close();
    killServer();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
