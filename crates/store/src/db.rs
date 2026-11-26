use std::path::Path;
use std::sync::Mutex;

use chartkit_core::{
    Alert, AlertFire, AlertKind, AssetClass, Bar, Instrument, Session, Side, Timeframe, Trade, Venue,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("store is poisoned: {0}")]
    Poisoned(String),
    #[error("unreadable stored row: {0}")]
    BadRow(String),
}

#[derive(Clone, Debug)]
pub struct BarFilter {
    pub instrument: String,
    pub timeframe: Timeframe,
    /// Inclusive lower bound, or None for the oldest stored bar.
    pub from: Option<i64>,
    /// Exclusive upper bound, or None for the newest stored bar.
    pub to: Option<i64>,
    pub limit: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub name: String,
    pub data: serde_json::Value,
    pub updated_at: i64,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS instruments (
    id              TEXT PRIMARY KEY,
    venue           TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    display         TEXT NOT NULL,
    name            TEXT NOT NULL,
    asset_class     TEXT NOT NULL,
    price_tick      REAL NOT NULL,
    qty_step        REAL NOT NULL,
    price_precision INTEGER NOT NULL,
    qty_precision   INTEGER NOT NULL,
    quote_currency  TEXT NOT NULL,
    session_json    TEXT NOT NULL,
    active          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS instruments_class ON instruments(asset_class, active);
CREATE INDEX IF NOT EXISTS instruments_display ON instruments(display);

CREATE TABLE IF NOT EXISTS bars (
    instrument_id TEXT NOT NULL,
    timeframe     TEXT NOT NULL,
    start         INTEGER NOT NULL,
    open          REAL NOT NULL,
    high          REAL NOT NULL,
    low           REAL NOT NULL,
    close         REAL NOT NULL,
    volume        REAL NOT NULL,
    trades        INTEGER NOT NULL,
    closed        INTEGER NOT NULL,
    PRIMARY KEY (instrument_id, timeframe, start)
);

CREATE TABLE IF NOT EXISTS trades (
    instrument_id TEXT NOT NULL,
    ts            INTEGER NOT NULL,
    seq           INTEGER NOT NULL,
    price         REAL NOT NULL,
    qty           REAL NOT NULL,
    aggressor     TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'live',
    PRIMARY KEY (instrument_id, ts, seq)
) WITHOUT ROWID;

-- One row per instrument: what the live stream saw, what a REST backfill filled,
-- and the oldest print the venue can still serve. `seq` values are venue trade ids,
-- shared by both sources, so the ranges below cannot overlap by accident.
CREATE TABLE IF NOT EXISTS print_coverage (
    instrument_id   TEXT PRIMARY KEY,
    live_from       INTEGER,
    live_to         INTEGER,
    live_min_seq    INTEGER,
    live_max_seq    INTEGER,
    backfill_from   INTEGER,
    backfill_to     INTEGER,
    backfill_min_id INTEGER,
    backfill_max_id INTEGER,
    venue_oldest_ts INTEGER,
    job_from        INTEGER,
    job_to          INTEGER,
    job_claim_at    INTEGER,
    updated_at      INTEGER NOT NULL
);

-- Filled print ranges, merged. A min/max pair cannot say which window inside it is
-- actually stored: a server that streamed twice leaves a hole between its sessions.
CREATE TABLE IF NOT EXISTS print_spans (
    instrument_id TEXT NOT NULL,
    from_ts       INTEGER NOT NULL,
    to_ts         INTEGER NOT NULL,
    PRIMARY KEY (instrument_id, from_ts)
);

CREATE TABLE IF NOT EXISTS workspaces (
    name       TEXT PRIMARY KEY,
    data_json  TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);

-- Price and volume rules, judged by the server in the live pump, so they hold with the
-- page closed. `armed` is stored with the rule: after a restart the server must neither
-- re-fire a level the tape still holds nor forget a rule that has to see the level given
-- back before it answers again.
CREATE TABLE IF NOT EXISTS alerts (
    id             TEXT PRIMARY KEY,
    instrument_id  TEXT NOT NULL,
    kind           TEXT NOT NULL,
    threshold      REAL NOT NULL,
    threshold_high REAL,
    timeframe      TEXT,
    rearm_gap      REAL NOT NULL,
    label          TEXT NOT NULL,
    enabled        INTEGER NOT NULL,
    muted          INTEGER NOT NULL,
    armed          INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    last_fired_at  INTEGER
);
CREATE INDEX IF NOT EXISTS alerts_instrument ON alerts(instrument_id, enabled);

-- One row per fire. The condition is copied in, so the history still reads correctly
-- after the rule that made it has been edited or deleted.
CREATE TABLE IF NOT EXISTS alert_fires (
    id             TEXT PRIMARY KEY,
    alert_id       TEXT NOT NULL,
    instrument_id  TEXT NOT NULL,
    kind           TEXT NOT NULL,
    timeframe      TEXT,
    threshold      REAL NOT NULL,
    threshold_high REAL,
    value          REAL NOT NULL,
    bar_start      INTEGER,
    ts             INTEGER NOT NULL,
    label          TEXT NOT NULL,
    muted          INTEGER NOT NULL,
    missed         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_fires_recent ON alert_fires(ts DESC);
CREATE INDEX IF NOT EXISTS alert_fires_alert ON alert_fires(alert_id, ts DESC);
"#;

/// Ranges this close together are stored as one filled span. A minute without prints
/// is a quiet tape, not a hole in coverage.
const SPAN_MERGE_SLACK_MS: i64 = 60_000;
/// When coverage has to be derived from stored prints, a gap wider than this is
/// treated as a hole rather than folded into the span around it.
const SPAN_REBUILD_GAP_MS: i64 = 15 * 60_000;
/// Fires the trigger history holds. It is the largest page `/api/alerts/history` will
/// hand back, so trimming at this size cannot drop a fire the panel could still list.
const FIRE_HISTORY_ROWS: i64 = 5_000;

/// Where a stored print came from: the venue's live stream, or a REST backfill of
/// the history the stream never saw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrintSource {
    Live,
    Backfill,
}

impl PrintSource {
    fn tag(self) -> &'static str {
        match self {
            PrintSource::Live => "live",
            PrintSource::Backfill => "backfill",
        }
    }
}

/// A closed time range over which prints are stored, merged with every range that
/// touches it. Ranges are kept apart where prints are genuinely missing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintSpan {
    pub from: i64,
    pub to: i64,
}

/// One page of venue print history handed to the store: the prints it carried, the
/// time range the page proves the venue has data for, and the aggregate ids it spanned.
#[derive(Clone, Debug, Default)]
pub struct BackfillPage {
    pub trades: Vec<Trade>,
    /// The venue answered this range, even where it answered with nothing.
    pub span: Option<(i64, i64)>,
    /// Aggregate trade ids covered, so a restarted backfill resumes after the last one.
    pub agg_ids: Option<(u64, u64)>,
}

/// Print coverage for one instrument. The live and backfilled ranges are reported
/// apart so a client can tell a streamed window from a reconstructed one, and
/// `venue_oldest_ts` tells it where the venue's own history ends.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintCoverage {
    pub instrument: String,
    pub live_from: Option<i64>,
    pub live_to: Option<i64>,
    /// Lowest and highest venue trade id seen on the live stream. A backfill stops
    /// here instead of re-reading prints the socket already delivered.
    pub live_min_seq: Option<i64>,
    pub live_max_seq: Option<i64>,
    pub backfill_from: Option<i64>,
    pub backfill_to: Option<i64>,
    /// Aggregate-trade ids the last backfill page ended on, so a restart resumes by
    /// id rather than re-reading stored prints.
    pub backfill_min_id: Option<i64>,
    pub backfill_max_id: Option<i64>,
    /// Every window prints are actually stored for, oldest first.
    pub spans: Vec<PrintSpan>,
    pub venue_oldest_ts: Option<i64>,
    /// Window a backfill is working through right now, with the time its worker last
    /// checked in. A claim nobody renews is a crashed worker, not a running job.
    pub job_from: Option<i64>,
    pub job_to: Option<i64>,
    pub job_claim_at: Option<i64>,
    pub updated_at: i64,
    pub status: String,
}

