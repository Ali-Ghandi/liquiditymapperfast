import type { View } from '../view.ts';
import { PALETTES, mixHex, type Palette } from '../theme.ts';
import type { LabelBoard } from '../labels.ts';
import { t } from '../i18n.ts';
import { price as fmtPrice, usd } from '../format.ts';
import { ageAlpha, LABEL_FLOOR } from '../traded/carry.ts';
import { letterOf, pocRuns, type TpoProfile } from './model.ts';
import { TPO_TWO_DEFAULTS, type TpoSettings } from './settings.ts';

/**
 * Drawing the TPO on the map (Karl's reference, 2026-11-10: block profiles per session, coloured by the time of each block, the point of
 * control's row standing out, the value area full and the rest dimmer, the initial balance marked at the left, the open and the last price,
 * a few numbers under each profile). Each window's profile stands at its start, under the candles, over a backing that mutes the heat map;
 * laid out in time (`fold` 1), each block stands in its own column at its time, behind its own candles. By zoom: letters while a block is
 * big enough to hold one, blocks, then compact: zoomed out, each row as one bar as long as its blocks (Karl, 2026-11-11: a 1-pixel outline
 * vanished on the heat map, so the TPO seemed to be drawn only where the page had recorded), in the colour of when the market was at that
 * price, or of how full the row is; laid out, each block as one bar at its time. A block this market's wick alone reached (tpo/model.ts
 * `hollowRows`) is drawn as an outline; compact, each block's own rows are counted, as the point of control counts them, and what one chosen
 * market alone reached is left out. A block's cells share one colour, so they are filled a block at a time (by
 * time) or a row at a time (by row length).
 */

/** Where one profile's cells were drawn, for the pointer (`cellAt`) and the lit block (`paintLit`). */
export interface TpoGeometry {
  profile: TpoProfile;
  x0: number; cw: number; ucw: number; rh: number; fold: number;
  /** Per row, the blocks in it, oldest first (a folded row's cells in that order from `x0`). */
  rows: Map<number, number[]>;
  /** Block index to its unfolded x (the cell's left). */
  unfoldX: Map<number, number>;
  /** Drawn compact (rows or blocks too fine for cells): the row under the pointer is known, not the block. */
  compact: boolean;
  /** Per row, the blocks counted there (the compact bar's length). */
  solid: Map<number, { n: number; mean: number }>;
}

/** The time ramp, early to late: warm to cool as on the reference chart, a hue apart from the heat map's ramp (dark and light pages). */
const TIME_DARK = ['#ff6b6b', '#ff9f43', '#ffd166', '#a3e05f', '#3ddc97', '#35c9d6', '#4f9cff', '#9b7bff'];
const TIME_LIGHT = ['#d62f2f', '#dd5e0b', '#b07800', '#4e8f0f', '#0b9a6f', '#0f8ea3', '#1f6fd1', '#6a45e0'];
/** How full a row is: thin to full, cool to hot. */
const COUNT_DARK = ['#4f6bff', '#2fb7d6', '#3ddc97', '#ffd166', '#ff9f43', '#ff5c5c'];
const COUNT_LIGHT = ['#3550d8', '#0f8ea3', '#0b9a6f', '#b07800', '#dd5e0b', '#d62f2f'];
/** The Colour-blind safe themes' ramps: blue to yellow, one lightness step at a time, no red against green (for both orders); darker on a light page. */
const SAFE = ['#3b6fd8', '#2a9fd0', '#3fbfa8', '#9fcf6a', '#e8d64b', '#f5b941'];
const SAFE_LIGHT = ['#1f4fbf', '#1979ad', '#178f86', '#5f9a35', '#8f7f00', '#a8650a'];
/** The initial balance's and the single prints' marks: amber, as the other marks of what stands out. */
const AMBER_DARK = '#f2b84b', AMBER_LIGHT = '#a35f00';

function hex(c: string): [number, number, number] { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const rgb = (c: [number, number, number]): string => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
function at(stops: readonly string[], f: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, f)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), u = x - i;
  const a = hex(stops[i]!), b = hex(stops[i + 1]!);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}
const mixed = (a: [number, number, number], b: [number, number, number], f: number): [number, number, number] => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
/** Dark or white letters, whichever stands out more on the colour (WCAG luminance). */
function inkOn(c: [number, number, number]): string {
  const lin = (v: number): number => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  return (l + 0.05) / 0.0561 >= 1.05 / (l + 0.05) ? '#121418' : '#ffffff';
}

