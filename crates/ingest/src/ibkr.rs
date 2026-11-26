//! Interactive Brokers, through the Web API (Client Portal Gateway) rather than the TWS
//! socket API: same data, JSON on the wire, and the entitlement question is answered by
//! the venue instead of guessed.
//!
//! Sources, all IBKR's own:
//! * Web API WebSocket connection and the `/tickle` session token:
//!   <https://www.interactivebrokers.com/docs/web-api/ws/connection-guide.md>
//! * Topic grammar `TOPIC+[TARGET]+{PARAMS}` and which topics need a brokerage session:
//!   <https://www.interactivebrokers.com/docs/web-api/ws/introduction.md>
//! * `smd` streaming market data, the field ids, and field 6509 *Market Data Availability*:
//!   <https://www.interactivebrokers.com/docs/web-api/ws/streaming-data.md>
//! * `smh` historical bars, with `mktDataDelay` and `mdAvailability` on the reply:
//!   <https://www.interactivebrokers.com/docs/web-api/ws/historical-data.md>
//! * `sbd` BookTrader price ladder:
//!   <https://www.interactivebrokers.com/docs/web-api/ws/booktrader.md>
//! * `tic` keep-alive: <https://www.interactivebrokers.com/docs/web-api/ws/ping.md>
//! * `GET /v1/api/iserver/secdef/search` for symbol → conid:
//!   <https://www.interactivebrokers.com/docs/web-api/v1/endpoints/contract/search-contract-by-symbol.md>
//! * Market data types Live/Frozen/Delayed/Delayed-Frozen and the 15-20 minute delay:
//!   <https://www.interactivebrokers.com/docs/tws-api/doc/md/delayed-data.md>
//!
//! An account without a streaming entitlement still gets data — 15 to 20 minutes late — so
//! this adapter reports `delayed`, never `live`, whenever the venue says so.

use std::collections::HashMap;
use std::time::Duration;

use chartkit_core::instrument::VenueTag;
use chartkit_core::{
    AssetClass, Bar, DepthSnapshot, Instrument, Level, Session, Side, Timeframe, Trade, Venue,
};
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::http::HeaderName;

use crate::credentials::{slug, CredentialStore};
use crate::event::{FeedCommand, FeedEvent, FeedState};
use crate::IngestError;

/// Default Client Portal Gateway origin. The docs use `https://localhost:5000` throughout.
pub const CP_BASE: &str = "https://localhost:5000";
/// Prefix every Web API endpoint sits behind.
pub const API_PREFIX: &str = "/v1/api";
/// The OAuth origin, for a bearer token instead of a local gateway.
pub const OAUTH_WS: &str = "wss://api.ibkr.com/v1/api/ws";
/// Watchlist fields this adapter asks for. Ids and meanings are from the *Market Data
/// Fields* list on the streaming-data page.
pub const FIELDS: [&str; 7] = ["31", "84", "85", "86", "88", "7059", "6509"];
/// A stream that stops answering for this long is treated as stalled.
const IDLE_AFTER: Duration = Duration::from_secs(30);
/// The docs advise pinging at least once a minute to hold the brokerage session.
const PING_EVERY: Duration = Duration::from_secs(50);
/// `smd` streams die after 15 minutes; resubscribe inside 10.
const DEFAULT_RESUBSCRIBE: Duration = Duration::from_secs(9 * 60);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Rows kept per side of the ladder.
const DEPTH_LEVELS: usize = 40;

/// What the adapter needs before it can connect. Nothing is compiled in.
#[derive(Clone, Debug)]
pub struct IbkrConfig {
    /// Origin of a Client Portal Gateway, e.g. `https://localhost:5000`.
    pub base_url: String,
    /// OAuth bearer token, only needed when not using a local gateway.
    pub bearer_token: Option<String>,
    /// Account id, required by the `sbd` price ladder topic.
    pub account: Option<String>,
    /// Socket override for the localhost fake venue.
    pub ws_url: Option<String>,
    /// How often to re-issue `smd` subscriptions; the venue drops them after 15 minutes.
    pub resubscribe_after: Duration,
    /// A session id from `/tickle`, taken as given. Skips the HTTP call, which is what
    /// lets a test drive the socket without a running gateway.
    pub session: Option<String>,
}

impl IbkrConfig {
    pub fn from_store(store: &CredentialStore) -> Result<Self, String> {
        let status = store.status(Venue::InteractiveBrokers);
        if !status.configured {
            return Err(format!(
                "start IB Gateway in Client Portal mode and set IBKR_BASE_URL (or fill the IBKR \
                 row in Settings > Feeds, writing {}); chartkit --check-feed {}",
                store.path().display(),
                slug(Venue::InteractiveBrokers)
            ));
        }
        Ok(Self {
            base_url: store
                .value(Venue::InteractiveBrokers, "base_url")
                .unwrap_or_else(|| CP_BASE.to_string()),
            bearer_token: store.value(Venue::InteractiveBrokers, "bearer_token"),
            account: store.value(Venue::InteractiveBrokers, "account"),
            ws_url: None,
            resubscribe_after: DEFAULT_RESUBSCRIBE,
            session: None,
        })
    }

