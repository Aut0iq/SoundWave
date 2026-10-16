// Real-time processing of the microphone stream:
//  Listener  - pitch frames + timbre from raw chunks
//  Performer - voice -> notes (key lock, chords, bend, CC) to the built-in instrument and MIDI out
//  Triggers  - beatbox hits -> drum pads

import { PitchTracker, type PitchFrame } from '../dsp/pitch';
import { snapToScale } from '../dsp/music';
import { buildChord } from '../dsp/harmony';
import { GUITAR_OPTIONS, NoteTracker, VOICE_OPTIONS, type TrackerFrame, type TrackerOptions } from '../dsp/noteTracker';
import { HitClassifier, hitFeatures, OnsetDetector } from '../dsp/triggers';
import { getInstrument, playableInstrument, type Instrument, type Voice } from './instruments';
import { playDrum } from './instruments/drums';
import type { AudioIO } from './audioIO';
import type { MidiOut } from '../midi/midiOut';
import { currentMask, type Settings } from '../state/settings';

export interface LiveFrame extends TrackerFrame {
  /** Fractional MIDI or NaN. */
  midi: number;
  brightness: number;
}

export class Listener {
  private tracker!: PitchTracker;
  private trackerKey = '';
  private base = 0;
  private expected = -1;
  private hpPrev = 0;
  private hpOut = 0;
  brightness = 0;
  level = 0;
  frameSec = 0.01;
  frameListeners: ((f: LiveFrame) => void)[] = [];
  chunkListeners: ((frame: number, samples: Float32Array) => void)[] = [];

  constructor(private readonly sr: number, private settings: Settings) {
    this.configure(settings);
  }

  configure(s: Settings): void {
    this.settings = s;
    const low = s.latency === 'low';
    const minFreq = s.source === 'guitar' ? 70 : low ? 95 : 65;
    const key = `${low}:${minFreq}`;
    if (key === this.trackerKey) return;
    this.trackerKey = key;
    this.tracker = new PitchTracker(this.sr, {
      minFreq,
      maxFreq: s.source === 'guitar' ? 1400 : 1200,
      frameSize: low ? 512 : 1024,
      hopSize: low ? 128 : 192,
    });
    this.frameSec = this.tracker.hop / this.sr;
    this.expected = -1;
  }

  push(frame: number, samples: Float32Array): void {
    if (frame !== this.expected) {
      // First chunk, or audio dropped: restart analysis aligned to this chunk.
      this.tracker.reset();
      this.base = frame;
    }
    this.expected = frame + samples.length;

    // Timbre: share of energy above ~2.5 kHz (one-pole highpass).
    let total = 0;
    let high = 0;
    const a = Math.exp((-2 * Math.PI * 2500) / this.sr);
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      this.hpOut = a * (this.hpOut + x - this.hpPrev);
      this.hpPrev = x;
      total += x * x;
      high += this.hpOut * this.hpOut;
    }
    const rms = Math.sqrt(total / samples.length);
    this.level = Math.max(rms, this.level * 0.9);
    if (total > 1e-6) {
      const b = Math.max(0, Math.min(1, (Math.log10(high / total + 1e-6) + 2.5) / 2.5));
      this.brightness += (b - this.brightness) * 0.3;
    }

    for (const l of this.chunkListeners) l(frame, samples);
    this.tracker.push(samples, (f: PitchFrame) => {
      const t = (this.base + f.pos) / this.sr;
      const live: LiveFrame = {
        t,
        freq: f.freq,
        clarity: f.clarity,
        rms: f.rms,
        midi: f.freq > 0 ? 69 + 12 * Math.log2(f.freq / this.settings.a4) : NaN,
        brightness: this.brightness,
      };
      for (const l of this.frameListeners) l(live);
    });
  }
}

export function trackerOptions(s: Settings): TrackerOptions {
  const base = s.source === 'guitar' ? GUITAR_OPTIONS : VOICE_OPTIONS;
  const o: TrackerOptions = { ...base, a4: s.a4, rmsGate: Math.pow(10, s.gateDb / 20) };
  if (s.latency === 'low') {
    o.confirmSec = Math.min(o.confirmSec, 0.025);
    o.changeSec = Math.min(o.changeSec, 0.035);
  }
  // In bend modes the pitch glides inside one note instead of splitting it.
  if (s.bendMode !== 'off') o.changeSemitones = Math.max(o.changeSemitones, s.bendRange - 0.3);
  return o;
}

export interface PerformedNote {
  notes: number[];
  root: number;
  raw: number;
  velocity: number;
  t: number;
}

interface Sounding {
  root: number;
  raw: number;
  notes: number[];
  voices: Voice[];
  velocity: number;
  start: number;
}

