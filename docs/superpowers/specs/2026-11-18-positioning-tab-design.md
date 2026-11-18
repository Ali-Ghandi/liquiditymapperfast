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
- Footnote on the tab: Binance-only approximation of Cav’s Coinalyze top-300 charts; durable-low rule stated briefly; “now” may be unconfirmed; how our sample of lows differs from Cav’s (ours from the first low in the data, Dec 2019; counts with open interest, with funding and since 2022 all computed from the data, against Cav’s 11 since 2022; closes here, wicks and 10-day swing lows there); any loader that failed (archive, closes, live funding, live open interest, live alt share).
- No new range chips required for charts 1–2 (event set is the full history we can compute). Chart 3 may reuse a simple range set (`1Y` / `2Y` / `ALL` from first available day) stored in metric prefs like other ranged tabs, or share one Positioning range — prefer one range control for chart 3 only so 1–2 stay stable. While the alt-share history is under a month long the chips are disabled, with a visible note under them saying why (not only a tooltip, so it reads on a phone).

## Durable low definition (charts 1–2)

Adopt Cav’s rule exactly (decided 2026-11-19), as far as Binance daily closes allow. His footnote: “Durable low = a swing low (lowest daily low of the prior 10 days) at least 15% below the prior 90-day intraday high, not undercut by any wick for the next 60 days, and followed by a close at least 15% higher within those 60 days; a qualifying low within 60 days of the previous one is a retest of the same episode and is not counted.”

- Candidate swing low: daily close at least **15%** below the prior **90-day** high (highest close); each run of such days gives one low, at its minimum close.
- Not undercut (no close below it) for **60** calendar days after that low, inclusive.
- Followed by a close at least **15%** higher **within those 60 days** (confirmed durable low). A low that held 60 days without that rally has **failed**: it is neither confirmed nor pending.
- **Retests**: a low within 60 days (inclusive) of the previous accepted low — confirmed, or the pending one — is the same episode and is not counted.
- Remaining differences from Cav: closes instead of wicks and intraday highs, and runs of drawdown days instead of 10-day swing lows. On data to 2026-11-17 this gives 11 confirmed lows since 2022, the same count as Cav’s, but not the same set: ours has Jan 2022 and lacks his Nov 2025 (on closes its rally falls just short of 15%), and three dates shift by weeks (Sep vs Aug 2023, Sep vs Aug 2024, Jun 30 vs Jul 2026).
- **Now**: the most recent low whose 60-day window is still open — no close under it so far, not yet confirmed (a *pending* low). If no low is pending, **now falls back to today**: the last closed day, with its own 30-day changes, the way Cav’s red dot is today’s reading (“not yet a confirmed low”). Re-highlighting the latest confirmed low would add nothing, since it is already plotted. Mark now distinctly; the headline says “Into the pending low of …” or “No pending low. Last 30 days to …”, and the readout says “pending low, unconfirmed” or “today, not a low”.
- If now has no contracts change (no open interest for its days), it is left out of chart 1 and the headline makes no claim about how many lows saw contracts grow faster.

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
- Display the **7-day trailing average** of that share as percent: the mean of the daily readings held in the 7 days ending on each day. Until a window holds 7 readings it is labelled “mean of *n* readings”, not “7d mean”. Each daily reading is a grey dot drawn over the mean line; while the history is short the mean is also marked each day as a small purple dot on top, so both show where they coincide.
- The live reading (taken when the tab opens, on today’s UTC day) is drawn as its own red dot with its value; when it cannot be read, no red dot is drawn and the legend says it is unavailable.
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