/** One colour of a ramp: its fill, its light stripe (the point of control's row) and the letters on each. */
interface Swatch { fill: string; stripe: string; ink: string; stripeInk: string }
const swatches = new Map<string, Swatch[]>();
/** `n` colours along a ramp (cached), each with its stripe and inks. */
function ramp(stops: readonly string[], n: number, dark: boolean): Swatch[] {
  const key = `${stops.join()}|${n}|${dark}`;
  let out = swatches.get(key);
  if (!out) {
    out = [];
    const light: [number, number, number] = dark ? [255, 255, 255] : [27, 29, 33];
    for (let i = 0; i < n; i++) { const c = at(stops, n > 1 ? i / (n - 1) : 0), s = mixed(c, light, 0.72); out.push({ fill: rgb(c), stripe: rgb(s), ink: inkOn(c), stripeInk: inkOn(s) }); }
    if (swatches.size > 64) swatches.clear();
    swatches.set(key, out);
  }
  return out;
}
/**
 * Edges on the device's pixel grid (2026-11-20): a cell's top, bottom, left and right are each rounded to a device pixel, so rows tile with no
 * seam or blur and every cell of a row is as tall as the next (a fractional edge was smeared over two pixels). The canvas's own transform says
 * where the pixels are; one without it (a test's) is left as it is.
 */
export interface Snap { x: (v: number) => number; y: (v: number) => number; px: number }
export function snapOf(ctx: CanvasRenderingContext2D): Snap {
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  if (!m || !(m.a > 0) || !(m.d > 0)) return { x: v => v, y: v => v, px: 1 };
  const { a, d, e, f } = m;
  return { x: v => (Math.round(v * a + e) - e) / a, y: v => (Math.round(v * d + f) - f) / d, px: 1 / a };
}
const ease = (u: number): number => u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;

/**
 * A profile's rows (as drawn: with what one market alone reached), each block's index in them (worked out when cells are drawn), its hollow
 * rows, and per row the blocks counted there (each block's own rows, not what one market alone reached) and the mean of their letters (when
 * the market was at that price, for the compact look), kept per profile.
 */
interface Layout { rows: Map<number, number[]>; maxCount: number; index: () => Map<number, Map<number, number>>; hollow: Map<number, ReadonlySet<number>>; solid: Map<number, { n: number; mean: number }> }
const layouts = new WeakMap<TpoProfile, Layout>();
function layoutOf(p: TpoProfile): Layout {
  let out = layouts.get(p);
  if (!out) {
    const rows = new Map<number, number[]>(), solid = new Map<number, { n: number; mean: number }>();
    for (const b of p.blocks) for (let r = b.ra; r <= b.rz; r++) {
      const list = rows.get(r); if (list) list.push(b.k); else rows.set(r, [b.k]);
      if (r >= b.a && r <= b.z) { const s = solid.get(r); if (s) { s.mean += (b.k - s.mean) / ++s.n; } else solid.set(r, { n: 1, mean: b.k }); }
    }
    let maxCount = 0, index: Map<number, Map<number, number>> | null = null;
    for (const list of rows.values()) maxCount = Math.max(maxCount, list.length);
    const indexOf = (): Map<number, Map<number, number>> => {
      if (!index) { index = new Map(); for (const [r, list] of rows) list.forEach((k, i) => { let m = index!.get(k); if (!m) { m = new Map(); index!.set(k, m); } m.set(r, i); }); }
      return index;
    };
    out = { rows, maxCount, index: indexOf, hollow: new Map(p.blocks.map(b => [b.k, b.hollow])), solid };
    layouts.set(p, out);
  }
  return out;
}

/** What `paintCompact` draws one profile with. */
interface Compact {
  prof: TpoProfile; x0: number; cw: number; ucw: number; rh: number; fold: number; yTop: (r: number) => number;
  solid: Map<number, { n: number; mean: number }>; maxCount: number; winPx: number;
  colours: Swatch[]; byTime: boolean; fade: number; ph: number; unfoldX: Map<number, number>;
  /** The blocks' opacity inside the value area and outside it (0..1); the Two colours look's swatches (inside, outside), and the POC's own. */
  inA: number; outA: number; two: [Swatch, Swatch] | null; pocSw: Swatch | null;
}

/**
 * How opaque the casing under a compact profile is: the page's background, a pixel round each bar, so a profile a few pixels wide keeps its
 * edges over a hot heat map (Karl, 2026-11-12: at a two-month zoom the strips blended into the map's blues and oranges).
 */
export const CASING_ALPHA = 0.85;

/** Narrower than this (its longest row, px), a profile zoomed out is drawn as a strip: too thin for its shape to show. */
const STRIP_PX = 3;

/**
 * Compact, for rows or blocks too fine for cells. Folded: the rows are gathered into the pixel rows they fall in, each drawn once as a bar as
 * long as its longest row (its blocks not hollow), in the colour of the mean time of its blocks (when the market was at that price) or of its
 * length, the value area in full and the rest dimmer, the point of control's as the light stripe. Laid out: each block as one bar at its time,
 * from its low to its high. The bars are gathered into a batch to be drawn later; the casing under each, a pixel larger all round, is added to
 * `casing` (x, y, width, height, ...), which is filled under every compact profile before any of them is drawn, so a neighbour's casing never
 * covers a profile drawn before it.
 */
