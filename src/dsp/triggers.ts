// Vocal-percussion ("beatbox") triggers: onset detection + spectral features + k-NN
// classification against examples the user records for each pad.

const FFT_SIZE = 512;
const BANDS = 20;

/** In-place radix-2 FFT. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Mel-spaced band edges (in FFT bins) for the given sample rate. */
function bandEdges(sr: number): number[] {
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const inv = (m: number) => 700 * (Math.pow(10, m / 2595) - 1);
  const lo = mel(40);
  const hi = mel(Math.min(16000, sr / 2));
  const edges: number[] = [];
  for (let i = 0; i <= BANDS; i++) {
    const f = inv(lo + ((hi - lo) * i) / BANDS);
    edges.push(Math.max(1, Math.min(FFT_SIZE / 2, Math.round((f / sr) * FFT_SIZE))));
  }
  for (let i = 1; i < edges.length; i++) if (edges[i] <= edges[i - 1]) edges[i] = edges[i - 1] + 1;
  return edges;
}

/**
 * Feature vector of a percussive hit: log band energies of two consecutive short frames
 * (attack and body), mean-removed so loudness does not dominate, plus zero-crossing rate.
 */
export function hitFeatures(samples: Float32Array, sr: number): Float32Array {
  const edges = bandEdges(sr);
  const feat = new Float32Array(BANDS * 2 + 1);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  for (let frame = 0; frame < 2; frame++) {
    re.fill(0);
    im.fill(0);
    const off = frame * (FFT_SIZE / 2);
    for (let i = 0; i < FFT_SIZE; i++) {
      const x = samples[off + i] ?? 0;
      re[i] = x * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
    }
    fft(re, im);
    let mean = 0;
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = edges[b]; k < Math.min(edges[b + 1], FFT_SIZE / 2); k++) e += re[k] * re[k] + im[k] * im[k];
      const v = Math.log10(e / Math.max(1, edges[b + 1] - edges[b]) + 1e-10);
      feat[frame * BANDS + b] = v;
      mean += v;
    }
    mean /= BANDS;
    for (let b = 0; b < BANDS; b++) feat[frame * BANDS + b] -= mean;
  }
  let zc = 0;
  const n = Math.min(samples.length, FFT_SIZE * 1.5);
  for (let i = 1; i < n; i++) if ((samples[i] >= 0) !== (samples[i - 1] >= 0)) zc++;
  feat[BANDS * 2] = (zc / n) * 10;
  return feat;
}

/** Samples needed after an onset before a hit can be classified. */
export const HIT_LENGTH = FFT_SIZE * 1.5;

function distance(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

export interface Classification {
  pad: number;
  distance: number;
}

export class HitClassifier {
  private examples: { pad: number; feat: Float32Array }[] = [];

  add(pad: number, feat: Float32Array): void {
    this.examples.push({ pad, feat });
  }

  clear(pad?: number): void {
    this.examples = pad === undefined ? [] : this.examples.filter((e) => e.pad !== pad);
  }

  count(pad: number): number {
    return this.examples.filter((e) => e.pad === pad).length;
  }

  size(): number {
    return this.examples.length;
  }

  /** k-NN vote weighted by inverse distance; null when nothing is trained. */
  classify(feat: Float32Array, k = 3): Classification | null {
    if (!this.examples.length) return null;
    const scored = this.examples.map((e) => ({ pad: e.pad, d: distance(e.feat, feat) })).sort((a, b) => a.d - b.d);
    const top = scored.slice(0, Math.min(k, scored.length));
    const votes = new Map<number, number>();
    for (const s of top) votes.set(s.pad, (votes.get(s.pad) ?? 0) + 1 / (s.d + 1e-3));
    let pad = top[0].pad;
    let best = -1;
    for (const [p, v] of votes) if (v > best) [pad, best] = [p, v];
    const nearest = top.find((s) => s.pad === pad)!.d;
    return { pad, distance: nearest };
  }

  toJSON(): { pad: number; feat: number[] }[] {
    return this.examples.map((e) => ({ pad: e.pad, feat: [...e.feat] }));
  }

  load(data: { pad: number; feat: number[] }[]): void {
    this.examples = data.map((d) => ({ pad: d.pad, feat: Float32Array.from(d.feat) }));
  }
}

export interface OnsetOptions {
  /** Minimum level (linear RMS) of a hit. */
  threshold: number;
  /** Required jump over the recent background level. */
  ratio: number;
  /** Dead time after a hit, seconds. */
  refractory: number;
}

export interface Hit {
  /** Absolute sample index of the onset. */
  pos: number;
  samples: Float32Array;
  rms: number;
}

/**
 * Streaming onset detector on short-window energy. When an onset is found, it collects
 * HIT_LENGTH samples (with a little pre-roll) and emits them for classification.
 */
export class OnsetDetector {
  private readonly win: number;
  private readonly history: Float32Array;
  private histPos = 0;
  private total = 0;
  private acc = 0;
  private accN = 0;
  private background = 1e-4;
  private lastHit = -Infinity;
  private capture: { pos: number; buf: Float32Array; fill: number; peak: number } | null = null;
  private readonly preRoll: number;

  constructor(private readonly sr: number, public opts: OnsetOptions) {
    this.win = Math.round(sr * 0.003);
    this.preRoll = Math.round(sr * 0.004);
    this.history = new Float32Array(4096);
  }

  push(input: Float32Array, onHit: (hit: Hit) => void): void {
    const H = this.history.length;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      this.history[this.histPos] = x;
      this.histPos = (this.histPos + 1) % H;
      const pos = this.total++;

      if (this.capture) {
        const c = this.capture;
        c.buf[c.fill++] = x;
        c.peak = Math.max(c.peak, Math.abs(x));
        if (c.fill === c.buf.length) {
          let e = 0;
          for (let j = 0; j < c.buf.length; j++) e += c.buf[j] * c.buf[j];
          onHit({ pos: c.pos, samples: c.buf, rms: Math.sqrt(e / c.buf.length) });
          this.capture = null;
        }
      }

      this.acc += x * x;
      if (++this.accN < this.win) continue;
      const rms = Math.sqrt(this.acc / this.accN);
      this.acc = 0;
      this.accN = 0;

      const t = pos / this.sr;
      const isHit = rms > this.opts.threshold && rms > this.background * this.opts.ratio && t - this.lastHit > this.opts.refractory;
      if (isHit && !this.capture) {
        this.lastHit = t;
        const buf = new Float32Array(HIT_LENGTH);
        const back = this.win + this.preRoll;
        for (let j = 0; j < back; j++) buf[j] = this.history[(this.histPos - back + j + H) % H];
        this.capture = { pos: pos - this.win, buf, fill: back, peak: 0 };
      }
      // Background follows decays quickly and rises slowly, so sustained sound is not a hit.
      const k = rms > this.background ? 0.02 : 0.3;
      this.background += (rms - this.background) * k;
      this.background = Math.max(this.background, 1e-4);
    }
  }
}
