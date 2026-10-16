export interface Voice {
  /** Begin the release at `time` (context seconds). */
  stop(time: number): void;
  /** Detune the voice by `cents` (live pitch bend). */
  bend(cents: number, time: number): void;
}

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface Instrument {
  id: string;
  name: string;
  group: 'synth' | 'sampled';
  /** General MIDI program used when exporting MIDI. */
  gmProgram: number;
  state(): LoadState;
  load(ctx: BaseAudioContext): Promise<void>;
  /**
   * Builds the per-track effect chain feeding `dest`; voices connect to the returned node.
   * Always a new node owned by the caller, so disconnecting it never cuts off `dest`.
   */
  createBus(ctx: BaseAudioContext, dest: AudioNode): AudioNode;
  /** Starts a note; with `duration` the release is scheduled automatically. */
  play(ctx: BaseAudioContext, bus: AudioNode, midi: number, velocity: number, time: number, duration?: number): Voice;
}

export const SILENT_VOICE: Voice = { stop() {}, bend() {} };
