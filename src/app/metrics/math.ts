/**
 * The arithmetic behind the metric tabs (`metrics/view.ts`): realised volatility, the EMA and a close's distance from it, Black-Scholes
 * delta, at-the-money and 25-delta implied volatility from an expiry's marks, and the runs of flagged points the charts shade. Pure and
 * tested (`tests/fork-metrics.test.mts`).
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const YEAR_MS = 365 * DAY_MS;
/** Bitcoin trades every hour of the year. */
export const HOURS_PER_YEAR = 24 * 365;

/**
 * Annualised realised volatility in percent at each close: the sample standard deviation of the last `window` log returns, times the square
 * root of `perYear` (returns per year). NaN until `window` returns are held. 168 hourly returns is the 7-day reading.
 */
export function realisedVol(close: ArrayLike<number>, window = 168, perYear = HOURS_PER_YEAR): Float64Array {
  const n = close.length, out = new Float64Array(n).fill(NaN);
  if (window < 2) return out;
  const r = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) { const a = close[i - 1]!, b = close[i]!; r[i] = a > 0 && b > 0 ? Math.log(b / a) : NaN; }
  for (let i = window; i < n; i++) {
    let s = 0, ok = true;
    for (let j = i - window + 1; j <= i; j++) { const x = r[j]!; if (!Number.isFinite(x)) { ok = false; break; } s += x; }
    if (!ok) continue;
    const mean = s / window;
    let v = 0;
    for (let j = i - window + 1; j <= i; j++) { const d = r[j]! - mean; v += d * d; }
    out[i] = 100 * Math.sqrt((v / (window - 1)) * perYear);
  }
  return out;
}

/** The exponential moving average with weight 2 / (period + 1), begun at the first value (as pandas' `ewm(span, adjust=False)`). */
export function ema(values: ArrayLike<number>, period: number): Float64Array {
  const n = values.length, out = new Float64Array(n).fill(NaN), k = 2 / (period + 1);
  let e = NaN;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) { out[i] = e; continue; }
    e = Number.isFinite(e) ? e + k * (v - e) : v;
    out[i] = e;
  }
  return out;
}

/** Each close's distance from its EMA in percent: 100 × (close / EMA − 1). */
export function pctFromEma(close: ArrayLike<number>, period = 21): Float64Array {
  const e = ema(close, period);
  return Float64Array.from({ length: close.length }, (_, i) => 100 * (close[i]! / e[i]! - 1));
}

/** The standard normal distribution function (Abramowitz and Stegun 7.1.26 through erf; error under 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Black-Scholes delta on the forward (no rate: Deribit quotes each expiry against its own forward): N(d1) for a call, N(d1) − 1 for a put,
 * with d1 = (ln(F/K) + σ²T/2) / (σ√T); `iv` in percent, `years` to expiry.
 */
export function bsDelta(kind: 'C' | 'P', forward: number, strike: number, years: number, iv: number): number {
  const s = iv / 100, sd = s * Math.sqrt(years);
  if (!(forward > 0 && strike > 0 && sd > 0)) return NaN;
  const d1 = (Math.log(forward / strike) + 0.5 * sd * sd) / sd;
  return kind === 'C' ? normCdf(d1) : normCdf(d1) - 1;
}

/** One option's mark on an expiry's smile. */
export interface SmilePoint { kind: 'C' | 'P'; strike: number; iv: number }

/**
 * The at-the-money implied volatility of an expiry: each strike's out-of-the-money mark (the call at or above the forward, the put below),
 * read linearly in log strike at the forward. NaN when the forward is not between two such strikes.
 */
export function atmIv(points: readonly SmilePoint[], forward: number): number {
  const otm = points.filter(p => p.iv > 0 && (p.kind === 'C' ? p.strike >= forward : p.strike < forward)).sort((a, b) => a.strike - b.strike);
  for (let i = 1; i < otm.length; i++) {
    const a = otm[i - 1]!, b = otm[i]!;
    if (a.strike <= forward && b.strike >= forward) {
      if (b.strike === a.strike) return (a.iv + b.iv) / 2;
      const w = (Math.log(forward) - Math.log(a.strike)) / (Math.log(b.strike) - Math.log(a.strike));
      return a.iv + w * (b.iv - a.iv);
    }
  }
  return NaN;
}

/**
 * The implied volatility at a delta (0.25 for the 25-delta call, −0.25 for the put): each out-of-the-money option of that kind gets its
 * Black-Scholes delta from its own mark, and the volatility is read linearly in delta between the two options either side of the target.
 * NaN when no two options bracket it.
 */
export function ivAtDelta(points: readonly SmilePoint[], forward: number, years: number, target: number): number {
  const kind: 'C' | 'P' = target > 0 ? 'C' : 'P';
  const wing = points
    .filter(p => p.kind === kind && p.iv > 0 && (kind === 'C' ? p.strike >= forward : p.strike <= forward))
    .map(p => ({ d: bsDelta(kind, forward, p.strike, years, p.iv), iv: p.iv }))
    .filter(p => Number.isFinite(p.d))
    .sort((a, b) => a.d - b.d);
  for (let i = 1; i < wing.length; i++) {
    const a = wing[i - 1]!, b = wing[i]!;
    if (a.d <= target && b.d >= target) return b.d === a.d ? (a.iv + b.iv) / 2 : a.iv + ((target - a.d) / (b.d - a.d)) * (b.iv - a.iv);
  }
  return NaN;
}

