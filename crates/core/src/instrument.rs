use serde::{Deserialize, Serialize};

/// Stable identifier, formatted `VENUE:SYMBOL`, e.g. `BINANCE:BTCUSDT`.
pub type InstrumentId = str;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetClass {
    Equity,
    Etf,
    Index,
    Future,
    Option,
    CryptoSpot,
    Perpetual,
    Forex,
    Prediction,
    Treasury,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Venue {
    Binance,
    Bybit,
    Okx,
    Kraken,
    Coinbase,
    Tradovate,
    InteractiveBrokers,
    /// Rithmic R|Trade Execution Platform: a direct CME book rather than a broker
    /// round-trip. Tradovate's own feed is Rithmic-backed, so this is a second path
    /// to the same market, not a new one.
    Rithmic,
    Simulation,
}

/// Trading hours in the instrument's own timezone. An empty `windows` list means
/// the instrument trades continuously.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub timezone: String,
    /// `(weekday 0=Mon, start "HH:MM", end "HH:MM")`, end may wrap past midnight.
    pub windows: Vec<(u32, String, String)>,
}

impl Session {
    pub fn continuous() -> Self {
        Self { timezone: "UTC".into(), windows: Vec::new() }
    }

    pub fn is_continuous(&self) -> bool {
        self.windows.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub id: String,
    pub venue: Venue,
    pub symbol: String,
    /// Short label for charts and watchlists, e.g. `BTCUSDT` or `ES Z6`.
    pub display: String,
    pub name: String,
    pub asset_class: AssetClass,
    /// Smallest price increment the venue publishes.
    pub price_tick: f64,
    /// Smallest quantity increment.
    pub qty_step: f64,
    pub price_precision: u32,
    pub qty_precision: u32,
    pub quote_currency: String,
    pub session: Session,
    pub active: bool,
}

impl Instrument {
    pub fn key(venue: Venue, symbol: &str) -> String {
        format!("{}:{}", venue.tag(), symbol)
    }

    /// Format a price with this instrument's precision.
    pub fn format_price(&self, price: f64) -> String {
        format!("{:.*}", self.price_precision as usize, price)
    }
}

/// Upper-case venue tag used inside instrument ids.
pub trait VenueTag {
    fn tag(&self) -> &'static str;
}

impl VenueTag for Venue {
    fn tag(&self) -> &'static str {
        match self {
            Venue::Binance => "BINANCE",
            Venue::Bybit => "BYBIT",
            Venue::Okx => "OKX",
            Venue::Kraken => "KRAKEN",
            Venue::Coinbase => "COINBASE",
            Venue::Tradovate => "TRADOVATE",
            Venue::InteractiveBrokers => "IBKR",
            Venue::Rithmic => "RITHMIC",
            Venue::Simulation => "SIM",
        }
    }
}
