/**
 * The Positioning tab (`view.ts` asks for it): three Binance approximations of Cav's (ID Theory) Coinalyze charts. A: 30-day change in
 * BTC contracts against the 30-day change in 7-day funding at each durable low; B: funding at the low against that change; C: the share
 * of alt open interest on negative funding. Lows and BTC series come from the browser plus the daily `positioning.json` archive; the alt
 * share is the archive's daily readings plus one live reading, which is slow and so drawn when it comes.
 */
import { t, tn } from '../i18n.ts';
import type { Chart } from './plot.ts';
import { DAY_MS } from './math.ts';
import { binanceFunding, binanceOiDaily, liveAltNegShare, positioningHistory } from './data.ts';
import { CAV_LOW_MONTHS, CAV_SAMPLE_START, altNegSeries, contractsOnGrid, durableLows, fundingOnGrid, lastFullAltMean, lowEventPoints, mergeOiByDay, monthsMatched, nowComparison, nowLow, type AltNegSeries, type LowEvent, type PositioningFile } from './positioning.ts';
import { Cached, PERP_START, STALE_MS, axis, dailyPerp, f1, idx, progress, signed, type Palette } from './shared.ts';
import { dateLabel, dayLabel } from './ticks.ts';

/** What the Positioning view draws into (the metrics view's parts). */
export interface PosHost {
  title: HTMLElement;
  foot: HTMLElement;
  layout(count: number, cls: string): Chart[];
  colours(): Palette;
  /** Whether this drawing is still the one on screen (no newer render, the tab still Positioning). */
  current(): boolean;
  /** Chart C's history is shorter than a month, so the range chips do nothing yet. */
  rangesIdle(idle: boolean): void;
}

/** Live funding from 2020 (the archive's funding7d covers before it and stands in when fapi cannot be read). */
const FUNDING_START = Date.UTC(2020, 0, 1);
const fundingRates = new Cached(async start => binanceFunding(start, progress(t('Binance funding'))));
const oiRecent = new Cached(async () => binanceOiDaily());
const posArchive = new Cached(async () => positioningHistory());
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The live alt share takes ~500 calls (~30 s), so it is read at most once per five minutes whatever the refresh button or timer ask, and a
 * failure (fewer than 80 % of the alts read, or no answer in 60 s) is not tried again for five minutes either.
 */
const altLive = (() => {
  let last: { at: number; value: Promise<number> } | null = null;
  return (): Promise<number> => {
    if (last && Date.now() - last.at < STALE_MS) return last.value;
    let timer = 0;
    const value = Promise.race([
      liveAltNegShare(50),
      new Promise<number>((_, reject) => { timer = window.setTimeout(() => reject(new Error(t('no answer in 60 s'))), 60_000); }),
    ]).finally(() => clearTimeout(timer));
    last = { at: Date.now(), value };
    value.catch(() => {});
    return value;
  };
})();

interface PosData { points: LowEvent[]; now: LowEvent | null; pending: boolean; file: PositioningFile | null; notes: string[]; hasOi: boolean; hasFunding: boolean; closes: boolean }

/**
 * Charts A and B's events: durable lows on Binance perpetual daily candles (wicks), each measured on the low's day: contracts and 7-day
 * funding changes over the 30 days into it (OI from the archive, then the API's month).
 */
