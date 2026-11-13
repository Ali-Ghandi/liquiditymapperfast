import { CVD_ID, CVD_SOURCE } from './script/starter.ts';
import { SCRIPTS_KEY, SCRIPT_API, ROW_MIN, type ScriptRecord } from './script/records.ts';
import { DEFAULTS_REV } from './store.ts';

/**
 * This fork's first visit: the page opens as a "Newsprint" desk instead of upstream's light heat map. A cream theme, Binance BTCUSDT on four-hour
 * candles, the order book and the flow column folded to their tabs, the year's volume profile from candles on the left with its value-area lines
 * across the chart, two anchored VWAPs and the 365-day rolling VWAP with shorter ones, Hyperliquid's liquidation levels, an Open Interest pane over
 * every perpetual (who opened and closed, with its table) and a Scripts pane with the spot and perpetual CVD and Toxic Flows.
 *
 * Revision 2: no order-book heatmap on the map, and the TPO (a week's Market Profile) on; browsers seeded before are migrated once.
 *
 * It only writes what a browser has not kept yet: a page that already saved its settings (`hlm-app-v2`) is left exactly as it is, and every value
 * written here still goes through the page's own readers (`readSettings`, `readScripts`), as a layouts file does. Everything stays changeable.
 */

const APP_KEY = 'hlm-app-v2', LAYOUT_KEY = 'hlm-layout-v3', TOUR_KEY = 'hlm-tour-v1', SEEDED_KEY = 'lmf-fork-seeded-v1';
/** The fork's revision of its defaults a browser has been brought to (`migrateForkDefaults`); none: revision 1, the first desk. */
export const FORK_REV_KEY = 'lmf-fork-rev', FORK_REV = 2;
const HOUR = 3_600_000, DAY = 24 * HOUR;

/** Toxic Flows: how one-sided the market orders are, a VPIN-style order-flow toxicity read from the recorded taker buys and sells. */
export const TOXIC_ID = 'toxic-flows';
export const TOXIC_SOURCE = `// Toxic Flows: how one-sided the market orders have been, in the spirit of VPIN (volume-synchronised probability of informed trading).
// Each candle's imbalance is |bought at market - sold at market|; toxicity is the imbalance over the window as a share of all that traded,
// ranked against its own range over the lookback (0: the calmest it has been, 100: the most one-sided). Above the dashed line the flow is toxic:
// liquidity providers are being run over, which tends to come before fast moves and thin books.
length = option(type=number, default=24, min=2, max=500, step=1, label="Window (candles)")
lookback = option(type=number, default=180, min=10, max=1000, step=1, label="Rank over (candles)")
threshold = option(type=number, default=80, min=1, max=100, step=1, label="Toxic above")
calmColor = option(type=color, default=#6f6e69, label=Line)
toxicColor = option(type=color, default=#af3029, label=Toxic)

var buys = nz(vbuy), sells = nz(vsell)
var imbalance = sum(Math.abs(buys - sells), length)
var traded = sum(buys + sells, length)
var vpin = traded > 0 ? imbalance / traded : NaN
var hi = highest(vpin, lookback), lo = lowest(vpin, lookback)
toxicity = hi > lo ? Math.min(100, Math.max(0, 100 * (vpin - lo) / (hi - lo))) : NaN

line({ value: toxicity, color: toxicity >= threshold ? toxicColor : calmColor }, title="Toxicity", lineWidth=2)
line(threshold, title="Threshold", color=rgba(16,15,15,0.55), lineStyle=2, lineWidth=1)
if (renderer.last && !na(toxicity)) mark({ value: toxicity, text: "Toxicity " + Math.round(toxicity), color: toxicity >= threshold ? toxicColor : calmColor }, title="Now", shape=label, position=at)
`;

