// Always-on capture of what the voice -> MIDI performer played, so a take can be saved afterwards.

import { newNoteId, type Note } from '../dsp/noteTracker';

interface Open {
  notes: number[];
  root: number;
  raw: number;
  velocity: number;
  t: number;
}

export class NoteCapture {
  private notes: Note[] = [];
  private open: Open | null = null;
  /** Context time the take is measured from (e.g. when FL started recording); null = first note. */
  private anchor: number | null = null;

  noteOn(notes: number[], root: number, raw: number, velocity: number, t: number): void {
    this.open = { notes, root, raw, velocity, t };
  }

  noteOff(t: number, discarded: boolean): void {
    const o = this.open;
    this.open = null;
    if (!o || discarded) return;
    for (const m of o.notes) {
      this.notes.push({ id: newNoteId(), midi: m, raw: o.raw + (m - o.root), start: o.t, end: Math.max(t, o.t + 0.03), velocity: o.velocity });
    }
  }

  /** Starts a new take; `anchor` aligns time zero with an external event. */
  clear(anchor: number | null = null): void {
    this.notes = [];
    this.open = null;
    this.anchor = anchor;
  }

  get empty(): boolean {
    return this.notes.length === 0 && this.open === null;
  }

  /** The take so far, with the sounding note closed at `now` and time zero at the anchor or first note. */
  take(now: number): Note[] {
    const all = this.notes.map((n) => ({ ...n }));
    if (this.open) {
      const o = this.open;
      for (const m of o.notes) all.push({ id: newNoteId(), midi: m, raw: o.raw + (m - o.root), start: o.t, end: Math.max(now, o.t + 0.03), velocity: o.velocity });
    }
    if (!all.length) return [];
    const origin = this.anchor ?? Math.min(...all.map((n) => n.start));
    return all
      .map((n) => ({ ...n, start: n.start - origin, end: n.end - origin }))
      .filter((n) => n.end > 0)
      .map((n) => ({ ...n, start: Math.max(0, n.start) }))
      .sort((a, b) => a.start - b.start);
  }

  summary(now: number): { notes: number; seconds: number } {
    const t = this.take(now);
    return { notes: t.length, seconds: t.length ? Math.max(...t.map((n) => n.end)) : 0 };
  }
}
