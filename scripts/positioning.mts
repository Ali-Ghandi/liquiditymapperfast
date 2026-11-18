// Builds positioning.json (the Positioning tab's archive): for each UTC day, Binance BTCUSDT open interest (contracts), the 7-day
// annualised BTCUSDT funding, and the open-interest-weighted share of the top 50 Binance USDT-M alts (ex-BTC) whose last funding was
// negative. Binance keeps funding back to 2019 but daily open interest for only about a month, and has no history of the alt share at
// all, so the file is what keeps them: the page reads it and adds what Binance still serves live.
//
//   npm run build:tools && node build/tools/scripts/positioning.mjs --out src/app/public/positioning.json
//   node build/tools/scripts/positioning.mjs --previous https://ali-ghandi.github.io/liquiditymapperfast/positioning.json \
//        --fallback src/app/public/positioning.json --out dist/positioning.json
//
// --previous is the file in use (a file or an address) and --fallback stands in when it cannot be read: its days are kept and only the
// days after its last are added, up to yesterday (UTC). Without either, funding is read from its start (September 2019). A new day needs
// its funding, and its open interest once Binance's history covers it; a day without them ends the file at the day before, so the file
// never has a hole (the open interest before Binance's month is null). The alt share is a live reading, so only yesterday gets one, when
// it has none yet; it is null when it cannot be read. Missing values are written as null (JSON has no NaN).
import fs from 'node:fs';
import path from 'node:path';
import { DAY_MS } from '../src/app/metrics/math.ts';
import { funding7dAnnualised, parsePositioning, type PositioningFile } from '../src/app/metrics/positioning.ts';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const FAPI = 'https://fapi.binance.com';
const SOURCE = 'Binance USDT-M: BTCUSDT open interest and funding; top 50 alts by open interest, last funding (approximates Coinalyze top-300)';
/** Before Binance's first BTCUSDT funding (2019-09-10). */
const FUNDING_START = Date.UTC(2019, 8, 1);
const TOP_ALTS = 50;
const day = (ms: number): number => Math.floor(ms / DAY_MS);
const iso = (d: number): string => new Date(d * DAY_MS).toISOString().slice(0, 10);
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function readFile(source: string | undefined): Promise<PositioningFile | null> {
  if (!source) return null;
  try {
    const json: unknown = /^https?:/.test(source)
      ? await (await fetch(source, { signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' } })).json()
      : JSON.parse(fs.readFileSync(source, 'utf8'));
    const file = parsePositioning(json);
    if (!file) console.warn(`${source} is not a positioning file`);
    else if (!file.days.length) { console.warn(`${source} holds no days`); return null; }
    return file;
  } catch (error) { console.warn(`could not read ${source}: ${message(error)}`); return null; }
}

/** A Binance public endpoint, retried with backoff (longer when Binance says to slow down). */
async function binance(pathAndQuery: string, attempts = 5): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(FAPI + pathAndQuery, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'liquidity-mapper-fast positioning' } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} for ${pathAndQuery}`);
        if (response.status === 451 || response.status === 400) throw Object.assign(error, { final: true });
        if (response.status === 429 || response.status === 418) await sleep(Number(response.headers.get('retry-after') ?? 10) * 1000);
        throw error;
      }
      return await response.json();
    } catch (error) {
      if ((error as { final?: boolean }).final || attempt >= attempts - 1) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/** BTCUSDT funding settlements from `start` to now, by time. */
async function fundingRates(start: number): Promise<Map<number, number>> {
  const at = new Map<number, number>(), now = Date.now();
  let cursor = start;
  for (let pages = 0; cursor <= now && pages < 400; pages++) {
    const body = await binance(`/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000&startTime=${cursor}`);
    if (!Array.isArray(body)) throw new Error('unexpected funding rates');
    let last = cursor, fresh = 0;
    for (const row of body as { fundingTime?: unknown; fundingRate?: unknown }[]) {
      const t = Number(row?.fundingTime), r = Number(row?.fundingRate);
      if (!Number.isFinite(t) || !Number.isFinite(r) || t < start) continue;
      if (!at.has(t)) fresh++;
      at.set(t, r);
      if (t > last) last = t;
    }
    if (fresh === 0 || last === cursor || body.length < 500) break;
    cursor = last + 1;
  }
  return at;
}

/** BTCUSDT daily open interest (contracts) by UTC day of the bar, about the last month. */
async function openInterestDaily(): Promise<Map<number, number>> {
  const body = await binance('/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=500');
  if (!Array.isArray(body)) throw new Error('unexpected open interest');
  const at = new Map<number, number>();
  for (const row of body as { timestamp?: unknown; sumOpenInterest?: unknown }[]) {
    const t = Number(row?.timestamp), c = Number(row?.sumOpenInterest);
    if (Number.isFinite(t) && Number.isFinite(c) && c >= 0) at.set(day(t), c);
  }
  return at;
}

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!(); }
  }));
  return out;
}

/** Now: the OI-weighted percent of the top alts (USDT-M perpetuals ex-BTC, by open interest) whose last funding is negative. */
async function altNegShare(): Promise<{ share: number; ranked: number; read: number }> {
  const [info, premium] = await Promise.all([binance('/fapi/v1/exchangeInfo'), binance('/fapi/v1/premiumIndex')]);
  const symbols = (info as { symbols?: unknown } | null)?.symbols;
  if (!Array.isArray(symbols) || !Array.isArray(premium)) throw new Error('unexpected exchange info or premium index');
  const alts = new Set<string>();
  for (const s of symbols as { symbol?: unknown; status?: unknown; contractType?: unknown; quoteAsset?: unknown }[]) {
    if (s?.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && typeof s.symbol === 'string' && s.symbol !== 'BTCUSDT') alts.add(s.symbol);
  }
  const funding = new Map<string, number>();
  for (const r of premium as { symbol?: unknown; lastFundingRate?: unknown }[]) {
    if (typeof r?.symbol !== 'string' || !alts.has(r.symbol)) continue;
    const rate = Number(r.lastFundingRate);
    if (Number.isFinite(rate)) funding.set(r.symbol, rate);
  }
  // Every alt's open interest, at most 8 at a time with a short pause each (well under Binance's weight limit); a failed one is skipped.
  const readings = await pool([...funding.keys()].map(symbol => async () => {
    await sleep(50);
    try {
      const oi = Number((await binance(`/fapi/v1/openInterest?symbol=${symbol}`, 3) as { openInterest?: unknown } | null)?.openInterest);
      return { symbol, oi: Number.isFinite(oi) && oi > 0 ? oi : NaN };
    } catch { return { symbol, oi: NaN }; }
  }), 8);
  const read = readings.filter(r => r.oi > 0);
  // A share from a fraction of the market would mislead: give up when most of the calls failed.
  if (read.length < Math.min(TOP_ALTS, funding.size * 0.8)) throw new Error(`open interest read for only ${read.length} of ${funding.size} alts`);
  const ranked = read.sort((a, b) => b.oi - a.oi).slice(0, TOP_ALTS);
  let neg = 0, total = 0;
  for (const r of ranked) { total += r.oi; if (funding.get(r.symbol)! < 0) neg += r.oi; }
  if (!(total > 0)) throw new Error('no alt open interest');
  return { share: 100 * neg / total, ranked: ranked.length, read: read.length };
}

const round = (v: number, places: number): number | null => Number.isFinite(v) ? Math.round(v * 10 ** places) / 10 ** places : null;

const out = arg('out');
if (!out) { console.error('usage: positioning --out <file> [--previous <file or URL>] [--fallback <file>]'); process.exit(2); }
const previous = await readFile(arg('previous')) ?? await readFile(arg('fallback'));
const yesterday = day(Date.now()) - 1;

/** Rows by day: [oi, funding7d, altNeg], NaN when missing. */
const held = new Map<number, [number, number, number]>();
for (const [d, oi, f, a] of previous?.days ?? []) held.set(d, [oi, f, a]);
let from = previous ? previous.from : NaN;
let through = previous ? previous.through : NaN;
const firstNew = previous ? previous.through + 1 : day(FUNDING_START);

// Funding: the rates since six days before the first new day (its 7-day window), or from the start.
let rates: Map<number, number>;
try {
  rates = await fundingRates(Math.max(FUNDING_START, (firstNew - 6) * DAY_MS));
} catch (error) {
  console.warn(`funding: ${message(error)}`);
  rates = new Map();
}
const rateTimes = [...rates.keys()].sort((a, b) => a - b);
const newDays: number[] = [];
for (let d = firstNew; d <= yesterday; d++) newDays.push(d);
const funding = funding7dAnnualised(Float64Array.from(rateTimes), Float64Array.from(rateTimes, t => rates.get(t)!), Float64Array.from(newDays, d => d * DAY_MS));
// A day's funding counts only when its own day has a settlement (the window could otherwise be filled by the days before alone).
const settled = new Set(rateTimes.map(day));

// Open interest: refreshes the days Binance still serves.
let oiByDay: Map<number, number> | null = null;
try { oiByDay = await openInterestDaily(); } catch (error) { console.warn(`open interest: ${message(error)}`); }
if (oiByDay && !oiByDay.size) { console.warn('open interest: none returned'); oiByDay = null; }
const oiFirst = oiByDay && oiByDay.size ? Math.min(...oiByDay.keys()) : Infinity;
const oiStarted = [...held.values()].some(([oi]) => Number.isFinite(oi));
if (oiByDay) for (const [d, oi] of oiByDay) { const row = held.get(d); if (row) row[0] = oi; }

// New days, in order, until one lacks what it needs.
let added = 0;
for (let i = 0; i < newDays.length; i++) {
  const d = newDays[i]!, f = funding[i]!;
  if (!settled.has(d) || !Number.isFinite(f)) {
    if (Number.isNaN(through)) continue; // before the first funding: the file has not begun
    console.warn(`${iso(d)}: no funding, the file ends at ${iso(through)}`); break;
  }
  const oi = oiByDay?.get(d) ?? NaN;
  const oiNeeded = oiByDay ? d >= oiFirst : oiStarted;
  if (oiNeeded && !Number.isFinite(oi)) { console.warn(`${iso(d)}: no open interest, the file ends at ${Number.isNaN(through) ? 'nothing' : iso(through)}`); break; }
  held.set(d, [oi, f, NaN]);
  if (Number.isNaN(from)) from = d;
  through = d; added++;
}
if (Number.isNaN(through)) { console.error('nothing to write: no funding was read and there is no previous file'); process.exit(1); }

// The alt share now stands for yesterday, when yesterday is in the file and has none.
const last = held.get(yesterday);
if (through === yesterday && last && !Number.isFinite(last[2])) {
  try {
    const { share, ranked, read } = await altNegShare();
    last[2] = share;
    console.log(`alt share: ${share.toFixed(2)}% negative, top ${ranked} of ${read} alts by open interest`);
  } catch (error) { console.warn(`alt share: ${message(error)}`); }
}

const days: [number, number | null, number | null, number | null][] = [];
for (let d = from; d <= through; d++) {
  const [oi, f, a] = held.get(d) ?? [NaN, NaN, NaN];
  days.push([d, round(oi, 3), round(f, 4), round(a, 2)]);
}
const file = { v: 1, source: SOURCE, builtAt: Date.now(), from, through, days };
if (!parsePositioning(JSON.parse(JSON.stringify(file)))) { console.error('built a file that does not parse'); process.exit(1); }
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out + '.tmp', JSON.stringify(file) + '\n');
fs.renameSync(out + '.tmp', out);
const count = (k: 1 | 2 | 3): number => days.filter(r => r[k] !== null).length;
console.log(`${out}: ${iso(from)} to ${iso(through)}, ${days.length} days (${added} new), open interest ${count(1)}, funding ${count(2)}, alt share ${count(3)}`);
