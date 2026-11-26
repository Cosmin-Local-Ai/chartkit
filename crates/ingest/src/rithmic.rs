//! Rithmic R|Protocol: futures market data as Protocol Buffers over a WebSocket.
//!
//! Rithmic's own product page states the transport: "R|Protocol API is a wire line
//! interface specification for communication with Rithmic's R | Trade Execution
//! Platform… R|Protocol API uses WebSockets and Google protocol buffers"
//! (<https://www.rithmic.com/apis>, archived copy
//! <https://web.archive.org/web/2025/https://www.rithmic.com/apis>).
//!
//! What is *not* public is the schema itself: the `.proto` files ship with the R|API+
//! download and sit behind a reseller login, so Rithmic's own documentation was not
//! reachable from here. The message names, template ids and field numbers below are
//! transcribed from an independent open-source implementation of the same protocol —
//! <https://github.com/parbhatc/Rithmic/tree/main/proto> with its client at
//! <https://github.com/parbhatc/Rithmic/blob/main/src/rithmicClient.js> — and the fixtures
//! under `fixtures/rithmic/` are marked as synthesized to that transcription. Treat the
//! first live run as the check on the numbers, not as a failure if one moves.
//!
//! Wire format, from that client: every message is a WebSocket binary frame holding a
//! 4-byte big-endian body length followed by the serialized protobuf message. The first
//! field of every message is `template_id` (154467), which says what the message is.
//! Protobuf encoding rules: <https://protobuf.dev/programming-guides/encoding/>.

use std::collections::HashMap;
use std::time::Duration;

