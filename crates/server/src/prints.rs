//! Prints the live stream never saw: the venue's own aggregate-trade history, pulled
//! over REST into the same table the socket writes.
//!
//! Prints only exist for the time a server was running, so a chart panned into older
//! history has bars but no footprint, no CVD and an empty profile. A backfill closes
//! that gap. Each row keeps the venue trade id of the first print inside the aggregate,
//! which is the id the spot `@trade` stream publishes too, so a backfilled print and a
//! live print of the same trade share one primary key and neither can duplicate.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chartkit_core::instrument::VenueTag;
use chartkit_core::{now_ms, Instrument, Trade, Venue};
use chartkit_ingest::{AggTrade, AggTradePage, BinanceFeed, IngestError};
use chartkit_store::{BackfillPage, Db, PrintCoverage, PrintSpan};
use tokio::sync::Mutex as AsyncMutex;

/// Rows fetched per request; the venue's own maximum for `aggTrades`.
pub const PAGE_SIZE: u32 = 1_000;
/// Request weight one `aggTrades` call costs, independent of `limit`.
pub const PAGE_WEIGHT: i64 = 4;
/// Share of the venue's 6000-weight-per-minute IP budget backfill may spend. The rest
/// is left for candle backfill and reconnects, which share the same address.
pub const WEIGHT_BUDGET_PER_MIN: i64 = 2_400;
/// Pause between pages implied by the budget: 2400 weight / 4 = 600 pages a minute.
pub const PAGE_SLEEP_MS: u64 = 60_000 / (WEIGHT_BUDGET_PER_MIN / PAGE_WEIGHT) as u64;
/// Venue-reported IP weight at or above which a job waits for the next minute window.
pub const WEIGHT_PAUSE_ABOVE: i64 = 4_500;
/// How far behind the newest stored print the startup pass reaches.
pub const BOOT_LOOKBACK_MS: i64 = 24 * 3_600_000;
/// Oldest prints a request may ask for, however far back the venue could serve them.
pub const MAX_LOOKBACK_MS: i64 = 30 * 86_400_000;
/// Wall clock one job may spend. It stops and the next request resumes by trade id,
/// so a wide window fills across several requests instead of blocking on one.
pub const JOB_MAX_DURATION: Duration = Duration::from_secs(900);
/// A claim nobody renewed for this long belongs to a process that is gone.
pub const JOB_CLAIM_LEASE_MS: i64 = 120_000;
/// How long a handler waits for a backfill it started before answering with whatever
/// is stored. A visible pan stays interactive at this cost.
pub const REQUEST_WAIT: Duration = Duration::from_secs(8);
/// Holes one job fills, oldest first. The rest wait for the next request, which keeps a
/// pan across a broken history from turning into an unbounded download.
pub const HOLES_PER_JOB: usize = 8;
/// How often a waiting handler re-reads coverage while a job runs.
pub const REQUEST_POLL: Duration = Duration::from_millis(400);
/// A stored range counts as reaching a window edge within this slack.
pub const COVERAGE_SLACK_MS: i64 = 1_000;
/// While the newest stored print is this fresh the stream is treated as current: any
/// newer print is either arriving now or not traded yet. Older than this, the store has
/// a hole at its own edge and the prints past it count as missing.
pub const LIVE_EDGE_MS: i64 = 60_000;
const MINUTE_MS: i64 = 60_000;

/// One job can fail on the venue or in the store; both end it the same way.
type JobResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Starts and supervises print backfills. Cheap to clone: every copy shares the store,
/// the HTTP client and the single in-flight-page gate.
#[derive(Clone)]
pub struct PrintBackfill {
    db: Arc<Db>,
    rest: BinanceFeed,
    /// Instruments with a job running in this process.
    running: Arc<Mutex<HashSet<String>>>,
    /// One REST page in flight per process, so backfill cannot out-spend the candle
    /// backfill or a reconnecting feed on the shared request-weight budget.
    page_gate: Arc<AsyncMutex<()>>,
}

impl PrintBackfill {
    pub fn new(db: Arc<Db>, rest: BinanceFeed) -> Self {
        Self { db, rest, running: Arc::new(Mutex::new(HashSet::new())), page_gate: Arc::new(AsyncMutex::new(())) }
    }

