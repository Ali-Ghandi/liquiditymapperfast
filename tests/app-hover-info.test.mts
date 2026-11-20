import test from 'node:test';
import assert from 'node:assert/strict';
import { hoverInfoShown, hoverInfoWanted, noteHoverPointer, setHoverInfo, watchHoverPointers } from '../src/app/hover-info.ts';
import { paintInfoBox, type InfoLine } from '../src/app/infobox.ts';
import { paintMirrorBox } from '../src/app/mirror.ts';
import { PALETTES } from '../src/app/theme.ts';
import { initialState } from '../src/app/store.ts';

const lines: InfoLine[] = [{ label: 'Price', text: '57,232.3' }];
const bounds = { x0: 0, y0: 0, x1: 400, y1: 300 };
const recorder = (): { ctx: CanvasRenderingContext2D; fills: number[][]; texts: string[] } => {
  const fills: number[][] = [], texts: string[] = [];
  const ctx = new Proxy({}, {
    get: (_t, k) => k === 'measureText' ? (s: string) => ({ width: s.length * 6 }) : k === 'fillRect' ? (...r: number[]) => { fills.push(r); }
      : k === 'fillText' ? (s: string) => { texts.push(s); } : () => {},
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, fills, texts };
};

test('the Hover info box setting is off on a fresh page and kept with the settings', () => {
  assert.equal(initialState().hoverInfo, false);
});

test('off, a mouse gets no box beside the pointer, on the canvas or the mirror box; on, it does', () => {
  setHoverInfo(false); noteHoverPointer('mouse');
  assert.equal(hoverInfoWanted(), false); assert.equal(hoverInfoShown(), false);
  const off = recorder();
  assert.equal(paintInfoBox(off.ctx, lines, 100, 100, bounds, PALETTES.dark!), null);
  paintMirrorBox(off.ctx, [{ label: 'Price', text: '1' }], 100, 100, bounds, PALETTES.dark!, () => '#fff');
  assert.deepEqual(off.fills, []); assert.deepEqual(off.texts, []);
  setHoverInfo(true);
  const on = recorder();
  assert.ok(paintInfoBox(on.ctx, lines, 100, 100, bounds, PALETTES.dark!));
  assert.ok(on.fills.length > 0 && on.texts.includes('57,232.3'));
  setHoverInfo(false);
});

test('a finger keeps its box with the setting off (a held crosshair, a TPO block\'s tap menu); a pen or a mouse after it does not', () => {
  setHoverInfo(false);
  noteHoverPointer('touch'); assert.equal(hoverInfoShown(), true);
  assert.ok(paintInfoBox(recorder().ctx, lines, 100, 100, bounds, PALETTES.dark!), 'the box a tap is checked against is drawn');
  noteHoverPointer('pen'); assert.equal(hoverInfoShown(), false);
  noteHoverPointer('touch'); noteHoverPointer('mouse'); assert.equal(hoverInfoShown(), false);
});

test('the page notes each pointer before the panes hear of it', () => {
  const heard: { type: string; fn: (e: Event) => void; opts: unknown }[] = [];
  watchHoverPointers({ addEventListener: ((type: string, fn: (e: Event) => void, opts: unknown) => { heard.push({ type, fn, opts }); }) as Window['addEventListener'] });
  assert.deepEqual(heard.map(h => h.type).sort(), ['pointerdown', 'pointermove']);
  assert.ok(heard.every(h => (h.opts as AddEventListenerOptions).capture === true));
  setHoverInfo(false);
  heard[0]!.fn({ pointerType: 'touch' } as unknown as Event); assert.equal(hoverInfoShown(), true);
  heard[0]!.fn({ pointerType: 'mouse' } as unknown as Event); assert.equal(hoverInfoShown(), false);
});
