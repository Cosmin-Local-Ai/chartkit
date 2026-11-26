//! Tradovate market data: quotes, DOM, tick prints and candles over their WebSocket API.
//!
//! Everything here is transcribed from Tradovate's own API documentation, which is served
//! from the API host itself: <https://api.tradovate.com/> — sections *Conventions*,
//! *WebSockets*, *Market Data* and *Access*. The hostnames, the SockJS frame prefixes, the
//! four-line client request, the `authorize` handshake, the 2.5 second heartbeat and every
//! market-data field below come from that page.
//!
//! The domain split is documented there too:
//! * `live.tradovateapi.com` — live accounts only,
//! * `demo.tradovateapi.com` — the simulation engine,
//! * `md.tradovateapi.com` — a market-data-only feed.
//! All three speak `wss://{host}/v1/websocket`.

use std::collections::HashMap;
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

use crate::credentials::{slug, CredentialStore};
use crate::event::{FeedCommand, FeedEvent, FeedState};
use crate::IngestError;

/// REST root for live accounts.
pub const LIVE_REST: &str = "https://live.tradovateapi.com/v1";
/// REST root for the simulation engine.
pub const DEMO_REST: &str = "https://demo.tradovateapi.com/v1";
/// Path every WebSocket client uses; the docs say to reuse the API URL with a `wss://`
/// prefix, and `/v1` is dropped from the path.
pub const WS_PATH: &str = "/v1/websocket";
/// A server that sends nothing for this long is open but silent.
const IDLE_AFTER: Duration = Duration::from_secs(20);
/// Tradovate expects a heartbeat frame every 2.5 seconds or it drops the connection.
const HEARTBEAT_EVERY: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Levels kept per side of the ladder.
const DEPTH_LEVELS: usize = 40;

/// Which Tradovate environment to talk to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TradovateServer {
    Live,
    Demo,
}

impl TradovateServer {
    pub fn rest(&self) -> &'static str {
        match self {
            TradovateServer::Live => LIVE_REST,
            TradovateServer::Demo => DEMO_REST,
        }
    }

    pub fn ws(&self) -> String {
        match self {
            TradovateServer::Live => format!("wss://live.tradovateapi.com{WS_PATH}"),
            TradovateServer::Demo => format!("wss://demo.tradovateapi.com{WS_PATH}"),
        }
    }
}

/// What the adapter needs before it can connect. Nothing here is compiled in.
#[derive(Clone, Debug)]
pub struct TradovateConfig {
    pub server: TradovateServer,
    pub user: String,
    pub password: String,
    pub app_id: String,
    pub device_id: String,
    /// Override for the socket URL, used by the localhost fake venue.
    pub ws_url: Option<String>,
    /// An access token obtained elsewhere. When set, the REST exchange is skipped, which
    /// is what lets a test drive the socket without a Tradovate account.
    pub token: Option<String>,
}

impl TradovateConfig {
    /// Reads credentials from the store. The error text is the "not configured" reason the
    /// status strip and `--check-feed` show.
    pub fn from_store(store: &CredentialStore) -> Result<Self, String> {
        let status = store.status(Venue::Tradovate);
        if !status.configured {
            return Err(format!(
                "set TRADOVATE_USER and TRADOVATE_PASSWORD, or fill the Tradovate row in \
                 Settings > Feeds ({}), or run: chartkit --check-feed {}",
                store.path().display(),
                slug(Venue::Tradovate)
            ));
        }
        let server = match store.value(Venue::Tradovate, "server").as_deref() {
            Some(text) if text.eq_ignore_ascii_case("live") => TradovateServer::Live,
            _ => TradovateServer::Demo,
        };
        Ok(Self {
            server,
            user: store.value(Venue::Tradovate, "user").unwrap_or_default(),
            password: store.value(Venue::Tradovate, "password").unwrap_or_default(),
            app_id: store
                .value(Venue::Tradovate, "app_id")
                .unwrap_or_else(|| "chartkit".to_string()),
            device_id: store
                .value(Venue::Tradovate, "device_id")
                .unwrap_or_else(|| "chartkit".to_string()),
            ws_url: None,
            token: None,
        })
    }

    pub fn ws_url(&self) -> String {
        self.ws_url.clone().unwrap_or_else(|| self.server.ws())
    }
}

/// One decoded Tradovate WebSocket frame. The first character is the frame type and the
/// rest is JSON, exactly as the *Server Frames* section describes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    /// `'o'` — the session is open.
    Open,
    /// `'h'` — heartbeat; the client must answer with `'[]'`.
    Heartbeat,
    /// `'a'` — an array of messages.
    Messages(Vec<Value>),
    /// `'c'` — close, with the server's code and reason.
    Closed(String),
}

/// Split one raw frame into its type prefix and JSON payload.
pub fn decode_frame(text: &str) -> Option<Frame> {
    let (kind, body) = text.split_at(1);
    match kind {
        "o" => Some(Frame::Open),
        "h" => Some(Frame::Heartbeat),
        "c" => Some(Frame::Closed(body.to_string())),
        "a" => {
            if body.is_empty() {
                return Some(Frame::Messages(Vec::new()));
            }
            serde_json::from_str::<Vec<Value>>(body).ok().map(Frame::Messages)
        }
        _ => None,
    }
}

/// Build one client request: endpoint, id, query, body, each on its own line. The docs are
/// explicit that the four fields _must_ be separated by newlines.
pub fn request_frame(endpoint: &str, id: u64, query: &str, body: &str) -> String {
    format!("{endpoint}\n{id}\n{query}\n{body}\n")
}

