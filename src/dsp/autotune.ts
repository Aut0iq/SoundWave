// Real-time pitch correction ("autotune"): YIN pitch tracking + TD-PSOLA resynthesis.
// Pure DSP, shared by the live AudioWorklet and the offline renderer.

import { PitchTracker } from './pitch';
import { freqToMidi, snapToScale } from './music';

export interface AutotuneParams {
  /** 12-bit pitch-class mask of allowed notes. */
  mask: number;
  /** 0 = instant (robotic), 1 = slow and natural. */
  speed: number;
  /** 0..1 portion of the correction applied. */
  amount: number;
  /** 0..1 wet/dry mix. */
  mix: number;
  a4: number;
}

export const DEFAULT_AUTOTUNE: AutotuneParams = {
  mask: 0xfff,
  speed: 0.15,
  amount: 1,
  mix: 1,
  a4: 440,
};

export interface AutotuneStatus {
  freq: number;
  target: number;
  shift: number;
}

interface Estimate {
  pos: number;
  period: number;
  midi: number;
}

const MIN_FREQ = 70;
const RING = 1 << 15;
const MASK = RING - 1;

export class AutotuneEngine {
  readonly latency: number;
  private params: AutotuneParams = { ...DEFAULT_AUTOTUNE };
  private readonly tracker: PitchTracker;
  private readonly maxPeriod: number;
  private readonly unvoicedPeriod: number;
  private readonly inBuf = new Float32Array(RING);
  private readonly outBuf = new Float32Array(RING);
  private readonly wBuf = new Float32Array(RING);
  private inPos = 0;
  private outPos = 0;
  private nextSynth = 0;
  private aMark = 0;
  private started = false;
  private readonly history: Estimate[] = [];
  private shift = 0;
  private target = NaN;
  private wet = 1;
  /** Latest analysis, for UI meters. */
  status: AutotuneStatus = { freq: 0, target: 0, shift: 0 };

  /** `hopSize` is the analysis hop at the decimated rate; larger is cheaper (offline). */
  constructor(private readonly sampleRate: number, hopSize = 128) {
    this.tracker = new PitchTracker(sampleRate, { minFreq: MIN_FREQ, maxFreq: 1200, frameSize: 1024, hopSize });
    this.maxPeriod = Math.ceil(sampleRate / MIN_FREQ);
    this.unvoicedPeriod = Math.round(sampleRate * 0.005);
    // Grains need +-period around a mark that may sit half a period after the synthesis point,
    // and output is final one period behind the last synthesis point.
    this.latency = 3 * this.maxPeriod + 64;
  }

  setParams(p: Partial<AutotuneParams>): void {
    this.params = { ...this.params, ...p };
  }

  getParams(): AutotuneParams {
    return { ...this.params };
  }

  process(input: Float32Array, output: Float32Array): void {
    const n = input.length;
    for (let off = 0; off < n; off += 128) {
      const len = Math.min(128, n - off);
      this.processBlock(input.subarray(off, off + len), output.subarray(off, off + len));
    }
  }

  private processBlock(input: Float32Array, output: Float32Array): void {
    const len = input.length;
    for (let i = 0; i < len; i++) this.inBuf[(this.inPos + i) & MASK] = input[i];
    this.inPos += len;

    this.tracker.push(input, (f) => {
      const voiced = f.freq > 0 && f.clarity > 0.8 && f.rms > 0.004;
      this.history.push({
        pos: f.pos,
        period: voiced ? this.sampleRate / f.freq : 0,
        midi: voiced ? freqToMidi(f.freq, this.params.a4) : NaN,
      });
      if (this.history.length > 96) this.history.shift();
    });

    if (!this.started) {
      this.nextSynth = this.aMark = this.inPos - this.latency + this.maxPeriod;
      this.outPos = this.inPos - len - this.latency;
      this.started = true;
    }

    this.synthesize();

    const p = this.params;
    for (let i = 0; i < len; i++) {
      const o = this.outPos + i;
      const idx = o & MASK;
      const w = this.wBuf[idx];
      // Normalise by the summed window; below 0.5 (gaps when pitching down) keep the gain capped.
      const psola = this.outBuf[idx] / (w > 0.5 ? w : 0.5);
      this.outBuf[idx] = 0;
      this.wBuf[idx] = 0;
      const dry = o >= 0 ? this.inBuf[o & MASK] : 0;
      this.wet += (p.mix - this.wet) * 0.002;
      output[i] = this.wet * psola + (1 - this.wet) * dry;
    }
    this.outPos += len;
  }

