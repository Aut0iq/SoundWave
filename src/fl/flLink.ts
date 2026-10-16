// Link with FL Studio: transport commands and state reports over MIDI (see fl/device_SoundWave.py),
// plus the dev-server bridge for installing the script and saving takes into FL's browser.

export const FL_CHANNEL = 16;
export const FL_CC = {
  record: 102,
  play: 103,
  stop: 104,
  hello: 105,
  tempoMsb: 20,
  tempoLsb: 52,
  playing: 21,
  recording: 22,
} as const;

export interface FlState {
  /** Seconds since the last message from FL (Infinity if never). */
  age: number;
  tempo: number;
  playing: boolean;
  recording: boolean;
  /** Tempo came from MIDI clock rather than the SoundWave script. */
  viaClock: boolean;
}

/** Parses what FL sends back: SoundWave-script reports and/or standard MIDI clock. */
export class FlSync {
  private lastSeen = -Infinity;
  private tempoMsb = 0;
  private clockTimes: number[] = [];
  tempo = 0;
  playing = false;
  recording = false;
  viaClock = false;
  onChange: (changed: { tempo?: boolean; playing?: boolean; recording?: boolean }) => void = () => {};

  /** Handles one incoming MIDI message; `now` in seconds. */
  handle(data: Uint8Array, now: number): void {
    const status = data[0];
    if (status === 0xf8) {
      // MIDI clock: 24 pulses per quarter note.
      this.clockTimes.push(now);
      if (this.clockTimes.length > 49) this.clockTimes.shift();
      if (this.clockTimes.length >= 25) {
        const span = this.clockTimes[this.clockTimes.length - 1] - this.clockTimes[0];
        const bpm = (60 * (this.clockTimes.length - 1)) / 24 / span;
        if (bpm > 20 && bpm < 400 && (this.viaClock || this.tempo === 0) && Math.abs(bpm - this.tempo) > 0.5) {
          this.tempo = Math.round(bpm * 10) / 10;
          this.viaClock = true;
          this.onChange({ tempo: true });
        }
      }
      this.lastSeen = now;
      return;
    }
    if (status === 0xfa || status === 0xfb || status === 0xfc) {
      const playing = status !== 0xfc;
      if (playing !== this.playing) {
        this.playing = playing;
        this.onChange({ playing: true });
      }
      if (!playing) this.clockTimes = [];
      this.lastSeen = now;
      return;
    }
    if (status !== 0xb0 + (FL_CHANNEL - 1) || data.length < 3) return;
    const [, cc, v] = data;
    if (cc === FL_CC.tempoMsb) {
      this.tempoMsb = v;
    } else if (cc === FL_CC.tempoLsb) {
      const tempo = ((this.tempoMsb << 7) | v) / 10;
      this.viaClock = false;
      if (tempo > 0 && Math.abs(tempo - this.tempo) > 0.05) {
        this.tempo = tempo;
        this.onChange({ tempo: true });
      }
    } else if (cc === FL_CC.playing) {
      const playing = v >= 64;
      if (playing !== this.playing) {
        this.playing = playing;
        this.onChange({ playing: true });
      }
    } else if (cc === FL_CC.recording) {
      const recording = v >= 64;
      if (recording !== this.recording) {
        this.recording = recording;
        this.onChange({ recording: true });
      }
    } else {
      return;
    }
    this.lastSeen = now;
  }

  state(now: number): FlState {
    return { age: now - this.lastSeen, tempo: this.tempo, playing: this.playing, recording: this.recording, viaClock: this.viaClock };
  }
}

// ---------------------------------------------------------------------------
// Dev-server bridge (server/flBridge.ts).

export interface BridgeStatus {
  platform: string;
  flInstalled: boolean;
  flRunning: boolean;
  script: 'missing' | 'outdated' | 'installed';
  scriptDir: string;
  captures: string;
  loopMidiInstalled: boolean;
  loopMidiRunning: boolean;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'X-SoundWave': '1', ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const bridge = {
  status: () => call<BridgeStatus>('/api/fl/status'),
  installScript: () => call<{ path: string }>('/api/fl/install-script', { method: 'POST' }),
  startLoopMidi: () => call<{ ok: true }>('/api/fl/start-loopmidi', { method: 'POST' }),
  openFl: () => call<{ ok: true }>('/api/fl/open', { method: 'POST' }),
  revealCaptures: () => call<{ ok: true }>('/api/fl/reveal', { method: 'POST' }),
  saveMidi: (name: string, bytes: Uint8Array) =>
    call<{ path: string }>(`/api/fl/save-midi?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/midi' },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
};
