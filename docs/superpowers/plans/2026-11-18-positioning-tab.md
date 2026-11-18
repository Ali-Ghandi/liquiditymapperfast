# Positioning Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one **Positioning** metric tab with three stacked Binance-based charts (OI vs funding into durable lows, funding into durable lows, alt negative-funding share) that load when the tab is opened.

**Architecture:** Pure maths live in `src/app/metrics/positioning.ts` (durable lows, contracts index, 7d funding, alt share, event points). Browser fetches live Binance series plus a site-built `positioning.json` (daily OI / funding / alt-share archive, same pattern as put-flow) via `data.ts`. `view.ts` renders one new tab with three charts; `settings.ts` / `tabs.ts` register it. Binance `openInterestHist` only keeps ~30 daily points, so the archive is required for OI history to grow; funding can be backfilled from `fapi/v1/fundingRate` on first script run.

**Tech Stack:** TypeScript (existing Vite app), Node test runner (`tests/fork-metrics.test.mts`), GitHub Actions Pages workflow, Binance USDT-M public REST (CORS `*`).

## Global Constraints

- Public Binance only — no Coinalyze key, no other paid APIs.
- Pics 1–3 only; TradingView sketch out of scope.
- Existing five metric tabs and put-flow workflow behaviour stay unchanged (add steps beside them, do not rewrite them).
- English copy via `t('…')` keys; other locale packs may omit new strings (English fallback).
- Opt-in tab: Chart remains default; Positioning loads on click only.
- Footnote must state Binance approximation of Cav’s Coinalyze top-300 charts.
- Normal push to `master` only; never force-push.
- `gh` fork commands use `-R Ali-Ghandi/liquiditymapperfast` when the default remote is upstream.

## File map

| File | Responsibility |
| --- | --- |
| `src/app/metrics/positioning.ts` | Pure durable-low detection, contracts index, funding annualisation, event points, alt-share aggregation, JSON parse |
| `src/app/metrics/data.ts` | Fetch BTC funding history, recent OI hist, `positioning.json`, live alt premiumIndex + OI sample |
| `scripts/positioning.mts` | Build/extend `positioning.json` (funding backfill, OI append, daily alt share) |
| `src/app/public/positioning.json` | Committed seed / fallback archive |
| `.github/workflows/pages.yml` | Deploy step + schedule reuse for positioning refresh |
| `src/app/metrics/settings.ts` | `pos` tab id, labels, tips, optional range for chart 3 |
| `src/app/metrics/view.ts` | `#pos` render: three charts |
| `src/app/metrics/tabs.ts` | Passes `MetricTab` through (types only if needed) |
| `src/app/metrics/plot.ts` | Add `scatter` layer if multiple `dot`s are too heavy |
| `tests/fork-metrics.test.mts` | Unit tests for positioning maths + prefs |
| `docs/superpowers/specs/2026-11-18-positioning-tab-design.md` | Spec (already committed) |

---

### Task 1: Durable lows + contracts + funding maths (pure)

**Files:**
- Create: `src/app/metrics/positioning.ts`
- Modify: `tests/fork-metrics.test.mts`
- Test: `tests/fork-metrics.test.mts`

**Interfaces:**
- Produces:
  - `export interface DurableLow { t: number; confirmed: boolean }` — `t` is UTC day-open ms of the low’s day
  - `export function durableLows(time: ArrayLike<number>, high: ArrayLike<number>, low: ArrayLike<number>, close: ArrayLike<number>, now?: number): DurableLow[]` (revised 2026-11-19: wicks for the swing low, 90-day high and hold; closes for the rally)
  - `export function contractsIndex(oi: ArrayLike<number>, price: ArrayLike<number>, base = 100): Float64Array` — `oi[i]*base*price[0]/price[i]/oi[0]` when oi[0]>0 and price>0; else NaN
  - `export function funding7dAnnualised(time: ArrayLike<number>, rate: ArrayLike<number>, dayTimes: ArrayLike<number>): Float64Array` — for each day in `dayTimes`, mean of funding rates with `time` in `[day, day+DAY_MS)` over the last 7 days of **funding events**, annualised as `mean * 3 * 365 * 100` (Binance 3 fundings/day → percent annualised). Days with no rates → NaN
  - `export function pctChange(series: ArrayLike<number>, times: ArrayLike<number>, at: number, lookbackDays: number): number` — value at `at` vs value at `at - lookbackDays*DAY_MS` (nearest ≤), as percent; NaN if missing
  - `export function pointChange(series: ArrayLike<number>, times: ArrayLike<number>, at: number, lookbackDays: number): number` — subtraction in series units (funding points)