async function posData(force: boolean): Promise<PosData> {
  const [day, rates, oi, file] = await Promise.allSettled([dailyPerp.get(PERP_START, force), fundingRates.get(FUNDING_START, force), oiRecent.get(0, force), posArchive.get(0, force)]);
  const archive = file.status === 'fulfilled' ? file.value : null, notes: string[] = [];
  if (!archive) notes.push(t('The positioning archive (positioning.json) could not be read.'));
  if (day.status === 'rejected') {
    // Without closes there are no lows; chart C can still draw (from the archive, or the live reading alone).
    notes.push(t('Binance daily closes could not be read ({why}), so there are no lows to plot.', { why: why(day.reason) }));
    return { points: [], now: null, pending: false, file: archive, notes, hasOi: false, hasFunding: false, closes: false };
  }
  if (rates.status === 'rejected') notes.push(t('Live funding could not be read; the archive\'s daily funding is used.'));
  if (oi.status === 'rejected') notes.push(t('Binance\'s live open interest could not be read ({why}); contracts come from the archive only, which can lag, so recent lows may have no contracts change.', { why: why(oi.reason) }));
  const { time, close, high, low } = day.value;
  const funding = fundingOnGrid(time, rates.status === 'fulfilled' ? rates.value : null, archive);
  const contracts = contractsOnGrid(time, close, mergeOiByDay(archive, oi.status === 'fulfilled' ? oi.value : null));
  const { lows, pending } = nowLow(durableLows(time, high, low, close), time[time.length - 1]!);
  const all = lowEventPoints(lows, time, contracts, funding);
  const now = all.find(p => !p.confirmed) ?? null;
  return { points: all.filter(p => p.confirmed), now, pending, file: archive, notes, hasOi: contracts.some(Number.isFinite), hasFunding: funding.some(Number.isFinite), closes: true };
}

const pctAxis = (v: number, step: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(step < 1 ? 1 : 0)}%`;
const ptsAxis = (v: number, step: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(step < 1 ? 1 : 0)}`;

/** A scatter of the confirmed lows plus the "now" dot, with Cav's quadrants shaded and a readout per point. */
function scatter(chart: Chart, c: Palette, d: PosData, xOf: (p: LowEvent) => number, xTitle: string, quads: [string, string | null], title: string, empty: string): void {
  const shown = d.points.filter(p => Number.isFinite(xOf(p)));
  const now = d.now && Number.isFinite(xOf(d.now)) ? d.now : null;
  if (!shown.length && !now) {
    chart.set({ x: { kind: 'value', min: -1, max: 1, format: pctAxis, title: xTitle }, panels: [{ weight: 1, format: ptsAxis, layers: [], title: `${title} — ${empty}` }] }, c);
    return;
  }
  const xs = [...shown.map(xOf), ...(now ? [xOf(now)] : []), 0], ys = [...shown.map(p => p.fundPts), ...(now ? [now.fundPts] : []), 0];
  const lo = Math.min(...xs), hi = Math.max(...xs), m = (hi - lo) * 0.08 || 1;
  // Headroom over the highest point, so the panel's title and the "now" label do not sit on it.
  const yHi = Math.max(...ys), yLo = Math.min(...ys); ys.push(yHi + (yHi - yLo) * 0.2);
  const order = shown.map((_, k) => k).sort((a, b) => xOf(shown[a]!) - xOf(shown[b]!));
  const snapXs = [...order.map(k => xOf(shown[k]!)), ...(now ? [xOf(now)] : [])].sort((a, b) => a - b);
  const line = (p: LowEvent): string[] => [
    `${dateLabel(p.t)} · ${p.confirmed ? t('durable low') : d.pending ? t('pending low, unconfirmed') : t('today, not a low')}`,
    `${t('Contracts, 30d')} ${Number.isFinite(p.oiPct) ? `${signed(p.oiPct)}%` : '–'}`,
    `${t('Funding, 30d change')} ${signed(p.fundPts)} ${t('pts')}`,
    `${t('Funding at the low')} ${f1(p.fundAt)}%`,
  ];
  chart.set({
    x: { kind: 'value', min: lo - m, max: hi + m, format: pctAxis, title: xTitle },
    panels: [{ weight: 1, format: ptsAxis, include: ys, layers: [
      // Cav's quadrants: top right (more positions or higher funding, and funding rising) red; A's bottom left (both falling) cool.
      { kind: 'rect' as const, x0: 0, x1: Infinity, y0: 0, y1: Infinity, color: c.flagSoft, label: quads[0], labelColor: c.flag },
      ...(quads[1] ? [{ kind: 'rect' as const, x0: -Infinity, x1: 0, y0: -Infinity, y1: 0, color: c.accentSoft, label: quads[1], labelColor: c.muted }] : []),
      { kind: 'hline' as const, y: 0, color: c.muted, width: 1 },
      { kind: 'vline' as const, x: 0, color: c.muted, width: 1 },
      { kind: 'scatter' as const, x: order.map(k => xOf(shown[k]!)), y: order.map(k => shown[k]!.fundPts), color: () => c.series, r: 4.5 },
      ...(now ? [{ kind: 'dot' as const, x: xOf(now), y: now.fundPts, color: c.flag, label: `${t('Now')} ${dayLabel(now.t)}` }] : []),
    ], title }],
    snap: snapXs,
    readout: x => { const p = now && xOf(now) === x ? now : shown.find(q => xOf(q) === x); return p ? line(p) : null; },
  }, c);
}

