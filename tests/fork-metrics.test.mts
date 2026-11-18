import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, HOUR_MS, alignTo, asOfClosedDay, atmIv, bsDelta, ema, expiryReadings, flaggedRuns, ivAtDelta, normCdf, parseOptionName, pctFromEma, realisedVol, skewPct, termShape, type OptionMark, type SmilePoint } from '../src/app/metrics/math.ts';
import { addTrade, optionKind, parsePutFlow, premiumUsd, readTrade, rowsOf, trailingPutShare, type FlowDay, type OptionTrade } from '../src/app/metrics/putflow.ts';
import { ALL_START, DEFAULT_RANGE, METRIC_KEY, METRIC_TABS, RANGES, SOURCE_START, rangeLabel, readMetricPrefs, rangeStart, tabLabel, tabTip, writeMetricPrefs } from '../src/app/metrics/settings.ts';
import { dayTicks, niceTicks, timeTicks } from '../src/app/metrics/ticks.ts';
import { nearest } from '../src/app/metrics/plot.ts';
import {
  ALT_ARCHIVE_DEF, CAV_LOW_MONTHS, CAV_SAMPLE_START, altArchiveDaysWanted, altCandidates, altNegShareFromArchive, altNegSeries, altNegShare, contractsIndex, contractsOnGrid, dailyOiFromMetrics, durableLows, funding7dAnnualised, fundingOnGrid,
  lastFundingBefore, lowEventPoints, mergeOiByDay, metricsUsdOiAtClose, nonCryptoUsdtPerps, monthsMatched, nowComparison, nowLow, parsePositioning, pctChange, pointChange, usdtPerpAlts, type PositioningFile,
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
  assert.deepEqual(METRIC_TABS, ['chart', 'vol', 'gap', 'term', 'puts', 'ema', 'pos']);
  assert.deepEqual(RANGES.pos, ['1Y', '2Y', 'ALL']);
  assert.equal(DEFAULT_RANGE.pos, 'ALL');
  assert.equal(ALL_START.pos, Date.UTC(2021, 11, 1));
  assert.equal(rangeStart('pos', 'ALL', Date.now()), Date.UTC(2021, 11, 1));
  assert.equal(tabLabel('pos'), 'Positioning');
  assert.equal(tabTip('pos'), 'BTC open interest and funding into swing lows, and the share of Binance alt perps on negative funding.');
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
  const lows = durableLows(time, close, close, close, t0 + 219 * DAY);
  assert.equal(lows.filter(l => l.confirmed).length, 1);
  assert.equal(lows.find(l => l.confirmed)!.t, t0 + 100 * DAY);
  const fresh = lows.filter(l => !l.confirmed);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.t, t0 + 200 * DAY);
  assert.equal(fresh[0]!.confirmed, false);
});

test('contractsIndex deflates USD open interest by price into contracts and indexes to 100', () => {
  const usdOi = [1000, 1100], price = [50_000, 55_000];
  const idx = contractsIndex(usdOi, price, 100);
  close(idx[0]!, 100, 1e-9);
  // 1100/1000 * 50000/55000 * 100
  close(idx[1]!, 100 * 1.1 * (50_000 / 55_000), 1e-9);
  // Open interest already in BTC goes in as USD (× price), so the price cancels: the index is BTC OI over the first day's.
  const btc = [20, 22], usd = btc.map((v, i) => v * price[i]!);
  close(contractsIndex(usd, price)[1]!, 110, 1e-9);
});

test('durableLows: a low held 60 days that never rallied 15% has failed, so it is not pending (pending = the 60-day window is open)', () => {
  const t0 = Date.UTC(2024, 0, 1);
  const time = Array.from({ length: 200 }, (_, i) => t0 + i * DAY_MS);
  // 100 days at 100, then 80 for 100 days: held 60 days but never +15 %.
  assert.deepEqual(flat(time, time.map((_, i) => (i < 100 ? 100 : 80))), []);
  // Still inside its 60 days (day 150 is 50 days after the low): pending.
  assert.deepEqual(flat(time.slice(0, 151), time.slice(0, 151).map((_, i) => (i < 100 ? 100 : 80))), [{ t: t0 + 100 * DAY_MS, confirmed: false }]);
});

