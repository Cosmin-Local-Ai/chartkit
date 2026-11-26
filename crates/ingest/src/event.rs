use chartkit_core::instrument::VenueTag;
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
    /// Data is arriving, but the venue stamps it late (IBKR without a streaming
    /// entitlement). A trader acts on `live` differently than on `delayed`, so the two
    /// are separate states rather than one state with a caveat in the detail text.
    Delayed,
    Stalled,
    /// No credentials for this venue. Not a failure: the feed simply was never started.
    NotConfigured,
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
        /// Which venue is speaking. Several feeds run at once, so a feed-wide status
        /// cannot be identified by instrument alone.
        venue: Venue,
        state: FeedState,
        detail: String,
    },
}

/// Control messages a running feed accepts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FeedCommand {
    /// Start publishing klines, prints and depth for a venue symbol.
    Subscribe {
        venue: Venue,
        symbol: String,
        timeframe: Timeframe,
    },
    Unsubscribe { venue: Venue, symbol: String },
}

impl FeedEvent {
    pub fn status(
        venue: Venue,
        instrument: Option<String>,
        state: FeedState,
        detail: impl Into<String>,
    ) -> Self {
        FeedEvent::Status { venue, instrument, state, detail: detail.into() }
    }

    /// Health of the venue connection itself, not of one instrument.
    pub fn venue_status(venue: Venue, state: FeedState, detail: impl Into<String>) -> Self {
        Self::status(venue, None, state, detail)
    }

    /// The key the hub files a status under. Feed-wide statuses are keyed by venue tag so
    /// that a second venue cannot overwrite the first one a client was shown.
    pub fn status_key(&self) -> Option<String> {
        match self {
            FeedEvent::Status { instrument, venue, .. } => {
                Some(instrument.clone().unwrap_or_else(|| venue.tag().to_string()))
            }
            _ => None,
        }
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
