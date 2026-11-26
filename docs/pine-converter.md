# Pine Script converter

Pastes TradingView Pine as a user indicator. The conversion is a documented mapping run by
a module in the app, not a model call at runtime: what converts, what changes meaning, and
what refuses is written here and enforced in code.

The target is the script format `ui/src/indicators/script/` runs — the same format a
hand-written user indicator is written in. A converted script is an ordinary user
indicator: it is stored in the workspace document, it is editable in the settings panel, and
it can only reach the globals the sandbox worker provides.

Code: `ui/src/indicators/pine/` (`lexer.ts`, `parser.ts`, `emit.ts`). Entry points: the
"Pine Script" tab of the add-indicator script dialog, and "convert pasted Pine" in an
existing instance's script field.

## The rule that decides everything else

Pine evaluates one bar at a time and keeps variables between bars. This chart evaluates a
whole series at once. Every translation choice follows from that difference:

- A plain Pine assignment becomes a whole-series expression. `plot` order, `input` order and
  statement order are preserved.
- A `var` keeps its per-bar behaviour only inside a `persist` pass, which walks the bars one
  at a time. See [Pine `var`](#pine-var).
- Anything that needs per-bar control flow, or a value the engine does not carry, is a hard
  error naming its line. A conversion never silently drops a construct and never invents a
  substitute for one.

A run collects every refusal it finds and returns them together, so one bad line does not
hide the next.

## Declarations

| Pine | This chart |
| --- | --- |
| `study("Name")`, `indicator("Name")` | `indicator({ name: 'Name' })` |
| `overlay = true` | `placement: 'price'`; otherwise `placement: 'pane'` |
| `precision = 3` | `precision: 3`, clamped to 0-8 |
| `format = format.mintick` | `priceUnits: true` |
| `hline(30, "Oversold", color.red)` | `levels: [30]` on the declaration |
| `title=`, `shorttitle=`, `scale=`, `max_bars_back=`, `format=percent`, `calc_on_every_tick=` | dropped, and each one is reported as a note |

A `strategy(...)` declaration, or any `strategy.*` call, is an error: entries, exits and
positions have no representation here.

## Parameters

The variable an `input.*` call is assigned to becomes the parameter's name in the settings
form. The Pine title becomes its label. Names that would collide with a sandbox global are
renamed; the label keeps the readable text.

| Pine | This chart |
| --- | --- |
| `input.int(14, "Len", minval = 2, maxval = 100)` | `input.int(14, { label: 'Len', min: 2, max: 100 })` |
| `input.float(2.0, "Mult", step = 0.1)` | `input.float(2, { label: 'Mult', step: 0.1 })` |
| `input.bool(true, "Show")` | `input.bool(true, { label: 'Show' })` |
| `input.string("fast", "Mode", options = ["fast", "slow"])` | `input.select('fast', { label: 'Mode', options: [...] })` |
| `input.source(close, "Source")` | `input.source('close', { label: 'Source' })` |
| `input(26, "Len", 1, 100, 0.5)` | the v2-v5 form: kind comes from the default's shape, positions 3-5 are min, max, step |
| `input.time`, `input.session`, `input.timeframe`, `input.symbol`, `input.color`, `input.point`, `input.duration`, `input.event` | error: this chart has no control for them |
| `group=`, `tooltip=`, `inline=`, `documentation=`, `id=`, `defval_title=` | dropped, and reported as a note |

`input.source` offers `open`, `high`, `low`, `close` and `hlc3`. Any other source is an
error rather than a quiet fall back to `close`.

A string parameter holds text. It can be compared with `eq`/`ne`; arithmetic on it fails
loudly, because the engine has no string series.

## Plots

| Pine | This chart |
| --- | --- |
| `plot(s, "Name", color.blue, 2)` | `plot('Name', s, { color: 'blue', width: 2 })` |
| `style = plot.style_columns` or `plot_style_histogram` | `hist(...)` |
| `style = plot.style_linebr`, `stepline`, `area`, `linearea` | a plain line, and a note |
| `style = plot.style_circles`, `cross`, `arrow` | error: no equivalent |
| `offset = 5` | drawn at its own bar, and a note |
| `u = plot(...)` then `fill(u, v, color = color.new(color.blue, 90))` | `fill(u, v, { color: 'blue' })` |
| `plotshape`, `plotchar`, `plotarrow` | error: markers have no equivalent here |
| `fillgradient` | error |
| `bgcolor`, `barcolor`, `setplotstyle` | dropped, and reported as a note |
| `alertcondition`, `alert` | error: alerts are not part of the script format |
| `color.new(c, 90)` | the color itself; transparency is noted and dropped |
| `color.rgb(255, 136, 0)` | `'#ff8800'` |
| `color.na` | the chart's own color, and a note |
| a second plot with a title already used | the later one is suffixed, and noted |
| a thirteenth plot | error: the format draws at most 12 series |

Plot colors are names the chart draws (`red`, `teal`, …) or `#rgb`/`#rrggbb`. Anything else
is an error naming the expression.

## Expressions

Operators and keywords become the sandbox functions, one call per operation:

| Pine | This chart |
| --- | --- |
| `a + b`, `a - b`, `a * b`, `a / b`, `a ^ b` | `add`, `sub`, `mul`, `div`, `pow` |
| `==`, `!=` / `<>`, `>`, `<`, `>=`, `<=` | `eq`, `ne`, `gt`, `lt`, `ge`, `le` |
| `and`, `or`, `not` | `and`, `or`, `not` |
| `cond ? a : b` | `iif(cond, a, b)` |
| `close[1]`, `high[3]` | `delay(close, 1)`, `delay(high, 3)` |
| `na` | `Number.NaN` |
| `nz(x)`, `nz(x, y)` | `nz(x)`, `nz(x, y)` |
| `open high low close volume time hlc3 bar_index` | the same names, `bar_index` as `barIndex` |
| `hl2`, `ohlc4` | written out from `open`, `high`, `low`, `close` |
| `math.max(a, b)`, `math.abs(x)`, `math.log(x)`, … | `max`, `abs`, `log`, and the matching global |
| `%`, `~`, `switch`, `for`, `while`, method calls | error |

`time` is the bar's own start; `time_close` and `timenow` are errors, because the script has
no bar-close clock and no wall clock.

## Indicator functions

`ta.` and the bare v2-v3 spelling mean the same thing. Both map onto the builtins the script
format already exposes, so a converted script computes with the same code as a hand-written
one.

| Pine | This chart |
| --- | --- |
| `ta.sma(src, n)`, `ta.ema`, `ta.rma`, `ta.wma`, `ta.hma` | `sma`, `ema`, `rma`, `wma`, `hma` |
| `ta.vwma(src, n)` | `vwma(src, volume, n)` |
| `ta.stdev(src, n)`, `ta.dev` | `stdev`, population form |
| `ta.rsi(src, n)` | `rsi`, Wilder smoothing, as TradingView does |
| `ta.avg(src, n)` (v2-v3 spelling) | `sma` |
| `[line, signal, hist] = ta.macd(src, fast, slow, signal)` | `macd(...)` and its three named outputs |
| `ta.stoch(src, high, low, n)` | `stochasticLine(src, high, low, n)` |
| `ta.atr(n)` | `atr(n, 'RMA')` |
| `ta.tr` | `trueRange` |
| `ta.cci(src, n)` | `cci` |
| `ta.mfi(src, n)` | `mfi(n)`; see the note below |
| `[diPlus, diMinus, adx] = ta.dmi(diLen, adxLen)` | `dmi(diLen, adxLen)` and its three named outputs |
| `ta.adx(n)` | `adx(n)` |
| `ta.sar(start, inc, max)` | `sar(start, inc, max)` |
| `ta.obv` | `obv` |
| `ta.highest(src, n)`, `ta.lowest(src, n)` | `highest`, `lowest`; the source may be omitted, then it is `close` |
| `ta.crossover(a, b)`, `ta.crossunder(a, b)`, `ta.cross(a, b)` | `crossover`, `crossunder`, `crossover` |
| `ta.change(src)` | `change` |
| `ta.sum(src, n)` | `sum` |
| `ta.vwap(src)` | `vwap('day', price)`; see the note below |
| `ta.valuewhen`, `ta.barssince`, `ta.pivotlow`, `ta.pivothigh`, `ta.linreg`, `ta.cmo`, `ta.wpr`, `ta.percentrank`, `ta.bbw`, `ta.median`, `ta.mode`, `ta.variance`, `ta.cum`, `ta.swma`, `ta.tema`, `ta.correlation`, `ta.lowestbars`, `ta.highestbars`, `ta.pvi`, `ta.nvi`, `ta.obi`, `ta.kc`, `ta.kdj` | error: not implemented, and named as such |

Two mappings change what the function reads, and both say so as a note on the line:

- `ta.vwap(src)` accumulates from the first bar of the session. Here it anchors to the UTC
  day, which is what the built-in VWAP this script replaces does. The series matches that
  built-in, not a TradingView session set to another timezone.
- `ta.mfi(src, n)` ignores `src`. Money flow index is defined on typical price and volume,
  and that is what the host builtin computes.

## Pine `var`

A `var` keeps its value between bars, so it cannot be a whole-series expression. It becomes a
`persist` pass: one loop over the bars whose step sees the previous bar's value.

```pine
var int dir = 1
dir := dir == 1 ? (close < finalDn ? -1 : 1) : (close > finalUp ? 1 : -1)
```

```js
const _p1 = iif(lt(close, finalDn), -1, 1);
const _p2 = iif(gt(close, finalUp), 1, -1);
const dir = persist(1, (__bar, dir) => {
  dir = iif(eq(dir, 1), _p1[__bar], _p2[__bar]);
  return dir;
});
```

Everything the update reads that does not itself depend on the `var` is evaluated once for
the whole series and hoisted above the loop (`_p1`, `_p2`), so the step stays a per-bar
lookup. A `var` therefore converts only when:

- it is updated at least once, and every update is a plain assignment or a foldable
  `if`/`else` chain;
- it is not read between two of its own updates, which would need per-bar order the engine
  does not have;
- two `var`s do not interleave their updates;
- its history is at most one bar deep (`dir[1]` on a `var` is the step's own previous value;
  `dir[2]` is an error).

Anything else is an error that names the line and says which condition it failed.

## Functions, and blocks

A Pine function converts when it is pure: its body assigns its own local values and ends with
an expression. It becomes an arrow function that reads and returns whole series, so calling
it with series arguments behaves like calling it per bar.

A function that assigns a variable from outside itself, or that uses `var` inside, is an
error: the engine has no place for the side effect.

An `if`/`else if`/`else` chain converts when every branch assigns the same single variable;
it folds into nested `iif` calls, and an `if` with no `else` keeps the variable's previous
value in the untaken branch. A block that plots, assigns two variables, or assigns different
variables in different branches is an error.

## Not supported

Each of these is a hard error naming the line, with a message that says what the construct
is. They are listed here so a reader can find out before pasting.

- Strategies: `strategy()`, `strategy.entry`, `strategy.close`, positions, fills, `eqd`/`eqr`.
- Other symbols and timeframes: `request.security`, `request.*`, `syminfo.*`, `timeframe.*`,
  `ticker.*`, `chart.*`.
- Drawing: `line.*`, `box.*`, `label.*`, `table.*`, `polyline.*`.
- Collections: `array.*`, `map.*`, `matrix.*`, and method calls on them.
- Strings: `str.*`, string concatenation with `+`.
- Loops and branches the engine cannot fold: `for`, `while`, `switch`, `try`.
- Bar state and clock: `barstate.*`, `timenow`, `time_close`, `numpoints`, `trades`.
- Tuple assignment from anything other than `ta.macd` and `ta.dmi`.
- Indicators listed as not implemented in the table above.

## Parity corpus

`ui/tests/pine-corpus.ts` holds the scripts the converter is tested against, and
`ui/tests/pine-converter.test.ts` runs them through the same sandbox worker the chart uses.

```
cd ui
npx rolldown tests/pine-converter.test.ts -o /tmp/pine-test.mjs -f esm && node /tmp/pine-test.mjs
```

The corpus is 13 studies written the way TradingView scripts are written — SMA and EMA with a
source input, RSI with levels, Bollinger with a fill, MACD histogram, ATR, Stochastic,
SuperTrend, session VWAP with bands, CCI, ADX with DI, MFI, an Ichimoku subset, and a custom
price-action study — plus 12 scripts that must refuse: alerts, a strategy, `plotshape`,
`request.security`, an array, `switch`, a `for` loop, drawn lines, `input.color`, `ta.linreg`,
a tuple the host cannot return, and a function with side effects.

Each plotted series of a converting script is compared against the built-in indicator or the
reference implementation it stands for, over 2 000 seeded bars:

- Tolerance is `1e-9` of the reference value's magnitude, so a moving average of a 58 000
  coin and an oscillator in the 0-100 range are held to the same number of significant
  digits. In practice every series agrees to the last bit.
- The NaN pattern must match exactly. A series that plots zero where the reference has no
  value yet fails, however close the rest looks.
- The report prints the largest difference, the bar it happened on, and the values at bars
  999, 1 499 and 1 999 so a reader can check one by hand.

The new math the converter leans on (`cci`, `mfi`, `dmi`, `adx`, `sar`, `obv`, `highest`,
`lowest`, `stdev`, `crossover`) is compared in the same run against reference implementations
written from the definitions, at the same tolerance.
