/**
 * Where a candle's body and wick fall in device pixels, the way TradingView draws them (Lightweight Charts' `optimalCandlestickWidth` and its
 * candlestick renderer, Apache-2.0): a body about 80-85 % of the bar spacing, three device pixels between 2.5 and 4 CSS px spacing, at least one;
 * a wick one device pixel wide on a 1x screen and `floor(dpr)` on a sharper one; the body's width of the wick's parity, so the wick stands
 * exactly in its middle; every edge on a whole device pixel, so nothing is blurred across two (a user, 2026-11-19: "candles just look ugly").
 */

/** The body's width in device pixels for bars `spacing` CSS px apart on a screen of `dpr` device pixels a CSS pixel. */
export function candleBodyPx(spacing: number, dpr: number): number {
  const r = dpr > 0 ? dpr : 1;
  if (!(spacing > 0)) return Math.max(1, Math.floor(r));
  if (spacing >= 2.5 && spacing <= 4) return Math.floor(3 * r);
  const coeff = 1 - 0.2 * Math.atan(Math.max(4, spacing) - 4) / (Math.PI * 0.5);
  const res = Math.floor(spacing * coeff * r), scaled = Math.floor(spacing * r);
  return Math.max(Math.floor(r), Math.min(res, scaled), 1);
}

/** The wick's width in device pixels: floor(dpr), never wider than the bar spacing, at least one. */
export function candleWickPx(spacing: number, dpr: number): number {
  const r = dpr > 0 ? dpr : 1;
  return Math.max(1, Math.min(Math.floor(r), Math.floor(Math.max(0, spacing) * r)));
}

/** A rectangle in device pixels, whole numbers. */
export interface PxRect { x: number; y: number; w: number; h: number }

/**
 * A candle's body and wick in device pixels: `x` its centre and `open`, `close`, `high`, `low` its rows, all in device pixels already (CSS
 * coordinates times dpr, offsets included); `bodyPx` and `wickPx` from the two above. The body is made one narrower where its parity is not
 * the wick's (so the wick is centred), and no narrower than the wick; it is at least one pixel tall, a doji a crisp line. The wick runs from the
 * high to the low, at least one pixel.
 */
export function candleRects(x: number, open: number, close: number, high: number, low: number, bodyPx: number, wickPx: number): { body: PxRect; wick: PxRect } {
  let bw = Math.max(1, Math.round(bodyPx));
  const ww = Math.max(1, Math.min(bw, Math.round(wickPx)));
  if (bw > ww && (bw - ww) % 2 !== 0) bw -= 1;
  const cx = Math.round(x);
  const bodyLeft = cx - Math.floor(bw / 2), wickLeft = cx - Math.floor(ww / 2);
  let top = Math.round(Math.min(open, close)), bottom = Math.round(Math.max(open, close));
  if (bottom - top < 1) bottom = top + 1;
  let wt = Math.round(Math.min(high, low)), wb = Math.round(Math.max(high, low));
  if (wb - wt < 1) wb = wt + 1;
  // The wick always reaches the body, whatever rounding did to either.
  wt = Math.min(wt, top); wb = Math.max(wb, bottom);
  return { body: { x: bodyLeft, y: top, w: bw, h: bottom - top }, wick: { x: wickLeft, y: wt, w: ww, h: wb - wt } };
}