export class Performer {
  private tracker: NoteTracker;
  private current: Sounding | null = null;
  private instrument: Instrument;
  private bus: AudioNode;
  private busFor = '';
  private lastBend = 0;
  private env = 0;
  private lastEnv = -1;
  private lastTimbre = -1;
  enabled = true;
  onNoteOn: (n: PerformedNote) => void = () => {};
  onNoteOff: (n: PerformedNote, end: number, discarded: boolean) => void = () => {};

  constructor(private readonly io: AudioIO, private readonly midi: MidiOut, private s: Settings, private frameSec: number) {
    this.tracker = new NoteTracker(trackerOptions(s), frameSec);
    this.instrument = playableInstrument(s.liveInstrument);
    this.bus = this.instrument.createBus(io.ctx, io.liveBus);
    this.busFor = this.instrument.id;
  }

  configure(s: Settings, frameSec: number): void {
    const prev = this.s;
    this.s = s;
    if (frameSec !== this.frameSec || prev.source !== s.source || prev.latency !== s.latency) {
      this.allOff();
      this.frameSec = frameSec;
      this.tracker = new NoteTracker(trackerOptions(s), frameSec);
    } else {
      this.tracker.opts = trackerOptions(s);
    }
    if (prev.liveInstrument !== s.liveInstrument || prev.midiChannel !== s.midiChannel || prev.midiPort !== s.midiPort) {
      this.allOff();
    }
    if (prev.bendRange !== s.bendRange && s.bendMode !== 'off') this.midi.bendRange(s.midiChannel, s.bendRange);
  }

  get active(): PerformedNote | null {
    const c = this.current;
    return c ? { notes: c.notes, root: c.root, raw: c.raw, velocity: c.velocity, t: c.start } : null;
  }

  get pitch(): number {
    return this.tracker.currentPitch;
  }

  private ensureInstrument(): void {
    const inst = playableInstrument(this.s.liveInstrument);
    if (inst.id !== this.busFor) {
      this.bus.disconnect();
      this.instrument = inst;
      this.bus = inst.createBus(this.io.ctx, this.io.liveBus);
      this.busFor = inst.id;
    }
  }

  frame(f: LiveFrame): void {
    const s = this.s;
    const events = this.tracker.push(f);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const next = events[i + 1];
      // The voice wobbled but still lands on the same (key-locked) note: keep it sounding.
      if (e.type === 'off' && next?.type === 'on' && next.legato && this.current && this.rootFor(next.raw) === this.current.root) {
        i++;
        continue;
      }
      if (e.type === 'off') this.release(e.note.end, e.discarded);
      else this.start(e.raw, e.velocity, e.t);
    }
    if (!this.enabled) return;

    // Continuous controllers.
    const db = 20 * Math.log10(Math.max(f.rms, 1e-6));
    const envTarget = Math.max(0, Math.min(1, (db - s.gateDb) / (-6 - s.gateDb))) * 127;
    this.env += (envTarget - this.env) * 0.5;
    if (s.envCC && Math.abs(Math.round(this.env) - this.lastEnv) >= 1) {
      this.lastEnv = Math.round(this.env);
      this.midi.cc(s.midiChannel, s.envCCNum, this.lastEnv);
    }
    if (s.timbreCC && f.midi === f.midi) {
      const v = Math.round(f.brightness * 127);
      if (Math.abs(v - this.lastTimbre) >= 1) {
        this.lastTimbre = v;
        this.midi.cc(s.midiChannel, s.timbreCCNum, v);
      }
    }

