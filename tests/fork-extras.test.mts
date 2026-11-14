import test from 'node:test';
import assert from 'node:assert/strict';
import { nakedPocs } from '../src/app/tpo/model.ts';
import { TPO_DEFAULTS, readTpo } from '../src/app/tpo/settings.ts';
import { forkSettings } from '../src/app/fork-defaults.ts';
import { readSettings } from '../src/app/store.ts';

const W = 7 * 86_400_000;
/** A window `i` weeks in, its point of control at row `poc` (rows of 100), trading `low`..`high`. */
const win = (i: number, poc: number, low: number, high: number, developing = false) => ({ key: `w${i}`, from: i * W, to: (i + 1) * W, poc, R: 100, low, high, developing });

test('a closed window\'s TPO point of control stays naked until a later window trades through it', () => {
  // POCs at 70,050 / 75,050 / 72,050; the last week under way trades 71,000..73,000.
  const list = [win(0, 700, 69_000, 71_000), win(1, 750, 74_000, 76_000), win(2, 720, 71_500, 74_500), win(3, 725, 71_000, 73_000, true)];
  assert.deepEqual(nakedPocs(list).map(n => [n.key, n.price]), [['w0', 70_050], ['w1', 75_050]], 'week 2\'s POC is traded through by the week under way; week 3 is under way');
  assert.deepEqual(nakedPocs([...list].reverse()).map(n => n.key), ['w0', 'w1'], 'order does not matter');
  assert.deepEqual(nakedPocs([win(0, 700, 69_000, 71_000)]), [], 'the newest window tests the others and is not one');
  assert.deepEqual(nakedPocs([]), []);
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
