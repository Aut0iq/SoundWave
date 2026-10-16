// On-screen piano showing sounding notes and the sung pitch; click to audition.

import { HiDpiCanvas, isBlack, roundRect } from './canvas';
import { mod } from '../dsp/music';

const LOW = 36; // C2
const HIGH = 96; // C7

export class Keyboard {
  private c: HiDpiCanvas;
  private whites: number[] = [];
  onPress: (midi: number) => void = () => {};

  constructor(el: HTMLCanvasElement) {
    this.c = new HiDpiCanvas(el);
    for (let m = LOW; m <= HIGH; m++) if (!isBlack(m)) this.whites.push(m);
    el.addEventListener('pointerdown', (e) => {
      const r = el.getBoundingClientRect();
      const m = this.hit(e.clientX - r.left, e.clientY - r.top);
      if (m !== null) this.onPress(m);
    });
  }

  private geometry() {
    const ww = this.c.width / this.whites.length;
    return { ww, bw: ww * 0.62, bh: this.c.height * 0.6 };
  }

  private keyX(midi: number): { x: number; w: number; black: boolean } {
    const { ww, bw } = this.geometry();
    if (!isBlack(midi)) return { x: this.whites.indexOf(midi) * ww, w: ww, black: false };
    const left = this.whites.indexOf(midi - 1);
    return { x: (left + 1) * ww - bw / 2, w: bw, black: true };
  }

  private hit(x: number, y: number): number | null {
    const { bh } = this.geometry();
    if (y < bh) {
      for (let m = LOW; m <= HIGH; m++) {
        if (!isBlack(m)) continue;
        const k = this.keyX(m);
        if (x >= k.x && x < k.x + k.w) return m;
      }
    }
    for (const m of this.whites) {
      const k = this.keyX(m);
      if (x >= k.x && x < k.x + k.w) return m;
    }
    return null;
  }

  draw(active: number[], sung: number, mask: number): void {
    if (!this.c.visible) return;
    const ctx = this.c.ctx;
    const { bh } = this.geometry();
    const H = this.c.height;
    this.c.clear('#0e0d15');
    const on = new Set(active);
    for (const m of this.whites) {
      const k = this.keyX(m);
      roundRect(ctx, k.x + 1, 0, k.w - 2, H - 1, 5);
      ctx.fillStyle = on.has(m) ? '#22d3b0' : mask & (1 << mod(m, 12)) ? '#e9e6f5' : '#a9a4bf';
      ctx.fill();
      if (mod(m, 12) === 0) {
        ctx.fillStyle = '#5b5578';
        ctx.font = '10px Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`C${Math.floor(m / 12) - 1}`, k.x + k.w / 2, H - 6);
      }
    }
    for (let m = LOW; m <= HIGH; m++) {
      if (!isBlack(m)) continue;
      const k = this.keyX(m);
      roundRect(ctx, k.x, 0, k.w, bh, 4);
      ctx.fillStyle = on.has(m) ? '#22d3b0' : mask & (1 << mod(m, 12)) ? '#2a2640' : '#15131f';
      ctx.fill();
    }
    if (sung === sung && sung >= LOW - 0.5 && sung <= HIGH + 0.5) {
      // Interpolate between neighbouring key centres for the sung (fractional) pitch.
      const lo = Math.floor(sung);
      const a = this.keyX(lo);
      const b = this.keyX(lo + 1);
      const f = sung - lo;
      const x = a.x + a.w / 2 + (b.x + b.w / 2 - (a.x + a.w / 2)) * f;
      ctx.fillStyle = '#8b6cff';
      ctx.fillRect(x - 1.5, 0, 3, H);
      ctx.beginPath();
      ctx.arc(x, 6, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