/** "Mean of n readings" until the window holds 7 daily readings, then "7d mean". */
const meanName = (n: number): string => (n >= 7 ? t('7d mean') : tn(n, 'Mean of {n} reading', 'Mean of {n} readings'));

/**
 * Chart C: the 7-day mean of the daily archive readings (the purple line, dominant), each reading as a small faint dot, and the live
 * reading as the red dot with its value. The mean and its legend stop at the last archive day, not in the funding-lag gap. `liveNote`
 * says why there is no live dot (loading, or unavailable); then nothing red is drawn.
 */
function drawAlt(host: PosHost, chart: Chart, c: Palette, s: AltNegSeries, start: number, liveNote: string): void {
  const n = s.time.length, base = t('Alt OI on negative funding');
  if (!n) {
    host.rangesIdle(true);
    chart.set({ x: { kind: 'time', min: start, max: Date.now() }, legend: liveNote ? [{ color: c.muted, text: liveNote }] : [], panels: [{ weight: 1, format: axis, min: 0, max: 100, layers: [], title: `${base} — ${t('no readings yet')}` }] }, c);
    return;
  }
  const last = s.time[n - 1]!, span = last - s.time[0]!;
  // The history is read from Binance's archive back to Dec 2021; without it (the file could not be read) only a reading or two shows:
  // then the last month is shown so one point is not a sliver, and the range chips are idle.
  host.rangesIdle(span < 30 * DAY_MS);
  const min = span < 30 * DAY_MS ? last - 34 * DAY_MS : Math.max(start, s.time[0]! - DAY_MS);
  const mean = lastFullAltMean(s);
  const finite = Array.from(s.raw).filter(Number.isFinite);
  const liveAt = s.live ? n - 1 : -1, readings = finite.length - (liveAt >= 0 ? 1 : 0);
  // The archive's readings in faint grey under the mean; the live one is the red dot, left out of the daily cloud.
  const daily = Float64Array.from(s.raw, (v, k) => (k === liveAt ? NaN : v));
  chart.set({
    x: { kind: 'time', min, max: last + 2 * DAY_MS },
    legend: [
      // The mean is of the archive's readings and ends on their last day, even when a later live reading is on the chart.
      ...(mean ? [{ color: c.purple, text: `${meanName(mean.n)} (${dayLabel(mean.t)}): ${f1(mean.avg)}%` }] : []),
      { color: c.muted, text: t('daily reading') },
      ...(liveAt >= 0 ? [{ color: c.flag, text: t('live now: {v}%', { v: f1(s.raw[liveAt]!) }) }] : liveNote ? [{ color: c.muted, text: liveNote }] : []),
    ],
    panels: [{ weight: 1, format: axis, min: 0, max: 100, layers: [
      // Faint daily dots first, then the mean on top so it stays the line you read; the live dot last, and larger.
      { kind: 'scatter', x: s.time, y: daily, color: () => c.muted, r: 1.3, alpha: 0.35, ring: false },
      { kind: 'line', x: s.time, y: s.avg7, color: c.purple, width: 2.2 },
      // While the history is short the mean is also marked each day, as a small dot drawn on top of the reading (a bullseye where
      // they meet), so both stay visible and one or two days still show.
      ...(readings < 8 ? [{ kind: 'scatter' as const, x: s.time, y: s.avg7, color: () => c.purple, r: 2.2 }] : []),
      ...(liveAt >= 0 ? [{ kind: 'dot' as const, x: s.time[liveAt]!, y: s.raw[liveAt]!, color: c.flag, r: 5.5, label: `${f1(s.raw[liveAt]!)}% ${t('live')}` }] : []),
    ], title: `${base} · ${tn(readings, '{n} daily reading', '{n} daily readings')}` }],
    snap: s.time,
    readout: x => {
      const k = idx(s.time, x);
      return k < 0 ? null : [
        `${dateLabel(s.time[k]!)}${k === liveAt ? ` (${t('live')})` : ''}`,
        `${t('Reading')} ${Number.isFinite(s.raw[k]!) ? `${f1(s.raw[k]!)}%` : '–'}`,
        ...(s.n7[k] ? [`${meanName(s.n7[k]!)} ${f1(s.avg7[k]!)}%`] : []),
      ];
    },
  }, c);
}