/** The heatmap's settings on this desk: switched off (the book stays in its own folded Order Book tab), its colours as upstream's. */
export const FORK_HEAT = { on: false, style: 'size', auto: true, contrast: 50, smooth: 'auto' } as const;
/**
 * The TPO on this desk: one Market Profile a week (Monday to Sunday in the Volume profile's zone), a letter or block per hour bracket (168 a
 * week), folded into a profile at the week's start, in the page's ink (pale for a thin row to dark for a full one), with its TPO point of
 * control, the 70 % value area (VAH and VAL), the initial balance (the first hour brackets' range), the open and close, tails and single
 * prints, and the range numbers under it. A day's profile on four-hour candles is six candles wide and its half-hour letters too small to
 * read; a week of hour brackets has room, and on a shorter timeframe the Period and Block length settings make it a day's.
 */
export const FORK_TPO = { on: true, period: 'week', block: 60, count: 0, source: 'chart', picks: [], look: 'auto', colour: 'ink', share: 70, unfold: false,
  hollow: false, ib: true, calls: true, stats: true, lines: true, rows: {}, splits: {}, merges: {}, v: 2 } as const;

/** A colour slot's own colour for the anchored VWAPs: the magenta of the reference desk. */
const ANCHOR_COLOR = '#b0189f';

/** The settings this fork opens with, as `hlm-app-v2` keeps them (anything left out is the page's default). */
export function forkSettings(now: number): Record<string, unknown> {
  // Two anchored VWAPs, a month and a week back, on four-hour boundaries (UTC): numbered AVWAP 1 and AVWAP 2 on the chart.
  const fourHours = (t: number): number => Math.floor(t / (4 * HOUR)) * 4 * HOUR;
  const a1 = fourHours(now - 30 * DAY), a2 = fourHours(now - 7 * DAY), id = now.toString(36);
  return {
    defaultsRev: DEFAULTS_REV,
    theme: 'newsprint', themePicked: true, themeSlots: { light: 'newsprint', dark: 'dark' },
    timeframe: '4h', layer: 'liquidity', heatmapSource: 'aggregated', scope: 'all', chartType: 'candles',
    barCollapsed: true,
    show: { profile: false, traded: true, depth: false, oi: true, delta: false, ls: false, funding: false, candles: true, footprint: false, stats: false, lt: false,
      mirror: true, volume: true, bubbles: false, cvd: false, book: false, script: true },
    // Revision 2 (2026-11-13): no order-book data on the map (the heatmap off; the book's own profile column was already off), and the TPO on.
    heat: FORK_HEAT,
    tpo: FORK_TPO,
    liqLevels: { on: true, column: false },
    // Candles first: no absorption squares or liquidation bubbles over them (each a switch in the Chart deck).
    absorption: { on: false, mode: 'auto', k: 10, sdMinutes: 30, fixedUsd: 250_000, volume: true },
    liquidations: { on: false, minUsd: 1_000, side: 'both', scale: 1, labels: true },
    oiMarkets: 'all', oiChange: 'who', oiTable: true,
    vwap: {
      on: true, session: false, period: 'day', startMinute: null, bands: 0, rolling: [7, 30, 365], labels: true, tags: true, whale: false, whaleUsd: 1_000_000,
      source: 'chart', picks: [],
      anchors: { BTC: [{ id: `a${id}1`, at: a1, slot: 0, color: ANCHOR_COLOR }, { id: `a${id}2`, at: a2, slot: 1, color: ANCHOR_COLOR }] },
      colors: { rolling: { '7': '#24837b', '30': '#da702c', '365': '#af3029' } },
    },
    traded: {
      placements: { version: 1, instances: [
        { id: 'volume:left', enabled: true, metric: 'volume', placement: 'left', order: 0, window: { kind: 'chart' }, sizePx: null, overrides: {} },
        { id: 'volume:right', enabled: true, metric: 'volume', placement: 'right', order: 0, window: { kind: 'chart' }, sizePx: null, overrides: {} },
      ] },
      bars: 'split', emphasis: true, valueArea: true, share: 70, rows: 1, poc: true, va: true, labels: true, tags: true,
      lines: [], windowLines: true, profiles: null, source: 'candles', zone: 'page', count: 5, naked: true, carry: false,
      columns: 'anchor', anchors: { BTC: { id: `p${id}`, rule: { period: 'year', point: 'start' }, slot: 0 } }, every: 60,
    },
  };
}

