// Builds put-flow.json: each UTC day's premium paid by aggressive (taker) buyers of Deribit BTC options, puts and calls apart, from
// Deribit's public trade history (history.deribit.com, which a browser cannot read: it sends no CORS header). The page reads the file and
// adds the last 24 hours from www.deribit.com, which it can read (when they cover the whole day after the file).
//
//   npm run build:tools && node build/tools/scripts/put-flow.mjs --from 2022-07-01 --out src/app/public/put-flow.json
//   node build/tools/scripts/put-flow.mjs --previous src/app/public/put-flow.json --out src/app/public/put-flow.json   (bring the copy up to date)
//   node build/tools/scripts/put-flow.mjs --previous https://ali-ghandi.github.io/liquiditymapperfast/put-flow.json \
//        --fallback src/app/public/put-flow.json --out dist/put-flow.json
//
// --previous is the file in use (a file or an address) and --fallback stands in when it cannot be read: only the days after its last are
// fetched. Days are fetched up to yesterday (UTC). A day that cannot be read after retries ends the file at the day before it, so the file
// never has a hole; with nothing new the previous file is written unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { DAY_MS, addTrade, parsePutFlow, readTrade, rowsOf, type FlowDay, type PutFlowFile } from '../src/app/metrics/putflow.ts';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const HOST = 'https://history.deribit.com/api/v2/public/get_last_trades_by_currency_and_time';
const SOURCE = 'Deribit BTC options, all trades (history.deribit.com), taker buys';

async function readFile(source: string | undefined): Promise<PutFlowFile | null> {
  if (!source) return null;
  try {
    const json: unknown = /^https?:/.test(source)
      ? await (await fetch(source, { signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' } })).json()
      : JSON.parse(fs.readFileSync(source, 'utf8'));
    const file = parsePutFlow(json);
    if (!file) console.warn(`${source} is not a put-flow file`);
    return file;
  } catch (error) { console.warn(`could not read ${source}: ${error instanceof Error ? error.message : String(error)}`); return null; }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function page(start: number, end: number): Promise<{ trades: unknown[]; hasMore: boolean }> {
  const url = `${HOST}?currency=BTC&kind=option&count=1000&sorting=asc&start_timestamp=${start}&end_timestamp=${end}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'liquidity-mapper-fast put flow' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { result?: { trades?: unknown; has_more?: unknown } };
      const trades = body.result?.trades;
      if (!Array.isArray(trades) || typeof body.result?.has_more !== 'boolean') throw new Error('unexpected body');
      return { trades, hasMore: body.result.has_more };
    } catch (error) {
      if (attempt >= 6) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/** One UTC day's sums, paging through the trades in time order. Trades at the page's last millisecond are read again and skipped by id. */
async function fetchDay(day: number): Promise<{ sums: FlowDay; read: number; stuck: number }> {
  const start = day * DAY_MS, end = start + DAY_MS - 1;
  const days = new Map<number, FlowDay>(), seen = new Set<string>();
  let cursor = start, read = 0, stuck = 0;
  for (;;) {
    const { trades, hasMore } = await page(cursor, end);
    let last = cursor, fresh = 0;
    for (const raw of trades) {
      const t = readTrade(raw);
      if (!t) throw new Error(`day ${new Date(start).toISOString().slice(0, 10)}: a trade without the fields the sum needs`);
      if (t.timestamp < start || t.timestamp > end || seen.has(t.trade_id)) continue;
      seen.add(t.trade_id); fresh++; read++;
      addTrade(days, t);
      last = Math.max(last, t.timestamp);
    }
    if (!hasMore || trades.length === 0) break;
    // A full page all at one millisecond (it has not happened in the history read so far) would never move on: step past it and count it.
    if (fresh === 0 || last === cursor) { stuck++; cursor = last + 1; } else cursor = last;
  }
  return { sums: days.get(day) ?? { day, put: 0, call: 0, n: 0 }, read, stuck };
}

const out = arg('out');
if (!out) { console.error('usage: put-flow --out <file> [--previous <file or URL>] [--fallback <file>] [--from YYYY-MM-DD] [--concurrency n]'); process.exit(2); }
const previous = await readFile(arg('previous')) ?? await readFile(arg('fallback'));
const fromArg = arg('from');
const yesterday = Math.floor(Date.now() / DAY_MS) - 1;
const first = previous ? previous.through + 1 : fromArg ? Math.floor(Date.parse(`${fromArg}T00:00:00Z`) / DAY_MS) : NaN;
if (!Number.isFinite(first)) { console.error('no previous file and no --from'); process.exit(2); }
const startDay = previous ? previous.from : first;
const held = new Map<number, FlowDay>();
for (const [day, put, call, n] of previous?.days ?? []) held.set(day, { day, put, call, n });
const concurrency = Math.max(1, Number(arg('concurrency') ?? 4));

let through = previous ? previous.through : first - 1;
const write = (): void => {
  const file: PutFlowFile = { v: 1, source: SOURCE, builtAt: Date.now(), from: startDay, through, days: rowsOf(held, startDay, through) };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out + '.tmp', JSON.stringify(file) + '\n');
  fs.renameSync(out + '.tmp', out);
};

const todo: number[] = [];
for (let d = first; d <= yesterday; d++) todo.push(d);
console.log(`${todo.length} days to read (${todo.length ? `${new Date(first * DAY_MS).toISOString().slice(0, 10)} to ${new Date(yesterday * DAY_MS).toISOString().slice(0, 10)}` : 'none'})`);
const done = new Map<number, FlowDay>();
let failedAt = Infinity, next = 0, totalRead = 0, totalStuck = 0, lastWrite = Date.now();
async function worker(): Promise<void> {
  while (next < todo.length) {
    const day = todo[next++]!;
    if (day > failedAt) return;
    try {
      const { sums, read, stuck } = await fetchDay(day);
      done.set(day, sums); totalRead += read; totalStuck += stuck;
    } catch (error) {
      console.warn(`${new Date(day * DAY_MS).toISOString().slice(0, 10)}: ${error instanceof Error ? error.message : String(error)}`);
      failedAt = Math.min(failedAt, day);
    }
    // The contiguous run of days read so far goes into the file.
    while (done.has(through + 1)) { const d = done.get(through + 1)!; held.set(d.day, d); done.delete(d.day); through++; }
    if (Date.now() - lastWrite > 30_000) {
      write(); lastWrite = Date.now();
      console.log(`through ${new Date(through * DAY_MS).toISOString().slice(0, 10)}, ${totalRead} trades read`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
write();
console.log(`${out}: ${new Date(startDay * DAY_MS).toISOString().slice(0, 10)} to ${new Date(through * DAY_MS).toISOString().slice(0, 10)}, ${totalRead} trades read this run${totalStuck ? `, ${totalStuck} pages stepped past (a full page at one millisecond)` : ''}${failedAt < Infinity ? ', stopped at a day that could not be read' : ''}`);
