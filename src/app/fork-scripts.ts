// Scripts drawn from two traders' public notes (Scott Phillips' "Scott_Alpha" and Marus' "Marus_Alpha" compendiums), each a row in the
// Scripts list that starts switched off: the desk looks as it did until one is switched on in the Scripts panel. They describe the chart; none
// is a forecast or a trading signal, and the notes' own claims are theirs (the page numbers are the compendiums').
import { t } from './i18n.ts';
import { MAX_NAME, SCRIPT_API, type ScriptRecord } from './script/records.ts';

/** One of these scripts: its id (kept, so a browser gets each once), its English name (translated as it is added), where it draws, its source. */
export interface ForkScript { id: string; name: string; place: 'pane' | 'map'; height: number; source: string }

export const SCOTT_TREND_SOURCE = `// Scott · Trend strength (Scott_Alpha p.5, p.12-13): a continuous reading of the trend rather than an above/below rule.
// For five lookbacks (the shortest, then twice, four, eight and sixteen times it) it takes the close's distance from the lookback's mean in
// standard deviations (a Bollinger distance, so it is scaled by volatility; clamped to 2) and the close's place in the lookback's high-low
// range, and averages the ten with equal weights: -1 (at the bottom of every window) to +1 (at the top). It describes; it does not forecast.
base = option(type=number, default=10, min=2, max=60, step=1, label="Shortest lookback (candles)")
upColor = option(type=color, default=#24837b, label=Positive)
downColor = option(type=color, default=#af3029, label=Negative)

var c = $price.close
function dist(c, m, m2) { var sd = Math.sqrt(Math.max(0, m2 - m * m)); return sd > 0 ? Math.max(-2, Math.min(2, (c - m) / sd)) / 2 : 0 }
function place(c, h, l) { return h > l ? 2 * (c - l) / (h - l) - 1 : 0 }
var d1 = dist(c, sma(c, base), sma(c * c, base)), p1 = place(c, highest($price.high, base), lowest($price.low, base))
var d2 = dist(c, sma(c, base * 2), sma(c * c, base * 2)), p2 = place(c, highest($price.high, base * 2), lowest($price.low, base * 2))
var d3 = dist(c, sma(c, base * 4), sma(c * c, base * 4)), p3 = place(c, highest($price.high, base * 4), lowest($price.low, base * 4))
var d4 = dist(c, sma(c, base * 8), sma(c * c, base * 8)), p4 = place(c, highest($price.high, base * 8), lowest($price.low, base * 8))
var d5 = dist(c, sma(c, base * 16), sma(c * c, base * 16)), p5 = place(c, highest($price.high, base * 16), lowest($price.low, base * 16))
var strength = (d1 + d2 + d3 + d4 + d5 + p1 + p2 + p3 + p4 + p5) / 10

histogram({ value: strength, color: strength >= 0 ? upColor : downColor }, title="Trend strength")
if (renderer.last) mark({ value: strength, text: "Trend " + (strength >= 0 ? "+" : "") + strength.toFixed(2), color: strength >= 0 ? upColor : downColor }, title="Now", shape=label, position=at)
`;

export const SCOTT_OI_SOURCE = `// Scott · OI at highs and lows (Scott_Alpha p.4, p.9-10, p.31): marks a candle that makes a new high while open interest has been falling
// (the rise carried by positions closing), and one that makes a new low while open interest has been rising (positions opening into the low).
// Open interest is the OI pane's (oichg, its venues); where it was not read nothing is marked. Only the first candle of a run is marked.
length = option(type=number, default=20, min=3, max=500, step=1, label="New high or low over (candles)")
oiLen = option(type=number, default=6, min=1, max=200, step=1, label="Open interest change over (candles)")
lowColor = option(type=color, default=#24837b, label="At lows")
highColor = option(type=color, default=#af3029, label="At highs")

var oiNow = sum(nz(oichg), oiLen)
var lo = lowest($price.low, length), hi = highest($price.high, length)
var atLow = $price.low <= lo && oiNow > 0
var atHigh = $price.high >= hi && oiNow < 0
if (atLow && !wasLow) mark({ value: $price.low, text: "OI up at low", tip: "New " + length + "-candle low; open interest +" + Math.round(oiNow / 1e6) + "M over " + oiLen + " candles", color: lowColor }, title="OI up at a low", shape=triangleUp, position=below)
if (atHigh && !wasHigh) mark({ value: $price.high, text: "OI down at high", tip: "New " + length + "-candle high; open interest " + Math.round(oiNow / 1e6) + "M over " + oiLen + " candles", color: highColor }, title="OI down at a high", shape=triangleDown, position=above)
wasLow = atLow
wasHigh = atHigh
`;

