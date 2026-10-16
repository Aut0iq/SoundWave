// Studio playback, recording and rendering.

import AutotuneWorker from './autotune.worker.ts?worker';
import { DRUM_SOUNDS, playDrum } from './instruments/drums';
import { getInstrument, playableInstrument, type Instrument, type Voice } from './instruments';
import { audibleTracks, projectEnd, type Project, type Track } from '../state/project';
import { newNoteId, type Note } from '../dsp/noteTracker';
import type { AutotuneParams } from '../dsp/autotune';

const LOOKAHEAD = 0.25;

export function drumIdForNote(note: number): string {
  return DRUM_SOUNDS.find((d) => d.gmNote === note)?.id ?? 'snare';
}

const bufferCache = new WeakMap<Float32Array, AudioBuffer>();
function toBuffer(data: Float32Array, sampleRate: number): AudioBuffer {
  let buf = bufferCache.get(data);
  if (!buf) {
    buf = new AudioBuffer({ length: Math.max(1, data.length), sampleRate, numberOfChannels: 1 });
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    bufferCache.set(data, buf);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Autotuned versions of recorded takes, rendered in a worker and cached per settings.

export class TunedCache {
  private worker: Worker | null = null;
  private jobs = new Map<number, (out: Float32Array) => void>();
  private nextJob = 1;
  private cache = new Map<number, { key: string; data: Float32Array }>();
  private pending = new Map<number, { key: string; promise: Promise<Float32Array> }>();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new AutotuneWorker();
      this.worker.onmessage = (e: MessageEvent<{ id: number; out: Float32Array }>) => {
        this.jobs.get(e.data.id)?.(e.data.out);
        this.jobs.delete(e.data.id);
      };
    }
    return this.worker;
  }

  static key(p: Partial<AutotuneParams>): string {
    return `${p.mask}:${p.speed?.toFixed(3)}:${p.amount?.toFixed(3)}:${p.a4}`;
  }

  get(track: Track, params: Partial<AutotuneParams>): Float32Array | null {
    const c = this.cache.get(track.id);
    return c && c.key === TunedCache.key(params) ? c.data : null;
  }

  render(track: Track, params: Partial<AutotuneParams>): Promise<Float32Array> {
    const key = TunedCache.key(params);
    const hit = this.get(track, params);
    if (hit) return Promise.resolve(hit);
    const pend = this.pending.get(track.id);
    if (pend && pend.key === key) return pend.promise;
    const audio = track.audio;
    if (!audio) return Promise.resolve(new Float32Array(0));
    const id = this.nextJob++;
    const promise = new Promise<Float32Array>((resolve) => {
      this.jobs.set(id, (out) => {
        this.cache.set(track.id, { key, data: out });
        this.pending.delete(track.id);
        resolve(out);
      });
      // Copy: the worker takes ownership of what we send.
      const copy = audio.slice();
      this.getWorker().postMessage({ id, data: copy, sampleRate: track.sampleRate, params }, [copy.buffer]);
    });
    this.pending.set(track.id, { key, promise });
    return promise;
  }

  drop(trackId: number): void {
    this.cache.delete(trackId);
  }
}

// ---------------------------------------------------------------------------
// Scheduling shared by live playback and offline rendering.

interface TrackChain {
  gain: GainNode;
  bus: AudioNode;
  instrument: Instrument;
}

function buildChain(ctx: BaseAudioContext, dest: AudioNode, track: Track): TrackChain {
  const gain = ctx.createGain();
  gain.gain.value = track.volume;
  gain.connect(dest);
  const instrument = playableInstrument(track.instrumentId);
  const bus = track.kind === 'drums' ? gain : instrument.createBus(ctx, gain);
  return { gain, bus, instrument };
}

function playsInstrument(t: Track): boolean {
  return t.kind === 'drums' || t.playMode.startsWith('instrument');
}

