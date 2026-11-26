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

/// How a print's size is measured before it is placed in a band.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SizeUnit {
    /// Quote currency traded by the print: price x quantity. The same edges mean the
    /// same thing on every instrument, which is why it is the default.
    Notional,
    /// Base quantity of the print. Only comparable inside one instrument.
    Quantity,
}

/// One size band: prints whose size sits in `[min, max)`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeBand {
    /// Lower edge, inclusive. None on the band that takes everything below the first edge.
    pub min: Option<f64>,
    /// Upper edge, exclusive. None on the band that takes everything above the last edge.
    pub max: Option<f64>,
    /// Label the server chose for the band. The client prints it instead of building its
    /// own, so the numbers on screen and the numbers in the response cannot drift.
    pub label: String,
}

/// Aggressive volume and print count in one band of one group.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeBandCell {
    pub buy_qty: f64,
    pub sell_qty: f64,
    pub buy_n: u64,
    pub sell_n: u64,
}

impl SizeBandCell {
    pub fn total(&self) -> f64 {
        self.buy_qty + self.sell_qty
    }

    pub fn delta(&self) -> f64 {
        self.buy_qty - self.sell_qty
    }

    pub fn prints(&self) -> u64 {
        self.buy_n + self.sell_n
    }
}

/// One bar of volume split by size band, oldest bar first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeBandBar {
    pub start: i64,
    /// One entry per band, in band order, always `bands.len()` long.
    pub bands: Vec<SizeBandCell>,
    /// Running buy - sell per band from the first returned bar, one entry per band.
    pub cumulative: Vec<f64>,
    pub total_qty: f64,
    pub delta: f64,
    pub trades: u64,
}

/// One price level of volume split by size band, lowest level first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeBandLevel {
    /// Bottom edge of the level; one level is `price_tick * step_ticks` wide.
    pub price: f64,
    /// One entry per band, in band order, always `bands.len()` long.
    pub bands: Vec<SizeBandCell>,
    pub total_qty: f64,
    pub delta: f64,
    pub trades: u64,
}

/// Prints of a window split by size band, grouped by bar and by price level.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeBandSeries {
    pub instrument: String,
    pub timeframe: Timeframe,
    /// Requested window, echoed back so a client can tell what the rows actually cover.
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub price_tick: f64,
    /// Ticks folded into one level row. 1 is the venue's own price grid.
    pub step_ticks: i64,
    pub size_unit: SizeUnit,
    /// How the edges were chosen, in words the client prints verbatim.
    pub band_rule: String,
    /// The bands, in order, with the edges and labels the aggregation used.
    pub bands: Vec<SizeBand>,
    pub bars: Vec<SizeBandBar>,
    pub levels: Vec<SizeBandLevel>,
    /// Everything the window held, per band, in band order.
    pub totals: Vec<SizeBandCell>,
    /// Prints the aggregation read.
    pub prints: u64,
    pub total_qty: f64,
    pub delta: f64,
}

/// One print at or above the cluster threshold. The notional travels with the row so the
/// screen shows the number the server filtered on rather than one the client rebuilt.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterPrint {
    pub ts: i64,
    /// Venue sequence, the other half of the print's primary key, so a listed row can be
    /// found again in the store.
    pub seq: u64,
    pub price: f64,
    pub qty: f64,
    pub notional: f64,
    pub aggressor: Side,
}

impl ClusterPrint {
    pub fn of(trade: &Trade) -> Self {
        Self {
            ts: trade.ts,
            seq: trade.seq,
            price: trade.price,
            qty: trade.qty,
            notional: trade.price * trade.qty,
            aggressor: trade.aggressor,
        }
    }
}

/// How many of one bar's prints cleared the threshold, and what they were worth. `notional`
/// over `qty` is the volume-weighted price of exactly those prints, which is where the
/// bar's cluster sits on the chart.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterBar {
    pub start: i64,
    pub prints: u64,
    pub buy_n: u64,
    pub sell_n: u64,
    pub qty: f64,
    pub notional: f64,
}

