// Builds positioning.json (the Positioning tab's archive): for each UTC day, Binance BTCUSDT open interest (contracts, at the day's
// open, as openInterestHist period=1d gives it: the 23:55 UTC reading of the day before), the 7-day annualised BTCUSDT funding, and the
// share of USD open interest (contracts × mark price) among the top 50 Binance USDT-M alts (ex-BTC, by USD open interest) whose last
// funding was negative. The page reads the file and adds what Binance
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
// its month and from the archive before that (or when fapi cannot be read). The alt share is read from the archive too (below).
//
// The alt share (ALT_ARCHIVE_DEF). For each day from 2021-12-01 (the archive's first alt metrics), every USDT-M symbol with a daily
// metrics file that day (listed from the archive's bucket) gives its USD open interest at the day's close, and its monthly fundingRate
// file its last funding settled that day; the share is altNegShareFromArchive over the top 50 by USD open interest, BTCUSDT and the
// equity perpetuals left out (their list, altExclude, comes from fapi's exchangeInfo when fapi can be read, else from the previous file).
// Funding is published a month at a time, after the month ends, so the alt share runs to the end of last month; each run reads the days
// after the last stored share in published months, at most --alt-months months (default 2) and stops starting new ones after
// --alt-minutes (default 12). A day whose symbols were not 80 % read is null and is not read again. The first run (no stored share)
// backfills from 2021-12-01: run it once with --alt-months 99 where there is time (about 45 minutes, 600,000 files).
//
// --previous is the file in use (a file or an address) and --fallback stands in when it cannot be read: its days are kept, its days
// without open interest are looked up again, and the days after its last are added, up to yesterday (UTC). The file ends at the last
// day both funding and open interest reached, so a day that has not been published yet is never written empty, and before the first
// new day whose funding or open interest could not be read (an error after retries); a day before that which a source lacks for good
// (no reading in the archive, e.g. 2021-02-20, or only zero placeholders) is null. A stored open interest of 0 or less is looked up again. Missing values are written
// as null (JSON has no NaN).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DAY_MS } from '../src/app/metrics/math.ts';
import { ALT_ARCHIVE_DEF, altArchiveDaysWanted, altNegShareFromArchive, dailyOiFromMetrics, funding7dAnnualised, lastFundingBefore, metricsUsdOiAtClose, nonCryptoUsdtPerps, parsePositioning, type PositioningFile } from '../src/app/metrics/positioning.ts';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const FAPI = 'https://fapi.binance.com';
const ARCHIVE = 'https://data.binance.vision/data/futures/um';
const SOURCE = 'Binance USDT-M (fapi.binance.com, data.binance.vision): BTCUSDT open interest at each day\u2019s open (the 23:55 UTC reading before it) and 7-day funding; '
  + 'alt share = share of USD open interest among the top 50 USDT-M alts by USD open interest (equity perpetuals left out) whose last funding settled that day was negative, from data.binance.vision daily metrics (USD open interest at the day close) and monthly funding files, so it runs to the end of last month '
  + '(approximates Coinalyze top-300)';
/** Before Binance's first BTCUSDT funding (2019-09-10). */
const FUNDING_START = Date.UTC(2019, 8, 1);
/** The archive's first day of BTCUSDT open interest. */
const OI_ARCHIVE_START = Date.UTC(2020, 8, 1);
/** The first day whose open interest the archive gives (from the reading at the end of the day before). */
const OI_FIRST_DAY = Math.floor(OI_ARCHIVE_START / DAY_MS) + 1;
const TOP_ALTS = 50;
/** The archive's first day of alt metrics (daily metrics files for symbols other than BTCUSDT begin 2021-12-01). */
const ALT_START = Math.floor(Date.UTC(2021, 11, 1) / DAY_MS);
const BUCKET = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
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
          console.warn(`fapi.binance.com answers HTTP ${response.status} here (${response.status === 451 ? 'a refused place' : 'a refused place or a WAF limit'}): funding and open interest come from data.binance.vision, the alt share is skipped`);
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

/**
 * BTCUSDT funding settlements from `start` from the archive's monthly files (the current month is not there yet). Returns the start
 * (ms) of the first month that could not be read (an error after retries, not a missing file), or Infinity.
 */