- [ ] **Step 1: Write the failing tests**

Append to `tests/fork-metrics.test.mts`:

```typescript
import {
  contractsIndex, durableLows, funding7dAnnualised, pctChange, pointChange,
} from '../src/app/metrics/positioning.ts';

test('durableLows: 15% under 90d high, held 60d, then +15% is confirmed; a fresh dip is unconfirmed now', () => {
  const DAY = 86_400_000;
  const t0 = Date.UTC(2024, 0, 1);
  const time: number[] = [], close: number[] = [];
  // 100 days flat at 100, then crash to 80 (day 100), stay ≥80 for 60 days, then rally to 92 (15% from 80)
  for (let i = 0; i < 200; i++) {
    time.push(t0 + i * DAY);
    if (i < 100) close.push(100);
    else if (i < 160) close.push(80);
    else close.push(92);
  }
  const lows = durableLows(time, close, close, close, t0 + 199 * DAY); // high = low = close: candles without wicks
  assert.equal(lows.filter(l => l.confirmed).length, 1);
  assert.equal(lows.find(l => l.confirmed)!.t, t0 + 100 * DAY);
});

test('contractsIndex deflates OI by price and indexes to 100', () => {
  const oi = [1000, 1100], price = [50_000, 55_000];
  const idx = contractsIndex(oi, price, 100);
  close(idx[0]!, 100, 1e-9);
  // 1100/1000 * 50000/55000 * 100
  close(idx[1]!, 100 * 1.1 * (50_000 / 55_000), 1e-9);
});

test('funding7dAnnualised means the last 7 days of funding events and annualises ×3×365×100', () => {
  const DAY = 86_400_000;
  const day = Date.UTC(2024, 5, 10);
  const time: number[] = [], rate: number[] = [];
  for (let i = 0; i < 21; i++) { // 7 days × 3
    time.push(day - 6 * DAY + i * (DAY / 3));
    rate.push(0.0001); // 0.01% per funding
  }
  const out = funding7dAnnualised(time, rate, [day]);
  close(out[0]!, 0.0001 * 3 * 365 * 100, 1e-6);
});

test('pctChange and pointChange read 30 days back', () => {
  const DAY = 86_400_000, t0 = Date.UTC(2024, 0, 1);
  const times = Array.from({ length: 40 }, (_, i) => t0 + i * DAY);
  const series = times.map((_, i) => 100 + i);
  close(pctChange(series, times, t0 + 39 * DAY, 30), 100 * ((139 / 109) - 1), 1e-9);
  close(pointChange(series, times, t0 + 39 * DAY, 30), 30, 1e-9);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /workspace/lmf/repo && npm test -- --test-name-pattern="durableLows|contractsIndex|funding7dAnnualised|pctChange"`  
Expected: FAIL (module or exports missing).

- [ ] **Step 3: Implement `positioning.ts`**

Create `src/app/metrics/positioning.ts` implementing the interfaces above.

