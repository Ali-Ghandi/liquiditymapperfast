/** Axis ticks for the metric charts: dates (UTC), days to expiry on a log axis, and round numbers on a linear or log scale. Pure. */
import { language } from '../i18n.ts';

const DAY = 86_400_000;
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = language() + JSON.stringify(options);
  let f = fmtCache.get(key);
  if (!f) { try { f = new Intl.DateTimeFormat(language(), { ...options, timeZone: 'UTC' }); } catch { f = new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' }); } fmtCache.set(key, f); }
  return f;
}
/** "16 Nov" (in the page's language), UTC. */
export const dayLabel = (t: number): string => fmt({ day: 'numeric', month: 'short' }).format(t);
/** "Nov 2026" (in the page's language), UTC: the year whole, so a month is never read as a day ("Jan 24"). */
export const monthLabel = (t: number): string => fmt({ month: 'short', year: 'numeric' }).format(t);
/** "16 Nov 2026" UTC. */
export const dateLabel = (t: number): string => fmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(t);
/** "16 Nov 14:00" UTC. */
export const hourLabel = (t: number): string => `${fmt({ day: 'numeric', month: 'short' }).format(t)} ${new Date(t).toISOString().slice(11, 16)}`;

const DAY_STEPS = [1, 2, 7, 14];
const MONTH_STEPS = [1, 2, 3, 6, 12];

/** Date ticks between `min` and `max`, at most about `count`: whole UTC days (weeks begin on Monday) or month starts. */
export function timeTicks(min: number, max: number, count: number, _zone?: string): { v: number; label: string }[] {
  const span = max - min, out: { v: number; label: string }[] = [];
  if (!(span > 0)) return out;
  const dayStep = DAY_STEPS.find(s => span / (s * DAY) <= count);
  if (dayStep !== undefined) {
    let t = Math.ceil(min / DAY) * DAY;
    if (dayStep >= 7) { while (new Date(t).getUTCDay() !== 1) t += DAY; }
    for (; t <= max; t += dayStep * DAY) out.push({ v: t, label: dayLabel(t) });
    return out;
  }
  const months = span / (30.44 * DAY), step = MONTH_STEPS.find(s => months / s <= count) ?? Math.ceil(months / count / 12) * 12;
  const d = new Date(min);
  let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  if (Date.UTC(y, m - 1, 1) >= min) m -= 1;
  // Months on the step from January, so that 6-month ticks fall on January and July.
  while (m % step !== 0) m++;
  for (;; m += step) {
    const t = Date.UTC(y + Math.floor(m / 12), m % 12, 1);
    if (t > max) break;
    if (t >= min) out.push({ v: t, label: monthLabel(t) });
  }
  return out;
}

/** Days-to-expiry ticks on a log axis. */
export function dayTicks(min: number, max: number): { v: number; label: string }[] {
  return [1, 7, 30, 90, 180, 365].filter(d => d >= min * 0.98 && d <= max * 1.02).map(d => ({ v: d, label: `${d}d` }));
}

/** Round values between `lo` and `hi`, about `count` of them; on a log scale 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8 times a power of ten, thinned evenly. */
export function niceTicks(lo: number, hi: number, count: number, log = false): number[] {
  if (!(hi > lo)) return [];
  if (log && lo > 0) {
    const all: number[] = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
      for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8]) { const v = m * 10 ** e; if (v >= lo && v <= hi) all.push(v); }
    if (all.length <= count) return all;
    const out: number[] = [], span = Math.log(hi / lo);
    let lastAt = -Infinity;
    for (const v of all) { const at = Math.log(v / lo) / span; if (at - lastAt >= 0.85 / count) { out.push(v); lastAt = at; } }
    return out;
  }
  const raw = (hi - lo) / Math.max(1, count), mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
  return out;
}