async function fundingFromArchive(start: number, at: Map<number, number>): Promise<number> {
  const months: { name: string; start: number }[] = [];
  const first = new Date(start), now = new Date();
  for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth()); m === 11 ? (y++, m = 0) : m++) {
    months.push({ name: `${y}-${String(m + 1).padStart(2, '0')}`, start: Date.UTC(y, m, 1) });
  }
  let failed = Infinity;
  const texts = await pool(months.map(month => async () => {
    try { return await archive(`monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-${month.name}.zip`); } catch (error) {
      console.warn(`funding for ${month.name} from the archive: ${message(error)}`);
      failed = Math.min(failed, month.start);
      return null;
    }
  }), 8);
  for (const text of texts) {
    for (const line of text?.split('\n') ?? []) {
      const [time, , rate] = line.split(',');
      const t = Number(time), r = Number(rate);
      if (line && Number.isFinite(t) && Number.isFinite(r) && t >= start) at.set(t, r);
    }
  }
  return failed;
}

/** BTCUSDT daily open interest (contracts) by UTC day of the bar from fapi, about the last month. */
async function oiFromApi(): Promise<Map<number, number>> {
  const body = await binance('/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=500');
  if (!Array.isArray(body)) throw new Error('unexpected open interest');
  const at = new Map<number, number>();
  for (const row of body as { timestamp?: unknown; sumOpenInterest?: unknown }[]) {
    const t = Number(row?.timestamp), c = Number(row?.sumOpenInterest);
    if (Number.isFinite(t) && Number.isFinite(c) && c > 0) at.set(day(t), c);
  }
  return at;
}

/**
 * A day's open interest from the archive (`dailyOiFromMetrics`: the 23:55 reading of the day before, as openInterestHist period=1d
 * gives it, else the day's 00:00; zero placeholders are no reading). NaN when the files there hold no reading, null when neither file
 * is there; an error (after retries) is thrown.
 */
async function oiFromArchive(d: number): Promise<number | null> {
  const before = await archive(`daily/metrics/BTCUSDT/BTCUSDT-metrics-${iso(d - 1)}.zip`);
  const close = dailyOiFromMetrics(before, null, d);
  if (close !== null && Number.isFinite(close)) return close;
  return dailyOiFromMetrics(before, await archive(`daily/metrics/BTCUSDT/BTCUSDT-metrics-${iso(d)}.zip`), d);
}

