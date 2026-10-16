// Music theory helpers: pitch <-> MIDI conversion, note names, scales.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_RU = ['До', 'До♯', 'Ре', 'Ре♯', 'Ми', 'Фа', 'Фа♯', 'Соль', 'Соль♯', 'Ля', 'Ля♯', 'Си'];

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function noteName(midi: number): string {
  const n = Math.round(midi);
  return NOTE_NAMES[mod(n, 12)] + (Math.floor(n / 12) - 1);
}

export function noteNameRu(midi: number): string {
  return NOTE_NAMES_RU[mod(Math.round(midi), 12)];
}

export interface Scale {
  id: string;
  name: string;
  steps: number[];
}

export const SCALES: Scale[] = [
  { id: 'chromatic', name: 'Хроматическая (все ноты)', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'major', name: 'Мажор', steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', name: 'Натуральный минор', steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonic', name: 'Гармонический минор', steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'pentaMajor', name: 'Пентатоника мажорная', steps: [0, 2, 4, 7, 9] },
  { id: 'pentaMinor', name: 'Пентатоника минорная', steps: [0, 3, 5, 7, 10] },
  { id: 'blues', name: 'Блюзовая', steps: [0, 3, 5, 6, 7, 10] },
  { id: 'dorian', name: 'Дорийский лад', steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'mixolydian', name: 'Миксолидийский лад', steps: [0, 2, 4, 5, 7, 9, 10] },
];

/** 12-bit mask: bit i set => pitch class i belongs to the scale. */
export function scaleMask(key: number, scaleId: string): number {
  const scale = SCALES.find((s) => s.id === scaleId) ?? SCALES[0];
  let mask = 0;
  for (const step of scale.steps) mask |= 1 << mod(key + step, 12);
  return mask;
}

export const CHROMATIC_MASK = 0xfff;

/** Nearest integer MIDI note whose pitch class is in the mask. */
export function snapToScale(midi: number, mask: number): number {
  if (mask === 0) return Math.round(midi);
  const base = Math.round(midi);
  let best = base;
  let bestDist = Infinity;
  for (let d = -6; d <= 6; d++) {
    const n = base + d;
    if (!(mask & (1 << mod(n, 12)))) continue;
    const dist = Math.abs(n - midi);
    if (dist < bestDist) {
      bestDist = dist;
      best = n;
    }
  }
  return best;
}

export function inScale(midi: number, mask: number): boolean {
  return (mask & (1 << mod(Math.round(midi), 12))) !== 0;
}