use chartkit_core::instrument::VenueTag;
use chartkit_core::{
    AssetClass, DepthSnapshot, Instrument, Level, Session, Side, Timeframe, Trade, Venue,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::credentials::{slug, CredentialStore};
use crate::event::{FeedCommand, FeedEvent, FeedState};
use crate::IngestError;

/// Chicago gateway listed by the reference client; other regions and brokers differ.
pub const GATEWAY: &str = "wss://rprotocol.rithmic.com:443";
/// Message ids, from the reference client's template table.
pub mod template {
    pub const REQUEST_LOGIN: u64 = 10;
    pub const RESPONSE_LOGIN: u64 = 11;
    pub const REQUEST_LOGOUT: u64 = 12;
    pub const REQUEST_HEARTBEAT: u64 = 18;
    pub const RESPONSE_HEARTBEAT: u64 = 19;
    pub const REJECT: u64 = 75;
    pub const FORCED_LOGOUT: u64 = 77;
    pub const REQUEST_MARKET_DATA_UPDATE: u64 = 100;
    pub const RESPONSE_MARKET_DATA_UPDATE: u64 = 101;
    pub const LAST_TRADE: u64 = 150;
    pub const BEST_BID_OFFER: u64 = 151;
    pub const ORDER_BOOK: u64 = 156;
}

/// Field numbers, from the transcribed `.proto` files. `PB_OFFSET + MNM_*` in the comments
/// there; the numbers are what the wire carries.
pub mod field {
    pub const TEMPLATE_ID: u64 = 154_467;
    pub const TEMPLATE_VERSION: u64 = 153_634;
    pub const USER_MSG: u64 = 132_760;
    pub const RP_CODE: u64 = 132_766;
    pub const UNIQUE_USER_ID: u64 = 153_428;
    pub const USER: u64 = 131_003;
    pub const PASSWORD: u64 = 130_004;
    pub const APP_NAME: u64 = 130_002;
    pub const APP_VERSION: u64 = 131_803;
    pub const SYSTEM_NAME: u64 = 153_628;
    pub const INFRA_TYPE: u64 = 153_621;
    pub const HEARTBEAT_INTERVAL: u64 = 153_633;
    pub const SYMBOL: u64 = 110_100;
    pub const EXCHANGE: u64 = 110_101;
    pub const REQUEST: u64 = 100_000;
    pub const UPDATE_BITS: u64 = 154_211;
    pub const IS_SNAPSHOT: u64 = 110_121;
    pub const PRESENCE_BITS: u64 = 149_138;
    pub const TRADE_PRICE: u64 = 100_006;
    pub const TRADE_SIZE: u64 = 100_178;
    pub const AGGRESSOR: u64 = 112_003;
    pub const BID_PRICE: u64 = 100_022;
    pub const BID_SIZE: u64 = 100_030;
    pub const ASK_PRICE: u64 = 100_025;
    pub const ASK_SIZE: u64 = 100_031;
    pub const DEPTH_BID_PRICE: u64 = 154_282;
    pub const DEPTH_BID_SIZE: u64 = 154_283;
    pub const DEPTH_ASK_PRICE: u64 = 154_284;
    pub const DEPTH_ASK_SIZE: u64 = 154_285;
    pub const DEPTH_UPDATE_TYPE: u64 = 157_608;
    pub const SSBOE: u64 = 150_100;
    pub const USECS: u64 = 150_101;
}

/// `RequestMarketDataUpdate.update_bits`: LAST_TRADE | BBO | ORDER_BOOK.
pub const UPDATE_BITS: u64 = 1 | 2 | 4;
/// `RequestMarketDataUpdate.request`: SUBSCRIBE.
pub const REQUEST_SUBSCRIBE: u64 = 1;
/// `RequestMarketDataUpdate.request`: UNSUBSCRIBE.
pub const REQUEST_UNSUBSCRIBE: u64 = 2;
/// `RequestLogin.infra_type`: TICKER_PLANT, the live market-data plant.
pub const TICKER_PLANT: u64 = 1;
/// `OrderBook.update_type` values that mean a book arrives in pieces.
pub const BOOK_BEGIN: u64 = 4;
pub const BOOK_MIDDLE: u64 = 5;
pub const BOOK_END: u64 = 6;
/// A book that never finished its BEGIN…END run is incomplete, so it is re-requested.
const PARTIAL_BOOK_AFTER: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const DEPTH_LEVELS: usize = 50;

/// What the adapter needs before it can connect. Nothing is compiled in.
#[derive(Clone, Debug)]
pub struct RithmicConfig {
    pub user: String,
    pub password: String,
    /// The named system to log into, e.g. `Rithmic Paper Trading`.
    pub system: String,
    pub gateway: String,
    /// App name Rithmic records for the connection.
    pub app_name: String,
    /// Socket override for the localhost fake venue.
    pub ws_url: Option<String>,
    /// How long an unfinished depth snapshot may hang before the book is re-asked for.
    pub partial_book_after: Duration,
}

impl RithmicConfig {
    pub fn from_store(store: &CredentialStore) -> Result<Self, String> {
        let status = store.status(Venue::Rithmic);
        if !status.configured {
            return Err(format!(
                "Rithmic needs a login from an FCM or reseller: set RITHMIC_USER, \
                 RITHMIC_PASSWORD and RITHMIC_SYSTEM (or fill the Rithmic row in \
                 Settings > Feeds, writing {}); chartkit --check-feed {}",
                store.path().display(),
                slug(Venue::Rithmic)
            ));
        }
        Ok(Self {
            user: store.value(Venue::Rithmic, "user").unwrap_or_default(),
            password: store.value(Venue::Rithmic, "password").unwrap_or_default(),
            system: store
                .value(Venue::Rithmic, "system")
                .unwrap_or_else(|| "Rithmic Paper Trading".to_string()),
            gateway: store.value(Venue::Rithmic, "gateway").unwrap_or_else(|| GATEWAY.to_string()),
            app_name: "chartkit".to_string(),
            ws_url: None,
            partial_book_after: PARTIAL_BOOK_AFTER,
        })
    }

    pub fn ws_url(&self) -> String {
        self.ws_url.clone().unwrap_or_else(|| self.gateway.clone())
    }
}

/// One decoded protobuf field.
#[derive(Clone, Debug, PartialEq)]
pub enum FieldValue {
    Varint(u64),
    /// A fixed 64-bit value, kept as raw bits; `as_double` reinterprets them.
    Fixed64(u64),
    Fixed32(u32),
    Bytes(Vec<u8>),
}

/// A parsed message: fields in wire order, which is all this adapter needs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Decoded(pub Vec<(u64, FieldValue)>);

impl Decoded {
    /// Public so a test can read a request frame back; production paths use the parsers.
    pub fn varint(&self, number: u64) -> Option<u64> {
        self.0
            .iter()
            .find(|(field, _)| *field == number)
            .and_then(|(_, value)| match value {
                FieldValue::Varint(v) => Some(*v),
                _ => None,
            })
    }

    pub fn double(&self, number: u64) -> Option<f64> {
        self.0
            .iter()
            .find(|(field, _)| *field == number)
            .and_then(|(_, value)| match value {
                FieldValue::Fixed64(bits) => Some(f64::from_bits(*bits)),
                _ => None,
            })
    }

    pub fn string(&self, number: u64) -> Option<String> {
        self.0.iter().find(|(field, _)| *field == number).and_then(|(_, value)| {
            match value {
                FieldValue::Bytes(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
                _ => None,
            }
        })
    }

    pub fn bool(&self, number: u64) -> Option<bool> {
        self.varint(number).map(|value| value != 0)
    }

    /// Repeated scalar field, either packed into one length-delimited run or repeated
    /// one-per-key; proto3 packs by default, the reference fixtures do not have to.
    fn doubles(&self, number: u64) -> Vec<f64> {
        let mut out = Vec::new();
        for (field, value) in &self.0 {
            if *field != number {
                continue;
            }
            match value {
                FieldValue::Fixed64(bits) => out.push(f64::from_bits(*bits)),
                FieldValue::Bytes(bytes) => {
                    let mut offset = 0;
                    while offset + 8 <= bytes.len() {
                        let bits = u64::from_le_bytes(
                            bytes[offset..offset + 8].try_into().unwrap_or([0; 8]),
                        );
                        out.push(f64::from_bits(bits));
                        offset += 8;
                    }
                }
                _ => {}
            }
        }
        out
    }

    fn ints(&self, number: u64) -> Vec<u64> {
        let mut out = Vec::new();
        for (field, value) in &self.0 {
            if *field != number {
                continue;
            }
            match value {
                FieldValue::Varint(v) => out.push(*v),
                FieldValue::Bytes(bytes) => {
                    let mut cursor = &bytes[..];
                    while let Some((v, rest)) = read_varint(cursor) {
                        out.push(v);
                        cursor = rest;
                    }
                }
                _ => {}
            }
        }
        out
    }
}

/// Read one varint; returns the value and the bytes after it.
fn read_varint(bytes: &[u8]) -> Option<(u64, &[u8])> {
    let mut value: u64 = 0;
    let mut shift = 0;
    for (index, byte) in bytes.iter().enumerate() {
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, &bytes[index + 1..]));
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}

/// Decode a protobuf message into its fields. Unknown and unsupported fields are skipped,
/// which is what lets this client survive a schema revision instead of misparsing it.
pub fn decode_message(bytes: &[u8]) -> Result<Decoded, IngestError> {
    let mut cursor = bytes;
    let mut fields = Vec::new();
    while !cursor.is_empty() {
        let (key, rest) = read_varint(cursor).ok_or_else(|| {
            IngestError::Payload("protobuf key varint ran off the end".into())
        })?;
        cursor = rest;
        let number = key >> 3;
        match u8::try_from(key & 0x07).map_err(|_| IngestError::Payload("bad wire type".into()))? {
            0 => {
                let (value, rest) = read_varint(cursor)
                    .ok_or_else(|| IngestError::Payload("varint ran off the end".into()))?;
                cursor = rest;
                fields.push((number, FieldValue::Varint(value)));
            }
            1 => {
                if cursor.len() < 8 {
                    return Err(IngestError::Payload("fixed64 truncated".into()));
                }
                let bits = u64::from_le_bytes(cursor[..8].try_into().unwrap_or([0; 8]));
                cursor = &cursor[8..];
                fields.push((number, FieldValue::Fixed64(bits)));
            }
            2 => {
                let (len, rest) = read_varint(cursor)
                    .ok_or_else(|| IngestError::Payload("length varint ran off the end".into()))?;
                let len = usize::try_from(len)
                    .map_err(|_| IngestError::Payload("length does not fit".into()))?;
                if rest.len() < len {
                    return Err(IngestError::Payload("length-delimited field truncated".into()));
                }
                fields.push((number, FieldValue::Bytes(rest[..len].to_vec())));
                cursor = &rest[len..];
            }
            5 => {
                if cursor.len() < 4 {
                    return Err(IngestError::Payload("fixed32 truncated".into()));
                }
                let value = u32::from_le_bytes(cursor[..4].try_into().unwrap_or([0; 4]));
                cursor = &cursor[4..];
                fields.push((number, FieldValue::Fixed32(value)));
            }
            other => {
                return Err(IngestError::Payload(format!("wire type {other} is not supported")));
            }
        }
    }
    Ok(Decoded(fields))
}

/// Append one varint to a buffer.
fn put_varint(buffer: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            buffer.push(byte);
            return;
        }
        buffer.push(byte | 0x80);
    }
}

