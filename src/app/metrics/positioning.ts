/**
 * The arithmetic behind the Positioning tab: durable swing lows, a price-deflated contracts index, 7-day annualised funding,
 * lookback changes, and the published `positioning.json` schema. Pure and tested (`tests/fork-metrics.test.mts`).
 */

import { DAY_MS } from './math.ts';

/** A durable swing low: `t` is the UTC day-open ms of the low close. */
export interface DurableLow { t: number; confirmed: boolean }

/**
 * Days that fell ≥15% under the prior 90-day high. Among each run of such days, the minimum close is the low. It is confirmed once
 * every close in the next 60 days stays at or above that low and some later close reaches +15%. A low that may still be confirmed is
 * returned unconfirmed ("now"), at most one of those (the latest): its 60-day hold is not finished yet, or it is held but has not rallied
 * 15% yet and no close since has gone under it.
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
    let held = true, covered = false, rallied = false, undercutLater = false;
    for (let j = 0; j < n; j++) {
      const tj = time[j]!, px = close[j]!;
      if (tj <= t || tj > end || !Number.isFinite(px)) continue;
      if (px < minPx) { if (tj <= holdEnd) held = false; else undercutLater = true; }
      if (tj >= holdEnd) covered = true;
      if (px >= minPx * 1.15) rallied = true;
    }
    if (!held) continue;
    if (covered && rallied) confirmed.push({ t, confirmed: true });
    else if (!covered || !undercutLater) latestUnconfirmed = { t, confirmed: false };
  }
  return latestUnconfirmed ? [...confirmed, latestUnconfirmed] : confirmed;
}

/**
 * Cav's contracts index from USD open interest: each day's USD OI is deflated by the price move from the first day (i.e. turned into
 * contracts) and scaled so the first reading is `base` (100). Binance's BTCUSDT open interest is already counted in BTC (contracts), so
 * a caller with that passes OI × price (`contractsOnGrid`), and the price cancels. NaN when the first USD OI or a day's price is not
 * positive.
 */
