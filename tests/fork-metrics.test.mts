import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, HOUR_MS, alignTo, asOfClosedDay, atmIv, bsDelta, ema, expiryReadings, flaggedRuns, ivAtDelta, normCdf, parseOptionName, pctFromEma, realisedVol, skewPct, termShape, type OptionMark, type SmilePoint } from '../src/app/metrics/math.ts';
import { addTrade, optionKind, parsePutFlow, premiumUsd, readTrade, rowsOf, trailingPutShare, type FlowDay, type OptionTrade } from '../src/app/metrics/putflow.ts';
import { DEFAULT_RANGE, METRIC_KEY, METRIC_TABS, RANGES, SOURCE_START, readMetricPrefs, rangeStart, writeMetricPrefs } from '../src/app/metrics/settings.ts';
import { dayTicks, niceTicks, timeTicks } from '../src/app/metrics/ticks.ts';
import { nearest } from '../src/app/metrics/plot.ts';
import {
  contractsIndex, durableLows, funding7dAnnualised, pctChange, pointChange,
} from '../src/app/metrics/positioning.ts';

const close = (a: number, b: number, eps: number, what = ''): void => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} is not within ${eps} of ${b}`);

/** ---- realised volatility ---------------------------------------------------------------------------------------------------------- */

test('realised volatility is the sample standard deviation of the window\'s log returns, annualised by √(returns per year), in percent', () => {
  // Prices that alternate up 1 % and down 1 %: the log returns are +ln 1.01 and −ln 1.01 in turn.
  const closes = [100];
  for (let i = 1; i <= 400; i++) closes.push(closes[i - 1]! * (i % 2 ? 1.01 : 1 / 1.01));
  const rv = realisedVol(closes, 168, 8760);
  const r = Math.log(1.01);
  // 168 returns, 84 of each sign: mean 0, sum of squares 168 r², sample variance 168 r² / 167.
  const expected = 100 * Math.sqrt(((168 * r * r) / 167) * 8760);
  close(rv[400]!, expected, 1e-9, 'alternating');
  close(rv[168]!, expected, 1e-9, 'first full window');
  assert.ok(Number.isNaN(rv[167]!), 'NaN until 168 returns are held');
});

test('realised volatility: steady growth has none, a gap in the closes gives no reading, and the window is the last N returns only', () => {
  const steady = Array.from({ length: 200 }, (_, i) => 100 * 1.001 ** i);
  close(realisedVol(steady, 24)[199]!, 0, 1e-9, 'steady');
  const holed = steady.slice(); holed[150] = NaN;
  const rv = realisedVol(holed, 24);
  assert.ok(Number.isNaN(rv[160]!), 'a window across the hole');
  assert.ok(Number.isFinite(rv[180]!), 'a window past it');
  // A jump 30 returns back is outside a 24-return window.
  const jumped = steady.slice(); for (let i = 170; i < 200; i++) jumped[i] = jumped[i]! * 1.2;
  close(realisedVol(jumped, 24)[199]!, 0, 1e-9, 'jump outside the window');
  assert.ok(realisedVol(jumped, 24)[180]! > 10, 'jump inside the window');
});

test('7-day realised volatility of a known random walk comes back near its true volatility', () => {
  // A seeded walk with hourly σ = 1 %: annualised 100 × 0.01 × √8760 ≈ 93.6.
  let s = 7, price = 50_000;
  const rand = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const closes = [price];
  for (let i = 0; i < 168 * 30; i++) { const z = Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()); price *= Math.exp(0.01 * z); closes.push(price); }
  const rv = realisedVol(closes, 168);
  let sum = 0, n = 0; for (let i = 168; i < rv.length; i++) { sum += rv[i]!; n++; }
  close(sum / n, 93.6, 3, 'mean 7-day reading');
});

/** ---- the 21 EMA and the distance from it ------------------------------------------------------------------------------------------ */

test('the EMA weighs each close by 2/(n+1) and begins at the first close', () => {
  const e = ema([10, 20, 30], 3); // k = 0.5
  assert.deepEqual([...e], [10, 15, 22.5]);
  const e21 = ema([100, 110], 21), k = 2 / 22;
  close(e21[1]!, 100 + k * 10, 1e-12);
  // A missing value carries the EMA on unchanged.
  assert.deepEqual([...ema([10, NaN, 30], 3)], [10, 10, 20]);
});

test('the distance from the 21 EMA is 100 × (close / EMA − 1): zero on a flat line, negative after a drop', () => {
  const flat = Array.from({ length: 60 }, () => 50_000);
  assert.ok(pctFromEma(flat, 21).every(v => Math.abs(v) < 1e-12));
  const drop = [...flat, 42_500];
  const e = ema(drop, 21);
  close(pctFromEma(drop, 21)[60]!, 100 * (42_500 / e[60]! - 1), 1e-12);
  // 15 % down from a flat 50,000 moves the EMA 2/22 of the way: 42,500 against 49,318.18 is −13.83 %.
  close(pctFromEma(drop, 21)[60]!, -13.825, 0.01);
});

/** ---- Black-Scholes delta and the 25-delta interpolation --------------------------------------------------------------------------- */

test('the normal distribution function and Black-Scholes delta on the forward', () => {
  close(normCdf(0), 0.5, 1e-9); close(normCdf(1.959964), 0.975, 1e-6); close(normCdf(-1), 0.158655, 1e-6);
  const F = 64_000, T = 30 / 365;
  for (const K of [50_000, 64_000, 80_000]) close(bsDelta('C', F, K, T, 50) - bsDelta('P', F, K, T, 50), 1, 1e-12, `put-call delta parity at ${K}`);
  // At the forward d1 = σ√T / 2.
  close(bsDelta('C', F, F, T, 50), normCdf((0.5 * Math.sqrt(T)) / 2), 1e-12);
  assert.ok(Number.isNaN(bsDelta('C', F, F, 0, 50)));
});

/** A smile: puts and calls every 1,000 from 40,000 to 90,000, volatility `smile(K)`. */
function smileOf(F: number, smile: (k: number) => number): SmilePoint[] {
  const out: SmilePoint[] = [];
  for (let K = 40_000; K <= 90_000; K += 1_000) for (const kind of ['C', 'P'] as const) out.push({ kind, strike: K, iv: smile(K) });
  return out;
}

test('on a flat smile the 25-delta put and call volatilities are the flat volatility and the skew is zero', () => {
  const pts = smileOf(64_000, () => 48);
  close(ivAtDelta(pts, 64_000, 20 / 365, 0.25), 48, 1e-9);
  close(ivAtDelta(pts, 64_000, 20 / 365, -0.25), 48, 1e-9);
  close(atmIv(pts, 64_000), 48, 1e-9);
  close(skewPct(48, 48, 48), 0, 1e-12);
});

test('the 25-delta volatility is read linearly in delta between the two strikes either side of 25 delta', () => {
  const F = 64_000, T = 20 / 365, smile = (K: number): number => 45 + 25 * Math.abs(Math.log(K / F)) - (K < F ? -8 * Math.log(F / K) : 0);
  const pts = smileOf(F, smile);
  // By hand: the out-of-the-money calls' deltas, then the two either side of 0.25.
  const calls = pts.filter(p => p.kind === 'C' && p.strike >= F).map(p => ({ d: bsDelta('C', F, p.strike, T, p.iv), iv: p.iv })).sort((a, b) => a.d - b.d);
  const i = calls.findIndex(c => c.d >= 0.25), a = calls[i - 1]!, b = calls[i]!;
  close(ivAtDelta(pts, F, T, 0.25), a.iv + ((0.25 - a.d) / (b.d - a.d)) * (b.iv - a.iv), 1e-12, 'call');
  const puts = pts.filter(p => p.kind === 'P' && p.strike <= F).map(p => ({ d: bsDelta('P', F, p.strike, T, p.iv), iv: p.iv })).sort((x, y) => x.d - y.d);
  const j = puts.findIndex(p => p.d >= -0.25), c = puts[j - 1]!, d = puts[j]!;
  close(ivAtDelta(pts, F, T, -0.25), c.iv + ((-0.25 - c.d) / (d.d - c.d)) * (d.iv - c.iv), 1e-12, 'put');
  // Puts richer than calls: a positive skew.
  assert.ok(ivAtDelta(pts, F, T, -0.25) > ivAtDelta(pts, F, T, 0.25));
  // Strikes that never reach 25 delta give no reading.
  assert.ok(Number.isNaN(ivAtDelta(pts.filter(p => p.strike > 75_000), F, T, 0.25)));
});

test('the at-the-money volatility is read in log strike between the out-of-the-money marks either side of the forward', () => {
  const pts: SmilePoint[] = [{ kind: 'P', strike: 60_000, iv: 50 }, { kind: 'C', strike: 60_000, iv: 99 }, { kind: 'C', strike: 70_000, iv: 40 }, { kind: 'P', strike: 70_000, iv: 99 }];
  const F = 64_000, w = Math.log(F / 60_000) / Math.log(70_000 / 60_000);
  close(atmIv(pts, F), 50 + w * (40 - 50), 1e-12);
});

test('Deribit option names are read apart, expiry at 08:00 UTC', () => {
  assert.deepEqual(parseOptionName('BTC-27NOV26-60000-P'), { expiry: Date.UTC(2026, 10, 27, 8), strike: 60_000, kind: 'P' });
  assert.deepEqual(parseOptionName('BTC-4DEC26-62000-C'), { expiry: Date.UTC(2026, 11, 4, 8), strike: 62_000, kind: 'C' });
  assert.equal(parseOptionName('BTC-PERPETUAL'), null);
  assert.equal(parseOptionName('BTC-27XYZ26-60000-P'), null);
});

test('expiry readings: one per expiry in time order, a near expiry left out, and skew as a percentage of ATM', () => {
  const now = Date.UTC(2026, 10, 16, 12);
  const marks: OptionMark[] = [];
  const add = (exp: string, F: number, smile: (K: number) => number): void => {
    for (let K = 40_000; K <= 90_000; K += 1_000) for (const k of ['C', 'P']) marks.push({ instrument_name: `BTC-${exp}-${K}-${k}`, mark_iv: smile(K), underlying_price: F });
  };
  add('16NOV26', 64_000, () => 80); // expired at 08:00 today: left out
  add('17NOV26', 64_000, K => 58 + (K < 64_000 ? 30 * Math.log(64_000 / K) : 0));
  add('18DEC26', 64_500, () => 40);
  const rows = expiryReadings(marks, now);
  assert.deepEqual(rows.map(r => new Date(r.expiry).toISOString().slice(0, 10)), ['2026-11-17', '2026-12-18']);
  close(rows[0]!.days, 20 / 24, 1e-9);
  close(rows[1]!.atm, 40, 1e-9); close(rows[1]!.skew, 0, 1e-9);
  assert.ok(rows[0]!.skew > 0);
  close(rows[0]!.skew, (100 * (rows[0]!.put25 - rows[0]!.call25)) / rows[0]!.atm, 1e-12);
  assert.equal(termShape(rows)!.shape, 'inverted');
});

test('the term structure is inverted, normal or flat by the nearest expiry against the one closest to 30 days', () => {
  const row = (days: number, atm: number) => ({ expiry: days, days, forward: 1, atm, put25: atm, call25: atm, skew: 0 });
  assert.equal(termShape([row(1, 58), row(7, 50), row(31, 40), row(90, 40)])!.shape, 'inverted');
  assert.equal(termShape([row(1, 58), row(7, 50), row(31, 40)])!.month.days, 31);
  assert.equal(termShape([row(1, 35), row(28, 40)])!.shape, 'normal');
  assert.equal(termShape([row(1, 40.5), row(28, 40)])!.shape, 'flat');
  assert.equal(termShape([row(1, 40)]), null);
});

/** ---- the put share of aggressive premium ------------------------------------------------------------------------------------------ */

const trade = (over: Partial<OptionTrade>): OptionTrade => ({ trade_id: String(Math.random()), timestamp: Date.UTC(2026, 10, 16, 3), instrument_name: 'BTC-27NOV26-60000-P', direction: 'buy', price: 0.01, amount: 2, index_price: 65_000, ...over });

test('a trade\'s premium is price × amount × index, and only taker buys of puts and calls are summed, by UTC day', () => {
  assert.equal(premiumUsd(trade({})), 0.01 * 2 * 65_000);
  assert.equal(optionKind('BTC-27NOV26-60000-C'), 'C'); assert.equal(optionKind('BTC-PERPETUAL'), null);
  const days = new Map<number, FlowDay>();
  addTrade(days, trade({}));
  addTrade(days, trade({ instrument_name: 'BTC-27NOV26-70000-C', price: 0.005 }));
  addTrade(days, trade({ direction: 'sell', price: 1 }));
  addTrade(days, trade({ instrument_name: 'BTC-PERPETUAL', price: 1 }));
  addTrade(days, trade({ timestamp: Date.UTC(2026, 10, 17, 0, 0, 1) }));
  const d16 = days.get(Date.UTC(2026, 10, 16) / DAY_MS)!, d17 = days.get(Date.UTC(2026, 10, 17) / DAY_MS)!;
  close(d16.put, 1300, 1e-9); close(d16.call, 650, 1e-9); assert.equal(d16.n, 2);
  close(d17.put, 1300, 1e-9); assert.equal(d17.n, 1);
});

test('readTrade checks the fields the sum needs', () => {
  assert.ok(readTrade({ trade_id: '1', timestamp: 1, instrument_name: 'X-P', direction: 'buy', price: 0.1, amount: 1, index_price: 1, iv: 50 }));
  assert.equal(readTrade({ trade_id: '1', timestamp: 1, instrument_name: 'X-P', direction: 'buy', price: '0.1', amount: 1, index_price: 1 }), null);
  assert.equal(readTrade(null), null);
});

test('the trailing 7-day put share sums each side over the window before dividing', () => {
  const put = [10, 0, 0, 0, 0, 0, 0, 90, 0], call = [0, 10, 10, 10, 10, 10, 10, 0, 0];
  const s = trailingPutShare(put, call, 7);
  assert.ok(s.slice(0, 6).every(Number.isNaN), 'NaN until 7 days');
  close(s[6]!, 100 * 10 / 70, 1e-9);
  close(s[7]!, 100 * 90 / 150, 1e-9);
  close(s[8]!, 100 * 90 / 140, 1e-9);
  assert.ok(Number.isNaN(trailingPutShare([0, 0], [0, 0], 2)[1]!), 'nothing bought: no reading');
  // Not the average of the daily shares: a big put day outweighs small call days.
  close(trailingPutShare([100, 0], [0, 1], 2)[1]!, 100 * 100 / 101, 1e-9);
});

test('the put-flow file: rows for every day (zero where none), checked for holes and its stated span', () => {
  const days = new Map<number, FlowDay>([[100, { day: 100, put: 1.4, call: 2.6, n: 3 }], [102, { day: 102, put: 5, call: 0, n: 1 }]]);
  const rows = rowsOf(days, 100, 102);
  assert.deepEqual(rows, [[100, 1, 3, 3], [101, 0, 0, 0], [102, 5, 0, 1]]);
  const file = { v: 1, source: 's', builtAt: 1, from: 100, through: 102, days: rows };
  assert.ok(parsePutFlow(JSON.parse(JSON.stringify(file))));
  assert.equal(parsePutFlow({ ...file, days: [rows[0], rows[2]] }), null, 'a hole');
  assert.equal(parsePutFlow({ ...file, through: 103 }), null, 'span not as stated');
  assert.equal(parsePutFlow({ ...file, v: 2 }), null);
  assert.equal(parsePutFlow({ ...file, days: [[100, 1, 'x', 3]] }), null);
});

/** ---- shading and alignment -------------------------------------------------------------------------------------------------------- */

test('flagged runs are the first and last time of each stretch of flagged points', () => {
  assert.deepEqual(flaggedRuns([1, 2, 3, 4, 5, 6], [0, 1, 1, 0, 1, 1]), [[2, 3], [5, 6]]);
  assert.deepEqual(flaggedRuns([1, 2], [false, false]), []);
});

test('a daily value as it stood at each hour is the last day that had closed: the day under way is not seen', () => {
  const d0 = Date.UTC(2026, 10, 14), days = [d0, d0 + DAY_MS, d0 + 2 * DAY_MS], vals = [1, 2, 3];
  const at = [d0 + 12 * HOUR_MS, d0 + DAY_MS, d0 + DAY_MS + 5 * HOUR_MS, d0 + 2 * DAY_MS, d0 + 3 * DAY_MS];
  assert.deepEqual([...asOfClosedDay(at, days, vals)], [NaN, 1, 1, 2, 3]);
  assert.deepEqual([...alignTo([1, 2, 3], [2, 3, 4], [20, 30, 40])], [NaN, 20, 30]);
  assert.equal(nearest([1, 5, 9], 6.9), 5); assert.equal(nearest([1, 5, 9], 7.1), 9);
});

/** ---- the kept choices and axis ticks ---------------------------------------------------------------------------------------------- */

function memory(): Storage {
  const kept = new Map<string, string>();
  return { get length() { return kept.size; }, clear: () => kept.clear(), key: (i: number) => [...kept.keys()][i] ?? null,
    getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); } };
}

test('a browser that never chose a metric tab is on the chart with each tab\'s default range; a choice is kept and checked', () => {
  const s = memory();
  assert.deepEqual(readMetricPrefs(s), { tab: 'chart', ranges: DEFAULT_RANGE });
  writeMetricPrefs(s, { tab: 'puts', ranges: { ...DEFAULT_RANGE, vol: '6M' } });
  assert.deepEqual(readMetricPrefs(s), { tab: 'puts', ranges: { ...DEFAULT_RANGE, vol: '6M' } });
  s.setItem(METRIC_KEY, JSON.stringify({ tab: 'nope', ranges: { vol: 'ALL', ema: '2Y' } }));
  assert.deepEqual(readMetricPrefs(s), { tab: 'chart', ranges: { ...DEFAULT_RANGE, ema: '2Y' } }, 'unknown tab and a range the tab does not offer are dropped');
  s.setItem(METRIC_KEY, '{oops'); assert.equal(readMetricPrefs(s).tab, 'chart');
  assert.equal(readMetricPrefs(null).tab, 'chart');
  assert.deepEqual(METRIC_TABS, ['chart', 'vol', 'gap', 'term', 'puts', 'ema']);
  for (const [tab, keys] of Object.entries(RANGES)) assert.ok((keys as readonly string[]).includes(DEFAULT_RANGE[tab as keyof typeof DEFAULT_RANGE]));
  assert.equal(rangeStart('gap', 'SRC', Date.now()), SOURCE_START);
  close(rangeStart('vol', '2M', 1e12), 1e12 - 2 * 30.44 * DAY_MS, 1);
});

test('axis ticks: round numbers, log steps, weekly Mondays, month starts and days to expiry', () => {
  assert.deepEqual(niceTicks(25, 61, 6), [30, 40, 50, 60]);
  assert.deepEqual(niceTicks(-41, 52, 5), [-40, -20, 0, 20, 40]);
  const log = niceTicks(24_000, 130_000, 10, true);
  assert.ok(log.includes(30_000) && log.includes(100_000) && log.every((v, i) => !i || v > log[i - 1]!));
  const weeks = timeTicks(Date.UTC(2026, 8, 18), Date.UTC(2026, 10, 18), 6);
  assert.ok(weeks.length >= 3 && weeks.every(w => new Date(w.v).getUTCDay() === 1 && w.v % DAY_MS === 0));
  const months = timeTicks(Date.UTC(2023, 4, 1), Date.UTC(2026, 10, 18), 8);
  assert.ok(months.every(m => new Date(m.v).getUTCDate() === 1 && new Date(m.v).getUTCMonth() % 6 === 0));
  assert.deepEqual(dayTicks(0.9, 220).map(d => d.label), ['1d', '7d', '30d', '90d', '180d']);
});

/** ---- positioning: durable lows, contracts index, funding maths ----------------------------------------------------------------- */

test('durableLows: 15% under 90d high, held 60d, then +15% is confirmed; a fresh dip is unconfirmed now', () => {
  const DAY = 86_400_000;
  const t0 = Date.UTC(2024, 0, 1);
  const time: number[] = [], close: number[] = [];
  // 100 days flat at 100, then crash to 80 (day 100), stay ≥80 for 60 days, then rally to 92 (15% from 80).
  // After the rally, a fresh crash to 70 (day 200) that has not yet held 60d or rallied is unconfirmed "now".
  for (let i = 0; i < 220; i++) {
    time.push(t0 + i * DAY);
    if (i < 100) close.push(100);
    else if (i < 160) close.push(80);
    else if (i < 200) close.push(92);
    else close.push(70);
  }
  const lows = durableLows(time, close, t0 + 219 * DAY);
  assert.equal(lows.filter(l => l.confirmed).length, 1);
  assert.equal(lows.find(l => l.confirmed)!.t, t0 + 100 * DAY);
  const fresh = lows.filter(l => !l.confirmed);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.t, t0 + 200 * DAY);
  assert.equal(fresh[0]!.confirmed, false);
});

test('contractsIndex deflates OI by price and indexes to 100', () => {
  const oi = [1000, 1100], price = [50_000, 55_000];
  const idx = contractsIndex(oi, price, 100);
  close(idx[0]!, 100, 1e-9);
  // 1100/1000 * 50000/55000 * 100
  close(idx[1]!, 100 * 1.1 * (50_000 / 55_000), 1e-9);
});

test('funding7dAnnualised means the last 7 days of funding events and annualises ×3×365×100', () => {
  const DAY = 86_400_000;
  const day = Date.UTC(2024, 5, 10);
  const time: number[] = [], rate: number[] = [];
  for (let i = 0; i < 21; i++) { // 7 days × 3
    time.push(day - 6 * DAY + i * (DAY / 3));
    rate.push(0.0001); // 0.01% per funding
  }
  const out = funding7dAnnualised(time, rate, [day]);
  close(out[0]!, 0.0001 * 3 * 365 * 100, 1e-6);
});

test('pctChange and pointChange read 30 days back', () => {
  const DAY = 86_400_000, t0 = Date.UTC(2024, 0, 1);
  const times = Array.from({ length: 40 }, (_, i) => t0 + i * DAY);
  const series = times.map((_, i) => 100 + i);
  close(pctChange(series, times, t0 + 39 * DAY, 30), 100 * ((139 / 109) - 1), 1e-9);
  close(pointChange(series, times, t0 + 39 * DAY, 30), 30, 1e-9);
});
