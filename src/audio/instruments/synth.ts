// Built-in instruments synthesised on the fly: work offline, no downloads.

import { midiToFreq } from '../../dsp/music';
import type { Instrument, LoadState, Voice } from './types';

// ---------------------------------------------------------------------------
// Pre-rendered tones (plucked and struck instruments), cached per note.

const bufferCache = new Map<string, AudioBuffer>();

function cachedBuffer(key: string, sr: number, render: () => Float32Array): AudioBuffer {
  const k = `${key}@${sr}`;
  let buf = bufferCache.get(k);
  if (!buf) {
    const data = render();
    buf = new AudioBuffer({ length: data.length, sampleRate: sr, numberOfChannels: 1 });
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    bufferCache.set(k, buf);
  }
  return buf;
}

/** Deterministic noise so cached tones are reproducible. */
function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

function normalise(out: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]));
  if (max > 0) {
    const g = peak / max;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}

function fadeOut(out: Float32Array, sr: number, seconds: number): void {
  const n = Math.min(out.length, Math.round(sr * seconds));
  for (let i = 0; i < n; i++) out[out.length - n + i] *= 1 - i / n;
}

interface PluckOptions {
  /** Seconds for the fundamental to decay by 60 dB. */
  t60: number;
  /** 0..1, brightness of the excitation. */
  brightness: number;
  /** Relative pluck position along the string (comb filter). */
  position: number;
  seconds: number;
}

/** Karplus-Strong string with fractional-delay tuning. */
export function renderPluck(sr: number, freq: number, o: PluckOptions, seed = 1): Float32Array {
  const len = Math.round(sr * o.seconds);
  const out = new Float32Array(len);
  const period = sr / freq;
  let D = period - 0.5; // the two-point average adds half a sample of delay
  let Di = Math.floor(D);
  let frac = D - Di;
  if (frac < 0.1) {
    Di -= 1;
    frac += 1;
  }
  const C = (1 - frac) / (1 + frac);
  const line = new Float32Array(Di);
  const rnd = noise(seed);

  // Excitation: one period of lowpassed noise with a pluck-position comb, DC removed.
  const ex = new Float32Array(Di);
  const lp = 0.15 + 0.8 * o.brightness;
  let y = 0;
  for (let i = 0; i < Di; i++) {
    y += lp * (rnd() - y);
    ex[i] = y;
  }
  const comb = Math.max(1, Math.round(o.position * Di));
  for (let i = Di - 1; i >= comb; i--) ex[i] -= ex[i - comb];
  let mean = 0;
  for (let i = 0; i < Di; i++) mean += ex[i];
  mean /= Di;
  for (let i = 0; i < Di; i++) line[i] = ex[i] - mean;

  const g = Math.pow(10, -3 / (o.t60 * freq));
  let p = 0;
  let prev = 0;
  let apX = 0;
  let apY = 0;
  for (let n = 0; n < len; n++) {
    const yd = line[p];
    const avg = 0.5 * (yd + prev);
    prev = yd;
    const ap = C * avg + apX - C * apY;
    apX = avg;
    apY = ap;
    const v = g * ap;
    line[p] = v;
    p = p + 1 === Di ? 0 : p + 1;
    out[n] = yd;
  }
  fadeOut(out, sr, 0.05);
  return normalise(out, 0.6);
}

/** Additive piano: inharmonic partials, two-stage decay, detuned string pair, hammer noise. */
export function renderPiano(sr: number, midi: number): Float32Array {
  const f0 = midiToFreq(midi);
  const t60 = Math.max(0.6, 14 * Math.pow(2, -(midi - 21) / 17));
  const seconds = Math.min(6, Math.max(1.2, t60 * 0.55));
  const len = Math.round(sr * seconds);
  const out = new Float32Array(len);
  const B = Math.min(0.002, 0.00012 * Math.pow(2, (midi - 40) / 16));
  const maxPartial = Math.max(2, Math.min(18, Math.floor(9000 / f0)));

  for (const detune of [1, 1.0007]) {
    for (let n = 1; n <= maxPartial; n++) {
      const fn = n * f0 * detune * Math.sqrt(1 + B * n * n);
      if (fn > sr * 0.45) break;
      const amp = (1 / Math.pow(n, 1.15)) * Math.exp(-(n - 1) * 0.12) * (n === 1 ? 1 : 0.9);
      const tau = t60 / 6.91 / (1 + 0.06 * n * n);
      const d1 = Math.exp(-1 / (sr * tau * 0.22));
      const d2 = Math.exp(-1 / (sr * tau));
      const w = (2 * Math.PI * fn) / sr;
      const c = Math.cos(w);
      const s = Math.sin(w);
      let x = 0;
      let yv = 1;
      let e1 = 0.65 * amp;
      let e2 = 0.35 * amp;
      for (let i = 0; i < len; i++) {
        out[i] += x * (e1 + e2);
        const nx = x * c + yv * s;
        yv = yv * c - x * s;
        x = nx;
        e1 *= d1;
        e2 *= d2;
      }
    }
  }
  // Hammer thump.
  const rnd = noise(midi * 7919);
  const hammerLen = Math.round(sr * 0.012);
  let h = 0;
  for (let i = 0; i < hammerLen; i++) {
    h += 0.3 * (rnd() - h);
    out[i] += h * 0.25 * (1 - i / hammerLen);
  }
  // Soft attack to avoid clicks.
  const atk = Math.round(sr * 0.002);
  for (let i = 0; i < atk; i++) out[i] *= i / atk;
  fadeOut(out, sr, 0.15);
  return normalise(out, 0.55);
}

