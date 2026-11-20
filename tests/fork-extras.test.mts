import test from 'node:test';
import assert from 'node:assert/strict';
import { pocRuns } from '../src/app/tpo/model.ts';
import { TPO_DEFAULTS, readTpo } from '../src/app/tpo/settings.ts';
import { forkSettings } from '../src/app/fork-defaults.ts';
import { readSettings } from '../src/app/store.ts';

const W = 7 * 86_400_000;
/**
 * A window `i` weeks in, its point of control at row `poc` (rows of 100), trading `low`..`high`: one block a day, each spanning `low`..`high`
 * unless `days` gives the days' own ranges.
 */
const DAYMS = 86_400_000;
const win = (i: number, poc: number, low: number, high: number, developing = false, days?: [number, number][]) => ({
  key: `w${i}`, from: i * W, to: (i + 1) * W, poc, R: 100, low, high, developing,
  blocks: (days ?? Array.from({ length: 7 }, () => [low, high] as [number, number])).map(([l, h], d) => ({ t: i * W + d * DAYMS, l, h })) as never[],
});
const naked = (list: Parameters<typeof pocRuns>[0]) => pocRuns(list).filter(r => r.until === null);

test('a closed window\'s TPO point of control runs on until a later block trades through it (TradingView\'s extend until intersected)', () => {
  // POCs at 70,050 / 75,050 / 72,050; the last week under way trades 71,000..73,000 only from its third day.
  const list = [win(0, 700, 69_000, 71_000), win(1, 750, 74_000, 76_000), win(2, 720, 71_500, 74_500), win(3, 725, 71_000, 73_000, true, [[73_500, 74_000], [72_600, 73_400], [71_000, 72_500]])];
  assert.deepEqual(naked(list).map(n => [n.key, n.price]), [['w0', 70_050], ['w1', 75_050]], 'week 2\'s POC is traded through by the week under way; week 3 is under way');
  assert.deepEqual(naked([...list].reverse()).map(n => n.key), ['w0', 'w1'], 'order does not matter');
  const runs = pocRuns(list);
  assert.equal(runs.length, 3, 'every closed window has a run; the one under way has none');
  const w2 = runs.find(r => r.key === 'w2')!;
  assert.equal(w2.from, 3 * W, 'from the end of its window');
  assert.equal(w2.until, 3 * W + 2 * DAYMS, 'to the start of the first block that reached 72,050: the third day, not the window\'s start');
  assert.deepEqual(naked([win(0, 700, 69_000, 71_000)]).map(n => n.key), ['w0'], 'the newest closed window is naked until something trades through it');
  assert.deepEqual(pocRuns([win(0, 700, 69_000, 71_000, true)]), [], 'a window under way has none');
  assert.deepEqual(pocRuns([]), []);
});

test('every new feature is a switch that starts off, on the fork\'s desk too; the current look is unchanged', () => {
  assert.equal(TPO_DEFAULTS.naked, false);
  assert.equal(readTpo({}).naked, false);
  assert.equal(readTpo({ naked: true }).naked, true, 'kept when switched on');
  assert.equal(readTpo({ naked: 'yes' }).naked, false);
  const s = readSettings(JSON.parse(JSON.stringify(forkSettings(Date.UTC(2026, 10, 14)))));
  assert.equal(s.tpo.naked, false, 'naked POCs off');
  assert.equal(s.traded.profiles, null, 'no volume profile in each window');
  assert.equal(s.show.funding, false, 'no Funding pane'); assert.equal(s.show.delta, false, 'no CVD (Delta) pane');
  assert.equal(s.delta.style, 'candles', 'the Delta pane, once on, draws CVD candles');
  assert.equal(s.show.oi, true, 'the OI pane as before');
});