    /// Fills the window behind the live stream for each symbol at startup, so the
    /// history the UI can pan to is already there rather than one pan away.
    pub fn boot_pass(&self, symbols: &[String]) {
        let to = now_ms();
        let from = to - BOOT_LOOKBACK_MS;
        for symbol in symbols {
            let id = format!("{}:{}", Venue::Binance.tag(), symbol);
            match self.db.instrument(&id) {
                Ok(Some(instrument)) => self.request(&instrument, from, to),
                Ok(None) => tracing::debug!("instrument {id} not stored yet, prints stay live-only"),
                Err(error) => tracing::warn!("print backfill lookup {id} failed: {error}"),
            }
        }
    }

    /// Starts a bounded backfill of `from..to` when stored prints do not already
    /// answer it. Never blocks: pages keep arriving after the caller answers.
    pub fn request(&self, instrument: &Instrument, from: i64, to: i64) {
        let Some(symbol) = venue_symbol(instrument) else { return };
        let from = from.max(now_ms() - MAX_LOOKBACK_MS);
        if from >= to {
            return;
        }
        let coverage = match self.db.print_coverage(&instrument.id) {
            Ok(coverage) => coverage,
            Err(error) => {
                tracing::warn!("print coverage unreadable for {}: {error}", instrument.id);
                return;
            }
        };
        if covers(&coverage, from, to) {
            return;
        }
        let id = instrument.id.clone();
        let now = now_ms();
        // The claim doubles as the merge point: a window asked for while a job runs
        // widens that job instead of starting a second download of the same range.
        let claimed = self
            .db
            .claim_print_backfill(&id, from, to, now, now - JOB_CLAIM_LEASE_MS);
        let (job_from, job_to) = match claimed {
            Ok(Some(window)) if !self.is_running(&id) => window,
            Ok(_) => return,
            Err(error) => {
                tracing::warn!("print backfill claim for {id} failed: {error}");
                return;
            }
        };
        self.mark_running(&id);
        let worker = self.clone();
        let symbol = symbol.to_string();
        tokio::spawn(async move {
            if let Err(error) = worker.run_job(&id, &symbol, job_from, job_to).await {
                tracing::warn!("print backfill {id} stopped: {error}");
            }
            worker.release_running(&id);
        });
    }

    /// `request`, then wait up to `REQUEST_WAIT` for the window to fill. A pan into a
    /// window with no prints gets rows on the first try instead of an empty pane that
    /// only fills on the next pan.
    pub async fn request_covering(&self, instrument: &Instrument, from: i64, to: i64) {
        self.request(instrument, from, to);
        if !self.is_running(&instrument.id) {
            return;
        }
        let deadline = tokio::time::Instant::now() + REQUEST_WAIT;
        loop {
            tokio::time::sleep(REQUEST_POLL).await;
            let Ok(coverage) = self.db.print_coverage(&instrument.id) else { return };
            let busy = tokio::time::Instant::now() < deadline && self.is_running(&instrument.id);
            if covers(&coverage, from, to) || !busy {
                return;
            }
        }
    }

    async fn run_job(&self, instrument: &str, symbol: &str, from: i64, to: i64) -> JobResult<()> {
        let outcome = self.pull(instrument, symbol, from, to).await;
        if let Err(error) = self.db.finish_print_backfill(instrument, now_ms()) {
            tracing::warn!("print coverage not released for {instrument}: {error}");
        }
        outcome
    }

