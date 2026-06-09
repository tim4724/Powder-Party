// RunSession — lifecycle manager for a single downhill run: the SkiEngine,
// countdown timer, and the run-timeout failsafe. All net/DOM/scene side-effects
// surface through callbacks; this module is pure run logic with no browser
// globals. (Adapted near-verbatim from the reference kart game's RaceSession —
// the method names + `racing` flag are kept so main.js wiring is unchanged.)
import { SkiEngine } from './engine/SkiEngine.js';

const MAX_RUN_MS = 120_000; // hard ceiling — failsafe ends a STUCK run. Generous of
                            // the ~1-min target so a slow/crashing human isn't cut off
                            // (normal runs still end the instant everyone finishes).

export class RunSession {
  constructor(players, track, opts = {}) {
    this.engine = new SkiEngine(players.map((p) => ({ id: p.peerIndex, stats: p.stats })), track, {
      onEvent: opts.onRaceEvent || (() => {}),
    });
    this.racing = false;

    this._onCountdownTick = opts.onCountdownTick || (() => {});
    this._onRaceStart     = opts.onRaceStart     || (() => {});
    this._onRaceEnd       = opts.onRaceEnd       || (() => {});

    this._countdownTimer = null;
    this._countdownN     = null;
    this._raceTimer      = null;
    this._raceDeadline   = 0;
    this._raceRemainMs   = null;
    this._ended          = false;
    this.paused          = false;
  }

  // Begin the countdown. Fires onCountdownTick(n) for n = seconds..0 (GO!) then
  // -1 (clear). The run starts ON "GO!" — racing flips and onRaceStart fires at
  // n=0 so skiers launch the instant the banner reads GO.
  startCountdown(seconds) {
    this._countdownN = seconds;
    this._onCountdownTick(this._countdownN);
    this._armCountdown();
  }

  // The ticking interval alone (no immediate announce) — shared by
  // startCountdown and a resume mid-countdown, which must pick the count back
  // up at the banked n WITHOUT re-announcing (and re-beeping) it.
  _armCountdown() {
    this._countdownTimer = setInterval(() => {
      this._countdownN -= 1;
      this._onCountdownTick(this._countdownN);
      if (this._countdownN === 0) {
        this.racing = true;
        this._onRaceStart();
        this._armRaceTimer(MAX_RUN_MS);
      } else if (this._countdownN < 0) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
        this._countdownN = null;
      }
    }, 1000);
  }

  _armRaceTimer(ms) {
    this._raceDeadline = performance.now() + ms;
    this._raceTimer = setTimeout(() => {
      this._raceTimer = null;
      if (this.racing) this._finish();
    }, ms);
  }

  // Freeze: stop timers + bank remaining time. Physics stop advancing (the caller
  // stops calling update()), so engine.elapsed/finish times don't tick while paused.
  pause() {
    if (this.paused || this._ended) return;
    this.paused = true;
    if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null; }
    if (this._raceTimer) {
      clearTimeout(this._raceTimer); this._raceTimer = null;
      this._raceRemainMs = Math.max(0, this._raceDeadline - performance.now());
    }
  }

  resume() {
    if (!this.paused || this._ended) return;
    this.paused = false;
    if (!this.racing && this._countdownN != null) {
      this._armCountdown(); // continue from the banked n (no duplicate announce)
    } else if (this.racing) {
      if (this._countdownN === 0) { this._countdownN = null; this._onCountdownTick(-1); }
      if (this._raceRemainMs != null) { this._armRaceTimer(this._raceRemainMs); this._raceRemainMs = null; }
    }
  }

  // Call from the render loop. Advances physics and fires onRaceEnd when done.
  update(dtMs) {
    if (!this.racing || this.paused) return;
    this.engine.update(dtMs);
    if (this.engine.raceOver) this._finish();
  }

  // Skip the rest of the run in one synchronous burst (real deterministic
  // physics, no rendering) when every human has finished and only CPU skiers
  // are still descending — humans shouldn't watch them crawl to the bottom.
  fastForwardToEnd(stepBots, dtMs = 1000 / 30) {
    if (!this.racing || this.paused || this._ended) return;
    let guard = 0;
    while (!this.engine.raceOver && guard++ < 100000) {
      if (stepBots) stepBots();
      this.engine.update(dtMs);
    }
    this._finish();
  }

  processInput(id, input) { this.engine.processInput(id, input); }

  forceRemoveCar(id) {
    const removed = this.engine.removeCar(id);
    if (removed && this.racing && this.engine.raceOver) this._finish();
    return removed;
  }

  // Move a still-descending skier from one id to another (a dropped player
  // reconnects on a different device → new peerIndex). Delegates to
  // SkiEngine.rekeyCar. Returns truthy if the skier existed and was moved.
  rekeyCar(oldId, newId) { return this.engine.rekeyCar(oldId, newId); }

  getSnapshot() { return this.engine.getSnapshot(); }
  getResults()  { return this.engine.getResults(); }

  dispose() {
    if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null; }
    if (this._raceTimer)      { clearTimeout(this._raceTimer);       this._raceTimer = null; }
    this._ended = true;
    this.racing = false;
    this.paused = false;
  }

  _finish() {
    if (this._ended) return;
    this._ended = true;
    this.racing = false;
    clearTimeout(this._raceTimer);
    this._raceTimer = null;
    this._onRaceEnd(this.engine.getResults());
  }
}
