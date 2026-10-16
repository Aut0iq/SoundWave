// Realistic instruments from the FluidR3 General MIDI soundfont (MIDI.js packaging),
// downloaded once and kept in the browser Cache Storage for offline use.

import type { Instrument, LoadState, Voice } from './types';

const BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/';
const CACHE = 'soundwave-samples-v1';

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function nameToMidi(name: string): number | null {
  const m = /^([A-G])(b|#)?(-?\d)$/.exec(name);
  if (!m) return null;
  let pc = PITCH[m[1]];
  if (m[2] === 'b') pc -= 1;
  if (m[2] === '#') pc += 1;
  return pc + (Number(m[3]) + 1) * 12;
}

async function fetchCached(url: string): Promise<string> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return await hit.text();
  } catch {
    cache = null;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (cache) {
    try {
      await cache.put(url, res.clone());
    } catch {
      // Quota or private mode: still usable without caching.
    }
  }
  return await res.text();
}

function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export class SampledInstrument implements Instrument {
  readonly group = 'sampled' as const;
  private samples = new Map<number, AudioBuffer>();
  private sorted: number[] = [];
  private loadState: LoadState = 'idle';
  /** Brings quiet soundfont samples up to a consistent level. */
  private norm = 1;
  private loading: Promise<void> | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly gmProgram: number,
    private readonly sfName: string,
    private readonly release = 0.25,
    private readonly gain = 1,
  ) {}

  state(): LoadState {
    return this.loadState;
  }

  load(ctx: BaseAudioContext): Promise<void> {
    if (this.loadState === 'ready') return Promise.resolve();
    if (this.loading) return this.loading;
    this.loadState = 'loading';
    this.loading = (async () => {
      try {
        const text = await fetchCached(`${BASE}${this.sfName}-mp3.js`);
        const re = /"([A-G]b?-?\d)"\s*:\s*"data:audio\/(?:mp3|mpeg);base64,([^"]+)"/g;
        const jobs: Promise<void>[] = [];
        for (const m of text.matchAll(re)) {
          const midi = nameToMidi(m[1]);
          if (midi === null) continue;
          const data = base64ToBytes(m[2]);
          jobs.push(
            ctx.decodeAudioData(data).then(
              (buf) => void this.samples.set(midi, buf),
              () => undefined,
            ),
          );
        }
        await Promise.all(jobs);
        if (this.samples.size === 0) throw new Error('no samples');
        this.sorted = [...this.samples.keys()].sort((a, b) => a - b);
        let peak = 0;
        for (const buf of this.samples.values()) {
          for (let c = 0; c < buf.numberOfChannels; c++) {
            const d = buf.getChannelData(c);
            for (let i = 0; i < d.length; i += 3) peak = Math.max(peak, Math.abs(d[i]));
          }
        }
        this.norm = peak > 0 ? Math.min(12, 0.6 / peak) : 1;
        this.loadState = 'ready';
      } catch (err) {
        this.loadState = 'error';
        this.loading = null;
        throw err;
      }
    })();
    return this.loading;
  }

  createBus(_ctx: BaseAudioContext, dest: AudioNode): AudioNode {
    return dest;
  }

  private nearest(midi: number): number {
    let best = this.sorted[0];
    for (const m of this.sorted) if (Math.abs(m - midi) < Math.abs(best - midi)) best = m;
    return best;
  }

  play(ctx: BaseAudioContext, bus: AudioNode, midi: number, velocity: number, time: number, duration?: number): Voice {
    if (this.loadState !== 'ready') return { stop() {}, bend() {} };
    const sampleMidi = this.nearest(midi);
    const src = ctx.createBufferSource();
    src.buffer = this.samples.get(sampleMidi)!;
    src.detune.value = (midi - sampleMidi) * 100;
    const v = Math.max(1, Math.min(127, velocity)) / 127;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(this.norm * this.gain * (0.12 + 0.88 * v * v), time + 0.004);
    src.connect(g).connect(bus);
    src.start(time);
    const base = (midi - sampleMidi) * 100;
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
        src.detune.setTargetAtTime(base + cents, t, 0.01);
      },
    };
    src.onended = () => g.disconnect();
    if (duration !== undefined) voice.stop(time + duration);
    return voice;
  }
}

export function createSampledInstruments(): Instrument[] {
  return [
    new SampledInstrument('sf-piano', 'Рояль', 0, 'acoustic_grand_piano', 0.3),
    new SampledInstrument('sf-epiano', 'Электропиано', 4, 'electric_piano_1', 0.3),
    new SampledInstrument('sf-nylon', 'Гитара (нейлон)', 24, 'acoustic_guitar_nylon', 0.2),
    new SampledInstrument('sf-steel', 'Гитара (металл. струны)', 25, 'acoustic_guitar_steel', 0.2),
    new SampledInstrument('sf-clean', 'Электрогитара (чистая)', 27, 'electric_guitar_clean', 0.2),
    new SampledInstrument('sf-overdrive', 'Электрогитара (перегруз)', 29, 'overdriven_guitar', 0.15),
    new SampledInstrument('sf-distortion', 'Электрогитара (дисторшн)', 30, 'distortion_guitar', 0.15),
    new SampledInstrument('sf-bass', 'Бас-гитара', 33, 'electric_bass_finger', 0.15),
    new SampledInstrument('sf-violin', 'Скрипка', 40, 'violin', 0.35),
    new SampledInstrument('sf-cello', 'Виолончель', 42, 'cello', 0.35),
    new SampledInstrument('sf-strings', 'Струнный ансамбль', 48, 'string_ensemble_1', 0.5),
    new SampledInstrument('sf-choir', 'Хор', 52, 'choir_aahs', 0.5),
    new SampledInstrument('sf-trumpet', 'Труба', 56, 'trumpet', 0.2),
    new SampledInstrument('sf-sax', 'Саксофон', 65, 'alto_sax', 0.2),
    new SampledInstrument('sf-flute', 'Флейта', 73, 'flute', 0.25),
    new SampledInstrument('sf-marimba', 'Маримба', 12, 'marimba', 0.3),
    new SampledInstrument('sf-organ', 'Рок-орган', 18, 'rock_organ', 0.1),
    new SampledInstrument('sf-lead', 'Синт-лид (пила)', 81, 'lead_2_sawtooth', 0.15),
    new SampledInstrument('sf-pad', 'Тёплый пэд', 89, 'pad_2_warm', 0.8),
  ];
}
