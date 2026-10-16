// Turns a stream of pitch frames into discrete notes (monophonic transcription).

import { freqToMidi } from './music';

export interface Note {
  id: number;
  /** Integer MIDI note that is played back. */
  midi: number;
  /** Median detected pitch as fractional MIDI (used to re-snap to a scale later). */
  raw: number;
  /** Seconds. */
  start: number;
  end: number;
  /** 1..127 */
  velocity: number;
}

export interface TrackerFrame {
  /** Seconds (window centre). */
  t: number;
  freq: number;
  clarity: number;
  rms: number;
}

export interface TrackerOptions {
  a4: number;
  /** Frames below this RMS are treated as silence. */
  rmsGate: number;
  clarityGate: number;
  /** A sustained pitch must last this long before a note starts. */
  confirmSec: number;
  minNoteSec: number;
  /** Silence shorter than this does not end a note. */
  maxGapSec: number;
  /** Deviation (semitones) from the note centre that counts as a pitch change. */
  changeSemitones: number;
  /** How long a new pitch must be held to split the note. */
  changeSec: number;
  /** RMS jump ratio that re-articulates a note (e.g. replucking the same string). */
  onsetRatio: number;
}

export const VOICE_OPTIONS: TrackerOptions = {
  a4: 440,
  rmsGate: 0.01,
  clarityGate: 0.75,
  confirmSec: 0.05,
  minNoteSec: 0.08,
  maxGapSec: 0.07,
  changeSemitones: 0.65,
  changeSec: 0.06,
  onsetRatio: 2.6,
};

export const GUITAR_OPTIONS: TrackerOptions = {
  ...VOICE_OPTIONS,
  clarityGate: 0.7,
  confirmSec: 0.035,
  minNoteSec: 0.06,
  maxGapSec: 0.05,
  changeSemitones: 0.55,
  changeSec: 0.045,
  onsetRatio: 1.8,
};

export type TrackerEvent =
  | { type: 'on'; midi: number; raw: number; t: number; velocity: number }
  /** `discarded`: the note was too short to keep in the transcription (it still has to be released). */
  | { type: 'off'; note: Note; discarded: boolean };

interface Voiced {
  t: number;
  m: number;
  rms: number;
}