    /// `wss://{host}/v1/api/ws` for a gateway, or the OAuth origin when a token is set.
    pub fn ws_url(&self) -> String {
        if let Some(url) = &self.ws_url {
            return url.clone();
        }
        if self.bearer_token.is_some() {
            return OAUTH_WS.to_string();
        }
        let origin = self
            .base_url
            .replace("http://", "ws://")
            .replace("https://", "wss://")
            .trim_end_matches('/')
            .to_string();
        format!("{origin}{API_PREFIX}/ws")
    }
}

/// Where the venue says this data actually comes from. Field 6509's first character is the
/// marker: R RealTime, D Delayed, Z Frozen, Y Frozen Delayed, N Not Subscribed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entitlement {
    RealTime,
    Delayed,
    Frozen,
    FrozenDelayed,
    NotSubscribed,
    Unknown,
}

impl Entitlement {
    /// Parse the leading character of field 6509, or `mktDataDelay` from an `smh` reply.
    pub fn from_marker(marker: &str) -> Self {
        match marker.chars().next() {
            Some('R') => Entitlement::RealTime,
            Some('D') => Entitlement::Delayed,
            Some('Z') => Entitlement::Frozen,
            Some('Y') => Entitlement::FrozenDelayed,
            Some('N') => Entitlement::NotSubscribed,
            _ => Entitlement::Unknown,
        }
    }

    /// Seconds the venue itself reports as delay, from `mktDataDelay`.
    pub fn from_delay(seconds: i64) -> Self {
        if seconds > 0 {
            Entitlement::Delayed
        } else {
            Entitlement::RealTime
        }
    }

    /// The state the status strip shows. Only a real-time marker reads as live.
    pub fn state(self) -> FeedState {
        match self {
            Entitlement::RealTime => FeedState::Live,
            Entitlement::Delayed | Entitlement::FrozenDelayed => FeedState::Delayed,
            Entitlement::NotSubscribed => FeedState::Failed,
            // Frozen and Unknown still arrive, but the strip must not claim real time.
            Entitlement::Frozen | Entitlement::Unknown => FeedState::Delayed,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Entitlement::RealTime => "realtime",
            Entitlement::Delayed => "delayed 15-20 min",
            Entitlement::Frozen => "frozen",
            Entitlement::FrozenDelayed => "frozen delayed",
            Entitlement::NotSubscribed => "no market data subscription",
            Entitlement::Unknown => "entitlement unknown",
        }
    }
}

/// Bar interval for a timeframe, from the `bar` values the `smh` page lists.
pub fn bar_interval(timeframe: Timeframe) -> Result<String, IngestError> {
    let text = match timeframe {
        Timeframe::Minute(n) if matches!(n, 1 | 2 | 3 | 5 | 10 | 15 | 30) => return Ok(format!("{n}min")),
        Timeframe::Hour(n) if matches!(n, 1 | 2 | 3 | 4 | 8) => return Ok(format!("{n}h")),
        Timeframe::Day(1) => "1d",
        Timeframe::Week(1) => "1w",
        Timeframe::Month(1) => "1m",
        other => return Err(IngestError::UnsupportedInterval(other.as_key())),
    };
    Ok(text.to_string())
}

/// The `smd` subscribe line: topic, conid, then the field list as JSON.
pub fn subscribe_frame(conid: &str, fields: &[&str]) -> String {
    let list = fields
        .iter()
        .map(|field| format!("\"{field}\""))
        .collect::<Vec<_>>()
        .join(",");
    format!("smd+{conid}+{{\"fields\":[{list}]}}")
}

/// The `umd` unsubscribe line.
pub fn unsubscribe_frame(conid: &str) -> String {
    format!("umd+{conid}+{{}}")
}

/// The `smh` historical-bar line. `format` names the values to return, in order.
pub fn history_frame(conid: &str, timeframe: Timeframe, period: &str) -> Result<String, IngestError> {
    let bar = bar_interval(timeframe)?;
    Ok(format!(
        "smh+{conid}+{{\"exchange\":\"SMART\",\"period\":\"{period}\",\"bar\":\"{bar}\",\
         \"outsideRth\":false,\"source\":\"trades\",\"format\":\"%o/%c/%h/%l/%v\"}}"
    ))
}

/// The `sbd` ladder line: topic, account, conid, then an optional routing exchange.
pub fn depth_frame(account: &str, conid: &str, exchange: Option<&str>) -> String {
    match exchange {
        Some(venue) => format!("sbd+{account}+{conid}+{venue}"),
        None => format!("sbd+{account}+{conid}"),
    }
}

/// One `smd` reply, in the shape the streaming-data page documents.
#[derive(Clone, Debug)]
pub struct MarketDataUpdate {
    pub conid: String,
    pub updated: i64,
    pub entitlement: Entitlement,
    pub last: Option<f64>,
    pub last_size: Option<f64>,
    pub bid: Option<(f64, f64)>,
    pub ask: Option<(f64, f64)>,
}

