/**
 * The arithmetic behind the Positioning tab: durable swing lows, a price-deflated contracts index, 7-day annualised funding,
 * lookback changes, and the published `positioning.json` schema. Pure and tested (`tests/fork-metrics.test.mts`).
 */

import { DAY_MS } from './math.ts';

/** A durable swing low: `t` is the UTC day-open ms of the low close. */
export interface DurableLow { t: number; confirmed: boolean }

/**
 * Days that fell ≥15% under the prior 90-day high. Among each run of such days, the minimum close is the low. It is confirmed once
 * every close in the next 60 days stays at or above that low and some later close reaches +15%; a low whose 60-day hold is not yet
 * finished is returned unconfirmed ("now"), at most one of those.
 */
export function durableLows(time: ArrayLike<number>, close: ArrayLike<number>, now?: number): DurableLow[] {
  const n = Math.min(time.length, close.length);
  const end = now ?? (n ? time[n - 1]! : NaN);
  const candidate: boolean[] = Array(n).fill(false);
  for (let i = 90; i < n; i++) {
    if (time[i]! > end) break;
    const px = close[i]!;
    if (!Number.isFinite(px)) continue;
    let high = -Infinity;
    for (let j = i - 90; j < i; j++) {
      const v = close[j]!;
      if (Number.isFinite(v) && v > high) high = v;
    }
    candidate[i] = high > 0 && px <= high * 0.85;
  }

  const confirmed: DurableLow[] = [];
  let latestUnconfirmed: DurableLow | undefined;
  let i = 0;
  while (i < n) {
    if (!candidate[i]) { i++; continue; }
    let runEnd = i, minI = i, minPx = close[i]!;
    for (let j = i + 1; j < n && candidate[j]; j++) {
      runEnd = j;
      const px = close[j]!;
      if (px < minPx) { minPx = px; minI = j; }
    }
    i = runEnd + 1;
    const t = time[minI]!;
    const holdEnd = t + 60 * DAY_MS;
    if (!Number.isFinite(minPx) || minPx <= 0) continue;
    let held = true, covered = false, rallied = false;
    for (let j = 0; j < n; j++) {
      const tj = time[j]!, px = close[j]!;
      if (tj <= t || tj > end || !Number.isFinite(px)) continue;
      if (tj <= holdEnd && px < minPx) held = false;
      if (tj >= holdEnd) covered = true;
      if (px >= minPx * 1.15) rallied = true;
    }
    if (!held) continue;
    if (covered && rallied) confirmed.push({ t, confirmed: true });
    else if (!covered) latestUnconfirmed = { t, confirmed: false };
  }
  return latestUnconfirmed ? [...confirmed, latestUnconfirmed] : confirmed;
}

/**
 * Open interest as a contracts index: each day's OI is deflated by the price move from the first day and scaled so the first reading is
 * `base` (100). NaN when the first OI or a day's price is not positive.
 */
export function contractsIndex(oi: ArrayLike<number>, price: ArrayLike<number>, base = 100): Float64Array {
  const n = Math.min(oi.length, price.length), out = new Float64Array(n).fill(NaN);
  const o0 = oi[0]!, p0 = price[0]!;
  if (!(o0 > 0 && p0 > 0)) return out;
  for (let i = 0; i < n; i++) {
    const p = price[i]!, o = oi[i]!;
    if (p > 0 && Number.isFinite(o)) out[i] = o * base * p0 / p / o0;
  }
  return out;
}

/**
 * For each day in `dayTimes`, the mean of funding rates whose `time` falls in the 7 days ending on that day (`[day - 6d, day + 1d)`),
 * annualised as `mean × 3 × 365 × 100` (Binance’s three fundings a day, in percent). NaN when a day has no rates.
 */
export function funding7dAnnualised(time: ArrayLike<number>, rate: ArrayLike<number>, dayTimes: ArrayLike<number>): Float64Array {
  const out = new Float64Array(dayTimes.length).fill(NaN);
  const n = Math.min(time.length, rate.length);
  for (let d = 0; d < dayTimes.length; d++) {
    const start = dayTimes[d]! - 6 * DAY_MS, end = dayTimes[d]! + DAY_MS;
    let sum = 0, count = 0;
    for (let i = 0; i < n; i++) {
      const t = time[i]!, r = rate[i]!;
      if (t >= start && t < end && Number.isFinite(r)) { sum += r; count++; }
    }
    if (count) out[d] = (sum / count) * 3 * 365 * 100;
  }
  return out;
}

