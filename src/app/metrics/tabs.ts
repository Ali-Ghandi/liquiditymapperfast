/**
 * The metric tabs: Chart | Vol | Vol gap | Term & skew | Put flow | 21 EMA. Chart is the page as it always was and the tab every browser
 * starts on; another tab lays its view over the map and the panes (which keep running underneath) until Chart is chosen again. On a
 * computer the tabs sit in the status bar; on a phone they are a section of Settings and a row along the top of the view. The tab chosen and
 * each tab's range are kept in this browser (`settings.ts`). The charts themselves load only when a metric tab is first opened (`view.ts`).
 */
import { t } from '../i18n.ts';
import { METRIC_TABS, readMetricPrefs, tabLabel, tabTip, writeMetricPrefs, type MetricPrefs, type MetricTab, type RangeKey, type RangedTab } from './settings.ts';
import type { MetricsView } from './view.ts';
import { openedSheet } from '../sheet.ts';

const storage = (): Storage | null => { try { return localStorage; } catch { return null; } };

export class MetricTabs {
  /** The row of tabs for the desktop status bar. */
  readonly strip: HTMLElement;
  /** The view laid over the page while a metric tab is chosen. */
  readonly overlay = document.createElement('section');
  #topStrip: HTMLElement;
  #prefs: MetricPrefs = readMetricPrefs(storage());
  #view: MetricsView | null = null;
  #loading: Promise<MetricsView> | null = null;
  #buttons: HTMLButtonElement[] = [];

  constructor(private theme: () => string, private bounds: () => { top: number; bottom: number }) {
    this.strip = this.#makeStrip('mx-tabs');
    this.#topStrip = this.#makeStrip('mx-tabs mx-tabs-top');
    this.overlay.className = 'mx-overlay';
    this.overlay.hidden = true;
    this.overlay.setAttribute('aria-label', t('Metrics'));
    this.overlay.append(this.#topStrip);
    const place = (): void => this.place();
    addEventListener('resize', place);
    new MutationObserver(place).observe(document.documentElement, { attributes: true, attributeFilter: ['data-layout', 'data-bar'] });
    addEventListener('keydown', e => {
      // Escape goes back to the chart, unless something over the view (a sheet, a menu) takes it first.
      if (e.key === 'Escape' && !this.overlay.hidden && !e.defaultPrevented && !openedSheet() && !document.querySelector('.menu, .sheet-scrim')) this.select('chart');
    });
  }

  get tab(): MetricTab { return this.#prefs.tab; }

  /** The tabs as tiles for a phone's Settings sheet; choosing one closes the sheet. */
  tiles(close: () => void): HTMLButtonElement[] {
    return METRIC_TABS.map(tab => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = tabLabel(tab); b.title = tabTip(tab);
      b.classList.toggle('on', tab === this.#prefs.tab);
      b.onclick = () => { close(); this.select(tab); };
      return b;
    });
  }

  /** Open the tab kept from the last visit (Chart, unless another was chosen). */
  start(): void { if (this.#prefs.tab !== 'chart') this.select(this.#prefs.tab); }

  select(tab: MetricTab): void {
    this.#prefs.tab = tab;
    writeMetricPrefs(storage(), this.#prefs);
    for (const b of this.#buttons) { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    // The phone's row scrolls sideways: the chosen tab is brought into it.
    this.#topStrip.querySelector<HTMLElement>('button.on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (tab === 'chart') {
      this.overlay.hidden = true;
      document.documentElement.removeAttribute('data-metric');
      this.#view?.hide();
      return;
    }
    document.documentElement.dataset.metric = tab;
    this.overlay.hidden = false;
    this.place();
    // Positioning's charts are Task 6: do not ask MetricsView to show 'pos' until that tab exists there.
    void this.#load().then(view => { if (this.#prefs.tab === tab && tab !== 'pos') view.show(tab); }, error => {
      const note = document.createElement('p');
      note.className = 'mx-status'; note.dataset.state = 'error';
      note.textContent = t('Could not load the metric charts: {why}', { why: error instanceof Error ? error.message : String(error) });
      this.overlay.append(note);
    });
  }

  /** The theme changed: the charts take its colours. */
  recolour(): void { this.#view?.recolour(); }

  #load(): Promise<MetricsView> {
    this.#loading ??= import('./view.ts').then(({ MetricsView }) => {
      const view = new MetricsView({
        prefs: () => this.#prefs,
        setRange: (tab: RangedTab, key: string) => { this.#prefs.ranges[tab] = key as RangeKey; writeMetricPrefs(storage(), this.#prefs); },
        theme: this.theme,
      });
      this.#view = view;
      this.overlay.append(view.root);
      return view;
    });
    return this.#loading;
  }

  /** Lay the view between the top bar and the status bar (again, after either moved). */
  place(): void {
    if (this.overlay.hidden) return;
    const { top, bottom } = this.bounds();
    this.overlay.style.top = `${Math.max(0, top)}px`;
    this.overlay.style.bottom = `${Math.max(0, bottom)}px`;
  }

  #makeStrip(cls: string): HTMLElement {
    const strip = document.createElement('div');
    strip.className = cls;
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', t('Metrics'));
    for (const tab of METRIC_TABS) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = tabLabel(tab); b.title = tabTip(tab); b.dataset.tab = tab;
      b.setAttribute('role', 'tab');
      const on = tab === this.#prefs.tab;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on));
      b.onclick = () => this.select(tab);
      this.#buttons.push(b);
      strip.append(b);
    }
    return strip;
  }
}