/// Parse one `smd` message. Values arrive as strings, so an unparsable field is skipped
/// rather than dropping the whole update.
pub fn parse_market_data(message: &Value) -> Option<MarketDataUpdate> {
    let conid = message
        .get("conid")
        .and_then(|value| value.as_str().map(str::to_string).or_else(|| value.as_i64().map(|n| n.to_string())))
        .or_else(|| {
            message
                .get("conidEx")
                .and_then(Value::as_str)
                .map(|text| text.split('@').next().unwrap_or(text).to_string())
        })?;
    let field = |key: &str| -> Option<f64> {
        message
            .get(key)
            .and_then(|value| value.as_str().and_then(|text| text.parse::<f64>().ok()).or_else(|| value.as_f64()))
    };
    let size = |key: &str| -> f64 {
        message
            .get(key)
            .and_then(|value| value.as_str().and_then(|text| text.parse::<f64>().ok()).or_else(|| value.as_f64()))
            .unwrap_or(0.0)
    };
    // A price of -1 means "no data right now" in the IBKR watchlist stream, and a crossed
    // ladder from a placeholder is worse than no ladder at all.
    let usable = |price: Option<f64>| price.filter(|value| *value > 0.0);
    let bid = usable(field("84")).map(|price| (price, size("88")));
    let ask = usable(field("86")).map(|price| (price, size("85")));
    Some(MarketDataUpdate {
        conid,
        updated: message.get("_updated").and_then(Value::as_i64).unwrap_or_default(),
        entitlement: Entitlement::from_marker(
            message.get("6509").and_then(Value::as_str).unwrap_or(""),
        ),
        last: usable(field("31")),
        last_size: field("7059"),
        bid,
        ask,
    })
}

/// A top-of-book ladder from one update. IBKR's `smd` topic is level one, so this is two
/// levels wide at most; `sbd` supplies the deeper book.
pub fn depth_from_update(update: &MarketDataUpdate) -> Option<DepthSnapshot> {
    let bids: Vec<Level> = update.bid.map(|(price, qty)| Level { price, qty }).into_iter().collect();
    let asks: Vec<Level> = update.ask.map(|(price, qty)| Level { price, qty }).into_iter().collect();
    if bids.is_empty() && asks.is_empty() {
        return None;
    }
    Some(DepthSnapshot { ts: update.updated, bids, asks })
}

/// A print from the last-price fields. `_updated` is used as the sequence: the docs cap
/// this stream at one update per 500 ms, so two different prints cannot share a stamp.
pub fn trade_from_update(update: &MarketDataUpdate) -> Option<Trade> {
    Some(Trade {
        ts: update.updated,
        seq: update.updated as u64,
        price: update.last?,
        qty: update.last_size.unwrap_or(0.0),
        // The watchlist stream carries no aggressor, so a print is reported as a buy and
        // the footprint reads it as such.
        aggressor: Side::Buy,
    })
}

/// One `smh` reply's bars: `data[]` of `{o,c,h,l,v,t}` with `t` in epoch seconds.
pub fn parse_history(message: &Value) -> (Vec<Bar>, Entitlement) {
    let entitlement = match message.get("mktDataDelay").and_then(Value::as_i64) {
        Some(delay) => Entitlement::from_delay(delay),
        None => Entitlement::from_marker(
            message.get("mdAvailability").and_then(Value::as_str).unwrap_or(""),
        ),
    };
    // `priceFactor` scales the values when it is present: 100 means the numbers are in
    // pennies, so dividing returns contract price.
    let factor = message.get("priceFactor").and_then(Value::as_f64).filter(|v| *v > 0.0);
    let scale = |value: f64| match factor {
        Some(factor) => value / factor,
        None => value,
    };
    let bars = message
        .get("data")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let num = |key: &str| row.get(key).and_then(Value::as_f64);
                    let start = row.get("t").and_then(Value::as_i64)? * 1000;
                    Some(Bar {
                        start,
                        open: scale(num("o")?),
                        high: scale(num("h")?),
                        low: scale(num("l")?),
                        close: scale(num("c")?),
                        volume: num("v").unwrap_or(0.0),
                        trades: 0,
                        closed: true,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (bars, entitlement)
}

/// One `sbd` ladder reply: rows of `{row, focus, price, bid, ask}`.
pub fn parse_ladder(message: &Value) -> Option<DepthSnapshot> {
    let rows = message.get("data").and_then(Value::as_array)?;
    let mut bids = Vec::new();
    let mut asks = Vec::new();
    for row in rows {
        let Some(price) = row.get("price").and_then(Value::as_str).and_then(|text| {
            // The docs note a row may read "size @ price"; take the number after the '@'.
            text.split('@').next_back().unwrap_or(text).trim().parse::<f64>().ok()
        }) else {
            continue;
        };
        let bid = row.get("bid").and_then(Value::as_str).and_then(|text| text.parse::<f64>().ok()).unwrap_or(0.0);
        let ask = row.get("ask").and_then(Value::as_str).and_then(|text| text.parse::<f64>().ok()).unwrap_or(0.0);
        if bid > 0.0 {
            bids.push(Level { price, qty: bid });
        }
        if ask > 0.0 {
            asks.push(Level { price, qty: ask });
        }
    }
    if bids.is_empty() && asks.is_empty() {
        return None;
    }
    bids.sort_by(|a, b| b.price.partial_cmp(&a.price).unwrap_or(std::cmp::Ordering::Equal));
    asks.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal));
    bids.truncate(DEPTH_LEVELS);
    asks.truncate(DEPTH_LEVELS);
    Some(DepthSnapshot { ts: chartkit_core::now_ms(), bids, asks })
}