  private estimateAt(pos: number): Estimate | null {
    const h = this.history;
    if (!h.length) return null;
    let best = h[h.length - 1];
    for (let i = h.length - 1; i >= 0; i--) {
      if (Math.abs(h[i].pos - pos) < Math.abs(best.pos - pos)) best = h[i];
      if (h[i].pos < pos) break;
    }
    return best;
  }

  private synthesize(): void {
    const limit = this.inPos - 2 * this.maxPeriod - 2;
    const p = this.params;
    while (this.nextSynth < limit) {
      const s = this.nextSynth;
      const est = this.estimateAt(s);
      let period: number;
      let ratio = 1;
      if (est && est.period > 0 && est.period <= this.maxPeriod) {
        period = est.period;
        let target = this.target;
        const cand = snapToScale(est.midi, p.mask);
        if (!(target === target) || Math.abs(est.midi - target) > 1.5) {
          target = cand;
        } else if (cand !== target && Math.abs(est.midi - cand) + 0.15 < Math.abs(est.midi - target)) {
          target = cand;
        }
        this.target = target;
        const desired = (target - est.midi) * p.amount;
        const hopSec = period / this.sampleRate;
        const tau = p.speed * p.speed * 0.4;
        const alpha = tau < 1e-4 ? 1 : 1 - Math.exp(-hopSec / tau);
        this.shift += (desired - this.shift) * alpha;
        ratio = Math.pow(2, this.shift / 12);
        this.status = { freq: this.sampleRate / period, target, shift: this.shift };
      } else {
        period = this.unvoicedPeriod;
        this.shift = 0;
        this.target = NaN;
        this.status = { freq: 0, target: 0, shift: 0 };
      }

      // Analysis mark: the pitch-synchronous mark closest to the synthesis point.
      let k = Math.round((s - this.aMark) / period);
      if (k < 0) k = 0;
      this.aMark += k * period;
      if (this.aMark < s - period) this.aMark = s;
      this.addGrain(this.aMark, s, period);
      this.nextSynth = s + period / ratio;
    }
  }

  private addGrain(center: number, at: number, half: number): void {
    const { inBuf, outBuf, wBuf } = this;
    const first = Math.ceil(at - half);
    const last = Math.floor(at + half);
    const inv = Math.PI / half;
    for (let k = first; k <= last; k++) {
      const u = k - at;
      const w = 0.5 + 0.5 * Math.cos(u * inv);
      const src = center + u;
      const i0 = Math.floor(src);
      const frac = src - i0;
      const a = inBuf[i0 & MASK];
      const b = inBuf[(i0 + 1) & MASK];
      const idx = k & MASK;
      outBuf[idx] += w * (a + (b - a) * frac);
      wBuf[idx] += w;
    }
  }
}

/** Offline helper: corrects a whole buffer, compensating the engine latency. */
export function renderAutotune(input: Float32Array, sampleRate: number, params: Partial<AutotuneParams>): Float32Array {
  const engine = new AutotuneEngine(sampleRate, 256);
  engine.setParams({ ...params, mix: params.mix ?? 1 });
  const L = engine.latency;
  const padded = new Float32Array(input.length + L);
  padded.set(input);
  const out = new Float32Array(padded.length);
  engine.process(padded, out);
  return out.subarray(L);
}