function voiceAudio(t: Track, tuned: TunedCache, params: Partial<AutotuneParams>): Float32Array | null {
  if (!t.audio || t.kind === 'drums') return null;
  if (t.playMode === 'voice' || t.playMode === 'instrument+voice') return t.audio;
  if (t.playMode === 'tuned' || t.playMode === 'instrument+tuned') return tuned.get(t, params) ?? t.audio;
  return null;
}

function scheduleNote(ctx: BaseAudioContext, chain: TrackChain, track: Track, n: Note, when: number): Voice | null {
  if (track.kind === 'drums') {
    playDrum(ctx, chain.bus, drumIdForNote(n.midi), n.velocity, when);
    return null;
  }
  return chain.instrument.play(ctx, chain.bus, n.midi, n.velocity, when, Math.max(0.05, n.end - n.start));
}

function scheduleClick(ctx: BaseAudioContext, dest: AudioNode, beat: number, when: number): void {
  playDrum(ctx, dest, beat % 4 === 0 ? 'clickAccent' : 'click', beat % 4 === 0 ? 110 : 80, when);
}

export interface PlayOptions {
  from: number;
  metronome: boolean;
  /** Context time at which project time `from` is heard; defaults to "now". */
  at?: number;
  /** Extra metronome beats before `at` (count-in). */
  countIn?: number;
  /** Stop automatically at the end of the project. */
  autoStop?: boolean;
}

export class Player {
  playing = false;
  private startCtx = 0;
  private startPos = 0;
  private schedPos = 0;
  private timer: number | null = null;
  private chains = new Map<number, TrackChain>();
  private voices: Voice[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private clickBus: GainNode;
  private nextBeat = 0;
  private opts: PlayOptions = { from: 0, metronome: false };
  onStop: () => void = () => {};

  constructor(
    private readonly ctx: AudioContext,
    private readonly dest: AudioNode,
    private readonly getProject: () => Project,
    private readonly tuned: TunedCache,
    private readonly tuneParams: () => Partial<AutotuneParams>,
  ) {
    this.clickBus = ctx.createGain();
    this.clickBus.gain.value = 0.5;
    this.clickBus.connect(dest);
  }

  position(): number {
    if (!this.playing) return this.startPos;
    return this.startPos + (this.ctx.currentTime - this.startCtx);
  }

  seek(pos: number): void {
    if (this.playing) return;
    this.startPos = Math.max(0, pos);
  }

  setMetronome(on: boolean): void {
    this.opts.metronome = on;
  }

  setTrackVolume(track: Track): void {
    const c = this.chains.get(track.id);
    if (c) c.gain.gain.setTargetAtTime(audibleTracks(this.getProject()).includes(track) ? track.volume : 0, this.ctx.currentTime, 0.02);
  }

  refreshMix(): void {
    for (const t of this.getProject().tracks) this.setTrackVolume(t);
  }

  play(opts: PlayOptions): void {
    this.stop(false);
    const project = this.getProject();
    this.opts = { ...opts };
    this.playing = true;
    this.startPos = opts.from;
    this.startCtx = opts.at ?? this.ctx.currentTime + 0.06;
    this.schedPos = opts.from;
    const beat = 60 / project.bpm;
    this.nextBeat = Math.ceil(opts.from / beat - 1e-6);
    if (opts.countIn && opts.metronome) {
      for (let i = opts.countIn; i >= 1; i--) scheduleClick(this.ctx, this.clickBus, i === opts.countIn ? 0 : 1, this.startCtx - i * beat);
    }

    const params = this.tuneParams();
    for (const t of project.tracks) {
      const chain = buildChain(this.ctx, this.dest, t);
      this.chains.set(t.id, chain);
      const audio = voiceAudio(t, this.tuned, params);
      if (audio && audio.length) {
        const src = this.ctx.createBufferSource();
        src.buffer = toBuffer(audio, t.sampleRate);
        src.connect(chain.gain);
        const offset = opts.from - t.audioStart;
        if (offset < src.buffer.duration) {
          if (offset >= 0) src.start(this.startCtx, offset);
          else src.start(this.startCtx - offset, 0);
          this.sources.push(src);
        }
      }
    }
    this.refreshMix();
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 30);
  }

