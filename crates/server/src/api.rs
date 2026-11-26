//! REST surface: history, order-flow aggregates, symbol search and workspaces.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chartkit_core::{
    new_id, Alert, AlertKind, AssetClass, FootprintSeries, FootprintSeriesBuilder, SizeBand,
    SizeBandBar, SizeBandCell, SizeBandLevel, SizeBandSeries, SizeUnit, Timeframe, VolumeProfile,
    VolumeProfileBuilder,
};
use chartkit_ingest::credentials::venue_from_slug;
use chartkit_store::{BarFilter, SizeBandRow, StoreError};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

/// Every handler failure in one type, so status codes stay consistent and the
/// message still reaches the status strip instead of killing the chart.
#[derive(Debug)]
pub enum ApiError {
    Store(StoreError),
    Json(serde_json::Error),
    NotFound(String),
    BadRequest(String),
    /// A blocking read task panicked or was cancelled.
    Task(String),
}

impl From<StoreError> for ApiError {
    fn from(value: StoreError) -> Self {
        Self::Store(value)
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, reason) = match self {
            ApiError::Store(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
            ApiError::Json(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
            ApiError::Task(error) => (StatusCode::INTERNAL_SERVER_ERROR, error),
            ApiError::NotFound(reason) => (StatusCode::NOT_FOUND, reason),
            ApiError::BadRequest(reason) => (StatusCode::BAD_REQUEST, reason),
        };
        (status, reason).into_response()
    }
}

/// Every routable venue, whether it has credentials, and which fields it needs. Secrets
/// are reported as set or unset; their values never leave the server.
pub async fn feeds(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "venues": state.feeds.statuses(),
        "credentialFile": state.feeds.data_dir().join("feeds.json"),
    })))
}

#[derive(Deserialize)]
pub struct FeedPatch {
    pub venue: String,
    #[serde(default)]
    pub values: std::collections::BTreeMap<String, String>,
}

/// Save credentials typed into the settings panel. An empty value clears that field.
pub async fn save_feeds(
    State(state): State<AppState>,
    Json(patch): Json<FeedPatch>,
) -> Result<Json<Value>, ApiError> {
    let venue = venue_from_slug(&patch.venue)
        .ok_or_else(|| ApiError::BadRequest(format!("unknown venue {}", patch.venue)))?;
    let statuses = state
        .feeds
        .save(venue, &patch.values)
        .map_err(ApiError::BadRequest)?;
    Ok(Json(json!({ "venues": statuses })))
}

pub async fn health(State(state): State<AppState>) -> Json<Value> {
    let coverage = state.db.coverage().unwrap_or_default();
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "time": chartkit_core::now_ms(),
        "coverage": coverage,
    }))
}

/// Global counts plus the per-instrument print ranges, so a client can tell a
/// backfilled window from a live one and stop asking for ranges the venue lacks.
pub async fn coverage(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let mut value = serde_json::to_value(state.db.coverage()?)?;
    let ranges = serde_json::to_value(state.db.print_coverage_all()?)?;
    if let Some(object) = value.as_object_mut() {
        object.insert("printCoverage".to_string(), ranges);
    }
    Ok(Json(value))
}

#[derive(Deserialize)]
pub struct InstrumentQuery {
    #[serde(default)]
    pub class: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
}

pub async fn instruments(
    State(state): State<AppState>,
    Query(query): Query<InstrumentQuery>,
) -> Result<Json<Value>, ApiError> {
    let class = match query.class.as_deref() {
        None | Some("") => None,
        Some("crypto-spot") => Some(AssetClass::CryptoSpot),
        Some("equity") => Some(AssetClass::Equity),
        Some("etf") => Some(AssetClass::Etf),
        Some("index") => Some(AssetClass::Index),
        Some("future") => Some(AssetClass::Future),
        Some("option") => Some(AssetClass::Option),
        Some("perpetual") => Some(AssetClass::Perpetual),
        Some("forex") => Some(AssetClass::Forex),
        Some("prediction") => Some(AssetClass::Prediction),
        Some("treasury") => Some(AssetClass::Treasury),
        Some(other) => return Err(ApiError::BadRequest(format!("unknown asset class {other}"))),
    };
    let items = state
        .db
        .instruments(class, query.q.as_deref())
        .map_err(ApiError::from)?;
    Ok(Json(json!({ "count": items.len(), "items": items })))
}

#[derive(Deserialize)]
pub struct BarQuery {
    pub instrument: String,
    #[serde(default = "default_timeframe")]
    pub timeframe: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<i64>,
}

fn default_timeframe() -> String {
    "1m".into()
}

/// Candles are bounded by the window, not by a plan: raise `limit` as far as the
/// data goes.
pub async fn bars(
    State(state): State<AppState>,
    Query(query): Query<BarQuery>,
) -> Result<Json<Value>, ApiError> {
    let timeframe = query
        .timeframe
        .parse::<Timeframe>()
        .map_err(ApiError::BadRequest)?;
    let limit = query.limit.unwrap_or(2000).clamp(1, 200_000);
    let bars = state
        .db
        .bars(BarFilter {
            instrument: query.instrument.clone(),
            timeframe,
            from: query.from,
            to: query.to,
            limit,
        })
        .map_err(ApiError::from)?;
    Ok(Json(json!({
        "instrument": query.instrument,
        "timeframe": timeframe.as_key(),
        "bars": bars,
    })))
}

