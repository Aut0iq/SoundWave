// Piano-roll view and note editor for the studio.

import { HiDpiCanvas, isBlack, roundRect } from './canvas';
import { mod, noteName } from '../dsp/music';
import { newNoteId, type Note } from '../dsp/noteTracker';
import type { Project, Track } from '../state/project';

const KEYS_W = 54;
const RULER_H = 24;
const EDGE = 7;

export interface RollHost {
  project(): Project;
  selectedTrack(): Track | null;
  mask(): number;
  position(): number;
  playing(): boolean;
  /** Notes/curve being recorded right now. */
  live(): { notes: Note[]; curve: { t: number; m: number }[] } | null;
  /** Grid step in seconds for snapping edits (0 = free). */
  snapStep(): number;
  seek(t: number): void;
  changed(track: Track): void;
  audition(track: Track, midi: number): void;
}

type Drag =
  | { kind: 'move' | 'resize'; x0: number; y0: number; orig: Map<number, Note>; anchor: Note; moved: boolean }
  | { kind: 'select'; x0: number; y0: number; x1: number; y1: number; base: Set<number> }
  | { kind: 'seek' };

export class PianoRoll {
  private c: HiDpiCanvas;
  pxPerSec = 110;
  scrollX = 0;
  topMidi = 84;
  rowH = 13;
  selection = new Set<number>();
  private drag: Drag | null = null;
  private hoverCursor = 'default';

  constructor(private readonly el: HTMLCanvasElement, private readonly host: RollHost) {
    this.c = new HiDpiCanvas(el);
    el.tabIndex = 0;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('dblclick', (e) => this.dbl(e));
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('keydown', (e) => this.key(e));
  }

  private x(t: number): number {
    return KEYS_W + (t - this.scrollX) * this.pxPerSec;
  }
  private t(x: number): number {
    return (x - KEYS_W) / this.pxPerSec + this.scrollX;
  }
  private y(m: number): number {
    return RULER_H + (this.topMidi - m) * this.rowH;
  }
  private m(y: number): number {
    return this.topMidi - Math.floor((y - RULER_H) / this.rowH);
  }

  zoom(factor: number, anchorX = (this.c.width + KEYS_W) / 2): void {
    const t = this.t(anchorX);
    this.pxPerSec = Math.max(15, Math.min(1200, this.pxPerSec * factor));
    this.scrollX = Math.max(0, t - (anchorX - KEYS_W) / this.pxPerSec);
  }

  /** Scrolls vertically so the given notes are in view. */
  reveal(notes: Note[]): void {
    if (!notes.length) return;
    const ms = notes.map((n) => n.midi).sort((a, b) => a - b);
    const mid = ms[ms.length >> 1];
    const rows = (this.c.height - RULER_H) / this.rowH;
    this.topMidi = Math.round(mid + rows / 2);
  }

  // -------------------------------------------------------------------------
  // Drawing