/// The `authorize` request: the token travels as the body field.
pub fn authorize_frame(id: u64, token: &str) -> String {
    request_frame("authorize", id, "", token)
}

/// Chart description for a timeframe. `MinuteBar` and `DailyBar` are the documented
/// `underlyingType` values; an hour bar is a minute bar of 60 × n minutes, which follows
/// from `elementSize` being counted in the unit named by `elementSizeUnit`.
pub fn chart_description(timeframe: Timeframe) -> Result<Value, IngestError> {
    let (kind, size) = match timeframe {
        Timeframe::Minute(n) => ("MinuteBar", u32::from(n)),
        Timeframe::Hour(n) => ("MinuteBar", u32::from(n) * 60),
        Timeframe::Day(1) => ("DailyBar", 1),
        other => return Err(IngestError::UnsupportedInterval(other.as_key())),
    };
    Ok(json!({
        "underlyingType": kind,
        "elementSize": size,
        "elementSizeUnit": "UnderlyingUnits",
        "withHistogram": false,
    }))
}

/// Live tick chart: every print, one per tick, with the venue's own tick id.
pub fn tick_chart_description() -> Value {
    json!({
        "underlyingType": "Tick",
        "elementSize": 1,
        "elementSizeUnit": "UnderlyingUnits",
        "withHistogram": false,
    })
}

/// Parse an ISO-8601 UTC timestamp such as `2021-04-13T04:59:06.588Z` into epoch ms.
/// Hand-rolled because the project carries no date crate.
pub fn parse_timestamp(text: &str) -> Option<i64> {
    let (date, time) = text.split_once('T')?;
    let mut parts = date.split('-').map(|p| p.parse::<i64>().ok());
    let (Some(year), Some(month), Some(day)) = (parts.next()?, parts.next()?, parts.next()?) else {
        return None;
    };
    let time = time.trim_end_matches('Z');
    let mut parts = time.split(':').map(|part| part.parse::<f64>().ok());
    let (Some(hour), Some(minute)) = (
        parts.next()?.map(|value| value as i64),
        parts.next()?.map(|value| value as i64),
    ) else {
        return None;
    };
    let second = parts.next().unwrap_or(Some(0.0))?;
    // Days from the civil calendar (Howard Hinnant's algorithm), shifted to 1970-01-01.
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719_468;
    Some(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + (second * 1000.0).round() as i64)
}

/// Instrument metadata for one contract name: `GET {rest}/contract/find?name=ESZ6`.
/// The entity carries only `id`, `name`, `contractMaturityId` and `timestamp`, so the tick
/// size has to come from the feed itself (the `ts` field of a tick packet).
pub fn instrument_from_contract(name: &str, body: &Value) -> Option<Instrument> {
    let id = body.get("id").and_then(Value::as_i64)?;
    let symbol = body.get("name").and_then(Value::as_str).unwrap_or(name);
    let _ = id;
    Some(Instrument {
        id: format!("{}:{}", Venue::Tradovate.tag(), symbol),
        venue: Venue::Tradovate,
        symbol: symbol.to_string(),
        display: symbol.to_string(),
        name: symbol.to_string(),
        asset_class: AssetClass::Future,
        // The Contract entity carries no tick size, so this is the CME E-mini default and
        // is corrected from the `ts` field of the first tick packet for that symbol.
        price_tick: 0.25,
        qty_step: 1.0,
        price_precision: 2,
        qty_precision: 0,
        quote_currency: "USD".to_string(),
        session: Session::continuous(),
        active: true,
    })
}

/// One entry of a quote message's `entries` map, e.g. `"Bid": {"price":..,"size":..}`.
fn entry(entries: &Value, key: &str) -> Option<(f64, f64)> {
    let row = entries.get(key)?;
    let price = row.get("price").and_then(Value::as_f64);
    let size = row.get("size").and_then(Value::as_f64);
    match (price, size) {
        (Some(p), Some(s)) => Some((p, s)),
        (Some(p), None) => Some((p, 0.0)),
        _ => None,
    }
}

/// `{"e":"md","d":{"quotes":[...]}}` → top-of-book depth plus the last trade.
pub fn parse_quote(data: &Value) -> (Option<DepthSnapshot>, Option<Trade>) {
    let Some(entries) = data.get("entries") else {
        return (None, None);
    };
    let ts = data
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_timestamp)
        .unwrap_or_default();
    let depth = match (entry(entries, "Bid"), entry(entries, "Offer")) {
        (Some(bid), Some(ask)) => Some(DepthSnapshot {
            ts,
            bids: vec![Level { price: bid.0, qty: bid.1 }],
            asks: vec![Level { price: ask.0, qty: ask.1 }],
        }),
        _ => None,
    };
    let trade = entry(entries, "Trade").map(|(price, size)| Trade {
        ts,
        seq: 0,
        price,
        qty: size,
        aggressor: Side::Buy,
    });
    (depth, trade)
}

/// `{"e":"md","d":{"doms":[...]}}` → the full ladder. DOM frames are snapshots, not diffs,
/// so no sequence bookkeeping is needed for depth here.
pub fn parse_dom(data: &Value) -> Option<DepthSnapshot> {
    let levels = |key: &str| -> Vec<Level> {
        data.get(key)
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        Some(Level {
                            price: row.get("price").and_then(Value::as_f64)?,
                            qty: row.get("size").and_then(Value::as_f64)?,
                        })
                    })
                    .take(DEPTH_LEVELS)
                    .collect()
            })
            .unwrap_or_default()
    };
    let bids = levels("bids");
    let asks = levels("offers");
    if bids.is_empty() && asks.is_empty() {
        return None;
    }
    Some(DepthSnapshot {
        ts: data
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp)
            .unwrap_or_default(),
        bids,
        asks,
    })
}

