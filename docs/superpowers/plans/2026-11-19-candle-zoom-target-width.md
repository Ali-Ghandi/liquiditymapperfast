# Candle zoom target-width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make map candles re-aggregate at a TradingView-like pixel width (~7 px) while zooming out, so they no longer shrink like a photo.

**Architecture:** Reuse `stripTimeframe` + `zoomedCandles`. Pass a higher `min` pixel width (`CANDLE_TARGET_PX`) when choosing the candle draw timeframe in `HeatPane.drawnTf`. Do not change the toolbar timeframe or go finer than the selection.

**Tech Stack:** TypeScript, existing Vite site, node:test in `tests/*.test.mts`, GitHub Pages deploy via existing workflow.

## Global Constraints

- Push only to `master` with normal commits (never force-push).
- Prefer thorough TDD; do not half-ass.
- Keep heatmap / liquidations / drawings on the existing zoom engine.
- Do not add Lightweight Charts in this plan.
- Copy and i18n: no new user-facing strings required unless a tip mentions candle width (avoid unless needed).

## File map

| File | Role |
|------|------|
| `src/app/price-line.ts` | Export `CANDLE_TARGET_PX = 7` |
| `src/app/panes/heat-pane.ts` | `drawnTf` (and any candle-length `stripTimeframe` call) passes `CANDLE_TARGET_PX` |
| `tests/zoomed-candles.test.mts` | Update / add assertions for target-width candle length |
| `tests/volume-strip.test.mts` | Keep strip default at `STRIP_MIN_PX` unless explicitly testing `min` override |

---

### Task 1: Constant + pure behaviour tests

**Files:**
- Modify: `src/app/price-line.ts`
- Modify: `tests/zoomed-candles.test.mts`
- Test: `tests/zoomed-candles.test.mts`

**Interfaces:**
- Consumes: `stripTimeframe(tfMs, span, pw, min?)` from `src/app/measures/volume-strip.ts`
- Produces: `export const CANDLE_TARGET_PX = 7` from `src/app/price-line.ts`

- [ ] **Step 1: Write the failing test**

In `tests/zoomed-candles.test.mts`, replace the old "at least two pixels" candle-length expectation with target-width behaviour, and keep an explicit check that `stripTimeframe` still accepts a custom `min`:

```ts
import { CANDLE_TARGET_PX } from '../src/app/price-line.ts';

test('candles pick the shortest TF that stays about CANDLE_TARGET_PX wide', () => {
  const H = 3_600_000, D = 24 * H, pw = 1_500;
  // Hourly at 20 days: pw*H/(20D) ≈ 3.1 px < 7 → need 4h (≈12.5 px)
  assert.equal(stripTimeframe(H, 20 * D, pw, CANDLE_TARGET_PX).ms, 4 * H);
  // Hourly at ~8 days: ≈7.8 px → stay on 1h
  assert.equal(stripTimeframe(H, 8 * D, pw, CANDLE_TARGET_PX).ms, H);
  // Never finer than the chart TF
  assert.equal(stripTimeframe(4 * H, 2 * D, pw, CANDLE_TARGET_PX).ms, 4 * H);
});
```

Remove or rewrite the prior test that asserted `stripTimeframe(H, 20 * D, 1_500).ms === H` under the 2 px rule if it lives in this file for candles.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="CANDLE_TARGET_PX"`
Expected: FAIL (missing export and/or old 2 px behaviour still encoded).

- [ ] **Step 3: Add `CANDLE_TARGET_PX`**

In `src/app/price-line.ts`, next to `CANDLE_LINE_PX`:

```ts
/** Preferred candle body width (CSS px) when zooming: re-bin before bars go thinner. TradingView-like readability. */
export const CANDLE_TARGET_PX = 7;
```

Leave `CANDLE_LINE_PX = 2` as the thin-line / emergency floor.

- [ ] **Step 4: Run tests for this file**

Run: `npm test -- tests/zoomed-candles.test.mts`  
Expected: new test PASS once `stripTimeframe` is called with `CANDLE_TARGET_PX` in the test; any old 2 px candle test updated.

- [ ] **Step 5: Commit**

```bash
git add src/app/price-line.ts tests/zoomed-candles.test.mts
git commit -m "test(candles): target-width zoom aggregation (CANDLE_TARGET_PX)"
```

---

### Task 2: Wire `drawnTf` to the target width

**Files:**
- Modify: `src/app/panes/heat-pane.ts` (`drawnTf` and any other candle-length `stripTimeframe(..., )` used for drawing candles)
- Test: `tests/zoomed-candles.test.mts` (already green); smoke via typecheck

**Interfaces:**
- Consumes: `CANDLE_TARGET_PX` from `../price-line.ts`; `stripTimeframe` from volume-strip
- Produces: `HeatPane.drawnTf` returns TF ms using `stripTimeframe(tf, span, plotW, CANDLE_TARGET_PX)`

- [ ] **Step 1: Find every candle-length call**

```bash
rg -n "stripTimeframe\(" src/app/panes/heat-pane.ts
```

Calls that choose **candle** draw length (including `drawnTf` ~line 1790 and the related block ~1706 if it drives candle paint) must pass `CANDLE_TARGET_PX`. Volume-strip paint may keep default `STRIP_MIN_PX` unless candles and strip must share length for alignment — if `drawnTf` already feeds the strip's coarse path, prefer one length: use `CANDLE_TARGET_PX` for candle `drawnTf`, and when the volume strip deliberately mirrors candle length, use `drawnTf` rather than a second `stripTimeframe` with 2 px.

- [ ] **Step 2: Implement**

Import `CANDLE_TARGET_PX` beside `CANDLE_LINE_PX` in `heat-pane.ts`. Change:

```ts
const wide = stripTimeframe(tf, v.t1 - v.t0, this.plotW, CANDLE_TARGET_PX).ms;
```

in `drawnTf` (and the sibling candle-length site if present). Update the comment that says "narrower than CANDLE_LINE_PX" for the **choice** of longer TF to say it uses `CANDLE_TARGET_PX`; leave the paint fallback that draws a line below `CANDLE_LINE_PX` alone.

- [ ] **Step 3: Typecheck and unit tests**

Run: `npm run typecheck && npm test`
Expected: PASS (update any test that assumed 2 px candle stepping on the map).

- [ ] **Step 4: Commit**

```bash
git add src/app/panes/heat-pane.ts tests
git commit -m "fix(candles): re-bin on zoom at ~7px target width"
```

---

### Task 3: Visual verify and ship

**Files:** none required beyond prior; deploy via push

- [ ] **Step 1: Local UI smoke**

Run: `npm run build:site && npm run preview:site` (or existing Pages preview). Zoom out on BTC from 1h until a multi-week span: candles should jump 1h → 4h → 1d with readable bodies, not continuous shrinking to hairlines.

- [ ] **Step 2: Push to master**

```bash
git push origin master
```

- [ ] **Step 3: Confirm GitHub Action + live site**

Wait for Pages workflow success. Open https://ali-ghandi.github.io/liquiditymapperfast/ , zoom out, screenshot desktop.

- [ ] **Step 4: Commit nothing if clean; report**

Report: before/after behaviour, Action URL, screenshot path.

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Target ~7 px aggregation | 1–2 |
| No toolbar TF auto-change | 2 (draw-only) |
| No finer than selection | 1 test + stripTimeframe |
| Keep heatmap zoom engine | 2 (no zoom rewrite) |
| Tests + deploy | 1–3 |
