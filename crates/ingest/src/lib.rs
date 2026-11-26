//! Venue feeds: one adapter per exchange behind a shared event and command type.

pub mod binance;
pub mod event;

pub use binance::{AggTrade, AggTradePage, BinanceFeed, REST_BASE};
pub use event::{FeedCommand, FeedEvent, FeedState};

use serde::{Deserialize, Serialize};

/// Errors a feed can surface. Reconnectable failures are reported as events, not
/// returned, so one venue cannot stop the others.
#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("websocket: {0}")]
    Socket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("unexpected payload: {0}")]
    Payload(String),
    #[error("interval {0} is not published by this venue")]
    UnsupportedInterval(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Venue interval string for a chart timeframe.
pub trait IntervalMap {
    fn interval(&self, timeframe: chartkit_core::Timeframe) -> Result<String, IngestError>;
}

/// Subscription control sent to a running feed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Subscription {
    #[serde(rename_all = "camelCase")]
    Spot { symbol: String },
}