/// Instrument rows from `GET /v1/api/iserver/secdef/search`.
pub fn instruments_from_search(symbol: &str, body: &Value) -> Vec<Instrument> {
    let rows = match body {
        Value::Array(rows) => rows.clone(),
        Value::Object(_) => vec![body.clone()],
        _ => Vec::new(),
    };
    rows.iter()
        .filter_map(|row| {
            let conid = row
                .get("conid")
                .and_then(|value| value.as_str().map(str::to_string).or_else(|| value.as_i64().map(|n| n.to_string())))?;
            let ticker = row.get("symbol").and_then(Value::as_str).unwrap_or(symbol);
            let name = row
                .get("companyName")
                .and_then(Value::as_str)
                .or_else(|| row.get("companyHeader").and_then(Value::as_str))
                .unwrap_or(ticker);
            let sec_type = row
                .get("sections")
                .and_then(Value::as_array)
                .and_then(|sections| sections.first())
                .and_then(|section| section.get("secType"))
                .and_then(Value::as_str)
                .unwrap_or("STK");
            Some(Instrument {
                id: format!("{}:{conid}", Venue::InteractiveBrokers.tag()),
                venue: Venue::InteractiveBrokers,
                symbol: ticker.to_string(),
                display: ticker.to_string(),
                name: name.to_string(),
                asset_class: match sec_type {
                    "STK" => AssetClass::Equity,
                    "FUT" => AssetClass::Future,
                    "OPT" => AssetClass::Option,
                    "CASH" => AssetClass::Forex,
                    _ => AssetClass::Other,
                },
                // The search reply carries no tick size; one cent is the US equity default
                // and the ladder re-derives its own row spacing from the prices it gets.
                price_tick: 0.01,
                qty_step: 1.0,
                price_precision: 2,
                qty_precision: 0,
                quote_currency: "USD".to_string(),
                session: Session::continuous(),
                active: row.get("restricted").and_then(Value::as_bool).map(|blocked| !blocked).unwrap_or(true),
            })
        })
        .collect()
}

/// IBKR feed: one socket per gateway session, many contracts, reconnecting forever.
pub struct IbkrFeed {
    config: IbkrConfig,
    timeframes: Vec<Timeframe>,
    client: Client,
}

impl IbkrFeed {
    pub fn new(config: IbkrConfig, timeframes: Vec<Timeframe>) -> Self {
        let client = Client::builder()
            // The gateway uses a self-signed certificate, so certificate failures are the
            // user's to accept rather than something this client should argue about.
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        Self { config, timeframes, client }
    }