    const c = this.current;
    if (c && s.bendMode !== 'off' && this.tracker.currentPitch === this.tracker.currentPitch) {
      const m = this.tracker.currentPitch + s.octave * 12;
      let bend: number;
      if (s.bendMode === 'follow') {
        bend = m - c.root;
      } else {
        const dz = 0.45;
        const dev = m - (c.raw + s.octave * 12);
        bend = Math.abs(dev) < dz ? 0 : Math.sign(dev) * (Math.abs(dev) - dz) * (s.bendRange / (s.bendRange - dz));
      }
      bend = Math.max(-s.bendRange, Math.min(s.bendRange, bend));
      if (Math.abs(bend - this.lastBend) > 1 / 64) {
        this.lastBend = bend;
        const now = this.io.ctx.currentTime;
        for (const v of c.voices) v.bend(bend * 100, now);
        this.midi.pitchBend(s.midiChannel, bend, s.bendRange);
      }
    }
  }

  private rootFor(raw: number): number {
    const s = this.s;
    return (s.keyLock ? snapToScale(raw, currentMask(s)) : Math.round(raw)) + s.octave * 12;
  }

  private start(raw: number, trackerVelocity: number, t: number): void {
    const s = this.s;
    this.release(t);
    const mask = currentMask(s);
    const root = this.rootFor(raw);
    const notes = buildChord(root, s.chord, s.voicing, mask);
    const velocity = s.velocityMode === 'fixed' ? s.fixedVelocity : trackerVelocity;
    const voices: Voice[] = [];
    if (this.enabled) {
      if (s.liveSound) {
        this.ensureInstrument();
        const now = this.io.ctx.currentTime;
        for (const n of notes) voices.push(this.instrument.play(this.io.ctx, this.bus, n, velocity, now));
      }
      if (s.bendMode !== 'off') this.midi.pitchBend(s.midiChannel, 0, s.bendRange);
      for (const n of notes) this.midi.noteOn(s.midiChannel, n, velocity);
    }
    this.lastBend = 0;
    this.current = { root, raw, notes, voices, velocity, start: t };
    this.onNoteOn({ notes, root, raw, velocity, t });
  }

  private release(t: number, discarded = false): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    const now = this.io.ctx.currentTime;
    for (const v of c.voices) v.stop(now);
    for (const n of c.notes) this.midi.noteOff(this.s.midiChannel, n);
    if (this.s.bendMode !== 'off' && this.lastBend !== 0) this.midi.pitchBend(this.s.midiChannel, 0, this.s.bendRange);
    this.lastBend = 0;
    this.onNoteOff({ notes: c.notes, root: c.root, raw: c.raw, velocity: c.velocity, t: c.start }, Math.max(t, c.start), discarded);
  }

  allOff(): void {
    this.release(this.io.ctx.currentTime);
  }

  /** Audition a note on the live instrument (UI keyboard). */
  preview(midi: number): void {
    this.ensureInstrument();
    this.instrument.play(this.io.ctx, this.bus, midi, 90, this.io.ctx.currentTime, 0.4);
  }

  loadInstrument(id: string): Promise<void> {
    return getInstrument(id).load(this.io.ctx);
  }
}

export interface TriggerHit {
  pad: number;
  velocity: number;
  t: number;
}

export class Triggers {
  readonly classifier = new HitClassifier();
  private detector: OnsetDetector;
  /** Pad being trained, or null. */
  training: number | null = null;
  enabled = false;
  onHit: (hit: TriggerHit) => void = () => {};
  onTrained: (pad: number) => void = () => {};

  constructor(private readonly io: AudioIO, private readonly midi: MidiOut, private s: Settings) {
    this.detector = new OnsetDetector(io.sampleRate, { threshold: Math.pow(10, s.triggerDb / 20), ratio: 4, refractory: 0.07 });
    try {
      const saved = localStorage.getItem('soundwave.triggers.v1');
      if (saved) this.classifier.load(JSON.parse(saved));
    } catch {
      // ignore
    }
  }

  configure(s: Settings): void {
    this.s = s;
    this.detector.opts = { ...this.detector.opts, threshold: Math.pow(10, s.triggerDb / 20) };
  }

  private persist(): void {
    try {
      localStorage.setItem('soundwave.triggers.v1', JSON.stringify(this.classifier.toJSON()));
    } catch {
      // ignore
    }
  }

  clear(pad: number): void {
    this.classifier.clear(pad);
    this.persist();
  }

  push(frame: number, samples: Float32Array): void {
    if (!this.enabled && this.training === null) return;
    this.detector.push(samples, (hit) => {
      const feat = hitFeatures(hit.samples, this.io.sampleRate);
      const db = 20 * Math.log10(Math.max(hit.rms, 1e-6));
      const velocity = Math.round(Math.max(30, Math.min(127, 40 + ((db - this.s.triggerDb) / 30) * 87)));
      const t = (frame + samples.length) / this.io.sampleRate;
      if (this.training !== null) {
        this.classifier.add(this.training, feat);
        this.persist();
        this.fire(this.training, velocity, t);
        this.onTrained(this.training);
        return;
      }
      const res = this.classifier.classify(feat);
      if (res) this.fire(res.pad, velocity, t);
    });
  }

  fire(pad: number, velocity: number, t: number): void {
    const cfg = this.s.pads[pad];
    if (!cfg) return;
    playDrum(this.io.ctx, this.io.drumBus, cfg.sound, velocity, this.io.ctx.currentTime);
    this.midi.noteOn(this.s.drumChannel, cfg.note, velocity);
    const ch = this.s.drumChannel;
    setTimeout(() => this.midi.noteOff(ch, cfg.note), 60);
    this.onHit({ pad, velocity, t });
  }
}
