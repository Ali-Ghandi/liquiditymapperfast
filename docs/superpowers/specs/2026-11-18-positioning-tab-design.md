# Positioning tab (CavanXy OI / funding charts)

Date: 2026-11-18  
Source: [CavanXy post 2118068035328282939](https://x.com/CavanXy/status/2118068035328282939), images 1–3 only (TradingView sketch skipped).  
Site: https://ali-ghandi.github.io/liquiditymapperfast/  
Repo: Ali-Ghandi/liquiditymapperfast

## Goal

Add one **Positioning** metric tab that stacks three Binance-based approximations of Cav’s Coinalyze / ID Theory charts so they update when the tab is opened, matching the existing Vol / Put flow / EMA pattern (opt-in tab, load on click, prefs in this browser).

## Non-goals

- Replicating Coinalyze top-300 aggregation or requiring a Coinalyze API key.
- Adding the hand-drawn TradingView price chart (image 4).
- Changing the existing five metric tabs’ maths or data sources.
- Building a multi-coin scanner for the main Chart view.

## User-facing behaviour

- New tab id: `pos` (label **Positioning**). Desktop: bottom bar with the other metric tabs. Phone: Settings → Metrics.
- Default tab stays **Chart**. Positioning loads only when selected.
- One scrollable view with three stacked charts (same canvas stack style as other metric panels where practical):
  1. **OI vs funding into lows** — scatter: 30-day % change in BTC contracts (x) vs 30-day change in 7-day funding points (y) at each durable low; “now” highlighted.
  2. **Funding into lows** — scatter: 7-day annualised funding at the low (x) vs 30-day change in funding points (y); same event set; “now” highlighted.
  3. **Alt negative funding** — time series: OI-weighted share of Binance USDT-M alt perps (exclude BTC) with negative funding, 7-day average.
- Footnote on the tab: Binance-only approximation of Cav’s Coinalyze top-300 charts; durable-low rule stated briefly; “now” may be unconfirmed.
- No new range chips required for charts 1–2 (event set is the full history we can compute). Chart 3 may reuse a simple range set (`1Y` / `2Y` / `ALL` from first available day) stored in metric prefs like other ranged tabs, or share one Positioning range — prefer one range control for chart 3 only so 1–2 stay stable.

## Durable low definition (charts 1–2)

Match Cav’s stated rule as closely as Binance daily closes allow:

- Candidate swing low: daily close at least **15%** below the prior **90-day** high.
- Not undercut for **60** calendar days after that low.
- Followed by a **15%** rally from that low (confirmed durable low).
- **Now**: the most recent candidate that meets the drawdown rule but is not yet confirmed (or the latest confirmed low if none pending). Mark it distinctly and label it unconfirmed when applicable.

Use Binance BTCUSDT perpetual daily closes for detection (same family as the 21 EMA tab). Document any unavoidable difference from Cav’s sample dates in the footnote if the event lists diverge.

## Metrics maths

### Contracts index (chart 1)

- Binance BTCUSDT perpetual open interest in contracts (or coin), converted to a **price-deflated** index: OI × (reference / price) so the series behaves like Cav’s “contracts” (USD OI deflated by price), indexed to a fixed start day = 100 when history begins.
- **30-day change into the low**: index at low ÷ index 30 days earlier − 1, as percent.

### Funding (charts 1–2)

- Binance BTCUSDT perpetual funding rates, compounded or averaged into a **7-day annualised** rate in percent (document the exact annualisation in code comments the same way existing metrics document theirs).
- **At the low**: 7-day annualised funding on the low day.
- **30-day change**: funding_at_low − funding_30d_before, in **points** (percentage points of annualised rate).

### Alt negative funding share (chart 3)

- Universe: Binance USDT-M perpetual symbols excluding BTCUSDT, capped to the top **N** by current OI (N chosen so load stays acceptable in the browser; start with N ≤ 50, raise only if tests show headroom).
- Each day (UTC): among those markets, OI-weighted share where funding &lt; 0.
- Display the **7-day trailing average** of that share as percent.
- If CORS or rate limits make live multi-symbol history too heavy, fall back to a prebuilt `alt-neg-funding.json` updated by the Pages workflow (same pattern as `put-flow.json`), still sourced only from Binance public endpoints — prefer live first; add the file only if live fails in real browsers.

## Data sources (no API keys)

| Need | Endpoint family |
| --- | --- |
| BTC daily closes | Existing `binanceCloses('perp', '1d', …)` |
| BTC OI history | Binance futures public open-interest history |
| BTC funding history | Binance futures public funding rate history |
| Alt symbols + OI + funding | Binance USDT-M exchangeInfo / premiumIndex / openInterest (and history endpoints as available) |

All fetches from the visitor’s browser when CORS allows; cache in-tab like other metrics (≈5 minutes). Cite Binance in the footnote.

## Architecture

- Extend `MetricTab` / `METRIC_TABS` / labels / tips in `src/app/metrics/settings.ts`.
- Wire the tab in `tabs.ts` (or equivalent) and `view.ts`: new render path `pos` that builds three panels.
- New helpers (keep pure and tested):
  - `durableLows(closes): { t, confirmed }[]`
  - `contractsIndex(oi, price): series`
  - `funding7dAnnualised(rates): series`
  - `altNegShare(days): series`
- Reuse `plot.ts` for scatter + time series; add a scatter layer only if missing (categories / x-numeric points).
- i18n: English strings first via existing `t()` keys; other locales can fall back to English until filled (same as prior metric addition if that was the pattern).
- Tests: unit tests for durable-low detection, contract % change, funding point change, and alt-share aggregation on fixtures; no network in unit tests.

## Error handling

- Partial failure: show which of the three charts failed; keep successful ones.
- Empty history / rate limit: clear message, retry on next open.
- If alt universe cannot be built, hide chart 3 with an explicit note rather than inventing zeros.

## Success criteria

- Positioning tab appears beside existing metric tabs; Chart remains default.
- Charts 1–2 show historical durable lows plus a distinct “now” point from live Binance BTC data.
- Chart 3 shows a continuous 7-day alt negative-funding share series from Binance.
- Footnote states Binance approximation vs Coinalyze top-300.
- Existing metric tabs and put-flow workflow unchanged.
- Unit tests for the new pure maths pass; site build succeeds.

## Open implementation detail (resolve during build, not product scope)

- Exact Binance OI history retention and whether a thin Pages-side cache is required for chart 3 — prefer browser-only; add workflow JSON only if needed after a real CORS/rate-limit check.