#[derive(Deserialize)]
pub struct TradeQuery {
    pub instrument: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<i64>,
}

pub async fn trades(
    State(state): State<AppState>,
    Query(query): Query<TradeQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = query.limit.unwrap_or(5000).clamp(1, 200_000);
    if let (Some(from), Some(to), Some(instrument)) = (
        query.from,
        query.to,
        state.db.instrument(&query.instrument).map_err(ApiError::from)?,
    ) {
        // Fire-and-forget: the tape pane follows the newest prints, so it should not
        // wait on a history pull to show what is already stored.
        state.prints.request(&instrument, from, to);
    }
    let rows = state.db.trades(&query.instrument, query.from, query.to, limit)?;
    Ok(Json(json!({ "instrument": query.instrument, "trades": rows })))
}

#[derive(Deserialize)]
pub struct FlowQuery {
    pub instrument: String,
    #[serde(default = "default_timeframe")]
    pub timeframe: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
    /// Bars to return; prints are read back far enough to fill them.
    pub limit: Option<i64>,
}

/// Prints one returned bar may fold. The scan cap is a limit on work, not on memory:
/// the prints are streamed into the builder, so a wide window costs time rather than a
/// copy of itself in RAM.
fn print_scan_cap(bars: i64) -> i64 {
    bars.saturating_mul(PRINTS_PER_BAR).min(PRINTS_PER_REQUEST)
}

const PRINTS_PER_BAR: i64 = 40_000;
const PRINTS_PER_REQUEST: i64 = 4_000_000;

/// Bid x ask footprint rebuilt from stored prints. Delta and CVD are relative to
/// the returned window, not to all stored history.
pub async fn footprint(
    State(state): State<AppState>,
    Query(query): Query<FlowQuery>,
) -> Result<Json<Value>, ApiError> {
    let timeframe = query.timeframe.parse::<Timeframe>().map_err(ApiError::BadRequest)?;
    let limit = query.limit.unwrap_or(120).clamp(1, 5000);
    let instrument = state
        .db
        .instrument(&query.instrument)
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::NotFound(format!("no instrument {}", query.instrument)))?;
    let price_tick = instrument.price_tick;
    if let (Some(from), Some(to)) = (query.from, query.to) {
        state.prints.request_covering(&instrument, from, to).await;
    }
    let state = state.clone();
    let id = query.instrument.clone();
    let (bars, cvd) = tokio::task::spawn_blocking(move || -> Result<(Vec<chartkit_core::FootprintBar>, Vec<f64>), StoreError> {
        let mut builder = FootprintSeriesBuilder::new(timeframe, price_tick);
        state.db.trades_window(&id, query.from, query.to, print_scan_cap(limit), |print| {
            builder.on_trade(print);
            Ok(())
        })?;
        let (mut bars, mut cvd) = builder.finish();
        if bars.len() > limit as usize {
            let cut = bars.len() - limit as usize;
            bars.drain(..cut);
            cvd.drain(..cut);
        }
        Ok((bars, cvd))
    })
    .await
    .map_err(|e| ApiError::Task(e.to_string()))?
    .map_err(ApiError::from)?;
    let series = FootprintSeries {
        instrument: query.instrument,
        timeframe,
        price_tick,
        bars,
        cvd,
    };
    Ok(Json(serde_json::to_value(series)?))
}

#[derive(Deserialize)]
pub struct ProfileQuery {
    pub instrument: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
    /// Bars the window spans; prints are read back far enough to fill them.
    pub limit: Option<i64>,
    /// Fraction of volume the value area must cover.
    #[serde(default, rename = "valueArea")]
    pub value_area: Option<f64>,
    /// Bucket width as a multiple of the venue tick. Absent or 1 keeps per-tick buckets.
    /// `tickMultiplier` is accepted as a second name for the same thing.
    #[serde(default, alias = "tickMultiplier")]
    pub ticks: Option<i64>,
    /// Bucket width as a price, e.g. `step=50` for rows 50 quote units wide. Takes
    /// precedence over `ticks`.
    #[serde(default)]
    pub step: Option<f64>,
}

/// Bucket width in venue ticks. A step below one tick, or neither parameter, keeps
/// the venue's own price grid, which is what the profile pane asked for until now.
fn profile_step_ticks(step: Option<f64>, ticks: Option<i64>, price_tick: f64) -> Result<i64, ApiError> {
    if let Some(step) = step {
        if !step.is_finite() || step <= 0.0 {
            return Err(ApiError::BadRequest(format!("step must be a positive price, got {step}")));
        }
        if price_tick <= 0.0 {
            return Ok(1);
        }
        return Ok(((step / price_tick).round() as i64).max(1));
    }
    if let Some(ticks) = ticks {
        if ticks < 1 {
            return Err(ApiError::BadRequest(format!("ticks must be at least 1, got {ticks}")));
        }
        return Ok(ticks);
    }
    Ok(1)
}