    /// `GET /v1/api/tickle` → the session value the socket cookie carries.
    pub async fn tickle(&self) -> Result<String, IngestError> {
        let body: Value = self
            .client
            .get(format!("{}{API_PREFIX}/tickle", self.config.base_url))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        body.get("session")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| IngestError::Payload("tickle returned no session".into()))
    }

    /// Symbol → conid, so the watchlist can hold IBKR instruments at all.
    pub async fn load_instruments(&self, symbol: &str) -> Result<Vec<Instrument>, IngestError> {
        let body: Value = self
            .client
            .get(format!("{}{API_PREFIX}/iserver/secdef/search", self.config.base_url))
            .query(&[("symbol", symbol)])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(instruments_from_search(symbol, &body))
    }

    /// Connect, subscribe, publish, reconnect forever.
    pub async fn run(
        self,
        mut commands: mpsc::UnboundedReceiver<FeedCommand>,
        tx: mpsc::UnboundedSender<FeedEvent>,
    ) -> Result<(), IngestError> {
        // conid → the symbol the user typed, so events can name their instrument.
        let mut wanted: HashMap<String, String> = HashMap::new();
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
            let session = match (&self.config.session, self.tickle().await) {
                (Some(session), _) => Some(session.clone()),
                (None, Ok(session)) => Some(session),
                (None, Err(error)) => {
                    tracing::warn!("ibkr tickle failed: {error}");
                    None
                }
            };
            let _ = tx.send(FeedEvent::venue_status(
                Venue::InteractiveBrokers,
                FeedState::Connecting,
                "connecting",
            ));
            match self.open(session.as_deref()).await {
                Ok(socket) => {
                    backoff = Duration::from_millis(500);
                    if let Err(error) = self.socket(socket, &mut commands, &mut wanted, &tx).await {
                        tracing::warn!("ibkr socket ended: {error}");
                    }
                }
                Err(error) => {
                    tracing::warn!("ibkr connect failed: {error}");
                    let _ = tx.send(FeedEvent::venue_status(
                        Venue::InteractiveBrokers,
                        FeedState::Failed,
                        format!("{}: {error}", self.config.ws_url()),
                    ));
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    /// Open the socket. A gateway session rides in the `api` cookie; an OAuth connection
    /// carries its bearer token as a query parameter instead.
    async fn open(
        &self,
        session: Option<&str>,
    ) -> Result<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        IngestError,
    > {
        let mut url = self.config.ws_url();
        if let Some(token) = &self.config.bearer_token {
            url.push_str(&format!("?bearer_token={token}"));
        }
        let mut request = url.into_client_request()?;
        let agent = header(&format!("chartkit/{}", env!("CARGO_PKG_VERSION")))?;
        request.headers_mut().insert(HeaderName::from_static("user-agent"), agent);
        if let Some(session) = session {
            // The connection guide spells the cookie out as `api={"<session>"}`.
            request.headers_mut().insert(
                HeaderName::from_static("cookie"),
                header(&format!(r#"api={{"{session}"}}"#))?,
            );
        }
        let (socket, _) = connect_async(request).await?;
        Ok(socket)
    }

    /// One connection: resubscribe everything wanted, then serve frames and commands.
    async fn socket(
        &self,
        socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        commands: &mut mpsc::UnboundedReceiver<FeedCommand>,
        wanted: &mut HashMap<String, String>,
        tx: &mpsc::UnboundedSender<FeedEvent>,
    ) -> Result<(), IngestError> {
        let (mut send, mut recv) = socket.split();
        let mut entitlement = Entitlement::Unknown;
        // conid → the newest `_updated` applied, so a replayed older frame is recognised.
        let mut last_update: HashMap<String, i64> = HashMap::new();
        let mut ping = tokio::time::interval(PING_EVERY);
        let mut resubscribe = tokio::time::interval(self.config.resubscribe_after);
        resubscribe.tick().await;
        let mut last_frame = tokio::time::Instant::now();
        let mut reported: Option<FeedState> = None;
        send_all(&mut send, wanted, self.config.account.as_deref()).await?;
        for timeframe in self.timeframes.clone() {
            for conid in wanted.keys() {
                if let Ok(frame) = history_frame(conid, timeframe, "1m") {
                    let _ = send.send(Message::Text(frame.into())).await;
                }
            }
        }
        loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { return Ok(()) };
                    apply_command(wanted, &command);
                    send_all(&mut send, wanted, self.config.account.as_deref()).await?;
                }
                frame = recv.next() => {
                    let Some(frame) = frame else { return Ok(()) };
                    match frame? {
                        Message::Text(text) => {
                            let Ok(message) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                            last_frame = tokio::time::Instant::now();
                            let topic = message.get("topic").and_then(Value::as_str).unwrap_or("");
                            if let Some(update) = parse_market_data(&message) {
                                let instrument = format!(
                                    "{}:{}",
                                    Venue::InteractiveBrokers.tag(),
                                    wanted.get(&update.conid).cloned().unwrap_or_else(|| update.conid.clone())
                                );
                                // A stamp that goes backwards is a replayed or out of order
                                // frame: report it instead of drawing a stale print as new.
                                let stale = last_update
                                    .get(&update.conid)
                                    .is_some_and(|seen| update.updated != 0 && update.updated <= *seen);
                                if update.updated != 0 {
                                    last_update.insert(update.conid.clone(), update.updated);
                                }
                                if stale {
                                    let _ = tx.send(FeedEvent::status(
                                        Venue::InteractiveBrokers,
                                        Some(instrument),
                                        FeedState::Stalled,
                                        format!(
                                            "update stamp went backwards ({}), frame dropped",
                                            update.updated
                                        ),
                                    ));
                                    continue;
                                }
                                // The entitlement is re-checked on every frame: a session
                                // that loses its streaming rights mid-day must stop reading
                                // as live.
                                if update.entitlement != entitlement || reported.is_none() {
                                    entitlement = update.entitlement;
                                    reported = Some(entitlement.state());
                                    let _ = tx.send(FeedEvent::venue_status(
                                        Venue::InteractiveBrokers,
                                        entitlement.state(),
                                        entitlement.label(),
                                    ));
                                }
                                if let Some(snapshot) = depth_from_update(&update) {
                                    let _ = tx.send(FeedEvent::Depth { instrument: instrument.clone(), snapshot });
                                }
                                if let Some(trade) = trade_from_update(&update) {
                                    let _ = tx.send(FeedEvent::Trades { instrument, trades: vec![trade] });
                                }
                            } else if let Some(rows) = message.get("data").filter(|_| topic.starts_with("sbd")) {
                                let _ = rows;
                                if let Some(snapshot) = parse_ladder(&message) {
                                    if let Some(conid) = conid_of(&message) {
                                        let instrument = format!(
                                            "{}:{}",
                                            Venue::InteractiveBrokers.tag(),
                                            wanted.get(&conid).cloned().unwrap_or(conid)
                                        );
                                        let _ = tx.send(FeedEvent::Depth { instrument, snapshot });
                                    }
                                }
                            } else if topic.starts_with("smh") {
                                let (bars, marker) = parse_history(&message);
                                if let Some(conid) = conid_of(&message) {
                                    if marker != entitlement {
                                        entitlement = marker;
                                        let _ = tx.send(FeedEvent::venue_status(
                                            Venue::InteractiveBrokers,
                                            entitlement.state(),
                                            entitlement.label(),
                                        ));
                                    }
                                    let instrument = format!(
                                        "{}:{}",
                                        Venue::InteractiveBrokers.tag(),
                                        wanted.get(&conid).cloned().unwrap_or(conid)
                                    );
                                    let timeframe = self
                                        .timeframes
                                        .first()
                                        .copied()
                                        .unwrap_or(Timeframe::Minute(1));
                                    for bar in bars {
                                        let _ = tx.send(FeedEvent::Bar {
                                            instrument: instrument.clone(),
                                            timeframe,
                                            bar,
                                        });
                                    }
                                }
                            }
                        }
                        Message::Close(_) => return Ok(()),
                        _ => {}
                    }
                }
                _ = ping.tick() => {
                    if send.send(Message::Text("tic".into())).await.is_err() {
                        return Ok(());
                    }
                }
                // The venue kills `smd` streams after 15 minutes; asking again inside 10
                // is what keeps the chart moving.
                _ = resubscribe.tick() => {
                    send_all(&mut send, wanted, self.config.account.as_deref()).await?;
                }
            }
            if last_frame.elapsed() >= IDLE_AFTER && reported.is_some() {
                reported = None;
                let _ = tx.send(FeedEvent::venue_status(
                    Venue::InteractiveBrokers,
                    FeedState::Stalled,
                    "no frames for 30s",
                ));
            }
        }
    }
}

/// Turn a string into a header value, reporting a bad value as a payload error.
fn header(text: &str) -> Result<tokio_tungstenite::tungstenite::http::HeaderValue, IngestError> {
    tokio_tungstenite::tungstenite::http::HeaderValue::from_str(text)
        .map_err(|error| IngestError::Payload(format!("bad header: {error}")))
}

/// Subscribe to everything wanted: market data, and the ladder when an account is known.
async fn send_all<S>(
    send: &mut S,
    wanted: &HashMap<String, String>,
    account: Option<&str>,
) -> Result<(), IngestError>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    for conid in wanted.keys() {
        let frame = subscribe_frame(conid, &FIELDS);
        if send.send(Message::Text(frame.into())).await.is_err() {
            return Err(IngestError::Payload("ibkr subscribe failed".into()));
        }
        if let Some(account) = account {
            let frame = depth_frame(account, conid, None);
            if send.send(Message::Text(frame.into())).await.is_err() {
                return Err(IngestError::Payload("ibkr depth subscribe failed".into()));
            }
        }
    }
    Ok(())
}