/// Prints at or above one size, newest first, with the counts of the window they were
/// searched in. The counts are the whole window's; `rows` is the newest `limit` of them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSearch {
    pub instrument: String,
    pub timeframe: Timeframe,
    /// Requested window, echoed back so a client can tell what the rows actually cover.
    pub from: Option<i64>,
    pub to: Option<i64>,
    /// The measure `threshold` is expressed in, the same one the size-band split bands by.
    pub size_unit: SizeUnit,
    /// The threshold and its measure, in words the client prints verbatim.
    pub size_rule: String,
    pub threshold: f64,
    /// Every print the window holds, big or small. Zero means the window holds no prints at
    /// all, which is a different answer from "nothing in it was big enough".
    pub prints: u64,
    /// Prints that cleared the threshold.
    pub clusters: u64,
    /// Rows actually sent, and the cap the server applied.
    pub returned: u64,
    pub limit: i64,
    /// True when the cap cut the list short: `clusters` still says how many there were.
    pub truncated: bool,
    pub cluster_qty: f64,
    pub cluster_notional: f64,
    pub buy_n: u64,
    pub sell_n: u64,
    pub rows: Vec<ClusterPrint>,
    /// Bars holding at least one cluster print, oldest first. A bar with none is left out,
    /// since the chart only needs the places to mark.
    pub bars: Vec<ClusterBar>,
}

// ---------------------------------------------------------------- TPO / market profile

/// What a value area is measured in. The shipped product exposes both choices as
/// `valueAreaMethod` / `vaFromVolume`; the walk is the same either way.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValueAreaBasis {
    /// Fraction of traded quantity. What the volume profile uses, so both panes put the
    /// value-area edges of one window on the same prices.
    #[default]
    Volume,
    /// Fraction of the letters in the grid: how many time buckets traded at a price.
    Tpo,
}

/// One time bucket crossed with one price row: what traded there, split by aggressor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TpoCell {
    pub buy_qty: f64,
    pub sell_qty: f64,
    pub buy_n: u64,
    pub sell_n: u64,
}

impl TpoCell {
    pub fn total(&self) -> f64 {
        self.buy_qty + self.sell_qty
    }

    pub fn prints(&self) -> u64 {
        self.buy_n + self.sell_n
    }
}

/// One time bucket of the grid, oldest first: the letter it earned and the price rows that
/// traded inside it. A row the bucket never touched is absent, which is what lets a client
/// tell "this bucket did not trade here" apart from "this bucket traded nothing".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TpoBucket {
    pub start: i64,
    /// The bucket's mark inside its session: `A` for the first, then `B`, and so on.
    pub letter: String,
    /// Price rows that traded, ascending. Each row is `price_tick * step_ticks` wide.
    pub rows: Vec<(f64, TpoCell)>,
    pub prints: u64,
    pub total_qty: f64,
    /// The row of this bucket carrying the most volume.
    pub poc: Option<f64>,
}

/// One price row of one session: how many of its letters sit there, and what traded there.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TpoRow {
    /// Bottom edge of the row.
    pub price: f64,
    /// Letters in the row: the count a market profile prints beside it.
    pub tpo_count: u32,
    pub prints: u64,
    pub buy_qty: f64,
    pub sell_qty: f64,
    pub total_qty: f64,
}

/// One session of the grid. Letters restart at `A` here, and so do the levels: a window
/// that straddles a session boundary answers one block per session, never a blend.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TpoSession {
    pub start: i64,
    pub end: i64,
    /// The letters this session handed out, in order, so the letter distribution of a
    /// window can be read off the answer without walking the buckets.
    pub letters: String,
    pub buckets: Vec<TpoBucket>,
    /// Price rows of the session, ascending, with the letter count beside each.
    pub rows: Vec<TpoRow>,
    /// Read off the venue's own price grid, whatever width `rows` folds to.
    pub poc: Option<f64>,
    pub vah: Option<f64>,
    pub val: Option<f64>,
    pub value_area: f64,
    pub value_area_basis: ValueAreaBasis,
    pub prints: u64,
    pub total_qty: f64,
    /// True when the session's last bucket is still open at the newest stored print.
    pub developing: bool,
}

