/**
 * Put flow: the share of the premium paid by aggressive buyers (the taker side of a Deribit BTC option trade marked `direction: "buy"`)
 * that went to puts, over a trailing window. Pure: the build script (`scripts/put-flow.mts`) and the page share it.
 *
 * A trade's premium in dollars is its price (in BTC per contract) times its amount (contracts of 1 BTC) times the index price at the trade.
 * Every trade counts, block trades included. Days are UTC days.
 */

export const DAY_MS = 86_400_000;

/** One UTC day of taker-buy premium: put and call dollars and the number of taker-buy trades. */
export interface FlowDay { day: number; put: number; call: number; n: number }

/** The file the build publishes (`put-flow.json`). `days` rows are `[UTC day number, put USD, call USD, taker-buy trades]`. */
export interface PutFlowFile {
  v: 1;
  source: string;
  builtAt: number;
  /** First and last UTC day number held (a day number is ms / 86,400,000). Every day between is a row, even an empty one. */
  from: number;
  through: number;
  days: [number, number, number, number][];
}

/** The fields of a Deribit trade the sum reads; anything else in the frame is ignored. */
export interface OptionTrade { trade_id: string; timestamp: number; instrument_name: string; direction: string; price: number; amount: number; index_price: number }

/** A Deribit option trade from an untyped body, or null when a field the sum needs is missing or is not a finite number. */
export function readTrade(raw: unknown): OptionTrade | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { trade_id, timestamp, instrument_name, direction, price, amount, index_price } = r;
  if (typeof trade_id !== 'string' || typeof instrument_name !== 'string' || typeof direction !== 'string') return null;
  for (const v of [timestamp, price, amount, index_price]) if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return { trade_id, timestamp: timestamp as number, instrument_name, direction, price: price as number, amount: amount as number, index_price: index_price as number };
}

/** 'P', 'C' or null for an instrument name like BTC-27NOV26-60000-P. */
export function optionKind(name: string): 'P' | 'C' | null {
  const last = name.slice(name.lastIndexOf('-') + 1);
  return last === 'P' || last === 'C' ? last : null;
}

/** The premium in dollars of one trade. */
export const premiumUsd = (t: Pick<OptionTrade, 'price' | 'amount' | 'index_price'>): number => t.price * t.amount * t.index_price;

/** Add a trade to its UTC day in `days` (by day number). Only taker buys count; a trade that is not a put or call is skipped. */
export function addTrade(days: Map<number, FlowDay>, t: OptionTrade): void {
  if (t.direction !== 'buy') return;
  const kind = optionKind(t.instrument_name);
  if (!kind) return;
  const day = Math.floor(t.timestamp / DAY_MS);
  let d = days.get(day);
  if (!d) { d = { day, put: 0, call: 0, n: 0 }; days.set(day, d); }
  const usd = premiumUsd(t);
  if (kind === 'P') d.put += usd; else d.call += usd;
  d.n += 1;
}

/** The file's days as `FlowDay`s, or null when the body is not a put-flow file. */
export function parsePutFlow(raw: unknown): PutFlowFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !Array.isArray(r.days) || typeof r.from !== 'number' || typeof r.through !== 'number') return null;
  const days: [number, number, number, number][] = [];
  for (const row of r.days) {
    if (!Array.isArray(row) || row.length !== 4 || !row.every(x => typeof x === 'number' && Number.isFinite(x))) return null;
    days.push([row[0], row[1], row[2], row[3]] as [number, number, number, number]);
  }
  for (let i = 1; i < days.length; i++) if (days[i]![0] !== days[i - 1]![0] + 1) return null;
  if (days.length && (days[0]![0] !== r.from || days[days.length - 1]![0] !== r.through)) return null;
  return { v: 1, source: typeof r.source === 'string' ? r.source : '', builtAt: typeof r.builtAt === 'number' ? r.builtAt : 0, from: r.from, through: r.through, days };
}

/** Rows for the days `from`..`through` from `days` (missing days are zero rows: a day with no taker buys). */
export function rowsOf(days: ReadonlyMap<number, FlowDay>, from: number, through: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let d = from; d <= through; d++) {
    const x = days.get(d);
    out.push([d, x ? Math.round(x.put) : 0, x ? Math.round(x.call) : 0, x ? x.n : 0]);
  }
  return out;
}

/**
 * The trailing share of taker-buy premium that went to puts, one value per day: for day i, the sum of put dollars over days i-window+1..i
 * divided by the sum of put and call dollars over the same days, as a percentage. NaN until a full window is held, or when nothing was bought.
 */
export function trailingPutShare(put: ArrayLike<number>, call: ArrayLike<number>, window = 7): Float64Array {
  const n = put.length, out = new Float64Array(n).fill(NaN);
  let p = 0, c = 0;
  for (let i = 0; i < n; i++) {
    p += put[i]!; c += call[i]!;
    if (i >= window) { p -= put[i - window]!; c -= call[i - window]!; }
    if (i >= window - 1 && p + c > 0) out[i] = (100 * p) / (p + c);
  }
  return out;
}
