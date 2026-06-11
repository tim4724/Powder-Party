// SlopeAudio — all sound for the big screen, synthesized with Web Audio (no
// asset files). A wind/ski-hiss drone whose brightness + volume track the pack's
// speed, plus discrete SFX (countdown, carve scrape, jump woosh, landing thud,
// finish). Browsers require a user gesture to start audio — call resume() from a
// click/key on the display. (Adapted from the reference kart RaceAudio.)
export class SlopeAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.wind = null;
    this.noiseBuf = null;
    this._lastScrape = 0;
  }

  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    const n = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, n, n);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  resume() { this._ensure(); if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  get ready() { return this.ctx && this.ctx.state === 'running'; }

  // ---- wind / ski-hiss drone (level 0..1) ----
  startWind() {
    this._ensure();
    if (!this.ctx || this.wind) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.7;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(bp); bp.connect(gain); gain.connect(this.master);
    src.start();
    this.wind = { src, bp, gain };
  }
  setWind(level) {
    if (!this.wind || !this.ctx) return;
    const t = this.ctx.currentTime, l = Math.max(0, Math.min(1, level));
    this.wind.bp.frequency.setTargetAtTime(380 + l * 1500, t, 0.08);
    this.wind.gain.gain.setTargetAtTime(0.02 + l * 0.13, t, 0.08);
  }
  stopWind() {
    if (!this.wind || !this.ctx) return;
    const w = this.wind, t = this.ctx.currentTime;
    try { w.gain.gain.setTargetAtTime(0, t, 0.15); w.src.stop(t + 0.5); } catch (_) {}
    this.wind = null;
  }

  // ---- one-shot SFX ----
  // While the context is still locked (no user gesture yet) one-shots are DROPPED,
  // not scheduled: currentTime is frozen at 0 while suspended, so queued tones
  // would all pile onto the same instant and fire as one burst on unlock.
  _tone(freq, dur, vol, type = 'square', delay = 0, freqTo = null) {
    this._ensure();
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (freqTo != null) o.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
    const g = ctx.createGain();
    o.connect(g); g.connect(this.master);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.03);
  }

  // Band-passed noise burst — the snow texture under landings, crashes, scrapes.
  _noise(freq, q, dur, vol, delay = 0) {
    this._ensure();
    if (!this.ready || !this.noiseBuf) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = ctx.createGain();
    src.connect(bp); bp.connect(g); g.connect(this.master);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.start(t); src.stop(t + dur + 0.05);
  }

  // ±pct random pitch wobble for SFX that fire often (land/bump/scrape), so a
  // busy pack doesn't machine-gun the identical sample. Rhythm cues (countdown,
  // finish) stay fixed-pitch on purpose — wobble there would read as a mistake.
  _vary(freq, pct = 0.08) { return freq * (1 + (Math.random() * 2 - 1) * pct); }

  countdown(n) { if (n > 0) this._tone(440, 0.18, 0.3, 'square'); else this._tone(880, 0.5, 0.4, 'sawtooth'); }
  finish() { [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 0.3, 0.35, 'triangle', i * 0.12)); }
  jump() {                                                          // rising woosh + air swell
    this._tone(this._vary(300, 0.04), 0.28, 0.28, 'sine', 0, 760);
    this._noise(900, 0.8, 0.3, 0.06);
  }
  trick() { this._tone(this._vary(520, 0.04), 0.22, 0.22, 'triangle', 0, 240); }     // falling whoosh as a flip kicks off
  trickLand() { this._tone(this._vary(660), 0.12, 0.26, 'triangle', 0, 990); }       // bright pop per completed rotation
  land(clean) {                                                     // thud + snow crunch
    this._tone(this._vary(clean ? 150 : 110), 0.16, clean ? 0.26 : 0.3, clean ? 'sine' : 'square');
    this._noise(clean ? 1600 : 700, 1.1, clean ? 0.12 : 0.22, clean ? 0.07 : 0.12);
  }
  crash() {                                                         // wipeout: tumbling body + snow burst + spray
    this._tone(this._vary(140), 0.35, 0.32, 'square', 0, 55);
    this._noise(500, 0.9, 0.45, 0.16);
    this._noise(2200, 1.4, 0.25, 0.08, 0.05);
  }
  bump() { this._tone(this._vary(90, 0.12), 0.07, 0.14, 'square'); } // low, short body-check thud
  pole(kick = 1) {                                                  // slalom-pole clack — louder + sharper with impact speed
    const v = Math.min(1, 0.45 + 0.55 * kick);
    this._tone(this._vary(740, 0.1), 0.06, 0.22 * v, 'square', 0, 320);
    this._noise(2800, 1.8, 0.07, 0.12 * v);
  }

  // carve scrape: short noise burst, throttled so it doesn't machine-gun.
  scrape(intensity = 1) {
    const now = performance.now();
    if (now - this._lastScrape < 150) return;
    this._lastScrape = now;
    this._noise(this._vary(2400, 0.15), 1.4, 0.2, 0.1 * Math.max(0.3, Math.min(1, intensity)));
  }

  // One mapping from engine race events to SFX, shared by the live display
  // (main.js) and the no-relay TestHarness so previews sound like real runs.
  raceEvent(e) {
    if (e.type === 'jump') this.jump();
    else if (e.type === 'trick_start') this.trick();
    else if (e.type === 'trick_done') this.trickLand();
    else if (e.type === 'land') this.land(!!e.clean);
    else if (e.type === 'crash') this.crash();
    else if (e.type === 'bump') this.bump();
    else if (e.type === 'reset') this.land(false); // ski-patrol plop back onto the piste
  }
}