/// Prints of a window cut into time buckets and price rows: the letter grid, with the
/// point of control and value area of every session it covers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TpoSeries {
    pub instrument: String,
    /// Requested window, echoed back so a client can tell what the rows actually cover.
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub price_tick: f64,
    /// Venue ticks folded into one price row. 1 is the venue's own price grid.
    pub step_ticks: i64,
    /// Minutes in one time bucket, and the same grid the letters were assigned on.
    pub bucket_minutes: i64,
    pub session_minutes: i64,
    pub session_start_minute: i64,
    /// How the grid was cut, in words the client prints verbatim, so a letter on screen
    /// always comes with the time span that produced it.
    pub bucket_rule: String,
    pub session_rule: String,
    pub value_area_rule: String,
    pub sessions: Vec<TpoSession>,
    /// Everything the returned buckets hold.
    pub prints: u64,
    pub total_qty: f64,
    /// Oldest and newest bucket start that carries prints. A bucket outside them is not
    /// an empty session: the prints simply do not reach it.
    pub covered_from: Option<i64>,
    pub covered_to: Option<i64>,
}

/// The letter for the `index`th bucket of a session: `A` to `Z`, then `a` to `z`, then
/// `A1`, `B1` and so on. A 24 hour session cut into 30 minute buckets needs 48 marks, so
/// one alphabet is not enough, and a bucket must never share a mark with its neighbour.
pub fn tpo_letter(index: i64) -> String {
    const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if index < 0 {
        return String::from("?");
    }
    let letter = UPPER[(index % 26) as usize] as char;
    match index {
        0..=25 => letter.to_string(),
        26..=51 => letter.to_lowercase().to_string(),
        // Past two alphabets the case alone is not enough to tell two buckets apart, so
        // the cycle number rides along: 52 is `A1`, 77 is `Z1`, 78 is `A2`.
        _ => format!("{letter}{}", (index - 52) / 26 + 1),
    }
}

/// The time grid a TPO answer is cut on. Sessions tile the timeline from a minute of the
/// UTC day, and every session is cut into the same buckets, so one bucket can never
/// straddle a session boundary and letters always restart where the session starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TpoGrid {
    pub bucket_minutes: i64,
    pub session_minutes: i64,
    pub session_start_minute: i64,
}

const MINUTE_MS: i64 = 60_000;
/// Minutes in a UTC day, which is what a session start is measured against.
const MINUTES_IN_DAY: i64 = 1_440;

impl TpoGrid {
    /// Accepts a grid only when the buckets divide the session exactly: a bucket that
    /// straddled a boundary would carry two sessions' letters, and a trader reading the
    /// letter would have no way to tell which one it meant.
    pub fn new(bucket_minutes: i64, session_minutes: i64, session_start_minute: i64) -> Option<Self> {
        // A session start is a minute of the UTC day, so 17:00 is a session and 1440 is not.
        if bucket_minutes < 1
            || session_minutes < bucket_minutes
            || session_start_minute < 0
            || session_start_minute >= MINUTES_IN_DAY
        {
            return None;
        }
        if session_minutes % bucket_minutes != 0 {
            return None;
        }
        Some(Self { bucket_minutes, session_minutes, session_start_minute })
    }

    pub fn bucket_ms(&self) -> i64 {
        self.bucket_minutes * MINUTE_MS
    }

    pub fn session_ms(&self) -> i64 {
        self.session_minutes * MINUTE_MS
    }

    /// Milliseconds past UTC midnight at which sessions begin. The store anchors its buckets
    /// here, which is what keeps a bucket inside one session.
    pub fn session_offset_ms(&self) -> i64 {
        self.session_start_minute * MINUTE_MS
    }

    /// Where the session containing `ts` begins.
    pub fn session_start(&self, ts: i64) -> i64 {
        let anchor = self.session_start_minute * MINUTE_MS;
        let session = self.session_ms();
        anchor + (ts - anchor).div_euclid(session) * session
    }

    /// Where the bucket containing `ts` begins. It always begins inside that bucket's
    /// session, because the buckets divide the session exactly.
    pub fn bucket_start(&self, ts: i64) -> i64 {
        let session = self.session_start(ts);
        let bucket = self.bucket_ms();
        session + (ts - session).div_euclid(bucket) * bucket
    }

    /// The mark this bucket carries, which is its position inside its own session.
    pub fn letter(&self, ts: i64) -> String {
        let session = self.session_start(ts);
        tpo_letter((self.bucket_start(ts) - session) / self.bucket_ms())
    }
}