function compactBars(c: Compact, casing: number[]): RectBatch {
  const { prof, x0, cw, rh, yTop, solid, colours, byTime, fade, ph } = c, batch = new RectBatch();
  if (c.fold < 0.5 && (c.winPx < 2 * STRIP_PX || c.maxCount * cw < STRIP_PX)) {
    // A strip as wide as the profile: its range dim, its value area in full and its point of control's row as the light stripe, in the
    // colour of when the market was at the point of control (a year on the map: each day's value moving, at a few rectangles a day).
    const s = solid.get(prof.poc), sw = c.two ? c.two[0] : byTime ? colours[Math.min(colours.length - 1, Math.max(0, Math.round(s?.mean ?? 0)))]! : colours[colours.length - 1]!;
    const w = Math.max(1, Math.min(c.maxCount * cw, Math.max(1, c.winPx))), top = (r: number): number => yTop(r), bottom = (r: number): number => yTop(r) + rh;
    const span = (a: number, z: number): [number, number] => { const y0 = Math.floor(top(z)), y1 = Math.max(y0 + 1, Math.ceil(bottom(a))); return [y0, y1 - y0]; };
    const [ry, rh2] = span(prof.lo, prof.hi), [vy, vh] = span(prof.val, prof.vah), [py, phh] = span(prof.poc, prof.poc);
    casing.push(x0 - 1, ry - 1, w + 2, rh2 + 2);
    batch.add(c.two ? c.two[1].fill : sw.fill, fade * c.outA, x0, ry, w, rh2);
    batch.add(sw.fill, fade * c.inA, x0, vy, w, vh);
    batch.add(c.pocSw ? c.pocSw.fill : sw.stripe, fade * c.inA, x0, py, w, phh);
  } else if (c.fold < 0.5) {
    // Rows a pixel tall or more: one bar each. Finer: the rows whose tops fall in one pixel row make one bar a pixel tall.
    interface Px { y: number; h: number; n: number; kSum: number; kN: number; va: boolean; poc: boolean }
    const bins: Px[] = [], fine = rh < 1;
    let cur: Px | null = null;
    for (let r = prof.drawHi; r >= prof.drawLo; r--) {
      const s = solid.get(r);
      if (!s) continue;
      const top = yTop(r);
      if (top + rh < 0 || top > ph) continue;
      const y = fine ? Math.floor(top) : top;
      if (!cur || !fine || y !== cur.y) { cur = { y, h: fine ? 1 : rh, n: 0, kSum: 0, kN: 0, va: false, poc: false }; bins.push(cur); }
      cur.n = Math.max(cur.n, s.n); cur.kSum += s.mean * s.n; cur.kN += s.n;
      if (r >= prof.val && r <= prof.vah) cur.va = true;
      if (r === prof.poc) cur.poc = true;
    }
    for (const b of bins) {
      const sw = c.two ? c.two[b.poc || b.va ? 0 : 1] : byTime ? colours[Math.min(colours.length - 1, Math.max(0, Math.round(b.kSum / b.kN)))]! : colours[Math.min(colours.length - 1, Math.max(0, b.n - 1))]!;
      casing.push(x0 - 1, b.y - 1, Math.max(1, b.n * cw) + 2, b.h + 2);
      batch.add(b.poc ? (c.pocSw ? c.pocSw.fill : sw.stripe) : sw.fill, fade * (b.poc || b.va ? c.inA : c.outA), x0, b.y, Math.max(1, b.n * cw), b.h);
    }
  } else {
    const mid = colours[Math.floor((colours.length - 1) / 2)]!;
    for (const b of prof.blocks) {
      const x = c.unfoldX.get(b.k) ?? 0, y = yTop(b.z), h = Math.max(1, yTop(b.a) + rh - y);
      if (y > ph || y + h < 0) continue;
      casing.push(x - 1, y - 1, c.ucw + 2, h + 2);
      batch.add((c.two ? c.two[0] : byTime ? colours[Math.min(colours.length - 1, Math.max(0, b.k))]! : mid).fill, fade * c.inA, x, y, c.ucw, h);
    }
  }
  return batch;
}

/** Rectangles `xs` (x, y, width, height, ...) filled in one colour and alpha, as one path: one fill for all of them. */
function fillRects(ctx: CanvasRenderingContext2D, style: string, alpha: number, xs: readonly number[]): void {
  if (!xs.length) return;
  ctx.globalAlpha = alpha; ctx.fillStyle = style; ctx.beginPath();
  for (let i = 0; i < xs.length; i += 4) ctx.rect(xs[i]!, xs[i + 1]!, xs[i + 2]!, xs[i + 3]!);
  ctx.fill();
}

