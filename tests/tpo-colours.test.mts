import test from 'node:test';
import assert from 'node:assert/strict';
import { TPO_DEFAULTS, TPO_TWO_DEFAULTS, hasOwnTpoColors, readTpo, readTpoColors, withThemeTpoColors, withTpoColor } from '../src/app/tpo/settings.ts';
import { blocksOf, buildProfile } from '../src/app/tpo/model.ts';
import { paintTpo, snapOf, tpoInk, zones } from '../src/app/tpo/paint.ts';
import { togglePricePatch } from '../src/app/chart-type.ts';
import { View } from '../src/app/view.ts';
import { PALETTES } from '../src/app/theme.ts';
import { LabelBoard } from '../src/app/labels.ts';
import type { CandleRow } from '../src/app/store.ts';

const MIN = 60_000, HALF = 30 * MIN, DAY = 86_400_000;

test('the TPO\'s colours, opacities and value area method are read field by field, the rest falling back', () => {
  const s = readTpo({ on: true, va: 'cbot', colour: 'two', colors: { poc: '#FF0000', va: 'red', ib: '#00ff00', bogus: '#123456' }, inAlpha: 80, outAlpha: 35 });
  assert.equal(s.va, 'cbot'); assert.equal(s.colour, 'two');
  assert.deepEqual(s.colors, { poc: '#ff0000', ib: '#00ff00' }, 'only #rrggbb of known keys, lower case');
  assert.equal(s.inAlpha, 80); assert.equal(s.outAlpha, TPO_DEFAULTS.outAlpha, '35 is not one of the steps');
  const d = readTpo({});
  assert.equal(d.va, 'tv'); assert.deepEqual(d.colors, {}); assert.equal(d.inAlpha, 100); assert.equal(d.outAlpha, 40);
  assert.deepEqual(readTpoColors(null), {});
});

test('a colour chosen and taken back, and Reset colours', () => {
  let s = withTpoColor(readTpo({}), 'naked', '#ABCDEF');
  assert.deepEqual(s.colors, { naked: '#abcdef' }); assert.ok(hasOwnTpoColors(s));
  s = withTpoColor(s, 'naked', null);
  assert.deepEqual(s.colors, {}); assert.ok(!hasOwnTpoColors(s));
  s = { ...withTpoColor(s, 'poc', '#111111'), outAlpha: 70, colour: 'two' };
  assert.ok(hasOwnTpoColors(s));
  const back = withThemeTpoColors(s);
  assert.deepEqual(back.colors, {}); assert.equal(back.outAlpha, 40); assert.equal(back.colour, 'two', 'the look chosen is kept');
  assert.deepEqual(withTpoColor(s, 'va', 'not a colour').colors, { poc: '#111111' });
});

test('the colours a frame paints with: the chosen one, else the theme\'s', () => {
  const p = PALETTES.dark!;
  const theme = tpoInk(TPO_DEFAULTS, p);
  assert.equal(theme.poc, p.poc); assert.equal(theme.va, p.poc); assert.equal(theme.naked, p.poc); assert.equal(theme.two, null); assert.equal(theme.pocSw, null);
  assert.equal(theme.inA, 1); assert.equal(theme.outA, 0.4);
  const own = tpoInk({ ...TPO_DEFAULTS, colour: 'two', colors: { poc: '#ff00ff', outside: '#101010' } }, p);
  assert.equal(own.poc, '#ff00ff'); assert.equal(own.naked, '#ff00ff', 'the carried POCs follow the POC\'s own colour until given theirs');
  assert.equal(own.two![0].fill, 'rgb(41,98,255)', `inside: TradingView's blue ${TPO_TWO_DEFAULTS.inside}`); assert.equal(own.two![1].fill, 'rgb(16,16,16)');
  assert.equal(own.pocSw!.fill, 'rgb(255,0,255)');
});

test('runs of single prints become zones', () => {
  assert.deepEqual(zones([7, 3, 4, 5, 9, 10]), [[3, 5], [7, 7], [9, 10]]);
  assert.deepEqual(zones([]), []);
});

