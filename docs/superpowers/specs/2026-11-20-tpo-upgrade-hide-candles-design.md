# TPO upgrade, TPO colours and a hide-candles eye: design

Date: 2026-11-20. Request: "can you add the feature to hide candles? just like this on other scripts ... i want to see tpo better. also on
TPOs I need you to improve it. it's ok but ok doesn't cut it. and please add features to edit its colors please."

## What was weak

Benchmarked against TradingView's TPO indicator (its help page "Time price opportunity (TPO) indicator"), the CBOT Market Profile handbook,
and the TPO tools of Sierra Chart, ATAS and Exocharts.

1. **Value area tie rule.** When the next row above and the next row below held the same number of blocks, both rows were taken at once.
   TradingView takes only one: the row nearer the POC, and the higher row if both are equally near. The old rule made the area one row too wide
   on flat profiles. On the BTC 2026-09-28 fixture it gave 1654–1673; TradingView's rule gives 1655–1674. There was also no CBOT (two rows at a
   time) method.
2. **Profiles drawn as slivers.** Blocks were square, as wide as a row is tall. With the user's setup (weekly windows, 4h chart) rows are
   1–3 px, so a week's profile was about 100 px inside a 400 px week, a grey smudge. TradingView sizes blocks to the room the period gives.
3. **Blurry edges.** Cells sat on fractional pixels, so the rows had uneven heights and soft seams.
4. **Missing lines.** Without the Volume profile's lines, the TPO drew its POC but not its VAH and VAL.
5. **The initial balance** was only a bracket. Nothing showed when price broke out of the IB range.
6. **Single prints** were a 2 px tick beside the profile and easy to miss.
7. **Poor highs and lows** had a label but no level line.
8. **Naked POCs** disappeared once touched. TradingView extends a POC until price meets it, and the line ends there.
9. **No colour control.** There was no way to pick colours, opacity or the value area's emphasis.
10. **No quick way to hide the candles.** The option was buried in the Chart type menu as "Hidden".

## What changes

- `model.ts`:
  - `valueArea(..., method)` grows the area one row at a time by default (`'tv'`, TradingView's rule).
  - `'cbot'` grows it two rows at a time (pairs compared; a side with one row left offers it; ties as `'tv'`).
  - `buildProfile` takes the method.
  - `pocRuns` replaces `nakedPocs`. For each closed window it returns its POC and the start of the first later block whose range holds that
    price, or null if no block has (still naked).
- `settings.ts` adds these settings, all validated and persisted with the rest:
  - `va: 'tv' | 'cbot'`.
  - `colors {inside, outside, poc, va, ib, singles, naked}`, each `#rrggbb`.
  - `inAlpha` and `outAlpha`, 10–100 % in steps of 10.
  - `colour: 'two'`, TradingView's look: a blue value area and grey everywhere else.
  - Helpers: `withTpoColor`, `hasOwnTpoColors`, `withThemeTpoColors`.
- `paint.ts`:
  - **Block width:** each block is `min(16 px, room / longest row)`, not tied to the row height, so profiles fill 60 % of their window.
  - **Sharp cells:** each edge is rounded to device pixels (`snapOf`, read from the canvas transform), so rows tile exactly.
  - **Two colours look:** two fixed colours, plus a POC colour that replaces the light stripe when one is chosen.
  - **Opacity:** separate settings inside and outside the value area.
  - **VAH and VAL:** dashed lines with labels whenever the Volume profile's lines don't stand in for them.
  - **Initial balance:** the IB edges run on faintly across the window.
  - **Single prints:** shaded as zones across the window.
  - **Poor highs and lows:** a dotted line across the window.
  - **Naked POCs:** "until touched". A touched POC is drawn faint up to where price met it; an untouched one runs to the right edge, labelled nPOC.
  - `tpoInk` resolves which colours to use.
- `panel.ts`:
  - New "Two colours" look.
  - New "Value area method" setting.
  - New Colours section: the swatches used elsewhere (`lineSwatch`), a reset button on each, a low-contrast note, the two opacity selects,
    and Reset colours.
- `heat-pane.ts`:
  - **Eye button:** an eye beside the market name on the legend, built from the scripts' eye (`.script-row-tool` / `.script-row-hide`). It is
    a real button, so Tab, Enter and Space work, and it carries aria-pressed and a translated tooltip.
  - **What the eye toggles:** `show.candles` through `togglePricePatch`, so it shares Chart type → Hidden and is saved the same way.
  - **What hiding removes:** the candles, the longer candles drawn when zoomed out, the price-history line, divergences and the unusual-volume
    rings. The price line stays.
- `heat-pane.ts` autoscale: when the candles are hidden and the TPO is on, the fit also takes in the TPO profiles in view, as
  `TpoLayer.rangeIn` reports them, so each profile is seen whole. With candles shown, autoscale fits the candles only, as before
  (TradingView's rule).
- Volume-profile lines that follow the TPO use the TPO's POC and VA colours when those are set.
- Translations: 24 new strings in all 11 packs; 2 strings that are no longer used were removed.

## Not done

- No TPO midpoint, IB extension multiples, or developing POC/VA paths.
- The new marks are drawn only when cells are drawn. A compact profile (zoomed out) shows the range, the value area and the POC.
