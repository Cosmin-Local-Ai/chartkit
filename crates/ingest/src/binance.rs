//! Binance spot feed: instrument list, kline backfill, and a combined stream for
//! live klines, prints and depth. Public endpoints, no API key.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use chartkit_core::instrument::VenueTag;
use chartkit_core::{
    AssetClass, Bar, DepthSnapshot, Instrument, Level, Session, Side, Timeframe, Trade, Venue,
};
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::event::{aggressor_from_buyer_maker, FeedCommand, FeedEvent, FeedState};
use crate::IngestError;

pub const REST_BASE: &str = "https://api.binance.com";
const WS_BASE: &str = "wss://stream.binance.com:9443/stream";
/// Most rows one `aggTrades` request will return.
pub const AGG_TRADE_MAX_LIMIT: u32 = 1_000;
/// Retries allowed on one page before the caller gives up on it.
const AGG_TRADE_MAX_ATTEMPTS: usize = 3;
/// Wait used when the venue sends no `Retry-After` with a 429.
const AGG_TRADE_RETRY_WAIT: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const DEPTH_LEVELS: usize = 25;
const DEPTH_SEED_LEVELS: u32 = 1000;
const BACKFILL_BATCH: u32 = 1000;
/// No frames for this long means the socket is open but silent.
const IDLE_AFTER: Duration = Duration::from_secs(15);

/// Map a chart timeframe onto a venue interval. Binance publishes a fixed set.
pub fn interval(tf: Timeframe) -> Result<String, IngestError> {
    let text = match tf {
        Timeframe::Second(1) => "1s",
        Timeframe::Minute(n) if matches!(n, 1 | 3 | 5 | 15 | 30 | 45) => return Ok(format!("{n}m")),
        Timeframe::Hour(n) if matches!(n, 1 | 2 | 3 | 4 | 6 | 8 | 12) => return Ok(format!("{n}h")),
        Timeframe::Day(n) if matches!(n, 1 | 3) => return Ok(format!("{n}d")),
        Timeframe::Week(1) => "1w",
        Timeframe::Month(1) => "1M",
        other => return Err(IngestError::UnsupportedInterval(other.as_key())),
    };
    Ok(text.to_string())
}

/// Local copy of the book.
///
/// `@depth@100ms` is a **diff** stream: it never sends a full snapshot, so the book
/// has to be seeded from the REST depth endpoint and then kept in step by checking
/// each event's id range against the last one applied. Applying diffs to an empty
/// book leaves levels that already moved, which shows up as a crossed ladder where
/// the best bid equals the best ask.
#[derive(Default)]
struct OrderBook {
    bids: BTreeMap<i64, f64>,
    asks: BTreeMap<i64, f64>,
    seeded: bool,
    last_id: Option<u64>,
}

impl OrderBook {
    fn from_levels(bids: &[Level], asks: &[Level], tick: f64) -> Self {
        let mut book = Self { seeded: true, last_id: None, ..Default::default() };
        for level in bids {
            book.bids.insert(chartkit_core::tick_index(level.price, tick), level.qty);
        }
        for level in asks {
            book.asks.insert(chartkit_core::tick_index(level.price, tick), level.qty);
        }
        book
    }

    /// True when `first..=last` continues the id sequence already applied. A gap
    /// means levels were missed in flight and the book must be re-seeded.
    fn accepts(&self, first: u64, last: u64) -> bool {
        match self.last_id {
            None => true,
            Some(id) => first <= id + 1 && id + 1 <= last,
        }
    }

    fn apply(&mut self, side: &str, rows: &[Value], tick: f64) {
        for row in rows {
            let Some(cells) = row.as_array() else { continue };
            let Some(price) = cells.first().and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok())
            else { continue };
            let Some(qty) = cells.get(1).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok())
            else { continue };
            let key = chartkit_core::tick_index(price, tick);
            let book = if side == "b" { &mut self.bids } else { &mut self.asks };
            if qty <= 0.0 {
                book.remove(&key);
            } else {
                book.insert(key, qty);
            }
        }
    }

    fn snapshot(&self, ts: i64, tick: f64) -> DepthSnapshot {
        let levels = |book: &BTreeMap<i64, f64>, reverse: bool| -> Vec<Level> {
            let iter: Box<dyn Iterator<Item = (&i64, &f64)>> = if reverse {
                Box::new(book.iter().rev())
            } else {
                Box::new(book.iter())
            };
            iter.take(DEPTH_LEVELS)
                .map(|(k, q)| Level { price: chartkit_core::tick_price(*k, tick), qty: *q })
                .collect()
        };
        DepthSnapshot { ts, bids: levels(&self.bids, true), asks: levels(&self.asks, false) }
    }
}