pub async fn profile(
    State(state): State<AppState>,
    Query(query): Query<ProfileQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = query.limit.unwrap_or(200).clamp(1, 5000);
    let value_area = query.value_area.unwrap_or(0.7).clamp(0.05, 1.0);
    let instrument = state
        .db
        .instrument(&query.instrument)
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::NotFound(format!("no instrument {}", query.instrument)))?;
    let price_tick = instrument.price_tick;
    let step_ticks = profile_step_ticks(query.step, query.ticks, price_tick)?;
    if let (Some(from), Some(to)) = (query.from, query.to) {
        state.prints.request_covering(&instrument, from, to).await;
    }
    let state = state.clone();
    let profile = tokio::task::spawn_blocking(move || -> Result<VolumeProfile, StoreError> {
        let mut builder = VolumeProfileBuilder::with_step(price_tick, step_ticks);
        state.db.trades_window(
            &query.instrument,
            query.from,
            query.to,
            print_scan_cap(limit),
            |print| {
                builder.on_trade(print);
                Ok(())
            },
        )?;
        Ok(builder.build(&query.instrument, value_area))
    })
    .await
    .map_err(|e| ApiError::Task(e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(serde_json::to_value(profile)?))
}

// ---------------------------------------------------------------- size bands

/// Default size ladder, in quote currency per print: a coffee, a tank of gas, a house.
/// Notional is the unit the bands default to because the same three numbers mean the same
/// thing on BTC, on SOL and on a stock, and because the ladder does not move when the
/// window moves — quantiles of the window would re-cut the bands on every pan, which
/// makes a chart of them unreadable. The edges are the server's, and they travel with the
/// answer so the client prints them instead of rebuilding them.
const DEFAULT_SIZE_EDGES: &[f64] = &[1_000.0, 10_000.0, 100_000.0];

/// Named ladders, so a client asks for a size of print by name and still gets edges it did
/// not invent. `standard` is `DEFAULT_SIZE_EDGES`.
const SIZE_LADDERS: &[(&str, &[f64])] = &[
    ("small", &[100.0, 1_000.0, 10_000.0]),
    ("standard", DEFAULT_SIZE_EDGES),
    ("block", &[10_000.0, 100_000.0, 1_000_000.0]),
];

/// Band edges the aggregation will accept. Each edge is one band, one plot line and one
/// column of the grid, so a long list is a chart nobody can read.
const SIZE_EDGE_MAX: usize = 8;

#[derive(Deserialize)]
pub struct SizeBandQuery {
    pub instrument: String,
    #[serde(default = "default_timeframe")]
    pub timeframe: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
    /// Bars to return; the window is aggregated whole, then trimmed to the newest bars.
    pub limit: Option<i64>,
    /// `bars` (default), `levels`, or `both`. Only the section asked for costs a scan.
    #[serde(default)]
    pub view: Option<String>,
    /// Named ladder (`standard`, `small`, `block`) or explicit ascending edges.
    #[serde(default)]
    pub bands: Option<String>,
    /// `notional` (default) or `quantity`.
    #[serde(default)]
    pub unit: Option<String>,
    /// Level row width in venue ticks, for the `levels` view. Same meaning as on
    /// `/api/profile`.
    #[serde(default, alias = "tickMultiplier")]
    pub ticks: Option<i64>,
    /// Level row width as a price; takes precedence over `ticks`.
    #[serde(default)]
    pub step: Option<f64>,
}

/// Which sections of the answer a caller wants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SizeBandView {
    Bars,
    Levels,
    Both,
}

/// Milliseconds in one bar, for the intervals the aggregation can group prints by.
/// Calendar and count-based intervals align on rules SQL cannot divide its way through,
/// so they are refused rather than quietly answered with nominal spans.
fn bar_span_ms(timeframe: Timeframe) -> Result<i64, ApiError> {
    match timeframe {
        Timeframe::Second(_) | Timeframe::Minute(_) | Timeframe::Hour(_) | Timeframe::Day(_) => {
            timeframe.duration_ms().ok_or_else(|| ApiError::BadRequest(format!("{timeframe} has no fixed span")))
        }
        other => Err(ApiError::BadRequest(format!(
            "size bands group prints by time interval; {other} is not one"
        ))),
    }
}

/// The band edges to aggregate with, and the sentence that says how they were chosen.
fn size_edges(
    spec: Option<&str>,
    unit: SizeUnit,
) -> Result<(Vec<f64>, String), ApiError> {
    let measure = match unit {
        SizeUnit::Notional => "quote notional per print",
        SizeUnit::Quantity => "quantity per print",
    };
    let (edges, named) = match spec.filter(|s| !s.is_empty()) {
        None => (DEFAULT_SIZE_EDGES.to_vec(), Some("standard".to_string())),
        Some(spec) if spec.contains(',') => {
            let edges = spec
                .split(',')
                .map(|edge| {
                    let value: f64 = edge
                        .trim()
                        .parse()
                        .map_err(|_| ApiError::BadRequest(format!("band edge {edge} is not a number")))?;
                    if !value.is_finite() || value <= 0.0 {
                        return Err(ApiError::BadRequest(format!("band edge {value} must be a positive number")));
                    }
                    Ok(value)
                })
                .collect::<Result<Vec<_>, _>>()?;
            validate_edges(&edges)?;
            (edges, None)
        }
        Some(name) => {
            let (_, edges) = SIZE_LADDERS
                .iter()
                .find(|(ladder, _)| ladder.eq_ignore_ascii_case(name.trim()))
                .ok_or_else(|| {
                    ApiError::BadRequest(format!(
                        "unknown band ladder {name}; try {}",
                        SIZE_LADDERS.iter().map(|(ladder, _)| *ladder).collect::<Vec<_>>().join(", ")
                    ))
                })?;
            (edges.to_vec(), Some(name.trim().to_ascii_lowercase()))
        }
    };
    if unit == SizeUnit::Quantity && named.is_some() {
        return Err(ApiError::BadRequest(
            "the named ladders are quote amounts; spell out the quantity edges you want, e.g. bands=0.1,1,10".into(),
        ));
    }
    let rule = match named {
        Some(ladder) => format!("named ladder {ladder}: {measure}, {edges}", edges = edge_list(&edges)),
        None => format!("caller's own edges: {measure}, {edges}", edges = edge_list(&edges)),
    };
    Ok((edges, rule))
}

