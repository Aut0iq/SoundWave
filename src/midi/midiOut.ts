// Live MIDI through the Web MIDI API: notes out to a DAW (e.g. via a loopMIDI virtual port)
// and an optional input for messages coming back (FL Studio sync).

export interface MidiPort {
  id: string;
  name: string;
}

export class MidiOut {
  private access: MIDIAccess | null = null;
  private port: MIDIOutput | null = null;
  private input: MIDIInput | null = null;
  private sounding = new Map<string, number>();
  onPortsChanged: () => void = () => {};
  onMessage: (data: Uint8Array, timeStamp: number) => void = () => {};

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  async init(): Promise<void> {
    if (this.access || !this.supported) return;
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => this.onPortsChanged();
  }

  get ready(): boolean {
    return this.access !== null;
  }

  ports(): MidiPort[] {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map((o) => ({ id: o.id, name: o.name ?? o.id }));
  }

  inputs(): MidiPort[] {
    if (!this.access) return [];
    return [...this.access.inputs.values()].map((i) => ({ id: i.id, name: i.name ?? i.id }));
  }

  get inputConnected(): boolean {
    return this.input !== null;
  }

  get outputId(): string | null {
    return this.port?.id ?? null;
  }

  get inputId(): string | null {
    return this.input?.id ?? null;
  }

  select(id: string | null): void {
    this.allNotesOff();
    this.port = id && this.access ? this.access.outputs.get(id) ?? null : null;
  }

  selectInput(id: string | null): void {
    if (this.input) this.input.onmidimessage = null;
    this.input = id && this.access ? this.access.inputs.get(id) ?? null : null;
    if (this.input) {
      this.input.onmidimessage = (e: MIDIMessageEvent) => {
        if (e.data) this.onMessage(e.data, e.timeStamp);
      };
    }
  }

  private send(bytes: number[], timestamp?: number): void {
    if (!this.port) return;
    try {
      this.port.send(bytes, timestamp);
    } catch {
      // Port vanished; ignore until the user picks another one.
    }
  }

  noteOn(channel: number, note: number, velocity: number): void {
    const ch = (channel - 1) & 15;
    this.sounding.set(`${ch}:${note}`, ch);
    this.send([0x90 | ch, note & 127, Math.max(1, Math.min(127, Math.round(velocity)))]);
  }

  noteOff(channel: number, note: number): void {
    const ch = (channel - 1) & 15;
    this.sounding.delete(`${ch}:${note}`);
    this.send([0x80 | ch, note & 127, 0]);
  }

  /** `semitones` relative to the note, mapped onto a +-`range` semitone bend. */
  pitchBend(channel: number, semitones: number, range: number): void {
    const ch = (channel - 1) & 15;
    const v = Math.max(0, Math.min(16383, Math.round(8192 + (semitones / range) * 8192)));
    this.send([0xe0 | ch, v & 127, (v >> 7) & 127]);
  }

  cc(channel: number, controller: number, value: number): void {
    const ch = (channel - 1) & 15;
    this.send([0xb0 | ch, controller & 127, Math.max(0, Math.min(127, Math.round(value)))]);
  }

  /** Sets the receiver's pitch-bend range via RPN 0. */
  bendRange(channel: number, semitones: number): void {
    this.cc(channel, 101, 0);
    this.cc(channel, 100, 0);
    this.cc(channel, 6, semitones);
    this.cc(channel, 38, 0);
    this.cc(channel, 101, 127);
    this.cc(channel, 100, 127);
  }

  allNotesOff(): void {
    for (const key of this.sounding.keys()) {
      const [ch, note] = key.split(':').map(Number);
      this.send([0x80 | ch, note, 0]);
    }
    this.sounding.clear();
    for (let ch = 0; ch < 16; ch++) {
      this.send([0xb0 | ch, 123, 0]);
      this.send([0xe0 | ch, 0, 64]);
    }
  }
}
