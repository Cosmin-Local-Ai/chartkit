/**
 * The Pine corpus the converter is tested against.
 *
 * Each entry is a study written the way TradingView scripts are written — real indicator
 * logic, `input.*` with ranges, `ta.*` builtins, `var` state, plots with colors — rather
 * than a minimal sketch of one. `expect: 'converts'` scripts are compared numerically
 * against the built-in indicator or reference implementation they stand for; `expect:
 * 'refuses'` scripts must fail with an error naming the line, which is what keeps an
 * unsupported construct from turning into a plausible-looking wrong plot.
 */

export interface CorpusScript {
  id: string;
  title: string;
  expect: 'converts' | 'refuses';
  /** Lines that must appear in the error list when `expect` is `refuses`. */
  errorLines?: number[];
  pine: string;
}

export const CORPUS: readonly CorpusScript[] = [
  {
    id: 'sma-ema',
    title: 'SMA and EMA, with a source input',
    expect: 'converts',
    pine: `//@version=5
indicator("SMA and EMA check", overlay = true)
src = input.source(close, "Source")
fastLength = input.int(9, "Fast length", minval = 1, maxval = 200)
slowLength = input.int(21, "Slow length", minval = 1, maxval = 200)
fastLine = ta.sma(src, fastLength)
slowLine = ta.ema(src, slowLength)
plot(fastLine, "SMA", color.orange, 1)
plot(slowLine, "EMA", color.teal, 1)
`,
  },
  {
    id: 'rsi-inputs',
    title: 'RSI with inputs and guide levels',
    expect: 'converts',
    pine: `//@version=5
indicator("RSI with inputs", overlay = false)
length = input.int(14, "RSI length", minval = 2, maxval = 100)
source = input.source(close, "Source")
value = ta.rsi(source, length)
plot(value, "RSI", color.purple, 2)
hline(30, "Oversold", color.red)
hline(50, "Mid", color.gray)
hline(70, "Overbought", color.green)
`,
  },
  {
    id: 'rsi-alerts',
    title: 'RSI with alertcondition',
    expect: 'refuses',
    errorLines: [8, 9],
    pine: `//@version=5
indicator("RSI with alerts", overlay = false)
length = input.int(14, "RSI length")
value = ta.rsi(close, length)
plot(value, "RSI", color.blue, 2)
hline(70, "Overbought", color.red)
hline(30, "Oversold", color.green)
alertcondition(ta.crossover(value, 70), "Overbought", "RSI crossed above 70")
alertcondition(ta.crossunder(value, 30), "Oversold", "RSI crossed below 30")
`,
  },
  {
    id: 'bb-fill',
    title: 'Bollinger bands with a fill',
    expect: 'converts',
    pine: `//@version=5
indicator("Bollinger with fill", overlay = true)
length = input.int(20, "Length", minval = 2, maxval = 200)
mult = input.float(2.0, "Std dev", minval = 0.5, maxval = 10.0, step = 0.1)
basis = ta.sma(close, length)
dev = mult * ta.stdev(close, length)
upperBand = basis + dev
lowerBand = basis - dev
u = plot(upperBand, "Upper", color.blue, 1)
m = plot(basis, "Basis", color.silver, 1)
l = plot(lowerBand, "Lower", color.blue, 1)
fill(u, l, color = color.new(color.blue, 90))
`,
  },
  {
    id: 'macd-hist',
    title: 'MACD line, signal and histogram',
    expect: 'converts',
    pine: `//@version=5
indicator("MACD histogram", overlay = false)
fastLength = input.int(12, "Fast", minval = 2, maxval = 200)
slowLength = input.int(26, "Slow", minval = 3, maxval = 300)
signalLength = input.int(9, "Signal", minval = 2, maxval = 100)
src = input.source(close, "Source")
[macdLine, signalLine, histLine] = ta.macd(src, fastLength, slowLength, signalLength)
plot(macdLine, "MACD", color.blue, 1)
plot(signalLine, "Signal", color.orange, 1)
plot(histLine, "Hist", color.red, 1, style = plot.style_columns)
hline(0, "Zero", color.gray)
`,
  },
  {
    id: 'atr',
    title: 'Average true range',
    expect: 'converts',
    pine: `//@version=5
indicator("ATR", overlay = false)
length = input.int(14, "Length", minval = 1, maxval = 200)
value = ta.atr(length)
plot(value, "ATR", color.gold, 1)
`,
  },
  {
    id: 'stoch',
    title: 'Stochastic oscillator, v2 builtins',
    expect: 'converts',
    pine: `study("Stochastic", overlay=false)
kLength = input(14, "%K length", minval=1)
smoothLength = input(3, "%K smoothing", minval=1)
dLength = input(3, "%D length", minval=1)
k = sma(ta.stoch(close, high, low, kLength), smoothLength)
dLine = sma(k, dLength)
plot(k, "%K", color.blue, 1)
plot(dLine, "%D", color.orange, 1)
hline(80, "OB", color.red)
hline(20, "OS", color.green)
`,
  },
  {
    id: 'supertrend',
    title: 'SuperTrend, the case that needs var state',
    expect: 'converts',
    pine: `//@version=5
indicator("SuperTrend", overlay = true)
src = input.source(close, "Source")
atrPeriod = input.int(10, "ATR Period", minval = 1, maxval = 200)
factor = input.float(3.0, "Factor", minval = 0.1, maxval = 10.0, step = 0.1)
rng = ta.atr(atrPeriod)
bandUp = src + factor * rng
bandDn = src - factor * rng
prevUp = nz(bandUp[1], bandUp)
prevDn = nz(bandDn[1], bandDn)
finalUp = close[1] > prevUp ? prevUp : bandUp
finalDn = close[1] < prevDn ? prevDn : bandDn
var int dir = 1
dir := dir == 1 ? (close < finalDn ? -1 : 1) : (close > finalUp ? 1 : -1)
upTrend = dir == 1 ? finalDn : na
downTrend = dir == -1 ? finalUp : na
plot(upTrend, "SuperTrend Up", color = color.green, linewidth = 2)
plot(downTrend, "SuperTrend Down", color = color.red, linewidth = 2)
`,
  },
  {
    id: 'vwap-bands',
    title: 'Session VWAP with standard deviation bands',
    expect: 'converts',
    pine: `//@version=5
indicator("Session VWAP", overlay = true)
src = input.source(hlc3, "Source")
bandMult = input.float(1.0, "Band multiplier", 0.0, 5.0, 0.1)
value = ta.vwap(src)
spread = bandMult * ta.stdev(src, 20)
plot(value, "VWAP", color.blue, 2)
plot(value + spread, "Upper", color.teal, 1)
plot(value - spread, "Lower", color.teal, 1)
`,
  },
  {
    id: 'cci',
    title: 'Commodity channel index',
    expect: 'converts',
    pine: `//@version=5
indicator("CCI", overlay = false)
length = input.int(20, "Length", minval = 1, maxval = 200)
src = input.source(hlc3, "Source")
value = ta.cci(src, length)
plot(value, "CCI", color.purple, 2)
hline(100, "Upper", color.gray)
hline(0, "Zero", color.gray)
hline(-100, "Lower", color.gray)
`,
  },
  {
    id: 'adx-dmi',
    title: 'ADX with +DI and -DI',
    expect: 'converts',
    pine: `//@version=5
indicator("ADX with DI", overlay = false)
diLength = input.int(14, "DI length", minval = 1, maxval = 100)
adxLength = input.int(14, "ADX smoothing", minval = 1, maxval = 100)
[diPlus, diMinus, adxValue] = ta.dmi(diLength, adxLength)
plot(diPlus, "+DI", color.green, 1)
plot(diMinus, "-DI", color.red, 1)
plot(adxValue, "ADX", color.blue, 2)
hline(25, "Threshold", color.gray)
`,
  },
  {
    id: 'mfi',
    title: 'Money flow index',
    expect: 'converts',
    pine: `//@version=5
indicator("MFI", overlay = false)
length = input.int(14, "Length", minval = 2, maxval = 100)
value = ta.mfi(hlc3, length)
plot(value, "MFI", color.gold, 2)
hline(80, "Overbought", color.red)
hline(20, "Oversold", color.green)
`,
  },
  {
    id: 'ichimoku',
    title: 'Ichimoku subset: cloud lines from window extremes',
    expect: 'converts',
    pine: `//@version=5
indicator("Ichimoku subset", overlay = true)
tenkanLength = input.int(9, "Conversion line", minval = 1, maxval = 200)
kijunLength = input.int(26, "Base line", minval = 1, maxval = 200)
spanBLength = input.int(52, "Leading span B", minval = 1, maxval = 200)
displacement = input.int(26, "Displacement", minval = 1, maxval = 200)
tenkan = (ta.highest(high, tenkanLength) + ta.lowest(low, tenkanLength)) / 2
kijun = (ta.highest(high, kijunLength) + ta.lowest(low, kijunLength)) / 2
spanA = (tenkan + kijun) / 2
spanB = (ta.highest(high, spanBLength) + ta.lowest(low, spanBLength)) / 2
plot(tenkan, "Tenkan-sen", color.blue, 1)
plot(kijun, "Kijun-sen", color.red, 1)
plot(spanA, "Senkou Span A", color.green, 1, offset = displacement)
plot(spanB, "Senkou Span B", color.purple, 1, offset = displacement)
`,
  },
  {
    id: 'price-action',
    title: 'Custom price action: range compression and inside-bar squeezes',
    expect: 'converts',
    pine: `//@version=5
indicator("Range compression", overlay = false)
lookback = input.int(20, "Range lookback", minval = 2, maxval = 200)
bodyShare = input.float(0.35, "Body share of range", minval = 0.1, maxval = 1.0, step = 0.05)
rangeHigh = ta.highest(high, lookback)
rangeLow = ta.lowest(low, lookback)
midpoint = (rangeHigh + rangeLow) / 2
width = (rangeHigh - rangeLow) / midpoint * 100
body = math.abs(close - open)
fullRange = high - low
insideBar = high <= high[1] and low >= low[1]
narrow = body <= bodyShare * fullRange
squeeze = insideBar and narrow
newestNarrowest = width <= ta.lowest(width, lookback) + 0.000001
plot(midpoint, "Range midpoint", color.silver, 1)
plot(width, "Range width", color.blue, 1)
plot(squeeze ? width : na, "Squeeze", color.orange, 2)
plot(newestNarrowest ? width : na, "Narrowest yet", color.teal, 1)
`,
  },
  {
    id: 'local-function',
    title: 'A pure function with an indented body',
    expect: 'converts',
    pine: `//@version=5
indicator("Local function", overlay = true)
length = input.int(10, "Length", minval = 2, maxval = 200)
midpoint(a, b) =>
    half = (a + b) / 2
    half
value = ta.sma(midpoint(high, low), length)
plot(value, "Midpoint", color.blue, 1)
`,
  },
  {
    id: 'plotshape',
    title: 'plotshape markers',
    expect: 'refuses',
    errorLines: [7],
    pine: `//@version=5
indicator("Marks", overlay = true)
up = close > open
bull = ta.crossover(close, ta.sma(close, 20))
bear = ta.crossunder(close, ta.sma(close, 20))
plot(close, "Close", color.blue, 1)
plotshape(bull, "Bull", shape.triangleup, location.belowbar, color.green, size = size.small)
plotshape(bear, "Bear", shape.triangledown, location.abovebar, color.red)
`,
  },
  {
    id: 'strategy',
    title: 'A strategy, not an indicator',
    expect: 'refuses',
    errorLines: [2, 6],
    pine: `//@version=5
strategy("Breakout strategy", overlay = true)
length = input.int(20, "Length")
line = ta.highest(high, length)
plot(line, "High", color.blue, 1)
strategy.entry("Long", strategy.long, when = ta.crossover(close, line))
strategy.close("Long", when = ta.crossunder(close, line))
`,
  },
  {
    id: 'security',
    title: 'request.security for a higher timeframe',
    expect: 'refuses',
    errorLines: [3],
    pine: `//@version=5
indicator("Higher timeframe filter", overlay = false)
dailyClose = request.security(syminfo.tickerid, "D", close)
value = ta.rsi(close, 14)
plot(value, "RSI", color.blue, 1)
plot(dailyClose, "Daily close", color.orange, 1)
`,
  },
  {
    id: 'array',
    title: 'An array of rolling values',
    expect: 'refuses',
    errorLines: [4],
    pine: `//@version=5
indicator("Array use", overlay = false)
length = input.int(10, "Length")
values = array.new_float(length, 0.0)
value = ta.rsi(close, 14)
plot(value, "RSI", color.blue, 1)
`,
  },
  {
    id: 'switch',
    title: 'A switch on a series',
    expect: 'refuses',
    errorLines: [6],
    pine: `//@version=5
indicator("Switch", overlay = false)
mode = input.string("fast", "Mode", options = ["fast", "slow"])
value = ta.rsi(close, 14)
plot(value, "RSI", color.blue, 1)
switch close
    => 1
`,
  },
  {
    id: 'loop',
    title: 'A for loop',
    expect: 'refuses',
    errorLines: [5],
    pine: `//@version=5
indicator("Loop", overlay = false)
total = 0.0
value = ta.rsi(close, 14)
for i = 0 to 10 by 1
    total := total + close[i]
plot(value, "RSI", color.blue, 1)
`,
  },
  {
    id: 'lines',
    title: 'Drawn lines',
    expect: 'refuses',
    errorLines: [6],
    pine: `//@version=5
indicator("Trendline", overlay = true)
value = ta.rsi(close, 14)
plot(value, "RSI", color.blue, 1)
plot(close, "Close", color.silver, 1)
line.new(bar_index - 10, high, bar_index, high, color = color.red)
`,
  },
  {
    id: 'input-color',
    title: 'A color input',
    expect: 'refuses',
    errorLines: [3],
    pine: `//@version=5
indicator("Color input", overlay = true)
tone = input.color(color.orange, "Tone")
value = ta.rsi(close, 14)
plot(close, "Close", tone, 1)
`,
  },
  {
    id: 'linreg',
    title: 'A linear regression channel',
    expect: 'refuses',
    errorLines: [4],
    pine: `//@version=5
indicator("Linreg", overlay = true)
length = input.int(20, "Length")
value = ta.linreg(close, length, 0)
plot(value, "Linreg", color.blue, 1)
`,
  },
  {
    id: 'tuple',
    title: 'A tuple the host cannot return',
    expect: 'refuses',
    errorLines: [4],
    pine: `//@version=5
indicator("Tuple", overlay = true)
length = input.int(10, "Length")
[hi, lo] = ta.highest(high, length)
plot(hi, "High", color.blue, 1)
`,
  },
  {
    id: 'side-effect-function',
    title: 'A function that assigns outside itself',
    expect: 'refuses',
    errorLines: [5],
    pine: `//@version=5
indicator("Side-effect function", overlay = true)
runs = 0.0
midpoint(a, b) =>
    runs := runs + 1
    (a + b) / 2
plot(midpoint(high, low), "Mid", color.blue, 1)
`,
  },
];