/** The latest value in `series` whose time is at or before `at`, or NaN if none. */
function valueAtOrBefore(series: ArrayLike<number>, times: ArrayLike<number>, at: number): number {
  const n = Math.min(series.length, times.length);
  let v = NaN;
  for (let i = 0; i < n; i++) if (times[i]! <= at) v = series[i]!; else break;
  return v;
}

/** Percent change from the value at `at - lookbackDays` (nearest at or before) to the value at `at`. NaN if either is missing. */
export function pctChange(series: ArrayLike<number>, times: ArrayLike<number>, at: number, lookbackDays: number): number {
  const here = valueAtOrBefore(series, times, at), back = valueAtOrBefore(series, times, at - lookbackDays * DAY_MS);
  return Number.isFinite(here) && back > 0 ? 100 * (here / back - 1) : NaN;
}

/** The same lookback as `pctChange`, as a subtraction in the series' own units (funding points). */
export function pointChange(series: ArrayLike<number>, times: ArrayLike<number>, at: number, lookbackDays: number): number {
  const here = valueAtOrBefore(series, times, at), back = valueAtOrBefore(series, times, at - lookbackDays * DAY_MS);
  return Number.isFinite(here) && Number.isFinite(back) ? here - back : NaN;
}

/** One UTC day in the archive: open interest, 7-day annualised funding, and the alt negative-funding share (percent, or NaN). */
export interface PosDay { day: number; oi: number; funding7d: number; altNeg: number }

/** The file the build publishes (`positioning.json`). `days` rows are `[UTC day number, oi, funding7d, altNeg]`. */
export interface PositioningFile {
  v: 1;
  source: string;
  builtAt: number;
  /** First and last UTC day number held (a day number is ms / 86,400,000). Every day between is a row; a missing field is NaN. */
  from: number;
  through: number;
  days: [number, number, number, number][];
}

/** A finite number, or NaN when `raw` is null or NaN (JSON has no NaN). Anything else is invalid. */
function fieldNum(raw: unknown): number | null {
  if (raw === null) return NaN;
  if (typeof raw === 'number' && (Number.isFinite(raw) || Number.isNaN(raw))) return raw;
  return null;
}

/** The archive as a `PositioningFile`, or null when the body is not a v1 positioning file. */
export function parsePositioning(raw: unknown): PositioningFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !Array.isArray(r.days) || typeof r.from !== 'number' || typeof r.through !== 'number') return null;
  const days: [number, number, number, number][] = [];
  for (const row of r.days) {
    if (!Array.isArray(row) || row.length !== 4) return null;
    const day = row[0], oi = fieldNum(row[1]), funding7d = fieldNum(row[2]), altNeg = fieldNum(row[3]);
    if (typeof day !== 'number' || !Number.isFinite(day) || oi === null || funding7d === null || altNeg === null) return null;
    days.push([day, oi, funding7d, altNeg]);
  }
  for (let i = 1; i < days.length; i++) if (days[i]![0] !== days[i - 1]![0] + 1) return null;
  if (days.length && (days[0]![0] !== r.from || days[days.length - 1]![0] !== r.through)) return null;
  return { v: 1, source: typeof r.source === 'string' ? r.source : '', builtAt: typeof r.builtAt === 'number' ? r.builtAt : 0, from: r.from, through: r.through, days };
}

/**
 * For each durable low, the 30-day contracts-index percent change (`oiPct`), the 30-day funding-point change (`fundPts`), and the
 * 7-day annualised funding at the low (`fundAt`). A low with no funding lookback is skipped; a low with funding but no OI is kept
 * (`oiPct` is NaN) so the funding-only scatter can still use it.
 */
export function lowEventPoints(
  lows: DurableLow[],
  dayTimes: ArrayLike<number>,
  contracts: ArrayLike<number>,
  funding: ArrayLike<number>,
): { t: number; confirmed: boolean; oiPct: number; fundPts: number; fundAt: number }[] {
  const out: { t: number; confirmed: boolean; oiPct: number; fundPts: number; fundAt: number }[] = [];
  for (const low of lows) {
    const oiPct = pctChange(contracts, dayTimes, low.t, 30);
    const fundPts = pointChange(funding, dayTimes, low.t, 30);
    const fundAt = valueAtOrBefore(funding, dayTimes, low.t);
    if (!Number.isFinite(fundPts) || !Number.isFinite(fundAt)) continue;
    out.push({ t: low.t, confirmed: low.confirmed, oiPct, fundPts, fundAt });
  }
  return out;
}
