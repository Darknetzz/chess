// Tiny WebAudio-synthesised sound effects (no audio assets needed).

let ctx = null;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(ac, out, { freq, start = 0, dur = 0.08, type = 'triangle', gain = 1, slide = 0 }) {
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(ac, out, { start = 0, dur = 0.06, gain = 1, freq = 1800 }) {
  const t0 = ac.currentTime + start;
  const len = Math.ceil(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(out);
  src.start(t0);
}

const SOUNDS = {
  move: (ac, out) => {
    noise(ac, out, { dur: 0.05, gain: 1.6, freq: 1400 });
    tone(ac, out, { freq: 220, dur: 0.06, gain: 0.35, slide: 0.7 });
  },
  capture: (ac, out) => {
    noise(ac, out, { dur: 0.09, gain: 2.2, freq: 900 });
    tone(ac, out, { freq: 160, dur: 0.1, type: 'square', gain: 0.18, slide: 0.6 });
  },
  check: (ac, out) => {
    tone(ac, out, { freq: 880, dur: 0.09, gain: 0.35 });
    tone(ac, out, { freq: 1175, start: 0.09, dur: 0.12, gain: 0.35 });
  },
  end: (ac, out) => {
    [523, 659, 784, 1047].forEach((f, i) => tone(ac, out, { freq: f, start: i * 0.11, dur: 0.22, gain: 0.3 }));
  },
};

/** Play a named sound ('move' | 'capture' | 'check' | 'end') at volume 0–100. */
export function play(name, volume = 60) {
  if (volume <= 0 || !SOUNDS[name]) return;
  const ac = audio();
  if (!ac) return;
  const out = ac.createGain();
  out.gain.value = (volume / 100) * 0.5;
  out.connect(ac.destination);
  SOUNDS[name](ac, out);
}
