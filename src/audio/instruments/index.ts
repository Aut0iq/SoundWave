import { createSampledInstruments } from './sampler';
import { createSynthInstruments } from './synth';
import type { Instrument } from './types';

export type { Instrument, Voice } from './types';

export const INSTRUMENTS: Instrument[] = [...createSampledInstruments(), ...createSynthInstruments()];

export const DEFAULT_INSTRUMENT = 'sf-piano';
export const OFFLINE_FALLBACK = 'syn-piano';

export function getInstrument(id: string): Instrument {
  return INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS.find((i) => i.id === OFFLINE_FALLBACK)!;
}

/**
 * Returns the instrument if it can play right now, otherwise its offline counterpart
 * (so playback never goes silent while samples download or when offline).
 */
export function playableInstrument(id: string): Instrument {
  const inst = getInstrument(id);
  if (inst.state() === 'ready') return inst;
  const synth = INSTRUMENTS.filter((i) => i.group === 'synth');
  return synth.find((s) => s.gmProgram === inst.gmProgram) ?? synth.find((s) => Math.abs(s.gmProgram - inst.gmProgram) < 8) ?? getInstrument(OFFLINE_FALLBACK);
}
