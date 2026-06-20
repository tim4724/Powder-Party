# Powder Party

Multiplayer downhill ski racing where phones become **tilt + swipe** controllers and a
shared screen is the slope. A couch party game for 1–4 players on one display.

![4-player split-screen](artwork/splitscreen-4p.png)

**▶ [Play it live](https://powder.couch-games.com/)** · **[UI gallery](https://powder-main.couch-games.com/gallery.html)**

## The idea

The big screen renders the mountain; each player joins by scanning a QR code with their
phone and races down the piste. Everything is **eyes-free** — you watch the TV, not your
hand:

You're **tucked and fast by default** — you only touch the pad to do something deliberate:

| Input | Action |
|---|---|
| **Tilt** the phone left/right | **Carve** left/right (gyro roll) |
| *(rest — nothing)* | **Tuck** — the default: squat for speed (soft steering) |
| **Touch & hold** (anywhere) | **Brake** — sit up to scrub speed and carve hard (corners, trees) |
| **Flick in the air** (any direction) | A **trick** — the angle picks it: up = back flip, down = front, sides = spin, diagonals = cork. Land it clean for a small boost; land mid-rotation and you wash out |

There's **no jump button**: ramps **auto-launch** you when you ski over the lip — the faster you
hit it, the bigger the air.

The core loop: **rip the straights** tucked, **hold to brake** into the bends and around the
trees, **hit the ramps** for air, and **flip** off the big jumps for a
boost — but only if you have the air to finish the rotation. First skier to the bottom wins.
Short-handed lobbies are topped up with CPU skiers so a solo player still races.

A session is a **series of runs** (the host picks **3 / 5 / 7** in the lobby, default 5). Each
run scores by finish place — **4 / 3 / 2 / 1** for the four skiers, a DNF earns 0 — and the
points accumulate across the runs. Between runs the board holds the standings for a beat, then
the next run auto-starts on a fresh mountain; after the last run the **overall champion** (most
points — a CPU can win the night) takes the crown.

## Architecture

Same display-authoritative model as the sibling games (Tiny-Track-Party, HexStacker-Party):
the **display browser runs the authoritative simulation** and renders it with Three.js; the
Node server only serves static files + a QR/JSON API (no game logic, no WebSocket). Phones are
thin controllers. Game events flow display → relay → controllers over a
[Party-Sockets](https://github.com/tim4724/Party-Sockets) WebSocket relay; the hot-path
`CONTROL` input (`{s: carve, t: tuck/brake, j: up-flick edge, f: air-flick edge}`) rides a low-latency WebRTC fastlane with
relay fallback. The transport kit (`partyplug/`) and Three.js (`vendor/`) are reused verbatim
from the sibling games.

## Quick start

```bash
npm install
npm start            # http://localhost:4000  (PORT env overrides)
```

1. Open the display URL on a big screen.
2. Players scan the QR code with their phones to join.
3. The first player to join is the host: they pick the difficulty + number of runs and start
   the series from their phone.
4. Tilt to carve, touch & hold to brake, flick **any direction** in the air to trick (ramps
   launch you). First to the bottom wins each run; most points across the series wins overall.

> Phones need **HTTPS** for the tilt sensors — front the server with a tunnel or TLS cert when
> testing on real devices. The display works over plain HTTP, and a desktop keyboard fallback
> (see [No-phone preview](#no-phone-preview)) lets you test without a phone.

### No-phone preview

The display page drives itself from fake data with `?test=1&scenario=…` (no relay needed). The
⚙ button bottom-left opens a debug menu that sets every param below interactively, so you rarely
hand-build these. (The controller has no debug menu — preview its screens via the gallery or the
URL below.)

Keyboard, where a scenario lets you drive: **A/D** carve · hold **S** brake · **W** front flip ·
**Space** back flip · **Q/E** spin · **Z/C** corks.

- `/?test=1&scenario=running&players=4` — full split-screen run, CPU-driven (endless loop)
- `/?test=1&scenario=lobby` (+ roster) · `…&scenario=slope` (clean) — orbiting slope preview
- `/?test=1&scenario=results` (mid-series board; `…&over=1` → the final/champion board) ·
  `…&scenario=countdown` · `…&scenario=paused` — the other states
- `&runs=N` pins the series length (any N≥1; `runs=1` is a single run) · `&intermission=N`
  shortens the between-runs auto-advance — both honoured in live play and previews/tests
- `/?test=1&scenario=device-choice&bail=game_ended` — the chooser a phone gets on this big-screen
  page (toast reasons: `game_ended`, `room_not_found`, `game_full`)
- `/?scenario=solo` — **single player on the big screen, no phone**: a real race against a CPU
  field in a full-screen chase cell. `&players=N` sizes the field, `&seed=N` pins the mountain
  (rematches replay it), `&level=blue|red|black` sets the grade; "Play again" rolls a fresh
  mountain at the same grade.

The phone controller previews the same way, off the relay:
`/controller/index.html?scenario=playing&color=2`. Scenarios cover every screen — lobby,
countdown, `playing`/`brake`, `paused`, `finished`, the results boards (`results-series` mid-
series / `results` final host / waiting / late-joiner), late-join, and the `conn-*` relay-link
overlay states; `color` 0–7 picks the livery.

### Gallery

A no-relay preview surface that tiles every screen as a scaled iframe of the real page (each
driven by its `TestHarness`), so UI regressions are visible at a glance. Four tabs:

- `/gallery.html` — **Display**: every big-screen state (lobby → countdown → run → paused →
  results) across aspect ratios (16:9 / 21:9 / 4:3 / 1:1) and skier counts.
- `/gallery-controller.html` — **Phone**: every controller screen across device sizes,
  orientation, and "browser chrome" on/off, with a "view as" picker to preview all liveries.
- `/gallery-slopes.html` — **Slopes**: one orbiting card per slope in `shared/slopes.js`,
  with an optional centerline overlay.
- `/gallery-sounds.html` — **Sounds**: one card per SFX, played through the real
  `SlopeAudio` synth and labelled with the game event that fires it.

## Project structure

```
server/index.js   # static host + QR/JSON API (no game logic)
public/
  shared/         # wire protocol, slope catalog, theme tokens (all dependency-free)
  display/        # the big screen (authoritative) — Node-testable sim in engine/SkiEngine.js,
                  #   Three.js SceneRenderer, RunSession lifecycle, AiDriver bots, relay + lobby
  controller/     # the phone — tilt → carve, swipe → brake/trick
  gallery*        # no-relay preview gallery (Display / Phone / Slopes / Sounds)
partyplug/        # reusable party-game transport kit (served under /partyplug/)
vendor/three/     # vendored Three.js (served under /vendor/)
tests/            # SkiEngine + slope-generator unit tests (node:test)
scripts/          # headless split-screen hero-shot capture → artwork/ (Playwright)
```

## Testing

```bash
npm test          # node:test — SkiEngine physics + partyplug transport
npm run test:e2e  # Playwright — real display + phone pages over the real relay
```

The engine is THREE-free, so the unit tests feed it a lightweight centerline stub and assert the
physics: gravity descent + finish, tuck speed gain, carve-scrub, tree wipeouts, ramp auto-launch,
air flips (clean landing → boost, mid-flip → wash out, the min-air gate), ranking, and removal.

The E2E suite (`tests/e2e`) drives the REAL pages over the real relay — the display opens a live
room, controllers join by code at phone viewport, and runs are skipped with the display's
fast-forward lever. It covers the full lifecycle, late-join, same-device rejoin, and the
device-choice screen with its bail toasts. One-time setup: `npx playwright install chromium`.

## Tuning

The feel constants are starting values, grouped and commented at the top of `SkiEngine.js`
(speed/tuck/carve/jump) and `SceneRenderer.js` (camera). The slope layout — pitches, bends,
ramp + tree placement — is plain data in `shared/slopes.js`.

## Tech stack

- **Runtime:** Node.js (static host, no build step, no bundler, no framework)
- **3D:** Three.js (vendored)
- **Relay:** Party-Sockets WebSocket relay (signaling + game events) + WebRTC fastlane for input
- **Frontend:** vanilla JavaScript + ES modules
