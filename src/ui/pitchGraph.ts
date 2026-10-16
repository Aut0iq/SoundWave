// Scrolling history of the sung pitch and the notes it produced.

import { HiDpiCanvas, isBlack } from './canvas';
import { mod, noteName } from '../dsp/music';

interface Point {
  t: number;
  m: number;
}

const SPAN = 8;

export class PitchGraph {
  private c: HiDpiCanvas;
  private points: Point[] = [];
  private notes: { notes: number[]; start: number; end: number | null }[] = [];
  private centre = 60;

  constructor(el: HTMLCanvasElement) {
    this.c = new HiDpiCanvas(el);
  }

  addPoint(t: number, m: number): void {
    this.points.push({ t, m });
    while (this.points.length && t - this.points[0].t > SPAN + 1) this.points.shift();
  }

  noteOn(notes: number[], t: number): void {
    this.notes.push({ notes, start: t, end: null });
    if (this.notes.length > 200) this.notes.shift();
  }

  noteOff(t: number): void {
    const last = this.notes[this.notes.length - 1];
    if (last && last.end === null) last.end = t;
  }

  draw(now: number, mask: number): void {
    if (!this.c.visible) return;
    const ctx = this.c.ctx;
    const W = this.c.width;
    const H = this.c.height;
    this.c.clear('#13111d');

    // Follow the singer: keep the recent median pitch in the middle.
    const recent = this.points.filter((p) => now - p.t < 3 && p.m === p.m).map((p) => p.m).sort((a, b) => a - b);
    if (recent.length) this.centre += (recent[recent.length >> 1] - this.centre) * 0.05;
    const rows = 25;
    const rowH = H / rows;
    const top = Math.round(this.centre) + 12;
    const y = (m: number) => (top - m + 0.5) * rowH;
    const x = (t: number) => W - ((now - t) / SPAN) * W;

    ctx.font = '10px Segoe UI, sans-serif';
    for (let i = 0; i <= rows; i++) {
      const m = top - i;
      const yy = y(m);
      const inScale = mask & (1 << mod(m, 12));
      ctx.fillStyle = inScale ? (isBlack(m) ? '#1c1a2b' : '#1f1c31') : '#14121e';
      ctx.fillRect(0, yy - rowH / 2, W, rowH);
      if (mod(m, 12) === 0) {
        ctx.fillStyle = '#2e2a44';
        ctx.fillRect(0, yy + rowH / 2 - 1, W, 1);
      }
      if (inScale) {
        ctx.fillStyle = '#4c4669';
        ctx.fillText(noteName(m), 6, yy + 3);
      }
    }

    ctx.fillStyle = 'rgba(34, 211, 176, 0.35)';
    for (const n of this.notes) {
      const end = n.end ?? now;
      if (end < now - SPAN) continue;
      for (const m of n.notes) {
        ctx.fillRect(x(n.start), y(m) - rowH / 2 + 1, Math.max(2, x(end) - x(n.start)), rowH - 2);
      }
    }

    ctx.strokeStyle = '#a58dff';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    let prev = 0;
    for (const p of this.points) {
      if (p.m !== p.m) {
        pen = false;
        continue;
      }
      if (pen && Math.abs(p.m - prev) > 3) pen = false; // octave jumps: don't draw a vertical line
      if (!pen) ctx.moveTo(x(p.t), y(p.m));
      else ctx.lineTo(x(p.t), y(p.m));
      pen = true;
      prev = p.m;
    }
    ctx.stroke();
  }
}