/// The conid a reply belongs to, from `topic` (`smd+265598`) or the `conid` field.
fn conid_of(message: &Value) -> Option<String> {
    if let Some(conid) = message.get("conid").and_then(|value| value.as_str().map(str::to_string).or_else(|| value.as_i64().map(|n| n.to_string()))) {
        return Some(conid);
    }
    let topic = message.get("topic").and_then(Value::as_str)?;
    topic.split('+').nth(1).map(str::to_string).filter(|text| !text.is_empty())
}

fn apply_command(wanted: &mut HashMap<String, String>, command: &FeedCommand) {
    match command {
        FeedCommand::Subscribe { symbol, .. } => {
            // IBKR addresses contracts by conid; the symbol the user typed is kept so the
            // instrument id can be rebuilt, and an explicit `AAPL@265598` form is accepted.
            let (symbol, conid) = match symbol.split_once('@') {
                Some((ticker, conid)) => (ticker.to_string(), conid.to_string()),
                None => (symbol.clone(), symbol.clone()),
            };
            wanted.insert(conid, symbol);
        }
        FeedCommand::Unsubscribe { symbol, .. } => {
            let conid = symbol.split('@').next_back().unwrap_or(symbol).to_string();
            wanted.remove(&conid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Reads `fixtures/ibkr/` and asserts values, including the entitlement difference
    /// between a real-time and a delayed reply.
    #[test]
    fn fixtures_parse_into_core_types() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/ibkr");
        let read = |name: &str| -> Value {
            let text = std::fs::read_to_string(dir.join(name)).expect(name);
            serde_json::from_str(&text).expect(name)
        };

        let live = parse_market_data(&read("smd-realtime.json")).expect("an smd reply");
        assert_eq!(live.entitlement, Entitlement::RealTime);
        assert_eq!(live.conid, "265598");
        assert_eq!(live.last, Some(182.50));
        assert_eq!(live.bid, Some((182.48, 0.0)));
        assert_eq!(trade_from_update(&live).unwrap().seq, 1_699_885_800_500);

        let slow = parse_market_data(&read("smd-delayed.json")).expect("an smd reply");
        assert_eq!(slow.entitlement, Entitlement::Delayed);
        assert_eq!(slow.entitlement.state(), FeedState::Delayed);
        assert_eq!(slow.bid, Some((182.28, 300.0)));
        assert_eq!(slow.ask, Some((182.32, 200.0)));
        assert_eq!(trade_from_update(&slow).unwrap().qty, 100.0);
        let snapshot = depth_from_update(&slow).unwrap();
        assert_eq!((snapshot.bids[0].price, snapshot.bids[0].qty), (182.28, 300.0));
        assert_eq!((snapshot.asks[0].price, snapshot.asks[0].qty), (182.32, 200.0));

        let (bars, entitlement) = parse_history(&read("smh.json"));
        assert_eq!(bars.len(), 2);
        assert_eq!(entitlement, Entitlement::RealTime);
        assert_eq!(bars[0].start, 1_699_801_200_000);
        assert!((bars[0].open - 1.82).abs() < 1e-12, "priceFactor 100 scales the values");
        assert!((bars[1].high - 1.85).abs() < 1e-12);
        assert_eq!(bars[1].volume, 110000.0);

        let (bars, entitlement) = parse_history(&read("smh-delayed.json"));
        assert_eq!(bars.len(), 1);
        assert_eq!(entitlement, Entitlement::Delayed);

        let ladder = parse_ladder(&read("sbd.json")).expect("a ladder");
        assert_eq!(ladder.bids.len(), 1);
        assert_eq!(ladder.bids[0].price, 182.28);
        assert_eq!(ladder.asks.len(), 2);
        assert_eq!(ladder.asks[1].price, 182.36, "the 'size @ price' row is still a price");
        assert_eq!(ladder.asks[1].qty, 50.0);

        let items = instruments_from_search("AAPL", &read("secdef-search.json"));
        assert_eq!(items[0].id, "IBKR:265598");
        assert_eq!(items[0].name, "APPLE INC");

        let session = read("tickle.json");
        assert_eq!(session["session"].as_str().unwrap().len(), 32);
    }

    #[test]
    fn entitlement_reads_the_venues_own_marker() {
        assert_eq!(Entitlement::from_marker("RB"), Entitlement::RealTime);
        assert_eq!(Entitlement::from_marker("DB"), Entitlement::Delayed);
        assert_eq!(Entitlement::from_marker("N"), Entitlement::NotSubscribed);
        assert_eq!(Entitlement::from_marker(""), Entitlement::Unknown);
        assert_eq!(Entitlement::from_marker("RB").state(), FeedState::Live);
        assert_eq!(Entitlement::from_marker("DB").state(), FeedState::Delayed);
        assert_eq!(Entitlement::from_delay(900).state(), FeedState::Delayed);
        assert_eq!(Entitlement::from_delay(0).state(), FeedState::Live);
        assert_eq!(Entitlement::from_marker("DB").label(), "delayed 15-20 min");
    }

    #[test]
    fn topics_use_the_documented_plus_separated_shape() {
        assert_eq!(
            subscribe_frame("265598", &["31", "6509"]),
            "smd+265598+{\"fields\":[\"31\",\"6509\"]}"
        );
        assert_eq!(unsubscribe_frame("265598"), "umd+265598+{}");
        assert_eq!(depth_frame("U1234567", "265598", None), "sbd+U1234567+265598");
        assert_eq!(depth_frame("U1234567", "265598", Some("NASDAQ")), "sbd+U1234567+265598+NASDAQ");
        assert_eq!(
            history_frame("265598", Timeframe::Hour(1), "1d").unwrap(),
            "smh+265598+{\"exchange\":\"SMART\",\"period\":\"1d\",\"bar\":\"1h\",\"outsideRth\":false,\"source\":\"trades\",\"format\":\"%o/%c/%h/%l/%v\"}"
        );
    }

    #[test]
    fn only_documented_bar_intervals_are_asked_for() {
        assert_eq!(bar_interval(Timeframe::Minute(5)).unwrap(), "5min");
        assert_eq!(bar_interval(Timeframe::Hour(4)).unwrap(), "4h");
        assert_eq!(bar_interval(Timeframe::Day(1)).unwrap(), "1d");
        assert_eq!(bar_interval(Timeframe::Month(1)).unwrap(), "1m");
        assert!(bar_interval(Timeframe::Minute(7)).is_err());
        assert!(bar_interval(Timeframe::Hour(6)).is_err());
    }

    #[test]
    fn the_documented_example_update_parses_to_exact_values() {
        // Transcribed from the response example on the streaming-data page.
        let message = json!({"server_id":"smd265598","conidEx":"265598","conid":265598,
            "_updated":1699885800500_i64,"6119":"smd265598","31":"182.50","84":"182.48","86":"182.52",
            "6509":"RB","topic":"smd+265598"});
        let update = parse_market_data(&message).expect("a watchlist update");
        assert_eq!(update.conid, "265598");
        assert_eq!(update.updated, 1_699_885_800_500);
        assert_eq!(update.entitlement, Entitlement::RealTime);
        assert_eq!(update.last, Some(182.50));
        assert_eq!(update.bid, Some((182.48, 0.0)), "no size field means zero, not missing");
        assert_eq!(update.ask, Some((182.52, 0.0)));
        let snapshot = depth_from_update(&update).expect("a two-level ladder");
        assert_eq!(snapshot.bids[0].price, 182.48);
        assert_eq!(snapshot.asks[0].price, 182.52);
        assert_eq!(snapshot.ts, 1_699_885_800_500);
        let trade = trade_from_update(&update).expect("a last price is a print");
        assert_eq!(trade.price, 182.50);
        assert_eq!(trade.seq, 1_699_885_800_500, "the update stamp is the print key");
    }

    #[test]
    fn a_placeholder_price_is_not_a_ladder() {
        // -1 means "no data right now"; drawing it crosses the book.
        let message = json!({"conid":265598,"_updated":1,"31":"-1","84":"-1","86":"-1","6509":"DB"});
        let update = parse_market_data(&message).unwrap();
        assert_eq!(update.last, None);
        assert!(depth_from_update(&update).is_none());
        assert_eq!(update.entitlement, Entitlement::Delayed);
    }

    #[test]
    fn sizes_come_through_as_sizes() {
        let message = json!({"conid":"265598","_updated":1699885800501_i64,"31":"182.50","7059":"100",
            "84":"182.48","88":"300","86":"182.52","85":"200","6509":"DB"});
        let update = parse_market_data(&message).unwrap();
        assert_eq!(update.bid, Some((182.48, 300.0)));
        assert_eq!(update.ask, Some((182.52, 200.0)));
        assert_eq!(trade_from_update(&update).unwrap().qty, 100.0);
        let snapshot = depth_from_update(&update).unwrap();
        assert_eq!(snapshot.bids[0].qty, 300.0);
        assert_eq!(snapshot.asks[0].qty, 200.0);
    }

    #[test]
    fn history_bars_are_scaled_by_the_price_factor() {
        // The response example on the historical-data page: priceFactor 100, values in pennies.
        let message = json!({"serverId":"smh265598","symbol":"AAPL","priceFactor":100,
            "mktDataDelay":0,"data":[{"o":182.0,"c":183.5,"h":184.2,"l":181.5,"v":95000,"t":1699801200},
            {"o":183.5,"c":182.8,"h":185.0,"l":182.0,"v":110000,"t":1699804800}],"points":2,
            "topic":"smh+265598"});
        let (bars, entitlement) = parse_history(&message);
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].start, 1_699_801_200_000, "epoch seconds to ms");
        assert!((bars[0].open - 1.82).abs() < 1e-12, "divided by the price factor");
        assert!((bars[0].high - 1.842).abs() < 1e-12);
        assert_eq!(bars[1].volume, 110000.0);
        assert_eq!(entitlement, Entitlement::RealTime);
    }

    #[test]
    fn a_delayed_history_reply_says_so() {
        let message = json!({"mktDataDelay":900,"data":[]});
        let (bars, entitlement) = parse_history(&message);
        assert!(bars.is_empty());
        assert_eq!(entitlement, Entitlement::Delayed);
        let message = json!({"mdAvailability":"D","data":[{"o":1.0,"c":1.0,"h":1.0,"l":1.0,"v":1.0,"t":1}]});
        let (_, entitlement) = parse_history(&message);
        assert_eq!(entitlement, Entitlement::Delayed);
    }

    #[test]
    fn a_ladder_reply_becomes_a_book() {
        let message = json!({"topic":"sbd+U1+265598","data":[
            {"row":1,"price":"182.48","bid":"300","ask":"0"},
            {"row":2,"focus":1,"price":"182.50","bid":"0","ask":"0"},
            {"row":3,"price":"182.52","bid":"0","ask":"200"},
            {"row":4,"price":"100 @ 182.55","bid":"0","ask":"50"}
        ]});
        let snapshot = parse_ladder(&message).expect("a ladder");
        assert_eq!(snapshot.bids.len(), 1);
        assert_eq!(snapshot.bids[0].price, 182.48);
        assert_eq!(snapshot.bids[0].qty, 300.0);
        assert_eq!(snapshot.asks.len(), 2);
        assert_eq!(snapshot.asks[0].price, 182.52, "best ask first");
        assert_eq!(snapshot.asks[1].price, 182.55, "the price after '@' is the level");
        assert_eq!(snapshot.asks[1].qty, 50.0);
    }

    #[test]
    fn search_results_become_instruments_keyed_by_conid() {
        let body = json!([{
            "conid": "265598", "companyName": "APPLE INC", "symbol": "AAPL",
            "description": "NASDAQ", "restricted": false,
            "sections": [{"secType": "STK", "months": "", "symbol": "AAPL", "exchange": "NASDAQ;SMART"}]
        }]);
        let items = instruments_from_search("AAPL", &body);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "IBKR:265598", "the id carries the conid, not the ticker");
        assert_eq!(items[0].symbol, "AAPL");
        assert_eq!(items[0].name, "APPLE INC");
        assert_eq!(items[0].asset_class, AssetClass::Equity);
        assert!(items[0].active);
    }

    #[test]
    fn a_conid_is_taken_from_the_field_or_the_topic() {
        assert_eq!(conid_of(&json!({"conid":265598})).as_deref(), Some("265598"));
        assert_eq!(conid_of(&json!({"topic":"smh+265598","data":[]})).as_deref(), Some("265598"));
        assert_eq!(conid_of(&json!({"topic":"tic"})), None);
    }

    #[test]
    fn a_ticker_with_a_conid_subscribes_the_conid() {
        let mut wanted = HashMap::new();
        apply_command(
            &mut wanted,
            &FeedCommand::Subscribe {
                venue: Venue::InteractiveBrokers,
                symbol: "AAPL@265598".into(),
                timeframe: Timeframe::Minute(1),
            },
        );
        assert_eq!(wanted.get("265598").map(String::as_str), Some("AAPL"));
        apply_command(
            &mut wanted,
            &FeedCommand::Unsubscribe { venue: Venue::InteractiveBrokers, symbol: "AAPL@265598".into() },
        );
        assert!(wanted.is_empty());
    }

    #[test]
    fn the_socket_url_follows_the_credential_shape() {
        let config = IbkrConfig {
            base_url: CP_BASE.into(),
            bearer_token: None,
            account: None,
            ws_url: None,
            resubscribe_after: DEFAULT_RESUBSCRIBE,
            session: None,
        };
        assert_eq!(config.ws_url(), "wss://localhost:5000/v1/api/ws");
        let config = IbkrConfig { bearer_token: Some("tok".into()), ..config };
        assert_eq!(config.ws_url(), OAUTH_WS);
    }

    #[test]
    fn an_unconfigured_venue_names_what_is_missing() {
        let store = CredentialStore::default();
        assert!(IbkrConfig::from_store(&store)
            .unwrap_err()
            .contains("IBKR_BASE_URL"));
    }
}
