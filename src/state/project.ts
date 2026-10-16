// Studio project model: tracks of notes, optional recorded audio, and helpers to edit them.

import { newNoteId, type Note } from '../dsp/noteTracker';
import { snapToScale } from '../dsp/music';

export type PlayMode = 'instrument' | 'voice' | 'tuned' | 'instrument+voice' | 'instrument+tuned';

export const PLAY_MODES: { id: PlayMode; name: string }[] = [
  { id: 'instrument', name: 'Инструмент' },
  { id: 'voice', name: 'Голос (оригинал)' },
  { id: 'tuned', name: 'Голос + автотюн' },
  { id: 'instrument+voice', name: 'Инструмент + голос' },
  { id: 'instrument+tuned', name: 'Инструмент + голос с автотюном' },
];

export interface Track {
  id: number;
  name: string;
  color: string;
  kind: 'melody' | 'drums';
  instrumentId: string;
  volume: number;
  muted: boolean;
  solo: boolean;
  playMode: PlayMode;
  notes: Note[];
  /** Mono recording of the take, if any. */
  audio: Float32Array | null;
  sampleRate: number;
  /** Project time (s) of the first audio sample. */
  audioStart: number;
  /** Detected pitch over time, for display. */
  curve: { t: number; m: number }[];
}

export interface Project {
  bpm: number;
  tracks: Track[];
}

const COLORS = ['#7c5cff', '#22c3a6', '#ff7a59', '#f5c542', '#4aa8ff', '#ff5c9a', '#9be15d', '#c38bff'];

let nextTrackId = 1;

export function newTrack(project: Project, init: Partial<Track>): Track {
  const id = Math.max(nextTrackId, ...project.tracks.map((t) => t.id + 1));
  nextTrackId = id + 1;
  return {
    id,
    name: `Дорожка ${id}`,
    color: COLORS[(id - 1) % COLORS.length],
    kind: 'melody',
    instrumentId: 'sf-piano',
    volume: 0.8,
    muted: false,
    solo: false,
    playMode: 'instrument',
    notes: [],
    audio: null,
    sampleRate: 48000,
    audioStart: 0,
    curve: [],
    ...init,
  };
}

export function projectEnd(p: Project): number {
  let end = 0;
  for (const t of p.tracks) {
    for (const n of t.notes) end = Math.max(end, n.end);
    if (t.audio) end = Math.max(end, t.audioStart + t.audio.length / t.sampleRate);
  }
  return end;
}

export function audibleTracks(p: Project): Track[] {
  const solo = p.tracks.some((t) => t.solo);
  return p.tracks.filter((t) => (solo ? t.solo : !t.muted));
}

export const QUANTIZE_GRIDS: { value: number; name: string }[] = [
  { value: 0, name: 'Без квантизации' },
  { value: 4, name: '1/4' },
  { value: 8, name: '1/8' },
  { value: 16, name: '1/16' },
  { value: 12, name: '1/8 триоль' },
];

/** Snaps note starts/ends to a grid of 1/`division` notes. */
export function quantizeNotes(notes: Note[], bpm: number, division: number): Note[] {
  if (!division) return notes;
  const step = (60 / bpm) * (4 / division);
  return notes.map((n) => {
    const start = Math.round(n.start / step) * step;
    const end = Math.max(start + step, Math.round(n.end / step) * step);
    return { ...n, start, end };
  });
}

export function snapNotesToScale(notes: Note[], mask: number): Note[] {
  return notes.map((n) => ({ ...n, midi: snapToScale(n.raw, mask) }));
}

/** Removes very short notes and merges same-pitch notes separated by tiny gaps. */
export function cleanupNotes(notes: Note[], minSec = 0.08, gapSec = 0.03): Note[] {
  const sorted = notes.filter((n) => n.end - n.start >= minSec).sort((a, b) => a.start - b.start);
  const out: Note[] = [];
  for (const n of sorted) {
    const prev = out.findLast((p) => p.midi === n.midi);
    if (prev && n.start - prev.end <= gapSec && n.start >= prev.start) {
      prev.end = Math.max(prev.end, n.end);
    } else {
      out.push({ ...n });
    }
  }
  return out;
}

export function transposeNotes(notes: Note[], semitones: number): Note[] {
  return notes.map((n) => ({ ...n, midi: Math.max(0, Math.min(127, n.midi + semitones)), raw: n.raw + semitones }));
}

export function cloneNote(n: Note): Note {
  return { ...n, id: newNoteId() };
}
