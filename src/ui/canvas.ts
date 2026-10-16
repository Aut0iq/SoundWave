/** Keeps a canvas' backing store in sync with its CSS size and device pixel ratio. */
export class HiDpiCanvas {
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;

  constructor(readonly el: HTMLCanvasElement) {
    this.ctx = el.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.el.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    const w = Math.round(this.width * dpr);
    const h = Math.round(this.height * dpr);
    if (this.el.width !== w || this.el.height !== h) {
      this.el.width = w;
      this.el.height = h;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  get visible(): boolean {
    return this.el.offsetParent !== null;
  }

  clear(color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }
}

export const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

export function isBlack(midi: number): boolean {
  return BLACK_KEYS.has(((midi % 12) + 12) % 12);
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
