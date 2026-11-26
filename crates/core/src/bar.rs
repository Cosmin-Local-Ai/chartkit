use crate::timeframe::Timeframe;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bar {
    /// Bar open time, epoch milliseconds, aligned to the timeframe boundary in UTC.
    pub start: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub trades: u64,
    /// False while the bar is still receiving prints.
    pub closed: bool,
}

impl Bar {
    fn fresh(start: i64, price: f64, qty: f64) -> Self {
        Self {
            start,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: qty,
            trades: 1,
            closed: false,
        }
    }

    fn extend(&mut self, price: f64, qty: f64) {
        self.high = self.high.max(price);
        self.low = self.low.min(price);
        self.close = price;
        self.volume += qty;
        self.trades += 1;
    }
}

/// Folds a time-ordered trade stream into bars. Bars are emitted when the next
/// print crosses the boundary, so callers always see completed bars plus the live one.
pub struct BarAggregator {
    timeframe: Timeframe,
    current: Option<Bar>,
}

impl BarAggregator {
    pub fn new(timeframe: Timeframe) -> Self {
        Self { timeframe, current: None }
    }

    /// Feed one print. Returns the bar that just closed, if any.
    pub fn on_trade(&mut self, ts: i64, price: f64, qty: f64) -> Option<Bar> {
        let start = self.timeframe.align(ts);
        let closed = match self.current.as_mut() {
            None => None,
            Some(bar) if bar.start == start => {
                bar.extend(price, qty);
                return None;
            }
            Some(bar) => {
                let mut done = *bar;
                done.closed = true;
                Some(done)
            }
        };
        self.current = Some(Bar::fresh(start, price, qty));
        closed
    }

    /// The partially built bar, if any.
    pub fn live(&self) -> Option<Bar> {
        self.current.as_ref().filter(|bar| bar.trades > 0).copied()
    }

    pub fn seal(&mut self) -> Option<Bar> {
        self.current.take().map(|mut b| {
            b.closed = true;
            b
        })
    }
}
