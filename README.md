# ChartKit

A local charting platform for one trader. A Rust server stores candles, prints
and depth in SQLite, streams them to a browser over REST and a WebSocket, and
serves a hand-written canvas front end. No third-party chart library, no
account, no quota, no telemetry.

Everything runs on your machine. The only network traffic is to the venues you
configure.

## Run it

```sh
# 1. Build the web client
cd ui && npm install && npm run build && cd ..

# 2. Run the server (first run pulls candles and prints, so it takes a few minutes)
cargo run -p chartkit-server -- \
  --data-dir ~/.chartkit \
  --addr 127.0.0.1:8786 \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT \
  --timeframes 1m,5m,1h,1d \
  --backfill-days 30 \
  --ui-dir ui/dist
```

Then open <http://127.0.0.1:8786>. `chartkit --help` lists every flag. The
default data directory is `~/.chartkit` and the default port is `8786`.

## What is in it

**Chart.** Candles, bars, Heikin Ashi and line. Linear and log scales. Pan and
zoom by keyboard or pointer, fit to data, follow the live bar. The price legend
shows the current bar, the session change, and value tags for the indicators you
have open.

**Panes.** Price, volume, footprint, session profile, size bands, TPO, depth
ladder and watchlist, stacked in any order and resized by dragging. Panes you do
not need are switched off from the top bar.

**Drawing tools: 65.** Lines, rays, channels, pitchforks, shapes, arrows,
harmonic and Elliott patterns, Fibonacci and Gann time-price tools. Anchor
counts match the original product's shipped map, asserted id by id in the test
suite. Place by click or by press-drag-release; a partial placement cancels on
`Esc` with nothing saved. Right-click a drawing for style, duplicate, z-order,
lock and delete.

**Indicators: 28.** Moving averages, trend, momentum, volatility, VWAP
variants, pivots, and order-flow series built from stored prints (cumulative
volume delta, aggregated delta, flow dominance, CVD by size). Add as many as you
want; there is no instance limit.

**Your own indicators.** Write a script against the indicator API, or paste Pine
Script and let the converter translate it. Unsupported constructs are refused
with a reason rather than silently drawn wrong. See
[docs/pine-converter.md](docs/pine-converter.md).

**Order flow.** Footprint cells with per-level buy/sell split, a session volume
profile with POC, VAH and VAL, CVD by order-size band, cluster search over
stored prints, and a TPO grid with letters per time bucket. All of it is
aggregated in SQL over the stored prints, not in the browser.

**Alerts.** Price and volume rules evaluated by the server, so they fire with
the browser closed. Trigger history is kept and replayed to a page that
connects later. One fire per crossing; a rule stays quiet until it gives the
level back or its re-arm gap expires.

**Workspaces.** Indicators, drawings, pane layout, zoom, manual price range,
settings and templates all live in one workspace document. Export it to a file,
import it back after a confirmation step, and the file states its own schema
version. Chart data exports as CSV for the bars in view or a chosen range.

## Data and credentials

Binance spot is configured out of the box and is the only feed proven live from
the development machine.

Tradovate, IBKR and Rithmic are implemented and proven **offline**: each parses
documented message fixtures, and a localhost venue replays captured frames
through store, hub and client, including a reconnect and a sequence gap. Their
credentials come from environment variables or a `feeds.json` (mode `0600`) that
Settings → Data feeds writes for you. Secrets are never sent back to the browser.

Prove a venue on your own machine with:

```sh
cargo run -p chartkit-server -- --check-feed tradovate
```

It prints entitlement, the first sequence number, counts and latency for what it
actually received. With no credentials it exits cleanly and says so, which is why
it is safe to run before you have configured anything. Status reaches the strip
as `live`, `delayed data`, `stalled` or `not configured` — delayed is never shown
as live.

Rithmic caveat: its `.proto` is not published. Template ids and field numbers
come from a third-party transcription, recorded in
`crates/ingest/fixtures/README.md` as the first thing a real login must confirm.

## Tests

```sh
# Rust: 166 tests (core 30, store 29, server 52, ingest 55)
cargo test -p chartkit-core -p chartkit-store -p chartkit-server -p chartkit-ingest

# Web: ten Node suites, no browser needed
cd ui
for t in alerts drawing-gestures export-import indicator-library pine-converter \
         settings-templates size-bands cluster-search tpo-profile undo-redo; do
  npx rolldown tests/$t.test.ts -o /tmp/ck.mjs -f esm && node /tmp/ck.mjs
done
npx tsc --noEmit
```

The Node suites are where the numeric work is checked: indicator series against
reference formulas over 2 400 bars, Pine parity against the corpus, band and
cluster totals against plain footprint deltas, drawing anchor counts against the
shipped map, undo steps against exact anchor values.

**Never run `cargo test --workspace`.** The workspace includes the desktop shell,
and pulling in its GTK and WebKit dependencies costs about 1.1 GB of build
artifacts. Scope every cargo command to the four crates above.

## Windows

`desktop/` is a Tauri shell: one process that starts the same axum server on a
free port and points a webview at it, so the client is unchanged.
[desktop/README.md](desktop/README.md) documents the local build. The installer
itself is built by `.github/workflows/windows-installer.yml`, because the Linux
development box has no MSVC toolchain.

## Known limits

- GitHub Actions cannot run on the repository's account today: the account has no
  Actions minutes, so a pushed job fails immediately with a billing annotation
  rather than a build error. Until that is cleared, build the installer locally.
- Reported feed latency rises when the server is running several large scans at
  once — a 3.4M-print profile or cluster search competes with the live pump. On
  an idle machine the newest print is about a second behind the venue.
- The database grows with the data you keep: roughly 1 GB for seven days of three
  symbols. There is no retention policy yet; delete the data directory to start
  over.
- Alert history is capped at 5 000 rows. Chart-data exports are capped by the
  server at 200 000 print rows per request, and an export that stops there says
  so in its file name.
- Clearing a venue's credentials does not stop a feed task that is already
  running; the status strip keeps reporting that venue until the server restarts.

## Layout

| Path | What lives there |
| --- | --- |
| `crates/core` | Domain types: instruments, bars, prints, depth, profiles, flow bands, alerts |
| `crates/store` | SQLite storage and the aggregation queries |
| `crates/ingest` | Venue adapters: Binance, Tradovate, IBKR, Rithmic, and their fixtures |
| `crates/server` | HTTP and WebSocket API, live pump, alert engine, feed supervision |
| `ui` | The web client: canvas renderer, panes, dialogs, and the Node test suites |
| `desktop` | Tauri shell for the Windows installer |
| `docs` | The Pine converter reference |
