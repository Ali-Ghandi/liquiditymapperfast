/**
 * The metric tabs' choices, kept in this browser (not in layouts, not migrated: a browser that never chose has the Chart tab and each
 * tab's default range). Pure and tested.
 */
import { t } from '../i18n.ts';

export type MetricTab = 'chart' | 'vol' | 'gap' | 'term' | 'puts' | 'ema' | 'pos';
export const METRIC_TABS: readonly MetricTab[] = ['chart', 'vol', 'gap', 'term', 'puts', 'ema', 'pos'];
export type RangedTab = 'vol' | 'gap' | 'puts' | 'ema' | 'pos';
export const METRIC_KEY = 'lmf-metric-tab-v1';

export type RangeKey = '1M' | '2M' | '3M' | '6M' | '1Y' | '2Y' | 'SRC' | 'ALL';

/** Where the source charts begin ("since May-23"). */
export const SOURCE_START = Date.UTC(2023, 4, 1);
/** Where each tab's longest range begins: the first DVOL hours (Mar 2021), the first put-flow week (Jul 2022), the perpetual's first days (Sep 2019). */
export const ALL_START: Record<RangedTab, number> = { vol: Date.UTC(2021, 3, 1), gap: Date.UTC(2021, 3, 1), puts: Date.UTC(2022, 6, 7), ema: Date.UTC(2019, 8, 10), pos: Date.UTC(2020, 0, 1) };

export const RANGES: Record<RangedTab, readonly RangeKey[]> = {
  vol: ['1M', '2M', '3M', '6M', '1Y'],
  gap: ['6M', '1Y', '2Y', 'SRC', 'ALL'],
  puts: ['6M', '1Y', '2Y', 'SRC', 'ALL'],
  ema: ['6M', '1Y', '2Y', 'SRC', 'ALL'],
  pos: ['1Y', '2Y', 'ALL'],
};
export const DEFAULT_RANGE: Record<RangedTab, RangeKey> = { vol: '2M', gap: 'SRC', puts: 'SRC', ema: 'SRC', pos: 'ALL' };

const MONTH = 30.44 * 86_400_000;
/** The first time a range shows, at `now`. */
export function rangeStart(tab: RangedTab, key: RangeKey, now: number): number {
  switch (key) {
    case '1M': return now - MONTH;
    case '2M': return now - 2 * MONTH;
    case '3M': return now - 3 * MONTH;
    case '6M': return now - 6 * MONTH;
    case '1Y': return now - 12 * MONTH;
    case '2Y': return now - 24 * MONTH;
    case 'SRC': return SOURCE_START;
    case 'ALL': return ALL_START[tab];
  }
}

/** What the range's button says. */
export function rangeLabel(tab: RangedTab, key: RangeKey): string {
  if (key === 'SRC') return t('Since May 2023');
  if (key === 'ALL') return tab === 'puts' ? t('Since Jul 2022') : tab === 'ema' ? t('Since Sep 2019') : t('Since Apr 2021');
  return key;
}

/** What each tab's button says. */
export function tabLabel(tab: MetricTab): string {
  switch (tab) {
    case 'chart': return t('Chart');
    case 'vol': return t('Volatility');
    case 'gap': return t('Vol gap');
    case 'term': return t('Term & skew');
    case 'puts': return t('Put flow');
    case 'ema': return t('21 EMA');
    case 'pos': return t('Positioning');
  }
}

export function tabTip(tab: MetricTab): string {
  switch (tab) {
    case 'chart': return t('The chart, as it was.');
    case 'vol': return t('BTC realised volatility (7 days of hourly returns) against implied volatility (Deribit DVOL).');
    case 'gap': return t('Realised minus implied volatility since 2023, with the BTC price.');
    case 'term': return t('Deribit BTC options now: at-the-money implied volatility by expiry, and the 25-delta put over call.');
    case 'puts': return t('The share of premium spent by aggressive option buyers that went to puts, over the last 7 days.');
    case 'ema': return t('The BTC daily close against its 21-day EMA, with the price.');
    case 'pos': return t('BTC open interest and funding into swing lows, and the share of Binance alt perps on negative funding.');
  }
}

export interface MetricPrefs { tab: MetricTab; ranges: Record<RangedTab, RangeKey> }

export const defaultPrefs = (): MetricPrefs => ({ tab: 'chart', ranges: { ...DEFAULT_RANGE } });

/** The kept choices, each checked: anything unknown is the default. */
export function readMetricPrefs(storage: Pick<Storage, 'getItem'> | null): MetricPrefs {
  const prefs = defaultPrefs();
  try {
    const raw: unknown = JSON.parse(storage?.getItem(METRIC_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return prefs;
    const r = raw as { tab?: unknown; ranges?: unknown };
    if (typeof r.tab === 'string' && (METRIC_TABS as readonly string[]).includes(r.tab)) prefs.tab = r.tab as MetricTab;
    if (typeof r.ranges === 'object' && r.ranges !== null) {
      for (const tab of Object.keys(RANGES) as RangedTab[]) {
        const v = (r.ranges as Record<string, unknown>)[tab];
        if (typeof v === 'string' && (RANGES[tab] as readonly string[]).includes(v)) prefs.ranges[tab] = v as RangeKey;
      }
    }
  } catch { /* the default */ }
  return prefs;
}

export function writeMetricPrefs(storage: Pick<Storage, 'setItem'> | null, prefs: MetricPrefs): void {
  try { storage?.setItem(METRIC_KEY, JSON.stringify(prefs)); } catch { /* storage refused: the choice lasts this visit */ }
}
