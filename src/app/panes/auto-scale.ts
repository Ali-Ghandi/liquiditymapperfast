import type { CandleRow } from '../store.ts';

/**
 * The price axis fitted to what is on screen, as TradingView's "Auto (fits data to screen)" does (a user, 2026-11-19: "when I zoom out, candles
 * don't correct vertically"). On by default: every frame the price range is the highest high and lowest low of the candles drawn across the
 * view's time span, with room above and below, eased there so a zoom or a pan glides rather than jumps. A hand that moves the price on purpose
 * turns it off (HeatPane), and the "A" button, a double click on the price scale or Recenter turn it on again. Pure, so it is tested without
 * a canvas.
 */

/** The share of the plot's height left above the highest high, and below the lowest low where nothing else needs the room. */
export const AUTO_MARGIN = 0.08;
/** How quickly the axis eases to the fit, ms per e-fold: a few frames, gone before a hand notices it, smooth across a re-binning. */
export const AUTO_EASE_MS = 70;
/** The narrowest fit, as a share of the price: a flat run of candles is not stretched into noise. */
export const AUTO_MIN_SHARE = 0.002;

export interface PriceRange { lo: number; hi: number }

/** The first row whose candle ends after `t0` (rows in time order, each `tf` long). */
function firstEnding(rows: readonly CandleRow[], tf: number, t0: number): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid]![0] + tf <= t0) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * The lowest low and highest high of the candles (`tf` long, in time order) that overlap [t0, t1]; null where none do. Only the candles on
 * screen are read (a binary search finds the first), so it is cheap enough for every frame.
 */
export function visibleRange(rows: readonly CandleRow[], tf: number, t0: number, t1: number): PriceRange | null {
  if (!rows.length || !(t1 > t0) || !(tf > 0)) return null;
  let lo = Infinity, hi = -Infinity;
  for (let i = firstEnding(rows, tf, t0); i < rows.length; i++) {
    const c = rows[i]!;
    if (c[0] >= t1) break;
    if (c[3] > 0 && Number.isFinite(c[3])) lo = Math.min(lo, c[3]);
    if (c[2] > 0 && Number.isFinite(c[2])) hi = Math.max(hi, c[2]);
  }
  return hi >= lo ? { lo, hi } : null;
}

/** Both ranges together; either may be missing. */
export function mergeRange(a: PriceRange | null, b: PriceRange | null): PriceRange | null {
  if (!a) return b; if (!b) return a;
  return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) };
}

/** A price widens the range to take it in (the live price, between the candle's updates); none (0 or less) leaves it as it is. */
export function withPrice(r: PriceRange | null, price: number): PriceRange | null {
  if (!(price > 0) || !Number.isFinite(price)) return r;
  return r ? { lo: Math.min(r.lo, price), hi: Math.max(r.hi, price) } : { lo: price, hi: price };
}

/**
 * The price axis that shows `range` between `top` px from the top of a plot `plotH` px tall and `bottom` px from its foot. A range narrower
 * than AUTO_MIN_SHARE of `ref` (the price) is widened about its middle. The margins never take more than 70 % of the height between them.
 */
export function autoScaleView(range: PriceRange | null, o: { plotH: number; top: number; bottom: number; ref: number }): { p0: number; p1: number } | null {
  if (!range || !(o.plotH > 0)) return null;
  let { lo, hi } = range;
  const ref = o.ref > 0 ? o.ref : (lo + hi) / 2, least = ref * AUTO_MIN_SHARE;
  if (!(hi - lo >= least)) { const mid = (lo + hi) / 2; lo = mid - least / 2; hi = mid + least / 2; }
  let top = Math.max(0, o.top), bottom = Math.max(0, o.bottom);
  const room = top + bottom, most = o.plotH * 0.7;
  if (room > most) { top *= most / room; bottom *= most / room; }
  const perPx = (hi - lo) / (o.plotH - top - bottom);
  return { p0: lo - bottom * perPx, p1: hi + top * perPx };
}

/**
 * One frame of the ease from the axis shown (`cur`) to the fit (`target`), `dt` ms after the last: each end moves by 1 - e^(-dt/AUTO_EASE_MS)
 * of the way, and lands once both are within a quarter of a pixel of it (`plotH` says what a pixel is). An axis with no span yet, a jump of
 * more than ten heights (another market) or no time at all lands at once.
 */
export function easeRange(cur: { p0: number; p1: number }, target: { p0: number; p1: number }, dt: number, plotH: number): { p0: number; p1: number; settled: boolean } {
  const span = cur.p1 - cur.p0, tSpan = target.p1 - target.p0;
  if (!(span > 0) || !Number.isFinite(span) || !(plotH > 0)) return { ...target, settled: true };
  const px = Math.min(span, tSpan) / plotH, d0 = target.p0 - cur.p0, d1 = target.p1 - cur.p1;
  if (Math.abs(d0) <= px * 0.25 && Math.abs(d1) <= px * 0.25) return { ...target, settled: true };
  if (!(dt > 0) || Math.abs(d0) > span * 10 || Math.abs(d1) > span * 10 || tSpan > span * 10 || span > tSpan * 10) return { ...target, settled: true };
  const k = 1 - Math.exp(-Math.min(dt, 100) / AUTO_EASE_MS);
  return { p0: cur.p0 + d0 * k, p1: cur.p1 + d1 * k, settled: false };
}