fn validate_edges(edges: &[f64]) -> Result<(), ApiError> {
    if edges.is_empty() || edges.len() > SIZE_EDGE_MAX {
        return Err(ApiError::BadRequest(format!(
            "between 1 and {SIZE_EDGE_MAX} band edges are accepted, got {}",
            edges.len()
        )));
    }
    if edges.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(ApiError::BadRequest(format!(
            "band edges must ascend, got {}",
            edge_list(edges)
        )));
    }
    Ok(())
}

fn edge_list(edges: &[f64]) -> String {
    edges.iter().map(|edge| fmt_band_number(*edge)).collect::<Vec<_>>().join(" / ")
}

/// A band edge written the way a trader reads one: 1k, 10k, 2.5M.
fn fmt_band_number(value: f64) -> String {
    let short = |value: f64, scale: f64, suffix: &str| -> String {
        let scaled = value / scale;
        let text = if scaled == scaled.round() {
            format!("{:.0}", scaled)
        } else {
            format!("{scaled:.1}")
        };
        format!("{text}{suffix}")
    };
    if value >= 1_000_000_000.0 {
        short(value, 1_000_000_000.0, "B")
    } else if value >= 1_000_000.0 {
        short(value, 1_000_000.0, "M")
    } else if value >= 1_000.0 {
        short(value, 1_000.0, "k")
    } else if value == value.round() {
        format!("{:.0}", value)
    } else {
        format!("{value}")
    }
}

/// Band 0 takes everything under the first edge, the top band everything at or above the
/// last. A print exactly on an edge belongs to the band above it, which is the same rule
/// the SQL `CASE` applies.
fn band_labels(edges: &[f64]) -> Vec<SizeBand> {
    edges
        .iter()
        .enumerate()
        .map(|(index, edge)| SizeBand {
            min: if index == 0 { None } else { Some(edges[index - 1]) },
            max: Some(*edge),
            label: if index == 0 {
                format!("under {}", fmt_band_number(*edge))
            } else {
                format!("{} to {}", fmt_band_number(edges[index - 1]), fmt_band_number(*edge))
            },
        })
        .chain(std::iter::once(SizeBand {
            min: edges.last().copied(),
            max: None,
            label: format!("{} and up", fmt_band_number(*edges.last().expect("an empty edge list is refused"))),
        }))
        .collect()
}

/// Folds aggregated `(group, band)` rows into one dense cell list per group. A group with
/// no prints in one band still carries a zero for it, so the client can index by band
/// without checking whether the answer was dense.
fn fold_size_bands(rows: &[SizeBandRow], bands: usize) -> Vec<(i64, Vec<SizeBandCell>)> {
    let mut out: Vec<(i64, Vec<SizeBandCell>)> = Vec::new();
    for row in rows {
        // The SQL CASE can only name a band inside the ladder; anything else is a row this
        // answer has nowhere to put, so it is dropped rather than folded into band 0.
        let Ok(band) = usize::try_from(row.band) else { continue };
        if band >= bands {
            continue;
        }
        let cells = match out.last_mut() {
            Some((group, cells)) if *group == row.group => cells,
            _ => {
                out.push((row.group, vec![SizeBandCell::default(); bands]));
                &mut out.last_mut().expect("just pushed").1
            }
        };
        cells[band] = SizeBandCell {
            buy_qty: row.buy_qty,
            sell_qty: row.sell_qty,
            buy_n: row.buy_n as u64,
            sell_n: row.sell_n as u64,
        };
    }
    out
}

/// Prints of a window split by order size. The bands are decided and aggregated in SQL,
/// so the answer is one row per (bar or level, band) whatever the window holds; the prints
/// themselves never leave the store.
pub async fn size_bands(
    State(state): State<AppState>,
    Query(query): Query<SizeBandQuery>,
) -> Result<Json<Value>, ApiError> {
    let timeframe = query.timeframe.parse::<Timeframe>().map_err(ApiError::BadRequest)?;
    let bar_ms = bar_span_ms(timeframe)?;
    let limit = query.limit.unwrap_or(240).clamp(1, 5_000);
    let unit = match query.unit.as_deref().filter(|u| !u.is_empty()) {
        None | Some("notional") => SizeUnit::Notional,
        Some("quantity") => SizeUnit::Quantity,
        Some(other) => {
            return Err(ApiError::BadRequest(format!("unknown size unit {other}; try notional or quantity")))
        }
    };
    let view = match query.view.as_deref().filter(|v| !v.is_empty()) {
        None | Some("bars") => SizeBandView::Bars,
        Some("levels") => SizeBandView::Levels,
        Some("both") => SizeBandView::Both,
        Some(other) => return Err(ApiError::BadRequest(format!("unknown view {other}; try bars, levels or both"))),
    };
    let (edges, band_rule) = size_edges(query.bands.as_deref(), unit)?;
    let labels = band_labels(&edges);
    let instrument = state
        .db
        .instrument(&query.instrument)
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::NotFound(format!("no instrument {}", query.instrument)))?;
    let price_tick = instrument.price_tick;
    let step_ticks = profile_step_ticks(query.step, query.ticks, price_tick)?;
    if let (Some(from), Some(to)) = (query.from, query.to) {
        state.prints.request_covering(&instrument, from, to).await;
    }

    let state = state.clone();
    let id = query.instrument.clone();
    let (from, to) = (query.from, query.to);
    let want_bars = view != SizeBandView::Levels;
    let want_levels = view != SizeBandView::Bars;
    let series = tokio::task::spawn_blocking(move || -> Result<SizeBandSeries, StoreError> {
        let band_rows = want_bars
            .then(|| state.db.size_band_bars(&id, from, to, &edges, unit, bar_ms))
            .transpose()?
            .unwrap_or_default();
        let level_rows = want_levels
            .then(|| state.db.size_band_levels(&id, from, to, &edges, unit, price_tick, step_ticks))
            .transpose()?
            .unwrap_or_default();
        Ok(assemble_size_bands(
            id,
            timeframe,
            from,
            to,
            price_tick,
            step_ticks,
            unit,
            band_rule,
            labels,
            band_rows,
            level_rows,
            limit,
        ))
    })
    .await
    .map_err(|e| ApiError::Task(e.to_string()))?
    .map_err(ApiError::from)?;
    Ok(Json(serde_json::to_value(series)?))
}

