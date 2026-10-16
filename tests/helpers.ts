import { PitchTracker, type PitchFrame } from '../src/dsp/pitch';
import { midiToFreq } from '../src/dsp/music';

export const SR = 48000;

export function sine(freq: number, seconds: number, sr = SR, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** Band-limited, voice-like harmonic tone following a per-sample frequency curve. */
export function tone(freqAt: (t: number) => number, seconds: number, sr = SR, amp = 0.4): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const f = freqAt(i / sr);
    if (f <= 0) {
      out[i] = 0;
      continue;
    }
    phase += (2 * Math.PI * f) / sr;
    let s = 0;
    for (let h = 1; h <= 12 && h * f < sr / 2.2; h++) s += Math.sin(phase * h) / (h * 1.2);
    out[i] = amp * 0.5 * s;
  }
  return out;
}

export function track(signal: Float32Array, sr = SR, chunk = 512): PitchFrame[] {
  const t = new PitchTracker(sr);
  const frames: PitchFrame[] = [];
  for (let i = 0; i < signal.length; i += chunk) t.push(signal.subarray(i, i + chunk), (f) => frames.push(f));
  return frames;
}

export function medianFreq(frames: PitchFrame[]): number {
  const f = frames.filter((x) => x.freq > 0).map((x) => x.freq).sort((a, b) => a - b);
  return f[f.length >> 1] ?? 0;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/** A held, imperfectly sung note. `centre` may sit between semitones. */
export function realVoice(centre: number, seconds: number, seed = 1, vibrato = 0.4): Float32Array {
  const rnd = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  let phase = 0;
  let jitter = 0;
  let dip = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    if (i % 48 === 0) jitter = 0.97 * jitter + 0.03 * rnd() * 2.2; // ~10-15 cent random walk
    const vib = t > 0.3 ? vibrato * Math.sin(2 * Math.PI * 5.5 * t) : 0;
    const drift = 0.12 * Math.sin(2 * Math.PI * 0.4 * t);
    const f = midiToFreq(centre + vib + drift + jitter * 0.12);
    phase += (2 * Math.PI * f) / SR;
    // Formant-ish spectrum with a 2nd harmonic louder than the fundamental.
    const amps = [0.8, 1.1, 0.7, 0.35, 0.3, 0.2, 0.12, 0.08];
    let s = 0;
    for (let h = 0; h < amps.length; h++) s += amps[h] * Math.sin(phase * (h + 1));
    // Breathy level dips every ~0.7 s lasting ~45 ms.
    if (i % Math.round(0.7 * SR) === Math.round(0.35 * SR)) dip = Math.round(0.045 * SR);
    const level = dip-- > 0 ? 0.25 : 1;
    const attack = Math.min(1, t / 0.08);
    out[i] = 0.12 * attack * level * (s * (1 + 0.05 * rnd())) + 0.004 * rnd();
  }
  return out;
}