/// Folds aggregated `(bucket, tick)` rows into the letter grid. The store hands over its
/// window at the venue's own tick resolution, one row at a time, because the point of control
/// and the value area are read off that grid exactly as the volume profile reads them.
///
/// Nothing here holds the window: the price rows are folded to `step_ticks` as they arrive, so
/// the builder carries the rows the answer will travel with plus one entry per traded tick per
/// session for the levels, and never one entry per traded `(bucket, tick)` pair. A wide window
/// costs a scan of itself, not a copy of itself.
#[derive(Debug)]
pub struct TpoBuilder {
    grid: TpoGrid,
    price_tick: f64,
    step_ticks: i64,
    /// bucket start -> display band -> what that bucket traded there
    buckets: BTreeMap<i64, BTreeMap<i64, TpoCell>>,
    /// session start -> venue tick -> (volume, buckets that traded here)
    levels: BTreeMap<i64, BTreeMap<i64, (f64, u32)>>,
}

impl TpoBuilder {
    pub fn new(grid: TpoGrid, price_tick: f64, step_ticks: i64) -> Self {
        Self {
            grid,
            price_tick,
            step_ticks: step_ticks.max(1),
            buckets: BTreeMap::new(),
            levels: BTreeMap::new(),
        }
    }

    /// Adds one aggregated cell. `bucket` is the bucket start the store computed for the
    /// print, from the same grid this builder was handed; a test pins the two together.
    pub fn on_cell(&mut self, bucket: i64, tick: i64, cell: &TpoCell) {
        if cell.prints() == 0 {
            return;
        }
        let row = self.buckets.entry(bucket).or_default().entry(tick.div_euclid(self.step_ticks)).or_default();
        row.buy_qty += cell.buy_qty;
        row.sell_qty += cell.sell_qty;
        row.buy_n += cell.buy_n;
        row.sell_n += cell.sell_n;
        // Levels stay on the venue's own grid, and belong to the session, so they do not move
        // when the caller trims the number of buckets it wants to travel.
        let level = self.levels.entry(self.grid.session_start(bucket)).or_default().entry(tick).or_default();
        level.0 += cell.total();
        level.1 += 1;
    }

    /// Seals the grid: buckets and sessions oldest first, letters by position inside a
    /// session, levels per session, and the oldest buckets dropped past `limit`. A bucket
    /// with no prints never appears, because the store has no row to answer for it.
    pub fn build(
        self,
        instrument: &str,
        from: Option<i64>,
        to: Option<i64>,
        value_area: f64,
        basis: ValueAreaBasis,
        limit: usize,
        now: i64,
    ) -> TpoSeries {
        let value_area = value_area.clamp(0.05, 1.0);
        let step = self.step_ticks;
        let grid = self.grid;
        let price_tick = self.price_tick;
        let mut sessions: BTreeMap<i64, OpenSession> = BTreeMap::new();
        let oldest = self.buckets.len().saturating_sub(limit);
        for (index, (bucket, cells)) in self.buckets.into_iter().enumerate() {
            if index < oldest {
                continue;
            }
            let session = sessions.entry(grid.session_start(bucket)).or_default();
            // The rows are already folded to the display width; one letter per band the bucket
            // traded in, whatever tick inside it printed.
            let mut rows: Vec<(f64, TpoCell)> = Vec::with_capacity(cells.len());
            for (band, cell) in cells {
                rows.push((crate::tick_price(band * step, price_tick), cell));
                let band = session.bands.entry(band).or_default();
                band.tpo_count += 1;
                band.prints += cell.prints();
                band.buy_qty += cell.buy_qty;
                band.sell_qty += cell.sell_qty;
            }
            let prints: u64 = rows.iter().map(|(_, cell)| cell.prints()).sum();
            let total_qty: f64 = rows.iter().map(|(_, cell)| cell.total()).sum();
            let poc = rows.iter().max_by(|a, b| a.1.total().total_cmp(&b.1.total())).map(|(price, _)| *price);
            let letter = grid.letter(bucket);
            session.buckets.push(TpoBucket { start: bucket, letter, rows, prints, total_qty, poc });
        }
        // A session the trim dropped entirely leaves no trace; one that survives carries its
        // levels from the whole window, because a session's point of control is a property of
        // the session and not of how many buckets the caller asked for.
        for (start, levels) in self.levels {
            if let Some(session) = sessions.get_mut(&start) {
                session.levels = levels;
            }
        }

        let sessions: Vec<TpoSession> = sessions
            .into_iter()
            .map(|(start, open)| open.seal(start, grid, step, price_tick, value_area, basis, now))
            .collect();
        let prints: u64 = sessions.iter().map(|session| session.prints).sum();
        let total_qty: f64 = sessions.iter().map(|session| session.total_qty).sum();
        let covered_from = sessions.iter().find_map(|session| session.buckets.first()).map(|bucket| bucket.start);
        let covered_to = sessions.iter().rev().find_map(|session| session.buckets.last()).map(|bucket| bucket.start);
        TpoSeries {
            instrument: instrument.to_string(),
            from,
            to,
            price_tick,
            step_ticks: step,
            bucket_minutes: grid.bucket_minutes,
            session_minutes: grid.session_minutes,
            session_start_minute: grid.session_start_minute,
            bucket_rule: format!("{} minute buckets, letters restarting at each session", grid.bucket_minutes),
            session_rule: format!(
                "{} minute sessions from minute {} of the UTC day",
                grid.session_minutes, grid.session_start_minute
            ),
            value_area_rule: format!(
                "value area {:.0}% of {}",
                value_area * 100.0,
                match basis {
                    ValueAreaBasis::Volume => "traded volume",
                    ValueAreaBasis::Tpo => "letters in the grid",
                }
            ),
            sessions,
            prints,
            total_qty,
            covered_from,
            covered_to,
        }
    }
}