/// One row of `GET /api/v3/aggTrades`: several venue prints that filled at the same
/// price, in the same direction, collapsed into one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AggTrade {
    /// Aggregate trade id. Contiguous and increasing, which is what makes paging by
    /// id gap-free.
    pub id: u64,
    /// Id of the first venue print inside the aggregate. This is the same numbering
    /// the spot `@trade` stream publishes as `t`, so a backfilled row and a live row
    /// for the same print land on one primary key.
    pub first_trade_id: u64,
    pub ts: i64,
    pub price: f64,
    pub qty: f64,
    pub aggressor: Side,
}

/// One page of aggregate trades, plus the IP request weight the venue reported after
/// serving it, which is what lets a backfill stay inside its budget.
#[derive(Clone, Debug, Default)]
pub struct AggTradePage {
    pub trades: Vec<AggTrade>,
    pub used_weight: Option<i64>,
}

#[derive(Clone)]
pub struct BinanceFeed {
    client: Client,
    timeframes: Vec<Timeframe>,
}

impl BinanceFeed {
    pub fn new(timeframes: Vec<Timeframe>) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
            timeframes,
        }
    }

    /// Full spot symbol list. `status` decides `active`, so delisted pairs stay out
    /// of search results but keep their history.
    pub async fn load_instruments(&self) -> Result<Vec<Instrument>, IngestError> {
        let body: Value = self
            .client
            .get(format!("{REST_BASE}/api/v3/exchangeInfo"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let symbols = body
            .get("symbols")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::with_capacity(symbols.len());
        for symbol in symbols {
            let Some(text) = symbol.get("symbol").and_then(Value::as_str) else { continue };
            let base = symbol.get("baseAsset").and_then(Value::as_str).unwrap_or(text);
            let quote = symbol.get("quoteAsset").and_then(Value::as_str).unwrap_or("");
            let status = symbol.get("status").and_then(Value::as_str).unwrap_or("TRADING");
            let filter = |kind: &str, key: &str| -> f64 {
                symbol
                    .get("filters")
                    .and_then(Value::as_array)
                    .and_then(|filters| {
                        filters.iter().find(|f| f.get("filterType").and_then(Value::as_str) == Some(kind))
                    })
                    .and_then(|f| f.get(key))
                    .and_then(filter_value)
                    .unwrap_or(0.0)
            };
            let precision = |key: &str| -> u32 {
                symbol.get(key).and_then(Value::as_u64).map(|v| v as u32).unwrap_or(8)
            };
            let price_tick = filter("PRICE_FILTER", "tickSize").max(1e-8);
            out.push(Instrument {
                id: format!("{}:{}", Venue::Binance.tag(), text),
                venue: Venue::Binance,
                symbol: text.to_string(),
                display: text.to_string(),
                name: format!("{base}/{quote}"),
                asset_class: AssetClass::CryptoSpot,
                price_tick,
                qty_step: filter("LOT_SIZE", "stepSize").max(1e-8),
                price_precision: precision("pricePrecision"),
                qty_precision: precision("quantityPrecision"),
                quote_currency: quote.to_string(),
                session: Session::continuous(),
                active: status.eq_ignore_ascii_case("TRADING"),
            });
        }
        Ok(out)
    }

    /// Historical candles, oldest first. `from` is an epoch-ms lower bound.
    pub async fn klines(
        &self,
        symbol: &str,
        timeframe: Timeframe,
        from: i64,
        limit: u32,
    ) -> Result<Vec<Bar>, IngestError> {
        let step = timeframe.duration_ms().unwrap_or(Timeframe::Minute(1).duration_ms().unwrap());
        let span = step * i64::from(limit.min(BACKFILL_BATCH));
        let end = from + span;
        let rows: Vec<Vec<Value>> = self
            .client
            .get(format!("{REST_BASE}/api/v3/klines"))
            .query(&[
                ("symbol", symbol),
                ("interval", &interval(timeframe)?),
                ("startTime", &from.to_string()),
                ("endTime", &end.to_string()),
                ("limit", &limit.min(BACKFILL_BATCH).to_string()),
            ])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let last = rows.len().saturating_sub(1);
        Ok(rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| {
                let num = |i: usize| row.get(i).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok());
                let start = row.first().and_then(Value::as_i64)?;
                Some(Bar {
                    start,
                    open: num(1)?,
                    high: num(2)?,
                    low: num(3)?,
                    close: num(4)?,
                    volume: num(5)?,
                    trades: row.get(8).and_then(Value::as_u64).unwrap_or(0),
                    // The venue leaves the newest row open; only it is marked live.
                    closed: index < last,
                })
            })
            .collect())
    }

    /// Order book snapshot. Required to seed the diff stream, which never carries a
    /// full book of its own.
    /// Order book snapshot plus the venue's update id at the time of the snapshot.
    /// Diffs at or below that id are already reflected and must not be applied.
    pub async fn depth(
        &self,
        symbol: &str,
        levels: u32,
    ) -> Result<(Vec<Level>, Vec<Level>, u64), IngestError> {
        let limit = levels.to_string();
        let body: Value = self
            .client
            .get(format!("{REST_BASE}/api/v3/depth"))
            .query(&[("symbol", symbol), ("limit", &limit)])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let parse = |key: &str| -> Vec<Level> {
            body.get(key)
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|row| {
                            let cells = row.as_array()?;
                            Some(Level {
                                price: cells.first()?.as_str()?.parse().ok()?,
                                qty: cells.get(1)?.as_str()?.parse().ok()?,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let last_update_id = body.get("lastUpdateId").and_then(Value::as_u64).unwrap_or(0);
        Ok((parse("bids"), parse("asks"), last_update_id))
    }

    /// Aggregate trades with ids at or above `from_id`, oldest first. Paging by id
    /// cannot skip prints the way paging by time can when a millisecond holds more
    /// rows than the page limit.
    pub async fn agg_trades_from_id(
        &self,
        symbol: &str,
        from_id: u64,
        limit: u32,
    ) -> Result<AggTradePage, IngestError> {
        self.agg_trades(symbol, &[("fromId", from_id.to_string()), ("limit", clamp_agg_limit(limit).to_string())])
            .await
    }

    /// Aggregate trades at or after `start_ms`, oldest first. Only good for finding
    /// the first id of a window; continue from there by id.
    pub async fn agg_trades_after(
        &self,
        symbol: &str,
        start_ms: i64,
        limit: u32,
    ) -> Result<AggTradePage, IngestError> {
        self.agg_trades(
            symbol,
            &[("startTime", start_ms.to_string()), ("limit", clamp_agg_limit(limit).to_string())],
        )
        .await
    }

    /// The oldest aggregate trade the venue still publishes for a symbol: the point
    /// past which no amount of paging will return anything.
    pub async fn oldest_agg_trade(&self, symbol: &str) -> Result<Option<AggTrade>, IngestError> {
        Ok(self.agg_trades_from_id(symbol, 0, 1).await?.trades.into_iter().next())
    }

    async fn agg_trades(
        &self,
        symbol: &str,
        params: &[(&str, String)],
    ) -> Result<AggTradePage, IngestError> {
        let mut pairs: Vec<(String, String)> =
            vec![("symbol".to_string(), symbol.to_string())];
        pairs.extend(params.iter().map(|(key, value)| ((*key).to_string(), value.clone())));
        for attempt in 0..AGG_TRADE_MAX_ATTEMPTS {
            let response = self
                .client
                .get(format!("{REST_BASE}/api/v3/aggTrades"))
                .query(&pairs)
                .send()
                .await?;
            let status = response.status();
            // A 429 carries the seconds to wait; ignoring it turns a soft limit into
            // an IP ban (418), which costs far more time than the pause does.
            if matches!(status.as_u16(), 429 | 418) && attempt + 1 < AGG_TRADE_MAX_ATTEMPTS {
                let wait = retry_after(&response).unwrap_or(AGG_TRADE_RETRY_WAIT);
                tracing::warn!("aggTrades {symbol} rate limited, waiting {wait:?}");
                tokio::time::sleep(wait).await;
                continue;
            }
            let response = response.error_for_status()?;
            let used_weight = response
                .headers()
                .get("x-mbx-used-weight-1m")
                .and_then(|value| value.to_str().ok())
                .and_then(|text| text.parse::<i64>().ok());
            let rows: Vec<Value> = response.json().await?;
            return Ok(AggTradePage { trades: parse_agg_trades(&rows), used_weight });
        }
        Err(IngestError::Payload(format!(
            "aggTrades {symbol} stayed rate limited after {AGG_TRADE_MAX_ATTEMPTS} attempts"
        )))
    }

    /// Authoritative tick per instrument. One frame of a price like `59111.6` cannot
    /// tell a 0.1 tick from a 0.01 tick, and a wrong tick collapses two adjacent
    /// price levels into one bucket, which is what makes a ladder read as crossed.
    async fn ticks(&self) -> HashMap<String, f64> {
        match self.load_instruments().await {
            Ok(items) => items
                .iter()
                .map(|item| (item.id.clone(), item.price_tick))
                .collect(),
            Err(error) => {
                tracing::warn!("tick table unavailable, inferring from prices: {error}");
                HashMap::new()
            }
        }
    }

    /// Load any subscribed book that is not usable yet, and recover from an id gap.
    /// Missed levels cannot be rebuilt from diffs alone.
    async fn seed_missing(
        &self,
        streams: &HashMap<String, String>,
        books: &mut HashMap<String, OrderBook>,
        ticks: &mut HashMap<String, f64>,
    ) {
        for symbol in streams.values() {
            let instrument = format!("{}:{}", Venue::Binance.tag(), symbol);
            if books.get(&instrument).is_some_and(|book| book.seeded) {
                continue;
            }
            match self.depth(symbol, DEPTH_SEED_LEVELS).await {
                Ok((bids, asks, last_update_id)) => {
                    // The seed fixes the tick the diffs are bucketed with, so
                    // snapshot keys and diff keys stay comparable after a gap.
                    let inferred = bids
                        .first()
                        .or(asks.first())
                        .map(|level| tick_from_price(level.price))
                        .unwrap_or(0.01);
                    let tick = *ticks.entry(instrument.clone()).or_insert(inferred);
                    let mut book = OrderBook::from_levels(&bids, &asks, tick);
                    // Diffs up to this id are inside the snapshot already.
                    book.last_id = Some(last_update_id);
                    books.insert(instrument, book);
                }
                Err(error) => tracing::warn!("depth seed {symbol} failed: {error}"),
            }
        }
    }

    /// Connect, publish, and reconnect forever. Commands add or drop streams on the
    /// live socket, so switching symbols never tears the connection down.
    pub async fn run(
        self,
        mut commands: mpsc::UnboundedReceiver<FeedCommand>,
        tx: mpsc::UnboundedSender<FeedEvent>,
    ) -> Result<(), IngestError> {
        let mut streams: HashMap<String, String> = HashMap::new();
        // Tick sizes come from the venue, not from guessing at price strings, and
        // they outlive reconnects.
        let mut ticks: HashMap<String, f64> = self.ticks().await;
        let mut backoff = Duration::from_millis(500);
        loop {
            if streams.is_empty() {
                match commands.recv().await {
                    Some(command) => {
                        apply_command(&mut streams, &command, &self.timeframes);
                        continue;
                    }
                    None => return Ok(()),
                }
            }
            let url = format!(
                "{WS_BASE}?streams={}",
                streams.keys().cloned().collect::<Vec<_>>().join("/")
            );
            let _ = tx.send(FeedEvent::status(None, FeedState::Connecting, "connecting"));
            match connect_async(&url).await {
                Ok((socket, _)) => {
                    backoff = Duration::from_millis(500);
                    let (mut send, mut recv) = socket.split();
                    let mut books: HashMap<String, OrderBook> = HashMap::new();
                    self.seed_missing(&streams, &mut books, &mut ticks).await;
                    let mut last_frame = tokio::time::Instant::now();
                    let mut reported_live = false;
                    let mut watchdog = tokio::time::interval(IDLE_AFTER);
                    let mut pending_seed: Option<String> = None;
                    'socket: loop {
                        tokio::select! {
                            command = commands.recv() => {
                                let Some(command) = command else { return Ok(()) };
                                let added = apply_command(&mut streams, &command, &self.timeframes);
                                for name in added {
                                    let frame = json!({"method": "SUBSCRIBE", "params": [name], "id": 1});
                                    if send.send(Message::Text(frame.to_string().into())).await.is_err() {
                                        break 'socket;
                                    }
                                }
                                self.seed_missing(&streams, &mut books, &mut ticks).await;
                            }
                            frame = recv.next() => {
                                let Some(frame) = frame else { break 'socket };
                                match frame {
                                    Ok(Message::Ping(payload)) => {
                                        if send.send(Message::Pong(payload)).await.is_err() {
                                            break 'socket;
                                        }
                                    }
                                    Ok(Message::Text(text)) => {
                                        handle_message(text.as_str(), &streams, &mut books, &mut ticks, &tx, &mut pending_seed);
                                        if pending_seed.take().is_some() {
                                            self.seed_missing(&streams, &mut books, &mut ticks).await;
                                        }
                                        last_frame = tokio::time::Instant::now();
                                        if !reported_live {
                                            reported_live = true;
                                            let _ = tx.send(FeedEvent::status(None, FeedState::Live, "streaming"));
                                        }
                                    }
                                    Ok(Message::Close(_)) | Err(_) => break 'socket,
                                    Ok(_) => {}
                                }
                            }
                            // A socket can stay open while the venue stops sending, so
                            // health has to be judged by the frame clock, not by the link.
                            _ = watchdog.tick() => {
                                if reported_live && last_frame.elapsed() >= IDLE_AFTER {
                                    reported_live = false;
                                    let _ = tx.send(FeedEvent::status(None, FeedState::Stalled, "no frames for 15s"));
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!("binance connect failed: {error}");
                    let _ = tx.send(FeedEvent::status(None, FeedState::Failed, error.to_string()));
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }
}

fn clamp_agg_limit(limit: u32) -> u32 {
    limit.clamp(1, AGG_TRADE_MAX_LIMIT)
}

/// `Retry-After` in seconds, as sent with a 429.
fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.parse::<u64>().ok())
        .map(Duration::from_secs)
}

/// Venue rows into prints. Prices and quantities arrive as strings, so a row that
/// does not parse is dropped rather than collapsing the whole page.
fn parse_agg_trades(rows: &[Value]) -> Vec<AggTrade> {
    rows.iter()
        .filter_map(|row| {
            let text = |key: &str| row.get(key).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok());
            let number = |key: &str| row.get(key).and_then(Value::as_u64);
            Some(AggTrade {
                id: number("a")?,
                first_trade_id: number("f")?,
                ts: row.get("T").and_then(Value::as_i64)?,
                price: text("p")?,
                qty: text("q")?,
                aggressor: aggressor_from_buyer_maker(
                    row.get("m").and_then(Value::as_bool).unwrap_or(false),
                ),
            })
        })
        .collect()
}

fn filter_value(value: &Value) -> Option<f64> {
    match value {
        Value::String(text) => text.parse::<f64>().ok(),
        Value::Number(number) => number.as_f64(),
        _ => None,
    }
}

/// Apply a command to the stream set. Returns the stream names that are new.
fn apply_command(
    streams: &mut HashMap<String, String>,
    command: &FeedCommand,
    timeframes: &[Timeframe],
) -> Vec<String> {
    match command {
        FeedCommand::Subscribe { symbol, timeframe } => {
            let lower = symbol.to_ascii_lowercase();
            let mut wanted: Vec<String> = vec![format!("{lower}@trade"), format!("{lower}@depth@100ms")];
            let mut intervals: Vec<String> = timeframes.iter().filter_map(|tf| interval(*tf).ok()).collect();
            if let Ok(one) = interval(*timeframe) {
                if !intervals.contains(&one) {
                    intervals.push(one);
                }
            }
            for one in intervals {
                wanted.push(format!("{lower}@kline_{one}"));
            }
            let mut added = Vec::new();
            for name in wanted {
                if !streams.contains_key(&name) {
                    streams.insert(name.clone(), symbol.clone());
                    added.push(name);
                }
            }
            added
        }
        FeedCommand::Unsubscribe { symbol } => {
            let stale: Vec<String> = streams
                .iter()
                .filter(|(_, owner)| *owner == symbol)
                .map(|(name, _)| name.clone())
                .collect();
            for name in &stale {
                streams.remove(name);
            }
            Vec::new()
        }
    }
}

fn handle_message(
    text: &str,
    streams: &HashMap<String, String>,
    books: &mut HashMap<String, OrderBook>,
    ticks: &mut HashMap<String, f64>,
    tx: &mpsc::UnboundedSender<FeedEvent>,
    pending_seed: &mut Option<String>,
) {
    let Ok(value) = serde_json::from_str::<Value>(text) else { return };
    let Some(stream) = value.get("stream").and_then(Value::as_str) else { return };
    let Some(symbol) = streams.get(stream).cloned() else { return };
    let Some(data) = value.get("data") else { return };
    let instrument = format!("{}:{}", Venue::Binance.tag(), symbol);
    let tick = *ticks.entry(instrument.clone()).or_insert_with(|| default_tick(data));

    match data.get("e").and_then(Value::as_str).unwrap_or("") {
        "kline" => {
            let Some(k) = data.get("k") else { return };
            let num = |key: &str| k.get(key).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok());
            let Some(start) = k.get("t").and_then(Value::as_i64) else { return };
            let (Some(open), Some(high), Some(low), Some(close), Some(volume)) =
                (num("o"), num("h"), num("l"), num("c"), num("v"))
            else {
                return;
            };
            let timeframe = stream
                .split("@kline_")
                .nth(1)
                .and_then(|s| s.parse::<Timeframe>().ok())
                .unwrap_or(Timeframe::Minute(1));
            let bar = Bar {
                start,
                open,
                high,
                low,
                close,
                volume,
                trades: k.get("n").and_then(Value::as_u64).unwrap_or(0),
                closed: k.get("x").and_then(Value::as_bool).unwrap_or(false),
            };
            let _ = tx.send(FeedEvent::Bar { instrument, timeframe, bar });
        }
        "trade" => {
            let num = |key: &str| data.get(key).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok());
            let Some(price) = num("p") else { return };
            let Some(qty) = num("q") else { return };
            let trade = Trade {
                ts: data.get("T").and_then(Value::as_i64).unwrap_or_default(),
                // Spot `@trade` identifies prints with `t`; `a` only exists on
                // `@aggTrade`. Zero would collapse every print in one millisecond
                // onto the same primary key and drop all but the first.
                seq: data.get("t").and_then(Value::as_u64).unwrap_or_default(),
                price,
                qty,
                aggressor: aggressor_from_buyer_maker(
                    data.get("m").and_then(Value::as_bool).unwrap_or(false),
                ),
            };
            let _ = tx.send(FeedEvent::Trades { instrument, trades: vec![trade] });
        }
        "depthUpdate" => {
            let ids = match (data.get("U").and_then(Value::as_u64), data.get("u").and_then(Value::as_u64)) {
                (Some(first), Some(last)) => Some((first, last)),
                _ => None,
            };
            let (Some(bids), Some(asks)) = (data.get("b"), data.get("a")) else { return };
            let book = books.entry(instrument.clone()).or_default();
            if !book.seeded {
                *pending_seed = Some(symbol);
                return;
            }
            if let Some((first, last)) = ids {
                if let Some(id) = book.last_id {
                    // Already inside the snapshot or a diff applied earlier.
                    if last <= id {
                        return;
                    }
                    if !book.accepts(first, last) {
                        *pending_seed = Some(symbol);
                        return;
                    }
                }
                book.last_id = Some(last);
            }
            let bids = bids.as_array().cloned().unwrap_or_default();
            let asks = asks.as_array().cloned().unwrap_or_default();
            book.apply("b", &bids, tick);
            book.apply("a", &asks, tick);
            let ts = data.get("E").and_then(Value::as_i64).unwrap_or_default();
            let _ = tx.send(FeedEvent::Depth { instrument, snapshot: book.snapshot(ts, tick) });
        }
        _ => {}
    }
}

/// Tick implied by a price's own decimal count. Depth frames carry no tick size,
/// and venues quote each symbol in its smallest listed increment.
fn tick_from_price(price: f64) -> f64 {
    let decimals = price
        .to_string()
        .split('.')
        .nth(1)
        .map(|fraction| fraction.trim_end_matches('0').len())
        .unwrap_or(0);
    10f64.powi(-(decimals.max(1) as i32))
}

fn default_tick(data: &Value) -> f64 {
    let probe = data
        .get("b")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(Value::as_array)
        .and_then(|cells| cells.first())
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| data.get("p").and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok()));
    probe.map(tick_from_price).unwrap_or(0.01)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intervals_map_only_supported_values() {
        assert_eq!(interval(Timeframe::Minute(5)).unwrap(), "5m");
        assert_eq!(interval(Timeframe::Hour(4)).unwrap(), "4h");
        assert!(interval(Timeframe::Minute(7)).is_err());
        assert!(interval(Timeframe::Tick(100)).is_err());
    }

    #[test]
    fn agg_trade_rows_become_prints_on_the_venues_own_trade_id() {
        // Field names and values as returned by GET /api/v3/aggTrades?symbol=BTCUSDT.
        // The last row is unparseable and must be dropped rather than stored as zero.
        let rows: Vec<Value> = serde_json::from_str(
            r#"[
              {"a":4130316408,"p":"59787.36000000","q":"0.02516000","f":6906229252,"l":6906229297,"T":1795518000037,"m":true,"M":true},
              {"a":4130316409,"p":"59787.35000000","q":"0.00063000","f":6906229298,"l":6906229304,"T":1795518000037,"m":false,"M":true},
              {"a":4130316410,"p":"n/a","q":"0.00045000","f":1,"l":2,"T":1795518000037,"m":true,"M":true}
            ]"#,
        )
        .expect("sample payload");
        let prints = parse_agg_trades(&rows);
        assert_eq!(prints.len(), 2, "one bad row must not sink the page");
        assert_eq!(prints[0].id, 4130316408, "paging continues from the aggregate id");
        assert_eq!(prints[0].first_trade_id, 6906229252, "the key matches the @trade stream's t");
        assert_eq!(prints[0].ts, 1795518000037);
        assert!((prints[0].qty - 0.025_16).abs() < 1e-12);
        assert_eq!(prints[0].aggressor, Side::Sell, "a maker buy is a sell print");
        assert_eq!(prints[1].aggressor, Side::Buy);
    }

    #[test]
    fn an_agg_trade_page_stays_inside_the_venue_maximum() {
        assert_eq!(clamp_agg_limit(5_000), AGG_TRADE_MAX_LIMIT);
        assert_eq!(clamp_agg_limit(0), 1);
    }

    #[test]
    fn subscribe_adds_trade_depth_and_kline_streams() {
        let mut streams = HashMap::new();
        let added = apply_command(
            &mut streams,
            &FeedCommand::Subscribe { symbol: "BTCUSDT".into(), timeframe: Timeframe::Minute(1) },
            &[Timeframe::Minute(5)],
        );
        assert!(added.contains(&"btcusdt@trade".to_string()));
        assert!(added.contains(&"btcusdt@depth@100ms".to_string()));
        assert!(added.contains(&"btcusdt@kline_5m".to_string()));
        assert!(added.contains(&"btcusdt@kline_1m".to_string()));
        let again = apply_command(
            &mut streams,
            &FeedCommand::Subscribe { symbol: "BTCUSDT".into(), timeframe: Timeframe::Minute(1) },
            &[Timeframe::Minute(5)],
        );
        assert!(again.is_empty());
    }

    #[tokio::test]
    async fn spot_trade_frame_keeps_its_id_and_aggressor() {
        let mut books = HashMap::new();
        let mut ticks = HashMap::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut streams = HashMap::new();
        streams.insert("btcusdt@trade".to_string(), "BTCUSDT".to_string());
        // Two prints in the same millisecond: distinct ids must survive.
        let a = r#"{"stream":"btcusdt@trade","data":{"e":"trade","E":1700000000000,"s":"BTCUSDT","t":900001,"p":"100.00","q":"0.5","T":1700000000000,"m":false}}"#;
        let b = r#"{"stream":"btcusdt@trade","data":{"e":"trade","E":1700000000000,"s":"BTCUSDT","t":900002,"p":"99.98","q":"1.5","T":1700000000000,"m":true}}"#;
        for frame in [a, b] {
            handle_message(frame, &streams, &mut books, &mut ticks, &tx, &mut None);
        }
        let first = rx.recv().await.expect("first trade");
        let second = rx.recv().await.expect("second trade");
        let id = |event: &FeedEvent| match event {
            FeedEvent::Trades { trades, .. } => trades[0],
            other => panic!("unexpected event {other:?}"),
        };
        assert_eq!(id(&first).seq, 900001);
        assert_eq!(id(&second).seq, 900002, "same-millisecond prints stay distinct");
        assert_eq!(id(&first).aggressor, chartkit_core::Side::Buy);
        assert_eq!(id(&second).aggressor, chartkit_core::Side::Sell);
    }

    fn depth_streams() -> HashMap<String, String> {
        let mut streams = HashMap::new();
        streams.insert("btcusdt@depth@100ms".to_string(), "BTCUSDT".to_string());
        streams
    }

    /// One depth diff between update ids `first..=last`.
    fn diff(first: u64, last: u64, bids: &str, asks: &str) -> String {
        format!(
            r#"{{"stream":"btcusdt@depth@100ms","data":{{"e":"depthUpdate","E":1700000000000,"U":{first},"u":{last},"b":[{bids}],"a":[{asks}]}}}}"#
        )
    }

    fn parse_levels(rows: &[(&str, &str)]) -> Vec<Level> {
        rows.iter()
            .map(|(price, qty)| Level { price: price.parse().unwrap(), qty: qty.parse().unwrap() })
            .collect()
    }

    fn seeded_at(
        bids: &[(&str, &str)],
        asks: &[(&str, &str)],
        last_id: Option<u64>,
        tick: f64,
    ) -> HashMap<String, OrderBook> {
        let mut book = OrderBook::from_levels(&parse_levels(bids), &parse_levels(asks), tick);
        book.last_id = last_id;
        let mut books = HashMap::new();
        books.insert("BINANCE:BTCUSDT".to_string(), book);
        books
    }

    fn seeded(levels: &[(&str, &str)], asks: &[(&str, &str)]) -> HashMap<String, OrderBook> {
        seeded_at(levels, asks, None, 0.1)
    }

    #[test]
    fn one_tick_apart_prices_stay_in_separate_buckets() {
        let bids = parse_levels(&[("100.00", "2")]);
        let asks = parse_levels(&[("100.01", "3")]);
        let exact = OrderBook::from_levels(&bids, &asks, 0.01).snapshot(0, 0.01);
        assert_eq!(exact.bids[0].price, 100.00);
        assert_eq!(exact.asks[0].price, 100.01);

        // A tick coarser than the venue's merges the best bid and best ask into one
        // bucket, which is exactly the crossed ladder seen in the live feed.
        let coarse = OrderBook::from_levels(&bids, &asks, 0.1).snapshot(0, 0.1);
        assert_eq!(coarse.bids[0].price, coarse.asks[0].price);
    }

    #[tokio::test]
    async fn unseeded_book_requests_a_snapshot() {
        let streams = depth_streams();
        let mut books = HashMap::new();
        let mut ticks = HashMap::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut seed = None;
        handle_message(
            &diff(10, 12, r#"["100.0","2"]"#, r#"["100.5","3"]"#),
            &streams,
            &mut books,
            &mut ticks,
            &tx,
            &mut seed,
        );
        assert_eq!(seed.as_deref(), Some("BTCUSDT"), "diffs alone cannot build a book");
        assert!(rx.try_recv().is_err(), "an unseeded book must not publish a ladder");
    }

    #[tokio::test]
    async fn seeded_book_applies_diffs_and_stays_uncrossed() {
        let streams = depth_streams();
        let mut books = seeded(&[("100.0", "2"), ("99.5", "1")], &[("100.5", "3")]);
        let mut ticks = HashMap::new();
        ticks.insert("BINANCE:BTCUSDT".to_string(), 0.1);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut seed = None;
        handle_message(
            &diff(10, 12, r#"["100.0","0"]"#, r#"["101.0","4"]"#),
            &streams,
            &mut books,
            &mut ticks,
            &tx,
            &mut seed,
        );
        assert!(seed.is_none());
        match rx.recv().await.expect("depth event") {
            FeedEvent::Depth { snapshot, .. } => {
                assert_eq!(snapshot.bids.len(), 1, "a zero quantity clears the level");
                assert_eq!(snapshot.bids[0].price, 99.5);
                assert_eq!(snapshot.asks.last().map(|level| level.price), Some(101.0));
                assert!(
                    snapshot.asks[0].price > snapshot.bids[0].price,
                    "best ask must sit above best bid: {:?} / {:?}",
                    snapshot.bids[0],
                    snapshot.asks[0]
                );
            }
            other => panic!("unexpected event {other:?}"),
        }
    }

    #[tokio::test]
    async fn diffs_already_inside_the_snapshot_are_skipped() {
        let streams = depth_streams();
        let mut books = seeded_at(&[("100.0", "2")], &[("100.5", "3")], Some(100), 0.1);
        let mut ticks = HashMap::new();
        ticks.insert("BINANCE:BTCUSDT".to_string(), 0.1);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut seed = None;
        handle_message(
            &diff(99, 100, r#"["99.0","7"]"#, r#"["101.0","7"]"#),
            &streams,
            &mut books,
            &mut ticks,
            &tx,
            &mut seed,
        );
        assert!(seed.is_none(), "a covered diff is not a gap");
        assert!(rx.try_recv().is_err(), "applying a covered diff would republish a stale level");
    }

    #[tokio::test]
    async fn missed_ids_request_a_reseed() {
        let streams = depth_streams();
        let mut books = seeded(&[("100.0", "2")], &[("100.5", "3")]);
        let mut ticks = HashMap::new();
        ticks.insert("BINANCE:BTCUSDT".to_string(), 0.1);
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut seed = None;
        handle_message(
            &diff(10, 12, r#"["100.0","2"]"#, r#"["100.5","3"]"#),
            &streams,
            &mut books,
            &mut ticks,
            &tx,
            &mut seed,
        );
        assert!(seed.is_none(), "the first event after a seed is continuous by definition");
        handle_message(
            &diff(20, 22, r#"["99.0","1"]"#, r#"["101.0","1"]"#),
            &streams,
            &mut books,
            &mut ticks,
            &tx,
            &mut seed,
        );
        assert_eq!(seed.as_deref(), Some("BTCUSDT"), "levels between 12 and 20 were never seen");
    }
}
