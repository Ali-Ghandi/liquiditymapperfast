import test from 'node:test';
import assert from 'node:assert/strict';
import { FORK_LAYOUT, TOXIC_SOURCE, forkScripts, forkSettings, seedForkDefaults } from '../src/app/fork-defaults.ts';
import { readSettings, DEFAULTS_REV } from '../src/app/store.ts';
import { SCRIPTS_KEY, readScripts } from '../src/app/script/records.ts';
import { runScript } from '../src/app/script/lang/engine.ts';
import type { BarInputs } from '../src/app/script/inputs.ts';

const NOW = Date.UTC(2026, 10, 13, 11, 0);

function memory(): Storage & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return { kept, get length() { return kept.size; }, clear: () => kept.clear(), key: (i: number) => [...kept.keys()][i] ?? null,
    getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); } };
}

test('the first visit is seeded once; a browser that kept settings is left as it is', () => {
  const s = memory();
  assert.equal(seedForkDefaults(s, NOW), true);
  assert.ok(s.getItem('hlm-app-v2') && s.getItem(SCRIPTS_KEY) && s.getItem('hlm-layout-v3'));
  s.setItem('hlm-app-v2', '{"theme":"dark"}');
  assert.equal(seedForkDefaults(s, NOW + 1), false);
  assert.equal(s.getItem('hlm-app-v2'), '{"theme":"dark"}', 'a later visit never overwrites a choice');
  const kept = memory(); kept.setItem('hlm-app-v2', '{}');
  assert.equal(seedForkDefaults(kept, NOW), false);
  assert.equal(kept.getItem(SCRIPTS_KEY), null);
  assert.equal(seedForkDefaults({ getItem: () => { throw new Error('blocked'); } } as unknown as Storage, NOW), false, 'storage out of reach: nothing, and no throw');
});

test('the seeded settings survive the page\'s own reader: Newsprint desk, 4h, OI and Scripts panes, year profile, VWAPs', () => {
  const raw = forkSettings(NOW);
  assert.equal(raw.defaultsRev, DEFAULTS_REV);
  assert.equal(raw.theme, 'newsprint');
  const s = readSettings(JSON.parse(JSON.stringify(raw)));
  assert.equal(s.timeframe, '4h');
  assert.equal(s.show.oi, true); assert.equal(s.show.script, true); assert.equal(s.show.book, false); assert.equal(s.show.cvd, false);
  assert.equal(s.oiMarkets, 'all'); assert.equal(s.oiChange, 'who'); assert.equal(s.oiTable, true);
  assert.equal(s.vwap.on, true); assert.deepEqual(s.vwap.rolling, [7, 30, 365]);
  assert.equal(s.vwap.anchors.BTC?.length, 2, 'two anchored VWAPs');
  assert.ok(s.vwap.anchors.BTC!.every(a => a.at !== undefined && a.at < NOW));
  assert.equal(s.vwap.colors.rolling['365'], '#af3029');
  assert.equal(s.traded.columns, 'anchor'); assert.equal(s.traded.source, 'candles');
  assert.deepEqual(s.traded.anchors.BTC?.rule, { period: 'year', point: 'start' });
  assert.ok(s.traded.placements.instances.some(p => p.placement === 'left' && p.enabled));
  assert.equal(s.liqLevels.on, true); assert.equal(s.absorption.on, false);
  assert.deepEqual(FORK_LAYOUT.order.slice(0, 3), ['heat', 'oi', 'script']);
});

test('the two seeded scripts read back as they are written, and Toxic Flows runs to a 0-100 line', () => {
  const list = readScripts(JSON.parse(JSON.stringify(forkScripts())));
  assert.deepEqual(list.map(r => [r.name, r.on, r.place]), [['Spot and perpetual CVD', true, 'pane'], ['Toxic Flows', true, 'pane']]);
  const n = 60, MIN = 60_000, time = Float64Array.from({ length: n }, (_, i) => i * MIN);
  const inputs: BarInputs = { tf: MIN, time, open: Float64Array.from(time, () => 100), high: Float64Array.from(time, () => 101), low: Float64Array.from(time, () => 99),
    close: Float64Array.from(time, () => 100), volume: Float64Array.from(time, () => 10), forming: false,
    sources: { '': { vbuy: Float64Array.from(time, (_, i) => 10 + (i % 7) * 3), vsell: Float64Array.from(time, (_, i) => 12 - (i % 5)), lbuy: new Float64Array(n), lsell: new Float64Array(n), markets: 1 } } };
  const r = runScript('toxic', TOXIC_SOURCE, {}, inputs);
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error));
  const toxicity = r.plots.find(p => p.title === 'Toxicity')!, values = [...toxicity.fields.value!].filter(Number.isFinite);
  assert.ok(values.length > 0 && values.every(v => v >= 0 && v <= 100));
  assert.ok(r.plots.some(p => p.title === 'Threshold'));
});