`durableLows` algorithm:
(Revised 2026-11-19: Cav’s rule literally; wicks, and closes for the rally.)
1. For each day `i` (need ≥90 prior days), it is a 10-day swing low if `low[i] < low[j]` for every `j` in `i-9..i-1`.
2. Candidate if also `low[i] <= 0.85 * max(high[i-90..i-1])` (prior 90-day intraday high). Every swing low is tested, in time order.
3. Skip the candidate if it is within 60 days (inclusive) of the previous accepted low — a retest of the same episode (Cav’s rule).
4. Confirmed if every intraday low in `(t, t+60d]` is `>= low[i]` and some daily close in that same window reaches `low[i] * 1.15`.
5. If the window is not over yet and no low has gone under it, it is pending (unconfirmed); if the window is over without the rally, it has failed and is dropped. Confirmed and pending lows are the accepted ones for step 3.
6. Return confirmed lows plus at most one latest pending low (“now”).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="durableLows|contractsIndex|funding7dAnnualised|pctChange"`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/metrics/positioning.ts tests/fork-metrics.test.mts
git commit -m "feat(metrics): durable lows, contracts index, funding maths for Positioning"
```

---

### Task 2: Event points + positioning.json schema

**Files:**
- Modify: `src/app/metrics/positioning.ts`
- Modify: `tests/fork-metrics.test.mts`

**Interfaces:**
- Consumes: Task 1 exports
- Produces:
  - `export interface PosDay { day: number; oi: number; funding7d: number; altNeg: number }` — `day` = UTC day index `floor(ms/DAY_MS)`; `altNeg` = share in percent or NaN
  - `export interface PositioningFile { v: 1; source: string; builtAt: number; from: number; through: number; days: [number, number, number, number][] }` — rows `[day, oi, funding7d, altNeg]`
  - `export function parsePositioning(raw: unknown): PositioningFile | null`
  - `export function lowEventPoints(lows: DurableLow[], dayTimes: ArrayLike<number>, contracts: ArrayLike<number>, funding: ArrayLike<number>): { t: number; confirmed: boolean; oiPct: number; fundPts: number; fundAt: number }[]` — skips a low when oiPct or fund fields are NaN for charts that need them; still returns fund-only fields when OI missing (oiPct NaN)

- [ ] **Step 1: Write failing tests** for `parsePositioning` round-trip and `lowEventPoints` with one confirmed low where contracts rose 9% and funding +5.5 points.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement parse + `lowEventPoints`**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/app/metrics/positioning.ts tests/fork-metrics.test.mts
git commit -m "feat(metrics): positioning.json schema and durable-low event points"
```

---

### Task 3: Browser data loaders

**Files:**
- Modify: `src/app/metrics/data.ts`
- Modify: `tests/fork-metrics.test.mts` (only if pure helpers extracted; otherwise a small node test that mocks `getJson` is optional — prefer keeping fetch untested and cover parsers in Task 2)

**Interfaces:**
- Produces:
  - `export async function binanceFunding(start: number, progress?: …): Promise<Series>` — paginate `https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000&startTime=` until now; `close` = fundingRate
  - `export async function binanceOiDaily(progress?: …): Promise<Series>` — `https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=500` → time=timestamp, close=`sumOpenInterest` (contracts)
  - `export async function positioningHistory(): Promise<PositioningFile | null>` — fetch `./positioning.json` (site-relative like put-flow), `parsePositioning`
  - `export async function liveAltNegShare(topN = 50): Promise<number>` — `premiumIndex` all symbols + `openInterest` for top N USDT-M alts by OI (exclude BTCUSDT); OI-weighted share with `lastFundingRate < 0`, as percent

Reuse existing `getJson` / `pool` in `data.ts`. Cap concurrent OI calls (e.g. 8).

- [ ] **Step 1: Implement the four exports** (no failing browser test required; add a tiny node test only if you extract URL builders)

- [ ] **Step 2: Manual smoke from node** (optional): `node -e` fetching funding page count > 0

- [ ] **Step 3: Commit**

```bash
git add src/app/metrics/data.ts
git commit -m "feat(metrics): Binance funding, OI, alt-share, positioning.json loaders"
```

---

### Task 4: `scripts/positioning.mts` + seed file + Pages step

**Files:**
- Create: `scripts/positioning.mts`
- Create: `src/app/public/positioning.json` (after first successful local run)
- Modify: `.github/workflows/pages.yml`
- Modify: `package.json` only if a script alias is useful (optional)

**Interfaces:**
- CLI: `node build/tools/scripts/positioning.mjs --out <file> [--previous <file|URL>] [--fallback <file>]`
- Behaviour:
  1. Read previous PositioningFile if any.
  2. Backfill BTC funding into daily `funding7d` from first needed day through yesterday UTC (paginate fundingRate).
  3. Append/refresh BTC daily OI from `openInterestHist` (merge by day).
  4. For yesterday UTC (and any missing recent days): compute altNeg via exchangeInfo + premiumIndex + openInterest top 50 alts (server-side, no CORS issue). Rate-limit politely.
  5. Write `{ v:1, source, builtAt, from, through, days }`.
  6. Never leave holes in funding/OI days once started; if a day fails, stop `through` before it (same spirit as put-flow).

Pages workflow (after coins / put-flow steps):

```yaml
      - run: npm run build:tools && node build/tools/scripts/positioning.mjs --previous https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}/positioning.json --fallback src/app/public/positioning.json --out dist/positioning.json
        continue-on-error: true
        timeout-minutes: 20