  draw(): void {
    if (!this.c.visible) return;
    const ctx = this.c.ctx;
    const W = this.c.width;
    const H = this.c.height;
    const project = this.host.project();
    const sel = this.host.selectedTrack();
    const mask = this.host.mask();
    const pos = this.host.position();

    if (this.host.playing() && !this.drag) {
      const px = this.x(pos);
      const visible = (W - KEYS_W) / this.pxPerSec;
      if (px > W - (W - KEYS_W) * 0.15 || px < KEYS_W) this.scrollX = Math.max(0, pos - visible * 0.1);
    }

    this.c.clear('#110f1b');
    const bottomMidi = this.m(H) - 1;

    // Pitch rows.
    for (let m = this.topMidi; m >= bottomMidi; m--) {
      const yy = this.y(m);
      const inScale = mask & (1 << mod(m, 12));
      ctx.fillStyle = isBlack(m) ? (inScale ? '#15131f' : '#100e18') : inScale ? '#1b1829' : '#141220';
      ctx.fillRect(KEYS_W, yy, W - KEYS_W, this.rowH);
      if (mod(m, 12) === 0) {
        ctx.fillStyle = '#2b2740';
        ctx.fillRect(KEYS_W, yy + this.rowH - 1, W - KEYS_W, 1);
      }
    }

    // Beat grid.
    const beat = 60 / project.bpm;
    const t0 = this.scrollX;
    const t1 = this.t(W);
    const beatPx = beat * this.pxPerSec;
    const sub = beatPx > 80 ? 4 : beatPx > 40 ? 2 : 1;
    for (let i = Math.floor((t0 / beat) * sub); i * (beat / sub) <= t1; i++) {
      const tt = i * (beat / sub);
      const xx = Math.round(this.x(tt)) + 0.5;
      const isBar = i % (4 * sub) === 0;
      const isBeat = i % sub === 0;
      if (!isBeat && !isBar && beatPx < 20) continue;
      ctx.fillStyle = isBar ? '#3a3556' : isBeat ? '#25213a' : '#1b1829';
      ctx.fillRect(xx, RULER_H, 1, H - RULER_H);
    }

    // Other tracks (faded), then the selected one on top.
    for (const tr of project.tracks) if (tr !== sel) this.drawNotes(tr.notes, tr.color, 0.28, false);
    if (sel) {
      this.drawCurve(sel.curve, sel.color);
      this.drawNotes(sel.notes, sel.color, 1, true);
    }
    const live = this.host.live();
    if (live) {
      this.drawCurve(live.curve, '#ffffff');
      this.drawNotes(live.notes, '#ff4d5e', 0.9, false);
    }

    if (this.drag?.kind === 'select') {
      const d = this.drag;
      ctx.fillStyle = 'rgba(139,108,255,0.12)';
      ctx.strokeStyle = 'rgba(139,108,255,0.7)';
      const rx = Math.min(d.x0, d.x1);
      const ry = Math.min(d.y0, d.y1);
      ctx.fillRect(rx, ry, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(rx + 0.5, ry + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }

    // Keys gutter.
    for (let m = this.topMidi; m >= bottomMidi; m--) {
      const yy = this.y(m);
      ctx.fillStyle = isBlack(m) ? '#1d1a2b' : '#cfcbe0';
      ctx.fillRect(0, yy, KEYS_W - 1, this.rowH - 1);
      if (mask & (1 << mod(m, 12))) {
        ctx.fillStyle = '#8b6cff';
        ctx.fillRect(KEYS_W - 4, yy, 3, this.rowH - 1);
      }
      if (mod(m, 12) === 0 && this.rowH >= 9) {
        ctx.fillStyle = '#2a2640';
        ctx.font = '10px Segoe UI, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(noteName(m), 5, yy + this.rowH - 3);
      }
    }

    // Ruler.
    ctx.fillStyle = '#17142a';
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.fillStyle = '#2e2a44';
    ctx.fillRect(0, RULER_H - 1, W, 1);
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    const bar = beat * 4;
    const barStep = bar * this.pxPerSec < 40 ? Math.ceil(40 / (bar * this.pxPerSec)) : 1;
    for (let b = Math.floor(t0 / bar); b * bar <= t1; b += 1) {
      if (b % barStep) continue;
      const xx = this.x(b * bar);
      if (xx < KEYS_W - 1) continue;
      ctx.fillStyle = '#4a4466';
      ctx.fillRect(xx, 12, 1, RULER_H - 12);
      ctx.fillStyle = '#9a94b8';
      ctx.fillText(String(b + 1), xx + 4, 15);
    }
    ctx.fillStyle = '#17142a';
    ctx.fillRect(0, 0, KEYS_W, RULER_H);

    // Playhead.
    const px = this.x(pos);
    if (px >= KEYS_W) {
      ctx.fillStyle = '#22d3b0';
      ctx.fillRect(Math.round(px), 0, 2, H);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 7, 0);
      ctx.lineTo(px + 1, 8);
      ctx.fill();
    }
    this.el.style.cursor = this.hoverCursor;
  }

  private drawNotes(notes: Note[], color: string, alpha: number, editable: boolean): void {
    const ctx = this.c.ctx;
    const W = this.c.width;
    for (const n of notes) {
      const x0 = this.x(n.start);
      const x1 = this.x(n.end);
      if (x1 < KEYS_W || x0 > W) continue;
      const yy = this.y(n.midi);
      if (yy < RULER_H - this.rowH || yy > this.c.height) continue;
      const xs = Math.max(KEYS_W, x0);
      const w = Math.max(3, x1 - xs);
      ctx.globalAlpha = alpha * (0.55 + (0.45 * n.velocity) / 127);
      roundRect(ctx, xs, yy + 1, w, this.rowH - 2, 3);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (editable && this.selection.has(n.id)) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (editable && w > 34 && this.rowH >= 11) {
        ctx.fillStyle = 'rgba(10,8,20,0.75)';
        ctx.font = '9px Segoe UI, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(noteName(n.midi), xs + 4, yy + this.rowH - 4);
      }
    }
  }

  private drawCurve(curve: { t: number; m: number }[], color: string): void {
    if (!curve.length) return;
    const ctx = this.c.ctx;
    const t0 = this.scrollX - 0.1;
    const t1 = this.t(this.c.width) + 0.1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYS_W, RULER_H, this.c.width - KEYS_W, this.c.height - RULER_H);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    let prev = 0;
    for (const p of curve) {
      if (p.t < t0 || p.t > t1 || p.m !== p.m) {
        pen = false;
        continue;
      }
      if (pen && Math.abs(p.m - prev) > 3) pen = false;
      const yy = this.y(p.m) + this.rowH / 2;
      if (!pen) ctx.moveTo(this.x(p.t), yy);
      else ctx.lineTo(this.x(p.t), yy);
      pen = true;
      prev = p.m;
    }
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Editing

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hitNote(x: number, y: number): { note: Note; edge: boolean } | null {
    const tr = this.host.selectedTrack();
    if (!tr || y < RULER_H || x < KEYS_W) return null;
    const m = this.m(y);
    for (let i = tr.notes.length - 1; i >= 0; i--) {
      const n = tr.notes[i];
      if (n.midi !== m) continue;
      const x0 = this.x(n.start);
      const x1 = Math.max(x0 + 3, this.x(n.end));
      if (x >= x0 && x <= x1 + 2) return { note: n, edge: x >= x1 - EDGE && x1 - x0 > EDGE * 1.5 };
    }
    return null;
  }

  private snap(t: number): number {
    const step = this.host.snapStep();
    return step > 0 ? Math.round(t / step) * step : Math.round(t * 100) / 100;
  }

  private down(e: PointerEvent): void {
    this.el.focus();
    const { x, y } = this.local(e);
    this.el.setPointerCapture(e.pointerId);
    const tr = this.host.selectedTrack();
    if (y < RULER_H) {
      this.drag = { kind: 'seek' };
      this.host.seek(Math.max(0, this.t(x)));
      return;
    }
    if (x < KEYS_W) {
      if (tr) this.host.audition(tr, this.m(y));
      return;
    }
    const hit = this.hitNote(x, y);
    if (hit && tr) {
      if (e.shiftKey) {
        if (this.selection.has(hit.note.id)) this.selection.delete(hit.note.id);
        else this.selection.add(hit.note.id);
      } else if (!this.selection.has(hit.note.id)) {
        this.selection = new Set([hit.note.id]);
      }
      const orig = new Map<number, Note>();
      for (const n of tr.notes) if (this.selection.has(n.id)) orig.set(n.id, { ...n });
      this.drag = { kind: hit.edge ? 'resize' : 'move', x0: x, y0: y, orig, anchor: { ...hit.note }, moved: false };
      this.host.audition(tr, hit.note.midi);
      return;
    }
    this.drag = { kind: 'select', x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? new Set(this.selection) : new Set() };
    if (!e.shiftKey) this.selection.clear();
  }

  private move(e: PointerEvent): void {
    const { x, y } = this.local(e);
    const d = this.drag;
    if (!d) {
      const hit = this.hitNote(x, y);
      this.hoverCursor = y < RULER_H ? 'col-resize' : hit ? (hit.edge ? 'ew-resize' : 'grab') : x < KEYS_W ? 'pointer' : 'crosshair';
      return;
    }
    if (d.kind === 'seek') {
      this.host.seek(Math.max(0, this.t(x)));
      return;
    }
    if (d.kind === 'select') {
      d.x1 = x;
      d.y1 = y;
      const tr = this.host.selectedTrack();
      if (!tr) return;
      const ta = this.t(Math.min(d.x0, x));
      const tb = this.t(Math.max(d.x0, x));
      const ma = this.m(Math.max(d.y0, y));
      const mb = this.m(Math.min(d.y0, y));
      this.selection = new Set(d.base);
      for (const n of tr.notes) if (n.end >= ta && n.start <= tb && n.midi >= ma && n.midi <= mb) this.selection.add(n.id);
      return;
    }
    const tr = this.host.selectedTrack();
    if (!tr) return;
    const dt = (x - d.x0) / this.pxPerSec;
    if (d.kind === 'move') {
      const dm = Math.round((d.y0 - y) / this.rowH);
      const shift = this.snap(d.anchor.start + dt) - d.anchor.start;
      for (const n of tr.notes) {
        const o = d.orig.get(n.id);
        if (!o) continue;
        const start = Math.max(0, o.start + shift);
        n.end = start + (o.end - o.start);
        n.start = start;
        const m = Math.max(0, Math.min(127, o.midi + dm));
        if (m !== n.midi && n.id === d.anchor.id) this.host.audition(tr, m);
        n.raw = o.raw + (m - o.midi);
        n.midi = m;
      }
    } else {
      const minLen = Math.max(0.03, this.host.snapStep());
      for (const n of tr.notes) {
        const o = d.orig.get(n.id);
        if (!o) continue;
        n.end = Math.max(n.start + minLen, this.snap(o.end + dt));
      }
    }
    d.moved = true;
  }

  private up(e: PointerEvent): void {
    this.el.releasePointerCapture(e.pointerId);
    const d = this.drag;
    this.drag = null;
    const tr = this.host.selectedTrack();
    if (d && (d.kind === 'move' || d.kind === 'resize') && d.moved && tr) {
      tr.notes.sort((a, b) => a.start - b.start);
      this.host.changed(tr);
    }
  }

  private dbl(e: MouseEvent): void {
    const { x, y } = this.local(e);
    const tr = this.host.selectedTrack();
    if (!tr || y < RULER_H || x < KEYS_W || tr.kind === 'drums') return;
    if (this.hitNote(x, y)) return;
    const step = this.host.snapStep() || 60 / this.host.project().bpm / 2;
    const start = this.host.snapStep() ? this.snap(this.t(x)) : Math.max(0, this.t(x));
    const midi = this.m(y);
    const note: Note = { id: newNoteId(), midi, raw: midi, start, end: start + step, velocity: 100 };
    tr.notes.push(note);
    tr.notes.sort((a, b) => a.start - b.start);
    this.selection = new Set([note.id]);
    this.host.audition(tr, midi);
    this.host.changed(tr);
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const { x } = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, x);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = e.shiftKey ? e.deltaY : e.deltaX;
      this.scrollX = Math.max(0, this.scrollX + d / this.pxPerSec);
    } else {
      this.topMidi = Math.max(20, Math.min(127, this.topMidi - Math.sign(e.deltaY) * 3));
    }
  }

  private key(e: KeyboardEvent): void {
    const tr = this.host.selectedTrack();
    if (!tr) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!this.selection.size) return;
      tr.notes = tr.notes.filter((n) => !this.selection.has(n.id));
      this.selection.clear();
      this.host.changed(tr);
      e.preventDefault();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!this.selection.size) return;
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      for (const n of tr.notes) {
        if (!this.selection.has(n.id)) continue;
        n.midi = Math.max(0, Math.min(127, n.midi + d));
        n.raw += d;
      }
      const first = tr.notes.find((n) => this.selection.has(n.id));
      if (first) this.host.audition(tr, first.midi);
      this.host.changed(tr);
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      this.selection = new Set(tr.notes.map((n) => n.id));
      e.preventDefault();
    } else if (e.key === 'Escape') {
      this.selection.clear();
    }
  }
}
