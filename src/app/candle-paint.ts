import { candleRects } from './candle-geometry.ts';
import type { CandleInk } from './candle-colours.ts';

/**
 * Filled candles drawn the way TradingView draws them (candle-geometry.ts): in device pixels, every edge on a whole one, the wick centred on the
 * body and in the body's colour unless one of its own was picked, a border only where one of its own was. All of a frame's candles go into one
 * path a colour, and a thin rim (one CSS pixel, in a colour that sinks into the page's background and stands out from bright heat) is laid
 * under them all first, so it never covers a neighbour.
 */
export class CandleBatch {
  readonly #bodies = new Map<string, Path2D>();
  readonly #wicks = new Map<string, Path2D>();
  readonly #borders = new Map<string, Path2D>();
  readonly #rim = new Path2D();
  #count = 0;
  /**
   * `dpr`: device pixels a CSS pixel; `offX`, `offY`: where the plot's (0, 0) is in device pixels (the context's transform: the columns left of it); `bodyPx`, `wickPx`: the
   * widths from `candleBodyPx` and `candleWickPx`; `rimPx`: the rim's width in device pixels, 0 for none.
   */
  constructor(readonly dpr: number, readonly offX: number, readonly offY: number, readonly bodyPx: number, readonly wickPx: number, readonly rimPx: number) {}

  #path(map: Map<string, Path2D>, color: string): Path2D {
    let p = map.get(color);
    if (!p) { p = new Path2D(); map.set(color, p); }
    return p;
  }

  /** One candle, its centre `x` and its rows in the plot's CSS pixels; what it is drawn in (`candleInk`). Returns the body in CSS pixels. */
  add(x: number, open: number, close: number, high: number, low: number, ink: CandleInk): { x: number; y: number; w: number; h: number } {
    const r = this.dpr, { body, wick } = candleRects(x * r + this.offX, open * r + this.offY, close * r + this.offY, high * r + this.offY, low * r + this.offY, this.bodyPx, this.wickPx);
    this.#path(this.#wicks, ink.wick).rect(wick.x, wick.y, wick.w, wick.h);
    const edge = Math.max(1, Math.floor(r));
    if (ink.border !== ink.body && body.w > 2 * edge && body.h > 2 * edge) {
      this.#path(this.#borders, ink.border).rect(body.x, body.y, body.w, body.h);
      this.#path(this.#bodies, ink.body).rect(body.x + edge, body.y + edge, body.w - 2 * edge, body.h - 2 * edge);
    } else this.#path(this.#bodies, ink.body).rect(body.x, body.y, body.w, body.h);
    const m = this.rimPx;
    if (m > 0) { this.#rim.rect(body.x - m, body.y - m, body.w + 2 * m, body.h + 2 * m); this.#rim.rect(wick.x - m, wick.y - m, wick.w + 2 * m, wick.h + 2 * m); }
    this.#count++;
    return { x: (body.x - this.offX) / r, y: (body.y - this.offY) / r, w: body.w / r, h: body.h / r };
  }

  /** Draw what was added: the rim, then the wicks, the borders and the bodies, in device pixels whatever the context's transform. */
  /** A batch for the context as it is now set up: its scale is the device pixels a CSS pixel, its translation where the plot begins. */
  static for(ctx: CanvasRenderingContext2D, bodyPx: number, wickPx: number, rimPx: number): CandleBatch {
    const m = ctx.getTransform();
    return new CandleBatch(m.a || 1, m.e, m.f, bodyPx, wickPx, rimPx);
  }

  flush(ctx: CanvasRenderingContext2D, rim: string): void {
    if (!this.#count) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    if (this.rimPx > 0) { ctx.fillStyle = rim; ctx.fill(this.#rim); }
    for (const [color, p] of this.#wicks) { ctx.fillStyle = color; ctx.fill(p); }
    for (const [color, p] of this.#borders) { ctx.fillStyle = color; ctx.fill(p); }
    for (const [color, p] of this.#bodies) { ctx.fillStyle = color; ctx.fill(p); }
    ctx.restore();
  }
}
