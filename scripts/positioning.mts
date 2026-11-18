// Builds positioning.json (the Positioning tab's archive): for each UTC day, Binance BTCUSDT open interest (contracts, the reading at
// the day's open, 00:00 UTC, as openInterestHist period=1d gives it), the 7-day annualised BTCUSDT funding, and the open-interest-weighted
// share of the top 50 Binance USDT-M alts (ex-BTC) whose last funding was negative. The page reads the file and adds what Binance
// still serves live.
//
//   npm run build:tools && node build/tools/scripts/positioning.mjs --out src/app/public/positioning.json
//   node build/tools/scripts/positioning.mjs --previous https://ali-ghandi.github.io/liquiditymapperfast/positioning.json \
//        --fallback src/app/public/positioning.json --out dist/positioning.json
//
// Sources. fapi.binance.com serves funding back to 2019 but open interest for only about a month, and may refuse some places (HTTP 451
// to US addresses, where GitHub's runners are). Binance's public archive, data.binance.vision, is readable from anywhere: open
// interest at 5-minute steps per day from 2020-09-01 (each day's file appears the next morning, UTC; its 23:55 reading is the next
// day's opening one, so yesterday's is there when the workflow runs) and funding per month (a month's file appears after it ends, so
// without fapi the file stops at the end of last month until then). Funding is read from fapi, and from the archive when fapi cannot be read; open interest from fapi for
// its month and from the archive before that (or when fapi cannot be read). The alt share is a live fapi reading only.
//
// --previous is the file in use (a file or an address) and --fallback stands in when it cannot be read: its days are kept, its days
// without open interest are looked up again, and the days after its last are added, up to yesterday (UTC). The file ends at the last
// day both funding and open interest reached, so a day that has not been published yet is never written empty; a day before that
// which a source lacks for good is null. The alt share is taken at build time (shortly after midnight UTC) and stored on yesterday,
// when yesterday is in the file and has none; without it (fapi refused) the day is still added, with null. Missing values are written
// as null (JSON has no NaN).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DAY_MS } from '../src/app/metrics/math.ts';
import { funding7dAnnualised, parsePositioning, type PositioningFile } from '../src/app/metrics/positioning.ts';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const FAPI = 'https://fapi.binance.com';
const ARCHIVE = 'https://data.binance.vision/data/futures/um';
const SOURCE = 'Binance USDT-M (fapi.binance.com, data.binance.vision): BTCUSDT open interest at each day\u2019s open (00:00 UTC) and 7-day funding; '
  + 'alt share = OI-weighted share of the top 50 alts by OI with negative last funding, read live just after the day ends and stored on that day '
  + '(approximates Coinalyze top-300)';
/** Before Binance's first BTCUSDT funding (2019-09-10). */
const FUNDING_START = Date.UTC(2019, 8, 1);
/** The archive's first day of BTCUSDT open interest. */
const OI_ARCHIVE_START = Date.UTC(2020, 8, 1);
/** The first day whose open interest the archive gives (from the reading at the end of the day before). */
const OI_FIRST_DAY = Math.floor(OI_ARCHIVE_START / DAY_MS) + 1;
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

/** Set once fapi refuses this place (451 or 403): later fapi calls fail at once. */
let fapiRefused = '';

