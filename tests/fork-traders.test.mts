import test from 'node:test';
import assert from 'node:assert/strict';
import { FORK_REV, FORK_REV_KEY, forkScripts, forkSettings, seedForkDefaults, migrateForkDefaults } from '../src/app/fork-defaults.ts';
import { FORK_TRADER_SCRIPTS, traderScriptRecords } from '../src/app/fork-scripts.ts';
import { readSettings } from '../src/app/store.ts';
import { MAX_NAME, SCRIPTS_KEY, readScripts } from '../src/app/script/records.ts';
import { runScript } from '../src/app/script/lang/engine.ts';
import type { BarInputs } from '../src/app/script/inputs.ts';

const NOW = Date.UTC(2026, 10, 13, 11, 0);

function memory(): Storage {
  const kept = new Map<string, string>();
  return { get length() { return kept.size; }, clear: () => kept.clear(), key: (i: number) => [...kept.keys()][i] ?? null,
    getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); } };
}

/** Four-hour candles over 200 days: a slow rise, a range, a flush with liquidations and a volume spike, and open interest that moves. */
function candles(): BarInputs {
  const n = 1200, TF = 4 * 3600_000, time = Float64Array.from({ length: n }, (_, i) => Date.UTC(2026, 0, 5) + i * TF);
  const close = Float64Array.from(time, (_, i) => 60_000 + 3_000 * Math.sin(i / 40) + (i < 600 ? i * 20 : 12_000) - (i === 900 ? 4_000 : 0) + (i === 1000 ? 5_000 : 0));
  const open = Float64Array.from(close, (c, i) => (i === 1000 ? c - 4_900 : i ? close[i - 1]! : c));
  const high = Float64Array.from(close, (c, i) => Math.max(c, open[i]!) + 150), low = Float64Array.from(close, (c, i) => Math.min(c, open[i]!) - 150 - (i === 900 ? 2_000 : 0));
  const volume = Float64Array.from(time, (_, i) => 1_000 + (i % 9) * 40 + (i === 900 ? 30_000 : 0));
  const lsell = Float64Array.from(time, (_, i) => (i > 800 ? (i === 900 ? 9e7 : 1e5 + (i % 5) * 1e4) : NaN));
  const oichg = Float64Array.from(time, (_, i) => 2e7 * Math.sin(i / 7));
  return { tf: TF, time, open, high, low, close, volume, forming: false, oichg,
    sources: { '': { vbuy: Float64Array.from(time, () => 1e6), vsell: Float64Array.from(time, () => 1e6), lbuy: new Float64Array(n), lsell, markets: 1 } } };
}

test('the Scott and Maru scripts are in two groups, each named within the limit and switched off', () => {
  const list = readScripts(JSON.parse(JSON.stringify(traderScriptRecords())));
  assert.equal(list.length, FORK_TRADER_SCRIPTS.length);
  assert.ok(list.every(r => r.on === false), 'every one off');
  assert.ok(list.every(r => /^(Scott|Maru) · /.test(r.name) && r.name.length <= MAX_NAME));
  assert.equal(list.filter(r => r.name.startsWith('Scott')).length, 4); assert.equal(list.filter(r => r.name.startsWith('Maru')).length, 7);
  assert.equal(new Set(list.map(r => r.id)).size, list.length);
});

test('every Scott and Maru script runs without an error on four-hour candles and draws something', () => {
  const inputs = candles();
  for (const s of FORK_TRADER_SCRIPTS) {
    const r = runScript(s.id, s.source, {}, inputs);
    assert.ok(r.ok, `${s.name}: ${r.ok ? '' : JSON.stringify(r.error)}`);
    if (s.id !== 'lmf-maru-weekend') assert.ok(r.plots.length > 0, `${s.name} plots`);
  }
});

test('the signals land where the candles put them', () => {
  const inputs = candles(), run = (id: string) => { const s = FORK_TRADER_SCRIPTS.find(x => x.id === id)!; const r = runScript(id, s.source, {}, inputs); assert.ok(r.ok); return r; };
  const marks = (r: ReturnType<typeof run>, title: string) => (r.ok ? r.plots.find(p => p.title === title) : undefined);
  const count = (p: { fields: { value?: Float64Array } } | undefined) => (p ? [...p.fields.value!].filter(Number.isFinite).length : 0);
  // The flush at candle 900, then its days 3, 5 and 7.
  assert.ok(count(marks(run('lmf-maru-clock'), 'Flush')) >= 1); assert.equal(count(marks(run('lmf-maru-clock'), 'Days after')) % 3, 0);
  assert.ok(count(marks(run('lmf-maru-spike'), 'Spike')) >= 1);
  assert.ok(count(marks(run('lmf-scott-range'), 'Wide up candle')) >= 1, 'the candle at 1000 opens at its low and closes at its high after a run');
  const strength = [...run('lmf-scott-trend').plots.find(p => p.title === 'Trend strength')!.fields.value!].filter(Number.isFinite);
  assert.ok(strength.every(v => v >= -1 && v <= 1));
  const vol = [...run('lmf-scott-vol').plots.find(p => p.title === 'Annualised volatility %')!.fields.value!].filter(Number.isFinite);
  assert.ok(vol.length > 0 && vol.every(v => v >= 0));
  const width = [...run('lmf-maru-coil').plots.find(p => p.title === 'Range width %')!.fields.value!].filter(Number.isFinite);
  assert.ok(width.length > 0 && width.every(v => v >= 0));
});

test('a first visit gets the Scott and Maru scripts after its own two, every one off', () => {
  const s = memory();
  assert.equal(seedForkDefaults(s, NOW), true);
  const list = readScripts(JSON.parse(s.getItem(SCRIPTS_KEY)!));
  assert.deepEqual(list.slice(0, 2).map(r => [r.name, r.on]), forkScripts().map(r => [r.name, r.on]));
  assert.ok(list.slice(2).every(r => !r.on)); assert.equal(list.length, 2 + FORK_TRADER_SCRIPTS.length);
  assert.equal(s.getItem(FORK_REV_KEY), String(FORK_REV));
});

test('a browser at revision 2 gains the scripts switched off, once, and keeps the heatmap and TPO it chose', () => {
  const s = memory();
  s.setItem('hlm-app-v2', JSON.stringify({ ...forkSettings(NOW), heat: { on: true }, tpo: { on: false } })); s.setItem(FORK_REV_KEY, '2');
  s.setItem(SCRIPTS_KEY, JSON.stringify(forkScripts().map(r => ({ ...r, on: false }))));
  assert.equal(migrateForkDefaults(s), true);
  const after = readSettings(JSON.parse(s.getItem('hlm-app-v2')!));
  assert.equal(after.heat.on, true, 'its heatmap stays on'); assert.equal(after.tpo.on, false, 'its TPO stays off');
  let list = readScripts(JSON.parse(s.getItem(SCRIPTS_KEY)!));
  assert.equal(list.length, 2 + FORK_TRADER_SCRIPTS.length); assert.ok(list.every(r => !r.on));
  // Deleting one keeps it deleted: the revision is reached.
  s.setItem(SCRIPTS_KEY, JSON.stringify(list.filter(r => r.id !== 'lmf-scott-trend')));
  assert.equal(migrateForkDefaults(s), false);
  list = readScripts(JSON.parse(s.getItem(SCRIPTS_KEY)!));
  assert.ok(!list.some(r => r.id === 'lmf-scott-trend'));
});