export const SCOTT_RANGE_SOURCE = `// Scott · Wide-range candle after a run (Scott_Alpha p.9): marks a candle whose range is several times the average, that opened near its
// low and closed near its high after a run up (or the mirror after a run down), the kind of candle his notes describe at squeeze tops.
avgLen = option(type=number, default=20, min=3, max=500, step=1, label="Average range over (candles)")
mult = option(type=number, default=2.5, min=1, max=10, step=0.1, label="Range at least (times the average)")
runLen = option(type=number, default=10, min=2, max=500, step=1, label="Run over (candles)")
runPct = option(type=number, default=8, min=0.5, max=100, step=0.5, label="Run at least (%)")
markColor = option(type=color, default=#da702c, label=Mark)

var o = $price.open, h = $price.high, l = $price.low, c = $price.close
var range = h - l
var avgRange = sma(range, avgLen)
var before = last(c, runLen + 1)
var run = before > 0 ? (c / before - 1) * 100 : 0
var wide = range > 0 && range >= mult * avgRange
var upCandle = wide && o <= l + 0.2 * range && c >= h - 0.2 * range && run >= runPct
var downCandle = wide && o >= h - 0.2 * range && c <= l + 0.2 * range && run <= -runPct
if (upCandle) mark({ value: h, text: "Wide range after run", tip: "Range " + (range / avgRange).toFixed(1) + "x average; " + run.toFixed(1) + "% over " + runLen + " candles", color: markColor }, title="Wide up candle", shape=diamond, position=above)
if (downCandle) mark({ value: l, text: "Wide range after run", tip: "Range " + (range / avgRange).toFixed(1) + "x average; " + run.toFixed(1) + "% over " + runLen + " candles", color: markColor }, title="Wide down candle", shape=diamond, position=below)
`;

export const SCOTT_VOL_SOURCE = `// Scott · Volatility sizing (Scott_Alpha p.4-5, p.20): the annualised volatility of the close's log returns over the last days (the standard
// deviation a day times the root of 365, his "x19"), and the share of capital that would run at the target volatility: target / volatility.
// Arithmetic on the past, not advice; the dashed line is the target.
days = option(type=number, default=21, min=2, max=365, step=1, label="Lookback (days)")
target = option(type=number, default=40, min=5, max=200, step=5, label="Target volatility (% a year)")
volColor = option(type=color, default=#100f0f, label=Volatility)

var perDay = 86400 / renderer.timeframe
var n = Math.max(2, Math.round(days * perDay))
var c = $price.close
var ret = prevClose > 0 && c > 0 ? Math.log(c / prevClose) : NaN
prevClose = c
var m = sma(ret, n), m2 = sma(ret * ret, n)
var annual = Math.sqrt(Math.max(0, m2 - m * m)) * Math.sqrt(perDay * 365) * 100
var size = annual > 0 ? 100 * target / annual : NaN

line({ value: annual, color: volColor }, title="Annualised volatility %", lineWidth=2)
line(target, title="Target", color=rgba(16,15,15,0.55), lineStyle=2, lineWidth=1)
if (renderer.last && !na(size)) mark({ value: annual, text: "Vol " + Math.round(annual) + "% · size " + Math.round(size) + "%", tip: "Capital share at " + target + "% target volatility: " + Math.round(size) + "%", color: volColor }, title="Now", shape=label, position=at)
`;

