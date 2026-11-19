# Price autoscale and TradingView-style candles (2026-11-19)

## Problem
The user, after the target-width re-binning shipped: "Candles just look ugly" and "when I zoom out, candles don't correct vertically".

What the code did:
- The price axis was framed once, by `fit()` (on open, on Recenter, after a timeframe change), `goTo`, `placeAt`. Nothing refits it when the
  time span changes. The mouse wheel on the plot zoomed time AND price by the same factor (`wheelAxes('plot')` = both, "the picture keeps its
  shape"), which is exactly the "zooming out of a picture" feel. While following live, `followPrice` only recentred the price once it reached
  the top/bottom tenth. So zooming out squashed the candles into the middle; panning left to older prices left them off screen.
- Filled candles were drawn with the theme's edge (white on dark, near-black on light) as border and wick, a 1.5 px halo around body and a 3.5 px
  halo around the wick, sub-pixel body edges (x - body/2 at fractional CSS px, with no device-pixel snapping) and a 1.6 px wick: blurry, outlined,
  "ugly" next to TradingView's flat, crisp bodies.

## Design
### Autoscale (TradingView's "Auto (fits data to screen)")
- `src/app/panes/auto-scale.ts`, pure: `visibleRange(rows, tf, t0, t1)` (binary search, high/low of rows overlapping the window),
  `autoScaleView(range, {plotH, top, bottom, ref})` (margins in px: 8 % top; 8 % bottom, or clear of the Volume strip when it shows),
  `easeRange(cur, target, dt, plotH)` (exponential ease, ~70 ms time constant, snaps under a quarter pixel).
- `HeatPane.#autoScale` (default on, never persisted). Each frame, unless the tour's demonstration holds the view, the target is computed from
  the candles drawn (the zoomed rows when re-binned, else the chart's candles with the exchange's history), merged with the price-history line's
  range where that line is shown, and the live price while the live edge is on screen; the view's p0/p1 ease to it. `followPrice` is skipped
  while autoscale is on (the fit keeps the live candle on screen anyway).
- While on: the wheel on the plot zooms time only (price is the fit's); a drag/touch pan/fling moves time only; a pinch scales time only; a
  right-button drag zooms time only. Turning it off, as TradingView does: wheel or drag on the price scale, Alt+wheel, a pan that moves the price
  on purpose (`holdsPrice`: 24 px and more vertical than horizontal), a right-drag mostly vertical, a touch drag on the price axis.
- Turning it back on: an "A" button at the foot of the price axis (lit while on), double-click on the price axis, double-click/double-tap on the
  chart / Recenter (`fit`).
- Heatmap, liquidations, drawings, glass all read the same `view`, so they rescale together; the raster is redone only when the view leaves
  the raster's coverage (`#manageRaster`), so the per-frame ease is cheap.

### Candles
- `src/app/candle-geometry.ts`, pure: TradingView's `optimalCandlestickWidth` (Lightweight Charts, Apache-2.0): about 80-85 % of the bar
  spacing, 3 device px between 2.5 and 4 px spacing, at least one device pixel; the wick `floor(dpr)` wide; body width made the wick's parity
  so the wick is exactly centred; every edge rounded to device pixels; bodies at least 1 device px tall.
- Drawn with an identity transform in device pixels, batched per colour (Path2D), for the chart's own candles and the zoomed-out longer ones.
- Colours: filled candles' border and wick are now the body's colour (TradingView), unless the user picked their own; the Newsprint (this fork's default), Light,
  Dark and Darker themes use TradingView's current candle colours, up `#089981`, down `#f23645`. Other themes keep their schemes' colours.
- The heavy halo is replaced by a 1 CSS px contrast rim (dark rim on dark themes, light on light), invisible on the plain background, keeping
  candles legible over bright heat.
- Outline candles, OHLC bars, the line, the trade-dust hollow mode and the footprint's narrowed candles keep their existing drawing.
- Text that described the old wheel (tour steps, the guide's zoom caption) is updated in all 11 language packs.