/** A Binance public endpoint, retried with backoff (longer when Binance says to slow down). */
async function binance(pathAndQuery: string, attempts = 5): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    if (fapiRefused) throw new Error(`fapi refused (${fapiRefused})`);
    try {
      const response = await fetch(FAPI + pathAndQuery, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'liquidity-mapper-fast positioning' } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} for ${pathAndQuery}`);
        if (response.status === 451 || response.status === 403) {
          fapiRefused = `HTTP ${response.status}`;
          console.warn(`fapi.binance.com answers HTTP ${response.status} here: funding and open interest come from data.binance.vision, the alt share is skipped`);
        }
        if (response.status === 451 || response.status === 403 || response.status === 400) throw Object.assign(error, { final: true });
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

/** The text of the single file in a zip (stored or deflated), read through the central directory. */
function unzipOne(zip: Buffer): string {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const cd = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad zip directory');
  const method = zip.readUInt16LE(cd + 10), size = zip.readUInt32LE(cd + 20), local = zip.readUInt32LE(cd + 42);
  if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
  const data = zip.subarray(local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)).subarray(0, size);
  if (method === 0) return data.toString('utf8');
  if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error(`zip method ${method}`);
}

/** A data.binance.vision zip's text, or null when the file is not there (not published yet, or never). Retried otherwise. */
async function archive(pathname: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${ARCHIVE}/${pathname}`, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'liquidity-mapper-fast positioning' } });
      if (response.status === 404 || response.status === 403) return null; // S3 answers 403 or 404 for a missing key
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${pathname}`);
      return unzipOne(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!(); }
  }));
  return out;
}

/** BTCUSDT funding settlements from `start` to now from fapi, by time. */
async function fundingFromApi(start: number, at: Map<number, number>): Promise<void> {
  const now = Date.now();
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
}

/** BTCUSDT funding settlements from `start` from the archive's monthly files (the current month is not there yet). */
async function fundingFromArchive(start: number, at: Map<number, number>): Promise<void> {
  const months: string[] = [];
  const first = new Date(start), now = new Date();
  for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth()); m === 11 ? (y++, m = 0) : m++) {
    months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
  }
  const texts = await pool(months.map(month => () => archive(`monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-${month}.zip`)), 8);
  for (const text of texts) {
    for (const line of text?.split('\n') ?? []) {
      const [time, , rate] = line.split(',');
      const t = Number(time), r = Number(rate);
      if (line && Number.isFinite(t) && Number.isFinite(r) && t >= start) at.set(t, r);
    }
  }
}

/** BTCUSDT daily open interest (contracts) by UTC day of the bar from fapi, about the last month. */
async function oiFromApi(): Promise<Map<number, number>> {
  const body = await binance('/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=500');
  if (!Array.isArray(body)) throw new Error('unexpected open interest');
  const at = new Map<number, number>();
  for (const row of body as { timestamp?: unknown; sumOpenInterest?: unknown }[]) {
    const t = Number(row?.timestamp), c = Number(row?.sumOpenInterest);
    if (Number.isFinite(t) && Number.isFinite(c) && c >= 0) at.set(day(t), c);
  }
  return at;
}

/** The sum_open_interest of the archive row stamped `stamp` ('YYYY-MM-DD HH:MM:SS'; rows are not in time order), NaN without one. */
function oiAt(text: string, stamp: string): number {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${stamp},`)) continue;
    const c = Number(line.split(',')[2]);
    return Number.isFinite(c) && c >= 0 ? c : NaN;
  }
  return NaN;
}

/**
 * A day's open interest from the archive as openInterestHist period=1d gives it for the bar opening that day: the 5-minute reading
 * stamped 23:55 the day before (it matched fapi on 29 of 30 days checked; the other matched 00:00), else the day's 00:00 reading.
 * NaN when the files hold neither; null when neither file is there.
 */