  private tick(): void {
    if (!this.playing) return;
    const project = this.getProject();
    const horizon = this.position() + LOOKAHEAD + Math.max(0, this.startCtx - this.ctx.currentTime);
    const from = this.schedPos;
    for (const t of project.tracks) {
      if (!playsInstrument(t)) continue;
      const chain = this.chains.get(t.id);
      if (!chain) continue;
      for (const n of t.notes) {
        if (n.start >= from && n.start < horizon && n.start >= this.startPos) {
          const v = scheduleNote(this.ctx, chain, t, n, this.startCtx + (n.start - this.startPos));
          if (v) this.voices.push(v);
        }
      }
    }
    if (this.opts.metronome) {
      const beat = 60 / project.bpm;
      while (this.nextBeat * beat < horizon) {
        scheduleClick(this.ctx, this.clickBus, this.nextBeat, this.startCtx + (this.nextBeat * beat - this.startPos));
        this.nextBeat++;
      }
    } else {
      this.nextBeat = Math.ceil(horizon / (60 / project.bpm));
    }
    this.schedPos = horizon;
    if (this.voices.length > 400) this.voices = this.voices.slice(-200);
    if (this.opts.autoStop && this.position() > projectEnd(project) + 0.5) this.stop();
  }

  stop(notify = true): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.startPos = this.position();
    this.playing = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const now = this.ctx.currentTime;
    for (const v of this.voices) v.stop(now);
    for (const s of this.sources) {
      try {
        s.stop(now + 0.02);
      } catch {
        // not started yet
      }
    }
    for (const c of this.chains.values()) {
      c.gain.gain.setTargetAtTime(0, now, 0.01);
      const g = c.gain;
      setTimeout(() => g.disconnect(), 400);
    }
    this.chains.clear();
    this.voices = [];
    this.sources = [];
    if (wasPlaying && notify) this.onStop();
  }
}

// ---------------------------------------------------------------------------
// Recording.

export interface RecordResult {
  audio: Float32Array;
  audioStart: number;
  notes: Note[];
  hits: Note[];
  curve: { t: number; m: number }[];
}

export class Recorder {
  recording = false;
  private chunks: { frame: number; samples: Float32Array }[] = [];
  private curve: { t: number; m: number }[] = [];
  private notes: Note[] = [];
  private hits: Note[] = [];
  private open: { notes: number[]; raw: number; root: number; velocity: number; t: number } | null = null;
  private startCtx = 0;
  private projectStart = 0;

  constructor(private readonly sampleRate: number) {}

  begin(startCtx: number, projectStart: number): void {
    this.recording = true;
    this.chunks = [];
    this.curve = [];
    this.notes = [];
    this.hits = [];
    this.open = null;
    this.startCtx = startCtx;
    this.projectStart = projectStart;
  }

  /** Live view of what has been captured so far, in project time (no latency compensation). */
  liveNotes(nowCtx: number): Note[] {
    const out = this.notes.map((n) => ({ ...n }));
    if (this.open) {
      for (const m of this.open.notes) {
        out.push({ id: 0, midi: m, raw: this.open.raw + (m - this.open.root), start: this.toProject(this.open.t), end: this.toProject(nowCtx), velocity: this.open.velocity });
      }
    }
    return out.filter((n) => n.end > this.projectStart);
  }

  liveCurve(): { t: number; m: number }[] {
    return this.curve;
  }

  private toProject(t: number, latency = 0): number {
    return this.projectStart + (t - this.startCtx) - latency;
  }

  addChunk(frame: number, samples: Float32Array): void {
    if (!this.recording) return;
    if ((frame + samples.length) / this.sampleRate < this.startCtx) return;
    this.chunks.push({ frame, samples: samples.slice() });
  }

  addFrame(t: number, midi: number): void {
    if (!this.recording || t < this.startCtx) return;
    if (midi === midi) this.curve.push({ t: this.toProject(t), m: midi });
    else if (this.curve.length && this.curve[this.curve.length - 1].m === this.curve[this.curve.length - 1].m) this.curve.push({ t: this.toProject(t), m: NaN });
  }