/// Snapshot of stored coverage, shown in the UI status strip.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub instruments: i64,
    pub bars: i64,
    pub trades: i64,
    pub newest_bar: Option<i64>,
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5_000)?;
        conn.execute_batch(SCHEMA)?;
        migrate_print_sources(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate_print_sources(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, StoreError> {
        self.conn
            .lock()
            .map_err(|e| StoreError::Poisoned(e.to_string()))
    }

    pub fn upsert_instruments(&self, items: &[Instrument]) -> Result<usize, StoreError> {
        let mut guard = self.lock()?;
        let tx = guard.transaction()?;
        let mut done = 0;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO instruments (id, venue, symbol, display, name, asset_class, price_tick,
                    qty_step, price_precision, qty_precision, quote_currency, session_json, active)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
                 ON CONFLICT(id) DO UPDATE SET display=excluded.display, name=excluded.name,
                    asset_class=excluded.asset_class, price_tick=excluded.price_tick,
                    qty_step=excluded.qty_step, price_precision=excluded.price_precision,
                    qty_precision=excluded.qty_precision, quote_currency=excluded.quote_currency,
                    session_json=excluded.session_json, active=excluded.active",
            )?;
            for item in items {
                done += stmt.execute(params![
                    item.id,
                    venue_tag(item.venue),
                    item.symbol,
                    item.display,
                    item.name,
                    asset_class_tag(item.asset_class),
                    item.price_tick,
                    item.qty_step,
                    item.price_precision as i64,
                    item.qty_precision as i64,
                    item.quote_currency,
                    serde_json::to_string(&item.session)?,
                    item.active as i64
                ])?;
            }
        }
        tx.commit()?;
        Ok(done)
    }

    pub fn instruments(&self, class: Option<AssetClass>, query: Option<&str>) -> Result<Vec<Instrument>, StoreError> {
        let guard = self.lock()?;
        let like = query.map(|q| format!("%{}%", q.to_ascii_uppercase()));
        let class_tag = class.map(asset_class_tag);
        let mut stmt = guard.prepare_cached(
            "SELECT id, venue, symbol, display, name, asset_class, price_tick, qty_step,
                    price_precision, qty_precision, quote_currency, session_json, active
             FROM instruments
             WHERE (:class IS NULL OR asset_class = :class)
               AND (:like IS NULL OR upper(display) LIKE :like OR upper(name) LIKE :like)
             ORDER BY display
             LIMIT 2000",
        )?;
        let rows = stmt.query_map(
            rusqlite::named_params! { ":class": class_tag, ":like": like },
            read_instrument,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    /// One instrument by id. Read directly: the catalogue is larger than the search
    /// list, so scanning the first page of it would miss most symbols.
    pub fn instrument(&self, id: &str) -> Result<Option<Instrument>, StoreError> {
        let guard = self.lock()?;
        guard
            .query_row(
                "SELECT id, venue, symbol, display, name, asset_class, price_tick, qty_step,
                        price_precision, qty_precision, quote_currency, session_json, active
                 FROM instruments WHERE id = ?1",
                params![id],
                read_instrument,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Insert or refresh bars. The live (unclosed) bar is rewritten until it seals.
    pub fn upsert_bars(&self, instrument: &str, timeframe: &str, bars: &[Bar]) -> Result<usize, StoreError> {
        let guard = self.lock()?;
        let mut stmt = guard.prepare_cached(
            "INSERT INTO bars (instrument_id, timeframe, start, open, high, low, close, volume, trades, closed)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(instrument_id, timeframe, start) DO UPDATE SET
                open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
                volume=excluded.volume, trades=excluded.trades, closed=excluded.closed",
        )?;
        let mut done = 0;
        for bar in bars {
            done += stmt.execute(params![
                instrument,
                timeframe,
                bar.start,
                bar.open,
                bar.high,
                bar.low,
                bar.close,
                bar.volume,
                bar.trades as i64,
                bar.closed as i64
            ])?;
        }
        Ok(done)
    }

    pub fn bars(&self, filter: BarFilter) -> Result<Vec<Bar>, StoreError> {
        let guard = self.lock()?;
        let tf = filter.timeframe.as_key();
        let mut stmt = guard.prepare_cached(
            "SELECT start, open, high, low, close, volume, trades, closed FROM bars
             WHERE instrument_id = :instrument AND timeframe = :timeframe
               AND (:from IS NULL OR start >= :from)
               AND (:to IS NULL OR start < :to)
             ORDER BY start DESC LIMIT :limit",
        )?;
        let rows = stmt.query_map(
            rusqlite::named_params! {
                ":instrument": filter.instrument,
                ":timeframe": tf,
                ":from": filter.from,
                ":to": filter.to,
                ":limit": filter.limit,
            },
            read_bar,
        )?;
        let mut out = rows.collect::<Result<Vec<_>, _>>()?;
        out.reverse();
        Ok(out)
    }

    pub fn last_bar_start(&self, instrument: &str, timeframe: &str) -> Result<Option<i64>, StoreError> {
        let guard = self.lock()?;
        Ok(guard
            .query_row(
                "SELECT MAX(start) FROM bars WHERE instrument_id = ?1 AND timeframe = ?2",
                params![instrument, timeframe],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten())
    }

    /// Prints from the live stream. `INSERT OR IGNORE` keeps a print that a backfill
    /// already stored under the same venue trade id.
    pub fn record_trades(&self, instrument: &str, trades: &[Trade]) -> Result<usize, StoreError> {
        self.record_prints(instrument, trades, PrintSource::Live, None, None)
    }

    /// One page of the venue's print history. The page records its own span, which can
    /// be wider than the prints inside it: an answer of "nothing before this point" is
    /// coverage too, and it is what stops a client asking again.
    pub fn record_backfill_page(&self, instrument: &str, page: &BackfillPage) -> Result<usize, StoreError> {
        self.record_prints(
            instrument,
            &page.trades,
            PrintSource::Backfill,
            page.span,
            page.agg_ids,
        )
    }

    fn record_prints(
        &self,
        instrument: &str,
        trades: &[Trade],
        source: PrintSource,
        span: Option<(i64, i64)>,
        agg_ids: Option<(u64, u64)>,
    ) -> Result<usize, StoreError> {
        let mut guard = self.lock()?;
        let tx = guard.transaction()?;
        let mut done = 0;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO trades (instrument_id, ts, seq, price, qty, aggressor, source)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
            )?;
            for trade in trades {
                done += stmt.execute(params![
                    instrument,
                    trade.ts,
                    trade.seq as i64,
                    trade.price,
                    trade.qty,
                    match trade.aggressor {
                        Side::Buy => "buy",
                        Side::Sell => "sell",
                    },
                    source.tag()
                ])?;
            }
        }
        let (mut from, mut to) = (i64::MAX, i64::MIN);
        let (mut low, mut high) = (u64::MAX, 0u64);
        for trade in trades {
            from = from.min(trade.ts);
            to = to.max(trade.ts);
            low = low.min(trade.seq);
            high = high.max(trade.seq);
        }
        let stored_range = (!trades.is_empty()).then_some((from, to));
        let now = chartkit_core::now_ms();
        match (source, agg_ids, stored_range) {
            (PrintSource::Live, _, Some((from, to))) => {
                tx.execute(
                "INSERT INTO print_coverage (instrument_id, live_from, live_to, live_min_seq, live_max_seq, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(instrument_id) DO UPDATE SET
                    live_from = MIN(COALESCE(live_from, excluded.live_from), excluded.live_from),
                    live_to = MAX(COALESCE(live_to, excluded.live_to), excluded.live_to),
                    live_min_seq = MIN(COALESCE(live_min_seq, excluded.live_min_seq), excluded.live_min_seq),
                    live_max_seq = MAX(COALESCE(live_max_seq, excluded.live_max_seq), excluded.live_max_seq),
                    updated_at = excluded.updated_at",
                    params![instrument, from, to, low as i64, high as i64, now],
                )?;
            }
            (PrintSource::Backfill, Some((low_id, high_id)), Some((from, to))) => {
                tx.execute(
                "INSERT INTO print_coverage
                    (instrument_id, backfill_from, backfill_to, backfill_min_id, backfill_max_id, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(instrument_id) DO UPDATE SET
                    backfill_from = MIN(COALESCE(backfill_from, excluded.backfill_from), excluded.backfill_from),
                    backfill_to = MAX(COALESCE(backfill_to, excluded.backfill_to), excluded.backfill_to),
                    backfill_min_id = MIN(COALESCE(backfill_min_id, excluded.backfill_min_id), excluded.backfill_min_id),
                    backfill_max_id = MAX(COALESCE(backfill_max_id, excluded.backfill_max_id), excluded.backfill_max_id),
                    updated_at = excluded.updated_at",
                    params![instrument, from, to, low_id as i64, high_id as i64, now],
                )?;
            }
            _ => {}
        }
        merge_print_span(&tx, instrument, span.or(stored_range))?;
        tx.commit()?;
        Ok(done)
    }

    pub fn trades(
        &self,
        instrument: &str,
        from: Option<i64>,
        to: Option<i64>,
        limit: i64,
    ) -> Result<Vec<Trade>, StoreError> {
        let guard = self.lock()?;
        let mut stmt = guard.prepare_cached(
            "SELECT ts, seq, price, qty, aggressor FROM trades
             WHERE instrument_id = :instrument
               AND (:from IS NULL OR ts >= :from)
               AND (:to IS NULL OR ts < :to)
             ORDER BY ts DESC, seq DESC LIMIT :limit",
        )?;
        let rows = stmt.query_map(
            rusqlite::named_params! {
                ":instrument": instrument, ":from": from, ":to": to, ":limit": limit
            },
            read_trade,
        )?;
        let mut out = rows.collect::<Result<Vec<_>, _>>()?;
        out.reverse();
        Ok(out)
    }


    /// The same prints `trades` returns, in the same order, handed to `visit` one at a
    /// time instead of collected. A footprint or profile answer folds every print in the
    /// window into a few hundred bars or price rows, so the window itself was the largest
    /// thing a request held and the part that survived was far smaller.
    ///
    /// The oldest print the answer may use is found first, which lets the read walk the
    /// `(instrument, ts, seq)` primary key forwards and stream, rather than sorting the
    /// whole window in memory.
    pub fn trades_window<F>(
        &self,
        instrument: &str,
        from: Option<i64>,
        to: Option<i64>,
        limit: i64,
        mut visit: F,
    ) -> Result<usize, StoreError>
    where
        F: FnMut(&Trade) -> Result<(), StoreError>,
    {
        let limit = limit.max(1);
        let guard = self.lock()?;
        use rusqlite::OptionalExtension as _;
        let cut: Option<(i64, i64)> = guard
            .prepare_cached(
                "SELECT ts, seq FROM trades
                 WHERE instrument_id = :instrument
                   AND (:from IS NULL OR ts >= :from)
                   AND (:to IS NULL OR ts < :to)
                 ORDER BY ts DESC, seq DESC LIMIT 1 OFFSET :oldest",
            )?
            .query_row(
                rusqlite::named_params! {
                    ":instrument": instrument, ":from": from, ":to": to,
                    ":oldest": limit - 1
                },
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (cut_ts, cut_seq) = cut.unzip();
        let mut stmt = guard.prepare_cached(
            "SELECT ts, seq, price, qty, aggressor FROM trades
             WHERE instrument_id = :instrument
               AND (:from IS NULL OR ts >= :from)
               AND (:to IS NULL OR ts < :to)
               AND (:cut_ts IS NULL OR (ts, seq) >= (:cut_ts, :cut_seq))
             ORDER BY ts, seq",
        )?;
        let rows = stmt.query_map(
            rusqlite::named_params! {
                ":instrument": instrument, ":from": from, ":to": to,
                ":cut_ts": cut_ts, ":cut_seq": cut_seq
            },
            read_trade,
        )?;
        let mut seen = 0;
        for trade in rows {
            visit(&trade?)?;
            seen += 1;
        }
        Ok(seen)
    }

    /// The plans of both print window reads, joined. A test hook: a plan that says SCAN
    /// is a request that starts walking every print an instrument holds.
    #[cfg(test)]
    fn print_read_plans(&self) -> Result<String, StoreError> {
        let guard = self.lock()?;
        let mut plans: Vec<String> = Vec::new();
        let mut stmt = guard.prepare_cached(
            "EXPLAIN QUERY PLAN SELECT ts, seq, price, qty, aggressor FROM trades
             WHERE instrument_id = ?1 AND ts >= ?2 AND ts < ?3
             ORDER BY ts DESC, seq DESC LIMIT 10",
        )?;
        plans.push(read_plan(&mut stmt, rusqlite::params!["BINANCE:BTCUSDT", 0i64, 1i64])?);
        drop(stmt);
        let mut stmt = guard.prepare_cached(
            "EXPLAIN QUERY PLAN SELECT ts, seq, price, qty, aggressor FROM trades
             WHERE instrument_id = ?1 AND ts >= ?2 AND ts < ?3
               AND (?4 IS NULL OR (ts, seq) >= (?4, ?5))
             ORDER BY ts, seq",
        )?;
        plans.push(read_plan(&mut stmt, rusqlite::params!["BINANCE:BTCUSDT", 0i64, 1i64, 0i64, 0i64])?);
        Ok(plans.join(" || "))
    }

    /// Drop prints older than `before`, keeping history tables small. Ranges go with
    /// them, or coverage would keep promising prints that are no longer stored.
    pub fn prune_trades(&self, before: i64) -> Result<usize, StoreError> {
        let guard = self.lock()?;
        let removed = guard.execute("DELETE FROM trades WHERE ts < ?1", params![before])?;
        guard.execute("DELETE FROM print_spans WHERE to_ts < ?1", params![before])?;
        Ok(removed)
    }

    pub fn workspaces(&self) -> Result<Vec<Workspace>, StoreError> {
        let guard = self.lock()?;
        let mut stmt = guard.prepare_cached(
            "SELECT name, data_json, updated_at FROM workspaces ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Workspace {
                name: row.get(0)?,
                data: serde_json::from_str(&row.get::<_, String>(1)?).unwrap_or(serde_json::Value::Null),
                updated_at: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    pub fn save_workspace(&self, name: &str, data: &serde_json::Value, updated_at: i64) -> Result<(), StoreError> {
        let guard = self.lock()?;
        guard.execute(
            "INSERT INTO workspaces (name, data_json, updated_at) VALUES (?1,?2,?3)
             ON CONFLICT(name) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at",
            params![name, serde_json::to_string(data)?, updated_at],
        )?;
        Ok(())
    }

    pub fn delete_workspace(&self, name: &str) -> Result<bool, StoreError> {
        let guard = self.lock()?;
        Ok(guard.execute("DELETE FROM workspaces WHERE name = ?1", params![name])? > 0)
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<(), StoreError> {
        let guard = self.lock()?;
        guard.execute(
            "INSERT INTO settings (key, value_json) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<serde_json::Value>, StoreError> {
        let guard = self.lock()?;
        let raw: Option<String> = guard
            .query_row("SELECT value_json FROM settings WHERE key = ?1", params![key], |row| row.get(0))
            .optional()?;
        match raw {
            None => Ok(None),
            Some(text) => Ok(Some(serde_json::from_str(&text)?)),
        }
    }

    /// Every rule, newest created first. Rules are few, so the evaluator keeps the whole
    /// set in memory instead of querying the store once a print.
    pub fn alerts(&self) -> Result<Vec<Alert>, StoreError> {
        let guard = self.lock()?;
        let sql = ALERT_SELECT.replace("{FILTER}", "");
        let mut stmt = guard.prepare_cached(&sql)?;
        let rows = stmt.query_map([], read_raw_alert)?;
        rows.collect::<Result<Vec<_>, _>>()?.into_iter().map(decode_alert).collect()
    }

    pub fn alert(&self, id: &str) -> Result<Option<Alert>, StoreError> {
        let guard = self.lock()?;
        let sql = ALERT_SELECT.replace("{FILTER}", "WHERE id = ?1");
        let raw = guard
            .query_row(&sql, params![id], read_raw_alert)
            .optional()?;
        raw.map(decode_alert).transpose()
    }

    pub fn insert_alert(&self, alert: &Alert) -> Result<(), StoreError> {
        let guard = self.lock()?;
        guard.execute(
            "INSERT INTO alerts (id, instrument_id, kind, threshold, threshold_high, timeframe,
                    rearm_gap, label, enabled, muted, armed, created_at, updated_at, last_fired_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                alert.id,
                alert.instrument,
                alert.kind.as_key(),
                alert.threshold,
                alert.threshold_high,
                alert.timeframe_key(),
                alert.rearm_gap,
                alert.label,
                alert.enabled as i64,
                alert.muted as i64,
                alert.armed as i64,
                alert.created_at,
                alert.updated_at,
                alert.last_fired_at,
            ],
        )?;
        Ok(())
    }

    /// Replaces a rule. `created_at` is written from the row that was read first, so an
    /// edit never rewrites when the rule was made.
    pub fn update_alert(&self, alert: &Alert) -> Result<bool, StoreError> {
        let guard = self.lock()?;
        let changed = guard.execute(
            "UPDATE alerts SET instrument_id=?2, kind=?3, threshold=?4, threshold_high=?5,
                    timeframe=?6, rearm_gap=?7, label=?8, enabled=?9, muted=?10, armed=?11,
                    updated_at=?12, last_fired_at=?13
             WHERE id = ?1",
            params![
                alert.id,
                alert.instrument,
                alert.kind.as_key(),
                alert.threshold,
                alert.threshold_high,
                alert.timeframe_key(),
                alert.rearm_gap,
                alert.label,
                alert.enabled as i64,
                alert.muted as i64,
                alert.armed as i64,
                alert.updated_at,
                alert.last_fired_at,
            ],
        )?;
        Ok(changed > 0)
    }

    /// Writes back only the crossing state, which is the half the evaluator owns. It
    /// moves on a fire or when the level is given back, never on every print.
    pub fn note_alert_state(&self, id: &str, armed: bool, last_fired_at: Option<i64>) -> Result<(), StoreError> {
        let guard = self.lock()?;
        guard.execute(
            "UPDATE alerts SET armed = ?2, last_fired_at = COALESCE(?3, last_fired_at) WHERE id = ?1",
            params![id, armed as i64, last_fired_at],
        )?;
        Ok(())
    }

    pub fn delete_alert(&self, id: &str) -> Result<bool, StoreError> {
        let guard = self.lock()?;
        Ok(guard.execute("DELETE FROM alerts WHERE id = ?1", params![id])? > 0)
    }

    /// Keeps one fire, then drops the oldest once the history passes `FIRE_HISTORY_ROWS`.
    /// A rule with a cooldown can fire every hour forever, and nothing ever read the
    /// rows past the first few hundred.
    pub fn record_alert_fire(&self, fire: &AlertFire) -> Result<(), StoreError> {
        let guard = self.lock()?;
        guard.execute(
            "INSERT INTO alert_fires (id, alert_id, instrument_id, kind, timeframe, threshold,
                    threshold_high, value, bar_start, ts, label, muted, missed)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
             ON CONFLICT(id) DO NOTHING",
            params![
                fire.id,
                fire.alert_id,
                fire.instrument,
                fire.kind.as_key(),
                fire.timeframe.map(|frame| frame.as_key()),
                fire.threshold,
                fire.threshold_high,
                fire.value,
                fire.bar_start,
                fire.ts,
                fire.label,
                fire.muted as i64,
                fire.missed as i64,
            ],
        )?;
        // Trimmed here rather than on a schedule: fires are rare, and a trim that only
        // runs from time to time leaves the table growing in between.
        guard.execute(
            "DELETE FROM alert_fires
             WHERE ts < (SELECT ts FROM alert_fires ORDER BY ts DESC, id DESC LIMIT 1 OFFSET ?1)",
            params![FIRE_HISTORY_ROWS - 1],
        )?;
        Ok(())
    }

    /// Fires, newest first. Narrowed to one instrument when asked for.
    pub fn alert_fires(&self, instrument: Option<&str>, limit: i64) -> Result<Vec<AlertFire>, StoreError> {
        let guard = self.lock()?;
        let mut stmt = guard.prepare_cached(
            "SELECT id, alert_id, instrument_id, kind, timeframe, threshold, threshold_high,
                    value, bar_start, ts, label, muted, missed
             FROM alert_fires
             WHERE (:instrument IS NULL OR instrument_id = :instrument)
             ORDER BY ts DESC, id DESC LIMIT :limit",
        )?;
        let rows = stmt.query_map(
            rusqlite::named_params! { ":instrument": instrument, ":limit": limit },
            read_raw_fire,
        )?;
        rows.collect::<Result<Vec<_>, _>>()?.into_iter().map(decode_fire).collect()
    }

    /// Empties the trigger history and reports how many fires went. The rules stay.
    pub fn clear_alert_fires(&self) -> Result<usize, StoreError> {
        let guard = self.lock()?;
        Ok(guard.execute("DELETE FROM alert_fires", [])?)
    }

    /// The newest print held for an instrument, with its venue stamp. Startup uses this
    /// to judge what a rule saw while the server was down.
    pub fn newest_print(&self, instrument: &str) -> Result<Option<(f64, i64)>, StoreError> {
        let guard = self.lock()?;
        Ok(guard
            .query_row(
                "SELECT price, ts FROM trades WHERE instrument_id = ?1 ORDER BY ts DESC, seq DESC LIMIT 1",
                params![instrument],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
            .filter(|(price, _)| price.is_finite()))
    }

    /// The newest closed bar in one timeframe. The live bar is skipped: a window rule
    /// reads settled totals only.
    pub fn newest_closed_bar(&self, instrument: &str, timeframe: &str) -> Result<Option<Bar>, StoreError> {
        let guard = self.lock()?;
        Ok(guard
            .query_row(
                "SELECT start, open, high, low, close, volume, trades, closed FROM bars
                 WHERE instrument_id = ?1 AND timeframe = ?2 AND closed = 1
                 ORDER BY start DESC LIMIT 1",
                params![instrument, timeframe],
                read_bar,
            )
            .optional()?)
    }

    /// Print coverage for one instrument. A database written before backfill existed
    /// has no coverage row, so it is derived from the stored prints once and then
    /// maintained on every write.
    pub fn print_coverage(&self, instrument: &str) -> Result<PrintCoverage, StoreError> {
        let guard = self.lock()?;
        let found = guard
            .query_row(
                "SELECT instrument_id, live_from, live_to, live_min_seq, live_max_seq,
                        backfill_from, backfill_to, backfill_min_id, backfill_max_id,
                        venue_oldest_ts, job_from, job_to, job_claim_at, updated_at
                 FROM print_coverage WHERE instrument_id = ?1",
                params![instrument],
                read_print_coverage,
            )
            .optional()?;
        drop(guard);
        let mut coverage = match found {
            Some(coverage) => coverage,
            None => self.rebuild_print_coverage(instrument)?,
        };
        // Ranges can be missing even when the coverage row is not: prints written
        // before ranges were recorded leave the bounds known and the holes unknown.
        // Every write extends both together, so ranges that fall short of the bounds
        // mean they were never derived. Doing it here is what makes an old store honest.
        let mut spans = self.print_spans(instrument)?;
        let short = claimed_bounds(&coverage).is_some_and(|(from, to)| {
            spans.first().is_none_or(|first| first.from > from)
                || spans.last().is_none_or(|last| last.to < to)
        });
        if short {
            self.seed_print_spans(instrument)?;
            spans = self.print_spans(instrument)?;
        }
        coverage.spans = spans;
        Ok(coverage)
    }

    /// Filled print ranges for one instrument, oldest first.
    fn print_spans(&self, instrument: &str) -> Result<Vec<PrintSpan>, StoreError> {
        let guard = self.lock()?;
        let mut stmt = guard.prepare_cached(
            "SELECT from_ts, to_ts FROM print_spans WHERE instrument_id = ?1 ORDER BY from_ts",
        )?;
        let rows = stmt.query_map(params![instrument], |row| {
            Ok(PrintSpan { from: row.get(0)?, to: row.get(1)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    /// Coverage rows for every instrument that has prints, for `/api/coverage`.
    pub fn print_coverage_all(&self) -> Result<Vec<PrintCoverage>, StoreError> {
        let guard = self.lock()?;
        let mut items = {
            let mut stmt = guard.prepare_cached(
                "SELECT instrument_id, live_from, live_to, live_min_seq, live_max_seq,
                        backfill_from, backfill_to, backfill_min_id, backfill_max_id,
                        venue_oldest_ts, job_from, job_to, job_claim_at, updated_at
                 FROM print_coverage ORDER BY instrument_id",
            )?;
            let rows = stmt.query_map([], read_print_coverage)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let spans = guard
            .prepare_cached(
                "SELECT instrument_id, from_ts, to_ts FROM print_spans
                 ORDER BY instrument_id, from_ts",
            )?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, PrintSpan { from: row.get(1)?, to: row.get(2)? }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for coverage in &mut items {
            coverage.spans = spans
                .iter()
                .filter(|(owner, _)| *owner == coverage.instrument)
                .map(|(_, span)| *span)
                .collect();
        }
        Ok(items)
    }

    /// Takes the claim on a backfill for `from..to`, returning the whole window the
    /// job must cover (a later request widens it instead of starting a second job).
    /// `None` means another job holds a live claim.
    pub fn claim_print_backfill(
        &self,
        instrument: &str,
        from: i64,
        to: i64,
        now: i64,
        lease_expired_before: i64,
    ) -> Result<Option<(i64, i64)>, StoreError> {
        let guard = self.lock()?;
        guard.execute(
            "INSERT INTO print_coverage (instrument_id, updated_at) VALUES (?1, ?2)
             ON CONFLICT(instrument_id) DO NOTHING",
            params![instrument, now],
        )?;
        let claimed = guard
            .query_row(
                "UPDATE print_coverage SET job_from = ?3, job_to = ?4, job_claim_at = ?2, updated_at = ?2
                 WHERE instrument_id = ?1
                   AND (job_claim_at IS NULL OR job_claim_at <= ?5)
                 RETURNING job_from, job_to",
                params![instrument, now, from, to, lease_expired_before],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if claimed.is_some() {
            return Ok(claimed);
        }
        // Someone else is downloading; widen their window so this request is served too.
        guard.execute(
            "UPDATE print_coverage
                SET job_from = MIN(COALESCE(job_from, ?3), ?3),
                    job_to = MAX(COALESCE(job_to, ?4), ?4),
                    updated_at = ?2
              WHERE instrument_id = ?1",
            params![instrument, now, from, to],
        )?;
        Ok(None)
    }

    /// Keeps a running claim alive, so a stalled process stops owning the window.
    pub fn heartbeat_print_backfill(&self, instrument: &str, now: i64) -> Result<(), StoreError> {
        let guard = self.lock()?;
        guard.execute(
            "UPDATE print_coverage SET job_claim_at = ?2, updated_at = ?2 WHERE instrument_id = ?1",
            params![instrument, now],
        )?;
        Ok(())
    }

    /// Releases the claim. Progress stays in the coverage row, so the next request
    /// continues from where this one stopped.
    pub fn finish_print_backfill(&self, instrument: &str, now: i64) -> Result<(), StoreError> {
        let guard = self.lock()?;
        guard.execute(
            "UPDATE print_coverage
                SET job_from = NULL, job_to = NULL, job_claim_at = NULL, updated_at = ?2
              WHERE instrument_id = ?1",
            params![instrument, now],
        )?;
        Ok(())
    }

    /// Records the oldest print the venue can still serve, so requests older than it
    /// stop starting jobs.
    pub fn note_venue_print_floor(
        &self,
        instrument: &str,
        oldest_ts: i64,
        now: i64,
    ) -> Result<(), StoreError> {
        let guard = self.lock()?;
        guard.execute(
            "INSERT INTO print_coverage (instrument_id, venue_oldest_ts, updated_at)
             VALUES (?1,?2,?3) ON CONFLICT(instrument_id) DO UPDATE SET
                venue_oldest_ts = COALESCE(venue_oldest_ts, excluded.venue_oldest_ts),
                updated_at = excluded.updated_at",
            params![instrument, oldest_ts, now],
        )?;
        Ok(())
    }

    /// Derives coverage for an instrument that has no coverage row yet: a database
    /// written before backfill existed, where every stored print is a live one.
    fn rebuild_print_coverage(&self, instrument: &str) -> Result<PrintCoverage, StoreError> {
        let guard = self.lock()?;
        let range = |source: &str| -> Result<(Option<i64>, Option<i64>, Option<i64>, Option<i64>), StoreError> {
            Ok(guard
                .query_row(
                    "SELECT MIN(ts), MAX(ts), MIN(seq), MAX(seq) FROM trades
                     WHERE instrument_id = ?1 AND source = ?2",
                    params![instrument, source],
                    |row| {
                        Ok((
                            row.get::<_, Option<i64>>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                        ))
                    },
                )
                .optional()?
                .unwrap_or((None, None, None, None)))
        };
        let (live_from, live_to, live_min_seq, live_max_seq) = range("live")?;
        let (backfill_from, backfill_to, backfill_min_id, backfill_max_id) = range("backfill")?;
        let coverage = PrintCoverage {
            instrument: instrument.to_string(),
            live_from,
            live_to,
            live_min_seq,
            live_max_seq,
            backfill_from,
            backfill_to,
            backfill_min_id,
            backfill_max_id,
            spans: Vec::new(),
            venue_oldest_ts: None,
            job_from: None,
            job_to: None,
            job_claim_at: None,
            updated_at: chartkit_core::now_ms(),
            status: String::new(),
        };
        // An instrument with no prints keeps no row, so the next live print is still
        // free to derive a real range instead of a cached empty one.
        let has_prints = coverage.live_from.is_some() || coverage.backfill_from.is_some();
        drop(guard);
        if has_prints {
            self.store_print_coverage(&coverage)?;
        }
        Ok(with_print_status(coverage))
    }

    /// Derives filled ranges from prints stored before the span table existed. Prints
    /// further apart than the rebuild gap end one range and start the next, which is
    /// how a server that streamed twice leaves its sessions visibly apart.
    fn seed_print_spans(&self, instrument: &str) -> Result<(), StoreError> {
        let guard = self.lock()?;
        let runs = guard
            .prepare_cached(
                "WITH ordered AS (
                     SELECT ts, LAG(ts) OVER (ORDER BY ts) AS previous
                     FROM trades WHERE instrument_id = ?1
                 ), marked AS (
                     SELECT ts, CASE WHEN previous IS NULL OR ts - previous > ?2 THEN 1 ELSE 0 END AS begins
                     FROM ordered
                 ), grouped AS (
                     SELECT ts, SUM(begins) OVER (
                         ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                     ) AS run
                     FROM marked
                 )
                 SELECT MIN(ts), MAX(ts) FROM grouped GROUP BY run ORDER BY MIN(ts)",
            )?
            .query_map(params![instrument, SPAN_REBUILD_GAP_MS], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<Vec<(i64, i64)>, _>>()?;
        drop(guard);
        let guard = self.lock()?;
        for (from_ts, to_ts) in runs {
            guard.execute(
                "INSERT OR IGNORE INTO print_spans (instrument_id, from_ts, to_ts) VALUES (?1,?2,?3)",
                params![instrument, from_ts, to_ts],
            )?;
        }
        Ok(())
    }

    fn store_print_coverage(&self, coverage: &PrintCoverage) -> Result<(), StoreError> {
        let guard = self.lock()?;
        guard.execute(
            "INSERT INTO print_coverage
                (instrument_id, live_from, live_to, live_min_seq, live_max_seq,
                 backfill_from, backfill_to, backfill_min_id, backfill_max_id,
                 venue_oldest_ts, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(instrument_id) DO UPDATE SET
                live_from=excluded.live_from, live_to=excluded.live_to,
                live_min_seq=excluded.live_min_seq, live_max_seq=excluded.live_max_seq,
                backfill_from=excluded.backfill_from, backfill_to=excluded.backfill_to,
                backfill_min_id=excluded.backfill_min_id, backfill_max_id=excluded.backfill_max_id,
                venue_oldest_ts=COALESCE(print_coverage.venue_oldest_ts, excluded.venue_oldest_ts),
                updated_at=excluded.updated_at",
            params![
                coverage.instrument,
                coverage.live_from,
                coverage.live_to,
                coverage.live_min_seq,
                coverage.live_max_seq,
                coverage.backfill_from,
                coverage.backfill_to,
                coverage.backfill_min_id,
                coverage.backfill_max_id,
                coverage.venue_oldest_ts,
                coverage.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn coverage(&self) -> Result<Coverage, StoreError> {
        let guard = self.lock()?;
        let count = |sql: &str| -> Result<i64, StoreError> {
            Ok(guard.query_row(sql, [], |row| row.get(0))?)
        };
        Ok(Coverage {
            instruments: count("SELECT COUNT(*) FROM instruments")?,
            bars: count("SELECT COUNT(*) FROM bars")?,
            trades: count("SELECT COUNT(*) FROM trades")?,
            newest_bar: guard.query_row("SELECT MAX(start) FROM bars", [], |row| row.get(0))?,
        })
    }
}

/// Rule columns, in the order `read_raw_alert` reads them. `{FILTER}` selects either the
/// whole table or one row, so the two queries cannot drift apart. Newest inserted first:
/// `rowid` is insertion order, which `created_at` cannot separate when two rules are made
/// in the same millisecond.
const ALERT_SELECT: &str = "SELECT id, instrument_id, kind, threshold, threshold_high, timeframe,
                rearm_gap, label, enabled, muted, armed, created_at, updated_at, last_fired_at
         FROM alerts {FILTER} ORDER BY rowid DESC";

/// A stored rule before its kind and window are read back. Both are text in the row, and
/// a value the evaluator could not judge is worth reporting rather than skipping quietly.
struct RawAlert {
    id: String,
    instrument: String,
    kind: String,
    threshold: f64,
    threshold_high: Option<f64>,
    timeframe: Option<String>,
    rearm_gap: f64,
    label: String,
    enabled: i64,
    muted: i64,
    armed: i64,
    created_at: i64,
    updated_at: i64,
    last_fired_at: Option<i64>,
}

fn read_raw_alert(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawAlert> {
    Ok(RawAlert {
        id: row.get(0)?,
        instrument: row.get(1)?,
        kind: row.get(2)?,
        threshold: row.get(3)?,
        threshold_high: row.get(4)?,
        timeframe: row.get(5)?,
        rearm_gap: row.get(6)?,
        label: row.get(7)?,
        enabled: row.get(8)?,
        muted: row.get(9)?,
        armed: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        last_fired_at: row.get(13)?,
    })
}

fn decode_alert(raw: RawAlert) -> Result<Alert, StoreError> {
    let timeframe = raw
        .timeframe
        .as_deref()
        .map(|text| text.parse::<Timeframe>().map_err(|error| StoreError::BadRow(format!("{text}: {error}"))))
        .transpose()?;
    Ok(Alert {
        kind: AlertKind::parse(&raw.kind).ok_or_else(|| StoreError::BadRow(format!("unknown alert kind {:?}", raw.kind)))?,
        id: raw.id,
        instrument: raw.instrument,
        threshold: raw.threshold,
        threshold_high: raw.threshold_high,
        timeframe,
        rearm_gap: raw.rearm_gap,
        label: raw.label,
        enabled: raw.enabled != 0,
        muted: raw.muted != 0,
        armed: raw.armed != 0,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        last_fired_at: raw.last_fired_at,
    })
}

/// The same shape for a fire: text kind and window, checked after the cursor closes.
struct RawFire {
    id: String,
    alert_id: String,
    instrument: String,
    kind: String,
    timeframe: Option<String>,
    threshold: f64,
    threshold_high: Option<f64>,
    value: f64,
    bar_start: Option<i64>,
    ts: i64,
    label: String,
    muted: i64,
    missed: i64,
}

/// Collects the detail lines of an `EXPLAIN QUERY PLAN` statement.
#[cfg(test)]
fn read_plan(stmt: &mut rusqlite::Statement<'_>, params: &[&dyn rusqlite::ToSql]) -> Result<String, StoreError> {
    let rows = stmt.query_map(params, |row| row.get::<_, String>(3))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?.join(", "))
}

/// Reads one print row. Shared by the collected and the streamed window reads, so the
/// two cannot drift apart.
fn read_trade(row: &rusqlite::Row<'_>) -> rusqlite::Result<Trade> {
    let aggressor = row.get::<_, String>(4)?;
    Ok(Trade {
        ts: row.get(0)?,
        seq: row.get::<_, i64>(1)? as u64,
        price: row.get(2)?,
        qty: row.get(3)?,
        aggressor: if aggressor == "buy" { Side::Buy } else { Side::Sell },
    })
}

fn read_raw_fire(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawFire> {
    Ok(RawFire {
        id: row.get(0)?,
        alert_id: row.get(1)?,
        instrument: row.get(2)?,
        kind: row.get(3)?,
        timeframe: row.get(4)?,
        threshold: row.get(5)?,
        threshold_high: row.get(6)?,
        value: row.get(7)?,
        bar_start: row.get(8)?,
        ts: row.get(9)?,
        label: row.get(10)?,
        muted: row.get(11)?,
        missed: row.get(12)?,
    })
}

fn decode_fire(raw: RawFire) -> Result<AlertFire, StoreError> {
    let timeframe = raw
        .timeframe
        .as_deref()
        .map(|text| text.parse::<Timeframe>().map_err(|error| StoreError::BadRow(format!("{text}: {error}"))))
        .transpose()?;
    Ok(AlertFire {
        kind: AlertKind::parse(&raw.kind).ok_or_else(|| StoreError::BadRow(format!("unknown alert kind {:?}", raw.kind)))?,
        id: raw.id,
        alert_id: raw.alert_id,
        instrument: raw.instrument,
        timeframe,
        threshold: raw.threshold,
        threshold_high: raw.threshold_high,
        value: raw.value,
        bar_start: raw.bar_start,
        ts: raw.ts,
        label: raw.label,
        muted: raw.muted != 0,
        missed: raw.missed != 0,
    })
}

/// Reads a `bars` row in the column order every bar query selects.
fn read_bar(row: &rusqlite::Row<'_>) -> rusqlite::Result<Bar> {
    Ok(Bar {
        start: row.get(0)?,
        open: row.get(1)?,
        high: row.get(2)?,
        low: row.get(3)?,
        close: row.get(4)?,
        volume: row.get(5)?,
        trades: row.get::<_, i64>(6)? as u64,
        closed: row.get::<_, i64>(7)? != 0,
    })
}

/// Reads an `instruments` row in the column order both catalogue queries use.
fn read_instrument(row: &rusqlite::Row<'_>) -> rusqlite::Result<Instrument> {
    Ok(Instrument {
        id: row.get(0)?,
        venue: venue_from_tag(row.get(1)?),
        symbol: row.get(2)?,
        display: row.get(3)?,
        name: row.get(4)?,
        asset_class: asset_class_from_tag(row.get(5)?),
        price_tick: row.get(6)?,
        qty_step: row.get(7)?,
        price_precision: row.get::<_, i64>(8)? as u32,
        qty_precision: row.get::<_, i64>(9)? as u32,
        quote_currency: row.get(10)?,
        session: serde_json::from_str(&row.get::<_, String>(11)?)
            .unwrap_or_else(|_| Session::continuous()),
        active: row.get::<_, i64>(12)? != 0,
    })
}

/// The time bounds the coverage row claims prints exist for.
fn claimed_bounds(coverage: &PrintCoverage) -> Option<(i64, i64)> {
    let from = [coverage.live_from, coverage.backfill_from].into_iter().flatten().min()?;
    let to = [coverage.live_to, coverage.backfill_to].into_iter().flatten().max()?;
    Some((from, to))
}

/// Folds `[from_ts, to_ts]` into the stored spans, joining every span it touches so
/// the table stays a list of real holes instead of one row per write.
fn merge_print_span(
    tx: &rusqlite::Transaction<'_>,
    instrument: &str,
    span: Option<(i64, i64)>,
) -> Result<(), StoreError> {
    let Some((from_ts, to_ts)) = span else { return Ok(()) };
    // Overlap in both directions: a stored range starting before the new one ends and
    // ending after it begins. A new range that swallows stored ranges counts too, which
    // is how a backfill across a gap joins the sessions on either side of it.
    let touching = tx
        .prepare_cached(
            "SELECT from_ts, to_ts FROM print_spans
             WHERE instrument_id = :instrument
               AND from_ts <= :to_ts + :slack
               AND to_ts + :slack >= :from_ts
             ORDER BY from_ts",
    )?
        .query_map(
            rusqlite::named_params! {
                ":instrument": instrument,
                ":from_ts": from_ts,
                ":to_ts": to_ts,
                ":slack": SPAN_MERGE_SLACK_MS,
            },
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
        .collect::<Result<Vec<(i64, i64)>, _>>()?;
    if touching.len() == 1 && touching[0].0 <= from_ts && touching[0].1 >= to_ts {
        return Ok(()); // already inside a stored span
    }
    let (mut low, mut high) = (from_ts, to_ts);
    for (start, end) in &touching {
        low = low.min(*start);
        high = high.max(*end);
    }
    if !touching.is_empty() {
        let mut delete = tx.prepare_cached("DELETE FROM print_spans WHERE instrument_id = ?1 AND from_ts = ?2")?;
        for (start, _) in &touching {
            delete.execute(params![instrument, start])?;
        }
    }
    tx.execute(
        "INSERT INTO print_spans (instrument_id, from_ts, to_ts) VALUES (?1,?2,?3)",
        params![instrument, low, high],
    )?;
    Ok(())
}

/// Reads a `print_coverage` row in the column order every coverage query uses.
fn read_print_coverage(row: &rusqlite::Row<'_>) -> rusqlite::Result<PrintCoverage> {
    let coverage = PrintCoverage {
        instrument: row.get(0)?,
        live_from: row.get(1)?,
        live_to: row.get(2)?,
        live_min_seq: row.get(3)?,
        live_max_seq: row.get(4)?,
        backfill_from: row.get(5)?,
        backfill_to: row.get(6)?,
        backfill_min_id: row.get(7)?,
        backfill_max_id: row.get(8)?,
        spans: Vec::new(),
        venue_oldest_ts: row.get(9)?,
        job_from: row.get(10)?,
        job_to: row.get(11)?,
        job_claim_at: row.get(12)?,
        updated_at: row.get(13)?,
        status: String::new(),
    };
    Ok(with_print_status(coverage))
}

fn with_print_status(mut coverage: PrintCoverage) -> PrintCoverage {
    coverage.status = print_status(
        coverage.job_to,
        coverage.backfill_to,
        coverage.live_to,
        coverage.venue_oldest_ts,
    )
    .to_string();
    coverage
}

/// One word for a client deciding whether to keep asking: `backfilling` while a job
/// owns the window, `backfilled` where history was pulled in, `live` where only the
/// stream has data, `empty` where nothing is stored.
fn print_status(
    job_to: Option<i64>,
    backfill_to: Option<i64>,
    live_to: Option<i64>,
    venue_oldest_ts: Option<i64>,
) -> &'static str {
    if job_to.is_some() {
        "backfilling"
    } else if backfill_to.is_some() {
        "backfilled"
    } else if live_to.is_some() {
        "live"
    } else if venue_oldest_ts.is_some() {
        "empty"
    } else {
        "unknown"
    }
}

/// Adds the `source` column to a `trades` table written before print backfill existed.
/// Every print in such a database came from the live stream, which is the default.
fn migrate_print_sources(conn: &Connection) -> Result<(), StoreError> {
    let columns: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('trades') WHERE name = 'source'",
        [],
        |row| row.get(0),
    )?;
    if columns == 0 {
        conn.execute_batch(
            "ALTER TABLE trades ADD COLUMN source TEXT NOT NULL DEFAULT 'live'",
        )?;
    }
    Ok(())
}

fn venue_tag(venue: Venue) -> String {
    match venue {
        Venue::Binance => "BINANCE",
        Venue::Bybit => "BYBIT",
        Venue::Okx => "OKX",
        Venue::Kraken => "KRAKEN",
        Venue::Coinbase => "COINBASE",
        Venue::Tradovate => "TRADOVATE",
        Venue::InteractiveBrokers => "IBKR",
        Venue::Simulation => "SIM",
    }
    .to_string()
}

fn venue_from_tag(tag: String) -> Venue {
    match tag.as_str() {
        "BYBIT" => Venue::Bybit,
        "OKX" => Venue::Okx,
        "KRAKEN" => Venue::Kraken,
        "COINBASE" => Venue::Coinbase,
        "TRADOVATE" => Venue::Tradovate,
        "IBKR" => Venue::InteractiveBrokers,
        "SIM" => Venue::Simulation,
        _ => Venue::Binance,
    }
}

fn asset_class_tag(class: AssetClass) -> String {
    match class {
        AssetClass::Equity => "equity",
        AssetClass::Etf => "etf",
        AssetClass::Index => "index",
        AssetClass::Future => "future",
        AssetClass::Option => "option",
        AssetClass::CryptoSpot => "crypto-spot",
        AssetClass::Perpetual => "perpetual",
        AssetClass::Forex => "forex",
        AssetClass::Prediction => "prediction",
        AssetClass::Treasury => "treasury",
        AssetClass::Other => "other",
    }
    .to_string()
}

fn asset_class_from_tag(tag: String) -> AssetClass {
    match tag.as_str() {
        "equity" => AssetClass::Equity,
        "etf" => AssetClass::Etf,
        "index" => AssetClass::Index,
        "future" => AssetClass::Future,
        "option" => AssetClass::Option,
        "crypto-spot" => AssetClass::CryptoSpot,
        "perpetual" => AssetClass::Perpetual,
        "forex" => AssetClass::Forex,
        "prediction" => AssetClass::Prediction,
        "treasury" => AssetClass::Treasury,
        _ => AssetClass::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "BINANCE:BTCUSDT";
    const HOUR: i64 = 3_600_000;

    fn print(ts: i64, seq: u64, side: Side) -> Trade {
        Trade { ts, seq, price: 100.0, qty: 1.0, aggressor: side }
    }

    #[test]
    fn live_and_backfilled_ranges_are_recorded_apart() {
        let db = Db::in_memory().expect("in-memory store");
        let live = [print(2_000, 500, Side::Buy), print(2_001, 501, Side::Sell)];
        assert_eq!(db.record_trades(ID, &live).expect("live prints"), 2);
        let page = BackfillPage {
            trades: vec![print(900, 300, Side::Buy), print(1_000, 400, Side::Sell)],
            span: Some((850, 1_000)),
            agg_ids: Some((90, 91)),
        };
        assert_eq!(db.record_backfill_page(ID, &page).expect("backfill page"), 2);

        let coverage = db.print_coverage(ID).expect("coverage");
        assert_eq!((coverage.live_from, coverage.live_to), (Some(2_000), Some(2_001)));
        assert_eq!((coverage.live_min_seq, coverage.live_max_seq), (Some(500), Some(501)));
        assert_eq!((coverage.backfill_from, coverage.backfill_to), (Some(900), Some(1_000)));
        assert_eq!((coverage.backfill_min_id, coverage.backfill_max_id), (Some(90), Some(91)));
        assert_eq!(coverage.status, "backfilled");
        assert_eq!(coverage.instrument, ID);
        // The live batch and the page touch inside the merge slack, so they read as one
        // filled range; the page's span reaches back to 850, which the rows alone would
        // not have proved.
        assert_eq!(
            coverage.spans.iter().map(|s| (s.from, s.to)).collect::<Vec<_>>(),
            vec![(850, 2_001)]
        );
    }

    #[test]
    fn ranges_apart_by_more_than_the_merge_gap_stay_separate() {
        let db = Db::in_memory().expect("in-memory store");
        db.record_trades(ID, &[print(0, 1, Side::Buy)]).expect("first session");
        db.record_trades(ID, &[print(4 * HOUR, 2, Side::Buy)]).expect("second session");
        let coverage = db.print_coverage(ID).expect("coverage");
        assert_eq!(
            coverage.spans.iter().map(|s| (s.from, s.to)).collect::<Vec<_>>(),
            vec![(0, 0), (4 * HOUR, 4 * HOUR)],
            "a min/max pair would hide the hole between two streaming sessions"
        );
        // A page landing in the hole closes it and the three ranges join up.
        db.record_backfill_page(
            ID,
            &BackfillPage {
                trades: vec![print(2 * HOUR, 900, Side::Sell)],
                span: Some((0, 4 * HOUR)),
                agg_ids: Some((5, 5)),
            },
        )
        .expect("hole filled");
        assert_eq!(
            db.print_coverage(ID).expect("coverage").spans,
            vec![PrintSpan { from: 0, to: 4 * HOUR }]
        );
    }

    #[test]
    fn a_page_that_answers_nothing_records_the_window_as_answered() {
        let db = Db::in_memory().expect("in-memory store");
        let answered = db
            .record_backfill_page(
                ID,
                &BackfillPage {
                    trades: Vec::new(),
                    span: Some((1_000, 60_000)),
                    agg_ids: None,
                },
            )
            .expect("empty page");
        assert_eq!(answered, 0);
        let coverage = db.print_coverage(ID).expect("coverage");
        assert_eq!(coverage.spans, vec![PrintSpan { from: 1_000, to: 60_000 }]);
        assert_eq!(coverage.backfill_from, None, "no prints, so no backfilled range");
    }

    #[test]
    fn a_print_already_stored_live_is_not_counted_twice() {
        let db = Db::in_memory().expect("in-memory store");
        let live = [print(2_000, 500, Side::Buy), print(2_001, 501, Side::Sell)];
        db.record_trades(ID, &live).expect("live prints");
        // An overlapping venue page: one row the stream already delivered, one new.
        let page = BackfillPage {
            trades: vec![print(2_000, 500, Side::Buy), print(1_999, 499, Side::Sell)],
            span: Some((1_999, 2_000)),
            agg_ids: Some((80, 81)),
        };
        assert_eq!(db.record_backfill_page(ID, &page).expect("page"), 1);
        assert_eq!(db.trades(ID, None, None, 100).expect("prints").len(), 3);
        assert_eq!(db.print_coverage(ID).expect("coverage").live_min_seq, Some(500));
    }

    #[test]
    fn coverage_is_derived_from_prints_when_no_row_exists() {
        let db = Db::in_memory().expect("in-memory store");
        db.record_trades(ID, &[print(500, 7, Side::Buy)]).expect("live print");
        // A database written before backfill existed has prints but no coverage row.
        let connection = db.lock().expect("connection");
        connection.execute("DELETE FROM print_coverage", []).expect("clear coverage");
        connection.execute("DELETE FROM print_spans", []).expect("clear spans");
        drop(connection);
        let coverage = db.print_coverage(ID).expect("derived coverage");
        assert_eq!((coverage.live_from, coverage.live_to), (Some(500), Some(500)));
        assert_eq!(coverage.live_min_seq, Some(7));
        assert_eq!(coverage.status, "live");
        assert_eq!(coverage.spans, vec![PrintSpan { from: 500, to: 500 }]);
    }

    #[test]
    fn ranges_are_recovered_when_only_the_coverage_row_exists() {
        let db = Db::in_memory().expect("in-memory store");
        db.record_trades(ID, &[print(0, 1, Side::Buy)]).expect("first session");
        db.record_trades(ID, &[print(4 * HOUR, 2, Side::Buy)]).expect("second session");
        // A store written by a build that recorded bounds but no ranges: the row is
        // there, so nothing else would notice the ranges are missing.
        db.lock().expect("connection").execute("DELETE FROM print_spans", []).expect("clear ranges");
        let coverage = db.print_coverage(ID).expect("coverage");
        assert_eq!(
            coverage.spans,
            vec![PrintSpan { from: 0, to: 0 }, PrintSpan { from: 4 * HOUR, to: 4 * HOUR }],
            "the hole between two streaming sessions is recovered from the prints"
        );
    }

    #[test]
    fn a_backfill_claim_is_held_until_its_lease_expires() {
        let db = Db::in_memory().expect("in-memory store");
        let lease = 1_000;
        let claim = |from: i64, to: i64, now: i64| {
            db.claim_print_backfill(ID, from, to, now, now - lease).expect("claim")
        };
        assert_eq!(claim(1_000, 2_000, 10_000), Some((1_000, 2_000)));
        // A wider window asked for while a job runs widens that job, it does not
        // start a second download of the same range.
        assert_eq!(claim(500, 1_500, 10_500), None);
        let coverage = db.print_coverage(ID).expect("coverage");
        assert_eq!((coverage.job_from, coverage.job_to), (Some(500), Some(2_000)));
        assert_eq!(coverage.status, "backfilling");

        // A claim nobody renewed is a dead worker: once its lease lapses the next
        // request takes the window over.
        assert_eq!(claim(0, 400, 13_000), Some((0, 400)));
        db.finish_print_backfill(ID, 14_000).expect("finish");
        assert_eq!(db.print_coverage(ID).expect("coverage").status, "unknown");
    }

    #[test]
    fn the_venue_floor_is_remembered_once() {
        let db = Db::in_memory().expect("in-memory store");
        db.note_venue_print_floor(ID, 1_000, 10).expect("floor");
        db.note_venue_print_floor(ID, 2_000, 20).expect("later floor");
        let coverage = db.print_coverage(ID).expect("coverage");
        assert_eq!(coverage.venue_oldest_ts, Some(1_000), "the first answer is the real floor");
        assert_eq!(coverage.status, "empty");
    }

    #[test]
    fn coverage_lists_every_instrument_with_prints() {
        let db = Db::in_memory().expect("in-memory store");
        db.record_trades(ID, &[print(1, 1, Side::Buy)]).expect("first");
        db.record_trades("BYBIT:ETHUSDT", &[print(2, 2, Side::Sell)]).expect("second");
        let all = db.print_coverage_all().expect("all coverage");
        assert_eq!(
            all.iter().map(|c| c.instrument.as_str()).collect::<Vec<_>>(),
            vec!["BINANCE:BTCUSDT", "BYBIT:ETHUSDT"]
        );
    }

    /// A store file in the temp directory, for the one test that has to close the database
    /// and open it again the way a server restart does.
    fn temp_store(tag: &str) -> std::path::PathBuf {
        let unique = format!("chartkit-{tag}-{}-{}", std::process::id(), chartkit_core::new_id(""));
        std::env::temp_dir().join(format!("{unique}.db"))
    }

    fn drop_store(path: &std::path::Path) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    /// A print at a chosen price; the module's own helper fixes the price at 100.
    fn print_at(ts: i64, price: f64, side: Side) -> Trade {
        Trade { ts, seq: ts as u64, price, qty: 1.0, aggressor: side }
    }

    fn bar_at(start: i64, volume: f64, closed: bool) -> Bar {
        Bar { start, open: 100.0, high: 101.0, low: 99.0, close: 100.0, volume, trades: 4, closed }
    }

    #[test]
    fn the_streamed_print_window_matches_the_collected_one() {
        let db = Db::in_memory().expect("in-memory store");
        let prints: Vec<Trade> = (0..40)
            .map(|i| print(i * 100, i as u64, if i % 2 == 0 { Side::Buy } else { Side::Sell }))
            .collect();
        db.record_trades(ID, &prints).expect("prints");

        let windows = [
            (None, None, 40),
            (None, None, 7),
            (None, None, 1),
            (Some(0), Some(4_000), 39),
            (Some(1_000), Some(2_600), 5),
            (Some(1_000), Some(2_600), 100),
            (Some(9_000), Some(9_500), 3),
        ];
        for (from, to, limit) in windows {
            let want = db.trades(ID, from, to, limit).expect("collected window");
            let mut got: Vec<Trade> = Vec::new();
            let seen = db
                .trades_window(ID, from, to, limit, |trade| {
                    got.push(*trade);
                    Ok(())
                })
                .expect("streamed window");
            assert_eq!(got, want, "streamed differs from collected: {from:?}..{to:?} limit {limit}");
            assert_eq!(seen as usize, want.len(), "row count for {from:?}..{to:?} limit {limit}");
        }
    }

    #[test]
    fn both_print_window_reads_walk_the_primary_key() {
        let db = Db::in_memory().expect("in-memory store");
        let plans = db.print_read_plans().expect("query plans");
        for (read, plan) in [("collected", plans.split(" || ").next().unwrap_or("")), ("streamed", plans.split(" || ").last().unwrap_or(""))] {
            assert!(!plan.contains("SCAN TABLE trades"), "the {read} read scans every print: {plan}");
            assert!(
                plan.contains("PRIMARY KEY") || plan.contains("USING INDEX"),
                "the {read} read does not use the (instrument, ts, seq) key: {plan}"
            );
        }
    }

    #[test]
    fn fire_history_keeps_the_newest_and_forgets_the_oldest() {
        let db = Db::in_memory().expect("in-memory store");
        let rule = Alert::new(ID, AlertKind::PriceAbove, 100.0);
        for hour in 0..FIRE_HISTORY_ROWS + 25 {
            let fire = AlertFire::from_alert(&rule, 105.0, 1_000 + hour * HOUR, None, false);
            db.record_alert_fire(&fire).expect("record fire");
        }
        let kept = db.alert_fires(None, FIRE_HISTORY_ROWS + 100).expect("history");
        assert_eq!(kept.len() as i64, FIRE_HISTORY_ROWS, "history outgrew its bound");
        assert_eq!(
            kept.first().expect("newest fire").ts,
            1_000 + (FIRE_HISTORY_ROWS + 24) * HOUR,
            "the newest fire has to survive the trim"
        );
        assert_eq!(kept.last().expect("oldest fire").ts, 1_000 + 25 * HOUR, "the oldest fires went first");
    }

    #[test]
    fn rules_and_their_fires_survive_the_store_being_reopened() {
        let path = temp_store("alerts");
        drop_store(&path);
        let frame = Timeframe::Minute(5);
        let mut rule = Alert::new(ID, AlertKind::PriceInRange, 100.0);
        rule.threshold_high = Some(120.0);
        rule.timeframe = Some(frame);
        rule.rearm_gap = 1.5;
        rule.label = "back inside the range".into();
        rule.muted = true;
        let id = rule.id.clone();
        let fire = AlertFire::from_alert(&rule, 121.0, 7_000, Some(6_900), true);
        {
            let db = Db::open(&path).expect("open store");
            db.insert_alert(&rule).expect("insert rule");
            db.note_alert_state(&id, false, Some(7_000)).expect("crossing state");
            db.record_alert_fire(&fire).expect("record fire");
            db.record_trades(ID, &[print_at(5_000, 96.0, Side::Buy), print_at(5_001, 121.0, Side::Sell)])
                .expect("prints");
            db.upsert_bars(ID, &frame.as_key(), &[bar_at(60_000, 900.0, true), bar_at(90_000, 40.0, false)])
                .expect("bars");
            rule.armed = false;
            rule.last_fired_at = Some(7_000);
        }

        let db = Db::open(&path).expect("reopen after a restart");
        assert_eq!(db.alert(&id).expect("rule").expect("rule"), rule, "every field comes back");
        assert_eq!(db.alerts().expect("rules"), vec![rule.clone()]);
        assert_eq!(db.alert_fires(None, 10).expect("history"), vec![fire], "history keeps the condition it fired on");
        assert_eq!(db.newest_print(ID).expect("newest print"), Some((121.0, 5_001)));
        let newest = db.newest_closed_bar(ID, &frame.as_key()).expect("newest bar").expect("a closed bar");
        assert_eq!((newest.start, newest.volume), (60_000, 900.0), "the open bar is not a closed one");
        assert_eq!(db.alert_fires(Some("BYBIT:ETHUSDT"), 10).expect("other symbol").len(), 0);
        assert_eq!(db.clear_alert_fires().expect("clear"), 1);
        assert!(db.alert_fires(None, 10).expect("history").is_empty());
        assert!(db.alert(&id).expect("rule").is_some(), "clearing history leaves the rules alone");
        drop(db);
        drop_store(&path);
    }

    #[test]
    fn rules_are_listed_newest_first_and_an_edit_replaces_the_condition() {
        let db = Db::in_memory().expect("in-memory store");
        let older = Alert::new(ID, AlertKind::PriceBelow, 90.0);
        let newer = Alert::new(ID, AlertKind::VolumeAbove, 500.0);
        db.insert_alert(&older).expect("older rule");
        db.insert_alert(&newer).expect("newer rule");
        assert_eq!(
            db.alerts().expect("rules").iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            vec![newer.id.as_str(), older.id.as_str()],
            "the newest rule made is the first one listed"
        );

        let mut edited = older.clone();
        edited.kind = AlertKind::PriceInRange;
        edited.threshold = 100.0;
        edited.threshold_high = Some(110.0);
        edited.enabled = false;
        edited.armed = true;
        edited.updated_at = older.created_at + 1_000;
        assert!(db.update_alert(&edited).expect("update"));
        assert_eq!(db.alert(&older.id).expect("rule").expect("rule"), edited);
        assert_eq!(db.alert(&older.id).expect("rule").expect("rule").created_at, older.created_at);
        assert!(!db.update_alert(&Alert { id: "missing".into(), ..older.clone() }).expect("missing update"));

        assert!(db.delete_alert(&newer.id).expect("delete"));
        assert!(!db.delete_alert(&newer.id).expect("delete twice"));
        assert_eq!(db.alerts().expect("rules").len(), 1);
        assert!(db.alert("nope").expect("missing rule").is_none());
        assert_eq!(db.newest_print(ID).expect("no prints"), None);
        assert!(db.newest_closed_bar(ID, "5m").expect("no bars").is_none());
    }
}