/// Turns aggregated rows into the answer: dense band lists per group, the running delta
/// per band across the returned bars, and the totals of what is actually on the way back.
///
/// The totals follow the bars when there are bars, because that is the window the caller
/// can see; a `levels` answer totals its own rows instead.
fn assemble_size_bands(
    instrument: String,
    timeframe: Timeframe,
    from: Option<i64>,
    to: Option<i64>,
    price_tick: f64,
    step_ticks: i64,
    unit: SizeUnit,
    band_rule: String,
    bands: Vec<SizeBand>,
    band_rows: Vec<SizeBandRow>,
    level_rows: Vec<SizeBandRow>,
    limit: i64,
) -> SizeBandSeries {
    let count = bands.len();
    let grouped = fold_size_bands(&band_rows, count);
    let oldest = grouped.len().saturating_sub(limit as usize);
    let mut running = vec![0.0f64; count];
    let bars: Vec<SizeBandBar> = grouped
        .iter()
        .skip(oldest)
        .map(|(start, cells)| {
            for (index, cell) in cells.iter().enumerate() {
                running[index] += cell.delta();
            }
            SizeBandBar {
                start: *start,
                cumulative: running.clone(),
                total_qty: cells.iter().map(SizeBandCell::total).sum(),
                delta: cells.iter().map(SizeBandCell::delta).sum(),
                trades: cells.iter().map(SizeBandCell::prints).sum(),
                bands: cells.clone(),
            }
        })
        .collect();
    let levels: Vec<SizeBandLevel> = fold_size_bands(&level_rows, count)
        .into_iter()
        .map(|(tick, cells)| SizeBandLevel {
            price: chartkit_core::tick_price(tick, price_tick),
            total_qty: cells.iter().map(SizeBandCell::total).sum(),
            delta: cells.iter().map(SizeBandCell::delta).sum(),
            trades: cells.iter().map(SizeBandCell::prints).sum(),
            bands: cells,
        })
        .collect();

    // The totals are summed out of the rows being returned, not out of the raw
    // aggregation, so what a caller reads as the window is what the rows add up to.
    let source: Vec<&[SizeBandCell]> = if bars.is_empty() {
        levels.iter().map(|level| level.bands.as_slice()).collect()
    } else {
        bars.iter().map(|bar| bar.bands.as_slice()).collect()
    };
    let mut totals = vec![SizeBandCell::default(); count];
    for cells in &source {
        for (index, cell) in cells.iter().enumerate() {
            totals[index].buy_qty += cell.buy_qty;
            totals[index].sell_qty += cell.sell_qty;
            totals[index].buy_n += cell.buy_n;
            totals[index].sell_n += cell.sell_n;
        }
    }
    SizeBandSeries {
        instrument,
        timeframe,
        from,
        to,
        price_tick,
        step_ticks,
        size_unit: unit,
        band_rule,
        bands,
        totals,
        prints: source.iter().flat_map(|cells| cells.iter()).map(SizeBandCell::prints).sum(),
        total_qty: source.iter().flat_map(|cells| cells.iter()).map(SizeBandCell::total).sum(),
        delta: source.iter().flat_map(|cells| cells.iter()).map(SizeBandCell::delta).sum(),
        bars,
        levels,
    }
}



/// A rule as a client sends it. The server owns the id, the timestamps and the crossing
/// state, so a draft carries only what the trader chooses.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertDraft {
    pub instrument: String,
    pub kind: AlertKind,
    pub threshold: f64,
    #[serde(default)]
    pub threshold_high: Option<f64>,
    #[serde(default)]
    pub timeframe: Option<Timeframe>,
    #[serde(default)]
    pub rearm_gap: Option<f64>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "rule_is_on")]
    pub enabled: bool,
    #[serde(default)]
    pub muted: bool,
}

fn rule_is_on() -> bool {
    true
}