export const MARU_CLOCK_SOURCE = `// Maru · Liquidation clock (Marus_Alpha p.3, p.7): marks a flush (a candle whose liquidations, or failing those its volume, are several
// deviations above their average) and then days 3, 5 and 7 after it, the 3-7 days his notes give the market to rebuild after one.
// A new flush starts the clock again. Liquidations are those the page recorded; before that the volume stands in.
win = option(type=number, default=60, min=10, max=1000, step=1, label="Baseline window (candles)")
flushZ = option(type=number, default=3, min=1, max=10, step=0.1, label="Flush at (deviations)")
markColor = option(type=color, default=#bc5215, label=Mark)

var liq = nz(lbuy) + nz(lsell)
var lm = sma(liq, win), lm2 = sma(liq * liq, win)
var lsd = Math.sqrt(Math.max(0, lm2 - lm * lm))
var v = nz($price.volume)
var vm = sma(v, win), vm2 = sma(v * v, win)
var vsd = Math.sqrt(Math.max(0, vm2 - vm * vm))
var liqZ = lsd > 0 && liq > 0 ? (liq - lm) / lsd : 0
var volZ = vsd > 0 ? (v - vm) / vsd : 0
var flush = liqZ >= flushZ || (liq === 0 && volZ >= flushZ)
var now = time
if (flush && now - flushAt > 86400) {
  flushAt = now
  lastDay = 0
  mark({ value: $price.low, text: "Flush", tip: liqZ >= flushZ ? "Liquidations " + liqZ.toFixed(1) + " deviations above average" : "Volume " + volZ.toFixed(1) + " deviations above average", color: markColor }, title="Flush", shape=circle, position=below)
}
var day = flushAt > 0 ? Math.floor((now - flushAt) / 86400) : 0
if (flushAt > 0 && day > lastDay && day <= 7) {
  if (day === 3 || day === 5 || day === 7) mark({ value: $price.low, text: "Day " + day, tip: day + " days after the flush", color: markColor }, title="Days after", shape=text, position=below)
  lastDay = day
}
`;

export const MARU_LOGVOL_SOURCE = `// Maru · Log-volume trend (Marus_Alpha p.9-10, p.19): two moving averages (EMAs) of the log of each candle's dollar volume, and the
// gap between them; his notes use crosses of such averages on volume, not on price, to read the trend. Marks where the gap changes sign.
fast = option(type=number, default=20, min=2, max=500, step=1, label="Fast average (candles)")
slow = option(type=number, default=60, min=3, max=1000, step=1, label="Slow average (candles)")
upColor = option(type=color, default=#24837b, label=Rising)
downColor = option(type=color, default=#af3029, label=Falling)

var dollars = nz($price.volume) * $price.close
var lv = dollars > 0 ? Math.log(dollars) : NaN
var gap = ema(lv, fast) - ema(lv, slow)
baseline({ value: gap }, title="Fast minus slow", baseValue=0, topLineColor=#24837b, bottomLineColor=#af3029, topFillColor1=rgba(36,131,123,0.18), bottomFillColor1=rgba(175,48,41,0.18), lineWidth=2)
if (!na(gap) && !na(prevGap) && (gap > 0) !== (prevGap > 0)) mark({ value: gap, text: gap > 0 ? "Volume up" : "Volume down", color: gap > 0 ? upColor : downColor }, title="Cross", shape=dot, position=at)
prevGap = gap
`;

export const MARU_SPIKE_SOURCE = `// Maru · Volume-spike levels (Marus_Alpha p.3, p.7, p.10): marks a candle whose volume is several deviations above its average and draws the
// middle of its range for the candles after it, the level his notes fade back to after liquidation and volume-spike candles. A reference
// line, not a target.
win = option(type=number, default=60, min=10, max=1000, step=1, label="Baseline window (candles)")
spikeZ = option(type=number, default=3, min=1, max=10, step=0.1, label="Spike at (deviations)")
keep = option(type=number, default=30, min=1, max=500, step=1, label="Show the level for (candles)")
lineColor = option(type=color, default=#5e409d, label=Level)

var v = nz($price.volume)
var vm = sma(v, win), vm2 = sma(v * v, win)
var vsd = Math.sqrt(Math.max(0, vm2 - vm * vm))
var z = vsd > 0 ? (v - vm) / vsd : 0
if (z >= spikeZ) {
  level = ($price.high + $price.low) / 2
  left = keep
  mark({ value: $price.high, text: "Volume spike", tip: "Volume " + z.toFixed(1) + " deviations above average; mid " + level.toFixed(1), color: lineColor }, title="Spike", shape=triangleDown, position=above)
} else if (left > 0) left = left - 1
line({ value: left > 0 ? level : NaN, color: lineColor }, title="Spike mid", lineType=1, lineStyle=2, lineWidth=1)
`;

