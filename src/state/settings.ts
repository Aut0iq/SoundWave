// User settings, persisted in localStorage.

import { scaleMask } from '../dsp/music';
import type { Voicing } from '../dsp/harmony';
import { DEFAULT_INSTRUMENT } from '../audio/instruments';

export type SourceKind = 'voice' | 'guitar';
export type BendMode = 'off' | 'hold' | 'follow';
export type LatencyMode = 'low' | 'stable';

export interface PadConfig {
  name: string;
  sound: string;
  note: number;
}

export interface Settings {
  version: number;
  deviceId: string;
  source: SourceKind;
  latency: LatencyMode;
  gateDb: number;
  a4: number;
  key: number;
  scaleId: string;
  /** Custom set of allowed notes; overrides key+scale when not null. */
  customMask: number | null;

  liveSound: boolean;
  liveInstrument: string;
  keyLock: boolean;
  chord: string;
  voicing: Voicing;
  octave: number;
  bendMode: BendMode;
  bendRange: number;
  velocityMode: 'dynamic' | 'fixed';
  fixedVelocity: number;
  envCC: boolean;
  envCCNum: number;
  timbreCC: boolean;
  timbreCCNum: number;

  midiPort: string;
  /** MIDI input carrying FL Studio's reports back (often the same loopMIDI port). */
  midiInPort: string;
  midiChannel: number;
  drumChannel: number;
  flTempo: boolean;
  flNewTake: boolean;

  triggersEnabled: boolean;
  triggerDb: number;
  pads: PadConfig[];

  tuneSpeed: number;
  tuneAmount: number;
  tuneMix: number;
  monitor: boolean;
  monitorLevel: number;

  bpm: number;
  metronome: boolean;
  countIn: boolean;
  /** Manual recording latency compensation (ms); null = automatic estimate. */
  latencyMs: number | null;
  quantize: number;
}

export const DEFAULT_PADS: PadConfig[] = [
  { name: 'Бочка («б», «пф»)', sound: 'kick', note: 36 },
  { name: 'Малый («пш», «к»)', sound: 'snare', note: 38 },
  { name: 'Хэт («тс»)', sound: 'hatClosed', note: 42 },
  { name: 'Открытый хэт («тссс»)', sound: 'hatOpen', note: 46 },
  { name: 'Хлопок', sound: 'clap', note: 39 },
  { name: 'Том', sound: 'tomLow', note: 45 },
  { name: 'Римшот', sound: 'rim', note: 37 },
  { name: 'Тарелка', sound: 'crash', note: 49 },
];

export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  deviceId: '',
  source: 'voice',
  latency: 'stable',
  gateDb: -45,
  a4: 440,
  key: 0,
  scaleId: 'chromatic',
  customMask: null,

  liveSound: true,
  liveInstrument: DEFAULT_INSTRUMENT,
  keyLock: true,
  chord: 'off',
  voicing: 'close',
  octave: 0,
  bendMode: 'off',
  bendRange: 2,
  velocityMode: 'dynamic',
  fixedVelocity: 100,
  envCC: false,
  envCCNum: 11,
  timbreCC: false,
  timbreCCNum: 74,

  midiPort: '',
  midiInPort: '',
  midiChannel: 1,
  drumChannel: 10,
  flTempo: true,
  flNewTake: true,

  triggersEnabled: false,
  triggerDb: -36,
  pads: DEFAULT_PADS,

  tuneSpeed: 0.3,
  tuneAmount: 1,
  tuneMix: 1,
  monitor: false,
  monitorLevel: 0.9,

  bpm: 100,
  metronome: true,
  countIn: true,
  latencyMs: null,
  quantize: 0,
};

const KEY = 'soundwave.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      const s = { ...DEFAULT_SETTINGS, ...saved } as Settings;
      if (!Array.isArray(s.pads) || s.pads.length !== DEFAULT_PADS.length) s.pads = DEFAULT_PADS;
      if (!((saved.version ?? 1) >= 2)) {
        // v1 shipped a very fast (robotic) default retune speed that makes held notes warble.
        if (s.tuneSpeed === 0.1) s.tuneSpeed = DEFAULT_SETTINGS.tuneSpeed;
        s.version = 2;
      }
      return s;
    }
  } catch {
    // Corrupt storage: fall back to defaults.
  }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage full or disabled.
  }
}

export function currentMask(s: Settings): number {
  return s.customMask ?? scaleMask(s.key, s.scaleId);
}