/// One session while the grid is being sealed.
#[derive(Debug, Default)]
struct OpenSession {
    /// venue tick -> (volume, buckets that traded here): the grid the levels come off
    levels: BTreeMap<i64, (f64, u32)>,
    /// display band -> what the session traded there, and how many letters sit in it
    bands: BTreeMap<i64, TpoRow>,
    buckets: Vec<TpoBucket>,
}

impl OpenSession {
    fn seal(
        self,
        start: i64,
        grid: TpoGrid,
        step_ticks: i64,
        price_tick: f64,
        value_area: f64,
        basis: ValueAreaBasis,
        now: i64,
    ) -> TpoSession {
        // Levels come off the venue's own tick grid, whatever width the rows below fold to:
        // the same walk, on the same resolution, as the volume profile's.
        let weights: Vec<(f64, f64)> = self
            .levels
            .iter()
            .map(|(tick, (qty, buckets))| {
                (
                    crate::tick_price(*tick, price_tick),
                    match basis {
                        ValueAreaBasis::Volume => *qty,
                        ValueAreaBasis::Tpo => *buckets as f64,
                    },
                )
            })
            .collect();
        let total: f64 = weights.iter().map(|(_, weight)| *weight).sum();
        let (poc, vah, val) = value_area_levels(&weights, total, value_area);
        let rows: Vec<TpoRow> = self
            .bands
            .into_iter()
            .map(|(band, row)| TpoRow {
                price: crate::tick_price(band * step_ticks, price_tick),
                total_qty: row.buy_qty + row.sell_qty,
                ..row
            })
            .collect();
        let prints: u64 = self.buckets.iter().map(|bucket| bucket.prints).sum();
        let total_qty: f64 = self.buckets.iter().map(|bucket| bucket.total_qty).sum();
        let letters = self.buckets.iter().map(|bucket| bucket.letter.as_str()).collect::<String>();
        TpoSession {
            start,
            end: start + grid.session_ms(),
            letters,
            buckets: self.buckets,
            rows,
            poc,
            vah,
            val,
            value_area,
            value_area_basis: basis,
            prints,
            total_qty,
            developing: now >= start && now < start + grid.session_ms(),
        }
    }
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

