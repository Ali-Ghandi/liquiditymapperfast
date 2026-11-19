import test from 'node:test';
import assert from 'node:assert/strict';
import { candleBodyPx, candleRects, candleWickPx } from '../src/app/candle-geometry.ts';

test('a body is about 80 % of the bar spacing, as TradingView sizes it', () => {
  assert.equal(candleBodyPx(7, 1), 5);
  assert.equal(candleBodyPx(10, 1), 8);
  assert.equal(candleBodyPx(3, 1), 3, 'three pixels between 2.5 and 4');
  assert.equal(candleBodyPx(3, 2), 6);
  assert.equal(candleBodyPx(1, 1), 1, 'at least a pixel');
  assert.equal(candleBodyPx(7, 2), 11);
  for (const s of [5, 8, 12, 20, 40]) { const w = candleBodyPx(s, 1); assert.ok(w >= s * 0.7 && w <= s, `${s}px: ${w}`); }
});

test('the wick is one device pixel a CSS pixel, never wider than the spacing', () => {
  assert.equal(candleWickPx(7, 1), 1);
  assert.equal(candleWickPx(7, 2), 2);
  assert.equal(candleWickPx(7, 1.5), 1);
  assert.equal(candleWickPx(0.3, 2), 1);
});

test('the wick is centred on the body: their widths share a parity, every edge on a whole pixel', () => {
  for (const [body, wick] of [[8, 1], [7, 1], [11, 2], [12, 2], [5, 1]] as const) {
    const r = candleRects(100.4, 50.3, 80.6, 20.2, 99.7, body, wick);
    assert.equal((r.body.w - r.wick.w) % 2, 0, `${body}/${wick}`);
    assert.equal(r.body.x * 2 + r.body.w, r.wick.x * 2 + r.wick.w, 'same middle');
    for (const v of [r.body.x, r.body.y, r.body.w, r.body.h, r.wick.x, r.wick.y, r.wick.w, r.wick.h]) assert.ok(Number.isInteger(v));
  }
  const r = candleRects(100, 50, 80, 20, 100, 8, 1);
  assert.deepEqual(r.body, { x: 97, y: 50, w: 7, h: 30 });
  assert.deepEqual(r.wick, { x: 100, y: 20, w: 1, h: 80 });
});

test('a doji is a one-pixel body; a candle with no range still shows', () => {
  const r = candleRects(10, 40.2, 40.3, 40.2, 40.3, 5, 1);
  assert.equal(r.body.h, 1);
  assert.ok(r.wick.h >= 1);
  const thin = candleRects(10, 40, 60, 30, 70, 1, 1);
  assert.equal(thin.body.w, 1, 'very zoomed out: body and wick one line');
});