let nextNoteId = 1;
export function newNoteId(): number {
  return nextNoteId++;
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

export function rmsToVelocity(rms: number): number {
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.round(Math.max(20, Math.min(127, 40 + ((db + 50) / 45) * 87)));
}

export class NoteTracker {
  private candidate: Voiced[] = [];
  private active: { start: number; values: Voiced[]; peak: number; articulated: boolean } | null = null;
  private deviation: Voiced[] = [];
  private lastVoicedT = -Infinity;
  private recentRms: { t: number; rms: number }[] = [];
  private smooth: number[] = [];
  readonly notes: Note[] = [];
  /** Fractional MIDI of the latest voiced frame (for display), NaN when silent. */
  currentPitch = NaN;

  constructor(public opts: TrackerOptions, private readonly frameSec: number) {}

  /** Whether a note is currently sounding. */
  get sounding(): boolean {
    return this.active !== null;
  }

  push(frame: TrackerFrame): TrackerEvent[] {
    const o = this.opts;
    const events: TrackerEvent[] = [];
    const voiced = frame.freq > 0 && frame.clarity >= o.clarityGate && frame.rms >= o.rmsGate;

    // Onset detection on the RMS envelope.
    this.recentRms.push({ t: frame.t, rms: frame.rms });
    while (this.recentRms.length && frame.t - this.recentRms[0].t > 0.09) this.recentRms.shift();
    let minRecent = Infinity;
    for (let i = 0; i < this.recentRms.length - 1; i++) minRecent = Math.min(minRecent, this.recentRms[i].rms);
    const onset = frame.rms > o.rmsGate * 3 && frame.rms > minRecent * o.onsetRatio;

    if (!voiced) {
      this.smooth.length = 0;
      this.currentPitch = NaN;
      if (this.active && frame.t - this.lastVoicedT > o.maxGapSec) {
        this.finish(this.lastVoicedT + this.frameSec, events);
      }
      if (!this.active && this.candidate.length && frame.t - this.candidate[this.candidate.length - 1].t > o.maxGapSec) {
        this.candidate = [];
      }
      return events;
    }

    // 3-frame median removes single-frame octave glitches.
    const mRaw = freqToMidi(frame.freq, o.a4);
    this.smooth.push(mRaw);
    if (this.smooth.length > 3) this.smooth.shift();
    const m = this.smooth.length === 3 ? median(this.smooth) : mRaw;
    this.currentPitch = m;
    this.lastVoicedT = frame.t;
    const v: Voiced = { t: frame.t, m, rms: frame.rms };

    if (this.active) {
      const centre = median(this.active.values.map((x) => x.m));
      const age = frame.t - this.active.start;
      // The onset window (90 ms) must lie entirely after the note's own attack, otherwise a
      // gradual swell (sung onsets) would look like a re-articulation.
      if (onset && age > o.minNoteSec + 0.1 && Math.abs(m - centre) <= o.changeSemitones) {
        this.finish(frame.t, events);
        this.begin([v], events, true);
        return events;
      }
      if (Math.abs(m - centre) <= o.changeSemitones) {
        this.deviation = [];
        this.active.values.push(v);
        if (age < 0.12) this.active.peak = Math.max(this.active.peak, frame.rms);
        return events;
      }
      this.deviation.push(v);
      // Keep only the trailing run of mutually consistent deviant frames.
      const devCentre = median(this.deviation.map((x) => x.m));
      while (this.deviation.length > 1 && Math.abs(this.deviation[0].m - devCentre) > o.changeSemitones) {
        this.deviation.shift();
      }
      const span = this.deviation[this.deviation.length - 1].t - this.deviation[0].t;
      if (span >= o.changeSec) {
        const dev = this.deviation;
        this.deviation = [];
        this.finish(dev[0].t, events);
        this.begin(dev, events);
      }
      return events;
    }

    // Building a candidate note.
    if (this.candidate.length) {
      const c = median(this.candidate.map((x) => x.m));
      if (Math.abs(m - c) > o.changeSemitones) this.candidate = [];
    }
    this.candidate.push(v);
    const span = this.candidate[this.candidate.length - 1].t - this.candidate[0].t;
    if (span >= o.confirmSec) {
      const cand = this.candidate;
      this.candidate = [];
      this.begin(cand, events);
    }
    return events;
  }

  /** Ends any sounding note at time t and returns all notes. */
  flush(t: number): Note[] {
    if (this.active) this.finish(Math.min(t, this.lastVoicedT + this.frameSec), []);
    this.candidate = [];
    return this.notes;
  }

  /** The note currently sounding (provisional), for live display. */
  activeNote(now: number): Note | null {
    if (!this.active) return null;
    const raw = median(this.active.values.map((x) => x.m));
    return {
      id: 0,
      midi: Math.round(raw),
      raw,
      start: this.active.start,
      end: now,
      velocity: rmsToVelocity(this.active.peak),
    };
  }

  private begin(values: Voiced[], events: TrackerEvent[], articulated = false): void {
    const peak = Math.max(...values.map((x) => x.rms));
    this.active = { start: values[0].t, values: values.slice(), peak, articulated };
    const raw = median(values.map((x) => x.m));
    events.push({ type: 'on', midi: Math.round(raw), raw, t: values[0].t, velocity: rmsToVelocity(peak) });
  }

  private finish(end: number, events: TrackerEvent[]): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.deviation = [];
    if (end - a.start < this.opts.minNoteSec) {
      const raw = median(a.values.map((x) => x.m));
      events.push({ type: 'off', note: { id: 0, midi: Math.round(raw), raw, start: a.start, end, velocity: 0 }, discarded: true });
      return;
    }
    // Skip the attack when estimating pitch: plucks and sung onsets are often sharp/flat.
    const settled = a.values.filter((x) => x.t - a.start > 0.03);
    const raw = median((settled.length >= 3 ? settled : a.values).map((x) => x.m));
    const note: Note = {
      id: newNoteId(),
      midi: Math.round(raw),
      raw,
      start: a.start,
      end,
      velocity: rmsToVelocity(a.peak),
    };
    // Merge with the previous note if it is the same pitch and practically touching.
    const prev = this.notes[this.notes.length - 1];
    if (prev && !a.articulated && prev.midi === note.midi && note.start - prev.end < 0.02) {
      prev.end = note.end;
    } else {
      this.notes.push(note);
    }
    events.push({ type: 'off', note, discarded: false });
  }
}

/** Offline transcription of a full list of frames. */
export function transcribe(frames: TrackerFrame[], opts: TrackerOptions, frameSec: number): Note[] {
  const tracker = new NoteTracker(opts, frameSec);
  for (const f of frames) tracker.push(f);
  const last = frames.length ? frames[frames.length - 1].t + frameSec : 0;
  return tracker.flush(last);
}
