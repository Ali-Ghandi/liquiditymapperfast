# Plan: autoscale + TradingView candles

1. `auto-scale.ts` + `tests/auto-scale.test.mts`: visibleRange, autoScaleView, easeRange (TDD).
2. `candle-geometry.ts` + `tests/candle-geometry.test.mts`: TV width, wick parity, device-pixel rects (TDD).
3. `heat-zoom.ts`: `wheelAxes(region, shift, auto)`, `WheelInput.auto` (tests extended).
4. `heat-pane.ts`: `#autoScale` state and per-frame fit in `#render`; gestures time-only while on; switches off on price gestures; "A" button,
   dblclick on axis; `fit()` turns it on.
5. Candle drawing: filled branch of `#paintCandles` and `#paintZoomed` on candle-geometry; `candleInk` filled border/wick = body; themes'
   TV colours; colours panel default shown; tests updated.
6. Full `npm test`, `npm run build`, push to master, watch the Pages Action, check live assets; headless Chrome screenshots zoomed in/out.
