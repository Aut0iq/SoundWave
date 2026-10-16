import { PitchTracker, type PitchFrame } from '../src/dsp/pitch';

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
