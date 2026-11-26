use chartkit_core::{
    Bar, DepthSnapshot, Instrument, Side, Timeframe, Trade, Venue,
};
use serde::{Deserialize, Serialize};

/// Connection health for one instrument, shown in the status strip.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FeedState {
    Connecting,
    Backfilling,
    Live,
    Stalled,
    Failed,
}

/// Everything a feed publishes, in one type so the pump has a single path.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FeedEvent {
    #[serde(rename_all = "camelCase")]
    Instruments { venue: Venue, items: Vec<Instrument> },
    #[serde(rename_all = "camelCase")]
    Trades { instrument: String, trades: Vec<Trade> },
    #[serde(rename_all = "camelCase")]
    Depth { instrument: String, snapshot: DepthSnapshot },
    #[serde(rename_all = "camelCase")]
    Bar { instrument: String, timeframe: Timeframe, bar: Bar },
    #[serde(rename_all = "camelCase")]
    Status {
        instrument: Option<String>,
        state: FeedState,
        detail: String,
    },
}

/// Control messages a running feed accepts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FeedCommand {
    /// Start publishing klines, prints and depth for a venue symbol.
    Subscribe { symbol: String, timeframe: Timeframe },
    Unsubscribe { symbol: String },
}

impl FeedEvent {
    pub fn status(instrument: Option<String>, state: FeedState, detail: impl Into<String>) -> Self {
        FeedEvent::Status { instrument, state, detail: detail.into() }
    }

    pub fn instrument(&self) -> Option<&str> {
        match self {
            FeedEvent::Trades { instrument, .. }
            | FeedEvent::Depth { instrument, .. }
            | FeedEvent::Bar { instrument, .. } => Some(instrument),
            FeedEvent::Status { instrument, .. } => instrument.as_deref(),
            FeedEvent::Instruments { .. } => None,
        }
    }
}

pub fn aggressor_from_buyer_maker(is_buyer_maker: bool) -> Side {
    if is_buyer_maker {
        Side::Sell
    } else {
        Side::Buy
    }
}