test('durableLows: the +15% rally must come within the 60-day hold window (Cav: "within those 60 days")', () => {
  const t0 = Date.UTC(2024, 0, 1);
  const time = Array.from({ length: 220 }, (_, i) => t0 + i * DAY_MS);
  // Low 80 on day 100, held; 92 (+15 %) only from day 161, one day after the window closed.
  const late = time.map((_, i) => (i < 100 ? 100 : i <= 160 ? 80 : 92));
  assert.deepEqual(flat(time, late), []);
  // The same rally on day 160 (the window's last day) confirms it.
  const onTime = time.map((_, i) => (i < 100 ? 100 : i < 160 ? 80 : 92));
  assert.deepEqual(flat(time, onTime), [{ t: t0 + 100 * DAY_MS, confirmed: true }]);
});

test('monthsMatched counts the reference months that hold one of the lows, each month once; Cav\'s list starts after his sample start', () => {
  const at = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d);
  assert.equal(monthsMatched([at(2022, 11, 21), at(2023, 3, 10), at(2023, 3, 28), at(2024, 10, 10)], ['2022-11', '2023-03', '2023-06']), 2);
  assert.equal(monthsMatched([], ['2022-11']), 0);
  assert.equal(CAV_LOW_MONTHS.length, 11);
  assert.ok(CAV_LOW_MONTHS.every(m => Date.UTC(+m.slice(0, 4), +m.slice(5) - 1, 1) >= CAV_SAMPLE_START));
});

/** Candles with no wicks (high = low = close), for the tests that are about the rule's timing. */
const flat = (time: ArrayLike<number>, close: ArrayLike<number>) => durableLows(time, close, close, close);

test('durableLows: a qualifying 10-day swing low counts even when a deeper low comes more than 60 days later in the same drawdown', () => {
  const t0 = Date.UTC(2024, 0, 1);
  const time = Array.from({ length: 200 }, (_, i) => t0 + i * DAY_MS);
  // Day 100: low 80 (20% under 100). It holds (lows 84 after it) and a close of 93 (+16%) on day 130 rallies it; then price sinks back
  // to 84 and makes a deeper low of 70 on day 175, 75 days on. A one-low-per-drawdown rule would only see day 175.
  const low = time.map((_, i) => (i < 100 ? 100 : i === 100 ? 80 : i < 175 ? 84 : i === 175 ? 70 : 72));
  const close = time.map((_, i) => (i === 130 ? 93 : low[i]!));
  assert.deepEqual(durableLows(time, close, low, close), [{ t: t0 + 100 * DAY_MS, confirmed: true }, { t: t0 + 175 * DAY_MS, confirmed: false }]);
});

test('durableLows reads wicks for the 90-day high and the hold, and a close for the +15% rally (Cav: "followed by a close at least 15% higher")', () => {
  const t0 = Date.UTC(2024, 0, 1);
  const time = Array.from({ length: 220 }, (_, i) => t0 + i * DAY_MS);
  // Closes and lows at 90 for 100 days, with one wick to 100 on day 50: day 100's low of 80 is 20% under that intraday high (only 11%
  // under the closes). Lows 82 / closes 83 / highs 84 after it, a high of 93 (+16%) on day 140, then 90 from day 160.
  const low = time.map((_, i) => (i < 100 ? 90 : i === 100 ? 80 : i < 160 ? 82 : 90));
  const high = time.map((_, i) => (i === 50 ? 100 : i === 140 ? 93 : i >= 100 && i < 160 ? 84 : 90));
  const close = (rallyClose: number) => time.map((_, i) => (i === 140 ? rallyClose : i >= 100 && i < 160 ? 83 : 90));
  // The wick to 93 alone (close 83) is not the rally: the low held 60 days without it and has failed.
  assert.deepEqual(durableLows(time, high, low, close(83)), []);
  // A close of 93 on day 140 is.
  assert.deepEqual(durableLows(time, high, low, close(93)), [{ t: t0 + 100 * DAY_MS, confirmed: true }]);
  // A wick to 79 on day 130 undercuts it (no close needs to): day 100 fails, and day 130 is itself a swing low that holds and rallies.
  const wick = low.map((v, i) => (i === 130 ? 79 : v));
  assert.deepEqual(durableLows(time, high, wick, close(93)), [{ t: t0 + 130 * DAY_MS, confirmed: true }]);
});

