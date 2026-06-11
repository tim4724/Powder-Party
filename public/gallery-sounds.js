// =====================================================================
// Sound gallery — one card per SlopeAudio SFX, played through the REAL
// synth (the game ships no audio files), so what you audition here is
// exactly what the display plays. Each card names the game event that
// fires the sound. Buttons double as the autoplay-unlock gesture.
// =====================================================================
import { SlopeAudio } from '/display/Audio.js';

const audio = new SlopeAudio();
const vol = document.getElementById('master-vol');

// Every button routes through here: the click IS the unlock gesture, but
// ctx.resume() is async — wait it out so the very first click is audible.
function play(fn) {
  audio.resume();
  const ctx = audio.ctx;
  if (!ctx) return;
  audio.master.gain.value = +vol.value;
  if (ctx.state !== 'running') ctx.resume().then(fn);
  else fn();
}
vol.addEventListener('input', () => { if (audio.master) audio.master.gain.value = +vol.value; });

const CARDS = [
  { title: 'Countdown', tag: 'run flow', desc: 'One beep per tick, then the GO sting an octave up.',
    btns: [
      ['tick', () => audio.countdown(3)],
      ['GO!', () => audio.countdown(0)],
      ['full count', () => [3, 2, 1, 0].forEach((n, i) => setTimeout(() => audio.countdown(n), i * 1000))],
    ] },
  { title: 'Finish chime', tag: 'run flow', desc: 'Four-note major arpeggio when the run is decided.',
    btns: [['play', () => audio.finish()]] },
  { title: 'Jump woosh', tag: 'engine: jump', desc: 'Rising sweep + air swell as a kicker auto-launches a skier.',
    btns: [['play', () => audio.jump()]] },
  { title: 'Trick kickoff', tag: 'engine: trick_start', desc: 'Falling whoosh as a flip or spin starts in the air.',
    btns: [['play', () => audio.trick()]] },
  { title: 'Rotation pop', tag: 'engine: trick_done', desc: 'Bright pop for each completed rotation — chains on multi-flips.',
    btns: [
      ['single', () => audio.trickLand()],
      ['triple', () => [0, 1, 2].forEach((i) => setTimeout(() => audio.trickLand(), i * 280))],
    ] },
  { title: 'Landing', tag: 'engine: land', desc: 'Thud + snow crunch. Clean is soft and bright; botched is low and harsh (also the ski-patrol reset plop).',
    btns: [
      ['clean', () => audio.land(true)],
      ['botched', () => audio.land(false)],
    ] },
  { title: 'Crash', tag: 'engine: crash', desc: 'Wipeout — tumbling body, snow burst, spray on top.',
    btns: [['play', () => audio.crash()]] },
  { title: 'Body check', tag: 'engine: bump', desc: 'Low thud for soft skier-on-skier contact.',
    btns: [['play', () => audio.bump()]] },
  { title: 'Pole clack', tag: 'renderer: pole break-off', desc: 'Edge pole snapping off its base — louder and sharper the faster the hit.',
    btns: [
      ['brush', () => audio.pole(0.35)],
      ['cruise', () => audio.pole(1)],
      ['schuss', () => audio.pole(1.4)],
    ] },
  { title: 'Carve scrape', tag: 'per-frame: off-piste / wipeout slide', desc: 'Band-passed snow hiss. Throttled to one burst per 150 ms in-game.',
    btns: [
      ['soft', () => audio.scrape(0.5)],
      ['hard', () => audio.scrape(1)],
    ] },
  { title: 'Wind drone', tag: 'per-frame: pack speed', desc: 'Looping noise bed — volume and brightness track the fastest skier. Drag to “ski”.',
    wind: true,
    btns: [['stop', () => audio.stopWind()]] },
];

const rows = document.getElementById('sound-rows');
for (const c of CARDS) {
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.innerHTML = '<span></span><span class="tag"></span>';
  title.firstChild.textContent = c.title;
  title.lastChild.textContent = c.tag;
  const desc = document.createElement('div');
  desc.className = 'sound-desc';
  desc.textContent = c.desc;
  const btns = document.createElement('div');
  btns.className = 'sound-btns';
  if (c.wind) {
    const r = document.createElement('input');
    r.type = 'range'; r.min = 0; r.max = 1; r.step = 0.01; r.value = 0;
    r.setAttribute('aria-label', 'wind level');
    r.addEventListener('input', () => play(() => { audio.startWind(); audio.setWind(+r.value); }));
    btns.appendChild(r);
  }
  for (const [label, fn] of c.btns) {
    const b = document.createElement('button');
    b.className = 'card-btn';
    b.textContent = label;
    b.addEventListener('click', () => play(fn));
    btns.appendChild(b);
  }
  card.append(title, desc, btns);
  rows.appendChild(card);
}

// Mobile ⚙ toggle (gallery-common.js owns this on the iframe pages; this page
// doesn't load common, so wire the one behaviour it needs directly).
const tog = document.getElementById('options-toggle');
tog.addEventListener('click', () => {
  const open = document.querySelector('header').classList.toggle('options-open');
  tog.setAttribute('aria-expanded', String(open));
});
