# Powder Party

Multiplayer downhill ski racing where phones become **tilt + swipe** controllers and a
shared screen is the slope. A couch party game for 1–4 players on one display.

## The idea

The big screen renders the mountain; each player joins by scanning a QR code with their
phone and races down the piste. Everything is **eyes-free** — you watch the TV, not your
hand:

| Input | Action |
|---|---|
| **Tilt** the phone left/right | **Carve** left/right (gyro roll) |
| **Swipe down & hold** | **Tuck** — squat for speed (but you can't carve hard while tucked) |
| **Release the tuck** / **swipe up** at a ramp lip | **Jump** — a timed lip pop for a launch + bonus |
| **Swipe up** on open snow | Quick **hop** (clears a tree) |

The core loop: **tuck the steep straights** to build speed, **stand up to carve** the bends
and dodge the trees, and **pop right at the ramp lips** for the biggest air (just rolling over a
ramp still launches you, only smaller). First skier to the bottom wins. Short-handed lobbies are
topped up with CPU skiers so a solo player still races.

## Architecture

Same display-authoritative model as the sibling games (Tiny-Track-Party, HexStacker-Party):
the **display browser runs the authoritative simulation** and renders it with Three.js; the
Node server only serves static files + a QR/JSON API (no game logic, no WebSocket). Phones are
thin controllers. Game events flow display → relay → controllers over a
[Party-Sockets](https://github.com/tim4654/Party-Sockets) WebSocket relay; the hot-path
`CONTROL` input (`{s: carve, t: tuck, j: jumpSeq}`) rides a low-latency WebRTC fastlane with
relay fallback. The transport kit (`partyplug/`) and Three.js (`vendor/`) are reused verbatim
from the sibling games.

## Quick start

```bash
npm install
npm start            # http://localhost:4000  (PORT env overrides)
```

1. Open the display URL on a big screen.
2. Players scan the QR code with their phones to join.
3. The first player to join is the host and starts the run from their phone.
4. Tilt to carve, swipe down to tuck, release at a ramp to jump. First to the bottom wins.

> Phones need **HTTPS** for the tilt sensors — front the server with a tunnel or TLS cert when
> testing on real devices. The display works over plain HTTP, and desktop keyboard fallback
> (A/D carve · S tuck · ↑/Space jump) lets you test without a phone.

### No-phone preview

The display page drives itself from fake data with `?test=1&scenario=…` (no relay needed):

- `/?test=1&scenario=running&players=4` — full split-screen run, CPU-driven (endless loop)
- `/?test=1&scenario=results` — the results board
- `/?test=1&scenario=lobby` — orbiting slope preview + fake roster
- `/?test=1&scenario=slope` — clean orbiting slope preview, CPU field (no overlays)
- `/?test=1&scenario=countdown` · `…&scenario=paused`

The phone controller previews a single screen the same way, off the relay:
`/controller/index.html?scenario=playing&color=2` (scenarios: `name`, `name-connecting`,
`lobby-host`, `lobby-waiting`, `countdown`, `playing`, `tuck`, `air`, `paused`, `finished`,
`results`; `color` 0–7 picks the livery).

### Gallery

A no-relay preview surface that tiles every screen as a scaled iframe of the real page (each
driven by its `TestHarness`), so UI regressions are visible at a glance. Three tabs:

- `/gallery.html` — **Display**: every big-screen state (lobby → countdown → run → paused →
  results) across aspect ratios (16:9 / 21:9 / 4:3 / 1:1) and skier counts.
- `/gallery-controller.html` — **Phone**: every controller screen across device sizes,
  orientation, and "browser chrome" on/off, with a "view as" picker to preview all liveries.
- `/gallery-slopes.html` — **Slopes**: one orbiting card per slope in `shared/slopes.js`,
  with an optional centerline overlay.

## Project structure

```
server/index.js            # static host + QR/JSON API (no game logic)
public/
  shared/protocol.js       # wire contract (MSG vocabulary, livery palette) — classic <script>
  shared/slopes.js         # slope catalog (dependency-free data)
  shared/theme.css         # shared design tokens + component kit
  display/                 # the big screen (authoritative)
    engine/SkiEngine.js    #   pure ribbon-follow ski sim (Node-testable, no THREE)
    SlopeBuilder.js        #   procedural descending centerline from slope pieces
    Centerline.js          #   open Catmull-Rom path sampler
    RunSession.js          #   lifecycle (countdown / run / finish / pause)
    AiDriver.js            #   pure-pursuit CPU skiers
    SceneRenderer.js       #   Three.js slope + skiers + split-screen chase cams
    Audio.js               #   Web-Audio wind / carve / jump SFX
    Net.js, main.js        #   relay + lobby + game loop
    TestHarness.js         #   no-relay preview scenarios
  controller/              # the phone (tilt + swipe)
    TiltInput.js           #   gyro → carve
    SwipeInput.js          #   swipe-down-hold → tuck, release → jump
    Net.js, main.js, ui.js
  gallery*.{html,js}       # no-relay preview gallery (Display / Phone / Slopes tabs)
  gallery.css              #   shared gallery chrome
partyplug/                 # reusable party-game transport kit (served under /partyplug/)
vendor/three/              # vendored Three.js (served under /vendor/)
tests/engine.test.js       # SkiEngine unit tests (node:test)
```

## Testing

```bash
npm test     # node:test — SkiEngine physics + partyplug transport
```

The engine is THREE-free so the unit tests feed it a lightweight centerline stub and assert on
the physics: gravity descent + finish, the tuck speed gain, carve-scrub, tree wipeouts,
crouch-release jumps, ramp auto-launch, ranking, and skier removal.

## Tuning

The feel constants are starting values, grouped and commented at the top of `SkiEngine.js`
(speed/tuck/carve/jump) and `SceneRenderer.js` (camera). The slope layout — pitches, bends,
ramp + tree placement — is plain data in `shared/slopes.js`.

## Tech stack

- **Runtime:** Node.js (static host, no build step, no bundler, no framework)
- **3D:** Three.js (vendored)
- **Relay:** Party-Sockets WebSocket relay (signaling + game events) + WebRTC fastlane for input
- **Frontend:** vanilla JavaScript + ES modules
