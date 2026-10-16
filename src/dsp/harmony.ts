// Chords built from a sung root note, and key detection from a note histogram.

import { mod, NOTE_NAMES_RU, SCALES } from './music';

export interface ChordType {
  id: string;
  name: string;
  /** Intervals above the root; `null` means "diatonic, stacked thirds in the current key". */
  intervals: number[] | null;
  /** Number of diatonic notes when intervals is null. */
  size?: number;
}

export const CHORD_TYPES: ChordType[] = [
  { id: 'off', name: 'Выкл. (одна нота)', intervals: [0] },
  { id: 'diatonic3', name: 'Трезвучие в тональности', intervals: null, size: 3 },
  { id: 'diatonic7', name: 'Септаккорд в тональности', intervals: null, size: 4 },
  { id: 'major', name: 'Мажорное трезвучие', intervals: [0, 4, 7] },
  { id: 'minor', name: 'Минорное трезвучие', intervals: [0, 3, 7] },
  { id: 'power', name: 'Квинта (power chord)', intervals: [0, 7, 12] },
  { id: 'sus2', name: 'Sus2', intervals: [0, 2, 7] },
  { id: 'sus4', name: 'Sus4', intervals: [0, 5, 7] },
  { id: 'maj7', name: 'Большой мажорный септ', intervals: [0, 4, 7, 11] },
  { id: 'min7', name: 'Минорный септ', intervals: [0, 3, 7, 10] },
  { id: 'dom7', name: 'Доминантсепт', intervals: [0, 4, 7, 10] },
  { id: 'octave', name: 'Октава', intervals: [0, 12] },
];

export type Voicing = 'close' | 'open' | 'bass';

export const VOICINGS: { id: Voicing; name: string }[] = [
  { id: 'close', name: 'Тесное' },
  { id: 'open', name: 'Широкое' },
  { id: 'bass', name: 'С басом (октава вниз)' },
];

/** Notes of the scale defined by `mask` that lie at or above `root`, in order. */
function scaleNotesFrom(root: number, mask: number, count: number): number[] {
  const out: number[] = [];
  for (let n = root; out.length < count && n < root + 48; n++) {
    if (mask & (1 << mod(n, 12))) out.push(n);
  }
  return out;
}

export function buildChord(root: number, typeId: string, voicing: Voicing, mask: number): number[] {
  const type = CHORD_TYPES.find((c) => c.id === typeId) ?? CHORD_TYPES[0];
  let notes: number[];
  if (type.intervals) {
    notes = type.intervals.map((i) => root + i);
  } else {
    const size = type.size ?? 3;
    const useMask = mask & (1 << mod(root, 12)) ? mask : mask | (1 << mod(root, 12));
    const run = scaleNotesFrom(root, useMask, size * 2);
    notes = [];
    for (let i = 0; i < size && i * 2 < run.length; i++) notes.push(run[i * 2]);
  }
  if (notes.length > 1) {
    if (voicing === 'open' && notes.length >= 3) {
      notes = notes.slice();
      notes[1] += 12; // drop-2 style spread: lift the third an octave
    } else if (voicing === 'bass') {
      notes = [root - 12, ...notes];
    }
  }
  return [...new Set(notes)].filter((n) => n >= 0 && n <= 127).sort((a, b) => a - b);
}

// Krumhansl-Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export interface KeyGuess {
  key: number;
  scaleId: 'major' | 'minor';
  confidence: number;
  label: string;
}

/** Duration-weighted pitch-class histogram -> most likely major/minor key. */
export function detectKey(notes: { midi: number; start: number; end: number }[]): KeyGuess | null {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[mod(n.midi, 12)] += Math.max(0.05, n.end - n.start);
  if (hist.every((x) => x === 0)) return null;
  let best: KeyGuess | null = null;
  for (let k = 0; k < 12; k++) {
    for (const [scaleId, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]] as const) {
      const rotated = profile.map((_, i) => profile[mod(i - k, 12)]);
      const r = correlation(hist, rotated);
      if (!best || r > best.confidence) {
        const scaleName = SCALES.find((s) => s.id === scaleId)!.name.toLowerCase();
        best = { key: k, scaleId, confidence: r, label: `${NOTE_NAMES_RU[k]} ${scaleName}` };
      }
    }
  }
  return best;
}