```

Existing schedule crons already run daily — no new cron required unless you want a third; reuse them.

- [ ] **Step 1: Implement script; `npm run build:tools`**

- [ ] **Step 2: Run locally to seed**

```bash
npm run build:tools && node build/tools/scripts/positioning.mjs --out src/app/public/positioning.json
cp src/app/public/positioning.json dist/positioning.json  # if dist exists from a prior site build; else skip
```

Expected: file with `through` = yesterday UTC, funding days back as far as the backfill reached, OI for ~last month, altNeg for recent day(s).

- [ ] **Step 3: Patch `pages.yml`**

- [ ] **Step 4: Commit**

```bash
git add scripts/positioning.mts src/app/public/positioning.json .github/workflows/pages.yml
git commit -m "feat(metrics): daily positioning.json archive and Pages refresh step"
```

---

### Task 5: Register Positioning tab in settings + prefs tests

**Files:**
- Modify: `src/app/metrics/settings.ts`
- Modify: `tests/fork-metrics.test.mts`

**Interfaces:**
- `MetricTab` includes `'pos'`
- `METRIC_TABS` ends with `'pos'` after `'ema'`
- `RangedTab` includes `'pos'` with `RANGES.pos = ['1Y','2Y','ALL']`, `DEFAULT_RANGE.pos = 'ALL'`, `ALL_START.pos` = first day we expect archive usefulness (use `Date.UTC(2020, 0, 1)` or the file’s `from` at runtime in the view — prefs ALL_START can be `Date.UTC(2024, 0, 1)` as a safe chart-3 default)
- `tabLabel('pos')` → `t('Positioning')`
- `tabTip('pos')` → `t('BTC open interest and funding into swing lows, and the share of Binance alt perps on negative funding.')`
- Update prefs test that asserts `METRIC_TABS` deep equality

- [ ] **Step 1: Write failing prefs assertion update**

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Edit `settings.ts`**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/app/metrics/settings.ts tests/fork-metrics.test.mts
git commit -m "feat(metrics): register Positioning tab in metric prefs"
```

---

### Task 6: Plot scatter support (if needed) + Positioning view

**Files:**
- Modify: `src/app/metrics/plot.ts` (add scatter layer)
- Modify: `src/app/metrics/view.ts`
- Modify: `src/app/metrics/tabs.ts` only if `show(tab)` typing needs `MetricTab` widened (view currently uses local `Tab` union — extend it)

**Interfaces:**
- Plot: add `| { kind: 'scatter'; x: ArrayLike<number>; y: ArrayLike<number>; color: (i: number) => string; r?: number }`
- View: `type Tab = 'vol' | 'gap' | 'term' | 'puts' | 'ema' | 'pos'`
- `#build` case `'pos': return this.#pos(rangeStart('pos', prefs.ranges.pos, now), force)`
- `#setRanges`: for `pos`, show ranges (drive chart 3 only)
- `#pos`:
  1. Load daily perp closes from `PERP_START`, funding from 2020, `positioningHistory()`, recent `binanceOiDaily()`, merge OI into a series (archive overrides/extends API).
  2. Build contracts index + funding7d series on day grid.
  3. `durableLows` → `lowEventPoints`.
  4. Layout **3** charts (`#layout(3, 'pos')`):
     - Chart A: scatter oiPct (x) vs fundPts (y); confirmed = series colour, now = flag colour; quadrant label via title/foot.
     - Chart B: scatter fundAt (x) vs fundPts (y); same colours.
     - Chart C: time series altNeg from archive days + optional live point; range clipped by prefs.
  5. Title/foot footnotes per design (Binance approx, durable-low rule, unconfirmed now).
  6. Partial failure: if alt share missing, still draw A/B; if OI missing for history, draw B and note A limited.