    /// Adds volume already aggregated at one venue tick. The store folds its window
    /// aggregation in SQL, and this is how those rows reach the same value-area walk the
    /// streamed prints do, so a profile built from rows answers like one built live.
    pub fn on_tick(&mut self, tick: i64, buy_qty: f64, sell_qty: f64) {
        let entry = self.buckets.entry(tick).or_default();
        entry.0 += buy_qty;
        entry.1 += sell_qty;
        self.total_qty += buy_qty + sell_qty;
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
    value_area_levels(&rows, total_qty, fraction)
}

/// The value-area walk itself, over ascending `(price, weight)` rows. The volume profile
/// weights a row by the quantity traded at it; the TPO grid may weight it by how many time
/// buckets traded there. Both read their levels off this one walk, so the two order-flow
/// panes cannot put a value-area edge on different prices for the same window.
///
/// `total` is the weight the fraction applies to and is passed in rather than summed out of
/// `rows`, because a caller that folds rows for transport still wants the fraction of the
/// whole window, not of the rows it kept.
pub fn value_area_levels(
    rows: &[(f64, f64)],
    total: f64,
    fraction: f64,
) -> (Option<f64>, Option<f64>, Option<f64>) {
    let Some(pivot) = rows.iter().enumerate().max_by(|a, b| a.1.1.total_cmp(&b.1.1)).map(|(i, _)| i) else {
        return (None, None, None);
    };
    let target = total * fraction;
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

    // ------------------------------------------------------------------ TPO grid

    const MINUTE: i64 = 60_000;
    const HOUR_MS: i64 = 3_600_000;
    const DAY: i64 = 86_400_000;

    #[test]
    fn letters_run_up_the_alphabets_and_never_repeat_inside_a_session() {
        assert_eq!(tpo_letter(0), "A");
        assert_eq!(tpo_letter(1), "B");
        assert_eq!(tpo_letter(25), "Z");
        // A 24 hour session cut into 30 minute buckets needs 48 marks, so the second
        // alphabet has to be readable as a different bucket from the first.
        assert_eq!(tpo_letter(26), "a");
        assert_eq!(tpo_letter(47), "v");
        assert_eq!(tpo_letter(51), "z");
        assert_eq!(tpo_letter(52), "A1", "the third cycle carries its cycle number");
        assert_eq!(tpo_letter(77), "Z1");
        assert_eq!(tpo_letter(78), "A2");
        let marks: std::collections::BTreeSet<String> = (0..200).map(tpo_letter).collect();
        assert_eq!(marks.len(), 200, "no two buckets may share a mark");
    }

    #[test]
    fn buckets_restart_at_the_session_boundary() {
        let daily = TpoGrid::new(30, 1_440, 0).expect("daily grid");
        assert_eq!(daily.letter(0), "A", "the first bucket of a session is A");
        assert_eq!(daily.letter(30 * MINUTE), "B");
        assert_eq!(daily.letter(DAY - 30 * MINUTE), "v", "the 48th bucket of the day");
        assert_eq!(daily.letter(DAY), "A", "the next session starts its letters again");
        assert_eq!(daily.bucket_start(95 * MINUTE), 90 * MINUTE, "a bucket floor is the bucket start");
        assert_eq!(daily.session_start(95 * MINUTE), 0);
        assert_eq!(daily.session_start(DAY + 1), DAY, "sessions tile the day");

        // A session that does not begin at midnight: the boundary moves, and so do the
        // letters, which is the whole point of making the start configurable.
        let shifted = TpoGrid::new(60, 1_440, 17 * 60).expect("17:00 UTC sessions");
        assert_eq!(shifted.session_start(18 * MINUTE), -7 * HOUR_MS, "before the first start is the session before");
        assert_eq!(shifted.letter(17 * HOUR_MS), "A");
        assert_eq!(shifted.letter(18 * HOUR_MS), "B");
        assert_eq!(shifted.letter(17 * HOUR_MS - MINUTE), "X", "one minute before the boundary is the previous session");
    }

    #[test]
    fn a_bucket_that_straddles_a_session_is_refused_not_quietly_misaligned() {
        // 7 minute buckets cannot divide a 24 hour session, so a bucket would carry prints
        // from two sessions and its letter would mean two different things.
        assert_eq!(TpoGrid::new(7, 1_440, 0), None);
        assert_eq!(TpoGrid::new(0, 1_440, 0), None);
        assert_eq!(TpoGrid::new(30, 1_440, -1), None);
        assert_eq!(TpoGrid::new(30, 15, 0), None, "a session shorter than one bucket");
        assert!(TpoGrid::new(240, 1_440, 0).is_some(), "a session of six buckets is fine");
    }

    #[test]
    fn the_letter_grid_answers_the_same_levels_as_the_volume_profile() {
        // The check the pane rests on: two views of the same prints cannot put the point of
        // control or the value area on different prices.
        let prices: Vec<f64> = (0..400).map(|i| 1_000.0 + i as f64 * 0.5).collect();
        let mut profile = VolumeProfileBuilder::with_step(0.5, 20);
        let mut tpo = TpoBuilder::new(TpoGrid::new(30, 1_440, 0).expect("grid"), 0.5, 20);
        for (index, price) in prices.iter().enumerate() {
            let qty = if *price == 1_100.5 { 50.0 } else { 1.0 + (index % 3) as f64 };
            let side = if index % 2 == 0 { Side::Buy } else { Side::Sell };
            let print = trade((index as i64) * MINUTE, *price, qty, side);
            profile.on_trade(&print);
            let cell = TpoCell {
                buy_qty: if side == Side::Buy { qty } else { 0.0 },
                sell_qty: if side == Side::Sell { qty } else { 0.0 },
                buy_n: u64::from(side == Side::Buy),
                sell_n: u64::from(side == Side::Sell),
            };
            tpo.on_cell(0, crate::tick_index(*price, 0.5), &cell);
        }
        let profile = profile.build("TEST:AAA", 0.7);
        let grid = tpo.build("TEST:AAA", None, None, 0.7, ValueAreaBasis::Volume, 400, DAY / 2);

        assert_eq!(grid.sessions.len(), 1, "one window inside one day is one session");
        let session = grid.sessions.first().expect("one session");
        assert_eq!(session.poc, profile.poc, "the point of control is one number, not two");
        assert_eq!((session.vah, session.val), (profile.vah, profile.val), "nor are the value-area edges");
        assert!((session.total_qty - profile.total_qty).abs() < 1e-9, "and the session holds the same volume");
    }

    #[test]
    fn every_print_lands_in_one_cell_of_one_bucket() {
        let grid = TpoGrid::new(30, 1_440, 0).expect("grid");
        let mut builder = TpoBuilder::new(grid, 0.01, 1);
        // 41 minutes apart, so the prints land in different buckets and cross a day edge.
        let prints: Vec<Trade> = (0..60i64)
            .map(|i| trade(i * 41 * MINUTE, 100.0 + (i % 5) as f64, 1.0 + i as f64, if i % 2 == 0 { Side::Buy } else { Side::Sell }))
            .collect();
        for print in &prints {
            let cell = TpoCell {
                buy_qty: if print.aggressor == Side::Buy { print.qty } else { 0.0 },
                sell_qty: if print.aggressor == Side::Sell { print.qty } else { 0.0 },
                buy_n: u64::from(print.aggressor == Side::Buy),
                sell_n: u64::from(print.aggressor == Side::Sell),
            };
            builder.on_cell(grid.bucket_start(print.ts), crate::tick_index(print.price, 0.01), &cell);
        }
        let series = builder.build("TEST:AAA", None, None, 0.7, ValueAreaBasis::Volume, 400, 0);

        let want_prints: u64 = prints.len() as u64;
        let want_qty: f64 = prints.iter().map(|print| print.qty).sum();
        assert_eq!(series.prints, want_prints, "a print counted twice or lost moves the count");
        assert!((series.total_qty - want_qty).abs() < 1e-9, "same for the volume");
        // 60 prints 41 minutes apart cross one UTC day edge, so the answer is two profiles.
        assert_eq!(series.sessions.len(), 2, "the window straddles two UTC days");
        for session in &series.sessions {
            let letters: Vec<String> = session.buckets.iter().map(|b| b.letter.clone()).collect();
            assert_eq!(letters.iter().collect::<std::collections::BTreeSet<_>>().len(), letters.len(), "no bucket shares a letter");
            for bucket in &session.buckets {
                assert_eq!(bucket.letter, grid.letter(bucket.start), "the letter is the bucket's place in its own session");
            }
        }
        assert_eq!(series.sessions.iter().map(|s| s.buckets.len()).sum::<usize>(), 60, "every print found its own bucket");
        // Each session's row counts add up to the letters it handed out.
        for session in &series.sessions {
            let cells: u32 = session.rows.iter().map(|row| row.tpo_count).sum();
            assert_eq!(cells as usize, session.buckets.iter().map(|b| b.rows.len()).sum::<usize>());
            assert_eq!(session.rows.iter().map(|row| row.prints).sum::<u64>(), session.prints);
        }
    }

    #[test]
    fn a_grid_cut_on_letters_counts_letters_and_the_profile_counts_volume() {
        // Three buckets trade one price, and one bucket alone trades another. The volume
        // basis follows the money; the letter basis follows the clock, and says so.
        let mut builder = TpoBuilder::new(TpoGrid::new(30, 1_440, 0).expect("grid"), 1.0, 1);
        let heavy = TpoCell { buy_qty: 900.0, sell_qty: 0.0, buy_n: 1, sell_n: 0 };
        let light = TpoCell { buy_qty: 1.0, sell_qty: 0.0, buy_n: 1, sell_n: 0 };
        builder.on_cell(0, 100, &heavy);
        for bucket in [30 * MINUTE, 60 * MINUTE, 90 * MINUTE] {
            builder.on_cell(bucket, 101, &light);
        }
        let by_volume = builder.build("TEST:AAA", None, None, 0.7, ValueAreaBasis::Volume, 400, 0);
        assert_eq!(by_volume.sessions.len(), 1);
        let session = by_volume.sessions.first().expect("one session");
        assert_eq!(session.poc, Some(100.0), "the busiest volume row is the point of control");
        assert!(by_volume.value_area_rule.contains("traded volume"), "{}", by_volume.value_area_rule);

        let mut builder = TpoBuilder::new(TpoGrid::new(30, 1_440, 0).expect("grid"), 1.0, 1);
        builder.on_cell(0, 100, &heavy);
        for bucket in [30 * MINUTE, 60 * MINUTE, 90 * MINUTE] {
            builder.on_cell(bucket, 101, &light);
        }
        let by_letters = builder.build("TEST:AAA", None, None, 0.7, ValueAreaBasis::Tpo, 400, 0);
        assert_eq!(by_letters.sessions.len(), 1);
        let session = by_letters.sessions.first().expect("one session");
        assert_eq!(session.poc, Some(101.0), "three letters beat one, whatever the volume");
        assert!(by_letters.value_area_rule.contains("letters in the grid"), "{}", by_letters.value_area_rule);
        // The count beside each row is the letter distribution the trader reads.
        let row = session.rows.iter().find(|row| row.price == 101.0).expect("row");
        assert_eq!(row.tpo_count, 3);
        assert_eq!(session.letters, "ABCD");
    }

    #[test]
    fn a_window_that_straddles_sessions_answers_one_block_per_session() {
        let grid = TpoGrid::new(60, 1_440, 0).expect("hourly buckets, daily sessions");
        let mut builder = TpoBuilder::new(grid, 1.0, 1);
        for index in 0..50i64 {
            builder.on_cell(index * HOUR_MS, 100, &TpoCell { buy_qty: 1.0, sell_qty: 0.0, buy_n: 1, sell_n: 0 });
        }
        let series = builder.build("TEST:AAA", Some(0), Some(50 * HOUR_MS), 0.7, ValueAreaBasis::Volume, 400, 49 * HOUR_MS);
        assert_eq!(series.sessions.len(), 3, "50 hourly buckets reach into a third UTC day");
        let (first, last) = (&series.sessions[0], &series.sessions[2]);
        assert_eq!(first.buckets.len(), 24, "a full day of hourly buckets");
        assert_eq!(first.letters, "ABCDEFGHIJKLMNOPQRSTUVWX", "one letter per bucket, in order");
        assert_eq!(last.buckets.len(), 2, "the session the newest print is in holds two buckets");
        assert_eq!(last.buckets[0].letter, "A", "and its letters start again");
        assert!(last.developing, "the live session says so");
        assert!(!first.developing);
        assert_eq!(series.sessions.iter().map(|s| s.buckets.len()).sum::<usize>(), 50);
        assert_eq!((series.covered_from, series.covered_to), (Some(0), Some(49 * HOUR_MS)));
    }

    #[test]
    fn a_bucket_the_store_returned_nothing_for_is_absent_rather_than_empty() {
        let grid = TpoGrid::new(30, 1_440, 0).expect("grid");
        let mut builder = TpoBuilder::new(grid, 1.0, 1);
        builder.on_cell(0, 100, &TpoCell { buy_qty: 1.0, sell_qty: 0.0, buy_n: 1, sell_n: 0 });
        builder.on_cell(90 * MINUTE, 100, &TpoCell::default());
        let series = builder.build("TEST:AAA", Some(0), Some(DAY), 0.7, ValueAreaBasis::Volume, 400, DAY / 2);
        assert_eq!(series.sessions.len(), 1);
        let session = series.sessions.first().expect("one session");
        assert_eq!(session.buckets.len(), 1, "an empty bucket has no letter to draw");
        assert_eq!(session.buckets[0].letter, "A");
        assert_eq!(
            session.buckets.iter().map(|b| b.start).collect::<Vec<_>>(),
            vec![0],
            "and the gap where the missing prints were stays visible as a gap"
        );
    }
}
