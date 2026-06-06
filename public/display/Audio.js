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
  _tone(freq, dur, vol, type = 'square', delay = 0, freqTo = null) {
    this._ensure();
    if (!this.ctx) return;
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

  countdown(n) { if (n > 0) this._tone(440, 0.18, 0.3, 'square'); else this._tone(880, 0.5, 0.4, 'sawtooth'); }
  finish() { [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 0.3, 0.35, 'triangle', i * 0.12)); }
  jump() { this._tone(300, 0.28, 0.28, 'sine', 0, 760); }          // rising woosh
  trick() { this._tone(520, 0.22, 0.22, 'triangle', 0, 240); }     // falling whoosh as a flip kicks off
  trickLand() { this._tone(660, 0.12, 0.26, 'triangle', 0, 990); } // bright pop per completed rotation
  land(clean) { this._tone(clean ? 150 : 110, 0.16, 0.3, clean ? 'sine' : 'square'); } // thud
  bump() { this._tone(90, 0.07, 0.14, 'square'); }                 // low, short body-check thud

  // carve scrape: short band-passed noise burst, throttled so it doesn't machine-gun.
  scrape(intensity = 1) {
    this._ensure();
    if (!this.ctx || !this.noiseBuf) return;
    const now = performance.now();
    if (now - this._lastScrape < 150) return;
    this._lastScrape = now;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 1.4;
    const g = ctx.createGain();
    src.connect(bp); bp.connect(g); g.connect(this.master);
    const v = 0.1 * Math.max(0.3, Math.min(1, intensity));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    src.start(t); src.stop(t + 0.24);
  }
}
