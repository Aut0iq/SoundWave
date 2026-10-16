import { describe, expect, it } from 'vitest';
import { YinDetector } from '../src/dsp/pitch';
import { freqToMidi, midiToFreq, noteName, scaleMask, snapToScale } from '../src/dsp/music';
import { transcribe, type TrackerFrame, VOICE_OPTIONS } from '../src/dsp/noteTracker';
import { renderAutotune } from '../src/dsp/autotune';
import { medianFreq, SR, sine, tone, track } from './helpers';

describe('music', () => {
  it('converts between frequency and MIDI', () => {
    expect(freqToMidi(440)).toBeCloseTo(69, 6);
    expect(midiToFreq(60)).toBeCloseTo(261.6256, 3);
    expect(noteName(60)).toBe('C4');
    expect(noteName(70)).toBe('A#4');
  });

  it('snaps to scale notes', () => {
    const cMajor = scaleMask(0, 'major');
    expect(snapToScale(61.2, cMajor)).toBe(62);
    expect(snapToScale(60.8, cMajor)).toBe(60);
    expect(snapToScale(66.6, cMajor)).toBe(67);
    const aMinorPenta = scaleMask(9, 'pentaMinor');
    expect(snapToScale(70.9, aMinorPenta)).toBe(72);
  });
});

describe('pitch detection', () => {
  it('detects pure tones across the range', () => {
    for (const f of [82.41, 110, 220, 440, 880]) {
      const yin = new YinDetector(SR / 2, 1024, 65, 1400);
      const sig = sine(f, 0.1, SR / 2);
      const r = yin.detect(sig, 0);
      expect(Math.abs(r.freq - f) / f).toBeLessThan(0.005);
      expect(r.clarity).toBeGreaterThan(0.9);
    }
  });

  it('tracks harmonic tones without octave errors', () => {
    for (const f of [98, 196.0, 329.6, 659.3]) {
      const frames = track(tone(() => f, 0.5));
      expect(Math.abs(medianFreq(frames) - f) / f).toBeLessThan(0.005);
    }
  });

  it('reports silence as unpitched', () => {
    const frames = track(new Float32Array(SR / 2));
    expect(frames.every((f) => f.freq === 0)).toBe(true);
  });

  it('places frames at window centres', () => {
    // Tone starts at 0.5 s; first confident frame should be centred near there.
    const sig = tone((t) => (t < 0.5 ? 0 : 220), 1);
    const frames = track(sig);
    const first = frames.find((f) => f.freq > 0 && f.clarity > 0.8)!;
    expect(first.pos / SR).toBeGreaterThan(0.47);
    expect(first.pos / SR).toBeLessThan(0.53);
  });
});

function framesFromSignal(sig: Float32Array): TrackerFrame[] {
  return track(sig).map((f) => ({ t: f.pos / SR, freq: f.freq, clarity: f.clarity, rms: f.rms }));
}

describe('note transcription', () => {
  it('turns a sung melody with vibrato into notes', () => {
    const melody = [
      { midi: 60, start: 0.2, end: 0.6 },
      { midi: 64, start: 0.6, end: 1.0 },
      { midi: 67, start: 1.3, end: 1.9 },
      { midi: 72, start: 1.9, end: 2.3 },
    ];
    const sig = tone((t) => {
      const n = melody.find((m) => t >= m.start && t < m.end);
      if (!n) return 0;
      const vib = 0.35 * Math.sin(2 * Math.PI * 5.5 * t);
      return midiToFreq(n.midi + vib);
    }, 2.6);
    const notes = transcribe(framesFromSignal(sig), VOICE_OPTIONS, 256 / SR * 2);
    expect(notes.map((n) => n.midi)).toEqual([60, 64, 67, 72]);
    notes.forEach((n, i) => {
      expect(Math.abs(n.start - melody[i].start)).toBeLessThan(0.06);
      expect(Math.abs(n.end - melody[i].end)).toBeLessThan(0.08);
    });
  });

  it('splits re-articulated notes of the same pitch', () => {
    // Two plucks of A3 with an exponential decay each.
    const sig = tone(() => 220, 1.2);
    for (let i = 0; i < sig.length; i++) {
      const t = i / SR;
      const local = t < 0.6 ? t : t - 0.6;
      sig[i] *= Math.exp(-local * 6);
    }
    const notes = transcribe(framesFromSignal(sig), { ...VOICE_OPTIONS, onsetRatio: 1.8 }, 512 / SR);
    expect(notes.length).toBe(2);
    expect(notes.every((n) => n.midi === 57)).toBe(true);
  });
});

describe('autotune', () => {
  const steadyFreq = (out: Float32Array) => medianFreq(track(out.subarray(Math.round(0.3 * SR))));

  it('pulls a sharp note to the nearest semitone', () => {
    const out = renderAutotune(tone(() => 452, 1.2), SR, { mask: 0xfff, speed: 0, amount: 1 });
    expect(Math.abs(steadyFreq(out) - 440) / 440).toBeLessThan(0.006);
  });

  it('pulls a flat note up', () => {
    const out = renderAutotune(tone(() => 205, 1.2), SR, { mask: 0xfff, speed: 0, amount: 1 });
    expect(Math.abs(steadyFreq(out) - 207.65) / 207.65).toBeLessThan(0.006);
  });

  it('respects the selected scale', () => {
    const out = renderAutotune(tone(() => midiToFreq(66.6), 1.2), SR, { mask: scaleMask(0, 'major'), speed: 0 });
    expect(Math.abs(steadyFreq(out) - midiToFreq(67)) / midiToFreq(67)).toBeLessThan(0.006);
  });

  it('keeps level and stays time-aligned', () => {
    const input = tone(() => 300, 1.2);
    const out = renderAutotune(input, SR, { mask: 0xfff, speed: 0 });
    expect(out.length).toBe(input.length);
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
    const a = rms(input.subarray(SR / 2, SR));
    const b = rms(out.subarray(SR / 2, SR));
    expect(b / a).toBeGreaterThan(0.8);
    expect(b / a).toBeLessThan(1.2);
  });

  it('passes the dry signal through when mix is 0', () => {
    const input = tone(() => 300, 0.5);
    const out = renderAutotune(input, SR, { mix: 0 });
    let maxErr = 0;
    for (let i = 4800; i < input.length - 4800; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - input[i]));
    expect(maxErr).toBeLessThan(1e-3);
  });
});
