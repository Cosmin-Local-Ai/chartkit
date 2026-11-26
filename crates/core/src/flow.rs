//! Prints, depth and the order-flow aggregates derived from them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::tick_index;
use crate::timeframe::Timeframe;

/// Aggressor side of a print: who crossed the spread.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Trade {
    pub ts: i64,
    /// Venue sequence, used to detect gaps and de-duplicate replayed prints.
    pub seq: u64,
    pub price: f64,
    pub qty: f64,
    pub aggressor: Side,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Level {
    pub price: f64,
    pub qty: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DepthSnapshot {
    pub ts: i64,
    pub bids: Vec<Level>,
    pub asks: Vec<Level>,
}

/// Incremental depth update. A level with `qty == 0` removes that price.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DepthDelta {
    pub ts: i64,
    pub bids: Vec<Level>,
    pub asks: Vec<Level>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceCell {
    /// Quantity traded while buyers were the aggressor.
    pub buy_qty: f64,
    pub sell_qty: f64,
    pub buy_n: u32,
    pub sell_n: u32,
}

impl PriceCell {
    pub fn total(&self) -> f64 {
        self.buy_qty + self.sell_qty
    }

    pub fn delta(&self) -> f64 {
        self.buy_qty - self.sell_qty
    }

    fn add(&mut self, trade: &Trade) {
        match trade.aggressor {
            Side::Buy => {
                self.buy_qty += trade.qty;
                self.buy_n += 1;
            }
            Side::Sell => {
                self.sell_qty += trade.qty;
                self.sell_n += 1;
            }
        }
    }
}

/// One bar of bid x ask volume split by price. Cells are ordered low price first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FootprintBar {
    pub start: i64,
    pub cells: Vec<(f64, PriceCell)>,
    pub total_qty: f64,
    pub delta: f64,
    pub trades: u64,
    /// Price carrying the largest total volume in the bar.
    pub poc: Option<f64>,
    /// Diagonal imbalances, as prices where ask volume at that level exceeds the
    /// bid volume one tick above by `ratio`, split by direction.
    pub buy_imbalance: Vec<f64>,
    pub sell_imbalance: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FootprintSeries {
    pub instrument: String,
    pub timeframe: Timeframe,
    pub price_tick: f64,
    pub bars: Vec<FootprintBar>,
    /// Cumulative volume delta at the close of each bar, aligned with `bars`.
    pub cvd: Vec<f64>,
}

type Cells = BTreeMap<i64, PriceCell>;

#[derive(Default)]
struct OpenFootprint {
    start: i64,
    cells: Cells,
    total_qty: f64,
    delta: f64,
    trades: u64,
}

/// Builds footprint bars from a time-ordered print stream.
pub struct FootprintSeriesBuilder {
    timeframe: Timeframe,
    price_tick: f64,
    open: Option<OpenFootprint>,
    closed: Vec<FootprintBar>,
    cvd: Vec<f64>,
    running_cvd: f64,
}

impl FootprintSeriesBuilder {
    pub fn new(timeframe: Timeframe, price_tick: f64) -> Self {
        Self {
            timeframe,
            price_tick,
            open: None,
            closed: Vec::new(),
            cvd: Vec::new(),
            running_cvd: 0.0,
        }
    }

    pub fn on_trade(&mut self, trade: &Trade) {
        let start = self.timeframe.align(trade.ts);
        if self.open.as_ref().is_some_and(|open| open.start != start) {
            if let Some(bar) = self.take_open() {
                self.push_closed(bar);
            }
        }
        let open = self.open.get_or_insert(OpenFootprint { start, ..Default::default() });
        open.cells
            .entry(tick_index(trade.price, self.price_tick))
            .or_default()
            .add(trade);
        open.total_qty += trade.qty;
        open.trades += 1;
        open.delta += match trade.aggressor {
            Side::Buy => trade.qty,
            Side::Sell => -trade.qty,
        };
    }

    /// Seal everything and hand back the finished bars with the aligned CVD line.
    pub fn finish(mut self) -> (Vec<FootprintBar>, Vec<f64>) {
        if let Some(bar) = self.take_open() {
            self.push_closed(bar);
        }
        (self.closed, self.cvd)
    }

    /// Seal the partially built bar, e.g. when a feed reconnects.
    pub fn seal(&mut self) -> Option<FootprintBar> {
        let bar = self.take_open()?;
        self.push_closed(bar.clone());
        Some(bar)
    }

    pub fn cvd_at(&self, index: usize) -> Option<f64> {
        self.cvd.get(index).copied()
    }

    fn take_open(&mut self) -> Option<FootprintBar> {
        let open = self.open.take()?;
        if open.cells.is_empty() {
            return None;
        }
        let poc = open
            .cells
            .iter()
            .max_by(|a, b| a.1.total().total_cmp(&b.1.total()))
            .map(|(k, _)| crate::tick_price(*k, self.price_tick));
        let buy_imbalance = find_imbalances(&open.cells, self.price_tick, true);
        let sell_imbalance = find_imbalances(&open.cells, self.price_tick, false);
        Some(FootprintBar {
            start: open.start,
            cells: open
                .cells
                .iter()
                .map(|(k, c)| (crate::tick_price(*k, self.price_tick), *c))
                .collect(),
            total_qty: open.total_qty,
            delta: open.delta,
            trades: open.trades,
            poc,
            buy_imbalance,
            sell_imbalance,
        })
    }

    fn push_closed(&mut self, bar: FootprintBar) {
        self.running_cvd += bar.delta;
        self.cvd.push(self.running_cvd);
        self.closed.push(bar);
    }
}

/// Diagonal imbalance: ask volume at `p` against bid volume one tick higher
/// (buy pressure) or the mirror image (sell pressure).
fn find_imbalances(cells: &Cells, price_tick: f64, buy: bool) -> Vec<f64> {
    const MIN_RATIO: f64 = 3.0;
    const MIN_SPLIT: f64 = 2.0;
    let mut out = Vec::new();
    for (tick, cell) in cells {
        let neighbour = if buy { *tick + 1 } else { *tick - 1 };
        let Some(other) = cells.get(&neighbour) else { continue };
        let (near, far) = if buy {
            (cell.sell_qty, other.buy_qty)
        } else {
            (cell.buy_qty, other.sell_qty)
        };
        if near < MIN_SPLIT || far < MIN_SPLIT {
            continue;
        }
        let ratio = if far == 0.0 { f64::INFINITY } else { near / far };
        if ratio >= MIN_RATIO {
            out.push(crate::tick_price(if buy { neighbour } else { *tick }, price_tick));
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBucket {
    pub price: f64,
    pub buy_qty: f64,
    pub sell_qty: f64,
    pub total_qty: f64,
}

/// Volume-at-price over a window, with point of control and value area.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeProfile {
    pub instrument: String,
    /// Venue tick, not the bucket width: one bucket is `price_tick * step_ticks` wide.
    pub price_tick: f64,
    /// Ticks folded into one bucket. 1 is the venue's own price grid.
    pub step_ticks: i64,
    pub buckets: Vec<ProfileBucket>,
    /// Point of control and value-area edges. Always read off the venue's own price grid,
    /// whatever width `step_ticks` folds the rows to.
    pub poc: Option<f64>,
    pub vah: Option<f64>,
    pub val: Option<f64>,
    pub total_qty: f64,
    /// Fraction of total volume the value area is required to cover.
    pub value_area: f64,
}

/// Volume is kept per venue tick and only grouped on the way out, so `step_ticks`
/// decides how many rows travel and nothing else: the same window gives the same poc,
/// vah and val whatever step it is asked for.
pub struct VolumeProfileBuilder {
    price_tick: f64,
    step_ticks: i64,
    buckets: BTreeMap<i64, (f64, f64)>,
    total_qty: f64,
}

impl VolumeProfileBuilder {
    pub fn new(price_tick: f64) -> Self {
        Self::with_step(price_tick, 1)
    }

    /// `step_ticks` venue ticks per bucket. Anything below 1 keeps per-tick buckets.
    pub fn with_step(price_tick: f64, step_ticks: i64) -> Self {
        Self {
            price_tick,
            step_ticks: step_ticks.max(1),
            buckets: BTreeMap::new(),
            total_qty: 0.0,
        }
    }

    pub fn on_trade(&mut self, trade: &Trade) {
        let entry = self.buckets.entry(tick_index(trade.price, self.price_tick)).or_default();
        match trade.aggressor {
            Side::Buy => entry.0 += trade.qty,
            Side::Sell => entry.1 += trade.qty,
        }
        self.total_qty += trade.qty;
    }

    pub fn build(self, instrument: &str, value_area: f64) -> VolumeProfile {
        let value_area = value_area.clamp(0.05, 1.0);
        let (poc, vah, val) = levels(&self.buckets, self.price_tick, self.total_qty, value_area);
        VolumeProfile {
            instrument: instrument.to_string(),
            price_tick: self.price_tick,
            step_ticks: self.step_ticks,
            poc,
            vah,
            val,
            total_qty: self.total_qty,
            buckets: fold(&self.buckets, self.step_ticks, self.price_tick),
            value_area,
        }
    }
}

/// Rows for transport: the per-tick volume grouped `step` ticks at a time, anchored on
/// tick 0, so a coarser step always groups whole finer buckets.
fn fold(buckets: &BTreeMap<i64, (f64, f64)>, step: i64, price_tick: f64) -> Vec<ProfileBucket> {
    let mut rows: Vec<ProfileBucket> = Vec::new();
    let mut band = i64::MIN;
    for (tick, (buy, sell)) in buckets {
        let group = tick.div_euclid(step);
        match rows.last_mut() {
            Some(row) if group == band => {
                row.buy_qty += buy;
                row.sell_qty += sell;
                row.total_qty = row.buy_qty + row.sell_qty;
            }
            _ => {
                band = group;
                rows.push(ProfileBucket {
                    price: crate::tick_price(group * step, price_tick),
                    buy_qty: *buy,
                    sell_qty: *sell,
                    total_qty: *buy + *sell,
                });
            }
        }
    }
    rows
}

/// Point of control and value-area edges, read off the venue's own price grid: the walk
/// widens from the busiest tick until the value area is covered.
fn levels(
    buckets: &BTreeMap<i64, (f64, f64)>,
    price_tick: f64,
    total_qty: f64,
    fraction: f64,
) -> (Option<f64>, Option<f64>, Option<f64>) {
    let rows: Vec<(f64, f64)> = buckets
        .iter()
        .map(|(tick, (buy, sell))| (crate::tick_price(*tick, price_tick), *buy + *sell))
        .collect();
    let Some(pivot) = rows.iter().enumerate().max_by(|a, b| a.1.1.total_cmp(&b.1.1)).map(|(i, _)| i) else {
        return (None, None, None);
    };
    let target = total_qty * fraction;
    let mut covered = rows[pivot].1;
    let (mut lo, mut hi) = (pivot, pivot);
    while covered < target && (lo > 0 || hi + 1 < rows.len()) {
        let down = if lo > 0 { rows[lo - 1].1 } else { -1.0 };
        let up = if hi + 1 < rows.len() { rows[hi + 1].1 } else { -1.0 };
        if up > down {
            hi += 1;
            covered += rows[hi].1;
        } else {
            lo -= 1;
            covered += rows[lo].1;
        }
    }
    (Some(rows[pivot].0), Some(rows[hi].0), Some(rows[lo].0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(ts: i64, price: f64, qty: f64, aggressor: Side) -> Trade {
        Trade { ts, seq: 0, price, qty, aggressor }
    }

    #[test]
    fn footprint_splits_bars_and_tracks_delta() {
        let mut builder = FootprintSeriesBuilder::new(Timeframe::Minute(1), 0.5);
        builder.on_trade(&trade(0, 100.0, 2.0, Side::Buy));
        builder.on_trade(&trade(60_000, 100.5, 1.0, Side::Sell));
        let (bars, cvd) = builder.finish();
        assert_eq!(bars.len(), 2, "a print past the boundary starts a new bar");
        assert_eq!((bars[0].delta, bars[1].delta), (2.0, -1.0));
        assert_eq!((bars[0].trades, bars[1].trades), (1, 1));
        assert!((cvd[1] - 1.0).abs() < 1e-9, "cvd accumulates bar deltas");
    }

    #[test]
    fn stacked_prices_share_one_cell() {
        let mut builder = FootprintSeriesBuilder::new(Timeframe::Minute(1), 0.5);
        builder.on_trade(&trade(0, 100.0, 2.0, Side::Buy));
        // 100.02 sits inside the 0.5 tick bucket of 100.0 and must not split.
        builder.on_trade(&trade(1_000, 100.02, 1.0, Side::Sell));
        let (bars, _) = builder.finish();
        assert_eq!(bars[0].cells.len(), 1);
        assert!((bars[0].total_qty - 3.0).abs() < 1e-9);
    }

    #[test]
    fn a_step_changes_rows_but_never_volume_or_levels() {
        let prices: Vec<f64> = (0..400).map(|i| 1_000.0 + i as f64 * 0.5).collect();
        let mut fine = VolumeProfileBuilder::new(0.5);
        let mut coarse = VolumeProfileBuilder::with_step(0.5, 20);
        for (index, price) in prices.iter().enumerate() {
            // A skewed book, so the point of control is a single price and not a plateau.
            let qty = if *price == 1_100.5 { 50.0 } else { 1.0 + (index % 3) as f64 };
            let side = if index % 2 == 0 { Side::Buy } else { Side::Sell };
            fine.on_trade(&trade(0, *price, qty, side));
            coarse.on_trade(&trade(0, *price, qty, side));
        }
        let fine = fine.build("TEST:AAA", 0.7);
        let coarse = coarse.build("TEST:AAA", 0.7);

        assert_eq!(fine.step_ticks, 1);
        assert_eq!(coarse.step_ticks, 20);
        assert_eq!(coarse.buckets.len() * 20, fine.buckets.len(), "one bucket per 20 ticks");
        assert!((fine.total_qty - coarse.total_qty).abs() < 1e-9, "folding must not lose volume");
        assert_eq!(fine.buckets.iter().map(|b| b.total_qty).sum::<f64>(), coarse.buckets.iter().map(|b| b.total_qty).sum::<f64>());

        assert_eq!(coarse.poc, fine.poc, "the point of control is not a wire-format choice");
        assert_eq!((coarse.vah, coarse.val), (fine.vah, fine.val), "neither is the value area");
        assert!(coarse.buckets.windows(2).all(|w| w[1].price > w[0].price), "rows stay ordered and distinct");
    }

    #[test]
    fn every_step_answers_with_the_same_levels_and_the_same_volume() {
        let prices: Vec<f64> = (0..400).map(|i| 1_000.0 + i as f64 * 0.5).collect();
        let profile = |step: i64| {
            let mut builder = VolumeProfileBuilder::with_step(0.5, step);
            for (index, price) in prices.iter().enumerate() {
                let qty = if *price == 1_100.5 { 50.0 } else { 1.0 + (index % 3) as f64 };
                let side = if index % 2 == 0 { Side::Buy } else { Side::Sell };
                builder.on_trade(&trade(0, *price, qty, side));
            }
            builder.build("TEST:AAA", 0.7)
        };
        let per_tick = profile(1);
        // Nearly flat volume, so the walk runs to the bottom of the range on one side.
        assert_eq!((per_tick.poc, per_tick.vah, per_tick.val), (Some(1_100.5), Some(1_136.0), Some(1_000.0)));

        for step in [2, 5, 20, 50] {
            let folded = profile(step);
            assert_eq!((folded.poc, folded.vah, folded.val), (per_tick.poc, per_tick.vah, per_tick.val), "levels moved at step {step}");
            assert!((folded.total_qty - per_tick.total_qty).abs() < 1e-9, "volume moved at step {step}");
            assert_eq!(folded.buckets.iter().map(|b| b.total_qty).sum::<f64>(), per_tick.total_qty);

            // Each band carries exactly the volume of the per-tick rows inside it.
            let width = 0.5 * step as f64;
            for row in &folded.buckets {
                let inside: f64 = per_tick
                    .buckets
                    .iter()
                    .filter(|b| b.price >= row.price - 1e-9 && b.price < row.price + width - 1e-9)
                    .map(|b| b.total_qty)
                    .sum();
                assert!((row.total_qty - inside).abs() < 1e-9, "band {} lost volume at step {step}", row.price);
                assert!((row.buy_qty + row.sell_qty - row.total_qty).abs() < 1e-9, "band {} is unbalanced", row.price);
            }
            assert_eq!(folded.buckets.len(), per_tick.buckets.len() / step as usize, "rows did not shrink with step {step}");
        }
    }

    #[test]
    fn value_area_brackets_the_poc() {
        let mut p = VolumeProfileBuilder::new(1.0);
        for price in [10.0, 11.0, 12.0] {
            p.on_trade(&trade(0, price, if price == 11.0 { 9.0 } else { 1.0 }, Side::Buy));
        }
        let profile = p.build("TEST:AAA", 0.7);
        assert_eq!(profile.poc, Some(11.0));
        assert!(profile.val <= Some(11.0) && profile.vah >= Some(11.0));
    }
}
