/**
 * What the metric tabs read, from the visitor's browser: Binance candles (api.binance.com, falling back to data-api.binance.vision for spot;
 * fapi.binance.com for the perpetual), Deribit's DVOL, option marks and the last day or two of option trades (www.deribit.com), and the
 * put-flow history this site builds once a day (`put-flow.json`, from history.deribit.com, which sends no CORS header and so cannot be read
 * from a page). Every body is checked before it is used; what cannot be read is an error the tab shows, never a stand-in.
 */
import { DAY_MS, HOUR_MS, type OptionMark } from './math.ts';
import { addTrade, parsePutFlow, readTrade, type FlowDay, type PutFlowFile } from './putflow.ts';

export interface Series { time: Float64Array; close: Float64Array }

async function getJson(url: string, timeout = 20_000): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) throw new Error(`${new URL(url).host}: HTTP ${response.status}`);
      return await response.json();
    } catch (error) { last = error; await new Promise(r => setTimeout(r, 600 * (attempt + 1))); }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Run `jobs` with at most `limit` at a time, keeping their order. */
async function pool<T>(jobs: (() => Promise<T>)[], limit: number, progress?: (done: number, total: number) => void): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!(); done++; progress?.(done, jobs.length); }
  }));
  return out;
}

const KLINE_HOSTS = { spot: ['https://api.binance.com/api/v3/klines', 'https://data-api.binance.vision/api/v3/klines'], perp: ['https://fapi.binance.com/fapi/v1/klines'] } as const;

/** Binance closed and forming candles of BTCUSDT from `start` to now, in time order: open time and close. */
export async function binanceCloses(market: 'spot' | 'perp', interval: '1h' | '1d', start: number, progress?: (done: number, total: number) => void): Promise<Series> {
  const step = interval === '1h' ? HOUR_MS : DAY_MS, limit = market === 'spot' ? 1000 : 1500, now = Date.now();
  const starts: number[] = [];
  for (let s = Math.floor(start / step) * step; s <= now; s += step * limit) starts.push(s);
  let hosts: readonly string[] = KLINE_HOSTS[market];
  const page = async (s: number): Promise<unknown> => {
    let error: unknown;
    for (const host of hosts) {
      try { return await getJson(`${host}?symbol=BTCUSDT&interval=${interval}&limit=${limit}&startTime=${s}&endTime=${s + step * limit - 1}`); }
      catch (e) { error = e; if (hosts.length > 1 && host === hosts[0]) hosts = hosts.slice(1); }
    }
    throw error;
  };
  const pages = await pool(starts.map(s => () => page(s)), 4, progress);
  const time: number[] = [], close: number[] = [];
  for (const body of pages) {
    if (!Array.isArray(body)) throw new Error('Binance: unexpected candles');
    for (const row of body) {
      if (!Array.isArray(row)) continue;
      const t = Number(row[0]), c = Number(row[4]);
      if (Number.isFinite(t) && c > 0 && (!time.length || t > time[time.length - 1]!)) { time.push(t); close.push(c); }
    }
  }
  if (!time.length) throw new Error('Binance: no candles');
  return { time: Float64Array.from(time), close: Float64Array.from(close) };
}

/** Deribit's DVOL (BTC 30-day implied volatility index) hourly or daily from `start` to now: candle start time and close. */
export async function dvol(resolution: '3600' | '1D', start: number, progress?: (done: number, total: number) => void): Promise<Series> {
  const step = resolution === '3600' ? HOUR_MS : DAY_MS, span = step * 1000, now = Date.now();
  const ends: number[] = [];
  for (let e = now; e > start; e -= span) ends.push(e);
  const pages = await pool(ends.map(e => () => getJson(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=${resolution}&start_timestamp=${Math.max(start, e - span + 1)}&end_timestamp=${e}`)), 3, progress);
  const at = new Map<number, number>();
  for (const body of pages) {
    const data = (body as { result?: { data?: unknown } } | null)?.result?.data;
    if (!Array.isArray(data)) throw new Error('Deribit: unexpected DVOL');
    for (const row of data) if (Array.isArray(row) && Number.isFinite(row[0]) && Number(row[4]) > 0) at.set(Number(row[0]), Number(row[4]));
  }
  const keys = [...at.keys()].sort((a, b) => a - b);
  if (!keys.length) throw new Error('Deribit: no DVOL');
  return { time: Float64Array.from(keys), close: Float64Array.from(keys, k => at.get(k)!) };
}

/** Every BTC option's mark from Deribit's book summary. */
export async function optionMarks(): Promise<OptionMark[]> {
  const body = await getJson('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
  const rows = (body as { result?: unknown } | null)?.result;
  if (!Array.isArray(rows)) throw new Error('Deribit: unexpected book summary');
  const out: OptionMark[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (r && typeof r.instrument_name === 'string' && typeof r.mark_iv === 'number' && typeof r.underlying_price === 'number') out.push({ instrument_name: r.instrument_name, mark_iv: r.mark_iv, underlying_price: r.underlying_price });
  }
  return out;
}

/** The site's put-flow history (built daily by the Pages workflow), or null when it is missing or not readable. */
export async function putFlowHistory(): Promise<PutFlowFile | null> {
  try { return parsePutFlow(await getJson('put-flow.json', 15_000)); } catch { return null; }
}

/**
 * Taker-buy premium per UTC day from www.deribit.com's recent trades (it holds about the last day and a half), from `since` to now. Also
 * says from when the trades it gave begin, so the caller knows which days are whole.
 */
export async function recentPutFlow(since: number): Promise<{ days: Map<number, FlowDay>; firstTrade: number; read: number }> {
  const days = new Map<number, FlowDay>(), seen = new Set<string>();
  let cursor = since, firstTrade = Infinity, read = 0;
  const end = Date.now();
  for (let pages = 0; pages < 200; pages++) {
    const body = await getJson(`https://www.deribit.com/api/v2/public/get_last_trades_by_currency_and_time?currency=BTC&kind=option&count=1000&sorting=asc&start_timestamp=${cursor}&end_timestamp=${end}`);
    const result = (body as { result?: { trades?: unknown; has_more?: unknown } } | null)?.result;
    if (!result || !Array.isArray(result.trades)) throw new Error('Deribit: unexpected trades');
    let last = cursor, fresh = 0;
    for (const raw of result.trades) {
      const tr = readTrade(raw);
      if (!tr || seen.has(tr.trade_id)) continue;
      seen.add(tr.trade_id); fresh++; read++;
      firstTrade = Math.min(firstTrade, tr.timestamp);
      addTrade(days, tr);
      last = Math.max(last, tr.timestamp);
    }
    if (result.has_more !== true || result.trades.length === 0) break;
    cursor = fresh === 0 || last === cursor ? last + 1 : last;
  }
  return { days, firstTrade, read };
}
