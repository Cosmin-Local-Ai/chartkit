//! Venue feeds: one adapter per exchange behind a shared event and command type.
//!
//! Binance, Tradovate, IBKR and Rithmic each emit the same [`FeedEvent`]s and accept the same
//! [`FeedCommand`]s, so the server pumps any of them into the same store and hub. Logins come
//! from the environment or a file the settings panel writes — never from the binary — and a
//! venue with no credentials says so rather than failing or looking live. See
//! [`credentials`] for what each venue needs and `chartkit --check-feed <venue>` to prove one
//! against the real venue with the user's own subscription.

pub mod binance;
pub mod credentials;
pub mod event;
pub mod ibkr;
pub mod rithmic;
pub mod tradovate;

pub use binance::{AggTrade, AggTradePage, BinanceFeed, REST_BASE};
pub use credentials::{CredentialStore, VenueStatus};
pub use event::{FeedCommand, FeedEvent, FeedState};
pub use ibkr::{Entitlement, IbkrConfig, IbkrFeed};
pub use rithmic::{RithmicConfig, RithmicFeed};
pub use tradovate::{TradovateConfig, TradovateFeed};

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
