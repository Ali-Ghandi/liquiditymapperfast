/**
 * The metric tabs' content (loaded only when a metric tab is first opened): five charts after @CavanXy's options and volatility post,
 * each made in the browser from public data, except the put-flow history, which the site's daily build makes (`scripts/put-flow.mts`).
 */
import { t } from '../i18n.ts';
import { PALETTES, mixHex, resolveThemeId } from '../theme.ts';
import { Chart, type ChartSpec, type Colours } from './plot.ts';
import { DAY_MS, HOUR_MS, alignTo, asOfClosedDay, ema, expiryReadings, flaggedRuns, pctFromEma, realisedVol, termShape, type ExpiryReading } from './math.ts';
import { binanceCloses, dvol, optionMarks, putFlowHistory, recentPutFlow, type Series } from './data.ts';
import { trailingPutShare, type FlowDay } from './putflow.ts';
import { RANGES, rangeLabel, rangeStart, type MetricPrefs, type RangedTab } from './settings.ts';
import { dateLabel, dayLabel, hourLabel } from './ticks.ts';

/** Thresholds of the source charts. */
export const GAP_FLAG = 10;
export const SKEW_FLAG = 20;
export const PUT_SHARE_FLAG = 68;
export const EMA_FLAG = -10;
const STALE_MS = 5 * 60_000;

type Tab = 'vol' | 'gap' | 'term' | 'puts' | 'ema';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '–');
const f0 = (v: number): string => (Number.isFinite(v) ? v.toFixed(0) : '–');
/** An axis label with a decimal only where the ticks are closer than 1 apart. */
const axis = (v: number, step: number): string => v.toFixed(step < 1 ? 1 : 0);
const signed = (v: number, d = 1): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}` : '–');
const kUsd = (v: number): string => (v >= 1000 ? `${+(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : v.toFixed(0));
const musd = (v: number): string => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : `$${(v / 1e6).toFixed(1)}M`);

/** Only candles that have closed: a candle still under way is not a close. */
function closed(s: Series, step: number, now = Date.now()): Series {
  let n = s.time.length;
  while (n > 0 && s.time[n - 1]! + step > now) n--;
  return { time: s.time.slice(0, n), close: s.close.slice(0, n) };
}

/** A cache of one loaded series that covers back to `start`, read again after five minutes. */
class Cached<T> {
  #value: { start: number; at: number; data: T } | null = null;
  #pending: Promise<T> | null = null;
  #pendingStart = Infinity;
  constructor(private load: (start: number) => Promise<T>) {}
  get(start: number, force = false): Promise<T> {
    const v = this.#value;
    if (!force && v && v.start <= start && Date.now() - v.at < STALE_MS) return Promise.resolve(v.data);
    if (this.#pending && this.#pendingStart <= start) return this.#pending;
    const from = Math.min(start, v?.start ?? Infinity);
    this.#pendingStart = from;
    this.#pending = this.load(from).then(data => { this.#value = { start: from, at: Date.now(), data }; return data; }).finally(() => { this.#pending = null; this.#pendingStart = Infinity; });
    return this.#pending;
  }
}

let progressNote: (text: string) => void = () => {};
const progress = (what: string) => (done: number, total: number): void => progressNote(t('Loading {what} {done}/{total}…', { what, done, total }));

const hourly = new Cached(async start => closed(await binanceCloses('spot', '1h', start, progress(t('Binance hourly candles'))), HOUR_MS));
const dvolHourly = new Cached(async start => dvol('3600', start, progress(t('Deribit DVOL'))));
const dailyPerp = new Cached(async start => closed(await binanceCloses('perp', '1d', start), DAY_MS));
/** Daily perpetual closes are read from the start of the perpetual whatever the range, so the 21-day EMA is settled where the chart begins. */
const PERP_START = Date.UTC(2019, 8, 8);

interface VolData { time: Float64Array; rv: Float64Array; iv: Float64Array }
async function volData(start: number): Promise<VolData> {
  const from = start - 8 * DAY_MS;
  const [h, d] = await Promise.all([hourly.get(from), dvolHourly.get(from)]);
  const rv = realisedVol(h.close, 168);
  // DVOL's candle at an hour and Binance's candle at the same hour both close at the end of that hour.
  return { time: h.time, rv, iv: alignTo(h.time, d.time, d.close) };
}

export interface MetricsHost { prefs: () => MetricPrefs; setRange: (tab: RangedTab, key: string) => void; theme: () => string }

export class MetricsView {
  readonly root = el('div', 'mx-content');
  #head = el('div', 'mx-head');
  #title = el('div', 'mx-title');
  #ranges = el('div', 'mx-ranges');
  #refresh = el('button', 'mx-refresh', '↻');
  #status = el('div', 'mx-status');
  #body = el('div', 'mx-body');
  #foot = el('div', 'mx-foot');
  #charts: Chart[] = [];
  #tab: Tab | null = null;
  #seq = 0;
  #timer = 0;