  noteOn(notes: number[], root: number, raw: number, velocity: number, t: number): void {
    if (!this.recording) return;
    this.open = { notes, root, raw, velocity, t };
  }

  noteOff(t: number, discarded = false): void {
    if (!this.recording || !this.open) return;
    const o = this.open;
    this.open = null;
    if (discarded) return;
    for (const m of o.notes) {
      this.notes.push({ id: newNoteId(), midi: m, raw: o.raw + (m - o.root), start: this.toProject(o.t), end: this.toProject(t), velocity: o.velocity });
    }
  }

  addHit(note: number, velocity: number, t: number): void {
    if (!this.recording || t < this.startCtx) return;
    const start = this.toProject(t);
    this.hits.push({ id: newNoteId(), midi: note, raw: note, start, end: start + 0.1, velocity });
  }

  finish(nowCtx: number, latency: number): RecordResult {
    this.noteOff(nowCtx);
    this.recording = false;
    const sr = this.sampleRate;
    let audio = new Float32Array(0);
    let audioStart = this.projectStart;
    if (this.chunks.length) {
      const first = Math.max(this.chunks[0].frame, Math.round(this.startCtx * sr));
      const last = this.chunks[this.chunks.length - 1];
      const total = last.frame + last.samples.length - first;
      audio = new Float32Array(Math.max(0, total));
      for (const c of this.chunks) {
        for (let i = 0; i < c.samples.length; i++) {
          const idx = c.frame + i - first;
          if (idx >= 0 && idx < audio.length) audio[idx] = c.samples[i];
        }
      }
      audioStart = this.toProject(first / sr, latency);
    }
    const shift = (n: Note): Note => ({ ...n, start: n.start - latency, end: n.end - latency });
    const notes = this.notes.map(shift).filter((n) => n.end > this.projectStart - latency + 0.02);
    for (const n of notes) n.start = Math.max(n.start, this.projectStart - latency);
    const curve = this.curve.map((c) => ({ t: c.t - latency, m: c.m }));
    this.chunks = [];
    return { audio, audioStart, notes, hits: this.hits.map(shift), curve };
  }
}

// ---------------------------------------------------------------------------
// Offline mixdown and file encoding.

export async function renderMix(project: Project, sampleRate: number, tuned: TunedCache, params: Partial<AutotuneParams>): Promise<AudioBuffer> {
  // Make sure sampled instruments are loaded and autotuned takes are rendered.
  const tracks = audibleTracks(project);
  const loader = new OfflineAudioContext(1, 1, sampleRate);
  await Promise.all(
    tracks.map(async (t) => {
      if (t.kind === 'melody' && playsInstrument(t)) await getInstrument(t.instrumentId).load(loader).catch(() => undefined);
      if (t.audio && (t.playMode === 'tuned' || t.playMode === 'instrument+tuned')) await tuned.render(t, params);
    }),
  );
  const length = Math.ceil((projectEnd(project) + 2) * sampleRate);
  const ctx = new OfflineAudioContext(2, Math.max(length, sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  master.connect(limiter).connect(ctx.destination);
  for (const t of tracks) {
    const chain = buildChain(ctx, master, t);
    if (playsInstrument(t)) for (const n of t.notes) if (n.start >= 0) scheduleNote(ctx, chain, t, n, n.start);
    const audio = voiceAudio(t, tuned, params);
    if (audio && audio.length) {
      const src = ctx.createBufferSource();
      src.buffer = toBuffer(audio, t.sampleRate);
      src.connect(chain.gain);
      if (t.audioStart >= 0) src.start(t.audioStart);
      else src.start(0, -t.audioStart);
    }
  }
  return ctx.startRendering();
}

export function encodeWav(buffer: AudioBuffer): Blob {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  data.setUint32(4, 36 + len * ch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, buffer.sampleRate, true);
  data.setUint32(28, buffer.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  w(36, 'data');
  data.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buffer.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data.buffer], { type: 'audio/wav' });
}