async function oiFromArchive(d: number): Promise<number | null> {
  const before = await archive(`daily/metrics/BTCUSDT/BTCUSDT-metrics-${iso(d - 1)}.zip`);
  const close = before === null ? NaN : oiAt(before, `${iso(d - 1)} 23:55:00`);
  if (Number.isFinite(close)) return close;
  const own = await archive(`daily/metrics/BTCUSDT/BTCUSDT-metrics-${iso(d)}.zip`);
  if (own === null) return before === null ? null : NaN;
  return oiAt(own, `${iso(d)} 00:00:00`);
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
const firstNew = previous ? previous.through + 1 : day(FUNDING_START);

// Funding: the rates since six days before the first new day (its 7-day window), or from the start; from fapi, else the archive.
const fundingStart = Math.max(FUNDING_START, (firstNew - 6) * DAY_MS);
const rates = new Map<number, number>();
if (firstNew <= yesterday) {
  try { await fundingFromApi(fundingStart, rates); } catch (error) { console.warn(`funding from fapi: ${message(error)}`); }
  const lastRate = Math.max(-Infinity, ...rates.keys());
  if (lastRate < (yesterday + 1) * DAY_MS - 8 * 3_600_000) {
    console.log('funding from data.binance.vision (monthly files)');
    try { await fundingFromArchive(fundingStart, rates); } catch (error) { console.warn(`funding from the archive: ${message(error)}`); }
  }
}
const rateTimes = [...rates.keys()].sort((a, b) => a - b);
const newDays: number[] = [];
for (let d = firstNew; d <= yesterday; d++) newDays.push(d);
const funding = funding7dAnnualised(Float64Array.from(rateTimes), Float64Array.from(rateTimes, t => rates.get(t)!), Float64Array.from(newDays, d => d * DAY_MS));
const fundingByDay = new Map<number, number>();
newDays.forEach((d, i) => { if (Number.isFinite(funding[i]!)) fundingByDay.set(d, funding[i]!); });
/** The last day with a settlement of its own: later days are not published yet. */
const lastFundingDay = rateTimes.length ? day(rateTimes[rateTimes.length - 1]!) : -Infinity;

// Open interest: fapi's month, then the archive for every other day from its start that the file does not hold yet.
const oiByDay = new Map<number, number>();
try { for (const [d, oi] of await oiFromApi()) oiByDay.set(d, oi); } catch (error) { console.warn(`open interest from fapi: ${message(error)}`); }
const oiWanted: number[] = [];
for (let d = OI_FIRST_DAY; d <= yesterday; d++) if (!oiByDay.has(d) && !Number.isFinite(held.get(d)?.[0] ?? NaN)) oiWanted.push(d);
let archiveFiles = 0, archiveMissing = 0, archiveNoMidnight = 0;
if (oiWanted.length) {
  console.log(`open interest from data.binance.vision: ${oiWanted.length} days to look up (${iso(oiWanted[0]!)} to ${iso(oiWanted[oiWanted.length - 1]!)})`);
  const found = await pool(oiWanted.map(d => async () => { try { return await oiFromArchive(d); } catch (error) { console.warn(`${iso(d)} open interest: ${message(error)}`); return null; } }), 8);
  oiWanted.forEach((d, i) => {
    const v = found[i];
    if (v === null || v === undefined) archiveMissing++;
    else { archiveFiles++; if (Number.isFinite(v)) oiByDay.set(d, v); else archiveNoMidnight++; }
  });
  console.log(`  ${archiveFiles} files read (${archiveNoMidnight} days without a midnight reading), ${archiveMissing} not there`);
}
for (const [d, oi] of oiByDay) { const row = held.get(d); if (row) row[0] = oi; }
let lastOiDay = Math.max(-Infinity, ...oiByDay.keys());
for (const [d, [oi]] of held) if (Number.isFinite(oi) && d > lastOiDay) lastOiDay = d;

// New days run to the last day both funding and open interest reached (open interest only once it has begun).
let end = Math.min(yesterday, lastFundingDay);
if (Number.isFinite(lastOiDay)) end = Math.min(end, lastOiDay);
if (end < yesterday && firstNew <= yesterday) console.warn(`the file ends at ${iso(Math.max(end, previous?.through ?? -Infinity))}, not yesterday: ${lastFundingDay < yesterday ? `funding is published to ${Number.isFinite(lastFundingDay) ? iso(lastFundingDay) : `nothing after ${iso(day(fundingStart))}`} (the archive gives a month once it ends)` : ''}${lastOiDay < yesterday && lastFundingDay < yesterday ? ', ' : ''}${lastOiDay < yesterday ? `open interest to ${iso(lastOiDay)}` : ''}`);
let from = previous ? previous.from : NaN;
let through = previous ? previous.through : NaN;
let added = 0;
for (const d of newDays) {
  if (d > end) break;
  const f = fundingByDay.get(d) ?? NaN;
  if (Number.isNaN(from)) { if (!Number.isFinite(f)) continue; from = d; } // the file begins at the first funding
  held.set(d, [oiByDay.get(d) ?? NaN, f, NaN]);
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
  } catch (error) { console.warn(`alt share not read, ${iso(yesterday)} is written without it: ${message(error)}`); }
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