/**
 * The headline, after Cav's: now's 30-day moves, and how many lows saw contracts grow faster or funding rise as far. `alt` is chart C's
 * state, for when the closes failed: drawn (archive or live readings), still loading, or failed too.
 */
function headline(d: PosData, alt: 'drawn' | 'loading' | 'failed'): string {
  const now = d.now;
  if (!now) {
    if (d.closes) return t('BTC open interest and funding into durable lows, and alt perps on negative funding.');
    return alt === 'drawn' ? t('Binance daily closes could not be read, so only the alt share is drawn.')
      : alt === 'loading' ? t('Binance daily closes could not be read; the alt share is still loading.')
      : t('Neither Binance daily closes nor the alt share could be read, so there is nothing to draw.');
  }
  const cmp = nowComparison(d.points, now), date = dayLabel(now.t), pts = signed(now.fundPts), at = f1(now.fundAt);
  const head = Number.isFinite(now.oiPct)
    ? d.pending
      ? t('Into the pending low of {date}: contracts {oi}% and funding {pts} pts over 30 days, funding {at}% annualised.', { date, oi: signed(now.oiPct), pts, at })
      : t('No pending low. Last 30 days to {date}: contracts {oi}% and funding {pts} pts, funding {at}% annualised.', { date, oi: signed(now.oiPct), pts, at })
    : d.pending
      ? t('Into the pending low of {date}: funding {pts} pts over 30 days, funding {at}% annualised; no contracts change (no open interest for those days).', { date, pts, at })
      : t('No pending low. Last 30 days to {date}: funding {pts} pts, funding {at}% annualised; no contracts change (no open interest for those days).', { date, pts, at });
  const tail = cmp.faster === null
    ? t('Of {m} durable lows with funding, {j} saw funding rise as far.', { m: cmp.withFunding, j: cmp.further })
    : t('Of {n} durable lows with open interest, {k} saw contracts grow faster; of {m} with funding, {j} saw funding rise as far.', { n: cmp.withOi, k: cmp.faster, m: cmp.withFunding, j: cmp.further });
  return `${head} ${tail}`;
}

/** Where chart C's history comes from and how far it runs (the archive publishes funding a month at a time). */
function altHistoryNote(file: PositioningFile | null): string[] {
  const held = (file?.days ?? []).filter(r => Number.isFinite(r[3]));
  if (!held.length) return [];
  return [t('Alt-share history: daily from {first} to {last}, {n} days, from Binance\'s public archive (data.binance.vision): each alt\'s USD open interest at the day\'s close and its last funding settled that day, equity perpetuals left out. The archive publishes funding a month at a time, so the history ends with last month; the red dot is the live reading (each alt\'s current funding rate), not part of the mean.',
    { first: dateLabel(held[0]![0] * DAY_MS), last: dateLabel(held[held.length - 1]![0] * DAY_MS), n: held.length })];
}

