# Plan: TPO upgrade, TPO colours and a hide-candles eye

1. Model: write `valueArea` with the `tv` and `cbot` methods, and `pocRuns`. Tests: `tests/tpo.test.mts` (fixture plus tie rules) and
   `tests/fork-extras.test.mts` (POC runs).
2. Settings: `va`, `colors`, `inAlpha`/`outAlpha`, the `two` look, and their helpers. Tests: `tests/tpo-colours.test.mts`.
3. Paint: block width, pixel snapping, Two colours, opacities, VAH/VAL lines, IB extension, single-print zones, poor-extreme lines, POC
   runs. Test: `tests/tpo-colours.test.mts`, which records the canvas.
4. Panel: the Colours section and the value area method.
5. Heat pane: the legend eye (`togglePricePatch`, tested), the autoscale range from the TPO when the candles are hidden, and the TPO colours
   on the Volume-profile lines.
6. i18n: all 11 packs.
7. Verify:
   - `npm test`, then `npm run build`.
   - Screenshot the local build in headless Chrome with the fork defaults.
   - Push to master, wait for the Pages Action, then screenshot the live site.