    /// Fills the holes the window is missing, oldest first. Each hole is entered by time
    /// and then walked forward by aggregate id, so a page never repeats a print the store
    /// already has and no gap can be stepped over.
    async fn pull(&self, instrument: &str, symbol: &str, from: i64, to: i64) -> JobResult<()> {
        let started = tokio::time::Instant::now();
        let coverage = self.db.print_coverage(instrument)?;
        if coverage.venue_oldest_ts.is_none() {
            if let Some(oldest) = self.rest.oldest_agg_trade(symbol).await? {
                self.db.note_venue_print_floor(instrument, oldest.ts, now_ms())?;
                tracing::info!("{instrument} venue prints start at {}", oldest.ts);
            }
        }

        let holes = uncovered(&coverage.spans, from, fetch_edge(&coverage, to));
        if holes.is_empty() {
            return Ok(());
        }
        tracing::info!(
            "{instrument} print backfill fills {} missing range(s), first at {}",
            holes.len(),
            holes[0].0
        );
        let mut stored = 0usize;
        for (hole_from, hole_to) in holes.into_iter().take(HOLES_PER_JOB) {
            let mut next_id: Option<u64> = None;
            let mut start_ts = hole_from;
            loop {
                if started.elapsed() > JOB_MAX_DURATION {
                    tracing::info!("{instrument} print backfill paused after {stored} prints; next request resumes");
                    return Ok(());
                }
                let page = self.fetch_page(symbol, next_id, start_ts).await?;
                self.db.heartbeat_print_backfill(instrument, now_ms())?;
                let (Some(first), Some(last)) = (page.trades.first(), page.trades.last()) else {
                    // The venue answered with nothing at or after this point, which proves
                    // the rest of the range empty rather than merely unfetched.
                    self.db.record_backfill_page(instrument, &BackfillPage {
                        span: Some((start_ts, hole_to)),
                        ..Default::default()
                    })?;
                    break;
                };
                // Paging by id continues a range the store already opened. Paging by time
                // starts at the hole's edge, which the answer proves is answered even where
                // the tape is quiet, so the recorded range reaches back to it.
                let span_from = if next_id.is_some() { first.ts } else { start_ts };
                let kept: Vec<Trade> = page
                    .trades
                    .iter()
                    .take_while(|agg| agg.ts < hole_to)
                    .map(print_from_agg)
                    .collect();
                stored += self.db.record_backfill_page(instrument, &BackfillPage {
                    trades: kept,
                    span: Some((span_from, last.ts.min(hole_to))),
                    agg_ids: Some((first.id, last.id)),
                })?;
                if last.ts >= hole_to {
                    break;
                }
                next_id = Some(last.id + 1);
                start_ts = last.ts;
                wait_between_pages(page.used_weight).await;
            }
        }
        tracing::debug!("{instrument} print backfill stored {stored} prints");
        Ok(())
    }

    async fn fetch_page(
        &self,
        symbol: &str,
        from_id: Option<u64>,
        start_ts: i64,
    ) -> Result<AggTradePage, IngestError> {
        let _gate = self.page_gate.lock().await;
        match from_id {
            Some(id) => self.rest.agg_trades_from_id(symbol, id, PAGE_SIZE).await,
            None => self.rest.agg_trades_after(symbol, start_ts, PAGE_SIZE).await,
        }
    }

    fn is_running(&self, instrument: &str) -> bool {
        self.running.lock().is_ok_and(|running| running.contains(instrument))
    }

    fn mark_running(&self, instrument: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.insert(instrument.to_string());
        }
    }

    fn release_running(&self, instrument: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(instrument);
        }
    }
}

/// The symbol a history request takes, or None for a venue with no paged trade history.
fn venue_symbol(instrument: &Instrument) -> Option<&str> {
    (instrument.venue == Venue::Binance).then_some(instrument.symbol.as_str())
}

fn print_from_agg(agg: &AggTrade) -> Trade {
    Trade {
        ts: agg.ts,
        seq: agg.first_trade_id,
        price: agg.price,
        qty: agg.qty,
        aggressor: agg.aggressor,
    }
}

/// Ranges inside `from..to` that no stored range covers, oldest first. A job downloads
/// exactly these, so a restart starts at the edge of what is already stored instead of
/// re-reading the window, and a hole left between two streaming sessions gets filled.
fn uncovered(spans: &[PrintSpan], from: i64, to: i64) -> Vec<(i64, i64)> {
    let mut holes = Vec::new();
    let mut cursor = from;
    for span in spans {
        if span.to <= cursor {
            continue;
        }
        if span.from >= to {
            break;
        }
        if span.from > cursor {
            holes.push((cursor, span.from.min(to)));
        }
        cursor = cursor.max(span.to);
        if cursor >= to {
            break;
        }
    }
    if cursor < to {
        holes.push((cursor, to));
    }
    holes
}

/// True when stored prints already answer `from..to`, or the venue has nothing there
/// to fetch, so starting a download would be wasted work.
fn covers(coverage: &PrintCoverage, from: i64, to: i64) -> bool {
    // The venue's own history starts at `venue_oldest_ts`; older is not a hole.
    if coverage.venue_oldest_ts.is_some_and(|oldest| to <= oldest + COVERAGE_SLACK_MS) {
        return true;
    }
    // A window at or past the newest stored print is the live stream's own job.
    let newest = [coverage.live_to, coverage.backfill_to].into_iter().flatten().max();
    if newest.is_some_and(|newest| from >= newest - COVERAGE_SLACK_MS) {
        return true;
    }
    // Same test the job uses: nothing left to download means nothing to ask for.
    uncovered(&coverage.spans, from, fetch_edge(coverage, to)).is_empty()
}