- [ ] **Step 1: Add scatter drawing in `plot.ts`** (mirror `dot`, loop points)

- [ ] **Step 2: Implement `#pos` in `view.ts`**; extend `Tab` / `#build` / timer (5 min like others)

- [ ] **Step 3: `npm test` full suite** — existing tests still pass; new ones pass

- [ ] **Step 4: `npm run build:site`** (or project’s site build script used in Pages) — must succeed

- [ ] **Step 5: Commit**

```bash
git add src/app/metrics/plot.ts src/app/metrics/view.ts src/app/metrics/tabs.ts
git commit -m "feat(metrics): Positioning tab UI with three Binance charts"
```

---

### Task 7: Push, verify Action, visual check

**Files:** none (ops)

- [ ] **Step 1: Push `master` to `origin`** (`git push origin master` or `-R` as needed)

- [ ] **Step 2: Watch Pages workflow** including positioning step; note continue-on-error outcome

- [ ] **Step 3: Fetch** `https://ali-ghandi.github.io/liquiditymapperfast/positioning.json` — confirm 200 and `through`

- [ ] **Step 4: Open site, click Positioning** — confirm three charts, Chart still default, footnote visible. Screenshot desktop + phone if box browser available.

- [ ] **Step 5: Report** commit hash, Action URL, live `through` date, any gaps (especially OI history depth vs Cav’s 2022 sample)

---

## Spec coverage check

| Spec item | Task |
| --- | --- |
| One Positioning tab, three charts | 5–6 |
| Durable-low rule 15/90/60/15 | 1 |
| Contracts deflated OI | 1, 4 |
| Funding 7d annualised + 30d points | 1–2 |
| Alt neg share 7d avg | 2–4, 6 (store daily; view can trailing-average) |
| Binance only, footnote | 3–6 |
| Load on open / Chart default | 5–6 |
| Archive if live history insufficient | 4 (required: OI ~30d API limit) |
| Existing tabs untouched | all |
| Tests for pure maths | 1–2, 5 |

## Placeholder / consistency review

- Names aligned: `durableLows`, `contractsIndex`, `funding7dAnnualised`, `PositioningFile`, tab id `pos`.
- No TBD steps; OI archive decision locked in Task 4.
- `altNeg` stored as daily percent; chart 3 applies 7-day trailing average in the view (or script stores already-averaged — prefer **raw daily in file**, average in view for flexibility).

## Task 8 (2026-11-19): alt-share history from data.binance.vision

fapi refuses GitHub's runners (HTTP 451), so the stored alt share is read from the public archive instead (definition in the spec, chart 3):

- Pure helpers in `positioning.ts`, tested first: `metricsUsdOiAtClose`, `lastFundingBefore`, `altNegShareFromArchive` (top 50 by USD OI, ≥ 80 % read or null), `nonCryptoUsdtPerps`, `altArchiveDaysWanted`; `ALT_ARCHIVE_DEF` marks the definition in the file.
- `scripts/positioning.mts` reads the published months after the last stored share, at most two a run within 12 minutes; the full history (from 2021-12-01) was seeded once from the box with `--alt-months 99` and committed. When the published copy lacks archive shares, the repository's copy fills them.
- The view's mean leaves out the live red dot; the footnote states the archive's dates and its month-long funding lag.
- Workflow: one `SITE` address for the three `--previous` copies (the coins one lacked the repository path); `tests/fork-pages-workflow.test.mts` checks it.