function envelopeGain(ctx: BaseAudioContext, bus: AudioNode, time: number, peak: number, attack: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, time);
  g.gain.linearRampToValueAtTime(peak, time + attack);
  g.connect(bus);
  return g;
}

function velocityGain(velocity: number): number {
  const v = Math.max(1, Math.min(127, velocity)) / 127;
  return 0.15 + 0.85 * v * v;
}

class BufferInstrument implements Instrument {
  readonly group = 'synth' as const;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly gmProgram: number,
    private readonly render: (sr: number, midi: number) => Float32Array,
    private readonly release: number,
    private readonly makeBus: (ctx: BaseAudioContext, dest: AudioNode) => AudioNode = (_c, d) => d,
    private readonly level = 1,
  ) {}

  state(): LoadState {
    return 'ready';
  }

  async load(): Promise<void> {}

  createBus(ctx: BaseAudioContext, dest: AudioNode): AudioNode {
    return this.makeBus(ctx, dest);
  }

  play(ctx: BaseAudioContext, bus: AudioNode, midi: number, velocity: number, time: number, duration?: number): Voice {
    const sr = ctx.sampleRate;
    const buf = cachedBuffer(`${this.id}:${midi}`, sr, () => this.render(sr, midi));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1200 + (velocity / 127) * 9000;
    tone.Q.value = 0.3;
    const g = envelopeGain(ctx, bus, time, velocityGain(velocity) * this.level, 0.003);
    src.connect(tone).connect(g);
    src.start(time);
    const release = this.release;
    let stopped = false;
    const voice: Voice = {
      stop(t: number) {
        if (stopped) return;
        stopped = true;
        const at = Math.max(t, time + 0.01);
        g.gain.cancelScheduledValues(at);
        g.gain.setTargetAtTime(0, at, release / 4);
        src.stop(at + release + 0.05);
      },
      bend(cents: number, t: number) {
        src.detune.setTargetAtTime(cents, t, 0.01);
      },
    };
    src.onended = () => g.disconnect();
    if (duration !== undefined) voice.stop(time + duration);
    return voice;
  }
}

// ---------------------------------------------------------------------------
// Oscillator-based sustained instruments.

interface OscPatch {
  waves: { type: OscillatorType | 'organ'; detune: number; gain: number; octave?: number }[];
  attack: number;
  release: number;
  cutoff: number;
  cutoffVel: number;
  q: number;
  vibratoRate: number;
  vibratoCents: number;
  vibratoDelay: number;
  breath?: number;
  /** Filter envelope: cutoff multiplier at the start decaying to 1. */
  filterEnv?: number;
  sustainLevel?: number;
  decay?: number;
}

const organWaves = new WeakMap<BaseAudioContext, PeriodicWave>();
function organWave(ctx: BaseAudioContext): PeriodicWave {
  let w = organWaves.get(ctx);
  if (!w) {
    // Drawbars 16' 8' 5 1/3' 4' 2 2/3' 2' -> harmonics relative to the 16' sub.
    const real = new Float32Array(17);
    const imag = new Float32Array(17);
    const bars: [number, number][] = [[1, 0.6], [2, 1], [3, 0.7], [4, 0.6], [6, 0.35], [8, 0.4], [16, 0.15]];
    for (const [h, a] of bars) imag[h] = a;
    w = ctx.createPeriodicWave(real, imag);
    organWaves.set(ctx, w);
  }
  return w;
}

let noiseBuffer: AudioBuffer | null = null;
function whiteNoise(sr: number): AudioBuffer {
  if (!noiseBuffer || noiseBuffer.sampleRate !== sr) {
    const len = sr * 2;
    noiseBuffer = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: 1 });
    const d = noiseBuffer.getChannelData(0);
    const rnd = noise(12345);
    for (let i = 0; i < len; i++) d[i] = rnd();
  }
  return noiseBuffer;
}

