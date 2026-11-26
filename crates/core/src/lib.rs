//! Domain model shared by feeds, storage and the API layer.
//!
//! Prices travel as `f64` plus an explicit `price_tick` from the venue. Bucketing
//! uses integer tick indices so floating point drift cannot split one price across
//! two order-flow cells.

pub mod alert;
pub mod bar;
pub mod flow;
pub mod id;
pub mod instrument;
pub mod time;
pub mod timeframe;

pub use alert::{
    has_given_back, is_satisfied, judge_downtime, step, Alert, AlertEvent, AlertFire, AlertKind,
    AlertTrigger, Downtime, WireEvent,
};
pub use bar::{Bar, BarAggregator};
pub use flow::{
    DepthDelta, DepthSnapshot, FootprintBar, FootprintSeries, FootprintSeriesBuilder, Level,
    PriceCell, ProfileBucket, VolumeProfile, VolumeProfileBuilder, Side, Trade,
};
pub use id::new_id;
pub use instrument::{AssetClass, Instrument, InstrumentId, Session, Venue};
pub use time::now_ms;
pub use timeframe::Timeframe;

/// Convert a price to its tick index for bucketing.
pub fn tick_index(price: f64, price_tick: f64) -> i64 {
    if price_tick <= 0.0 {
        return 0;
    }
    (price / price_tick).round() as i64
}

/// Inverse of `tick_index`. Rounded back to the tick's own precision, because
/// `index * tick` in binary floating point otherwise drifts (5907377 * 0.01 gives
/// 59073.770000000004), which misaligns grid rows and ladder labels.
pub fn tick_price(index: i64, price_tick: f64) -> f64 {
    if price_tick <= 0.0 {
        return 0.0;
    }
    let factor = 10f64.powi(tick_decimals(price_tick) as i32);
    (index as f64 * price_tick * factor).round() / factor
}

/// Decimal places needed to write `price_tick` exactly, from its shortest
/// round-trip representation.
fn tick_decimals(price_tick: f64) -> usize {
    price_tick
        .to_string()
        .split('.')
        .nth(1)
        .map(|fraction| fraction.trim_end_matches('0').len().min(8))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_roundtrip_stays_exact() {
        for (tick, price) in [(0.01, 59_073.77), (0.5, 100.5), (0.00001, 0.00003), (1.0, 4_200.0)] {
            let index = tick_index(price, tick);
            assert_eq!(tick_price(index, tick), price, "tick {tick}");
        }
    }
}
