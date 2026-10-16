// Monophonic pitch detection: YIN on a 2x-decimated signal, framed by PitchTracker.

export interface PitchResult {
  /** Fundamental frequency in Hz, 0 when no periodicity was found. */
  freq: number;
  /** 0..1, 1 - YIN aperiodicity at the chosen lag. */
  clarity: number;
}

export interface PitchFrame extends PitchResult {
  /** Absolute position (in original-rate samples) of the analysis window centre. */
  pos: number;
  rms: number;
}

export class YinDetector {
  private readonly diff: Float32Array;
  private readonly cmnd: Float32Array;
  private readonly minTau: number;
  private readonly maxTau: number;
  private readonly window: number;

  constructor(
    private readonly sampleRate: number,
    frameSize: number,
    minFreq: number,
    maxFreq: number,
    private readonly threshold = 0.15,
  ) {
    this.maxTau = Math.min(Math.floor(sampleRate / minFreq), Math.floor(frameSize / 2));
    this.minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
    this.window = frameSize - this.maxTau - 1;
    this.diff = new Float32Array(this.maxTau + 2);
    this.cmnd = new Float32Array(this.maxTau + 2);
  }

  /** `frame` must hold at least `frameSize` samples starting at `offset`. */
  detect(frame: Float32Array, offset = 0): PitchResult {
    const { diff, cmnd, maxTau, minTau, window: w } = this;
    const lastTau = maxTau + 1;

    for (let tau = 1; tau <= lastTau; tau++) {
      let sum = 0;
      for (let j = 0; j < w; j++) {
        const d = frame[offset + j] - frame[offset + j + tau];
        sum += d * d;
      }
      diff[tau] = sum;
    }

    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= lastTau; tau++) {
      running += diff[tau];
      cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
    }

    let tau = -1;
    for (let t = minTau; t < maxTau; t++) {
      if (cmnd[t] < this.threshold) {
        while (t + 1 < maxTau && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // No dip under the threshold: fall back to the global minimum, reported with low clarity.
      let best = minTau;
      for (let t = minTau + 1; t < maxTau; t++) if (cmnd[t] < cmnd[best]) best = t;
      tau = best;
    }

    const clarity = Math.max(0, 1 - cmnd[tau]);
    if (tau <= minTau || tau >= maxTau) return { freq: 0, clarity };

    const s0 = cmnd[tau - 1];
    const s1 = cmnd[tau];
    const s2 = cmnd[tau + 1];
    const denom = s0 - 2 * s1 + s2;
    const shift = denom !== 0 ? (s0 - s2) / (2 * denom) : 0;
    const refined = tau + Math.max(-1, Math.min(1, shift));
    return { freq: this.sampleRate / refined, clarity };
  }
}

export interface PitchTrackerOptions {
  minFreq?: number;
  maxFreq?: number;
  threshold?: number;
  /** Analysis frame length at the decimated rate. */
  frameSize?: number;
  /** Hop between analyses at the decimated rate. */
  hopSize?: number;
}

/**
 * Streams audio in arbitrary chunk sizes, decimates by 2 when the rate allows,
 * and runs YIN every hop. Frame positions are reported in original-rate samples.
 */
export class PitchTracker {
  readonly decim: number;
  readonly analysisRate: number;
  readonly frameSize: number;
  readonly hopSize: number;
  /** Original-rate samples per hop. */
  readonly hop: number;
  private readonly yin: YinDetector;
  private readonly ring: Float32Array;
  private ringFill = 0;
  private sinceHop = 0;
  private decimated = 0;
  private prevA = 0;
  private prevB = 0;
  private phase = 0;

  constructor(readonly sampleRate: number, opts: PitchTrackerOptions = {}) {
    this.decim = sampleRate >= 44100 ? 2 : 1;
    this.analysisRate = sampleRate / this.decim;
    this.frameSize = opts.frameSize ?? 1024;
    this.hopSize = opts.hopSize ?? 256;
    this.hop = this.hopSize * this.decim;
    this.yin = new YinDetector(
      this.analysisRate,
      this.frameSize,
      opts.minFreq ?? 65,
      opts.maxFreq ?? 1400,
      opts.threshold ?? 0.15,
    );
    // Double-length ring: every sample is written twice so a frame is always contiguous.
    this.ring = new Float32Array(this.frameSize * 2);
  }

  reset(): void {
    this.ringFill = 0;
    this.sinceHop = 0;
    this.decimated = 0;
    this.prevA = this.prevB = 0;
    this.phase = 0;
  }

  push(input: Float32Array, onFrame: (frame: PitchFrame) => void): void {
    for (let i = 0; i < input.length; i++) {
      let x = input[i];
      if (this.decim === 2) {
        // [0.25 0.5 0.25] half-band-ish lowpass, keep every second sample.
        const y = 0.25 * this.prevB + 0.5 * this.prevA + 0.25 * x;
        this.prevB = this.prevA;
        this.prevA = x;
        this.phase ^= 1;
        if (this.phase) continue;
        x = y;
      }
      this.write(x, onFrame);
    }
  }

  private write(x: number, onFrame: (frame: PitchFrame) => void): void {
    const n = this.frameSize;
    const idx = this.decimated % n;
    this.ring[idx] = x;
    this.ring[idx + n] = x;
    this.decimated++;
    if (this.ringFill < n) this.ringFill++;
    this.sinceHop++;
    if (this.ringFill < n || this.sinceHop < this.hopSize) return;
    this.sinceHop = 0;

    const start = this.decimated % n;
    let energy = 0;
    const q = n >> 2;
    for (let j = start + q; j < start + n - q; j++) energy += this.ring[j] * this.ring[j];
    const rms = Math.sqrt(energy / (n - 2 * q));
    const res = rms > 1e-4 ? this.yin.detect(this.ring, start) : { freq: 0, clarity: 0 };
    // The decimation filter delays by one decimated sample; centre of the frame in original samples.
    const pos = (this.decimated - n / 2) * this.decim - (this.decim - 1);
    onFrame({ pos, freq: res.freq, clarity: res.clarity, rms });
  }
}
