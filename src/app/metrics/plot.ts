/**
 * A small canvas chart for the metric tabs: stacked panels over one x axis (time, a log axis of days, or categories), each with its own
 * y axis (linear or log), and layers drawn in order: shaded bands across every panel, fills between two lines, bars, lines, dots, level
 * lines and labels. A crosshair follows the pointer (mouse, pen or finger) and a readout says the values under it.
 */
import { dayTicks, niceTicks, timeTicks } from './ticks.ts';
import { pixelRatio, sharpens, stopSharpening, type Sharpened } from '../pixel-ratio.ts';

export interface Colours { bg: string; text: string; muted: string; line: string; flag: string; flagSoft: string }

export type Layer =
  | { kind: 'line'; x: ArrayLike<number>; y: ArrayLike<number>; color: string; width?: number; dots?: boolean }
  | { kind: 'fill'; x: ArrayLike<number>; a: ArrayLike<number>; b: ArrayLike<number>; color: string }
  | { kind: 'area'; x: ArrayLike<number>; y: ArrayLike<number>; base: number; color: string }
  | { kind: 'bars'; x: ArrayLike<number>; y: ArrayLike<number>; base: number; color: (i: number) => string; width?: number }
  | { kind: 'hline'; y: number; color: string; dash?: boolean; width?: number }
  | { kind: 'dot'; x: number; y: number; color: string; label?: string };

export interface Panel {
  weight: number;
  title?: string;
  log?: boolean;
  min?: number; max?: number;
  /** Values the y range must include (a threshold line, zero). */
  include?: number[];
  /** A y label; `step` is the distance between ticks (so a formatter can choose its decimals). */
  format: (v: number, step: number) => string;
  layers: Layer[];
}

export interface ChartSpec {
  x: { kind: 'time' | 'logdays' | 'category'; min: number; max: number; labels?: string[]; timeZone?: string };
  panels: Panel[];
  /** Shaded spans of x drawn behind every panel. */
  bands?: { runs: [number, number][]; color: string; minWidth?: number }[];
  /** The legend: a swatch and a name for each. */
  legend?: { color: string; text: string }[];
  /** Big corner label (a current reading), drawn top right of the first panel. */
  corner?: { text: string; color: string };
  /** What the crosshair's readout says at an x (lines of text), or null for nothing. */
  readout?: (x: number) => string[] | null;
  /** Where the crosshair snaps (the data's own x values), for category and data-dense charts. */
  snap?: ArrayLike<number>;
}

const PAD = { l: 8, r: 64, t: 10, b: 26, gap: 14 };

export class Chart implements Sharpened {
  readonly root: HTMLDivElement;
  #canvas = document.createElement('canvas');
  #spec: ChartSpec | null = null;
  #colours: Colours;
  #hover: { x: number; y: number } | null = null;
  #ro: ResizeObserver;
  #frame = 0;

