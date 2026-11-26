//! REST surface: history, order-flow aggregates, symbol search and workspaces.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chartkit_core::{
    new_id, Alert, AlertKind, AssetClass, FootprintSeries, FootprintSeriesBuilder, Timeframe,
    VolumeProfile, VolumeProfileBuilder,
};
use chartkit_store::{BarFilter, StoreError};
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

// ---------------------------------------------------------------- alerts

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
}