export const MARU_COIL_SOURCE = `// Maru · Coiled range (Marus_Alpha p.3, p.12): the width of the high-low range over the last days as a share of the close; his notes say to
// be ready for a large candle after months of range. The dashed line is the width counted as coiled; the first candle under it is marked.
days = option(type=number, default=90, min=5, max=365, step=1, label="Range over (days)")
coiled = option(type=number, default=25, min=1, max=200, step=1, label="Coiled under (% wide)")
widthColor = option(type=color, default=#100f0f, label=Width)
coilColor = option(type=color, default=#da702c, label=Coiled)

var n = Math.max(2, Math.round(days * 86400 / renderer.timeframe))
var hi = highest($price.high, n), lo = lowest($price.low, n)
var width = $price.close > 0 ? 100 * (hi - lo) / $price.close : NaN
var tight = width <= coiled
line({ value: width, color: tight ? coilColor : widthColor }, title="Range width %", lineWidth=2)
line(coiled, title="Coiled under", color=rgba(16,15,15,0.55), lineStyle=2, lineWidth=1)
if (tight && !wasTight) mark({ value: width, text: "Coiled " + Math.round(width) + "%", tip: days + "-day range " + width.toFixed(1) + "% of the close", color: coilColor }, title="Coiled", shape=dot, position=at)
wasTight = tight
`;

export const MARU_OI_SOURCE = `// Maru · Open-interest trend (Marus_Alpha p.3, p.9): open interest added up from the OI pane's changes (oichg) and two moving averages (EMAs)
// of it; his notes smooth noisy series like open interest instead of price. The bars are the fast average minus the slow, in dollars.
fast = option(type=number, default=12, min=2, max=500, step=1, label="Fast average (candles)")
slow = option(type=number, default=48, min=3, max=1000, step=1, label="Slow average (candles)")
upColor = option(type=color, default=#24837b, label=Rising)
downColor = option(type=color, default=#af3029, label=Falling)

var oi = cum(nz(oichg))
var gap = ema(oi, fast) - ema(oi, slow)
histogram({ value: gap, color: gap >= 0 ? upColor : downColor }, title="Fast minus slow")
if (renderer.last) mark({ value: gap, text: "OI trend " + (gap >= 0 ? "+" : "") + Math.round(gap / 1e6) + "M", color: gap >= 0 ? upColor : downColor }, title="Now", shape=label, position=at)
`;

export const MARU_CROSS_SOURCE = `// Maru · Moving-average cross without chop (Marus_Alpha p.10): the close's EMA (200 candles by default) and a mark where the close crosses it,
// left out when it had crossed back within the last candles (his "cancel if the previous bar already crossed"), so a flip-flop marks nothing.
len = option(type=number, default=200, min=2, max=1000, step=1, label="Average (candles)")
quiet = option(type=number, default=3, min=1, max=50, step=1, label="No cross in the last (candles)")
showLine = option(type=checkbox, default=true, label="Show the average")
lineColor = option(type=color, default=#6f6e69, label=Average)
upColor = option(type=color, default=#24837b, label="Cross up")
downColor = option(type=color, default=#af3029, label="Cross down")

var e = ema($price.close, len)
var above = $price.close > e
var crossed = renderer.length > 1 && above !== wasAbove
var recent = sum(crossed ? 1 : 0, quiet + 1) - (crossed ? 1 : 0)
if (showLine) line({ value: e, color: lineColor }, title="EMA", lineWidth=1)
var fresh = crossed && recent === 0 && renderer.length > len
if (fresh && above) mark({ value: $price.low, text: "Cross up", color: upColor }, title="Cross up", shape=arrowUp, position=below)
if (fresh && !above) mark({ value: $price.high, text: "Cross down", color: downColor }, title="Cross down", shape=arrowDown, position=above)
wasAbove = above
`;