/** The keys under a prefix of the archive's bucket (S3 list, 1,000 a page). */
async function listKeys(prefix: string, delimiter = false): Promise<string[]> {
  const out: string[] = [];
  let marker = '';
  for (;;) {
    let text = '';
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${BUCKET}?prefix=${encodeURIComponent(prefix)}${delimiter ? '&delimiter=/' : ''}&max-keys=1000${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status} listing ${prefix}`);
        text = await response.text();
        break;
      } catch (error) { if (attempt >= 4) throw error; await sleep(1000 * 2 ** attempt); }
    }
    const keys = [...text.matchAll(delimiter ? /<Prefix>([^<]+)<\/Prefix>/g : /<Key>([^<]+)<\/Key>/g)].map(m => m[1]!).filter(k => k !== prefix);
    out.push(...keys);
    if (!text.includes('<IsTruncated>true</IsTruncated>') || !keys.length) return out;
    marker = text.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1] ?? keys[keys.length - 1]!;
  }
}

/** The days (UTC day numbers) of each USDT symbol's daily metrics files from `fromDay`, BTCUSDT apart. */
async function metricsDays(fromDay: number, toDay: number): Promise<Map<string, Set<number>>> {
  const symbols = (await listKeys('data/futures/um/daily/metrics/', true)).map(p => p.split('/')[5]!).filter(s => s.endsWith('USDT') && s !== 'BTCUSDT');
  const out = new Map<string, Set<number>>();
  const fromMonth = iso(fromDay).slice(0, 7);
  await pool(symbols.map(symbol => async () => {
    const keys = await listKeys(`data/futures/um/daily/metrics/${symbol}/`);
    const days = new Set<number>();
    for (const key of keys) {
      const m = key.match(/-(\d{4}-\d{2}-\d{2})\.zip$/);
      if (!m || m[1]!.slice(0, 7) < fromMonth) continue;
      const d = day(Date.parse(m[1]!));
      if (d >= fromDay && d <= toDay) days.add(d);
    }
    if (days.size) out.set(symbol, days);
  }), 32);
  return out;
}

/**
 * The alt share (ALT_ARCHIVE_DEF) for `wanted` days, month by month, into `held`: at most `months` months, none started after
 * `budgetMs`. A month where no day could be read (its funding not published yet) ends the run. Returns the days given a share.
 */
async function altFromArchive(wanted: number[], exclude: ReadonlySet<string>, months: number, budgetMs: number): Promise<number> {
  const byMonth = new Map<string, number[]>();
  for (const d of wanted) { const m = iso(d).slice(0, 7); byMonth.set(m, [...(byMonth.get(m) ?? []), d]); }
  const chosen = [...byMonth.keys()].slice(0, Math.max(0, months));
  if (!chosen.length) return 0;
  const startedAt = Date.now();
  const files = await metricsDays(byMonth.get(chosen[0]!)![0]!, byMonth.get(chosen[chosen.length - 1]!)!.at(-1)!);
  console.log(`alt share from data.binance.vision: ${chosen.length} months (${chosen[0]} to ${chosen[chosen.length - 1]}), ${files.size} USDT symbols listed, ${exclude.size} left out`);
  let stored = 0;
  for (const month of chosen) {
    if (Date.now() - startedAt > budgetMs) { console.warn(`alt share: time budget spent, ${month} and later are left for the next run`); break; }
    const days = byMonth.get(month)!;
    const symbols = [...files].filter(([symbol, ds]) => !exclude.has(symbol) && days.some(d => ds.has(d))).map(([symbol]) => symbol);
    // Each symbol's funding for the month (none, or unreadable: its days are unread for it).
    const funding = new Map<string, string | null>();
    let fundingFiles = 0;
    await pool(symbols.map(symbol => async () => {
      try { const text = await archive(`monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`); funding.set(symbol, text); if (text) fundingFiles++; } catch { funding.set(symbol, null); }
    }), 64);
    // Every (symbol, day) metrics file of the month at once, 128 at a time.
    let monthStored = 0, failed = 0;
    const jobs: { symbol: string; d: number }[] = [];
    for (const d of days) for (const symbol of symbols) if (files.get(symbol)!.has(d)) jobs.push({ symbol, d });
    const rows = await pool(jobs.map(({ symbol, d }) => async () => {
      let usd: number;
      // A file that could not be read (after retries) counts as a candidate that was not read.
      try { const text = await archive(`daily/metrics/${symbol}/${symbol}-metrics-${iso(d)}.zip`); usd = text === null ? NaN : metricsUsdOiAtClose(text, d); } catch { failed++; return { d, symbol, usd: 1, rate: NaN }; }
      const text = funding.get(symbol);
      return { d, symbol, usd, rate: text ? lastFundingBefore(text, (d + 1) * DAY_MS) : NaN };
    }), 128);
    for (const d of days) {
      const share = altNegShareFromArchive(rows.filter(r => r.d === d), exclude, TOP_ALTS);
      const row = held.get(d);
      if (row && share !== null) { row[2] = share; monthStored++; }
    }
    stored += monthStored;
    console.log(`  ${month}: ${monthStored} of ${days.length} days, ${symbols.length} symbols, ${fundingFiles} funding files${failed ? `, ${failed} metrics files failed` : ''}`);
    if (!monthStored) { console.warn(`alt share: nothing read for ${month} (funding not published yet?), later months wait`); break; }
  }
  return stored;
}

const round = (v: number, places: number): number | null => Number.isFinite(v) ? Math.round(v * 10 ** places) / 10 ** places : null;

const out = arg('out');
if (!out) { console.error('usage: positioning --out <file> [--previous <file or URL>] [--fallback <file>]'); process.exit(2); }
const fallbackFile = await readFile(arg('fallback'));
const previous = await readFile(arg('previous')) ?? fallbackFile;
const yesterday = day(Date.now()) - 1;

/** Rows by day: [oi, funding7d, altNeg], NaN when missing. */
const held = new Map<number, [number, number, number]>();
// A non-positive open interest is no reading (the archive's 0E-8 placeholders, once stored as 0): it is looked up again.
// An alt share stored another way (the old live reading) is dropped, to be read again from the archive.
const altKept = previous?.altDef === ALT_ARCHIVE_DEF;
if (previous && !altKept) console.log('stored alt shares are not from the archive: they are read again');
for (const [d, oi, f, a] of previous?.days ?? []) held.set(d, [oi > 0 ? oi : NaN, f, altKept ? a : NaN]);
// The repository's copy may hold archive shares the published file lacks (a backfill seeded from a place fapi does not refuse): they
// fill its days without one.
if (fallbackFile && fallbackFile !== previous && fallbackFile.altDef === ALT_ARCHIVE_DEF) {
  let filled = 0;
  for (const [d, , , a] of fallbackFile.days) { const row = held.get(d); if (row && !Number.isFinite(row[2]) && Number.isFinite(a)) { row[2] = a; filled++; } }
  if (filled) console.log(`alt share: ${filled} days taken from the repository's copy`);
}
const firstNew = previous ? previous.through + 1 : day(FUNDING_START);

// Funding: the rates since six days before the first new day (its 7-day window), or from the start; from fapi, else the archive.
const fundingStart = Math.max(FUNDING_START, (firstNew - 6) * DAY_MS);
const rates = new Map<number, number>();
let fundingFailedDay = Infinity;
if (firstNew <= yesterday) {
  try { await fundingFromApi(fundingStart, rates); } catch (error) { console.warn(`funding from fapi: ${message(error)}`); }
  const lastRate = Math.max(-Infinity, ...rates.keys());
  if (lastRate < (yesterday + 1) * DAY_MS - 8 * 3_600_000) {
    console.log('funding from data.binance.vision (monthly files)');
    const failed = await fundingFromArchive(fundingStart, rates);
    // A month that could not be read (and that fapi did not cover) ends the new days before it: its days would be wrong, not missing.
    if (failed < Infinity && ![...rates.keys()].some(t => t >= failed && t < failed + 31 * DAY_MS)) fundingFailedDay = day(failed);
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
// Three outcomes per day: a reading; no reading (the file is there but holds none, or the day has no file while a later day has one) —
// the archive lacks it for good, so it is null and does not stop the file; and a failure (an error after retries) — the new days stop
// before it, so the file never has a hole that a later run would have filled.
let archiveRead = 0, archiveNoReading = 0, archiveNoFile = 0;
const oiFailed: number[] = [];
if (oiWanted.length) {
  console.log(`open interest from data.binance.vision: ${oiWanted.length} days to look up (${iso(oiWanted[0]!)} to ${iso(oiWanted[oiWanted.length - 1]!)})`);
  const found = await pool(oiWanted.map(d => async () => {
    try { return await oiFromArchive(d); } catch (error) { console.warn(`${iso(d)} open interest: ${message(error)}`); oiFailed.push(d); return undefined; }
  }), 8);
  oiWanted.forEach((d, i) => {
    const v = found[i];
    if (v === undefined) return;
    if (v === null) archiveNoFile++;
    else if (Number.isFinite(v)) { archiveRead++; oiByDay.set(d, v); } else archiveNoReading++;
  });
  console.log(`  ${archiveRead} days read, ${archiveNoReading} without a reading, ${archiveNoFile} without a file, ${oiFailed.length} failed`);
}
for (const [d, oi] of oiByDay) { const row = held.get(d); if (row) row[0] = oi; }
let lastOiDay = Math.max(-Infinity, ...oiByDay.keys());
for (const [d, [oi]] of held) if (Number.isFinite(oi) && d > lastOiDay) lastOiDay = d;

// New days run to the last day both funding and open interest reached (open interest only once it has begun; a day after the last
// reading has not been published yet), and stop before the first day whose funding or open interest could not be read.
let end = Math.min(yesterday, lastFundingDay, fundingFailedDay - 1);
if (Number.isFinite(lastOiDay)) end = Math.min(end, lastOiDay);
const firstOiFailed = Math.min(Infinity, ...oiFailed.filter(d => d >= firstNew));
end = Math.min(end, firstOiFailed - 1);
if (end < yesterday && firstNew <= yesterday) {
  const why: string[] = [];
  if (fundingFailedDay <= yesterday) why.push(`funding for the month from ${iso(fundingFailedDay)} could not be read`);
  if (lastFundingDay < yesterday) why.push(`funding is published to ${Number.isFinite(lastFundingDay) ? iso(lastFundingDay) : `nothing after ${iso(day(fundingStart))}`} (the archive gives a month once it ends)`);
  if (lastOiDay < yesterday) why.push(`open interest is published to ${iso(lastOiDay)}`);
  if (firstOiFailed <= yesterday) why.push(`open interest for ${iso(firstOiFailed)} could not be read`);
  console.warn(`the file ends at ${iso(Math.max(end, previous?.through ?? -Infinity))}, not yesterday: ${why.join('; ')}`);
}
let from = previous ? previous.from : NaN;
let through = previous ? previous.through : NaN;
let added = 0;
for (const d of newDays) {
  if (d > end) break;
  const f = fundingByDay.get(d) ?? NaN;
  if (Number.isNaN(from)) { if (!Number.isFinite(f)) continue; from = d; } // the file begins at the first funding
  else if (!Number.isFinite(f)) { console.warn(`${iso(d)}: no funding in its 7 days, the file ends at ${iso(through)}`); break; }
  held.set(d, [oiByDay.get(d) ?? NaN, f, NaN]);
  through = d; added++;
}
if (Number.isNaN(through)) { console.error('nothing to write: no funding was read and there is no previous file'); process.exit(1); }

// The alt share from the archive: the equity perpetuals to leave out (fapi's exchangeInfo when it can be read, with the stored list),
// then the days after the last stored share in months whose funding is published.
const exclude = new Set([...(previous?.altExclude ?? []), ...(fallbackFile?.altExclude ?? [])]);
try { for (const symbol of nonCryptoUsdtPerps(await binance('/fapi/v1/exchangeInfo'))) exclude.add(symbol); } catch (error) {
  console.warn(`exchangeInfo: ${message(error)}; the stored list of ${exclude.size} equity perpetuals is used`);
}
const altMonths = Number(arg('alt-months') ?? 2), altMinutes = Number(arg('alt-minutes') ?? 12);
const rowsNow: [number, number, number, number][] = [];
for (let d = from; d <= through; d++) { const r = held.get(d); if (r) rowsNow.push([d, r[0], r[1], r[2]]); }
const altWanted = altArchiveDaysWanted(rowsNow, ALT_START, Date.now());
if (!exclude.size) console.warn('alt share not read: no list of equity perpetuals to leave out (fapi was refused and no file holds one)');
else if (altWanted.length) {
  try { await altFromArchive(altWanted, exclude, altMonths, altMinutes * 60_000); } catch (error) { console.warn(`alt share from the archive: ${message(error)}`); }
}

const days: [number, number | null, number | null, number | null][] = [];
for (let d = from; d <= through; d++) {
  const [oi, f, a] = held.get(d) ?? [NaN, NaN, NaN];
  days.push([d, round(oi, 3), round(f, 4), round(a, 2)]);
}
const file = { v: 1, source: SOURCE, builtAt: Date.now(), from, through, days, altDef: ALT_ARCHIVE_DEF, altExclude: [...exclude].sort() };
if (!parsePositioning(JSON.parse(JSON.stringify(file)))) { console.error('built a file that does not parse'); process.exit(1); }
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out + '.tmp', JSON.stringify(file) + '\n');
fs.renameSync(out + '.tmp', out);
const count = (k: 1 | 2 | 3): number => days.filter(r => r[k] !== null).length;
console.log(`${out}: ${iso(from)} to ${iso(through)}, ${days.length} days (${added} new), open interest ${count(1)}, funding ${count(2)}, alt share ${count(3)}`);