/// The newest time a download can answer for. A live tape is never quite caught up with
/// `now`, and nothing newer than its newest print is traded yet, so a current stream
/// bounds the window. Once the stream stalls, its last print is a hole instead of an edge.
fn fetch_edge(coverage: &PrintCoverage, to: i64) -> i64 {
    let newest = [coverage.live_to, coverage.backfill_to].into_iter().flatten().max();
    if stream_is_current(coverage) {
        newest.map_or(to, |newest| to.min(newest))
    } else {
        to
    }
}

/// True while the newest stored print is recent enough that the gap past it belongs to
/// the stream rather than to the store.
fn stream_is_current(coverage: &PrintCoverage) -> bool {
    [coverage.live_to, coverage.backfill_to]
        .into_iter()
        .flatten()
        .max()
        .is_some_and(|newest| now_ms() - newest <= LIVE_EDGE_MS)
}

/// Sleeps out the remainder of the venue's minute window when the reported IP weight
/// is close to the cap, and the budget-sized pause otherwise.
async fn wait_between_pages(used_weight: Option<i64>) {
    if used_weight.is_some_and(|used| used >= WEIGHT_PAUSE_ABOVE) {
        let rest_of_minute = MINUTE_MS - now_ms().rem_euclid(MINUTE_MS);
        tracing::debug!("venue request weight {used_weight:?} near the cap, waiting {rest_of_minute}ms");
        tokio::time::sleep(Duration::from_millis(rest_of_minute as u64)).await;
    } else {
        tokio::time::sleep(Duration::from_millis(PAGE_SLEEP_MS)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Coverage over the given filled ranges, with the aggregate-id frontier a
    /// backfill would have left behind at the first range.
    fn stored(spans: &[(i64, i64)]) -> PrintCoverage {
        let mut coverage = PrintCoverage {
            instrument: "BINANCE:BTCUSDT".into(),
            live_from: spans.iter().map(|(from, _)| *from).min(),
            live_to: spans.iter().map(|(_, to)| *to).max(),
            live_min_seq: Some(100),
            live_max_seq: Some(900),
            backfill_from: None,
            backfill_to: None,
            backfill_min_id: None,
            backfill_max_id: None,
            spans: spans.iter().map(|(from, to)| PrintSpan { from: *from, to: *to }).collect(),
            venue_oldest_ts: None,
            job_from: None,
            job_to: None,
            job_claim_at: None,
            updated_at: 0,
            status: String::new(),
        };
        if let Some((first, _)) = spans.first() {
            coverage.backfill_from = Some(*first);
            coverage.backfill_to = spans.first().map(|(_, to)| *to);
            coverage.backfill_min_id = Some(10);
            coverage.backfill_max_id = Some(20);
        }
        coverage
    }

    const MINUTE: i64 = 60_000;
    const HOUR: i64 = 3_600_000;

    #[test]
    fn a_window_inside_a_stored_range_needs_no_download() {
        assert!(covers(&stored(&[(0, HOUR)]), 0, HOUR));
        assert!(covers(&stored(&[(0, HOUR)]), HOUR - 60_000, HOUR));
    }

    #[test]
    fn a_window_older_than_any_range_needs_one() {
        assert!(!covers(&stored(&[(0, HOUR)]), -HOUR, -60_000));
    }

    #[test]
    fn a_window_straddling_two_ranges_has_a_hole_in_it() {
        // Sessions apart by more than the merge gap stay separate ranges on purpose.
        assert!(!covers(&stored(&[(0, HOUR), (5 * HOUR, 6 * HOUR)]), HOUR, 5 * HOUR));
        assert!(covers(&stored(&[(0, HOUR), (5 * HOUR, 6 * HOUR)]), 5 * HOUR, 6 * HOUR));
    }

    #[test]
    fn nothing_stored_at_all_always_asks() {
        assert!(!covers(&stored(&[]), 0, HOUR));
    }

    #[test]
    fn windows_older_than_the_venue_are_not_re_asked() {
        let mut coverage = stored(&[(10 * HOUR, 11 * HOUR)]);
        coverage.venue_oldest_ts = Some(5 * HOUR);
        assert!(covers(&coverage, 0, 4 * HOUR), "the venue has nothing before its own start");
        assert!(!covers(&coverage, 6 * HOUR, 9 * HOUR));
    }

    #[test]
    fn a_window_past_the_newest_print_is_left_to_the_stream() {
        let mut coverage = stored(&[(0, HOUR)]);
        coverage.venue_oldest_ts = Some(-100 * HOUR);
        assert!(covers(&coverage, HOUR, 2 * HOUR));
    }

    #[test]
    fn a_window_ending_at_now_is_covered_up_to_the_live_edge() {
        // The startup pass asks for a window ending at `now`. A live tape's newest print
        // is always a moment older, and that moment is not a hole to download.
        let now = now_ms();
        assert!(covers(&stored(&[(now - 2 * HOUR, now - 20_000)]), now - 2 * HOUR, now));
    }

    #[test]
    fn prints_missing_after_a_stalled_stream_stay_a_hole() {
        let now = now_ms();
        let stalled = now - 10 * MINUTE;
        assert!(
            !covers(&stored(&[(now - 2 * HOUR, stalled)]), now - HOUR, now),
            "the stream stopped, so prints between its last one and now are really missing"
        );
    }

    fn spans(rows: &[(i64, i64)]) -> Vec<PrintSpan> {
        rows.iter().map(|(from, to)| PrintSpan { from: *from, to: *to }).collect()
    }

    #[test]
    fn a_job_downloads_only_what_is_missing() {
        let filled = spans(&[(0, HOUR), (5 * HOUR, 6 * HOUR)]);
        assert_eq!(uncovered(&filled, 0, 6 * HOUR), vec![(HOUR, 5 * HOUR)]);
        assert_eq!(
            uncovered(&filled, -HOUR, 6 * HOUR),
            vec![(-HOUR, 0), (HOUR, 5 * HOUR)],
            "a window reaching past both ends asks for both ends"
        );
        assert_eq!(uncovered(&filled, HOUR / 2, 3 * HOUR), vec![(HOUR, 3 * HOUR)]);
        assert_eq!(uncovered(&filled, 2 * HOUR, 3 * HOUR), vec![(2 * HOUR, 3 * HOUR)]);
        assert!(uncovered(&filled, 0, HOUR).is_empty(), "a filled window downloads nothing");
        assert_eq!(uncovered(&[], 0, HOUR), vec![(0, HOUR)], "an empty store fills the window");
    }

    #[test]
    fn a_restart_resumes_at_the_stored_edge() {
        // The first pass filled up to `end`; the second must start there, not at the
        // window's left edge, which is what keeps stored prints from being re-read.
        let filled = spans(&[(0, HOUR)]);
        assert_eq!(uncovered(&filled, 0, 2 * HOUR), vec![(HOUR, 2 * HOUR)]);
    }

    #[test]
    fn only_binance_prints_can_be_backfilled() {
        let mut instrument = Instrument {
            id: "BINANCE:BTCUSDT".into(),
            venue: Venue::Binance,
            symbol: "BTCUSDT".into(),
            display: "BTCUSDT".into(),
            name: "BTC/USDT".into(),
            asset_class: chartkit_core::AssetClass::CryptoSpot,
            price_tick: 0.01,
            qty_step: 0.00001,
            price_precision: 2,
            qty_precision: 5,
            quote_currency: "USDT".into(),
            session: chartkit_core::Session::continuous(),
            active: true,
        };
        assert_eq!(venue_symbol(&instrument), Some("BTCUSDT"));
        instrument.venue = Venue::Coinbase;
        assert_eq!(venue_symbol(&instrument), None);
    }

    #[test]
    fn the_page_pause_stays_inside_the_weight_budget() {
        let pages_per_minute = 60_000 / PAGE_SLEEP_MS;
        assert!(
            pages_per_minute * PAGE_WEIGHT as u64 <= WEIGHT_BUDGET_PER_MIN as u64,
            "{pages_per_minute} pages a minute would spend more than {WEIGHT_BUDGET_PER_MIN} weight"
        );
        assert_eq!(PAGE_SIZE, 1_000, "the venue caps a page here");
    }
}