/// A message under construction.
#[derive(Default)]
pub struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self::default()
    }

    /// varint / bool / enum field.
    pub fn varint(&mut self, number: u64, value: u64) -> &mut Self {
        put_varint(&mut self.bytes, (number << 3) | 0);
        put_varint(&mut self.bytes, value);
        self
    }

    /// bool field, which on the wire is a varint.
    pub fn bool(&mut self, number: u64, value: bool) -> &mut Self {
        self.varint(number, u64::from(value))
    }

    /// double field, little-endian.
    pub fn double(&mut self, number: u64, value: f64) -> &mut Self {
        put_varint(&mut self.bytes, (number << 3) | 1);
        self.bytes.extend_from_slice(&value.to_le_bytes());
        self
    }

    /// string / bytes field.
    pub fn bytes(&mut self, number: u64, value: &[u8]) -> &mut Self {
        put_varint(&mut self.bytes, (number << 3) | 2);
        put_varint(&mut self.bytes, value.len() as u64);
        self.bytes.extend_from_slice(value);
        self
    }

    pub fn string(&mut self, number: u64, value: &str) -> &mut Self {
        self.bytes(number, value.as_bytes())
    }

    /// Packed repeated double, the proto3 default.
    pub fn packed_doubles(&mut self, number: u64, values: &[f64]) -> &mut Self {
        let mut body = Vec::with_capacity(values.len() * 8);
        for value in values {
            body.extend_from_slice(&value.to_le_bytes());
        }
        self.bytes(number, &body)
    }

    pub fn finish(&self) -> Vec<u8> {
        self.bytes.clone()
    }
}

