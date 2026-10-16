// Robustness against real-voice imperfections: vibrato, jitter, strong 2nd harmonic,
// breath noise and short level dips. A sustained note must stay one stable note.

import { describe, expect, it } from 'vitest';
import { freqToMidi, midiToFreq } from '../src/dsp/music';
import { transcribe, VOICE_OPTIONS } from '../src/dsp/noteTracker';
import { renderAutotune } from '../src/dsp/autotune';
import { realVoice, SR, tone, track } from './helpers';

describe('stability on imperfect singing', () => {
  it('pitch frames have no octave errors on a held note', () => {
    const frames = track(realVoice(57, 2)).filter((f) => f.freq > 0 && f.clarity > 0.75 && f.rms > 0.01);
    const bad = frames.filter((f) => Math.abs(freqToMidi(f.freq) - 57) > 3).length;
    expect(bad / frames.length).toBeLessThan(0.01);
  });

  it('transcribes a held note with vibrato and dips as one note', () => {
    for (const [centre, seed] of [[57, 1], [64, 2], [50, 3], [60.35, 4]] as const) {
      const sig = realVoice(centre, 2.2, seed);
      const frames = track(sig).map((f) => ({ t: f.pos / SR, freq: f.freq, clarity: f.clarity, rms: f.rms }));
      const notes = transcribe(frames, VOICE_OPTIONS, 384 / SR);
      expect(notes.length, `centre ${centre}`).toBe(1);
      expect(notes[0].midi).toBe(Math.round(centre));
    }
  });

  it('autotune holds one target on a held note (no warble between notes)', () => {
    // Sung slightly sharp of A3 with vibrato: output should sit on A3 throughout.
    const out = renderAutotune(realVoice(57.35, 2.2, 5), SR, { mask: 0xfff, speed: 0.1, amount: 1 });
    const frames = track(out.subarray(Math.round(0.25 * SR))).filter((f) => f.freq > 0 && f.clarity > 0.7 && f.rms > 0.01);
    const off = frames.filter((f) => Math.abs(freqToMidi(f.freq) - 57) > 0.45).length;
    expect(off / frames.length).toBeLessThan(0.03);
  });

  it('autotune does not flip-flop when singing between two notes', () => {
    const out = renderAutotune(realVoice(57.5, 2.2, 6, 0.3), SR, { mask: 0xfff, speed: 0.1, amount: 1 });
    const frames = track(out.subarray(Math.round(0.25 * SR))).filter((f) => f.freq > 0 && f.clarity > 0.7 && f.rms > 0.01);
    let switches = 0;
    let prev = Math.round(freqToMidi(frames[0].freq));
    for (const f of frames) {
      const m = Math.round(freqToMidi(f.freq));
      if (m !== prev) switches++;
      prev = m;
    }
    expect(switches).toBeLessThanOrEqual(4);
  });
});

describe('responsiveness', () => {
  it('autotune follows real note changes, including semitone steps', () => {
    const steps = [57, 58, 60, 59, 62];
    const seg = 0.45;
    const sig = tone((t) => {
      const i = Math.min(steps.length - 1, Math.floor(t / seg));
      return midiToFreq(steps[i] + 0.2 + 0.25 * Math.sin(2 * Math.PI * 5.5 * t));
    }, seg * steps.length);
    const out = renderAutotune(sig, SR, { mask: 0xfff, speed: 0.1, amount: 1 });
    const frames = track(out).filter((f) => f.freq > 0 && f.clarity > 0.7);
    steps.forEach((m, i) => {
      // After 160 ms in each segment the output must sit on the new note.
      const inSeg = frames.filter((f) => f.pos / SR > i * seg + 0.16 && f.pos / SR < (i + 1) * seg - 0.03);
      const on = inSeg.filter((f) => Math.abs(freqToMidi(f.freq) - m) < 0.35).length;
      expect(on / inSeg.length, `step ${i} -> ${m}`).toBeGreaterThan(0.9);
    });
  });

  it('note tracker splits a melody with semitone steps', () => {
    const steps = [57, 58, 60, 59, 62];
    const seg = 0.4;
    const sig = tone((t) => midiToFreq(steps[Math.min(steps.length - 1, Math.floor(t / seg))] + 0.2 * Math.sin(2 * Math.PI * 5.5 * t)), seg * steps.length);
    const frames = track(sig).map((f) => ({ t: f.pos / SR, freq: f.freq, clarity: f.clarity, rms: f.rms }));
    expect(transcribe(frames, VOICE_OPTIONS, 384 / SR).map((n) => n.midi)).toEqual(steps);
  });
});