  constructor(colours: Colours) {
    this.#colours = colours;
    this.root = document.createElement('div');
    this.root.className = 'mx-chart';
    this.root.append(this.#canvas);
    this.#ro = new ResizeObserver(() => this.#queue());
    this.#ro.observe(this.root);
    const move = (e: PointerEvent): void => { const r = this.#canvas.getBoundingClientRect(); this.#hover = { x: e.clientX - r.left, y: e.clientY - r.top }; this.#queue(); };
    sharpens(this);
    this.#canvas.addEventListener('pointermove', move);
    this.#canvas.addEventListener('pointerdown', move);
    // A finger's reading stays after it lifts (a tap shows a day); the mouse's goes when it leaves.
    this.#canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { this.#hover = null; this.#queue(); } });
  }

  set(spec: ChartSpec, colours?: Colours): void { this.#spec = spec; if (colours) this.#colours = colours; this.#queue(); }
  destroy(): void { this.#ro.disconnect(); cancelAnimationFrame(this.#frame); stopSharpening(this); }
  /** For a sharp picture (pixel-ratio.ts): the canvas is sized as it is drawn. */
  resize(): void {}
  paint(): void { if (this.root.isConnected) this.#draw(); }

  #queue(): void { if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#draw(); }); }

  #draw(): void {
    const spec = this.#spec, c = this.#colours, canvas = this.#canvas;
    const w = this.root.clientWidth, h = this.root.clientHeight;
    if (!spec || w < 40 || h < 40) return;
    const dpr = pixelRatio();
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const font = getComputedStyle(this.root).fontFamily || 'sans-serif', small = w < 520;
    const fs = small ? 10 : 11;
    ctx.font = `${fs}px ${font}`;
    const pad = { ...PAD, r: small ? 46 : PAD.r };
    const legendH = spec.legend?.length ? fs + 10 : 0;
    const plotL = pad.l, plotR = w - pad.r, top = pad.t + legendH, bottom = h - pad.b;
    const total = spec.panels.reduce((s, p) => s + p.weight, 0), avail = bottom - top - pad.gap * (spec.panels.length - 1);
    const X = spec.x;
    const xs = (v: number): number => {
      const f = X.kind === 'logdays' ? (Math.log(v) - Math.log(X.min)) / (Math.log(X.max) - Math.log(X.min)) : (v - X.min) / (X.max - X.min || 1);
      return plotL + f * (plotR - plotL);
    };
    const xInv = (px: number): number => {
      const f = (px - plotL) / (plotR - plotL);
      return X.kind === 'logdays' ? Math.exp(Math.log(X.min) + f * (Math.log(X.max) - Math.log(X.min))) : X.min + f * (X.max - X.min);
    };
    // Panels' boxes and y scales.
    let y0 = top;
    const boxes = spec.panels.map(p => {
      const ph = (avail * p.weight) / total, box = { p, top: y0, bottom: y0 + ph };
      y0 += ph + pad.gap;
      let lo = p.min ?? Infinity, hi = p.max ?? -Infinity;
      if (p.min === undefined || p.max === undefined) {
        const see = (v: number): void => { if (Number.isFinite(v) && (!p.log || v > 0)) { if (p.min === undefined) lo = Math.min(lo, v); if (p.max === undefined) hi = Math.max(hi, v); } };
        for (const L of p.layers) {
          const inRange = (x: number): boolean => x >= X.min && x <= X.max;
          if (L.kind === 'line' || L.kind === 'bars' || L.kind === 'area') { for (let i = 0; i < L.y.length; i++) if (inRange(L.x[i]!)) see(L.y[i]!); if (L.kind !== 'line') see(L.base); }
          else if (L.kind === 'fill') { for (let i = 0; i < L.a.length; i++) if (inRange(L.x[i]!)) { see(L.a[i]!); see(L.b[i]!); } }
          else if (L.kind === 'dot') see(L.y);
        }
        for (const v of p.include ?? []) see(v);
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
      if (p.log) { const m = Math.log(hi / lo) * 0.06 || 0.1; lo = lo * Math.exp(-m); hi = hi * Math.exp(m); }
      else { const m = (hi - lo) * 0.07 || Math.abs(hi) * 0.1 || 1; if (p.min === undefined) lo -= m; if (p.max === undefined) hi += m; }
      const ys = (v: number): number => {
        const f = p.log ? (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : (v - lo) / (hi - lo);
        return box.bottom - f * (box.bottom - box.top);
      };
      return { ...box, lo, hi, ys };
    });

    // Bands across all panels.
    for (const band of spec.bands ?? []) {
      ctx.fillStyle = band.color;
      for (const [a, b] of band.runs) {
        if (b < X.min || a > X.max) continue;
        const xa = xs(Math.max(a, X.min)), xb = Math.max(xs(Math.min(b, X.max)), xa + (band.minWidth ?? 2));
        for (const bx of boxes) ctx.fillRect(xa, bx.top, xb - xa, bx.bottom - bx.top);
      }
    }

    // X grid and labels.
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    const xTicks: { v: number; label: string }[] = X.kind === 'time' ? timeTicks(X.min, X.max, Math.max(2, Math.floor((plotR - plotL) / (small ? 70 : 95))), X.timeZone)
      : X.kind === 'logdays' ? dayTicks(X.min, X.max)
      : (X.labels ?? []).map((label, i) => ({ v: i, label }));
    if (X.kind !== 'category') {
      ctx.strokeStyle = c.line; ctx.lineWidth = 1;
      for (const tk of xTicks) { const px = Math.round(xs(tk.v)) + 0.5; for (const bx of boxes) { ctx.beginPath(); ctx.moveTo(px, bx.top); ctx.lineTo(px, bx.bottom); ctx.stroke(); } }
    }
    ctx.fillStyle = c.muted;
    const last = boxes[boxes.length - 1]!;
    if (X.kind === 'category') {
      const step = (plotR - plotL) / Math.max(1, xTicks.length), every = Math.max(1, Math.ceil((fs * 4.2) / step));
      xTicks.forEach((tk, i) => { if (i % every === 0) ctx.fillText(tk.label, plotL + step * (i + 0.5), last.bottom + 6); });
    } else for (const tk of xTicks) ctx.fillText(tk.label, xs(tk.v), last.bottom + 6);

    // Panels.
    const catX = (i: number): number => plotL + ((plotR - plotL) / Math.max(1, X.labels?.length ?? 1)) * (i + 0.5);
    const px = (v: number): number => (X.kind === 'category' ? catX(v) : xs(v));
    for (const bx of boxes) {
      const { p, ys } = bx;
      // Y grid and labels.
      const yTicks = niceTicks(bx.lo, bx.hi, Math.max(2, Math.floor((bx.bottom - bx.top) / 38)), p.log);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const yStep = yTicks.length > 1 ? Math.abs(yTicks[1]! - yTicks[0]!) : 1;
      for (const v of yTicks) {
        const y = Math.round(ys(v)) + 0.5;
        if (y < bx.top - 1 || y > bx.bottom + 1) continue;
        ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke();
        ctx.fillStyle = c.muted; ctx.fillText(p.format(v, yStep), plotR + 6, y);
      }
      ctx.save();
      ctx.beginPath(); ctx.rect(plotL, bx.top, plotR - plotL, bx.bottom - bx.top); ctx.clip();
      for (const L of p.layers) {
        if (L.kind === 'hline') {
          ctx.strokeStyle = L.color; ctx.lineWidth = L.width ?? 1.2; ctx.setLineDash(L.dash ? [5, 4] : []);
          const y = ys(L.y); ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke(); ctx.setLineDash([]);
        } else if (L.kind === 'bars') {
          const n = L.x.length, inView = Math.max(1, countIn(L.x, X.min, X.max)), bw = L.width ?? Math.max(1, ((plotR - plotL) / inView) * (X.kind === 'category' ? 0.75 : 1));
          for (let i = 0; i < n; i++) {
            const v = L.y[i]!; if (!Number.isFinite(v)) continue;
            const x = px(L.x[i]!); if (x < plotL - bw || x > plotR + bw) continue;
            const ya = ys(L.base), yb = ys(v);
            ctx.fillStyle = L.color(i); ctx.fillRect(x - bw / 2, Math.min(ya, yb), bw, Math.max(1, Math.abs(yb - ya)));
          }
        } else if (L.kind === 'area') {
          ctx.fillStyle = L.color; ctx.beginPath();
          let open = false, firstX = 0, lastX = 0;
          const close = (): void => { if (open) { ctx.lineTo(lastX, ys(L.base)); ctx.lineTo(firstX, ys(L.base)); ctx.closePath(); open = false; } };
          for (let i = 0; i < L.x.length; i++) {
            const v = L.y[i]!; const x = px(L.x[i]!);
            if (!Number.isFinite(v) || (v - L.base) >= 0) { close(); continue; }
            if (!open) { ctx.moveTo(x, ys(L.base)); firstX = x; open = true; }
            ctx.lineTo(x, ys(v)); lastX = x;
          }
          close(); ctx.fill();
        } else if (L.kind === 'fill') {
          // Where a is above b, one closed shape per run.
          ctx.fillStyle = L.color;
          let run: number[] = [];
          const flush = (): void => {
            if (run.length > 1) {
              ctx.beginPath();
              run.forEach((i, k) => (k ? ctx.lineTo(px(L.x[i]!), ys(L.a[i]!)) : ctx.moveTo(px(L.x[i]!), ys(L.a[i]!))));
              for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(px(L.x[run[k]!]!), ys(L.b[run[k]!]!));
              ctx.closePath(); ctx.fill();
            }
            run = [];
          };
          for (let i = 0; i < L.x.length; i++) { const a = L.a[i]!, b = L.b[i]!; if (Number.isFinite(a) && Number.isFinite(b) && a > b) run.push(i); else flush(); }
          flush();
        } else if (L.kind === 'line') {
          ctx.strokeStyle = L.color; ctx.lineWidth = L.width ?? 1.6; ctx.lineJoin = 'round'; ctx.beginPath();
          let pen = false;
          for (let i = 0; i < L.x.length; i++) {
            const v = L.y[i]!;
            if (!Number.isFinite(v) || (p.log && v <= 0)) { pen = false; continue; }
            const x = px(L.x[i]!), y = ys(v);
            if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
          }
          ctx.stroke();
          if (L.dots) { ctx.fillStyle = L.color; for (let i = 0; i < L.x.length; i++) { const v = L.y[i]!; if (Number.isFinite(v)) { ctx.beginPath(); ctx.arc(px(L.x[i]!), ys(v), 3.2, 0, Math.PI * 2); ctx.fill(); } } }
        }
      }
      ctx.restore();
      for (const L of p.layers) if (L.kind === 'dot') {
        const x = px(L.x), y = ys(L.y);
        ctx.fillStyle = L.color; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
        if (L.label) {
          // Right of the dot, or left of it where the plot's edge leaves no room (the latest reading sits at the right edge).
          ctx.font = `bold ${fs + 2}px ${font}`; ctx.textBaseline = 'middle';
          const room = x + 7 + ctx.measureText(L.label).width <= plotR - 2;
          ctx.textAlign = room ? 'left' : 'right';
          const ly = Math.min(Math.max(y, bx.top + fs), bx.bottom - fs);
          ctx.fillStyle = c.bg; ctx.globalAlpha = 0.85; const tw = ctx.measureText(L.label).width; ctx.fillRect(room ? x + 5 : x - 9 - tw, ly - fs / 2 - 3, tw + 4, fs + 6); ctx.globalAlpha = 1;
          ctx.fillStyle = L.color; ctx.fillText(L.label, room ? x + 7 : x - 7, ly); ctx.font = `${fs}px ${font}`;
        }
      }
      if (p.title) {
        // On a patch of the page's colour, so a level line under it does not cross the words.
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillStyle = c.bg; ctx.globalAlpha = 0.85; ctx.fillRect(plotL + 2, bx.top + 2, ctx.measureText(p.title).width + 4, fs + 3); ctx.globalAlpha = 1;
        ctx.fillStyle = c.muted; ctx.fillText(p.title, plotL + 4, bx.top + 3);
      }
      ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.strokeRect(plotL + 0.5, Math.round(bx.top) + 0.5, plotR - plotL - 1, Math.round(bx.bottom - bx.top));
    }

    // Legend and corner label.
    if (spec.legend?.length) {
      let lx = plotL + 2; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (const item of spec.legend) {
        ctx.fillStyle = item.color; ctx.fillRect(lx, pad.t + fs / 2, 14, 3); lx += 19;
        ctx.fillStyle = c.text; ctx.fillText(item.text, lx, pad.t + fs / 2 + 1); lx += ctx.measureText(item.text).width + 16;
      }
    }
    if (spec.corner) {
      ctx.font = `bold ${fs + 3}px ${font}`; ctx.fillStyle = spec.corner.color; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillText(spec.corner.text, plotR - 6, boxes[0]!.top + 5); ctx.font = `${fs}px ${font}`;
    }

    // Crosshair and readout.
    const hv = this.#hover;
    if (hv && hv.x >= plotL && hv.x <= plotR && hv.y >= top && hv.y <= bottom && spec.readout) {
      let xv = X.kind === 'category' ? Math.round(((hv.x - plotL) / (plotR - plotL)) * (X.labels?.length ?? 1) - 0.5) : xInv(hv.x);
      if (spec.snap && spec.snap.length && X.kind !== 'category') xv = nearest(spec.snap, xv);
      const lines = spec.readout(xv);
      if (lines?.length) {
        const cx = X.kind === 'category' ? catX(xv) : xs(xv);
        ctx.strokeStyle = c.muted; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, top); ctx.lineTo(Math.round(cx) + 0.5, bottom); ctx.stroke(); ctx.setLineDash([]);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        const bw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 14, bh = lines.length * (fs + 5) + 8;
        let bxp = cx + 12; if (bxp + bw > plotR) bxp = cx - 12 - bw; bxp = Math.max(plotL, bxp);
        const byp = Math.min(Math.max(top, hv.y - bh - 8), bottom - bh);
        ctx.fillStyle = c.bg; ctx.globalAlpha = 0.94; ctx.fillRect(bxp, byp, bw, bh); ctx.globalAlpha = 1;
        ctx.strokeStyle = c.line; ctx.strokeRect(bxp + 0.5, byp + 0.5, bw, bh);
        ctx.fillStyle = c.text; lines.forEach((l, i) => ctx.fillText(l, bxp + 7, byp + 5 + i * (fs + 5)));
      }
    }
  }
}

function countIn(x: ArrayLike<number>, lo: number, hi: number): number { let n = 0; for (let i = 0; i < x.length; i++) if (x[i]! >= lo && x[i]! <= hi) n++; return n; }

/** The value of sorted `xs` closest to `v`. */
export function nearest(xs: ArrayLike<number>, v: number): number {
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m]! <= v) lo = m; else hi = m; }
  return Math.abs(xs[lo]! - v) <= Math.abs(xs[hi]! - v) ? xs[lo]! : xs[hi]!;
}