export const MARU_WEEKEND_SOURCE = `// Maru · Weekend candles (Marus_Alpha p.3, p.11): draws the candles of Saturday and Sunday (UTC) in a muted colour, the days his notes call
// noise for the majors. (Scott's notes test a weekend effect too and find it does not hold: Scott_Alpha p.18.)
weekendColor = option(type=color, default=#b7b5ac, label="Weekend candles")
var day = Math.floor(time / 86400 + 4) % 7
if (day === 0 || day === 6) { $price.color = weekendColor }
`;

/** The scripts in the order they are added: Scott's, then Maru's, each name beginning with its group. */
export const FORK_TRADER_SCRIPTS: ForkScript[] = [
  { id: 'lmf-scott-trend', name: 'Scott · Trend strength', place: 'pane', height: 70, source: SCOTT_TREND_SOURCE },
  { id: 'lmf-scott-oi', name: 'Scott · OI at highs and lows', place: 'map', height: 70, source: SCOTT_OI_SOURCE },
  { id: 'lmf-scott-range', name: 'Scott · Wide-range candle after a run', place: 'map', height: 70, source: SCOTT_RANGE_SOURCE },
  { id: 'lmf-scott-vol', name: 'Scott · Volatility sizing', place: 'pane', height: 70, source: SCOTT_VOL_SOURCE },
  { id: 'lmf-maru-clock', name: 'Maru · Liquidation clock', place: 'map', height: 70, source: MARU_CLOCK_SOURCE },
  { id: 'lmf-maru-logvol', name: 'Maru · Log-volume trend', place: 'pane', height: 70, source: MARU_LOGVOL_SOURCE },
  { id: 'lmf-maru-spike', name: 'Maru · Volume-spike levels', place: 'map', height: 70, source: MARU_SPIKE_SOURCE },
  { id: 'lmf-maru-coil', name: 'Maru · Coiled range', place: 'pane', height: 70, source: MARU_COIL_SOURCE },
  { id: 'lmf-maru-oi', name: 'Maru · Open-interest trend', place: 'pane', height: 70, source: MARU_OI_SOURCE },
  { id: 'lmf-maru-cross', name: 'Maru · Moving-average cross without chop', place: 'map', height: 70, source: MARU_CROSS_SOURCE },
  { id: 'lmf-maru-weekend', name: 'Maru · Weekend candles', place: 'map', height: 70, source: MARU_WEEKEND_SOURCE },
];

/** A script's name in the page's language: its group ("Scott", "Maru") as it is, the rest translated. */
export function traderScriptName(s: ForkScript): string {
  const [group, rest] = s.name.split(' · ');
  return `${group} · ${translatedRest(rest)}`.slice(0, MAX_NAME);
}

function translatedRest(rest: string): string {
  // Each written out, so the translation check finds every one.
  switch (rest) {
    case 'Trend strength': return t('Trend strength');
    case 'OI at highs and lows': return t('OI at highs and lows');
    case 'Wide-range candle after a run': return t('Wide-range candle after a run');
    case 'Volatility sizing': return t('Volatility sizing');
    case 'Liquidation clock': return t('Liquidation clock');
    case 'Log-volume trend': return t('Log-volume trend');
    case 'Volume-spike levels': return t('Volume-spike levels');
    case 'Coiled range': return t('Coiled range');
    case 'Open-interest trend': return t('Open-interest trend');
    case 'Moving-average cross without chop': return t('Moving-average cross without chop');
    case 'Weekend candles': return t('Weekend candles');
    default: return rest;
  }
}

/** The records for these scripts, every one switched off. */
export function traderScriptRecords(): ScriptRecord[] {
  return FORK_TRADER_SCRIPTS.map((s) => ({ id: s.id, name: traderScriptName(s), source: s.source, options: {}, on: false, api: SCRIPT_API, height: s.height, place: s.place }));
}