function footnote(d: PosData, extra: string[]): string {
  const withOi = d.points.filter(p => Number.isFinite(p.oiPct)).length, fromCav = d.points.filter(p => p.t >= CAV_SAMPLE_START).map(p => p.t);
  return [
    t('A Binance-only approximation of Cav\'s (ID Theory) Coinalyze top-300 charts. Contracts: Binance BTCUSDT perpetual open interest in BTC (USD open interest deflated by price), indexed; daily from Sep 2020 (data.binance.vision archive, then fapi). Funding: BTCUSDT 7-day mean × 3 × 365, annualised %. Alt share: share of USD open interest (contracts × mark price) among the top 50 Binance USDT-M alts by USD open interest whose last funding is negative, a 7-day mean of daily readings.'),
    t('Durable low (Cav\'s rule, on daily candles): a day whose intraday low is the lowest of its 10 days and at least 15% under the prior 90-day intraday high, with no intraday low under it for the next 60 days and a daily close at least 15% above it within those 60 days; a low within 60 days of the previous one is a retest and is not counted. The red "now" point is not a confirmed low.'),
    ...altHistoryNote(d.file),
    ...(d.points.length ? [t('Sample: lows here run from {first} (Binance perpetual history; open interest from Sep 2020), {n} with open interest and {m} with funding. From Cav\'s sample start (Aug 2022) there are {k} here against his 11, and {j} of his 11 fall in the same month as one here. He reads Coinalyze\'s aggregated candles and this reads Binance\'s BTCUSDT perpetual, so a low can differ by a day or show on one side only.', { first: dateLabel(d.points[0]!.t), n: withOi, m: d.points.length, k: fromCav.length, j: monthsMatched(fromCav, CAV_LOW_MONTHS) })] : []),
    ...d.notes, ...extra,
  ].join(' ');
}

/** Load and return the drawing (charts A and B at once; chart C again when the live alt share settles). */
export async function buildPos(host: PosHost, start: number, force: boolean): Promise<() => void> {
  // The slow live scan starts first, beside the BTC loaders, and never holds them up.
  const live = altLive();
  const d = await posData(force);
  const draw = (altValue: number | null, liveNote: string, settled: boolean): void => {
    const c = host.colours(), [a, b, cc] = host.layout(3, 'pos');
    const series = altNegSeries(d.file, altValue === null ? null : { at: Date.now(), value: altValue });
    host.title.textContent = headline(d, series.time.length ? 'drawn' : settled ? 'failed' : 'loading');
    scatter(a!, c, d, p => p.oiPct, t('BTC contracts, 30-day change'), [t('Added positions, paid more'), t('Cut positions, paid less')], t('7d funding, 30-day change (pts)'),
      !d.closes ? t('no lows') : d.hasOi ? t('no lows with open interest') : t('open interest could not be read'));
    scatter(b!, c, d, p => p.fundAt, t('7d funding at the low, annualised'), [t('Paying up, and rising'), null], t('7d funding, 30-day change (pts)'),
      !d.closes ? t('no lows') : d.hasFunding ? t('no lows') : t('funding could not be read'));
    drawAlt(host, cc!, c, series, start, liveNote);
    host.foot.textContent = footnote(d, altValue === null && liveNote ? [liveNote] : []);
  };
  // `drawn`: the first drawing is the caller's (after this returns), so an answer already in hand waits for it rather than being drawn over.
  let alt: [number | null, string, boolean] = [null, t('Live alt share loading (about 30 s)…'), false], drawn = false;
  const settle = (next: [number | null, string, boolean]): void => { alt = next; if (drawn && host.current()) draw(...alt); };
  live.then(v => settle([v, '', true]), (e: unknown) => settle([null, t('Live alt share unavailable ({why}); archive readings only.', { why: why(e) }), true]));
  return () => { drawn = true; draw(...alt); };
}