/** Rectangles gathered by colour and alpha, filled one group at a time (a profile zoomed out is hundreds of bars in a few colours). */
class RectBatch {
  /** By alpha, then colour: no key is built for a rectangle. */
  readonly #groups = new Map<number, Map<string, number[]>>();
  add(style: string, alpha: number, x: number, y: number, w: number, h: number): void {
    let byStyle = this.#groups.get(alpha);
    if (!byStyle) { byStyle = new Map(); this.#groups.set(alpha, byStyle); }
    let xs = byStyle.get(style);
    if (!xs) { xs = []; byStyle.set(style, xs); }
    xs.push(x, y, w, h);
  }
  flush(ctx: CanvasRenderingContext2D): void { for (const [alpha, byStyle] of this.#groups) for (const [style, xs] of byStyle) fillRects(ctx, style, alpha, xs); this.#groups.clear(); }
}

export interface TpoPaint {
  profiles: readonly TpoProfile[];
  settings: TpoSettings;
  view: View; pw: number; ph: number; p: Palette;
  labels: LabelBoard;
  /** 0 folded, 1 laid out in time, between while it moves. */
  fold: number;
  /** How old each window is among those drawn (0 the newest). */
  rank: (key: string) => number;
  name: (p: TpoProfile) => string;
  now: number;
  /** Whether the Volume profile's lines stand for a window (then the TPO draws no point-of-control line of its own for it). */
  linesFor: (key: string) => boolean;
}

/** One colour as a swatch (its stripe and inks), for the colours chosen by hand. */
const solid = (c: string, dark: boolean): Swatch => ramp([c, c], 1, dark)[0]!;

/** The colours and opacities a frame paints with, worked out once (`paintTpo`). */
export interface TpoInk { ib: string; singles: string; poc: string; va: string; naked: string; inA: number; outA: number; two: [Swatch, Swatch] | null; pocSw: Swatch | null }
/** The colours of the marks and lines: each the one chosen (settings `colors`), else the theme's (amber marks; the point of control's colour for the lines). */
export function tpoInk(s: Pick<TpoSettings, 'colors' | 'colour' | 'inAlpha' | 'outAlpha'>, p: Palette): TpoInk {
  const safe = p === PALETTES.colorblind || p === PALETTES.daylight, amber = safe ? p.text : p.dark ? AMBER_DARK : AMBER_LIGHT, c = s.colors;
  return {
    ib: c.ib ?? amber, singles: c.singles ?? amber, poc: c.poc ?? p.poc, va: c.va ?? p.poc, naked: c.naked ?? c.poc ?? p.poc,
    inA: s.inAlpha / 100, outA: s.outAlpha / 100,
    two: s.colour === 'two' ? [solid(c.inside ?? TPO_TWO_DEFAULTS.inside, p.dark), solid(c.outside ?? TPO_TWO_DEFAULTS.outside, p.dark)] : null,
    pocSw: c.poc ? solid(c.poc, p.dark) : null,
  };
}

/** Runs of consecutive rows (each `[low, high]`), from rows in any order. */
export function zones(rows: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const r of [...rows].sort((a, b) => a - b)) { const last = out[out.length - 1]; if (last && r === last[1] + 1) last[1] = r; else out.push([r, r]); }
  return out;
}

export function paintTpo(ctx: CanvasRenderingContext2D, o: TpoPaint): TpoGeometry[] {
  const out: TpoGeometry[] = [];
  const { view: v, pw, ph, p, settings: s } = o, dark = p.dark, safe = p === PALETTES.colorblind || p === PALETTES.daylight;
  const safeStops = dark ? SAFE : SAFE_LIGHT;
  const timeStops = safe ? safeStops : dark ? TIME_DARK : TIME_LIGHT, countStops = safe ? safeStops : dark ? COUNT_DARK : COUNT_LIGHT;
  // Fork: "In ink" counts the row's blocks as By row length does, from the page's paper to its ink (one hue, as print), so the profile reads
  // on a quiet page without competing with the candles' and the VWAPs' colours.
  const inkStops = [mixHex(p.bg, p.level, 0.28), mixHex(p.bg, p.text, 0.72)];
  const ink = tpoInk(s, p), { two, pocSw, inA, outA } = ink, snap = snapOf(ctx);
  const fold = ease(Math.max(0, Math.min(1, o.fold)));
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
  // Each profile is laid out first and drawn after (`jobs`, in order), so the compact ones' casing goes under all of them at once.
  const jobs: (() => void)[] = [], casing: number[] = [];
  for (const prof of o.profiles) {
    const wx0 = v.xOf(prof.from, pw), wx1 = v.xOf(Math.min(prof.to, Math.max(o.now, prof.from + prof.blockMs)), pw);
    if (wx1 < 0 || wx0 > pw) continue;
    const rh = Math.abs(v.yOf(0, ph) - v.yOf(prof.R, ph));
    const yTop = (r: number): number => v.yOf((r + 1) * prof.R, ph);
    if (yTop(prof.drawLo - 1) < -40 || yTop(prof.drawHi) > ph + 40) continue;
    const { rows, maxCount, index: indexOf, hollow, solid: counted } = layoutOf(prof);
    // Blocks no wider than 16 px, the longest row no wider than three fifths of the window on the chart (its candles keep the rest), as the
    // Volume profile's windows.
    // Never wider than its window either: zoomed out to months, a day of a few pixels would otherwise lie over the days after it.
    const winPx = v.xOf(prof.to, pw) - wx0, room = Math.max(Math.min(8, winPx), winPx * 0.6);
    // Blocks need not be square (2026-11-20, as TradingView's): each is as wide as the room the window gives the longest row allows, up to
    // 16 px, so a profile is never a sliver as wide as its rows are tall (a week of thin rows was 100 px in a 400 px week).
    const cw = Math.min(16, room / Math.max(1, maxCount));
    const compact = rh < 1.6 || cw < 1.6;
    const x0 = Math.max(wx0, Math.min(0, wx1 - maxCount * cw)), blockPx = v.xOf(prof.from + prof.blockMs, pw) - wx0;
    const ucw = Math.max(1, Math.min(cw, blockPx - 1));
    const unfoldX = new Map<number, number>();
    for (const b of prof.blocks) unfoldX.set(b.k, v.xOf(b.t, pw) + (blockPx - ucw) / 2);
    out.push({ profile: prof, x0, cw, ucw, rh, fold, rows, unfoldX, compact, solid: counted });
    const fade = ageAlpha(o.rank(prof.key)), n = Math.max(1, Math.round((prof.to - prof.from) / prof.blockMs));
    const gap = cw >= 5 && rh >= 5 ? 1 : 0, cellW = fold > 0.5 ? ucw : cw;
    // Letters where the cell as drawn can hold one: a row of about 11 px and a cell of about 7 (Auto), or 6 px when letters are asked for.
    const letters = s.look === 'letters' ? cellW >= 6 && rh >= 7 : s.look === 'auto' && rh >= 11 && cellW >= 7;
    const xAt = (r: number, i: number, k: number): number => x0 + i * cw + ((unfoldX.get(k) ?? 0) - x0 - i * cw) * fold;
    // A cell's box on the device's pixels: its edges are the row's and the column's edges rounded, so neighbours share them exactly.
    const box = (r: number, x: number): [number, number, number, number] => {
      const ya = snap.y(yTop(r)), yb = snap.y(yTop(r) + rh), xa = snap.x(x), xb = snap.x(x + cellW);
      return [xa, ya, Math.max(snap.px, xb - xa - gap), Math.max(snap.px, yb - ya - gap)];
    };
    const backing = dark ? 'rgba(0,0,0,0.62)' : 'rgba(255,255,255,0.72)';
    const byTime = s.colour === 'time' && !two, colours = byTime ? ramp(timeStops, n, dark) : ramp(s.colour === 'ink' ? inkStops : countStops, Math.max(1, maxCount), dark);
    const inVa = (r: number): boolean => r >= prof.val && r <= prof.vah;
    const bars = compact ? compactBars({ prof, x0, cw, ucw, rh, fold, yTop, solid: counted, maxCount, winPx, colours, byTime, fade, ph, unfoldX, inA, outA, two, pocSw }, casing) : null;
    jobs.push(() => {
      if (bars) { bars.flush(ctx); ctx.globalAlpha = 1; }
      else {
        const index = indexOf();
        // The backing first (not faded: it mutes the heat map under every block alike), then the blocks.
        ctx.globalAlpha = 1; ctx.fillStyle = backing;
        if (fold < 0.5) for (const [r, list] of rows) { const ya = snap.y(yTop(r)), xa = snap.x(x0 - 1); ctx.fillRect(xa, ya, snap.x(x0 + list.length * cw) - xa, snap.y(yTop(r) + rh) - ya); }
        else for (const b of prof.blocks) { const x = xAt(b.ra, index.get(b.k)!.get(b.ra)!, b.k), xa = snap.x(x - 1), ya = snap.y(yTop(b.rz)); ctx.fillRect(xa, ya, snap.x(x + cellW + 1) - xa, snap.y(yTop(b.ra) + rh) - ya); }
        const swatchOf = (k: number, r: number): Swatch => two ? two[inVa(r) ? 0 : 1] : byTime ? colours[Math.min(colours.length - 1, Math.max(0, k))]! : colours[Math.max(0, (rows.get(r)?.length ?? 1) - 1)]!;
        // A cell: filled, or an outline where it is hollow.
        const cell = (r: number, x: number, sw: Swatch, hollowCell: boolean): void => {
          const y = yTop(r);
          if (y > ph || y + rh < 0) return;
          const [bx, by, bw, bh] = box(r, x);
          if (hollowCell) { ctx.strokeStyle = sw.fill; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, Math.max(1, bw - 1), Math.max(1, bh - 1)); }
          else ctx.fillRect(bx, by, bw, bh);
        };
        // Three passes, one alpha each: the value area, the rows outside it (dimmer by default), the point of control's row (its own colour, or a light stripe).
        for (const pass of [0, 1, 2] as const) {
          ctx.globalAlpha = fade * (pass === 1 ? outA : inA);
          const wanted = (r: number): boolean => pass === 2 ? r === prof.poc : r !== prof.poc && (pass === 0) === inVa(r);
          const style = (sw: Swatch): string => pass === 2 ? (pocSw ? pocSw.fill : sw.stripe) : sw.fill;
          if (byTime) {
            for (const b of prof.blocks) {
              const sw = swatchOf(b.k, 0), rowIndex = index.get(b.k)!;
              ctx.fillStyle = style(sw);
              for (let r = b.ra; r <= b.rz; r++) if (wanted(r)) cell(r, xAt(r, rowIndex.get(r)!, b.k), sw, b.hollow.has(r));
            }
          } else {
            for (const [r, list] of rows) {
              if (!wanted(r)) continue;
              const sw = swatchOf(0, r); ctx.fillStyle = style(sw);
              for (let i = 0; i < list.length; i++) { const k = list[i]!; cell(r, xAt(r, i, k), sw, hollow.get(k)?.has(r) ?? false); }
            }
          }
        }
        if (letters) {
          // Letters: on the colour in the ink that stands out on it; outside the value area in the page's text colour over the dim cell.
          ctx.font = `600 ${Math.max(7, Math.min(12, Math.floor(Math.min(rh * 0.78, cellW * 1.05))))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          for (const b of prof.blocks) {
            const rowIndex = index.get(b.k)!, letter = letterOf(b.k);
            for (let r = b.ra; r <= b.rz; r++) {
              const y = yTop(r); if (y > ph || y + rh < 0) continue;
              const sw = swatchOf(b.k, r), poc = r === prof.poc, va = inVa(r), hollowCell = b.hollow.has(r), [bx, by, bw, bh] = box(r, xAt(r, rowIndex.get(r)!, b.k));
              // Outside the value area the cell is dim: the letter is the page's text there, unless the cells are opaque enough to carry their own ink.
              const onCell = poc || va || outA >= 0.7;
              ctx.fillStyle = hollowCell ? sw.fill : poc ? (pocSw ? pocSw.ink : sw.stripeInk) : onCell ? sw.ink : p.text;
              ctx.globalAlpha = fade * (hollowCell || poc || va ? 1 : 0.8);
              ctx.fillText(letter, bx + bw / 2, by + bh / 2 + 0.5);
            }
          }
        }
      }
      ctx.globalAlpha = 1;
      const label = (text: string, x: number, y: number, colour: string, align: CanvasTextAlign, alpha: number): void => {
        ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; const tw = ctx.measureText(text).width + 8;
        // Kept inside the plot at the right (the window under way stands at the live edge, where a name would run off the map); a name meant
        // to stand left of something that is off the map at the left is left out rather than pushed onto the profile.
        if (align === 'right' && x - tw < 0) return;
        const bx = Math.min(pw - tw - 2, align === 'right' ? x - tw : x);
        if (!o.labels.claim({ x0: bx, x1: bx + tw, y0: y - 7, y1: y + 7 })) return;
        ctx.globalAlpha = 0.85 * alpha; ctx.fillStyle = p.panel; ctx.fillRect(bx, y - 7, tw, 14);
        ctx.globalAlpha = alpha; ctx.fillStyle = colour; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + 4, y);
      };
      // A level across the rest of the window, from after the profile's cells (or the window's start, laid out) to its end.
      const hline = (y: number, from: number, to: number, colour: string, width: number, dash: number[], alpha: number): void => {
        const yy = Math.round(y) + (width % 2 ? 0.5 : 0); if (yy < -2 || yy > ph + 2 || to <= from) return;
        ctx.globalAlpha = alpha; ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(from, yy); ctx.lineTo(to, yy); ctx.stroke(); ctx.setLineDash([]);
      };
      const named = Math.max(LABEL_FLOOR, fade), end = Math.min(pw, wx1), after = (r: number): number => x0 + (rows.get(r)?.length ?? 0) * cw + 4;
      if (s.ib && !compact && prof.ibh !== null && prof.ibl !== null && fold < 0.5) {
        // The initial balance: a bracket at the left edge over the first hour's range, named at its two ends, and its edges run on faintly
        // across the window, so a break out of the first hour's range reads at a glance (range extension).
        const yA = snap.y(yTop(prof.ibh)), yB = snap.y(yTop(prof.ibl) + rh), bx = x0 - 5;
        ctx.globalAlpha = fade; ctx.strokeStyle = ink.ib; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(bx + 3, yA); ctx.lineTo(bx, yA); ctx.lineTo(bx, yB); ctx.lineTo(bx + 3, yB); ctx.stroke();
        hline(yA, x0 + maxCount * cw + 4, end, ink.ib, 1, [2, 4], 0.45 * fade); hline(yB, x0 + maxCount * cw + 4, end, ink.ib, 1, [2, 4], 0.45 * fade);
        if (rh * (prof.ibh - prof.ibl + 1) > 30) { label(t('IBH'), bx - 3, yA + 4, ink.ib, 'right', named); label(t('IBL'), bx - 3, yB - 4, ink.ib, 'right', named); }
        // The open (the window's first price) and the last price: small arrows at the left edge and after the last row's cells.
        ctx.fillStyle = p.text; ctx.globalAlpha = 0.9 * fade;
        if (prof.open !== null) { const y = yTop(prof.open) + rh / 2; ctx.beginPath(); ctx.moveTo(x0 - 1, y); ctx.lineTo(x0 - 6, y - 3.5); ctx.lineTo(x0 - 6, y + 3.5); ctx.closePath(); ctx.fill(); }
        if (prof.close !== null) {
          const y = yTop(prof.close) + rh / 2, x = x0 + (rows.get(prof.close)?.length ?? 0) * cw + 2;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 5, y - 3.5); ctx.lineTo(x + 5, y + 3.5); ctx.closePath(); ctx.fill();
        }
      }
      if (s.calls && !compact && fold < 0.5) {
        // Single prints: a bar after each row's cell, and each run of them shaded across the rest of the window (where price moved too fast
        // to trade twice: the market often comes back to fill it).
        for (const [a, z] of zones(prof.singles)) {
          const ya = snap.y(yTop(z)), yb = snap.y(yTop(a) + rh), from = x0 + cw + 1;
          ctx.globalAlpha = 0.9 * fade; ctx.fillStyle = ink.singles; ctx.fillRect(from, ya, 2, Math.max(1, yb - ya));
          if (end > from + 4) { ctx.globalAlpha = 0.13 * fade; ctx.fillRect(from + 2, ya, end - from - 2, Math.max(1, yb - ya)); }
        }
        // The extremes' calls, with how many of the four row grids agree; an unsure one in amber. A poor extreme is also marked by a dotted
        // line across the window at its edge: unfinished business the market tends to revisit.
        const call = (what: TpoProfile['top'], votes: number, top: boolean): void => {
          if (what === 'neither') return;
          if (what === 'poor') hline(top ? snap.y(yTop(prof.hi)) : snap.y(yTop(prof.lo) + rh), x0, end, votes >= 3 ? p.muted : ink.ib, 1, [1, 3], 0.8 * fade);
          const text = `${what === 'poor' ? (top ? t('Poor high') : t('Poor low')) : t('Tail')} · ${votes}/4`;
          label(text, x0, top ? yTop(prof.drawHi) - 9 : yTop(prof.drawLo) + rh + 9, votes >= 3 ? p.muted : ink.ib, 'left', named);
        };
        call(prof.top, prof.topVotes, true); call(prof.bottom, prof.bottomVotes, false);
      }
      if (s.stats && !compact && fold < 0.5) {
        // A few numbers under the profile: the range, the initial balance, the TPOs above and below the point of control.
        const step = prof.R, y0 = yTop(prof.drawLo) + rh + (s.calls && prof.bottom !== 'neither' ? 24 : 12);
        const ib = prof.ibh !== null && prof.ibl !== null ? (prof.ibh - prof.ibl + 1) * step : null;
        const first = `${t('Range')} ${fmtPrice(prof.high - prof.low, step)}${ib !== null ? ` · ${t('IB')} ${fmtPrice(ib, step)}` : ''}`;
        const second = `${t('TPO')} ${prof.total} · ▲${prof.above} ▼${prof.below}${prof.usd > 0 ? ` · $${usd(prof.usd)}` : ''}${prof.developing ? ` · ${t('developing')}` : ''}`;
        label(first, x0, y0, p.muted, 'left', named);
        label(second, x0, y0 + 15, p.muted, 'left', named);
      }
      if (!o.linesFor(prof.key)) {
        // The point of control, and the value area's high and low, across the rest of the window, where the Volume profile's lines do not
        // stand for it: the high at the top of its row, the low at the bottom of its, as the levels are read (`levelsOfProfile`).
        const from = (r: number): number => fold < 0.5 ? after(r) : Math.max(0, wx0);
        const pocY = yTop(prof.poc) + rh / 2;
        if (!compact) {
          hline(yTop(prof.vah), from(prof.vah), end, ink.va, 1, [6, 4], 0.75 * fade);
          hline(yTop(prof.val) + rh, from(prof.val), end, ink.va, 1, [6, 4], 0.75 * fade);
        }
        if (end > from(prof.poc) + 10) {
          ctx.globalAlpha = 0.9 * fade; ctx.strokeStyle = ink.poc; ctx.lineWidth = 1.5; ctx.setLineDash([]);
          const y = Math.round(pocY) + 0.5; ctx.beginPath(); ctx.moveTo(from(prof.poc), y); ctx.lineTo(end, y); ctx.stroke();
          if (end - from(prof.poc) > 90) {
            const name = o.name(prof);
            label(`${name ? `${name} ` : ''}${t('TPO')} ${t('POC')} ${fmtPrice((prof.poc + 0.5) * prof.R, prof.R)}`, end - 2, y, ink.poc, 'right', named);
            if (!compact) { label(`${t('VAH')} ${fmtPrice((prof.vah + 1) * prof.R, prof.R)}`, end - 2, yTop(prof.vah), ink.va, 'right', named); label(`${t('VAL')} ${fmtPrice(prof.val * prof.R, prof.R)}`, end - 2, yTop(prof.val) + rh, ink.va, 'right', named); }
          }
        }
      }
      ctx.globalAlpha = 1;
    });
  }
  // The casing, in the page's colour and not faded (it parts every compact profile from the map alike), as one path: where two overlap it is
  // filled once, not darker.
  fillRects(ctx, p.bg, CASING_ALPHA, casing);
  ctx.globalAlpha = 1;
  for (const job of jobs) job();
  if (s.naked) paintNaked(ctx, o, ink.naked);
  ctx.restore();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  return out;
}

/**
 * Points of control carried on (fork; 2026-11-20 as TradingView's "extend until intersected"): from the end of each closed window, a thin
 * dashed line at its TPO point of control, to where a later block first traded through it (fainter, unnamed), or, still naked, to the right
 * edge, named "nPOC" with its price there, where the labels leave room.
 */
function paintNaked(ctx: CanvasRenderingContext2D, o: TpoPaint, colour: string): void {
  const { view: v, pw, ph, p } = o;
  ctx.strokeStyle = colour; ctx.lineWidth = 1;
  for (const n of pocRuns(o.profiles)) {
    const y = Math.round(v.yOf(n.price, ph)) + 0.5, from = Math.max(0, v.xOf(n.from, pw)), to = n.until === null ? pw : Math.min(pw, v.xOf(n.until, pw));
    if (y < 0 || y > ph || to - from < 3) continue;
    ctx.globalAlpha = n.until === null ? 0.85 : 0.4; ctx.setLineDash(n.until === null ? [4, 3] : [2, 3]);
    ctx.beginPath(); ctx.moveTo(from, y); ctx.lineTo(to, y); ctx.stroke(); ctx.setLineDash([]);
    if (n.until !== null || from >= pw - 10) continue;
    const text = `${t('nPOC')} ${fmtPrice(n.price, n.R)}`;
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 8, bx = pw - tw - 2;
    if (bx > from && o.labels.claim({ x0: bx, x1: bx + tw, y0: y - 7, y1: y + 7 })) {
      ctx.globalAlpha = 0.85; ctx.fillStyle = p.panel; ctx.fillRect(bx, y - 7, tw, 14);
      ctx.globalAlpha = 1; ctx.fillStyle = colour; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + 4, y);
    }
  }
  ctx.globalAlpha = 1;
}

/** The block under the pointer, on the pointer's own layer: its cells framed wherever they stand, and its time lit across the map. */
export function paintLit(ctx: CanvasRenderingContext2D, geo: TpoGeometry, k: number, v: View, pw: number, ph: number, p: Palette): void {
  const prof = geo.profile, b = prof.blocks.find(x => x.k === k);
  if (!b) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
  const a = v.xOf(b.t, pw), z = v.xOf(b.t + prof.blockMs, pw);
  ctx.globalAlpha = 0.08; ctx.fillStyle = p.text; ctx.fillRect(a, 0, Math.max(1, z - a), ph);
  const gap = geo.cw >= 5 && geo.rh >= 5 ? 1 : 0, w = Math.max(1, (geo.fold > 0.5 ? geo.ucw : geo.cw) - gap), h = Math.max(1, geo.rh - gap);
  ctx.globalAlpha = 1; ctx.strokeStyle = p.text; ctx.lineWidth = 1;
  for (let r = b.ra; r <= b.rz; r++) {
    const list = geo.rows.get(r), i = list?.indexOf(k) ?? -1;
    if (i < 0) continue;
    const x = geo.x0 + i * geo.cw + ((geo.unfoldX.get(k) ?? 0) - geo.x0 - i * geo.cw) * geo.fold, y = v.yOf((r + 1) * prof.R, ph);
    ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
  }
  ctx.restore();
}

/** The block and row under (x, y) on the profiles drawn last, the newest drawn first. */
export function cellAt(geos: readonly TpoGeometry[], x: number, y: number, view: View, ph: number): { geo: TpoGeometry; k: number; r: number } | null {
  for (let g = geos.length - 1; g >= 0; g--) {
    const geo = geos[g]!, prof = geo.profile, price = view.pOf(y, ph), r = Math.floor(price / prof.R * (1 + 1e-12)), list = geo.rows.get(r);
    if (!list) continue;
    if (geo.compact && geo.fold < 0.5) { const n = geo.solid.get(r)?.n ?? 0; if (n && x >= geo.x0 && x <= geo.x0 + Math.max(1, n * geo.cw)) return { geo, k: list[0]!, r }; continue; }
    for (let i = 0; i < list.length; i++) {
      const k = list[i]!, cx = geo.x0 + i * geo.cw + ((geo.unfoldX.get(k) ?? 0) - geo.x0 - i * geo.cw) * geo.fold, w = geo.fold > 0.5 ? geo.ucw : geo.cw;
      if (x >= cx - 1 && x <= cx + w + 1) return { geo, k, r };
    }
  }
  return null;
}