/// `{"e":"chart","d":{"charts":[{"bars":[...]}]}}` → candles. Volume is the sum of
/// `upVolume` and `downVolume`, the two documented fields; the venue does not send a
/// separate total.
pub fn parse_bars(data: &Value) -> Vec<Bar> {
    data.get("bars")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let num = |key: &str| row.get(key).and_then(Value::as_f64);
                    Some(Bar {
                        start: row.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp)?,
                        open: num("open")?,
                        high: num("high")?,
                        low: num("low")?,
                        close: num("close")?,
                        volume: num("upVolume").unwrap_or(0.0) + num("downVolume").unwrap_or(0.0),
                        trades: (num("upTicks").unwrap_or(0.0) + num("downTicks").unwrap_or(0.0))
                            as u64,
                        closed: true,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One tick-chart packet's prints. Prices and timestamps are relative to the packet:
/// `bp` is a count of tick sizes and `bt` a base timestamp, so the real price is
/// `(bp + p) * ts` and the real time is `bt + t`.
pub fn parse_ticks(packet: &Value) -> Vec<Trade> {
    let tick = packet.get("ts").and_then(Value::as_f64).unwrap_or(1.0);
    let base_price = packet.get("bp").and_then(Value::as_f64).unwrap_or(0.0);
    let base_time = packet.get("bt").and_then(Value::as_i64).unwrap_or(0);
    packet
        .get("tks")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let id = row.get("id").and_then(Value::as_u64)?;
                    let relative_price = row.get("p").and_then(Value::as_f64).unwrap_or(0.0);
                    let price = (base_price + relative_price) * tick;
                    let price = (price * 1e6).round() / 1e6;
                    Some(Trade {
                        ts: base_time + row.get("t").and_then(Value::as_i64).unwrap_or(0),
                        seq: id,
                        price,
                        qty: row.get("s").and_then(Value::as_f64).unwrap_or(0.0),
                        aggressor: aggressor_from_levels(
                            relative_price,
                            row.get("b").and_then(Value::as_i64),
                            row.get("a").and_then(Value::as_i64),
                        ),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Which side hit the tape. The tick packet carries no aggressor flag, only the bid and ask
/// the venue had when the print happened, in the same ticks as `p`; a negative side means
/// the book was one-sided at that moment. A print at or through the ask is buyer-initiated,
/// at or through the bid is seller-initiated, and one between the two goes to the nearer
/// side. With no book to judge by the print is left as a buy rather than dropped.
fn aggressor_from_levels(price: f64, bid: Option<i64>, ask: Option<i64>) -> Side {
    // A negative level means the book was one-sided, which is the venue's way of saying it
    // has nothing to compare the print against.
    let bid = bid.filter(|level| *level >= 0).map(|level| level as f64);
    let ask = ask.filter(|level| *level >= 0).map(|level| level as f64);
    match (bid, ask) {
        (Some(bid), Some(ask)) => {
            if price >= ask {
                Side::Buy
            } else if price <= bid {
                Side::Sell
            } else if price * 2.0 > bid + ask {
                Side::Buy
            } else {
                Side::Sell
            }
        }
        (Some(bid), None) => {
            if price <= bid {
                Side::Sell
            } else {
                Side::Buy
            }
        }
        (None, Some(ask)) => {
            if price >= ask {
                Side::Buy
            } else {
                Side::Sell
            }
        }
        (None, None) => Side::Buy,
    }
}

/// True when `first..=last` continues the tick ids already applied. Tradovate gives no
/// sequence on quote or DOM frames, so the tick chart's own `id` is the only gap signal.
fn continues(last: Option<u64>, first: u64) -> bool {
    match last {
        None => true,
        Some(id) => first <= id + 1,
    }
}

/// One open Tradovate socket.
struct Conn {
    /// request id → what it asked for, so a response can be matched to its purpose.
    pending: HashMap<u64, PendingRequest>,
    next_id: u64,
    /// contractId → venue symbol, filled from the subscriptions the adapter itself makes.
    by_contract: HashMap<i64, String>,
    /// symbol → tick size, learned from the first tick packet of that symbol.
    ticks: HashMap<String, f64>,
    /// Last tick id applied per symbol: a jump means prints were missed in flight.
    last_tick: HashMap<String, u64>,
    /// Last tick timestamp per symbol, the point a gap fill is re-requested from.
    last_tick_time: HashMap<String, i64>,
}

/// What a request id was for. Only the ids the adapter cares about are tracked.
#[derive(Clone, Debug, PartialEq, Eq)]
enum PendingRequest {
    Authorize,
    Chart { symbol: String, timeframe: Timeframe },
    TickChart { symbol: String },
    Other,
}

impl Conn {
    fn new() -> Self {
        Self {
            pending: HashMap::new(),
            next_id: 1,
            by_contract: HashMap::new(),
            ticks: HashMap::new(),
            last_tick: HashMap::new(),
            last_tick_time: HashMap::new(),
        }
    }

    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

/// Tradovate feed: one socket, many instruments, reconnecting forever.
pub struct TradovateFeed {
    config: TradovateConfig,
    timeframes: Vec<Timeframe>,
    client: Client,
}

impl TradovateFeed {
    pub fn new(config: TradovateConfig, timeframes: Vec<Timeframe>) -> Self {
        Self { config, timeframes, client: Client::builder().timeout(Duration::from_secs(20)).build().unwrap_or_default() }
    }

    /// Exchange credentials for an access token. `POST {rest}/auth/accesstokenrequest`.
    pub async fn access_token(&self) -> Result<String, IngestError> {
        let body = json!({
            "name": self.config.user,
            "password": self.config.password,
            "appId": self.config.app_id,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "deviceId": self.config.device_id,
        });
        let response: Value = self
            .client
            .post(format!("{}/auth/accesstokenrequest", self.config.server.rest()))
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        response
            .get("accessToken")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| IngestError::Payload("accesstokenrequest returned no accessToken".into()))
    }

    /// `GET {rest}/contract/find?name=ESZ6` for each symbol, so the instrument table has
    /// rows before the first frame arrives.
    pub async fn load_instruments(&self, symbols: &[String]) -> Result<Vec<Instrument>, IngestError> {
        let mut out = Vec::new();
        for symbol in symbols {
            let body: Value = self
                .client
                .get(format!("{}/contract/find", self.config.server.rest()))
                .query(&[("name", symbol.as_str())])
                .bearer_auth(self.access_token().await?)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            if let Some(item) = instrument_from_contract(symbol, &body) {
                out.push(item);
            }
        }
        Ok(out)
    }

    /// Connect, authorize, subscribe, publish, and reconnect forever.
    pub async fn run(
        self,
        mut commands: mpsc::UnboundedReceiver<FeedCommand>,
        tx: mpsc::UnboundedSender<FeedEvent>,
    ) -> Result<(), IngestError> {
        // symbol → the streams it asked for, kept across reconnects.
        let mut wanted: HashMap<String, Wanted> = HashMap::new();
        let mut token: Option<(String, tokio::time::Instant)> = None;
        let mut backoff = Duration::from_millis(500);
        loop {
            if wanted.is_empty() {
                match commands.recv().await {
                    Some(command) => {
                        apply_command(&mut wanted, &command);
                        continue;
                    }
                    None => return Ok(()),
                }
            }
            let token = match self.token(&mut token, &tx).await {
                Ok(text) => text,
                Err(error) => {
                    let _ = tx.send(FeedEvent::venue_status(
                        Venue::Tradovate,
                        FeedState::Failed,
                        format!("auth: {error}"),
                    ));
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue;
                }
            };
            let _ = tx.send(FeedEvent::venue_status(
                Venue::Tradovate,
                FeedState::Connecting,
                "connecting",
            ));
            match connect_async(self.config.ws_url()).await {
                Ok((socket, _)) => {
                    backoff = Duration::from_millis(500);
                    if let Err(error) = self
                        .socket(&mut commands, socket, &token, &mut wanted, &tx)
                        .await
                    {
                        tracing::warn!("tradovate socket ended: {error}");
                    }
                }
                Err(error) => {
                    tracing::warn!("tradovate connect failed: {error}");
                    let _ = tx.send(FeedEvent::venue_status(
                        Venue::Tradovate,
                        FeedState::Failed,
                        error.to_string(),
                    ));
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    /// Reuse the token until it is close to expiring; Tradovate rate-limits token requests
    /// hard enough that refetching per reconnect costs more than it saves.
    async fn token(
        &self,
        cache: &mut Option<(String, tokio::time::Instant)>,
        tx: &mpsc::UnboundedSender<FeedEvent>,
    ) -> Result<String, IngestError> {
        if let Some(token) = &self.config.token {
            return Ok(token.clone());
        }
        if let Some((token, until)) = cache {
            if tokio::time::Instant::now() < *until {
                return Ok(token.clone());
            }
        }
        let token = self.access_token().await?;
        *cache = Some((token.clone(), tokio::time::Instant::now() + Duration::from_secs(30 * 60)));
        let _ = tx;
        Ok(token)
    }

    /// One connection: authorize, then serve commands and frames until it dies.
    async fn socket(
        &self,
        commands: &mut mpsc::UnboundedReceiver<FeedCommand>,
        socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        token: &str,
        wanted: &mut HashMap<String, Wanted>,
        tx: &mpsc::UnboundedSender<FeedEvent>,
    ) -> Result<(), IngestError> {
        let (mut send, mut recv) = socket.split();
        let mut state = Conn::new();
        // The id of the `authorize` request, so its response can open the session.
        let mut auth_id = 0;
        let mut authorized = false;
        let mut heartbeat = tokio::time::interval(HEARTBEAT_EVERY);
        let mut last_frame = tokio::time::Instant::now();
        let mut reported_live = false;
        let mut gap_fill: Option<(String, i64, u64)> = None;
        loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { return Ok(()) };
                    apply_command(wanted, &command);
                    // Subscribing before `authorize` succeeds is ignored by the server.
                    if authorized {
                        for line in subscription_frames(wanted, &self.timeframes, &mut state) {
                            if send.send(Message::Text(line.into())).await.is_err() {
                                return Err(IngestError::Payload("send subscription failed".into()));
                            }
                        }
                    }
                }
                frame = recv.next() => {
                    let Some(frame) = frame else { return Ok(()) };
                    match frame? {
                        Message::Text(text) => {
                            let Some(frame) = decode_frame(text.as_str()) else { continue };
                            match frame {
                                Frame::Open => {
                                    auth_id = state.take_id();
                                    state.pending.insert(auth_id, PendingRequest::Authorize);
                                    send.send(Message::Text(authorize_frame(auth_id, token).into())).await?;
                                }
                                Frame::Heartbeat => {
                                    if send.send(Message::Text("[]".into())).await.is_err() {
                                        return Ok(());
                                    }
                                }
                                Frame::Closed(reason) => {
                                    return Err(IngestError::Payload(format!("server closed: {reason}")));
                                }
                                Frame::Messages(messages) => {
                                    for message in messages {
                                        // The authorize response is the gate: only after it
                                        // does the server accept market-data requests.
                                        if !authorized && ok_response(&message, auth_id) {
                                            authorized = true;
                                            for line in
                                                subscription_frames(wanted, &self.timeframes, &mut state)
                                            {
                                                if send.send(Message::Text(line.into())).await.is_err() {
                                                    return Ok(());
                                                }
                                            }
                                            continue;
                                        }
                                        handle_message(&message, wanted, &mut state, tx, &mut gap_fill);
                                    }
                                    last_frame = tokio::time::Instant::now();
                                    if !reported_live {
                                        reported_live = true;
                                        let _ = tx.send(FeedEvent::venue_status(
                                            Venue::Tradovate,
                                            FeedState::Live,
                                            "streaming",
                                        ));
                                    }
                                }
                            }
                        }
                        Message::Close(_) => return Ok(()),
                        _ => {}
                    }
                }
                _ = heartbeat.tick() => {
                    if authorized && send.send(Message::Text("[]".into())).await.is_err() {
                        return Ok(());
                    }
                }
            }
            if let Some((symbol, from, jumped_to)) = gap_fill.take() {
                // Tradovate has no gap-fill verb: re-asking for the chart from the last tick
                // the client actually applied is what re-delivers the prints in between.
                let id = state.take_id();
                state.pending.insert(id, PendingRequest::TickChart { symbol: symbol.clone() });
                let body = json!({
                    "symbol": symbol,
                    "chartDescription": tick_chart_description(),
                    "timeRange": { "asFarAsTimestamp": iso(from) },
                });
                let _ = tx.send(FeedEvent::status(
                    Venue::Tradovate,
                    Some(format!("{}:{}", Venue::Tradovate.tag(), symbol)),
                    FeedState::Backfilling,
                    format!("tick id jumped to {jumped_to}, re-requesting prints"),
                ));
                if send
                    .send(Message::Text(request_frame("md/getChart", id, "", &body.to_string()).into()))
                    .await
                    .is_err()
                {
                    return Ok(());
                }
            }
            if last_frame.elapsed() >= IDLE_AFTER && reported_live {
                reported_live = false;
                let _ = tx.send(FeedEvent::venue_status(
                    Venue::Tradovate,
                    FeedState::Stalled,
                    "no frames for 20s",
                ));
            }
        }
    }
}

/// Adapter-owned subscriptions per symbol.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Wanted {
    pub quote: bool,
    pub dom: bool,
    pub ticks: bool,
    pub charts: Vec<Timeframe>,
}

fn apply_command(wanted: &mut HashMap<String, Wanted>, command: &FeedCommand) {
    match command {
        FeedCommand::Subscribe { symbol, timeframe, .. } => {
            let row = wanted.entry(symbol.clone()).or_default();
            row.quote = true;
            row.dom = true;
            row.ticks = true;
            if !row.charts.contains(timeframe) {
                row.charts.push(*timeframe);
            }
        }
        FeedCommand::Unsubscribe { symbol, .. } => {
            wanted.remove(symbol);
        }
    }
}

/// The subscribe frames for everything currently wanted.
fn subscription_frames(
    wanted: &HashMap<String, Wanted>,
    timeframes: &[Timeframe],
    state: &mut Conn,
) -> Vec<String> {
    let mut out = Vec::new();
    for (symbol, row) in wanted {
        if row.quote {
            let id = state.take_id();
            state.pending.insert(id, PendingRequest::Other);
            out.push(request_frame(
                "md/subscribeQuote",
                id,
                "",
                &json!({ "symbol": symbol }).to_string(),
            ));
        }
        if row.dom {
            let id = state.take_id();
            state.pending.insert(id, PendingRequest::Other);
            out.push(request_frame(
                "md/subscribeDOM",
                id,
                "",
                &json!({ "symbol": symbol }).to_string(),
            ));
        }
        if row.ticks {
            let id = state.take_id();
            state.pending.insert(id, PendingRequest::TickChart { symbol: symbol.clone() });
            let body = json!({
                "symbol": symbol,
                "chartDescription": tick_chart_description(),
                "timeRange": { "asMuchAsElements": 200 },
            });
            out.push(request_frame("md/getChart", id, "", &body.to_string()));
        }
        let mut charts = row.charts.clone();
        for extra in timeframes {
            if !charts.contains(extra) {
                charts.push(*extra);
            }
        }
        for timeframe in charts {
            let Ok(description) = chart_description(timeframe) else { continue };
            let id = state.take_id();
            state.pending.insert(id, PendingRequest::Chart { symbol: symbol.clone(), timeframe });
            let body = json!({
                "symbol": symbol,
                "chartDescription": description,
                "timeRange": { "asMuchAsElements": 500 },
            });
            out.push(request_frame("md/getChart", id, "", &body.to_string()));
        }
    }
    out
}

/// True when a message is the 2xx response to request `id`.
fn ok_response(message: &Value, id: u64) -> bool {
    message.get("i").and_then(Value::as_u64) == Some(id)
        && matches!(message.get("s").and_then(Value::as_u64), Some(200..=299))
}

/// Apply one decoded message from an `'a'` frame.
fn handle_message(
    message: &Value,
    wanted: &HashMap<String, Wanted>,
    state: &mut Conn,
    tx: &mpsc::UnboundedSender<FeedEvent>,
    gap_fill: &mut Option<(String, i64, u64)>,
) {
    let instrument = |symbol: &str| format!("{}:{}", Venue::Tradovate.tag(), symbol);
    // A response carries `i` (the request id) and `s` (an HTTP-like status).
    if let Some(id) = message.get("i").and_then(Value::as_u64) {
        let status = message.get("s").and_then(Value::as_u64).unwrap_or(0);
        if status != 200 {
            tracing::warn!("tradovate request {id} failed with status {status}");
        }
        state.pending.remove(&id);
        return;
    }
    let Some(kind) = message.get("e").and_then(Value::as_str) else { return };
    let data = message.get("d");
    match kind {
        "md" => {
            let Some(data) = data else { return };
            for row in data.get("quotes").and_then(Value::as_array).into_iter().flatten() {
                let Some(symbol) = symbol_of(row, state, wanted) else { continue };
                let (depth, trade) = parse_quote(row);
                if let Some(snapshot) = depth {
                    let _ = tx.send(FeedEvent::Depth { instrument: instrument(&symbol), snapshot });
                }
                // The quote's `Trade` entry is the same last print the tick chart delivers
                // with an id, so it is dropped rather than published twice without a key.
                let _ = trade;
            }
            for row in data.get("doms").and_then(Value::as_array).into_iter().flatten() {
                let Some(symbol) = symbol_of(row, state, wanted) else { continue };
                if let Some(snapshot) = parse_dom(row) {
                    let _ = tx.send(FeedEvent::Depth { instrument: instrument(&symbol), snapshot });
                }
            }
        }
        "chart" => {
            let Some(charts) = data.and_then(|d| d.get("charts")).and_then(Value::as_array) else {
                return;
            };
            for packet in charts {
                let Some(symbol) = symbol_of(packet, state, wanted) else { continue };
                if packet.get("eoh").and_then(Value::as_bool).unwrap_or(false) {
                    continue;
                }
                // A tick packet states the contract's tick size, which the REST entity does
                // not, so this is where the ladder's precision comes from.
                if let Some(tick) = packet.get("ts").and_then(Value::as_f64) {
                    if tick > 0.0 {
                        state.ticks.insert(symbol.clone(), tick);
                    }
                }
                let prints = parse_ticks(packet);
                if !prints.is_empty() {
                    let first = prints.first().map(|trade| trade.seq).unwrap_or(0);
                    let last_seen = state.last_tick.get(&symbol).copied();
                    // The hole is usually inside the packet: the venue replays the last
                    // prints it had, so the jump sits between two of its own rows. A fill is
                    // asked for from the print before the hole, which is the point the
                    // missing ticks start.
                    let inside = prints
                        .windows(2)
                        .find(|pair| !continues(Some(pair[0].seq), pair[1].seq))
                        .map(|pair| (pair[0].ts, pair[1].seq));
                    let hole = inside.or_else(|| {
                        if continues(last_seen, first) {
                            None
                        } else {
                            let from = state
                                .last_tick_time
                                .get(&symbol)
                                .copied()
                                .or_else(|| prints.first().map(|trade| trade.ts))
                                .unwrap_or(0);
                            Some((from, first))
                        }
                    });
                    if let Some((from, jumped_to)) = hole {
                        *gap_fill = Some((symbol.clone(), from, jumped_to));
                    }
                    for trade in &prints {
                        state.last_tick.insert(symbol.clone(), trade.seq);
                        state.last_tick_time.insert(symbol.clone(), trade.ts);
                    }
                    let _ = tx.send(FeedEvent::Trades { instrument: instrument(&symbol), trades: prints });
                }
                let bars = parse_bars(packet);
                for bar in bars {
                    let timeframe = chart_of(packet, state).unwrap_or(Timeframe::Minute(1));
                    let _ = tx.send(FeedEvent::Bar {
                        instrument: instrument(&symbol),
                        timeframe,
                        bar,
                    });
                }
            }
        }
        _ => {}
    }
}

/// Market data rows name the contract by id, so the id→symbol map built at subscribe time
/// is the only way back to the instrument.
fn symbol_of(
    row: &Value,
    state: &Conn,
    wanted: &HashMap<String, Wanted>,
) -> Option<String> {
    if let Some(id) = row.get("contractId").and_then(Value::as_i64) {
        if let Some(symbol) = state.by_contract.get(&id) {
            return Some(symbol.clone());
        }
    }
    let symbol = row.get("symbol").and_then(Value::as_str)?;
    if !wanted.contains_key(symbol) {
        tracing::debug!("tradovate data for an unsubscribed symbol {symbol}");
    }
    Some(symbol.to_string())
}

/// Which timeframe a bar packet belongs to: the request id the server echoes as `id`.
fn chart_of(packet: &Value, state: &Conn) -> Option<Timeframe> {
    let id = packet.get("id").and_then(Value::as_u64)?;
    match state.pending.get(&id)? {
        PendingRequest::Chart { timeframe, .. } => Some(*timeframe),
        _ => None,
    }
}

/// Epoch ms → the `YYYY-MM-DDTHH:MMZ` form Tradovate's `timeRange` accepts.
fn iso(ms: i64) -> String {
    let secs = ms / 1000;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Inverse of the civil-days algorithm above.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{year:04}-{:02}-{:02}T{:02}:{:02}Z",
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads the files under `fixtures/tradovate/` and asserts their values, so a fixture
    /// that drifts from the parser fails here rather than in front of the user.
    #[test]
    fn fixtures_parse_into_core_types() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/tradovate");
        let read = |name: &str| -> Value {
            let text = std::fs::read_to_string(dir.join(name)).expect(name);
            serde_json::from_str(&text).expect(name)
        };

        let quote = read("quote.json");
        let entries = &quote["d"]["quotes"][0];
        let (depth, trade) = parse_quote(entries);
        let snapshot = depth.expect("a bid and an offer");
        assert_eq!(snapshot.ts, 1_618_289_946_588);
        assert_eq!(snapshot.bids[0].price, 18_405.123);
        assert_eq!(snapshot.asks[0].price, 18_410.012);
        assert_eq!(trade.expect("the Trade entry").qty, 2.1);

        let dom = read("dom.json");
        let snapshot = parse_dom(&dom["d"]["doms"][0]).expect("a DOM book");
        assert_eq!(snapshot.bids.len(), 3);
        assert_eq!(snapshot.bids[2].qty, 758.21);
        assert_eq!(snapshot.asks[1].price, 2337.75);

        let chart = read("chart-bars.json");
        let bars = parse_bars(&chart["d"]["charts"][0]);
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].start, 1_492_081_200_000, "2017-04-13T11:00Z");
        assert_eq!(bars[0].high, 2334.5);
        assert!((bars[0].volume - 4913.358).abs() < 1e-9);
        assert_eq!(bars[1].trades, 62);

        let packet = &read("tick-packet.json")["d"]["charts"][0];
        let prints = parse_ticks(packet);
        assert_eq!(prints.len(), 3);
        assert_eq!(prints[0].price, 2979.25);
        assert_eq!(prints[1].price, 2980.25);
        assert_eq!(prints[2].price, 2979.75);
        assert_eq!(prints[0].seq, 11_768_401);
        assert_eq!(prints[2].ts, 1_563_421_182_735);
        assert!(continues(Some(prints[0].seq), prints[1].seq));

        let gapped = &read("tick-gap.json")["d"]["charts"][0];
        let prints = parse_ticks(gapped);
        assert_eq!(prints.len(), 3);
        assert!(!continues(Some(prints[1].seq), prints[2].seq), "ids 3..6 are missing");

        let frames = std::fs::read_to_string(dir.join("frames.txt")).expect("frames.txt");
        let decoded: Vec<Frame> = frames
            .lines()
            .filter(|line| !line.starts_with('#') && !line.trim().is_empty())
            .map(|line| decode_frame(line).expect("a documented frame"))
            .collect();
        assert_eq!(decoded[0], Frame::Open);
        assert_eq!(decoded[1], Frame::Heartbeat);
        // The authorize response is the first `a` frame in the file.
        assert_eq!(decoded[2], Frame::Messages(vec![json!({"s": 200, "i": 2})]));
        assert_eq!(decoded[4], Frame::Closed("[3000,\"Go away!\"]".into()));
        assert_eq!(decoded.len(), 5);
    }

    #[test]
    fn frames_decode_their_prefix() {
        assert_eq!(decode_frame("o"), Some(Frame::Open));
        assert_eq!(decode_frame("h"), Some(Frame::Heartbeat));
        assert_eq!(decode_frame("c[3000,\"Go away!\"]"), Some(Frame::Closed("[3000,\"Go away!\"]".into())));
        assert_eq!(
            decode_frame("a[{\"s\":200,\"i\":2}]"),
            Some(Frame::Messages(vec![json!({"s":200,"i":2})]))
        );
        assert_eq!(decode_frame("z?"), None);
    }

    #[test]
    fn requests_are_four_newline_separated_fields() {
        assert_eq!(request_frame("executionReport/list", 4, "", ""), "executionReport/list\n4\n\n\n");
        assert_eq!(
            request_frame("tradingPermission/ldeps", 8, "masterids=1", ""),
            // The docs' example shows the query line last; the empty body field is the
            // fourth field the protocol requires.
            "tradingPermission/ldeps\n8\nmasterids=1\n\n"
        );
        assert_eq!(authorize_frame(2, "tok"), "authorize\n2\n\ntok\n");
    }

    #[test]
    fn timestamps_parse_the_venues_own_strings() {
        assert_eq!(parse_timestamp("2021-04-13T04:59:06.588Z"), Some(1_618_289_946_588));
        assert_eq!(parse_timestamp("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_timestamp("2017-04-13T11:33Z"), Some(1_492_083_180_000));
        assert_eq!(parse_timestamp("nonsense"), None);
    }

    #[test]
    fn iso_round_trips_a_timestamp() {
        assert_eq!(iso(parse_timestamp("2017-04-13T11:33:00Z").unwrap()), "2017-04-13T11:33Z");
    }

    #[test]
    fn chart_descriptions_use_the_documented_types() {
        assert_eq!(chart_description(Timeframe::Minute(5)).unwrap()["underlyingType"], "MinuteBar");
        assert_eq!(chart_description(Timeframe::Minute(5)).unwrap()["elementSize"], 5);
        assert_eq!(chart_description(Timeframe::Hour(2)).unwrap()["elementSize"], 120);
        assert_eq!(chart_description(Timeframe::Day(1)).unwrap()["underlyingType"], "DailyBar");
        assert!(chart_description(Timeframe::Second(5)).is_err());
    }

    #[test]
    fn a_quote_frame_becomes_a_top_of_book_ladder() {
        let value = json!({
            "timestamp": "2021-04-13T04:59:06.588Z",
            "contractId": 123_456,
            "entries": {
                "Bid": { "price": 18405.123, "size": 7.123 },
                "Offer": { "price": 18410.012, "size": 12.35 },
                "Trade": { "price": 18405.023, "size": 2.10 }
            }
        });
        let (depth, trade) = parse_quote(&value);
        let snapshot = depth.expect("a bid and an offer make a ladder");
        assert_eq!(snapshot.ts, 1_618_289_946_588);
        assert_eq!(snapshot.bids[0].price, 18405.123);
        assert_eq!(snapshot.bids[0].qty, 7.123);
        assert_eq!(snapshot.asks[0].price, 18410.012);
        assert_eq!(snapshot.asks[0].qty, 12.35);
        let trade = trade.expect("the Trade entry is the last print");
        assert_eq!(trade.price, 18405.023);
        assert_eq!(trade.qty, 2.10);
    }

    #[test]
    fn a_dom_frame_becomes_the_ladder_in_order() {
        let value = json!({
            "contractId": 123_456,
            "timestamp": "2021-04-13T11:33:57.488Z",
            "bids": [{"price": 2335.25, "size": 33.54}, {"price": 2333.0, "size": 758.21}],
            "offers": [{"price": 2335.5, "size": 255.12}, {"price": 2337.75, "size": 466.64}]
        });
        let snapshot = parse_dom(&value).expect("a DOM snapshot");
        assert_eq!(snapshot.bids.len(), 2);
        assert_eq!(snapshot.bids[0].price, 2335.25);
        assert_eq!(snapshot.bids[1].qty, 758.21);
        assert_eq!(snapshot.asks.last().unwrap().price, 2337.75);
        assert_eq!(snapshot.asks[0].price, 2335.5);
        assert_eq!(snapshot.bids[1].price, 2333.0, "depth keeps every row it was sent");
    }

    #[test]
    fn a_chart_packet_becomes_candles() {
        let value = json!({
            "id": 9,
            "td": 20_170_413,
            "bars": [{
                "timestamp": "2017-04-13T11:00:00.000Z",
                "open": 2334.25, "high": 2334.5, "low": 2333.0, "close": 2333.75,
                "upVolume": 4712.234, "downVolume": 201.124,
                "upTicks": 1333, "downTicks": 82
            }]
        });
        let bars = parse_bars(&value);
        assert_eq!(bars.len(), 1);
        let bar = &bars[0];
        assert_eq!(bar.start, parse_timestamp("2017-04-13T11:00:00.000Z").unwrap());
        assert_eq!((bar.open, bar.high, bar.low, bar.close), (2334.25, 2334.5, 2333.0, 2333.75));
        assert!((bar.volume - 4913.358).abs() < 1e-9, "volume is up plus down");
        assert_eq!(bar.trades, 1415);
    }

    #[test]
    fn tick_prices_are_relative_to_the_packet() {
        let packet = json!({
            "id": 16_335, "s": "db", "td": 20_210_718, "bp": 11_917, "bt": 1_563_421_179_735_i64, "ts": 0.25,
            "tks": [
                { "t": 0, "p": 0, "s": 3, "b": -1, "a": 0, "bs": 122.21, "as": 28.35, "id": 11_768_401 },
                { "t": 1_500, "p": 4, "s": 1, "id": 11_768_402 }
            ]
        });
        let prints = parse_ticks(&packet);
        assert_eq!(prints.len(), 2);
        assert_eq!(prints[0].price, 2979.25, "(bp + p) * ts");
        assert_eq!(prints[0].ts, 1_563_421_179_735_i64);
        assert_eq!(prints[0].seq, 11_768_401);
        assert_eq!(prints[0].qty, 3.0);
        assert_eq!(prints[0].aggressor, Side::Buy, "the print is at the ask level (a = 0)");
        assert_eq!(prints[1].price, 2980.25);
        assert_eq!(prints[1].ts, 1_563_421_181_235, "bt + t");
        assert_eq!(prints[1].seq, 11_768_402);
    }

    #[test]
    fn a_tick_id_jump_is_a_gap() {
        assert!(continues(None, 10));
        assert!(continues(Some(10), 11), "the next id continues the run");
        assert!(continues(Some(10), 10), "a repeat is already applied");
        assert!(!continues(Some(10), 12), "id 11 was never seen");
    }

    #[test]
    fn subscribing_asks_for_every_channel_the_core_types_need() {
        let mut wanted = HashMap::new();
        apply_command(
            &mut wanted,
            &FeedCommand::Subscribe {
                venue: Venue::Tradovate,
                symbol: "ESZ6".into(),
                timeframe: Timeframe::Minute(5),
            },
        );
        let mut state = Conn::new();
        let frames = subscription_frames(&wanted, &[Timeframe::Hour(1)], &mut state);
        let text = frames.join("");
        assert!(text.contains("md/subscribeQuote"), "{text}");
        assert!(text.contains("md/subscribeDOM"), "{text}");
        assert!(text.contains("\"underlyingType\":\"Tick\""), "{text}");
        assert!(text.contains("\"elementSize\":5"), "{text}");
        assert!(text.contains("\"elementSize\":60"), "the server's own timeframes too");
        assert_eq!(frames.len(), 5, "quote + dom + tick + two charts");
    }
}
