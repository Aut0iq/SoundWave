import { describe, expect, it } from 'vitest';
import { buildChord, detectKey } from '../src/dsp/harmony';
import { scaleMask } from '../src/dsp/music';
import { writeMidiFile } from '../src/midi/midiFile';
import { fft, HIT_LENGTH, HitClassifier, hitFeatures, OnsetDetector } from '../src/dsp/triggers';
import { cleanupNotes, quantizeNotes } from '../src/state/project';
import { SR } from './helpers';

describe('chords', () => {
  const cMajor = scaleMask(0, 'major');

  it('builds diatonic triads in the key', () => {
    expect(buildChord(60, 'diatonic3', 'close', cMajor)).toEqual([60, 64, 67]); // C
    expect(buildChord(62, 'diatonic3', 'close', cMajor)).toEqual([62, 65, 69]); // Dm
    expect(buildChord(71, 'diatonic3', 'close', cMajor)).toEqual([71, 74, 77]); // Bdim
    expect(buildChord(67, 'diatonic7', 'close', cMajor)).toEqual([67, 71, 74, 77]); // G7
  });

  it('builds fixed chord shapes and voicings', () => {
    expect(buildChord(57, 'minor', 'close', cMajor)).toEqual([57, 60, 64]);
    expect(buildChord(60, 'power', 'close', cMajor)).toEqual([60, 67, 72]);
    expect(buildChord(60, 'major', 'open', cMajor)).toEqual([60, 67, 76]);
    expect(buildChord(60, 'major', 'bass', cMajor)).toEqual([48, 60, 64, 67]);
    expect(buildChord(60, 'off', 'bass', cMajor)).toEqual([60]);
  });
});

describe('key detection', () => {
  const melody = (pcs: number[], base = 60) =>
    pcs.map((pc, i) => ({ midi: base + pc, start: i * 0.4, end: i * 0.4 + 0.35 }));

  it('finds a major key from a scale-wise melody', () => {
    // G major: G A B C D E F# G with tonic emphasis
    const k = detectKey(melody([7, 9, 11, 0, 2, 4, 6, 7, 7, 11, 2, 7]));
    expect(k?.key).toBe(7);
    expect(k?.scaleId).toBe('major');
  });

  it('finds a minor key', () => {
    // A minor arpeggios and scale
    const k = detectKey(melody([9, 0, 4, 9, 11, 0, 2, 4, 5, 4, 0, 9, 9, 4]));
    expect(k?.key).toBe(9);
    expect(k?.scaleId).toBe('minor');
  });
});

describe('MIDI file', () => {
  it('writes a valid format-1 file', () => {
    const bytes = writeMidiFile(
      [{ name: 'Тест', channel: 1, program: 24, notes: [{ midi: 60, start: 0, end: 0.5, velocity: 100 }] }],
      120,
    );
    const ascii = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4));
    expect(ascii(0)).toBe('MThd');
    expect(bytes[9]).toBe(1); // format 1
    expect(bytes[11]).toBe(2); // tempo track + one note track
    expect((bytes[12] << 8) | bytes[13]).toBe(480);
    expect(ascii(14)).toBe('MTrk');
    // Note-on C4 velocity 100 and its note-off one beat later (0.5 s at 120 bpm = 480 ticks).
    const s = Array.from(bytes);
    const on = s.findIndex((b, i) => b === 0x90 && s[i + 1] === 60 && s[i + 2] === 100);
    expect(on).toBeGreaterThan(0);
    const off = s.findIndex((b, i) => i > on && b === 0x80 && s[i + 1] === 60);
    expect(s.slice(off - 2, off)).toEqual([0x83, 0x60]); // VLQ 480
  });
});

describe('note editing helpers', () => {
  it('quantizes to the grid', () => {
    const q = quantizeNotes([{ id: 1, midi: 60, raw: 60, start: 0.27, end: 0.71, velocity: 90 }], 120, 8);
    expect(q[0].start).toBeCloseTo(0.25);
    expect(q[0].end).toBeCloseTo(0.75);
  });

  it('removes blips and merges gaps', () => {
    const notes = [
      { id: 1, midi: 60, raw: 60, start: 0, end: 0.4, velocity: 90 },
      { id: 2, midi: 72, raw: 72, start: 0.4, end: 0.43, velocity: 90 },
      { id: 3, midi: 60, raw: 60, start: 0.42, end: 0.8, velocity: 90 },
    ];
    const out = cleanupNotes(notes);
    expect(out.length).toBe(1);
    expect(out[0].end).toBeCloseTo(0.8);
  });
});

describe('beatbox triggers', () => {
  it('computes an FFT', () => {
    const re = new Float32Array(16);
    const im = new Float32Array(16);
    for (let i = 0; i < 16; i++) re[i] = Math.cos((2 * Math.PI * 2 * i) / 16);
    fft(re, im);
    expect(re[2]).toBeCloseTo(8, 4);
    expect(Math.abs(re[3])).toBeLessThan(1e-4);
  });

  // Synthetic vocal percussion: "kick" = low thump, "hat" = bright noise, "snare" = mid noise burst.
  function hit(kind: 'kick' | 'hat' | 'snare', seed: number): Float32Array {
    let s = seed;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2147483648 - 1);
    const out = new Float32Array(HIT_LENGTH + 2000);
    let lp = 0;
    let hpPrev = 0;
    let hp = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      const n = rnd();
      if (kind === 'kick') {
        out[i] = Math.sin(2 * Math.PI * (60 + 80 * Math.exp(-t * 40)) * t) * Math.exp(-t * 18) * (0.8 + 0.1 * rnd());
      } else if (kind === 'hat') {
        hp = 0.7 * (hp + n - hpPrev);
        hpPrev = n;
        out[i] = hp * 0.5 * Math.exp(-t * 30);
      } else {
        lp += 0.35 * (n - lp);
        out[i] = (lp * 0.9 + Math.sin(2 * Math.PI * 200 * t) * 0.3) * Math.exp(-t * 20);
      }
    }
    return out;
  }

  it('detects onsets and classifies trained sounds', () => {
    const clf = new HitClassifier();
    const kinds = ['kick', 'snare', 'hat'] as const;
    kinds.forEach((k, pad) => {
      for (let i = 0; i < 6; i++) clf.add(pad, hitFeatures(hit(k, 100 + i * 7 + pad), SR));
    });

    // A performance: silence + hits separated by gaps, detected via the streaming detector.
    const order = ['kick', 'hat', 'snare', 'hat', 'kick', 'snare', 'hat', 'kick'] as const;
    const signal = new Float32Array(SR * 4);
    order.forEach((k, i) => signal.set(hit(k, 999 + i * 13), Math.round((0.2 + i * 0.45) * SR)));
    const det = new OnsetDetector(SR, { threshold: 0.02, ratio: 4, refractory: 0.07 });
    const found: string[] = [];
    for (let i = 0; i < signal.length; i += 512) {
      det.push(signal.subarray(i, i + 512), (h) => {
        const c = clf.classify(hitFeatures(h.samples, SR));
        found.push(c ? kinds[c.pad] : '?');
      });
    }
    expect(found).toEqual([...order]);
  });
});