  constructor(private host: MetricsHost) {
    this.#refresh.type = 'button';
    this.#refresh.title = t('Read the data again');
    this.#refresh.setAttribute('aria-label', t('Read the data again'));
    this.#refresh.onclick = () => { if (this.#tab) void this.#render(this.#tab, true); };
    this.#head.append(this.#title, this.#ranges, this.#refresh);
    this.root.append(this.#head, this.#status, this.#body, this.#foot);
    progressNote = text => { this.#status.textContent = text; this.#status.hidden = false; };
  }

  show(tab: Tab): void {
    this.#tab = tab;
    void this.#render(tab, false);
    clearInterval(this.#timer);
    // While a tab shows, its live data is read again every five minutes (the term structure every two).
    this.#timer = window.setInterval(() => { if (this.#tab && document.visibilityState === 'visible') void this.#render(this.#tab, true, true); }, tab === 'term' ? 120_000 : STALE_MS);
  }

  hide(): void { this.#tab = null; clearInterval(this.#timer); this.#seq++; }

  /** Redraw with the theme's colours (the theme changed). */
  recolour(): void { if (this.#tab) void this.#render(this.#tab, false, true); }

  #colours(): Colours & { series: string; series2: string; purple: string; soft: string; flagBar: string; bar: string; barSoft: string; accentSoft: string } {
    const p = PALETTES[resolveThemeId(this.host.theme())]!;
    return { bg: p.bg, text: p.text, muted: p.muted, line: p.line, flag: p.ask, flagSoft: mixHex(p.bg, p.ask, 0.2), series: p.bid, series2: p.text, purple: p.poc,
      soft: mixHex(p.bg, p.muted, 0.16), flagBar: p.ask, bar: mixHex(p.bg, p.muted, 0.55), barSoft: mixHex(p.bg, p.muted, 0.28), accentSoft: mixHex(p.bg, p.accent, 0.18) };
  }

  #setRanges(tab: Tab): void {
    this.#ranges.replaceChildren();
    if (tab === 'term') return;
    const chosen = this.host.prefs().ranges[tab];
    for (const key of RANGES[tab]) {
      const b = el('button', key === chosen ? 'on' : '', rangeLabel(tab, key));
      b.type = 'button';
      b.onclick = () => { this.host.setRange(tab, key); void this.#render(tab, false); };
      this.#ranges.append(b);
    }
  }

  /** The charts the tab needs, reusing those already made. */
  #layout(count: number, cls: string): Chart[] {
    const c = this.#colours();
    if (this.#charts.length !== count || this.#body.dataset.layout !== cls) {
      for (const ch of this.#charts) ch.destroy();
      this.#charts = Array.from({ length: count }, () => new Chart(c));
      this.#body.replaceChildren(...this.#charts.map(ch => ch.root));
      this.#body.dataset.layout = cls;
    }
    return this.#charts;
  }

  async #render(tab: Tab, force: boolean, quiet = false): Promise<void> {
    const seq = ++this.#seq;
    this.#setRanges(tab);
    if (!quiet) { this.#status.hidden = false; this.#status.textContent = t('Loading…'); this.#status.dataset.state = ''; }
    try {
      const draw = await this.#build(tab, force);
      if (seq !== this.#seq) return;
      draw();
      this.#status.hidden = true;
    } catch (error) {
      if (seq !== this.#seq) return;
      this.#status.hidden = false; this.#status.dataset.state = 'error';
      this.#status.textContent = t('Could not read the data: {why}. Nothing is drawn in its place; ↻ tries again.', { why: error instanceof Error ? error.message : String(error) });
    }
  }

  async #build(tab: Tab, force: boolean): Promise<() => void> {
    const now = Date.now(), prefs = this.host.prefs();
    switch (tab) {
      case 'vol': return this.#vol(rangeStart('vol', prefs.ranges.vol, now), force);
      case 'gap': return this.#gap(rangeStart('gap', prefs.ranges.gap, now), force);
      case 'term': return this.#term();
      case 'puts': return this.#puts(rangeStart('puts', prefs.ranges.puts, now), force);
      case 'ema': return this.#ema(rangeStart('ema', prefs.ranges.ema, now), force);
    }
  }

  async #vol(start: number, force: boolean): Promise<() => void> {
    if (force) await Promise.all([hourly.get(start - 8 * DAY_MS, true), dvolHourly.get(start - 8 * DAY_MS, true)]);
    const d = await volData(start);
    return () => {
      const c = this.#colours(), [chart] = this.#layout(1, 'one');
      let i = d.time.length - 1;
      while (i > 0 && !(Number.isFinite(d.rv[i]!) && Number.isFinite(d.iv[i]!))) i--;
      const rv = d.rv[i]!, iv = d.iv[i]!, over = rv > iv;
      this.#title.textContent = t('Realised {rv} vs implied {iv} ({time} UTC). Red: realised over implied.', { rv: f0(rv), iv: f0(iv), time: hourLabel(d.time[i]! + HOUR_MS) });
      this.#foot.textContent = t('Realised: 7-day, Binance BTCUSDT hourly returns, annualised (√8760). Implied: Deribit DVOL (30-day). Hourly, closed hours only.');
      const spec: ChartSpec = {
        x: { kind: 'time', min: start, max: d.time[d.time.length - 1]! + HOUR_MS },
        legend: [{ color: c.series, text: t('Realised (7d, hourly)') }, { color: c.series2, text: t('Implied (DVOL)') }],
        corner: { text: t('{rv} vs {iv}', { rv: f0(rv), iv: f0(iv) }), color: over ? c.flag : c.muted },
        panels: [{ weight: 1, format: axis, layers: [
          { kind: 'fill', x: d.time, a: d.rv, b: d.iv, color: c.flagSoft },
          { kind: 'line', x: d.time, y: d.iv, color: c.series2, width: 1.5 },
          { kind: 'line', x: d.time, y: d.rv, color: c.series, width: 1.6 },
        ] }],
        snap: d.time,
        readout: x => { const k = idx(d.time, x); return k < 0 ? null : [`${hourLabel(d.time[k]! + HOUR_MS)} UTC`, `${t('Realised')} ${f1(d.rv[k]!)}`, `${t('Implied')} ${f1(d.iv[k]!)}`, `${t('Gap')} ${signed(d.rv[k]! - d.iv[k]!)}`]; },
      };
      chart!.set(spec, c);
    };
  }

  async #gap(start: number, force: boolean): Promise<() => void> {
    if (force) await Promise.all([hourly.get(start - 8 * DAY_MS, true), dvolHourly.get(start - 8 * DAY_MS, true), dailyPerp.get(PERP_START, true)]);
    const [d, day] = await Promise.all([volData(start), dailyPerp.get(PERP_START)]);
    const dayEma = ema(day.close, 21);
    // The daily close and EMA as they stood at each hour: the last day that had closed by then (no peeking at the day under way).
    const closeThen = asOfClosedDay(d.time.map(x => x + HOUR_MS), day.time, day.close), emaThen = asOfClosedDay(d.time.map(x => x + HOUR_MS), day.time, dayEma);
    const gap = Float64Array.from(d.time, (_, k) => d.rv[k]! - d.iv[k]!);
    const flag = Array.from(d.time, (_, k) => gap[k]! > GAP_FLAG && closeThen[k]! < emaThen[k]!);
    const runs = flaggedRuns(d.time, flag);
    return () => {
      const c = this.#colours(), [chart] = this.#layout(1, 'one');
      let i = d.time.length - 1;
      while (i > 0 && !Number.isFinite(gap[i]!)) i--;
      const g = gap[i]!, under = closeThen[i]! < emaThen[i]!;
      this.#title.textContent = t('Realised minus implied vol, with BTC. Red: gap above +{n} with BTC under its daily 21 EMA. Now {gap} ({state}).', { n: GAP_FLAG, gap: signed(g, 0), state: under ? t('under the 21 EMA') : t('over the 21 EMA') });
      this.#foot.textContent = t('Realised: 7-day, Binance BTCUSDT hourly returns. Implied: Deribit DVOL. 21 EMA: Binance BTCUSDT perpetual daily closes, the last day closed at each hour.');
      const dayFrom = Math.max(0, idx(day.time, start) - 1);
      const px = day.time.slice(dayFrom), pc = day.close.slice(dayFrom);
      chart!.set({
        x: { kind: 'time', min: start, max: d.time[d.time.length - 1]! + HOUR_MS },
        bands: [{ runs: runs.map(([a, b]) => [a, b + HOUR_MS] as [number, number]), color: c.flagSoft, minWidth: 2 }],
        panels: [
          { weight: 1, format: axis, include: [GAP_FLAG, 0], layers: [
            { kind: 'bars', x: d.time, y: gap, base: 0, color: k => (flag[k] ? c.flagBar : gap[k]! >= 0 ? c.bar : c.barSoft) },
            { kind: 'hline', y: 0, color: c.muted, width: 1 },
            { kind: 'hline', y: GAP_FLAG, color: c.flag, dash: true },
            { kind: 'dot', x: d.time[i]!, y: g, color: g > GAP_FLAG ? c.flag : c.muted, label: signed(g, 0) },
          ], title: t('Realised − implied, pts') },
          { weight: 1, log: true, format: kUsd, layers: [{ kind: 'line', x: px, y: pc, color: c.series2, width: 1.3 }], title: t('BTC (log)') },
        ],
        snap: d.time,
        readout: x => { const k = idx(d.time, x); return k < 0 ? null : [`${hourLabel(d.time[k]! + HOUR_MS)} UTC`, `${t('Gap')} ${signed(gap[k]!)} (${f1(d.rv[k]!)} − ${f1(d.iv[k]!)})`, `${t('BTC daily close')} ${f0(closeThen[k]!)}`, `${t('21 EMA')} ${f0(emaThen[k]!)}`]; },
      }, c);
    };
  }

  async #term(): Promise<() => void> {
    const now = Date.now();
    const rows = expiryReadings(await optionMarks(), now);
    if (rows.length < 2) throw new Error(t('too few expiries could be read'));
    const shape = termShape(rows)!;
    return () => {
      const c = this.#colours(), [left, right] = this.#layout(2, 'two');
      const flagged = rows.filter(r => r.skew > SKEW_FLAG);
      const run: ExpiryReading[] = [];
      for (const r of rows) { if (r.skew > SKEW_FLAG) run.push(r); else break; }
      const shapeWord = shape.shape === 'inverted' ? t('inverted') : shape.shape === 'normal' ? t('normal') : t('flat');
      const skewText = run.length
        ? (() => {
          const lo = f1(Math.min(...run.map(r => r.skew))), hi = f1(Math.max(...run.map(r => r.skew))), date = dayLabel(run[run.length - 1]!.expiry);
          return lo === hi ? t('Puts {v}% over calls out to {date} (red: above {n}%).', { v: lo, date, n: SKEW_FLAG }) : t('Puts {lo}–{hi}% over calls out to {date} (red: above {n}%).', { lo, hi, date, n: SKEW_FLAG });
        })()
        : t('Nearest expiry puts {v}% over calls; red marks expiries above {n}% ({k} now).', { v: f1(rows[0]!.skew), n: SKEW_FLAG, k: flagged.length });
      this.#title.textContent = `${t('Nearest expiry {front} implied vol vs {month} from 1 month out: {shape}.', { front: f0(shape.front.atm), month: f0(shape.month.atm), shape: shapeWord })} ${skewText}`;
      this.#foot.textContent = t('Deribit BTC options, live marks ({time} UTC). ATM: out-of-the-money marks read at each expiry\'s forward. 25Δ: Black-Scholes delta from each mark, read between strikes. Expiries under 6 hours away are left out.', { time: hourLabel(now).slice(-5) });
      const days = rows.map(r => r.days), atm = rows.map(r => r.atm);
      left!.set({
        x: { kind: 'logdays', min: Math.max(0.2, Math.min(...days) * 0.8), max: Math.max(...days) * 1.25 },
        panels: [{ weight: 1, format: axis, layers: [{ kind: 'line', x: days, y: atm, color: c.series2, width: 1.8, dots: true }], title: `${t('Term structure')}: ${shapeWord}` }],
        snap: days,
        readout: x => { const r = rows.find(q => q.days === x); return r ? [`${dateLabel(r.expiry)} (${f1(r.days)}d)`, `${t('ATM IV')} ${f1(r.atm)}`, `${t('Forward')} ${f0(r.forward)}`] : null; },
      }, c);
      const idxs = rows.map((_, k) => k), skew = rows.map(r => r.skew);
      right!.set({
        x: { kind: 'category', min: -0.5, max: rows.length - 0.5, labels: rows.map(r => dayLabel(r.expiry)) },
        panels: [{ weight: 1, format: axis, min: Math.min(0, ...skew), include: [SKEW_FLAG], layers: [
          { kind: 'bars', x: idxs, y: skew, base: 0, color: k => (skew[k]! > SKEW_FLAG ? c.flagBar : c.bar) },
          { kind: 'hline', y: SKEW_FLAG, color: c.flag, dash: true },
        ], title: t('25Δ put over call, % of ATM IV') }],
        readout: x => { const r = rows[x]; return r ? [dateLabel(r.expiry), `${t('Put over call')} ${f1(r.skew)}%`, `${t('25Δ put')} ${f1(r.put25)} · ${t('25Δ call')} ${f1(r.call25)}`, `${t('ATM IV')} ${f1(r.atm)}`] : null; },
      }, c);
    };
  }

  async #puts(start: number, force: boolean): Promise<() => void> {
    const [file, day] = await Promise.all([putFlowHistory(), dailyPerp.get(PERP_START, force)]);
    if (!file) throw new Error(t('the put-flow history (put-flow.json) could not be read'));
    const map = new Map<number, FlowDay>();
    for (const [d, put, call, n] of file.days) map.set(d, { day: d, put, call, n });
    let through = file.through, note = '', partialToday = false;
    // The days after the history: www.deribit.com holds about the last day and a half of trades.
    try {
      const since = (through + 1) * DAY_MS;
      if (since <= Date.now()) {
        const recent = await recentPutFlow(since);
        const today = Math.floor(Date.now() / DAY_MS);
        // A day counts only when the trades read begin at its start (within 15 minutes); otherwise the newer days are not whole and are left out.
        if (recent.read > 0 && recent.firstTrade - since <= 15 * 60_000) {
          for (let d = through + 1; d <= today; d++) map.set(d, recent.days.get(d) ?? { day: d, put: 0, call: 0, n: 0 });
          through = today; partialToday = true;
          note = t('The last day is today so far (UTC), from Deribit\'s live trades.');
        } else note = t('History through {date}; the days after it could not be read whole, so they are left out.', { date: dateLabel(file.through * DAY_MS) });
      }
    } catch { note = t('History through {date}; Deribit\'s live trades could not be read.', { date: dateLabel(file.through * DAY_MS) }); }
    const n = through - file.from + 1;
    const time = Float64Array.from({ length: n }, (_, k) => (file.from + k) * DAY_MS);
    const put = Float64Array.from(time, x => map.get(x / DAY_MS)?.put ?? 0), call = Float64Array.from(time, x => map.get(x / DAY_MS)?.call ?? 0);
    const share = trailingPutShare(put, call, 7);
    const flag = Array.from(share, v => v >= PUT_SHARE_FLAG);
    const runs = flaggedRuns(time, flag);
    return () => {
      const c = this.#colours(), [chart] = this.#layout(1, 'one');
      let i = n - 1;
      while (i > 0 && !Number.isFinite(share[i]!)) i--;
      const sum7 = (a: Float64Array, k: number): number => { let s = 0; for (let j = Math.max(0, k - 6); j <= k; j++) s += a[j]!; return s; };
      this.#title.textContent = t('Share of premium spent by aggressive buyers that went to puts, trailing 7 days. Shaded: {n}%+. Now {v}%.', { n: PUT_SHARE_FLAG, v: f0(share[i]!) });
      this.#foot.textContent = `${t('Deribit BTC options, all trades (block trades too): taker buys, premium in USD (price × amount × index). Daily (UTC) history from history.deribit.com, built by the site\'s put-flow script; data since Jul 2022.')} ${note}`;
      const dayFrom = Math.max(0, idx(day.time, start) - 1);
      chart!.set({
        x: { kind: 'time', min: start, max: time[n - 1]! + DAY_MS },
        bands: [{ runs: runs.map(([a, b]) => [a, b + DAY_MS] as [number, number]), color: c.accentSoft, minWidth: 2 }],
        panels: [
          { weight: 1, format: axis, include: [PUT_SHARE_FLAG], layers: [
            { kind: 'hline', y: PUT_SHARE_FLAG, color: c.muted, dash: true },
            { kind: 'line', x: time, y: share, color: c.purple, width: 1.5 },
            { kind: 'dot', x: time[i]!, y: share[i]!, color: c.purple, label: `${f0(share[i]!)}%` },
          ], title: t('% on puts') },
          { weight: 1, log: true, format: kUsd, layers: [{ kind: 'line', x: day.time.slice(dayFrom), y: day.close.slice(dayFrom), color: c.series2, width: 1.3 }], title: t('BTC (log)') },
        ],
        snap: time,
        readout: x => { const k = idx(time, x); if (k < 0) return null; const p = sum7(put, k), q = sum7(call, k); return [`${dateLabel(time[k]!)}${k === n - 1 && partialToday ? ` (${t('so far')})` : ''}`, `${t('On puts')} ${f1(share[k]!)}%`, `${t('Puts')} ${musd(p)} · ${t('Calls')} ${musd(q)} (7d)`]; },
      }, c);
    };
  }

  async #ema(start: number, force: boolean): Promise<() => void> {
    const day = await dailyPerp.get(PERP_START, force);
    const pct = pctFromEma(day.close, 21), e = ema(day.close, 21);
    const flag = Array.from(pct, v => v <= EMA_FLAG);
    const runs = flaggedRuns(day.time, flag);
    return () => {
      const c = this.#colours(), [chart] = this.#layout(1, 'one');
      const i = day.time.length - 1, from = Math.max(0, idx(day.time, start) - 1);
      const tm = day.time.slice(from), pc = pct.slice(from), cl = day.close.slice(from);
      this.#title.textContent = t('Daily close vs 21 EMA, with BTC. Shaded: closes {n}%+ below. Last close {v}% ({date}).', { n: Math.abs(EMA_FLAG), v: signed(pct[i]!), date: dayLabel(day.time[i]!) });
      this.#foot.textContent = t('Binance BTCUSDT perpetual, daily closes (UTC); the day under way is left out. EMA from Sep 2019.');
      chart!.set({
        x: { kind: 'time', min: start, max: day.time[i]! + DAY_MS },
        bands: [{ runs: runs.map(([a, b]) => [a, b + DAY_MS] as [number, number]), color: c.flagSoft, minWidth: 2 }],
        panels: [
          { weight: 1, format: axis, include: [EMA_FLAG, 0], layers: [
            { kind: 'area', x: tm, y: pc, base: 0, color: c.soft },
            { kind: 'hline', y: 0, color: c.muted, width: 1 },
            { kind: 'hline', y: EMA_FLAG, color: c.flag, dash: true },
            { kind: 'line', x: tm, y: pc, color: c.series2, width: 1.2 },
            { kind: 'dot', x: day.time[i]!, y: pct[i]!, color: pct[i]! <= EMA_FLAG ? c.flag : c.muted, label: `${signed(pct[i]!)}%` },
          ], title: t('% from 21 EMA') },
          { weight: 1, log: true, format: kUsd, layers: [{ kind: 'line', x: tm, y: cl, color: c.series2, width: 1.3 }], title: t('BTC (log)') },
        ],
        snap: tm,
        readout: x => { const k = idx(day.time, x); return k < 0 ? null : [dateLabel(day.time[k]!), `${t('Daily close')} ${f0(day.close[k]!)}`, `${t('21 EMA')} ${f0(e[k]!)}`, `${signed(pct[k]!)}%`]; },
      }, c);
    };
  }
}

/** The index of the last element of sorted `xs` at or before `x` (or the first, when `x` is before them all; -1 when empty). */
function idx(xs: ArrayLike<number>, x: number): number {
  if (!xs.length) return -1;
  let lo = 0, hi = xs.length - 1;
  if (x <= xs[0]!) return 0;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xs[m]! <= x) lo = m; else hi = m - 1; }
  return lo;
}
