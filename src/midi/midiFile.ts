// Standard MIDI File (format 1) writer.

export interface MidiFileNote {
  midi: number;
  /** Seconds. */
  start: number;
  end: number;
  velocity: number;
}

export interface MidiFileTrack {
  name: string;
  channel: number; // 1..16
  program: number | null; // GM program, null for drums
  notes: MidiFileNote[];
}

const PPQ = 480;

function vlq(value: number): number[] {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function str(s: string): number[] {
  return [...new TextEncoder().encode(s)];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type: string, data: number[]): number[] {
  return [...str(type), ...u32(data.length), ...data];
}

export function writeMidiFile(tracks: MidiFileTrack[], bpm: number): Uint8Array {
  const secToTicks = (s: number) => Math.round((s * bpm * PPQ) / 60);
  const usPerBeat = Math.round(60_000_000 / bpm);

  const tempo: number[] = [
    0, 0xff, 0x51, 0x03, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255,
    0, 0xff, 0x58, 0x04, 4, 2, 24, 8,
    0, 0xff, 0x2f, 0x00,
  ];
  const chunks = [chunk('MTrk', tempo)];

  for (const t of tracks) {
    const ch = (t.channel - 1) & 15;
    const name = str(t.name);
    const data: number[] = [0, 0xff, 0x03, ...vlq(name.length), ...name];
    if (t.program !== null) data.push(0, 0xc0 | ch, t.program & 127);
    const events: { tick: number; order: number; bytes: number[] }[] = [];
    for (const n of t.notes) {
      const on = secToTicks(n.start);
      const off = Math.max(on + 1, secToTicks(n.end));
      events.push({ tick: on, order: 1, bytes: [0x90 | ch, n.midi & 127, Math.max(1, Math.min(127, Math.round(n.velocity)))] });
      events.push({ tick: off, order: 0, bytes: [0x80 | ch, n.midi & 127, 0] });
    }
    // Note-offs before note-ons at the same tick so repeated notes retrigger cleanly.
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    let last = 0;
    for (const e of events) {
      data.push(...vlq(e.tick - last), ...e.bytes);
      last = e.tick;
    }
    data.push(0, 0xff, 0x2f, 0x00);
    chunks.push(chunk('MTrk', data));
  }

  const header = chunk('MThd', [0, 1, (chunks.length >> 8) & 255, chunks.length & 255, (PPQ >> 8) & 255, PPQ & 255]);
  const bytes = [...header, ...chunks.flat()];
  return new Uint8Array(bytes);
}
