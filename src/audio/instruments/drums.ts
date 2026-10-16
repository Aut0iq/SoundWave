// Synthesised drum kit for beatbox triggers and the metronome.

export interface DrumSound {
  id: string;
  name: string;
  /** General MIDI percussion note (channel 10). */
  gmNote: number;
}

export const DRUM_SOUNDS: DrumSound[] = [
  { id: 'kick', name: 'Бочка', gmNote: 36 },
  { id: 'snare', name: 'Малый барабан', gmNote: 38 },
  { id: 'hatClosed', name: 'Хэт закрытый', gmNote: 42 },
  { id: 'hatOpen', name: 'Хэт открытый', gmNote: 46 },
  { id: 'clap', name: 'Хлопок', gmNote: 39 },
  { id: 'tomLow', name: 'Том низкий', gmNote: 45 },
  { id: 'tomHigh', name: 'Том высокий', gmNote: 50 },
  { id: 'rim', name: 'Римшот', gmNote: 37 },
  { id: 'crash', name: 'Тарелка', gmNote: 49 },
  { id: 'cowbell', name: 'Ковбелл', gmNote: 56 },
];

type Biquad = (x: number) => number;

function biquad(type: 'lowpass' | 'highpass' | 'bandpass', freq: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * freq) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  let b0: number, b1: number, b2: number;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = b0;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = b0;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

function render(id: string, sr: number): Float32Array<ArrayBuffer> {
  const rnd = rng(id.length * 977 + id.charCodeAt(0));
  const make = (sec: number) => new Float32Array(Math.round(sr * sec));
  switch (id) {
    case 'kick': {
      const out = make(0.6);
      let phase = 0;
      const click = biquad('lowpass', 3000, 0.7, sr);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        const f = 48 + 110 * Math.exp(-t * 28);
        phase += (2 * Math.PI * f) / sr;
        out[i] = Math.sin(phase) * Math.exp(-t * 6.5) + click(rnd()) * Math.exp(-t * 300) * 0.6;
      }
      return out;
    }
    case 'snare': {
      const out = make(0.35);
      const hp = biquad('highpass', 1500, 0.7, sr);
      const lp = biquad('lowpass', 9000, 0.7, sr);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        const body = (Math.sin(2 * Math.PI * 185 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t)) * Math.exp(-t * 30);
        out[i] = 0.55 * body + 0.8 * lp(hp(rnd())) * Math.exp(-t * 14);
      }
      return out;
    }
    case 'hatClosed':
    case 'hatOpen':
    case 'crash': {
      const sec = id === 'hatClosed' ? 0.09 : id === 'hatOpen' ? 0.5 : 1.8;
      const decay = id === 'hatClosed' ? 55 : id === 'hatOpen' ? 7 : 2.4;
      const out = make(sec);
      const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
      const base = id === 'crash' ? 330 : 420;
      const hp = biquad('highpass', id === 'crash' ? 4000 : 7000, 0.8, sr);
      const hp2 = biquad('highpass', id === 'crash' ? 4000 : 7000, 0.8, sr);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        let metal = 0;
        for (const r of ratios) metal += Math.sign(Math.sin(2 * Math.PI * base * r * t));
        const n = id === 'crash' ? 0.7 * rnd() + 0.08 * metal : 0.25 * rnd() + 0.15 * metal;
        out[i] = hp2(hp(n)) * Math.exp(-t * decay) * 1.2;
      }
      return out;
    }
    case 'clap': {
      const out = make(0.35);
      const bp = biquad('bandpass', 1200, 1.2, sr);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        let env = Math.exp(-Math.max(0, t - 0.03) * 18);
        for (const b of [0, 0.011, 0.022]) if (t >= b && t < b + 0.01) env = Math.max(env, Math.exp(-(t - b) * 200));
        out[i] = bp(rnd()) * env * 2.2;
      }
      return out;
    }
    case 'tomLow':
    case 'tomHigh': {
      const out = make(0.5);
      const f0 = id === 'tomLow' ? 95 : 165;
      let phase = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        phase += (2 * Math.PI * (f0 + f0 * 0.6 * Math.exp(-t * 20))) / sr;
        out[i] = Math.sin(phase) * Math.exp(-t * 8) + rnd() * 0.08 * Math.exp(-t * 60);
      }
      return out;
    }
    case 'rim': {
      const out = make(0.08);
      const bp = biquad('bandpass', 1700, 4, sr);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        out[i] = (bp(rnd()) * 3 + Math.sin(2 * Math.PI * 820 * t) * 0.5) * Math.exp(-t * 70);
      }
      return out;
    }
    case 'cowbell': {
      const out = make(0.4);
      const bp = biquad('bandpass', 800, 2, sr);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        const sq = Math.sign(Math.sin(2 * Math.PI * 540 * t)) + Math.sign(Math.sin(2 * Math.PI * 800 * t));
        out[i] = bp(sq) * Math.exp(-t * 9) * 1.4;
      }
      return out;
    }
    case 'click':
    case 'clickAccent': {
      const out = make(0.04);
      const f = id === 'clickAccent' ? 1760 : 1175;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        out[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 120);
      }
      return out;
    }
  }
  return make(0.01);
}

const cache = new Map<string, AudioBuffer>();

function buffer(id: string, sr: number): AudioBuffer {
  const key = `${id}@${sr}`;
  let buf = cache.get(key);
  if (!buf) {
    const data = render(id, sr);
    let peak = 0;
    for (const x of data) peak = Math.max(peak, Math.abs(x));
    if (peak > 0) for (let i = 0; i < data.length; i++) data[i] *= 0.8 / peak;
    buf = new AudioBuffer({ length: data.length, sampleRate: sr, numberOfChannels: 1 });
    buf.copyToChannel(data, 0);
    cache.set(key, buf);
  }
  return buf;
}

/** Plays a drum (or metronome click) one-shot. */
export function playDrum(ctx: BaseAudioContext, dest: AudioNode, id: string, velocity: number, time: number): void {
  const src = ctx.createBufferSource();
  src.buffer = buffer(id, ctx.sampleRate);
  const g = ctx.createGain();
  const v = Math.max(1, Math.min(127, velocity)) / 127;
  g.gain.value = 0.15 + 0.85 * v * v;
  src.connect(g).connect(dest);
  src.onended = () => g.disconnect();
  src.start(time);
}