test('cells snap to the device pixel grid of the canvas transform', () => {
  const at = (a: number, e: number) => snapOf({ getTransform: () => ({ a, d: a, e, f: 0 }) } as unknown as CanvasRenderingContext2D);
  const two = at(2, 0);
  assert.equal(two.x(10.3), 10.5); assert.equal(two.x(10.2), 10); assert.equal(two.px, 0.5);
  // Translated by the columns left of the plot (in device pixels): the edges still land on whole device pixels.
  const moved = at(1.5, 61);
  for (const v of [0.1, 3.7, 99.99]) { const d = moved.x(v) * 1.5 + 61; assert.ok(Math.abs(d - Math.round(d)) < 1e-9, `${v}`); }
  const none = snapOf({} as CanvasRenderingContext2D);
  assert.equal(none.x(3.3), 3.3);
});

test('the eye on the legend hides the price as Hidden does, and brings it back in its type', () => {
  const show = { candles: true, volume: true };
  assert.deepEqual(togglePricePatch('outline', show), { show: { candles: false, volume: true } });
  assert.deepEqual(togglePricePatch('outline', { ...show, candles: false }), { chartType: 'outline', show: { candles: true, volume: true } });
});

/** A canvas that records each rectangle filled, with its colour and alpha. */
function fillsCanvas(): { ctx: CanvasRenderingContext2D; fills: { style: string; alpha: number; r: number[] }[]; strokes: string[] } {
  const out = { fills: [] as { style: string; alpha: number; r: number[] }[], strokes: [] as string[], ctx: null as unknown as CanvasRenderingContext2D };
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', globalAlpha: 1 };
  const noop = (): void => {};
  out.ctx = new Proxy({}, {
    get: (_t, k) => k === 'fillRect' ? (...r: number[]) => { out.fills.push({ style: String(state.fillStyle), alpha: Number(state.globalAlpha), r }); }
      : k === 'stroke' ? () => { out.strokes.push(String(state.strokeStyle)); }
      : k === 'measureText' ? () => ({ width: 10 }) : typeof k === 'string' && k in state ? state[k] : noop,
    set: (_t, k, v) => { state[k as string] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return out;
}

test('Two colours: the value area\'s blocks in one colour, the rest in the other at their own opacity; the POC row and lines in the POC\'s colour', () => {
  // A day of half hours swinging around 100, rows of 1.
  const rows: CandleRow[] = [];
  for (let i = 0; i < 48; i++) { const mid = 100 + Math.round(6 * Math.sin(i / 5)); rows.push([i * HALF, mid, mid + 2, mid - 2, mid, 1] as unknown as CandleRow); }
  const prof = buildProfile({ key: 'd', from: 0, to: DAY }, blocksOf(rows, 0, DAY, HALF, HALF, 2 * DAY), HALF, 1, 0.7, 2 * DAY)!;
  const view = new View({ t0: -DAY / 4, t1: 1.5 * DAY, p0: 85, p1: 115 });
  const c = fillsCanvas();
  const settings = { ...TPO_DEFAULTS, on: true, look: 'blocks' as const, colour: 'two' as const, colors: { inside: '#0000ff', outside: '#888888', poc: '#ffff00', va: '#00ffff' }, outAlpha: 60 };
  const geos = paintTpo(c.ctx, { profiles: [prof], settings, view, pw: 800, ph: 600, p: PALETTES.dark!, labels: new LabelBoard(), fold: 0, rank: () => 0, name: () => '', now: 2 * DAY, linesFor: () => false });
  assert.equal(geos.length, 1); assert.ok(!geos[0]!.compact);
  const by = (style: string) => c.fills.filter(f => f.style === style);
  assert.ok(by('rgb(0,0,255)').length > 0 && by('rgb(0,0,255)').every(f => f.alpha === 1), 'inside, full');
  assert.ok(by('rgb(136,136,136)').length > 0 && by('rgb(136,136,136)').every(f => Math.abs(f.alpha - 0.6) < 1e-9), 'outside, at 60 %');
  assert.equal(by('rgb(255,255,0)').length, prof.counts.get(prof.poc), 'one POC cell a block in its row');
  assert.ok(c.strokes.includes('#ffff00'), 'the POC line'); assert.ok(c.strokes.filter(s => s === '#00ffff').length >= 2, 'the VAH and VAL lines');
  // Every cell of one row is as tall as every other (snapped edges; here the transform is the identity).
  const heights = new Set(by('rgb(0,0,255)').map(f => f.r[3]));
  assert.equal(heights.size, 1);
});