/** The 25-delta put's volatility over the call's, as a percentage of the at-the-money volatility. */
export const skewPct = (put25: number, call25: number, atm: number): number => (100 * (put25 - call25)) / atm;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** A Deribit option name (BTC-27NOV26-60000-P) read apart; expiry is 08:00 UTC of its day. Null for anything else. */
export function parseOptionName(name: string): { expiry: number; strike: number; kind: 'C' | 'P' } | null {
  const m = /^[A-Z]+-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/.exec(name);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!);
  if (month < 0) return null;
  return { expiry: Date.UTC(2000 + Number(m[3]), month, Number(m[1]), 8), strike: Number(m[4]!.replace('d', '.')), kind: m[5] as 'C' | 'P' };
}

/** One expiry's row of the term structure and skew. */
export interface ExpiryReading { expiry: number; days: number; forward: number; atm: number; put25: number; call25: number; skew: number }

/** An option's mark from Deribit's book summary: its name, mark volatility (percent) and the forward of its expiry. */
export interface OptionMark { instrument_name: string; mark_iv: number; underlying_price: number }

/**
 * The term structure and 25-delta skew from every option's mark, one reading per expiry in time order. An expiry less than `minDays` away
 * (whose marks are mostly time value of a few hours) is left out, as is one whose at-the-money or 25-delta volatility cannot be read.
 */
export function expiryReadings(marks: readonly OptionMark[], now: number, minDays = 0.25): ExpiryReading[] {
  const byExpiry = new Map<number, { forward: number[]; points: SmilePoint[] }>();
  for (const m of marks) {
    const o = parseOptionName(m.instrument_name);
    if (!o || !(m.mark_iv > 0) || !(m.underlying_price > 0)) continue;
    let e = byExpiry.get(o.expiry);
    if (!e) { e = { forward: [], points: [] }; byExpiry.set(o.expiry, e); }
    e.forward.push(m.underlying_price); e.points.push({ kind: o.kind, strike: o.strike, iv: m.mark_iv });
  }
  const out: ExpiryReading[] = [];
  for (const [expiry, e] of [...byExpiry].sort((a, b) => a[0] - b[0])) {
    const days = (expiry - now) / DAY_MS;
    if (days < minDays) continue;
    const forward = median(e.forward), years = days / 365;
    const atm = atmIv(e.points, forward), put25 = ivAtDelta(e.points, forward, years, -0.25), call25 = ivAtDelta(e.points, forward, years, 0.25);
    if (![atm, put25, call25].every(Number.isFinite)) continue;
    out.push({ expiry, days, forward, atm, put25, call25, skew: skewPct(put25, call25, atm) });
  }
  return out;
}

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; }

/**
 * The term structure's shape: the nearest expiry's at-the-money volatility against the expiry closest to 30 days out. Inverted when the
 * nearest is higher by more than `flat` points, normal when lower by more, flat between.
 */
export function termShape(rows: readonly ExpiryReading[], flat = 1): { shape: 'inverted' | 'normal' | 'flat'; front: ExpiryReading; month: ExpiryReading } | null {
  if (rows.length < 2) return null;
  const front = rows[0]!;
  const month = rows.slice(1).reduce((best, r) => (Math.abs(r.days - 30) < Math.abs(best.days - 30) ? r : best), rows[1]!);
  const d = front.atm - month.atm;
  return { shape: d > flat ? 'inverted' : d < -flat ? 'normal' : 'flat', front, month };
}

/** The runs of consecutive flagged points as [first time, last time] pairs. */
export function flaggedRuns(time: ArrayLike<number>, flag: ArrayLike<boolean | number>): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < time.length; i++) {
    if (flag[i]) { if (start < 0) start = i; }
    else if (start >= 0) { out.push([time[start]!, time[i - 1]!]); start = -1; }
  }
  if (start >= 0) out.push([time[start]!, time[time.length - 1]!]);
  return out;
}

/**
 * For each time, the value of a daily series as it stood then: the latest day whose candle had closed (day start + 1 day ≤ time). NaN before
 * the first closed day. `days` are the daily candles' start times in order.
 */
export function asOfClosedDay(time: ArrayLike<number>, days: ArrayLike<number>, values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(time.length).fill(NaN);
  let j = -1;
  for (let i = 0; i < time.length; i++) {
    while (j + 1 < days.length && days[j + 1]! + DAY_MS <= time[i]!) j++;
    if (j >= 0) out[i] = values[j]!;
  }
  return out;
}

/** The value of `series` (by `seriesTime`) at each of `time`, or NaN where it has no point at that exact time. */
export function alignTo(time: ArrayLike<number>, seriesTime: ArrayLike<number>, series: ArrayLike<number>): Float64Array {
  const at = new Map<number, number>();
  for (let i = 0; i < seriesTime.length; i++) at.set(seriesTime[i]!, series[i]!);
  return Float64Array.from({ length: time.length }, (_, i) => at.get(time[i]!) ?? NaN);
}
