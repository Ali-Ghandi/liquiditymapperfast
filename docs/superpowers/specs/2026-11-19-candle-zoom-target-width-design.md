# Candle zoom: TradingView-like target width

**Date:** 2026-11-19  
**Repo:** Ali-Ghandi/liquiditymapperfast  
**Status:** Approved direction (owner: "go for it"; pain: zoom-out locks candles like a photo)

## Problem

Zooming out scales the selected timeframe's candles like a bitmap. They shrink toward ~2 px before we re-aggregate (`CANDLE_LINE_PX` / `STRIP_MIN_PX`). TradingView keeps candle bodies roughly constant width and changes the effective bar length as the visible range changes.

## Goal

While zooming the map (wheel, pinch, right-drag), candles stay readable at a stable body width. Heatmap, liquidations, drawings, and the rest keep the existing zoom engine and stay locked to the same view.

## Non-goals

- Replacing the map with Lightweight Charts or Advanced Charts.
- Auto-changing the user's selected timeframe in the toolbar.
- Inventing bars finer than the selected timeframe when zooming in.
- Redesigning candle colours, outlines, or glass/trail layers.

## Approach (chosen)

**Target-width aggregation.** Keep the current `stripTimeframe` + `zoomedCandles` path. Raise the pixel threshold used for **candle** aggregation so we step to the next whole multiple of the chart TF as soon as bars would fall under a TradingView-like width (~7 CSS px), not at 2 px.

Volume strip may keep its own min (or match later); candle readability is the primary fix.

## Behaviour

1. Let `chartTf` be the selected timeframe ms, `span = t1 - t0`, `pw = plotW`.
2. Candle draw length `drawnTf` = shortest timeframe `ms` in `TIMEFRAMES` such that `ms` is a whole multiple of `chartTf` (or equal), `ms >= chartTf`, and `pw * ms / span >= CANDLE_TARGET_PX` (default **7**). Cap at `1d` as today.
3. If even `1d` is still narrower than the target, keep `1d` (same as today's day cap).
4. If the chart TF already meets the target, draw the chart's own candles (no aggregation).
5. Zooming in never picks a TF shorter than the selected one.
6. Heatmap columns, price/time axes, and overlays continue to use the view `{t0,t1,p0,p1}` unchanged.

## Files

- `src/app/price-line.ts` — introduce `CANDLE_TARGET_PX` (candles' preferred width); keep `CANDLE_LINE_PX` as the hard floor for the thin-line fallback.
- `src/app/measures/volume-strip.ts` — `stripTimeframe` already takes `min`; no API change required.
- `src/app/panes/heat-pane.ts` — `drawnTf` / volume-strip candle path pass `CANDLE_TARGET_PX` into `stripTimeframe` for candle length.
- Tests: `tests/zoomed-candles.test.mts`, `tests/volume-strip.test.mts` (and any heat-pane tests that encode the 2 px rule for candles).

## Success criteria

- At a ~45-day window on a ~1500 px plot with hourly selection, candles draw as 4h (or longer) with body width ≥ ~7 px, not as sub-2 px hourly sticks.
- Pinch/wheel zoom out no longer looks like photo pinch; bars re-bin at each step of the TF ladder.
- `npm test`, typecheck, and `build:site` pass.
- Live Pages deploy shows the behaviour; screenshot before/after on desktop zoom-out.

## Risks

- Coarser candles sooner may surprise users who liked dense micro-structure while zoomed out; mitigated by keeping the selected TF for scripts/data and only changing **draw** length.
- Price-history coarse reads must still align with `drawnTf` (already keyed off it).