class OscInstrument implements Instrument {
  readonly group = 'synth' as const;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly gmProgram: number,
    private readonly patch: OscPatch,
    private readonly makeBus: (ctx: BaseAudioContext, dest: AudioNode) => AudioNode = (_c, d) => d,
  ) {}

  state(): LoadState {
    return 'ready';
  }

  async load(): Promise<void> {}

  createBus(ctx: BaseAudioContext, dest: AudioNode): AudioNode {
    return this.makeBus(ctx, dest);
  }

  play(ctx: BaseAudioContext, bus: AudioNode, midi: number, velocity: number, time: number, duration?: number): Voice {
    const p = this.patch;
    const freq = midiToFreq(midi);
    const vel = velocity / 127;
    const peak = velocityGain(velocity) * 0.32;
    const out = envelopeGain(ctx, bus, time, peak, p.attack);
    if (p.decay && p.sustainLevel !== undefined) {
      out.gain.setTargetAtTime(peak * p.sustainLevel, time + p.attack, p.decay / 3);
    }
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const cutoff = Math.min(18000, p.cutoff + p.cutoffVel * vel);
    filter.Q.value = p.q;
    if (p.filterEnv) {
      filter.frequency.setValueAtTime(Math.min(18000, cutoff * p.filterEnv), time);
      filter.frequency.setTargetAtTime(cutoff, time + 0.01, 0.15);
    } else {
      filter.frequency.value = cutoff;
    }
    filter.connect(out);

    // Shared pitch control: vibrato LFO and live bend both drive `detune` of every oscillator.
    const pitch = ctx.createConstantSource();
    pitch.offset.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = p.vibratoRate;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.setValueAtTime(0, time);
    lfoDepth.gain.linearRampToValueAtTime(0, time + p.vibratoDelay);
    lfoDepth.gain.linearRampToValueAtTime(p.vibratoCents, time + p.vibratoDelay + 0.4);
    lfo.connect(lfoDepth);

    const sources: AudioScheduledSourceNode[] = [pitch, lfo];
    for (const w of p.waves) {
      const osc = ctx.createOscillator();
      if (w.type === 'organ') osc.setPeriodicWave(organWave(ctx));
      else osc.type = w.type;
      osc.frequency.value = freq * Math.pow(2, w.octave ?? 0);
      osc.detune.value = w.detune;
      pitch.connect(osc.detune);
      lfoDepth.connect(osc.detune);
      const g = ctx.createGain();
      g.gain.value = w.gain;
      osc.connect(g).connect(filter);
      sources.push(osc);
    }
    if (p.breath) {
      const n = ctx.createBufferSource();
      n.buffer = whiteNoise(ctx.sampleRate);
      n.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = Math.min(12000, freq * 2);
      bp.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.value = p.breath;
      n.connect(bp).connect(g).connect(filter);
      sources.push(n);
    }
    for (const s of sources) s.start(time);

    let stopped = false;
    const voice: Voice = {
      stop(t: number) {
        if (stopped) return;
        stopped = true;
        const at = Math.max(t, time + 0.01);
        out.gain.cancelScheduledValues(at);
        out.gain.setTargetAtTime(0, at, p.release / 4);
        for (const s of sources) s.stop(at + p.release + 0.05);
      },
      bend(cents: number, t: number) {
        pitch.offset.setTargetAtTime(cents, t, 0.01);
      },
    };
    sources[sources.length - 1].onended = () => out.disconnect();
    if (duration !== undefined) voice.stop(time + duration);
    return voice;
  }
}

// ---------------------------------------------------------------------------
// Effect buses.

function distortionCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

function guitarBody(ctx: BaseAudioContext, dest: AudioNode): AudioNode {
  const input = ctx.createGain();
  const low = ctx.createBiquadFilter();
  low.type = 'peaking';
  low.frequency.value = 110;
  low.Q.value = 1.2;
  low.gain.value = 4;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 220;
  mid.Q.value = 1.4;
  mid.gain.value = 3;
  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 4000;
  air.gain.value = -3;
  input.connect(low).connect(mid).connect(air).connect(dest);
  return input;
}

function ampBus(ctx: BaseAudioContext, dest: AudioNode): AudioNode {
  const input = ctx.createGain();
  input.gain.value = 2.5;
  const shaper = ctx.createWaveShaper();
  shaper.curve = distortionCurve(5);
  shaper.oversample = '4x';
  const cab = ctx.createBiquadFilter();
  cab.type = 'lowpass';
  cab.frequency.value = 4200;
  cab.Q.value = 0.9;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 90;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 1600;
  presence.gain.value = 4;
  const out = ctx.createGain();
  out.gain.value = 0.35;
  input.connect(hp).connect(shaper).connect(presence).connect(cab).connect(out).connect(dest);
  return input;
}