impl AlertDraft {
    fn build(&self, now: i64) -> Alert {
        Alert {
            id: String::new(),
            instrument: self.instrument.trim().to_ascii_uppercase(),
            kind: self.kind,
            threshold: self.threshold,
            threshold_high: self.threshold_high,
            timeframe: self.timeframe,
            rearm_gap: self.rearm_gap.unwrap_or(0.0),
            label: self.label.clone().unwrap_or_default().trim().chars().take(120).collect(),
            enabled: self.enabled,
            muted: self.muted,
            created_at: now,
            updated_at: now,
            // Waiting: a rule whose level already holds answers on the next print
            // instead of waiting for the level to be given back first.
            armed: true,
            last_fired_at: None,
        }
    }
}

/// Every rule, newest created first. There is no ceiling on how many a trader keeps.
pub async fn alerts(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({ "items": state.db.alerts()? })))
}

/// Fires, newest first. Kept whatever happens to the rule that made them.
#[derive(Deserialize)]
pub struct HistoryQuery {
    #[serde(default)]
    pub instrument: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn alert_history(
    State(state): State<AppState>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = query.limit.unwrap_or(200).clamp(1, 5_000);
    Ok(Json(json!({ "items": state.db.alert_fires(query.instrument.as_deref(), limit)? })))
}

pub async fn create_alert(
    State(state): State<AppState>,
    Json(draft): Json<AlertDraft>,
) -> Result<(StatusCode, Json<Alert>), ApiError> {
    let mut alert = draft.build(chartkit_core::now_ms());
    alert.id = new_id("al");
    validate_rule(&state, &alert)?;
    state.db.insert_alert(&alert)?;
    state.alerts.reload()?;
    Ok((StatusCode::CREATED, Json(alert)))
}

/// Replaces a rule. Saving one always re-arms it: the crossing state that was stored
/// describes the condition the trader has just changed.
pub async fn update_alert(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(draft): Json<AlertDraft>,
) -> Result<Json<Value>, ApiError> {
    let stored = state
        .db
        .alert(&id)?
        .ok_or_else(|| ApiError::NotFound(format!("no alert {id}")))?;
    let now = chartkit_core::now_ms();
    let mut alert = draft.build(now);
    alert.id = stored.id.clone();
    alert.created_at = stored.created_at;
    alert.last_fired_at = stored.last_fired_at;
    validate_rule(&state, &alert)?;
    if !state.db.update_alert(&alert)? {
        return Err(ApiError::NotFound(format!("no alert {id}")));
    }
    state.alerts.reload()?;
    Ok(Json(serde_json::to_value(alert)?))
}

pub async fn delete_alert(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let deleted = state.db.delete_alert(&id)?;
    state.alerts.reload()?;
    Ok(Json(json!({ "id": id, "deleted": deleted })))
}

/// Empties the trigger history. The rules themselves are untouched.
pub async fn clear_alert_history(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({ "cleared": state.db.clear_alert_fires()? })))
}

/// A rule the pump could actually judge, against an instrument the store knows. An
/// unknown id is refused rather than kept as a rule that would never be evaluated.
fn validate_rule(state: &AppState, alert: &Alert) -> Result<(), ApiError> {
    alert.validate().map_err(ApiError::BadRequest)?;
    let known = state.db.instrument(&alert.instrument)?;
    if known.is_none() {
        return Err(ApiError::NotFound(format!("no instrument {}", alert.instrument)));
    }
    Ok(())
}

pub async fn workspaces(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({ "items": state.db.workspaces()? })))
}

#[derive(Deserialize)]
pub struct WorkspaceBody {
    pub name: String,
    pub data: Value,
}

pub async fn save_workspace(
    State(state): State<AppState>,
    Json(body): Json<WorkspaceBody>,
) -> Result<Json<Value>, ApiError> {
    state.db.save_workspace(&body.name, &body.data, chartkit_core::now_ms())?;
    Ok(Json(json!({ "name": body.name, "saved": true })))
}