/// Wrap a serialized message the way the protocol frames it: 4-byte big-endian length,
/// then the body.
pub fn encode_frame(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// Undo [`encode_frame`]. A short or over-long frame is rejected rather than trusted.
pub fn decode_frame(bytes: &[u8]) -> Result<Decoded, IngestError> {
    if bytes.len() < 4 {
        return Err(IngestError::Payload("frame is shorter than its length prefix".into()));
    }
    let len = u32::from_be_bytes(bytes[..4].try_into().unwrap_or([0; 4])) as usize;
    let body = bytes.get(4..4 + len).ok_or_else(|| {
        IngestError::Payload(format!("frame claims {len} bytes, {} are present", bytes.len().saturating_sub(4)))
    })?;
    decode_message(body)
}

/// `RequestLogin` (template 10).
pub fn login_request(config: &RithmicConfig) -> Vec<u8> {
    let mut writer = Writer::new();
    writer
        .varint(field::TEMPLATE_ID, template::REQUEST_LOGIN)
        .string(field::TEMPLATE_VERSION, "3.9")
        .string(field::USER, &config.user)
        .string(field::PASSWORD, &config.password)
        .string(field::APP_NAME, &config.app_name)
        .string(field::APP_VERSION, env!("CARGO_PKG_VERSION"))
        .string(field::SYSTEM_NAME, &config.system)
        .varint(field::INFRA_TYPE, TICKER_PLANT);
    writer.finish()
}

/// `RequestHeartbeat` (template 18).
pub fn heartbeat_request() -> Vec<u8> {
    let mut writer = Writer::new();
    writer.varint(field::TEMPLATE_ID, template::REQUEST_HEARTBEAT);
    writer.finish()
}

/// `RequestMarketDataUpdate` (template 100).
pub fn market_data_request(symbol: &str, exchange: &str, subscribe: bool) -> Vec<u8> {
    let mut writer = Writer::new();
    writer
        .varint(field::TEMPLATE_ID, template::REQUEST_MARKET_DATA_UPDATE)
        .string(field::SYMBOL, symbol)
        .string(field::EXCHANGE, exchange)
        .varint(field::REQUEST, if subscribe { REQUEST_SUBSCRIBE } else { REQUEST_UNSUBSCRIBE })
        .varint(field::UPDATE_BITS, UPDATE_BITS);
    writer.finish()
}

/// `ssboe` (seconds since epoch) plus `usecs` into epoch milliseconds.
pub fn stamp(message: &Decoded) -> i64 {
    let seconds = message.varint(field::SSBOE).unwrap_or(0) as i64;
    let micros = message.varint(field::USECS).unwrap_or(0) as i64;
    seconds * 1000 + micros / 1000
}

/// The error Rithmic reports in `rp_code`; anything but "0" or "7" is a failure.
pub fn rp_error(message: &Decoded) -> Option<String> {
    let codes: Vec<String> = message
        .0
        .iter()
        .filter(|(number, _)| *number == field::RP_CODE)
        .filter_map(|(_, value)| match value {
            FieldValue::Bytes(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        })
        .collect();
    codes
        .iter()
        .find(|code| code.as_str() != "0" && code.as_str() != "7")
        .cloned()
}

/// `LastTrade` (template 150) into a print. A snapshot row is skipped: it repeats a print
/// the chart already holds, and it carries no aggressor.
pub fn parse_last_trade(message: &Decoded) -> Option<Trade> {
    if message.bool(field::IS_SNAPSHOT).unwrap_or(false) {
        return None;
    }
    let price = message.double(field::TRADE_PRICE)?;
    let sizes = message.ints(field::TRADE_SIZE);
    Some(Trade {
        ts: stamp(message),
        // R|Protocol carries no print number in these messages, so the microsecond stamp
        // is the closest thing to a sequence the protocol offers.
        seq: (message.varint(field::SSBOE).unwrap_or(0) as u64) * 1_000_000
            + message.varint(field::USECS).unwrap_or(0),
        price,
        qty: sizes.first().copied().unwrap_or(0) as f64,
        aggressor: match message.varint(field::AGGRESSOR).unwrap_or(0) {
            1 => Side::Buy,
            2 => Side::Sell,
            _ => Side::Buy,
        },
    })
}

/// `BestBidOffer` (template 151) into a two-level ladder. `presence_bits` says which side
/// the frame actually carries, so a one-sided frame does not invent the other.
pub fn parse_bbo(message: &Decoded) -> Option<DepthSnapshot> {
    let presence = message.varint(field::PRESENCE_BITS).unwrap_or(3);
    let bids = if presence & 1 != 0 {
        match (message.double(field::BID_PRICE), message.varint(field::BID_SIZE)) {
            (Some(price), Some(size)) if price > 0.0 => vec![Level { price, qty: size as f64 }],
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    };
    let asks = if presence & 2 != 0 {
        match (message.double(field::ASK_PRICE), message.varint(field::ASK_SIZE)) {
            (Some(price), Some(size)) if price > 0.0 => vec![Level { price, qty: size as f64 }],
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    };
    if bids.is_empty() && asks.is_empty() {
        return None;
    }
    Some(DepthSnapshot { ts: stamp(message), bids, asks })
}

/// `OrderBook` (template 156) into the ladder. Prices and sizes arrive as parallel arrays,
/// which is why both are read and zipped rather than scanned for pairs.
pub fn parse_order_book(message: &Decoded) -> Option<DepthSnapshot> {
    let levels = |prices: Vec<f64>, sizes: Vec<u64>| -> Vec<Level> {
        prices
            .into_iter()
            .zip(sizes)
            .filter(|(price, _)| *price > 0.0)
            .map(|(price, size)| Level { price, qty: size as f64 })
            .collect()
    };
    let mut bids = levels(message.doubles(field::DEPTH_BID_PRICE), message.ints(field::DEPTH_BID_SIZE));
    let mut asks = levels(message.doubles(field::DEPTH_ASK_PRICE), message.ints(field::DEPTH_ASK_SIZE));
    if bids.is_empty() && asks.is_empty() {
        return None;
    }
    bids.sort_by(|a, b| b.price.partial_cmp(&a.price).unwrap_or(std::cmp::Ordering::Equal));
    asks.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal));
    bids.truncate(DEPTH_LEVELS);
    asks.truncate(DEPTH_LEVELS);
    Some(DepthSnapshot { ts: stamp(message), bids, asks })
}

/// Instrument row for a Rithmic contract. The reference protocol's symbol lookup answers
/// with exchange, tick size and multiplier, which is not implemented here, so the row is
/// built from what the subscribe already knows.
pub fn instrument(symbol: &str, exchange: &str) -> Instrument {
    let display = format!("{symbol}");
    Instrument {
        id: format!("{}:{symbol}@{exchange}", Venue::Rithmic.tag()),
        venue: Venue::Rithmic,
        symbol: format!("{symbol}@{exchange}"),
        display,
        name: format!("{symbol} ({exchange})"),
        asset_class: AssetClass::Future,
        price_tick: 0.25,
        qty_step: 1.0,
        price_precision: 2,
        qty_precision: 0,
        quote_currency: "USD".to_string(),
        session: Session::continuous(),
        active: true,
    }
}

/// Split a user-typed symbol into Rithmic's symbol and exchange. `MES26@CME` is explicit;
/// a bare symbol is treated as CME, which is what the reference client defaults to.
pub fn split_symbol(symbol: &str) -> (String, String) {
    match symbol.split_once('@') {
        Some((ticker, exchange)) => (ticker.to_string(), exchange.to_ascii_uppercase()),
        None => (symbol.to_string(), "CME".to_string()),
    }
}

/// Rithmic feed: one ticker-plant session, reconnecting forever.
pub struct RithmicFeed {
    config: RithmicConfig,
}

impl RithmicFeed {
    /// `timeframes` is accepted for symmetry with the other feeds and dropped: R|Protocol
    /// bars come from the history plant's time-bar templates, which this adapter does not
    /// speak yet, so candles are not published for this venue.
    pub fn new(config: RithmicConfig, _timeframes: Vec<Timeframe>) -> Self {
        let _ = _timeframes;
        Self { config }
    }

    pub async fn run(
        self,
        mut commands: mpsc::UnboundedReceiver<FeedCommand>,
        tx: mpsc::UnboundedSender<FeedEvent>,
    ) -> Result<(), IngestError> {
        // symbol → exchange, kept across reconnects so the socket can be rebuilt.
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
            let _ = tx.send(FeedEvent::venue_status(
                Venue::Rithmic,
                FeedState::Connecting,
                "connecting",
            ));
            match connect_async(self.config.ws_url()).await {
                Ok((socket, _)) => {
                    backoff = Duration::from_millis(500);
                    if let Err(error) = self.socket(socket, &mut commands, &mut wanted, &tx).await {
                        tracing::warn!("rithmic session ended: {error}");
                        let _ = tx.send(FeedEvent::venue_status(
                            Venue::Rithmic,
                            FeedState::Failed,
                            error.to_string(),
                        ));
                    }
                }
                Err(error) => {
                    tracing::warn!("rithmic connect failed: {error}");
                    let _ = tx.send(FeedEvent::venue_status(
                        Venue::Rithmic,
                        FeedState::Failed,
                        error.to_string(),
                    ));
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    /// One session: log in, subscribe, publish, until the link dies.
    async fn socket(
        &self,
        socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        commands: &mut mpsc::UnboundedReceiver<FeedCommand>,
        wanted: &mut HashMap<String, String>,
        tx: &mpsc::UnboundedSender<FeedEvent>,
    ) -> Result<(), IngestError> {
        let (mut send, mut recv) = socket.split();
        send.send(Message::Binary(encode_frame(&login_request(&self.config)).into()))
            .await?;
        let mut logged_in = false;
        let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
        // A stalled book has to be noticed on a quiet wire too, so the check gets its own
        // tick instead of riding along with the next frame.
        let mut watchdog = tokio::time::interval(self.config.partial_book_after);
        // A BEGIN without its END means rows were lost in flight; the book is re-asked for.
        let mut partial: Option<(String, tokio::time::Instant)> = None;
        loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { return Ok(()) };
                    apply_command(wanted, &command);
                    if logged_in {
                        for frame in subscribe_frames(wanted) {
                            send.send(Message::Binary(frame.into())).await?;
                        }
                    }
                }
                frame = recv.next() => {
                    let Some(frame) = frame else { return Ok(()) };
                    match frame? {
                        Message::Binary(bytes) => {
                            let message = decode_frame(bytes.as_ref())?;
                            let kind = message.varint(field::TEMPLATE_ID).unwrap_or(0);
                            if kind == template::RESPONSE_LOGIN {
                                if let Some(code) = rp_error(&message) {
                                    return Err(IngestError::Payload(format!("login rejected: {code}")));
                                }
                                logged_in = true;
                                for frame in subscribe_frames(wanted) {
                                    send.send(Message::Binary(frame.into())).await?;
                                }
                                let _ = tx.send(FeedEvent::venue_status(
                                    Venue::Rithmic,
                                    FeedState::Live,
                                    "logged in, streaming",
                                ));
                            } else if kind == template::REJECT || kind == template::FORCED_LOGOUT {
                                let code = rp_error(&message).unwrap_or_else(|| "no code".into());
                                return Err(IngestError::Payload(format!("server said {kind}: {code}")));
                            } else if kind == template::RESPONSE_MARKET_DATA_UPDATE {
                                if let Some(code) = rp_error(&message) {
                                    let _ = tx.send(FeedEvent::venue_status(
                                        Venue::Rithmic,
                                        FeedState::Failed,
                                        format!("subscribe rejected: {code}"),
                                    ));
                                }
                            } else if kind == template::LAST_TRADE {
                                if let Some(trade) = parse_last_trade(&message) {
                                    let _ = tx.send(FeedEvent::Trades {
                                        instrument: instrument_id(&message),
                                        trades: vec![trade],
                                    });
                                }
                            } else if kind == template::BEST_BID_OFFER {
                                if let Some(snapshot) = parse_bbo(&message) {
                                    let _ = tx.send(FeedEvent::Depth {
                                        instrument: instrument_id(&message),
                                        snapshot,
                                    });
                                }
                            } else if kind == template::ORDER_BOOK {
                                let update = message.varint(field::DEPTH_UPDATE_TYPE).unwrap_or(0);
                                let id = instrument_id(&message);
                                if matches!(update, BOOK_BEGIN) {
                                    partial = Some((id.clone(), tokio::time::Instant::now()));
                                }
                                if let Some(snapshot) = parse_order_book(&message) {
                                    let _ = tx.send(FeedEvent::Depth { instrument: id.clone(), snapshot });
                                }
                                if matches!(update, BOOK_END) {
                                    partial = None;
                                }
                            }
                        }
                        Message::Close(_) => return Ok(()),
                        _ => {}
                    }
                }
                _ = heartbeat.tick() => {
                    if logged_in && send.send(Message::Binary(encode_frame(&heartbeat_request()).into())).await.is_err() {
                        return Ok(());
                    }
                }
                _ = watchdog.tick() => {}
            }
            // A half-received book is a gap: the levels between BEGIN and END never came,
            // and only a fresh snapshot can close them.
            if let Some((symbol, since)) = partial.as_ref() {
                if since.elapsed() >= self.config.partial_book_after {
                    let exchange = wanted
                        .get(symbol.as_str())
                        .cloned()
                        .unwrap_or_else(|| "CME".to_string());
                    let _ = tx.send(FeedEvent::status(
                        Venue::Rithmic,
                        Some(instrument(symbol.as_str(), &exchange).id),
                        FeedState::Stalled,
                        "depth snapshot never finished, re-subscribing",
                    ));
                    send.send(Message::Binary(
                        encode_frame(&market_data_request(&symbol, &exchange, true)).into(),
                    ))
                    .await?;
                    partial = None;
                }
            }
        }
    }
}

fn subscribe_frames(wanted: &HashMap<String, String>) -> Vec<Vec<u8>> {
    wanted
        .iter()
        .map(|(symbol, exchange)| encode_frame(&market_data_request(symbol, exchange, true)))
        .collect()
}

/// The instrument a market-data message belongs to, named by the symbol it carries.
fn instrument_id(message: &Decoded) -> String {
    let ticker = message.string(field::SYMBOL).unwrap_or_default();
    let exchange = message.string(field::EXCHANGE).unwrap_or_else(|| "CME".to_string());
    instrument(&ticker, &exchange).id
}

fn apply_command(wanted: &mut HashMap<String, String>, command: &FeedCommand) {
    match command {
        FeedCommand::Subscribe { symbol, .. } => {
            let (ticker, exchange) = split_symbol(symbol);
            wanted.insert(ticker, exchange);
        }
        FeedCommand::Unsubscribe { symbol, .. } => {
            let (ticker, _) = split_symbol(symbol);
            wanted.remove(&ticker);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a `LastTrade` body the way the reference client would.
    fn last_trade_body(price: f64, size: i64, aggressor: u64, ssboe: u64, usecs: u64) -> Vec<u8> {
        let mut writer = Writer::new();
        writer
            .varint(field::TEMPLATE_ID, template::LAST_TRADE)
            .string(field::SYMBOL, "MES")
            .string(field::EXCHANGE, "CME")
            .double(field::TRADE_PRICE, price)
            .varint(field::TRADE_SIZE, size as u64)
            .varint(field::AGGRESSOR, aggressor)
            .varint(field::SSBOE, ssboe)
            .varint(field::USECS, usecs);
        writer.finish()
    }

    /// Reads `fixtures/rithmic/frames.json`, decodes each frame and asserts the values, so
    /// the hex on disk and the codec cannot drift apart.
    #[test]
    fn fixtures_decode_into_core_types() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/rithmic/frames.json");
        let text = std::fs::read_to_string(path).expect("frames.json");
        let fixture: serde_json::Value = serde_json::from_str(&text).expect("frames.json");
        let hex = |name: &str| -> Vec<u8> {
            let value = fixture[name].as_str().expect(name);
            (0..value.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&value[i..i + 2], 16).expect("hex"))
                .collect()
        };

        let login = decode_frame(&hex("response-login")).expect("a login reply");
        assert_eq!(login.varint(field::TEMPLATE_ID), Some(template::RESPONSE_LOGIN));
        assert_eq!(rp_error(&login), None, "rp_code 0 is success");
        assert_eq!(login.double(field::HEARTBEAT_INTERVAL), Some(30.0));

        let trade = decode_frame(&hex("last-trade-1")).expect("a trade frame");
        let print = parse_last_trade(&trade).expect("a print");
        assert_eq!(print.price, 5_101.25);
        assert_eq!(print.qty, 3.0);
        assert_eq!(print.aggressor, Side::Buy);
        assert_eq!(print.ts, 1_700_000_000_250);
        assert_eq!(instrument_id(&trade), "RITHMIC:MES@CME");

        let sell = parse_last_trade(&decode_frame(&hex("last-trade-2")).unwrap()).unwrap();
        assert_eq!(sell.aggressor, Side::Sell);
        assert_eq!(sell.price, 5_101.00);

        let book = parse_order_book(&decode_frame(&hex("order-book")).unwrap()).expect("a book");
        assert_eq!(book.bids.len(), 2);
        assert_eq!(book.bids[0].price, 5_100.75);
        assert_eq!(book.bids[1].qty, 30.0);
        assert_eq!(book.asks[0].price, 5_101.00);
        assert_eq!(book.asks[1].qty, 19.0);
        assert_eq!(book.ts, 1_700_000_002_500);

        // A BEGIN with no rows and no END is an unfinished snapshot, which is what the
        // re-subscribe path is for.
        let begin = decode_frame(&hex("order-book-begin-only")).unwrap();
        assert_eq!(begin.varint(field::DEPTH_UPDATE_TYPE), Some(BOOK_BEGIN));
        assert_eq!(begin.varint(field::DEPTH_BID_PRICE), None, "no bid rows arrived yet");
    }

    #[test]
    fn a_frame_is_a_length_prefix_and_a_body() {
        let body = last_trade_body(5_101.25, 3, 1, 1_700_000_000, 250_000);
        let frame = encode_frame(&body);
        assert_eq!(&frame[..4], &(body.len() as u32).to_be_bytes());
        let message = decode_frame(&frame).expect("a well-formed frame");
        assert_eq!(message.varint(field::TEMPLATE_ID), Some(template::LAST_TRADE));
    }

    #[test]
    fn a_truncated_frame_is_refused_not_guessed() {
        let body = last_trade_body(1.0, 1, 1, 1, 1);
        let mut frame = encode_frame(&body);
        frame.truncate(frame.len() - 3);
        assert!(decode_frame(&frame).is_err());
        assert!(decode_frame(&[0, 0]).is_err(), "no length prefix at all");
    }

    #[test]
    fn a_last_trade_frame_becomes_a_print_with_its_values() {
        let body = last_trade_body(5_101.25, 3, 2, 1_700_000_000, 250_000);
        let message = decode_message(&body).unwrap();
        let trade = parse_last_trade(&message).expect("a print");
        assert_eq!(trade.price, 5_101.25);
        assert_eq!(trade.qty, 3.0);
        assert_eq!(trade.aggressor, Side::Sell, "aggressor 2 is a sell");
        assert_eq!(trade.ts, 1_700_000_000_250, "ssboe seconds plus usecs");
        assert_eq!(trade.seq, 1_700_000_000_250_000, "the microsecond stamp is the key");
        assert_eq!(instrument_id(&message), "RITHMIC:MES@CME");
    }

    #[test]
    fn a_snapshot_trade_is_not_a_new_print() {
        let mut writer = Writer::new();
        writer
            .varint(field::TEMPLATE_ID, template::LAST_TRADE)
            .bool(field::IS_SNAPSHOT, true)
            .double(field::TRADE_PRICE, 10.0);
        writer.varint(field::IS_SNAPSHOT, 1);
        let message = decode_message(&writer.finish()).unwrap();
        assert_eq!(message.bool(field::IS_SNAPSHOT), Some(true));
        assert!(parse_last_trade(&message).is_none());
    }

    #[test]
    fn a_bbo_frame_honours_its_presence_bits() {
        // presence_bits 1 means the frame carries the bid only.
        let mut writer = Writer::new();
        writer
            .varint(field::TEMPLATE_ID, template::BEST_BID_OFFER)
            .string(field::SYMBOL, "MES")
            .string(field::EXCHANGE, "CME")
            .varint(field::PRESENCE_BITS, 1)
            .double(field::BID_PRICE, 5_101.00)
            .varint(field::BID_SIZE, 4)
            .double(field::ASK_PRICE, 5_101.25)
            .varint(field::ASK_SIZE, 6)
            .varint(field::SSBOE, 1_700_000_000)
            .varint(field::USECS, 0);
        let snapshot = parse_bbo(&decode_message(&writer.finish()).unwrap()).unwrap();
        assert_eq!(snapshot.bids.len(), 1);
        assert_eq!(snapshot.bids[0].price, 5_101.00);
        assert_eq!(snapshot.bids[0].qty, 4.0);
        assert!(snapshot.asks.is_empty(), "the frame did not claim an ask");

        // Both sides present.
        let mut both = Writer::new();
        both.varint(field::TEMPLATE_ID, template::BEST_BID_OFFER)
            .varint(field::PRESENCE_BITS, 3)
            .double(field::BID_PRICE, 5_101.00)
            .varint(field::BID_SIZE, 4)
            .double(field::ASK_PRICE, 5_101.25)
            .varint(field::ASK_SIZE, 6);
        let snapshot = parse_bbo(&decode_message(&both.finish()).unwrap()).unwrap();
        assert_eq!(snapshot.asks[0].price, 5_101.25);
        assert_eq!(snapshot.asks[0].qty, 6.0);
    }

    #[test]
    fn an_order_book_frame_pairs_the_parallel_arrays() {
        let mut writer = Writer::new();
        writer
            .varint(field::TEMPLATE_ID, template::ORDER_BOOK)
            .string(field::SYMBOL, "MES")
            .string(field::EXCHANGE, "CME")
            .packed_doubles(field::DEPTH_BID_PRICE, &[5_100.75, 5_100.50, 5_100.25])
            .packed_doubles(field::DEPTH_ASK_PRICE, &[5_101.00, 5_101.25])
            .varint(field::DEPTH_BID_SIZE, 12)
            .varint(field::DEPTH_BID_SIZE, 30)
            .varint(field::DEPTH_BID_SIZE, 4)
            .varint(field::DEPTH_ASK_SIZE, 8)
            .varint(field::DEPTH_ASK_SIZE, 19)
            .varint(field::SSBOE, 1_700_000_000)
            .varint(field::USECS, 500_000);
        let snapshot = parse_order_book(&decode_message(&writer.finish()).unwrap()).unwrap();
        assert_eq!(snapshot.bids.len(), 3);
        assert_eq!(snapshot.bids[0].price, 5_100.75, "best bid first");
        assert_eq!(snapshot.bids[0].qty, 12.0);
        assert_eq!(snapshot.bids[1].qty, 30.0, "sizes stay aligned with prices");
        assert_eq!(snapshot.asks.len(), 2);
        assert_eq!(snapshot.asks[0].price, 5_101.00);
        assert_eq!(snapshot.asks[1].qty, 19.0);
        assert_eq!(snapshot.ts, 1_700_000_000_500);
    }

    #[test]
    fn unpacked_repeated_fields_decode_too() {
        // The same book written one value per key instead of packed.
        let mut writer = Writer::new();
        writer.varint(field::TEMPLATE_ID, template::ORDER_BOOK);
        for price in [5_101.25, 5_101.00] {
            writer.double(field::DEPTH_ASK_PRICE, price);
        }
        for size in [19, 8] {
            writer.varint(field::DEPTH_ASK_SIZE, size);
        }
        let snapshot = parse_order_book(&decode_message(&writer.finish()).unwrap()).unwrap();
        assert_eq!(snapshot.asks.iter().map(|level| level.price).collect::<Vec<_>>(), vec![5_101.00, 5_101.25]);
        assert_eq!(snapshot.asks[0].qty, 8.0);
    }

    #[test]
    fn a_login_request_carries_the_credentials_and_the_ticker_plant() {
        let config = RithmicConfig {
            user: "trader".into(),
            password: "secret".into(),
            system: "Rithmic Paper Trading".into(),
            gateway: GATEWAY.into(),
            app_name: "chartkit".into(),
            ws_url: None,
            partial_book_after: PARTIAL_BOOK_AFTER,
        };
        let message = decode_message(&login_request(&config)).unwrap();
        assert_eq!(message.varint(field::TEMPLATE_ID), Some(template::REQUEST_LOGIN));
        assert_eq!(message.string(field::USER).as_deref(), Some("trader"));
        assert_eq!(message.string(field::PASSWORD).as_deref(), Some("secret"));
        assert_eq!(message.string(field::SYSTEM_NAME).as_deref(), Some("Rithmic Paper Trading"));
        assert_eq!(message.varint(field::INFRA_TYPE), Some(TICKER_PLANT));
    }

    #[test]
    fn a_subscribe_request_names_the_venue_and_the_three_channels() {
        let message = decode_message(&market_data_request("MES", "CME", true)).unwrap();
        assert_eq!(message.varint(field::TEMPLATE_ID), Some(template::REQUEST_MARKET_DATA_UPDATE));
        assert_eq!(message.string(field::SYMBOL).as_deref(), Some("MES"));
        assert_eq!(message.string(field::EXCHANGE).as_deref(), Some("CME"));
        assert_eq!(message.varint(field::REQUEST), Some(REQUEST_SUBSCRIBE));
        assert_eq!(message.varint(field::UPDATE_BITS), Some(UPDATE_BITS));
        let unsubscribe = decode_message(&market_data_request("MES", "CME", false)).unwrap();
        assert_eq!(unsubscribe.varint(field::REQUEST), Some(REQUEST_UNSUBSCRIBE));
    }

    #[test]
    fn an_rp_code_that_is_not_zero_is_an_error() {
        let mut writer = Writer::new();
        writer.varint(field::TEMPLATE_ID, template::RESPONSE_LOGIN).string(field::RP_CODE, "0");
        assert_eq!(rp_error(&decode_message(&writer.finish()).unwrap()), None);
        let mut bad = Writer::new();
        bad.varint(field::TEMPLATE_ID, template::RESPONSE_LOGIN)
            .string(field::RP_CODE, "1005");
        assert_eq!(rp_error(&decode_message(&bad.finish()).unwrap()).as_deref(), Some("1005"));
    }

    #[test]
    fn unknown_fields_are_skipped_not_misread() {
        // A schema revision that added field 999 must not break the print behind it.
        let mut writer = Writer::new();
        writer
            .varint(999, 7)
            .string(998, "future")
            .double(field::TRADE_PRICE, 4_000.5)
            .varint(field::SSBOE, 1)
            .varint(field::USECS, 1);
        let message = decode_message(&writer.finish()).unwrap();
        assert_eq!(message.double(field::TRADE_PRICE), Some(4_000.5));
        assert_eq!(message.string(998).as_deref(), Some("future"));
    }

    /// One-off generator for `fixtures/rithmic/frames.json`; run with --ignored.
    #[test]
    #[ignore]
    fn emit_fixtures() {
        let mut out = Vec::new();
        let mut push = |name: &str, body: Vec<u8>| {
            let frame = encode_frame(&body);
            let hex: String = frame.iter().map(|b| format!("{b:02x}")).collect();
            out.push(format!("  \"{name}\": \"{hex}\""));
        };
        let mut login = Writer::new();
        login
            .varint(field::TEMPLATE_ID, template::RESPONSE_LOGIN)
            .string(field::RP_CODE, "0")
            .string(field::UNIQUE_USER_ID, "u1")
            .double(field::HEARTBEAT_INTERVAL, 30.0);
        push("response-login", login.finish());
        for (index, (price, size, aggressor, usecs)) in [
            (5_101.25f64, 3i64, 1u64, 250_000u64),
            (5_101.00, 1, 2, 400_000),
            (5_101.50, 7, 1, 900_000),
        ]
        .iter()
        .enumerate()
        {
            let mut trade = Writer::new();
            trade
                .varint(field::TEMPLATE_ID, template::LAST_TRADE)
                .string(field::SYMBOL, "MES")
                .string(field::EXCHANGE, "CME")
                .double(field::TRADE_PRICE, *price)
                .varint(field::TRADE_SIZE, *size as u64)
                .varint(field::AGGRESSOR, *aggressor)
                .varint(field::SSBOE, 1_700_000_000 + index as u64)
                .varint(field::USECS, *usecs);
            push(&format!("last-trade-{}", index + 1), trade.finish());
        }
        let mut book = Writer::new();
        book.varint(field::TEMPLATE_ID, template::ORDER_BOOK)
            .string(field::SYMBOL, "MES")
            .string(field::EXCHANGE, "CME")
            .varint(field::DEPTH_UPDATE_TYPE, BOOK_END)
            .packed_doubles(field::DEPTH_BID_PRICE, &[5_100.75, 5_100.50])
            .packed_doubles(field::DEPTH_ASK_PRICE, &[5_101.00, 5_101.25])
            .varint(field::DEPTH_BID_SIZE, 12)
            .varint(field::DEPTH_BID_SIZE, 30)
            .varint(field::DEPTH_ASK_SIZE, 8)
            .varint(field::DEPTH_ASK_SIZE, 19)
            .varint(field::SSBOE, 1_700_000_002)
            .varint(field::USECS, 500_000);
        push("order-book", book.finish());
        let mut begin = Writer::new();
        begin.varint(field::TEMPLATE_ID, template::ORDER_BOOK)
            .string(field::SYMBOL, "MES")
            .string(field::EXCHANGE, "CME")
            .varint(field::DEPTH_UPDATE_TYPE, BOOK_BEGIN)
            .packed_doubles(field::DEPTH_ASK_PRICE, &[5_101.00])
            .varint(field::DEPTH_ASK_SIZE, 8);
        push("order-book-begin-only", begin.finish());
        println!("{{\n{}\n}}", out.join(",\n"));
    }

    #[test]
    fn symbols_split_into_the_two_fields_the_venue_wants() {
        assert_eq!(split_symbol("MES@CME"), ("MES".into(), "CME".into()));
        assert_eq!(split_symbol("NQ@nyse"), ("NQ".into(), "NYSE".into()));
        assert_eq!(split_symbol("MES"), ("MES".into(), "CME".into()));
    }

    #[test]
    fn an_unconfigured_venue_names_what_is_missing() {
        let store = CredentialStore::default();
        let error = RithmicConfig::from_store(&store).unwrap_err();
        assert!(error.contains("RITHMIC_USER"));
        assert!(error.contains("RITHMIC_SYSTEM"));
    }

    #[test]
    fn subscribing_records_the_exchange_per_symbol() {
        let mut wanted = HashMap::new();
        apply_command(
            &mut wanted,
            &FeedCommand::Subscribe {
                venue: Venue::Rithmic,
                symbol: "MES@CME".into(),
                timeframe: Timeframe::Minute(1),
            },
        );
        assert_eq!(wanted.get("MES").map(String::as_str), Some("CME"));
        assert_eq!(instrument_id(&decode_message(&market_data_request("MES", "CME", true)).unwrap()), "RITHMIC:MES@CME");
    }
}
