import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_MIN_SHARE, autoScaleView, easeRange, mergeRange, visibleRange, withPrice } from '../src/app/panes/auto-scale.ts';
import type { CandleRow } from '../src/app/store.ts';

const H = 3_600_000;
const row = (t: number, o: number, h: number, l: number, c: number): CandleRow => [t, o, h, l, c, 1] as unknown as CandleRow;
// A trend: hour i trades between 100 + i and 110 + i.
const trend: CandleRow[] = Array.from({ length: 200 }, (_, i) => row(i * H, 102 + i, 110 + i, 100 + i, 104 + i));

test('the visible range is the high and low of the candles that overlap the window, and only those', () => {
  assert.deepEqual(visibleRange(trend, H, 10 * H, 20 * H), { lo: 110, hi: 129 }, 'candles 10..19');
  assert.deepEqual(visibleRange(trend, H, 10.5 * H, 19.2 * H), { lo: 110, hi: 129 }, 'a candle part on screen counts');
  assert.deepEqual(visibleRange(trend, H, 0, 200 * H), { lo: 100, hi: 309 }, 'zoomed out: the whole run');
  assert.equal(visibleRange(trend, H, 500 * H, 600 * H), null, 'nothing on screen');
  assert.equal(visibleRange([], H, 0, H), null);
  assert.equal(visibleRange(trend, H, 5 * H, 5 * H), null, 'no span');
});

test('zooming out widens the fit, panning moves it: the axis follows what is on screen', () => {
  const narrow = visibleRange(trend, H, 150 * H, 160 * H)!, wide = visibleRange(trend, H, 60 * H, 160 * H)!;
  assert.ok(wide.hi - wide.lo > 4 * (narrow.hi - narrow.lo));
  const a = autoScaleView(narrow, { plotH: 500, top: 40, bottom: 40, ref: 250 })!, b = autoScaleView(wide, { plotH: 500, top: 40, bottom: 40, ref: 250 })!;
  assert.ok(b.p0 < a.p0 && b.p1 >= a.p1 - 1e-9);
});

test('the fit leaves the margins asked, in pixels', () => {
  const v = autoScaleView({ lo: 100, hi: 200 }, { plotH: 500, top: 40, bottom: 60, ref: 150 })!;
  const y = (p: number): number => (1 - (p - v.p0) / (v.p1 - v.p0)) * 500;
  assert.ok(Math.abs(y(200) - 40) < 1e-9, 'the high 40 px from the top');
  assert.ok(Math.abs(y(100) - 440) < 1e-9, 'the low 60 px from the foot');
});

test('a flat range is widened to the least share of the price; margins never eat the plot', () => {
  const v = autoScaleView({ lo: 100, hi: 100 }, { plotH: 400, top: 0, bottom: 0, ref: 100 })!;
  assert.ok(Math.abs((v.p1 - v.p0) - 100 * AUTO_MIN_SHARE) < 1e-9);
  assert.ok(Math.abs((v.p0 + v.p1) / 2 - 100) < 1e-9);
  const m = autoScaleView({ lo: 0.5, hi: 1 }, { plotH: 100, top: 80, bottom: 80, ref: 1 })!;
  const y = (p: number): number => (1 - (p - m.p0) / (m.p1 - m.p0)) * 100;
  assert.ok(y(1) < y(0.5) && y(0.5) - y(1) >= 30 - 1e-9, 'at least 30 % of the height for the candles');
  assert.equal(autoScaleView(null, { plotH: 100, top: 0, bottom: 0, ref: 1 }), null);
});

test('ranges merge, and the live price widens one', () => {
  assert.deepEqual(mergeRange({ lo: 1, hi: 3 }, { lo: 2, hi: 5 }), { lo: 1, hi: 5 });
  assert.deepEqual(mergeRange(null, { lo: 2, hi: 5 }), { lo: 2, hi: 5 });
  assert.equal(mergeRange(null, null), null);
  assert.deepEqual(withPrice({ lo: 1, hi: 3 }, 4), { lo: 1, hi: 4 });
  assert.deepEqual(withPrice({ lo: 1, hi: 3 }, 0), { lo: 1, hi: 3 });
  assert.deepEqual(withPrice(null, 2), { lo: 2, hi: 2 });
});

test('the ease glides to the fit and lands on it', () => {
  let cur = { p0: 100, p1: 200 };
  const target = { p0: 120, p1: 260 };
  const first = easeRange(cur, target, 16, 500);
  assert.equal(first.settled, false);
  assert.ok(first.p0 > 100 && first.p0 < 120 && first.p1 > 200 && first.p1 < 260, 'part of the way');
  let frames = 0, r = first;
  while (!r.settled && frames < 200) { cur = r; r = easeRange(cur, target, 16, 500); frames++; }
  assert.ok(r.settled && frames < 40, `lands within a few frames (${frames})`);
  assert.deepEqual({ p0: r.p0, p1: r.p1 }, target);
  assert.deepEqual(easeRange({ p0: 0, p1: 0 }, target, 16, 500), { ...target, settled: true }, 'no axis yet: at once');
  assert.deepEqual(easeRange({ p0: 1, p1: 2 }, { p0: 60_000, p1: 61_000 }, 16, 500), { p0: 60_000, p1: 61_000, settled: true }, 'another market: at once');
});