pub async fn delete_workspace(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({ "name": name, "deleted": state.db.delete_workspace(&name)? })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_draft_builds_a_rule_the_evaluator_can_judge() {
        let draft = AlertDraft {
            instrument: " binance:btcusdt ".into(),
            kind: AlertKind::PriceAbove,
            threshold: 59_000.0,
            threshold_high: None,
            timeframe: None,
            rearm_gap: None,
            label: Some("  reclaims the level  ".into()),
            enabled: true,
            muted: false,
        };
        let alert = draft.build(1_700_000_000_000);
        assert_eq!(alert.instrument, "BINANCE:BTCUSDT", "the store keys ids in upper case");
        assert_eq!(alert.label, "reclaims the level");
        assert_eq!(alert.rearm_gap, 0.0);
        assert!(alert.armed, "a new rule waits for its crossing");
        assert!(alert.enabled);
        assert_eq!(alert.created_at, alert.updated_at);
        assert!(alert.validate().is_ok());

        let window = AlertDraft {
            instrument: "BINANCE:BTCUSDT".into(),
            kind: AlertKind::VolumeAbove,
            threshold: 120.0,
            threshold_high: None,
            timeframe: Some(Timeframe::Minute(5)),
            rearm_gap: Some(10.0),
            label: None,
            enabled: false,
            muted: true,
        };
        let rule = window.build(1_700_000_000_000);
        assert_eq!(rule.label, "");
        assert!(!rule.enabled);
        assert!(rule.muted);
        assert!(rule.validate().is_ok());
    }

    #[test]
    fn no_step_keeps_the_venues_own_price_grid() {
        assert_eq!(profile_step_ticks(None, None, 0.01).unwrap(), 1);
        assert_eq!(profile_step_ticks(None, Some(1), 0.01).unwrap(), 1);
        assert_eq!(profile_step_ticks(Some(0.001), None, 0.01).unwrap(), 1);
    }

    #[test]
    fn a_price_step_is_measured_in_ticks() {
        assert_eq!(profile_step_ticks(Some(0.05), None, 0.01).unwrap(), 5);
        assert_eq!(profile_step_ticks(Some(1.0), None, 0.01).unwrap(), 100);
        assert_eq!(profile_step_ticks(Some(5.0), None, 0.01).unwrap(), 500);
        // A step that is not a whole number of ticks takes the nearest one.
        assert_eq!(profile_step_ticks(Some(0.017), None, 0.01).unwrap(), 2);
    }

    #[test]
    fn a_price_step_wins_over_a_tick_multiplier() {
        assert_eq!(profile_step_ticks(Some(5.0), Some(10), 0.01).unwrap(), 500);
        assert_eq!(profile_step_ticks(None, Some(500), 0.01).unwrap(), 500);
    }

    #[test]
    fn an_impossible_step_is_refused() {
        assert!(profile_step_ticks(Some(0.0), None, 0.01).is_err());
        assert!(profile_step_ticks(Some(-2.0), None, 0.01).is_err());
        assert!(profile_step_ticks(Some(f64::NAN), None, 0.01).is_err());
        assert!(profile_step_ticks(None, Some(0), 0.01).is_err());
        assert!(profile_step_ticks(None, Some(-5), 0.01).is_err());
    }

    fn row(group: i64, band: i64, buy: f64, sell: f64, buy_n: i64, sell_n: i64) -> SizeBandRow {
        SizeBandRow { group, band, buy_qty: buy, sell_qty: sell, buy_n, sell_n }
    }

    /// The same window as the aggregation would return it: two bars, three bands.
    fn two_bars() -> (Vec<SizeBand>, Vec<SizeBandRow>) {
        let edges = [1_000.0, 10_000.0, 100_000.0];
        let labels = band_labels(&edges);
        let rows = vec![
            row(0, 0, 3.0, 1.0, 5, 2),
            row(0, 1, 2.0, 0.0, 1, 0),
            row(0, 3, 0.0, 4.0, 0, 1),
            row(60_000, 0, 1.0, 1.0, 1, 1),
            row(60_000, 2, 5.0, 0.0, 2, 0),
        ];
        (labels, rows)
    }

    fn answer(labels: Vec<SizeBand>, rows: Vec<SizeBandRow>, limit: i64) -> SizeBandSeries {
        assemble_size_bands(
            "BINANCE:BTCUSDT".into(),
            Timeframe::Minute(1),
            Some(0),
            Some(120_000),
            0.01,
            1,
            SizeUnit::Notional,
            "test".into(),
            labels,
            rows,
            Vec::new(),
            limit,
        )
    }

    #[test]
    fn the_bands_of_a_bar_add_up_to_the_plain_delta_and_volume_of_that_bar() {
        let (labels, rows) = two_bars();
        let series = answer(labels, rows, 240);
        assert_eq!(series.bars.len(), 2);
        assert_eq!(series.bars[0].bands.len(), 4, "a band with no prints still occupies a slot");

        // The check the whole feature rests on: splitting a bar by size may not move a
        // coin. Every band's delta summed is the bar's delta, and so is its volume.
        let first = &series.bars[0];
        let band_delta: f64 = first.bands.iter().map(SizeBandCell::delta).sum();
        let band_volume: f64 = first.bands.iter().map(SizeBandCell::total).sum();
        let band_prints: u64 = first.bands.iter().map(SizeBandCell::prints).sum();
        assert_eq!(band_delta, 3.0 - 1.0 + 2.0 - 4.0, "the bands do not sum to the bar delta");
        assert_eq!(band_delta, first.delta);
        assert_eq!(band_volume, first.total_qty);
        assert_eq!(band_prints, first.trades);
        assert_eq!((first.total_qty, first.trades), (10.0, 9));

        let second = &series.bars[1];
        assert_eq!((second.delta, second.total_qty, second.trades), (5.0, 7.0, 4));
        assert!(second.bands.iter().map(|cell| cell.total()).sum::<f64>() == second.total_qty);

        assert_eq!((series.total_qty, series.delta, series.prints), (17.0, 5.0, 13));
        let totals: f64 = series.totals.iter().map(SizeBandCell::delta).sum();
        assert_eq!(totals, series.delta, "the per-band totals must add up to the window delta");
    }

    #[test]
    fn the_running_delta_per_band_follows_the_bars_it_is_handed_with() {
        let (labels, rows) = two_bars();
        let series = answer(labels.clone(), rows.clone(), 240);
        // Bar one: +2 on the retail band, +2 on the mid band, -4 on the block band.
        assert_eq!(series.bars[0].cumulative, vec![2.0, 2.0, 0.0, -4.0]);
        // Bar two adds 0, 0, +5, 0 on top of those.
        assert_eq!(series.bars[1].cumulative, vec![2.0, 2.0, 5.0, -4.0]);
        let last = series.bars.last().expect("bars").cumulative.clone();
        let totals: Vec<f64> = series.totals.iter().map(SizeBandCell::delta).collect();
        assert_eq!(last, totals, "the line has to end where the totals say it does");

        // Dropping the oldest bar restarts the line at the bar that survives the trim.
        let trimmed = answer(labels, rows, 1);
        assert_eq!(trimmed.bars.len(), 1);
        assert_eq!(trimmed.bars[0].start, 60_000);
        assert_eq!(trimmed.bars[0].cumulative, vec![0.0, 0.0, 5.0, 0.0]);
        assert_eq!((trimmed.total_qty, trimmed.delta, trimmed.prints), (7.0, 5.0, 4));
    }

    #[test]
    fn the_default_ladder_is_named_in_the_answer_rather_than_guessed_by_the_caller() {
        let (edges, rule) = size_edges(None, SizeUnit::Notional).expect("default ladder");
        assert_eq!(edges, DEFAULT_SIZE_EDGES.to_vec());
        assert!(rule.contains("standard"), "{rule}");
        assert!(rule.contains("quote notional per print"), "{rule}");
        assert!(rule.contains("1k / 10k / 100k"), "{rule}");

        let labels = band_labels(&edges);
        assert_eq!(
            labels.iter().map(|band| band.label.as_str()).collect::<Vec<_>>(),
            vec!["under 1k", "1k to 10k", "10k to 100k", "100k and up"]
        );
        assert_eq!(labels[0].min, None, "the bottom band has no floor");
        assert_eq!(labels[0].max, Some(1_000.0));
        assert_eq!(labels[3].max, None, "the top band has no ceiling");
        assert_eq!(labels[3].min, Some(100_000.0));
    }

    #[test]
    fn a_caller_may_ask_for_another_ladder_by_name_or_by_number() {
        let (edges, rule) = size_edges(Some("BLOCK"), SizeUnit::Notional).expect("named ladder");
        assert_eq!(edges, vec![10_000.0, 100_000.0, 1_000_000.0]);
        assert!(rule.contains("named ladder block"), "{rule}");

        let (edges, rule) = size_edges(Some(" 0.25, 2 , 250 "), SizeUnit::Quantity).expect("own edges");
        assert_eq!(edges, vec![0.25, 2.0, 250.0]);
        assert!(rule.contains("quantity per print"), "{rule}");
        assert!(rule.contains("0.25 / 2 / 250"), "{rule}");
    }

    #[test]
    fn a_ladder_that_cannot_be_aggregated_is_refused_with_a_reason() {
        // Not ascending: the SQL CASE tests the edges in order, so an unsorted list would
        // silently swallow the bands behind it.
        assert!(size_edges(Some("10000,1000,100000"), SizeUnit::Notional).is_err());
        assert!(size_edges(Some("1000,1000"), SizeUnit::Notional).is_err());
        assert!(size_edges(Some("0,1000"), SizeUnit::Notional).is_err());
        assert!(size_edges(Some("-5"), SizeUnit::Notional).is_err());
        assert!(size_edges(Some("big"), SizeUnit::Notional).is_err());
        assert!(size_edges(Some("not-a-number,1"), SizeUnit::Notional).is_err());
        assert!(size_edges(Some("1,2,3,4,5,6,7,8,9"), SizeUnit::Notional).is_err(), "nine bands is a wall");
        // The named ladders are quote amounts, so they cannot describe a quantity.
        assert!(size_edges(Some("standard"), SizeUnit::Quantity).is_err());
    }

    #[test]
    fn a_size_is_written_the_way_a_trader_reads_it() {
        assert_eq!(fmt_band_number(1_000.0), "1k");
        assert_eq!(fmt_band_number(2_500.0), "2.5k");
        assert_eq!(fmt_band_number(100_000.0), "100k");
        assert_eq!(fmt_band_number(1_000_000.0), "1M");
        assert_eq!(fmt_band_number(1_500_000_000.0), "1.5B");
        assert_eq!(fmt_band_number(5.0), "5");
        assert_eq!(fmt_band_number(0.25), "0.25");
    }

    #[test]
    fn only_intervals_with_a_fixed_span_can_be_grouped_by_time() {
        assert_eq!(bar_span_ms(Timeframe::Minute(1)).expect("1m"), 60_000);
        assert_eq!(bar_span_ms(Timeframe::Minute(5)).expect("5m"), 300_000);
        assert_eq!(bar_span_ms(Timeframe::Hour(1)).expect("1h"), 3_600_000);
        assert_eq!(bar_span_ms(Timeframe::Day(1)).expect("1d"), 86_400_000);
        assert!(bar_span_ms(Timeframe::Month(1)).is_err());
        assert!(bar_span_ms(Timeframe::Tick(100)).is_err());
        // Weeks align against a Sunday epoch, which a plain division would miss.
        assert!(bar_span_ms(Timeframe::Week(1)).is_err());
    }

    #[test]
    fn a_fold_is_dense_and_keeps_every_group_it_was_given() {
        let (labels, rows) = two_bars();
        let folded = fold_size_bands(&rows, labels.len());
        assert_eq!(folded.len(), 2, "both bars survive");
        assert!(folded.iter().all(|(_, cells)| cells.len() == 4));
        assert_eq!(folded[0].1[2], SizeBandCell::default(), "an empty band reads as a zero");
        assert_eq!(folded[1].1[1], SizeBandCell::default());

        // A band index outside the ladder cannot index out of the dense row.
        let stray = vec![row(0, 9, 1.0, 0.0, 1, 0), row(0, -1, 1.0, 0.0, 1, 0), row(0, 0, 2.0, 0.0, 1, 0)];
        let folded = fold_size_bands(&stray, 4);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].1[0].buy_qty, 2.0, "the band that exists still gets its volume");
    }
}