test('durableLows: a qualifying low within 60 days of the previous accepted low is a retest of the same episode and is not counted', () => {
  const t0 = Date.UTC(2024, 0, 1);
  const time = Array.from({ length: 260 }, (_, i) => t0 + i * DAY_MS);
  // Low 80 on day 100; 90 on days 101-114; a second 10-day swing low of 82 on day 115 (15 days later; a swing low is the lowest of its
  // 10 days, so a retest of a held low is at least 10 days on), then 95 from day 130. Both qualify on their own; the second is a retest.
  const px = (i: number): number => (i < 100 ? 100 : i === 100 ? 80 : i < 115 ? 90 : i === 115 ? 82 : i < 130 ? 84 : 95);
  const close = time.map((_, i) => px(i));
  assert.deepEqual(flat(time, close), [{ t: t0 + 100 * DAY_MS, confirmed: true }]);
  // A retest still inside its own window is not "now" either.
  assert.deepEqual(flat(time.slice(0, 120), close.slice(0, 120)), [{ t: t0 + 100 * DAY_MS, confirmed: false }]);
  // "Within 60 days" is inclusive, like the hold window: a second low 60 days on is a retest, 61 days on is a new low.
  const second = (gap: number) => time.map((_, i) => (i < 100 ? 100 : i === 100 ? 80 : i === 100 + gap ? 81 : 96));
  assert.deepEqual(flat(time, second(60)), [{ t: t0 + 100 * DAY_MS, confirmed: true }]);
  assert.deepEqual(flat(time, second(61)), [{ t: t0 + 100 * DAY_MS, confirmed: true }, { t: t0 + 161 * DAY_MS, confirmed: true }]);
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

/** ---- positioning file and durable-low event points -------------------------------------------------------------------------------- */

test('the positioning file: parsePositioning round-trips and rejects holes, a wrong span, a bad version, and a non-number', () => {
  const days: [number, number, number, number][] = [[100, 1, 2, 3], [101, 4, 5, 6], [102, 7, 8, 9]];
  const file = { v: 1 as const, source: 's', builtAt: 1, from: 100, through: 102, days };
  assert.deepEqual(parsePositioning(JSON.parse(JSON.stringify(file))), file);
  assert.equal(parsePositioning({ ...file, days: [days[0], days[2]] }), null, 'a hole');
  assert.equal(parsePositioning({ ...file, through: 103 }), null, 'span not as stated');
  assert.equal(parsePositioning({ ...file, v: 2 }), null);
  assert.equal(parsePositioning({ ...file, days: [[100, 1, 'x', 3]] }), null);
  // Missing oi / funding / altNeg may be null (JSON has no NaN) or NaN; the parser stores NaN.
  const gapped = parsePositioning({ v: 1, source: 's', builtAt: 1, from: 100, through: 101, days: [[100, 1, 2, null], [101, null, 3, 4]] });
  assert.ok(gapped);
  close(gapped.days[0]![1]!, 1, 1e-9);
  close(gapped.days[1]![2]!, 3, 1e-9);
  assert.ok(Number.isNaN(gapped.days[0]![3]!), 'null altNeg');
  assert.ok(Number.isNaN(gapped.days[1]![1]!), 'null oi');
  const nanRow = parsePositioning({ v: 1, source: 's', builtAt: 1, from: 100, through: 100, days: [[100, 1, NaN, 0]] });
  assert.ok(nanRow);
  assert.ok(Number.isNaN(nanRow.days[0]![2]!), 'NaN funding7d');
});

test('the positioning file keeps its alt-share definition and its list of equity perpetuals left out', () => {
  const file = { v: 1 as const, source: 's', builtAt: 1, from: 100, through: 100, days: [[100, 1, 2, 3]] as [number, number, number, number][], altDef: ALT_ARCHIVE_DEF, altExclude: ['AAPLUSDT', 'TSLAUSDT'] };
  assert.deepEqual(parsePositioning(JSON.parse(JSON.stringify(file))), file);
  const plain = parsePositioning({ v: 1, source: 's', builtAt: 1, from: 100, through: 100, days: [[100, 1, 2, 3]] });
  assert.ok(plain);
  assert.equal(plain.altDef, undefined);
  assert.deepEqual(plain.altExclude, undefined);
  // A list that is not strings is dropped, not the file.
  assert.equal(parsePositioning({ ...file, altExclude: [1, 'X'] })?.altExclude, undefined);
});

/** ---- the alt share from data.binance.vision ------------------------------------------------------------------------------------------ */

const METRICS_HEAD = 'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio';

test('metricsUsdOiAtClose: the day\'s 23:55 USD open interest (sum_open_interest_value), else its latest real reading', () => {
  const d = Math.floor(Date.UTC(2026, 10, 17) / DAY_MS);
  const rows = (lines: string[]): string => [METRICS_HEAD, ...lines].join('\n');
  const full = rows([
    '2026-11-17 00:00:00,ETHUSDT,2284265.26,4156822442.76,1,1,1,1',
    '2026-11-17 23:55:00,ETHUSDT,2347501.46,4292593813.99,1,1,1,1',
    '2026-11-17 23:10:00,ETHUSDT,2347000.00,4290000000.00,1,1,1,1',
  ]);
  close(metricsUsdOiAtClose(full, d), 4292593813.99, 1e-3);
  // No 23:55 row (or a zero placeholder there): the latest stamped row of the day with a reading.
  const late = rows(['2026-11-17 12:00:00,X,1,500,1,1,1,1', '2026-11-17 23:55:00,X,0E-8,0E-8,,,,', '2026-11-17 22:00:00,X,2,900,1,1,1,1', '2026-11-17 06:00:00,X,3,700,1,1,1,1']);
  close(metricsUsdOiAtClose(late, d), 900, 1e-9);
  // Only placeholders, other days' rows, or nothing: NaN.
  assert.ok(Number.isNaN(metricsUsdOiAtClose(rows(['2026-11-17 23:55:00,X,0E-8,0E-16,,,,', '2026-11-16 23:55:00,X,5,5,1,1,1,1']), d)));
  assert.ok(Number.isNaN(metricsUsdOiAtClose(METRICS_HEAD, d)));
});

test('lastFundingBefore: the rate of the last settlement before a time, from a monthly fundingRate file', () => {
  const csv = ['calc_time,funding_interval_hours,last_funding_rate', '1790812800001,8,0.00005694', '1790841600005,8,-0.00007243', '1790870400002,8,0.0001'].join('\n');
  close(lastFundingBefore(csv, 1790870400000), -0.00007243, 1e-12);
  close(lastFundingBefore(csv, 1790870400003), 0.0001, 1e-12);
  assert.ok(Number.isNaN(lastFundingBefore(csv, 1790812800000)), 'nothing settled before');
  assert.ok(Number.isNaN(lastFundingBefore('calc_time,funding_interval_hours,last_funding_rate', 2e12)));
});

test('altNegShareFromArchive: top alts by USD open interest, BTCUSDT and the left-out symbols excluded, null under 80% read', () => {
  const rows = [
    { symbol: 'BTCUSDT', usd: 9e12, rate: -1 },
    { symbol: 'AAPLUSDT', usd: 8e12, rate: -1 },
    { symbol: 'ETHUSDT', usd: 3e9, rate: -0.0001 },
    { symbol: 'SOLUSDT', usd: 1e9, rate: 0.0001 },
    { symbol: 'XRPUSDT', usd: 5e8, rate: -0.0002 },
    { symbol: 'DOGEUSDT', usd: 1e8, rate: 0.0001 },
    { symbol: 'DEADUSDT', usd: NaN, rate: 0.0001 }, // no reading at the day's close: not trading, not a candidate
  ];
  const exclude = new Set(['AAPLUSDT']);
  close(altNegShareFromArchive(rows, exclude, 3)!, 100 * 3.5e9 / 4.5e9, 1e-9, 'top 3 of ETH, SOL, XRP, DOGE');
  close(altNegShareFromArchive(rows, exclude, 50)!, 100 * 3.5e9 / 4.6e9, 1e-9);
  // A candidate without funding is unread: 3 of 4 read is under 80 %.
  const unread = rows.map(r => (r.symbol === 'DOGEUSDT' ? { ...r, rate: NaN } : r));
  assert.equal(altNegShareFromArchive(unread, exclude, 50), null);
  assert.equal(altNegShareFromArchive([], exclude, 50), null);
});

test('nonCryptoUsdtPerps: the USDT contracts exchangeInfo lists that are not crypto perpetuals (equity "TRADIFI" perpetuals), not dated futures', () => {
  const info = { symbols: [
    { symbol: 'ETHUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING' },
    { symbol: 'AAPLUSDT', contractType: 'TRADIFI_PERPETUAL', quoteAsset: 'USDT', status: 'TRADING' },
    { symbol: 'OLDUSDT', contractType: 'TRADIFI_PERPETUAL', quoteAsset: 'USDT', status: 'SETTLING' },
    { symbol: 'BTCUSDT_261225', contractType: 'CURRENT_QUARTER', quoteAsset: 'USDT', status: 'TRADING' },
    { symbol: 'ETHUSDC', contractType: 'TRADIFI_PERPETUAL', quoteAsset: 'USDC', status: 'TRADING' },
  ] };
  assert.deepEqual([...nonCryptoUsdtPerps(info)].sort(), ['AAPLUSDT', 'OLDUSDT']);
  assert.throws(() => nonCryptoUsdtPerps({}));
});

test('altArchiveDaysWanted: the days after the last stored alt share, from the archive\'s first, in months whose funding is published', () => {
  const day = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
  const start = day(2021, 12, 1), now = Date.UTC(2026, 10, 19, 1);
  const rows = (from: number, to: number, alt: (d: number) => number): [number, number, number, number][] => Array.from({ length: to - from + 1 }, (_, i) => [from + i, 1, 1, alt(from + i)]);
  // Nothing stored: from the archive's first day to the end of last month (October 2026), not November's days.
  const empty = altArchiveDaysWanted(rows(day(2021, 11, 25), day(2026, 11, 17), () => NaN), start, now);
  assert.equal(empty[0], start);
  assert.equal(empty[empty.length - 1], day(2026, 10, 31));
  assert.equal(empty.length, day(2026, 10, 31) - start + 1);
  // Stored to 2026-09-30, with an old hole (null for good): only October.
  const held = altArchiveDaysWanted(rows(day(2021, 11, 25), day(2026, 11, 17), d => (d <= day(2026, 9, 30) && d !== day(2023, 5, 5) ? 10 : NaN)), start, now);
  assert.deepEqual([held[0], held[held.length - 1], held.length], [day(2026, 10, 1), day(2026, 10, 31), 31]);
  // Never past the file's last day.
  assert.equal(altArchiveDaysWanted(rows(day(2021, 11, 25), day(2022, 1, 10), () => NaN), start, now).at(-1), day(2022, 1, 10));
});

test('lowEventPoints: a confirmed low with contracts up 9% and funding +5.5 points', () => {
  const t0 = Date.UTC(2024, 0, 1);
  const dayTimes = Array.from({ length: 40 }, (_, i) => t0 + i * DAY_MS);
  const contracts = dayTimes.map((_, i) => (i === 39 ? 109 : 100));
  const funding = dayTimes.map((_, i) => (i === 39 ? 15.5 : 10));
  const points = lowEventPoints([{ t: t0 + 39 * DAY_MS, confirmed: true }], dayTimes, contracts, funding);
  assert.equal(points.length, 1);
  assert.equal(points[0]!.t, t0 + 39 * DAY_MS);
  assert.equal(points[0]!.confirmed, true);
  close(points[0]!.oiPct, 9, 1e-9);
  close(points[0]!.fundPts, 5.5, 1e-9);
  close(points[0]!.fundAt, 15.5, 1e-9);
});

test('lowEventPoints keeps a low with missing OI (oiPct NaN) and skips one with missing funding', () => {
  const t0 = Date.UTC(2024, 0, 1);
  const dayTimes = Array.from({ length: 40 }, (_, i) => t0 + i * DAY_MS);
  const t = t0 + 39 * DAY_MS;
  const funding = dayTimes.map((_, i) => (i === 39 ? 15.5 : 10));
  const noOi = lowEventPoints([{ t, confirmed: false }], dayTimes, dayTimes.map(() => NaN), funding);
  assert.equal(noOi.length, 1);
  assert.equal(noOi[0]!.confirmed, false);
  assert.ok(Number.isNaN(noOi[0]!.oiPct));
  close(noOi[0]!.fundPts, 5.5, 1e-9);
  close(noOi[0]!.fundAt, 15.5, 1e-9);
  const contracts = dayTimes.map((_, i) => (i === 39 ? 109 : 100));
  assert.deepEqual(lowEventPoints([{ t, confirmed: true }], dayTimes, contracts, dayTimes.map(() => NaN)), []);
  const onlyAt = dayTimes.map((_, i) => (i === 39 ? 15.5 : NaN));
  assert.deepEqual(lowEventPoints([{ t, confirmed: true }], dayTimes, contracts, onlyAt), [], 'funding at the low but no 30d lookback');
});

/** ---- alt negative-funding share and the archive's daily open interest ----------------------------------------------------------- */

const prem = (symbol: string, rate: number, mark: number) => ({ symbol, lastFundingRate: String(rate), markPrice: String(mark) });

test('usdtPerpAlts keeps trading USDT perpetuals other than BTCUSDT; altCandidates reads funding and mark price for them', () => {
  const info = { symbols: [
    { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
    { symbol: 'ETHUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
    { symbol: 'ETHUSDT_250926', status: 'TRADING', contractType: 'CURRENT_QUARTER', quoteAsset: 'USDT' },
    { symbol: 'SOLUSDC', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDC' },
    { symbol: 'OLDUSDT', status: 'SETTLING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
  ] };
  assert.deepEqual([...usdtPerpAlts(info)], ['ETHUSDT']);
  const rows = altCandidates([prem('ETHUSDT', -0.0001, 3000), prem('XUSDT', 0.0001, 1), { symbol: 'ETHUSDT2', lastFundingRate: 'x', markPrice: '1' }], new Set(['ETHUSDT', 'ETHUSDT2']));
  assert.deepEqual(rows, [{ symbol: 'ETHUSDT', rate: -0.0001, mark: 3000 }]);
});

test('altNegShare ranks and weights by USD open interest (contracts × mark price), not contracts', () => {
  const premium = [prem('ETHUSDT', -0.0001, 3000), prem('SOLUSDT', 0.0001, 150), prem('PEPEUSDT', 0.0001, 0.00001)];
  const eligible = new Set(['ETHUSDT', 'SOLUSDT', 'PEPEUSDT']);
  // Contracts: PEPE 1e10, SOL 10,000, ETH 1,000; USD: ETH $3M (negative), SOL $1.5M, PEPE $100k.
  const oi = new Map([['ETHUSDT', 1000], ['SOLUSDT', 10_000], ['PEPEUSDT', 1e10]]);
  // The top 2 by USD are ETH and SOL: 3M of 4.5M negative. (By contracts they would be PEPE and SOL, with no negative share.)
  close(altNegShare(premium, eligible, oi, 2)!, 100 * 3_000_000 / 4_500_000, 1e-9, 'USD-weighted top 2');
  close(altNegShare(premium, eligible, oi, 3)!, 100 * 3_000_000 / 4_600_000, 1e-9, 'USD-weighted, all three');
});

test('altNegShare leaves out BTCUSDT and alts whose open interest is not positive', () => {
  const premium = [prem('BTCUSDT', -0.001, 60_000), prem('ETHUSDT', 0.0001, 3000), prem('SOLUSDT', -0.0001, 150), prem('DOGEUSDT', -0.0001, 0.2), prem('XRPUSDT', 0.0001, 0.5), prem('ADAUSDT', 0.0001, 0.4)];
  const eligible = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'ADAUSDT']);
  const oi = new Map([['BTCUSDT', 1e9], ['ETHUSDT', 1000], ['SOLUSDT', 20_000], ['DOGEUSDT', 0], ['XRPUSDT', 1_000_000], ['ADAUSDT', 1_000_000]]);
  // ETH $3M, SOL $3M (negative), XRP $0.5M, ADA $0.4M; DOGE has zero OI and BTC is not an alt. 4 of 5 alts read = 80 %.
  close(altNegShare(premium, eligible, oi, 50)!, 100 * 3_000_000 / 6_900_000, 1e-9);
});

test('altNegShare is null when fewer than 80 % of the alts were read, or there is nothing to weigh', () => {
  const premium = Array.from({ length: 10 }, (_, i) => prem(`A${i}USDT`, i % 2 ? -0.0001 : 0.0001, 1));
  const eligible = new Set(premium.map(r => r.symbol));
  const seven = new Map(premium.slice(0, 7).map(r => [r.symbol, 100] as [string, number]));
  assert.equal(altNegShare(premium, eligible, seven, 50), null, '7 of 10 read');
  const eight = new Map(premium.slice(0, 8).map(r => [r.symbol, 100] as [string, number]));
  close(altNegShare(premium, eligible, eight, 50)!, 50, 1e-9, '8 of 10 read');
  assert.equal(altNegShare([], new Set(), new Map(), 50), null, 'empty');
  assert.equal(altNegShare(premium, eligible, new Map(), 50), null, 'nothing read');
});

test('dailyOiFromMetrics: the 23:55 reading of the day before, else the day\'s 00:00; zero placeholder rows are no reading', () => {
  const head = 'create_time,symbol,sum_open_interest,sum_open_interest_value\n';
  const before = head + '2024-07-10 23:50:00,BTCUSDT,0E-8,0E-8\n2024-07-10 23:55:00,BTCUSDT,0E-16,0E-8\n2024-07-10 12:00:00,BTCUSDT,70000.5,1\n';
  const own = head + '2024-07-11 00:05:00,BTCUSDT,71000,1\n2024-07-11 00:00:00,BTCUSDT,70900.25,1\n';
  const d = Date.UTC(2024, 6, 11) / DAY_MS;
  close(dailyOiFromMetrics(before, own, d)!, 70900.25, 1e-9, 'placeholder at 23:55 falls back to 00:00');
  const good = head + '2024-07-10 23:55:00,BTCUSDT,70123.4,1\n';
  close(dailyOiFromMetrics(good, own, d)!, 70123.4, 1e-9, '23:55 first');
  assert.ok(Number.isNaN(dailyOiFromMetrics(before, head + '2024-07-11 00:00:00,BTCUSDT,0E-8,0\n', d)!), 'only placeholders: NaN');
  assert.ok(Number.isNaN(dailyOiFromMetrics(before, null, d)!), 'a file but no reading: NaN');
  assert.equal(dailyOiFromMetrics(null, null, d), null, 'no files');
});

/** ---- Positioning view data assembly ---------------------------------------------------------------------------------------------- */

const posFile = (from: number, rows: [number, number, number][]): PositioningFile =>
  ({ v: 1, source: 's', builtAt: 0, from, through: from + rows.length - 1, days: rows.map(([oi, f, a], k) => [from + k, oi, f, a]) });

test('mergeOiByDay: the archive overrides and extends the API by UTC day; missing or non-positive readings are left out', () => {
  const d0 = 20_000;
  const file = posFile(d0, [[10, 1, NaN], [NaN, 1, NaN], [12, 1, NaN], [0, 1, NaN]]);
  const api = { time: Float64Array.from([d0 + 1, d0 + 2, d0 + 4].map(d => d * DAY_MS)), close: Float64Array.from([21, 22, 24]) };
  const m = mergeOiByDay(file, api);
  assert.deepEqual([...m.entries()].sort((a, b) => a[0] - b[0]), [[d0, 10], [d0 + 1, 21], [d0 + 2, 12], [d0 + 4, 24]]);
  assert.deepEqual([...mergeOiByDay(null, api).keys()], [d0 + 1, d0 + 2, d0 + 4], 'API only');
  assert.equal(mergeOiByDay(file, null).size, 2, 'archive only');
  assert.equal(mergeOiByDay(null, null).size, 0);
});

test('contractsOnGrid: Binance OI is already in BTC, so the index is OI over the first day with OI, × 100 (not deflated twice)', () => {
  const d0 = 20_000, times = [0, 1, 2, 3, 4].map(k => (d0 + k) * DAY_MS), price = [100, 200, 400, 800, 100];
  const oi = new Map([[d0 + 1, 50], [d0 + 2, 55], [d0 + 4, 40]]);
  const idx = contractsOnGrid(times, price, oi);
  assert.ok(Number.isNaN(idx[0]!), 'before the first OI');
  close(idx[1]!, 100, 1e-9);
  close(idx[2]!, 110, 1e-9, 'price doubled, contracts +10 %');
  assert.ok(Number.isNaN(idx[3]!), 'a day without OI stays NaN');
  close(idx[4]!, 80, 1e-9);
  assert.ok(contractsOnGrid(times, price, new Map()).every(Number.isNaN), 'no OI at all');
});

test('fundingOnGrid: live 7-day funding where it reads, the archive\'s funding7d on days it does not, NaN when neither', () => {
  const d0 = 20_000, times = [0, 1, 2, 3].map(k => (d0 + k) * DAY_MS);
  const file = posFile(d0, [[1, 5, NaN], [1, 6, NaN], [1, 7, NaN]]);
  const rates = { time: Float64Array.from([2, 3].flatMap(k => [0, 1, 2].map(j => (d0 + k) * DAY_MS + j * 8 * HOUR_MS))), close: new Float64Array(6).fill(0.0001) };
  const f = fundingOnGrid(times, rates, file);
  close(f[0]!, 5, 1e-9, 'archive');
  close(f[1]!, 6, 1e-9, 'archive');
  close(f[2]!, 0.0001 * 3 * 365 * 100, 1e-9, 'live');
  close(f[3]!, 0.0001 * 3 * 365 * 100, 1e-9, 'live, after the archive');
  const archiveOnly = fundingOnGrid(times, null, file);
  close(archiveOnly[2]!, 7, 1e-9);
  assert.ok(Number.isNaN(archiveOnly[3]!), 'neither');
});

test('altNegSeries: archive readings plus a live reading on today, a 7-day trailing mean of the archive readings (not the live one), and gaps kept', () => {
  const d0 = 20_000;
  const file = posFile(d0, [[1, 1, 10], [1, 1, NaN], [1, 1, 20], [1, 1, NaN]]);
  const s = altNegSeries(file, { at: (d0 + 5) * DAY_MS + 3 * HOUR_MS, value: 30 });
  assert.deepEqual(Array.from(s.time), [0, 1, 2, 3, 4, 5].map(k => (d0 + k) * DAY_MS));
  assert.deepEqual(Array.from(s.raw).map(v => (Number.isNaN(v) ? null : v)), [10, null, 20, null, null, 30]);
  // The live reading is measured another way (current funding, contracts × mark now), so the mean is of the archive's readings only.
  assert.deepEqual(Array.from(s.n7), [1, 1, 2, 2, 2, 2], 'archive readings in each 7-day window: the mean is "mean of n readings" until 7');
  close(s.avg7[0]!, 10, 1e-9); close(s.avg7[1]!, 10, 1e-9); close(s.avg7[2]!, 15, 1e-9); close(s.avg7[5]!, 15, 1e-9);
  assert.equal(s.live, true);
  const single = altNegSeries(posFile(d0, [[1, 1, NaN], [1, 1, 11.7]]), null);
  assert.deepEqual(Array.from(single.time), [(d0 + 1) * DAY_MS], 'one archive reading: one point');
  close(single.avg7[0]!, 11.7, 1e-9);
  assert.equal(single.live, false);
  const live = altNegSeries(posFile(d0, [[1, 1, 12]]), { at: d0 * DAY_MS + HOUR_MS, value: 14 });
  assert.deepEqual(Array.from(live.raw), [14], 'the live reading replaces the archive on the same day');
  assert.ok(Number.isNaN(live.avg7[0]!), 'and has no mean of its own');
  assert.equal(live.n7[0], 0);
  assert.equal(altNegSeries(null, null).time.length, 0);
  // A reading every 8 days leaves a day with none in its 7: NaN, so the line breaks there.
  const sparse = altNegSeries(posFile(d0, [[1, 1, 10], [1, 1, NaN], [1, 1, NaN], [1, 1, NaN], [1, 1, NaN], [1, 1, NaN], [1, 1, NaN], [1, 1, NaN], [1, 1, 20]]), null);
  assert.ok(Number.isNaN(sparse.avg7[7]!));
});

test('nowLow: the pending (unconfirmed) low is now; with none pending, the last closed day is', () => {
  const lows = [{ t: 1, confirmed: true }, { t: 5, confirmed: false }];
  assert.deepEqual(nowLow(lows, 9), { lows, pending: true });
  assert.deepEqual(nowLow([{ t: 1, confirmed: true }], 9), { lows: [{ t: 1, confirmed: true }, { t: 9, confirmed: false }], pending: false });
  assert.deepEqual(nowLow([], 9), { lows: [{ t: 9, confirmed: false }], pending: false });
});

test('rangeLabel: Positioning\'s longest range says where it begins (Dec 2021, the alt-share archive)', () => {
  assert.equal(rangeLabel('pos', 'ALL'), 'Since Dec 2021'); // chart C's archive (alt metrics) begins 2021-12-01
  assert.equal(rangeLabel('gap', 'ALL'), 'Since Apr 2021');
  assert.equal(ALL_START.pos, Date.UTC(2021, 11, 1));
});

test('nowComparison: counts lows that beat now, and leaves the contracts count out when now has no open interest', () => {
  const p = (oiPct: number, fundPts: number) => ({ t: 0, confirmed: true, oiPct, fundPts, fundAt: 0 });
  const lows = [p(10, 1), p(-5, 6), p(NaN, 7), p(3, -2)];
  assert.deepEqual(nowComparison(lows, { ...p(5, 5), confirmed: false }), { withOi: 3, faster: 1, withFunding: 4, further: 2 });
  assert.deepEqual(nowComparison(lows, { ...p(NaN, 5), confirmed: false }), { withOi: 3, faster: null, withFunding: 4, further: 2 });
});
