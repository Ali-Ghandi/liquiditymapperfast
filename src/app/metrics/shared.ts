/**
 * What the metric views share (`view.ts`, `pos-view.ts`): the five-minute cache of loaded series, the daily perpetual closes, the loading
 * note, and number formats.
 */
import { t } from '../i18n.ts';
import type { Colours } from './plot.ts';
import { DAY_MS } from './math.ts';
import { binanceCloses, type Candles } from './data.ts';

export const STALE_MS = 5 * 60_000;

/** The view's colours: the chart's own and the series' (`MetricsView#colours`). */
export type Palette = Colours & { series: string; series2: string; purple: string; soft: string; flagBar: string; bar: string; barSoft: string; accentSoft: string };

export const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '–');
/** An axis label with a decimal only where the ticks are closer than 1 apart. */
export const axis = (v: number, step: number): string => v.toFixed(step < 1 ? 1 : 0);
export const signed = (v: number, d = 1): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}` : '–');

/** Only candles that have closed: a candle still under way is not a close. */
export function closed(s: Candles, step: number, now = Date.now()): Candles {
  let n = s.time.length;
  while (n > 0 && s.time[n - 1]! + step > now) n--;
  return { time: s.time.slice(0, n), close: s.close.slice(0, n), high: s.high.slice(0, n), low: s.low.slice(0, n) };
}

/** A cache of one loaded series that covers back to `start`, read again after five minutes. */
export class Cached<T> {
  #value: { start: number; at: number; data: T } | null = null;
  #pending: Promise<T> | null = null;
  #pendingStart = Infinity;
  constructor(private load: (start: number) => Promise<T>) {}
  get(start: number, force = false): Promise<T> {
    const v = this.#value;
    if (!force && v && v.start <= start && Date.now() - v.at < STALE_MS) return Promise.resolve(v.data);
    if (this.#pending && this.#pendingStart <= start) return this.#pending;
    const from = Math.min(start, v?.start ?? Infinity);
    this.#pendingStart = from;
    this.#pending = this.load(from).then(data => { this.#value = { start: from, at: Date.now(), data }; return data; }).finally(() => { this.#pending = null; this.#pendingStart = Infinity; });
    return this.#pending;
  }
}

let progressNote: (text: string) => void = () => {};
/** Where loading progress is told (the view's status line). */
export const setProgressNote = (f: (text: string) => void): void => { progressNote = f; };
export const progress = (what: string) => (done: number, total: number): void => progressNote(t('Loading {what} {done}/{total}…', { what, done, total }));

export const dailyPerp = new Cached(async start => closed(await binanceCloses('perp', '1d', start), DAY_MS));
/** Daily perpetual closes are read from the start of the perpetual whatever the range, so the 21-day EMA is settled where the chart begins. */
export const PERP_START = Date.UTC(2019, 8, 8);

/** The index of the last element of sorted `xs` at or before `x` (or the first, when `x` is before them all; -1 when empty). */
export function idx(xs: ArrayLike<number>, x: number): number {
  if (!xs.length) return -1;
  let lo = 0, hi = xs.length - 1;
  if (x <= xs[0]!) return 0;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xs[m]! <= x) lo = m; else hi = m - 1; }
  return lo;
}