/** The scripts this fork opens with: the spot and perpetual CVD and Toxic Flows, each a short row in the Scripts pane. */
export function forkScripts(): ScriptRecord[] {
  return [
    { id: CVD_ID, name: 'Spot and perpetual CVD', source: CVD_SOURCE, options: {}, on: true, api: SCRIPT_API, height: ROW_MIN, place: 'pane' },
    { id: TOXIC_ID, name: 'Toxic Flows', source: TOXIC_SOURCE, options: {}, on: true, api: SCRIPT_API, height: ROW_MIN, place: 'pane' },
  ];
}

/** The panes under the map: the Open Interest pane, then the scripts; the book on the right, the flow column on the left (both folded). */
export const FORK_LAYOUT = { heights: { oi: 170, script: 84 }, order: ['heat', 'oi', 'script', 'bars', 'depth', 'delta', 'ls', 'funding', 'lt'],
  dock: { left: ['cvd'], right: ['book'], leftW: null, rightW: null, weights: {} } };

/**
 * Brings a browser seeded under an earlier revision to this one, once: revision 2 switches the heatmap off and the TPO on in the settings it
 * kept, and changes nothing else it chose. A browser at this revision already (or one with nothing kept) is left alone. True when it changed.
 */
export function migrateForkDefaults(storage: Storage | undefined = globalThis.localStorage): boolean {
  try {
    if (!storage) return false;
    const rev = Number(storage.getItem(FORK_REV_KEY) ?? 1), raw = storage.getItem(APP_KEY);
    if (rev >= FORK_REV) return false;
    if (raw !== null) {
      const saved = JSON.parse(raw) as Record<string, unknown>;
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        const heat = saved.heat && typeof saved.heat === 'object' ? saved.heat as Record<string, unknown> : {};
        saved.heat = { ...FORK_HEAT, ...heat, on: false };
        const tpo = saved.tpo && typeof saved.tpo === 'object' ? saved.tpo as Record<string, unknown> : {};
        saved.tpo = { ...FORK_TPO, ...tpo, on: true, period: FORK_TPO.period, block: FORK_TPO.block, colour: FORK_TPO.colour, hollow: FORK_TPO.hollow };
        storage.setItem(APP_KEY, JSON.stringify(saved));
      }
    }
    storage.setItem(FORK_REV_KEY, String(FORK_REV));
    return true;
  } catch { return false; }
}

/** Writes this fork's first-visit settings into `storage` where it holds none yet; true when it did. */
export function seedForkDefaults(storage: Storage | undefined = globalThis.localStorage, now = Date.now()): boolean {
  try {
    if (!storage) return false;
    if (storage.getItem(APP_KEY) !== null || storage.getItem(SEEDED_KEY) !== null) { migrateForkDefaults(storage); return false; }
    storage.setItem(APP_KEY, JSON.stringify(forkSettings(now)));
    if (storage.getItem(SCRIPTS_KEY) === null) storage.setItem(SCRIPTS_KEY, JSON.stringify(forkScripts()));
    if (storage.getItem(LAYOUT_KEY) === null) storage.setItem(LAYOUT_KEY, JSON.stringify(FORK_LAYOUT));
    // The desk opens as it is; the tour is still one press away (Tour, in the bar).
    if (storage.getItem(TOUR_KEY) === null) storage.setItem(TOUR_KEY, JSON.stringify({ v: 1, seen: now, dismissed: now }));
    storage.setItem(SEEDED_KEY, String(now));
    storage.setItem(FORK_REV_KEY, String(FORK_REV));
    return true;
  } catch { return false; }
}
