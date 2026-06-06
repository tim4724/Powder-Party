# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                          # Unit tests (node:test) — SkiEngine + partyplug
node --test tests/engine.test.js  # A single unit test
npm start                         # Run the server (node server/index.js), port 4000
npm run dev                       # Run with --watch (auto-restart)
```

No browser/E2E suite. Preview the display without phones via `/?test=1&scenario=…`
(see README) — the per-page `TestHarness` drives a single screen with no relay.

## Key Rules

- **Display-authoritative:** the ski simulation (`public/display/engine/SkiEngine.js`) runs in
  the display browser, not the server. `server/index.js` serves static files + JSON endpoints
  only — no game logic, no WebSocket.
- **Engine is dependency-free / THREE-free** so Node tests can import it. It operates on the
  vector frames `centerline.sampleAt(s)` returns (`clone`/`addScaledVector`/`applyAxisAngle`/
  `cross`/`dot`). Keep it that way; the tests feed a lightweight centerline stub.
- **`(s, lat)` physics only:** every skier is glued to the slope centerline by arclength
  `totalS` + lateral offset `lat` + carve `heading`; jumps add a separate `air` height along
  the slope normal. Collisions/ramps/obstacles live in the locally-flat `(s, lat)` plane.
  The renderer reads `pose = {pos, forward, up}` from the engine and never does physics.
- **One input contract** `processInput(id, {s, t, j, f})` for humans AND CPU bots — latest-wins,
  stored not queued. `s` carve; `t` tuck 0|1 (DEFAULT 1 = tucked/fast, 0 = braking); `j` wrapping
  up-flick edge — does nothing on the snow ("flick up to jump" removed; ramps auto-launch), in the
  AIR a back-flip fallback for non-analog inputs; `f` `{n,a,m}` wrapping ANALOG air-trick flick
  (`a` = angle rad, up=+π/2: up→back, down→front, sides→spin, diagonals→cork; `m` = strength 0..1 →
  spin rate; air-only). Air tricks resolve from the display's authoritative air state.
- Browser code is ES modules; the engine is import-free (fully dependency/THREE-free, so the
  Node tests can load it on a lightweight centerline stub). Three.js is vendored
  under `vendor/three/` and served via `/vendor/`, imported through an inline importmap (the
  one script needing a CSP nonce).
- Relay/STUN URLs + the message vocabulary live in `public/shared/protocol.js` (game-side
  config, loaded as a classic `<script>` so its top-level `var`s become `window` globals the
  ES-module `Net.js` reads — the partyplug kit reads no game globals).
- `CONTROL` input rides the WebRTC fastlane (`partyplug/PartyFastlane.js`) with relay fallback;
  game events flow display → relay → controllers over the WebSocket relay.
- PartyPlug (`partyplug/`) is the reusable transport kit shared across the sibling games;
  Three.js (`vendor/`) is vendored — both live OUTSIDE `public/` and are served via route
  remaps in `server/index.js`, so update the Dockerfile + CSP when changing them.
- Slope layout is plain data in `public/shared/slopes.js`; `SlopeBuilder.js` turns it into a
  descending `Centerline`. Feel constants are starting values commented atop `SkiEngine.js`
  and `SceneRenderer.js`.
- UI reuses the shared "Sunny Circuit" tokens/kit in `public/shared/theme.css`; page CSS owns
  layout, the theme owns colour/type/surface. Fonts are self-hosted woff2 (CSP `font-src 'self'`).
```