export function contractsIndex(usdOi: ArrayLike<number>, price: ArrayLike<number>, base = 100): Float64Array {
  const n = Math.min(usdOi.length, price.length), out = new Float64Array(n).fill(NaN);
  const o0 = usdOi[0]!, p0 = price[0]!;
  if (!(o0 > 0 && p0 > 0)) return out;
  for (let i = 0; i < n; i++) {
    const p = price[i]!, o = usdOi[i]!;
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

/** Trading USDT-M perpetual symbols from Binance's exchangeInfo, excluding BTCUSDT: the alts the negative-funding share is taken over. */
export function usdtPerpAlts(info: unknown): Set<string> {
  const rows = (info as { symbols?: unknown } | null)?.symbols;
  if (!Array.isArray(rows)) throw new Error('Binance: unexpected exchange info');
  const out = new Set<string>();
  for (const row of rows) {
    const s = row as { symbol?: unknown; status?: unknown; contractType?: unknown; quoteAsset?: unknown } | null;
    if (s && s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && typeof s.symbol === 'string' && s.symbol !== 'BTCUSDT') out.add(s.symbol);
  }
  return out;
}

/** An alt with its last funding rate and mark price (from premiumIndex). */
export interface AltCandidate { symbol: string; rate: number; mark: number }

/** The premiumIndex rows for `alts` (never BTCUSDT) with a finite last funding rate and a positive mark price. */
export function altCandidates(premium: unknown, alts: ReadonlySet<string>): AltCandidate[] {
  if (!Array.isArray(premium)) throw new Error('Binance: unexpected premium index');
  const out: AltCandidate[] = [];
  for (const row of premium) {
    const r = row as { symbol?: unknown; lastFundingRate?: unknown; markPrice?: unknown } | null;
    if (typeof r?.symbol !== 'string' || r.symbol === 'BTCUSDT' || !alts.has(r.symbol)) continue;
    const rate = Number(r.lastFundingRate), mark = Number(r.markPrice);
    if (Number.isFinite(rate) && mark > 0) out.push({ symbol: r.symbol, rate, mark });
  }
  return out;
}

/** The least share of the alts whose open interest must have been read for the ranking to be the real one. */
export const ALT_MIN_READ = 0.8;

/**
 * The percent of USD open interest (contracts × mark price) among the top `topN` alts by USD open interest whose last funding is
 * negative. `oi` holds each alt's open interest in contracts (a symbol missing, or not positive, was not read). Null when fewer than
 * `ALT_MIN_READ` of the alts were read (the top would be a sample, not the top) or there is nothing to weigh.
 */
export function altNegShare(premium: unknown, alts: ReadonlySet<string>, oi: ReadonlyMap<string, number>, topN = 50): number | null {
  const candidates = altCandidates(premium, alts);
  const read: { usd: number; negative: boolean }[] = [];
  for (const c of candidates) {
    const contracts = oi.get(c.symbol);
    if (contracts !== undefined && contracts > 0 && Number.isFinite(contracts)) read.push({ usd: contracts * c.mark, negative: c.rate < 0 });
  }
  if (!candidates.length || read.length < ALT_MIN_READ * candidates.length) return null;
  read.sort((a, b) => b.usd - a.usd);
  let neg = 0, total = 0;
  for (const r of read.slice(0, Math.max(0, topN))) { total += r.usd; if (r.negative) neg += r.usd; }
  return total > 0 ? 100 * neg / total : null;
}

/** The positive sum_open_interest of the data.binance.vision metrics row stamped `stamp` (rows are not in time order), else NaN. */
function metricsOiAt(text: string, stamp: string): number {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${stamp},`)) continue;
    const c = Number(line.split(',')[2]);
    if (c > 0 && Number.isFinite(c)) return c; // the archive writes 0E-8 / 0E-16 where it has no reading
  }
  return NaN;
}

/**
 * Day `day`'s open interest from data.binance.vision's daily metrics files, as openInterestHist period=1d gives it for the bar opening
 * that day: the reading stamped 23:55 the day before (`before` is that day's CSV), else the day's own 00:00 reading (`own`). Zero
 * placeholder rows are no reading. NaN when the files there hold neither; null when neither file is there.
 */
export function dailyOiFromMetrics(before: string | null, own: string | null, day: number): number | null {
  if (before === null && own === null) return null;
  const iso = (d: number): string => new Date(d * DAY_MS).toISOString().slice(0, 10);
  const close = before === null ? NaN : metricsOiAt(before, `${iso(day - 1)} 23:55:00`);
  if (Number.isFinite(close)) return close;
  return own === null ? NaN : metricsOiAt(own, `${iso(day)} 00:00:00`);
}


/** A daily series: UTC day-open times and one value each (the shape `data.ts` loads). */
interface DaySeries { time: ArrayLike<number>; close: ArrayLike<number> }

/**
 * BTC open interest (contracts) by UTC day number: the API's month first, then the archive over it (the archive's reading for a day wins
 * and it reaches years further back). Missing, NaN or non-positive readings are left out, so a day without one stays without.
 */
export function mergeOiByDay(file: PositioningFile | null, api: DaySeries | null): Map<number, number> {
  const out = new Map<number, number>();
  if (api) for (let i = 0; i < Math.min(api.time.length, api.close.length); i++) {
    const v = api.close[i]!;
    if (v > 0 && Number.isFinite(v)) out.set(Math.floor(api.time[i]! / DAY_MS), v);
  }
  if (file) for (const [day, oi] of file.days) if (oi > 0 && Number.isFinite(oi)) out.set(day, oi);
  return out;
}

/**
 * The contracts index on a day grid (`times` are UTC day opens, `price` the closes), from the first day that has open interest. Binance's
 * BTCUSDT open interest is already counted in BTC, i.e. USD open interest deflated by price, so it goes to `contractsIndex` as USD
 * (OI × close) to be deflated once: the result is OI over that first day's, × 100. NaN on days without OI.
 */
export function contractsOnGrid(times: ArrayLike<number>, price: ArrayLike<number>, oi: ReadonlyMap<number, number>): Float64Array {
  const n = Math.min(times.length, price.length), out = new Float64Array(n).fill(NaN);
  const at = (i: number): number => oi.get(Math.floor(times[i]! / DAY_MS)) ?? NaN;
  let k = 0;
  while (k < n && !(at(k) > 0 && price[k]! > 0)) k++;
  if (k >= n) return out;
  const usd = new Float64Array(n - k), px = new Float64Array(n - k);
  for (let i = k; i < n; i++) { usd[i - k] = at(i) * price[i]!; px[i - k] = price[i]!; }
  out.set(contractsIndex(usd, px), k);
  return out;
}

/**
 * 7-day annualised funding on a day grid: from the funding settlements (`funding7dAnnualised`) where they give a value, else the archive's
 * stored funding7d for that UTC day (so the charts still draw when fapi cannot be read), else NaN.
 */
export function fundingOnGrid(times: ArrayLike<number>, rates: DaySeries | null, file: PositioningFile | null): Float64Array {
  const out = rates ? funding7dAnnualised(rates.time, rates.close, times) : new Float64Array(times.length).fill(NaN);
  if (file) for (let i = 0; i < times.length; i++) {
    if (Number.isFinite(out[i]!)) continue;
    const row = file.days[Math.floor(times[i]! / DAY_MS) - file.from];
    if (row && Number.isFinite(row[2])) out[i] = row[2];
  }
  return out;
}

/** Chart C's series: one entry per UTC day from the first reading to the last. `n7` is how many readings each day's `avg7` is the mean of. */
export interface AltNegSeries { time: Float64Array; raw: Float64Array; avg7: Float64Array; n7: Float64Array; live: boolean }

/**
 * The alt negative-funding share by UTC day: the archive's daily readings, plus `live` (a reading taken now) on its own day, replacing an
 * archive reading there. `avg7` is the mean of the readings held in the 7 days ending on each day (NaN where there are none, so the line
 * breaks rather than inventing a value). Empty when there are no readings.
 */
export function altNegSeries(file: PositioningFile | null, live: { at: number; value: number } | null): AltNegSeries {
  const by = new Map<number, number>();
  if (file) for (const [day, , , a] of file.days) if (Number.isFinite(a)) by.set(day, a);
  const liveDay = live && Number.isFinite(live.value) ? Math.floor(live.at / DAY_MS) : null;
  if (liveDay !== null) by.set(liveDay, live!.value);
  if (!by.size) return { time: new Float64Array(0), raw: new Float64Array(0), avg7: new Float64Array(0), n7: new Float64Array(0), live: false };
  const days = [...by.keys()], first = Math.min(...days), last = Math.max(...days), n = last - first + 1;
  const time = new Float64Array(n), raw = new Float64Array(n).fill(NaN), avg7 = new Float64Array(n).fill(NaN), n7 = new Float64Array(n);
  for (let k = 0; k < n; k++) { time[k] = (first + k) * DAY_MS; raw[k] = by.get(first + k) ?? NaN; }
  for (let k = 0; k < n; k++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, k - 6); j <= k; j++) if (Number.isFinite(raw[j]!)) { sum += raw[j]!; count++; }
    if (count) avg7[k] = sum / count;
    n7[k] = count;
  }
  return { time, raw, avg7, n7, live: liveDay !== null };
}

/**
 * The "now" event for charts A and B: the pending (unconfirmed) low when there is one; otherwise the last closed day (`lastDay`), the way
 * Cav's red dot is today's reading, appended unconfirmed. `pending` says which.
 */
export function nowLow(lows: DurableLow[], lastDay: number): { lows: DurableLow[]; pending: boolean } {
  if (lows.some(l => !l.confirmed)) return { lows, pending: true };
  return { lows: [...lows, { t: lastDay, confirmed: false }], pending: false };
}

/** One event of charts A and B (`lowEventPoints`). */
export type LowEvent = ReturnType<typeof lowEventPoints>[number];

/**
 * How "now" compares with the confirmed lows, for the tab's headline: of the lows with open interest, how many saw contracts grow faster
 * (null when now's own contracts change is unknown, so no count is claimed); of all lows (each has funding), how many saw funding rise
 * at least as far.
 */
export function nowComparison(lows: LowEvent[], now: LowEvent): { withOi: number; faster: number | null; withFunding: number; further: number } {
  const withOi = lows.filter(p => Number.isFinite(p.oiPct));
  return {
    withOi: withOi.length,
    faster: Number.isFinite(now.oiPct) ? withOi.filter(p => p.oiPct > now.oiPct).length : null,
    withFunding: lows.length,
    further: lows.filter(p => p.fundPts >= now.fundPts).length,
  };
}