function bassBus(ctx: BaseAudioContext, dest: AudioNode): AudioNode {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2200;
  lp.connect(dest);
  return lp;
}

// ---------------------------------------------------------------------------

export function createSynthInstruments(): Instrument[] {
  return [
    new BufferInstrument('syn-piano', 'Пианино', 0, renderPiano, 0.25),
    new BufferInstrument(
      'syn-guitar',
      'Акустическая гитара',
      25,
      (sr, m) => renderPluck(sr, midiToFreq(m), { t60: Math.max(1.2, 5 * Math.pow(2, -(m - 40) / 24)), brightness: 0.6, position: 0.13, seconds: 3.5 }, m),
      0.12,
      guitarBody,
      1.6,
    ),
    new BufferInstrument(
      'syn-egtr',
      'Электрогитара (перегруз)',
      29,
      (sr, m) => renderPluck(sr, midiToFreq(m), { t60: 6, brightness: 0.8, position: 0.2, seconds: 4 }, m),
      0.08,
      ampBus,
    ),
    new BufferInstrument(
      'syn-bass',
      'Бас-гитара',
      33,
      (sr, m) => renderPluck(sr, midiToFreq(m), { t60: 3.5, brightness: 0.3, position: 0.25, seconds: 3 }, m),
      0.08,
      bassBus,
      1.8,
    ),
    new OscInstrument('syn-strings', 'Струнные', 48, {
      waves: [
        { type: 'sawtooth', detune: -7, gain: 0.4 },
        { type: 'sawtooth', detune: 6, gain: 0.4 },
        { type: 'sawtooth', detune: 0, gain: 0.3, octave: -1 },
      ],
      attack: 0.18, release: 0.45, cutoff: 1800, cutoffVel: 3500, q: 0.6,
      vibratoRate: 5.3, vibratoCents: 9, vibratoDelay: 0.25,
    }),
    new OscInstrument('syn-flute', 'Флейта', 73, {
      waves: [
        { type: 'sine', detune: 0, gain: 0.9 },
        { type: 'triangle', detune: 0, gain: 0.15, octave: 1 },
      ],
      attack: 0.07, release: 0.18, cutoff: 5000, cutoffVel: 3000, q: 0.5,
      vibratoRate: 4.8, vibratoCents: 7, vibratoDelay: 0.3, breath: 0.08,
    }),
    new OscInstrument('syn-organ', 'Орган', 16, {
      waves: [{ type: 'organ', detune: 0, gain: 1.1, octave: -1 }],
      attack: 0.01, release: 0.08, cutoff: 9000, cutoffVel: 0, q: 0.3,
      vibratoRate: 6.5, vibratoCents: 4, vibratoDelay: 0,
    }),
    new OscInstrument('syn-lead', 'Синт-лид', 81, {
      waves: [
        { type: 'sawtooth', detune: -9, gain: 0.45 },
        { type: 'sawtooth', detune: 9, gain: 0.45 },
        { type: 'square', detune: 0, gain: 0.25, octave: -1 },
      ],
      attack: 0.008, release: 0.15, cutoff: 1400, cutoffVel: 4000, q: 4,
      vibratoRate: 5.5, vibratoCents: 6, vibratoDelay: 0.35, filterEnv: 3.5,
    }),
    new OscInstrument('syn-pad', 'Мягкий пэд', 89, {
      waves: [
        { type: 'sawtooth', detune: -14, gain: 0.3 },
        { type: 'sawtooth', detune: 13, gain: 0.3 },
        { type: 'triangle', detune: 0, gain: 0.4, octave: -1 },
        { type: 'sine', detune: 3, gain: 0.3, octave: 1 },
      ],
      attack: 0.6, release: 1.2, cutoff: 900, cutoffVel: 1500, q: 0.8,
      vibratoRate: 0.4, vibratoCents: 6, vibratoDelay: 0,
    }),
    new OscInstrument('syn-bass-synth', 'Синт-бас', 38, {
      waves: [
        { type: 'sawtooth', detune: 0, gain: 0.5 },
        { type: 'square', detune: 0, gain: 0.4, octave: -1 },
      ],
      attack: 0.005, release: 0.08, cutoff: 500, cutoffVel: 1500, q: 6,
      vibratoRate: 5, vibratoCents: 0, vibratoDelay: 0, filterEnv: 5, sustainLevel: 0.7, decay: 0.3,
    }),
  ];
}
