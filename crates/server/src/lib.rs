//! The local server: history, order flow and the live feed over axum, plus the
//! built web client.
//!
//! A library so the desktop shell can host this in-process on a background thread
//! instead of launching a second process: one binary, one port, no orphaned child.

pub mod alerts;
pub mod api;
pub mod feeds;
pub mod live;
pub mod prints;
pub mod state;
pub mod static_files;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use chartkit_core::{Timeframe, Venue};
use chartkit_ingest::{BinanceFeed, FeedCommand};
use chartkit_store::Db;
use state::{AppState, Hub};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::prints::PrintBackfill;

/// Whatever stopped the server: io, the store, or a bind failure.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Everything the server needs: where state lives, what to stream, what to serve.
pub struct Config {
    /// Directory holding `chartkit.db`; created if missing.
    pub data_dir: PathBuf,
    /// `host:port` to bind. Port 0 asks the OS for a free port, and
    /// [`Running::local_addr`] reports the one it got.
    pub addr: String,
    /// Venue symbols to subscribe to at startup.
    pub symbols: Vec<String>,
    pub timeframes: Vec<Timeframe>,
    /// Days of candles to pull per timeframe on first run.
    pub backfill_days: i64,
    /// Directory holding the built web client, served from the same origin.
    pub ui_dir: PathBuf,
}

/// A server that is already accepting connections.
pub struct Running {
    /// The address actually bound, which is only known after binding when port 0
    /// was requested.
    pub local_addr: SocketAddr,
    task: JoinHandle<Result<(), BoxError>>,
}

impl Running {
    /// Resolves when the serve loop stops, i.e. when the process is going away.
    pub async fn wait(self) -> Result<(), BoxError> {
        match self.task.await {
            Ok(result) => result,
            Err(join) => {
                Err(Box::from(std::io::Error::other(format!("server task stopped: {join}"))) as BoxError)
            }
        }
    }
}

/// Open the store, start the feed and the boot backfill, and begin serving.
/// Returns once the listener is bound, so callers can point a browser or a
/// webview at [`Running::local_addr`] immediately.
pub async fn start(config: Config) -> Result<Running, BoxError> {
    std::fs::create_dir_all(&config.data_dir)?;
    let db = Arc::new(Db::open(config.data_dir.join("chartkit.db"))?);
    let timeframes = config.timeframes;
    let symbols = config.symbols;

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let hub = Hub::default();
    // One router in front of every venue feed. Binance registers its channel below; the
    // other venues start when their credentials are present and answer `not-configured`
    // when they are not.
    let feeds = Arc::new(feeds::Feeds::new(
        &config.data_dir,
        event_tx.clone(),
        timeframes.clone(),
        hub.clone(),
    ));
    feeds.register(Venue::Binance, cmd_tx.clone());
    // Rules are read, and the gap since the last run is judged, before the feed can reach
    // the pump: otherwise a live print would be judged against rules that were never read.
    let alerts = alerts::AlertEngine::new(Arc::clone(&db), hub.clone());
    alerts.load();
    let state = AppState {
        db: Arc::clone(&db),
        cmd_tx: cmd_tx.clone(),
        feeds: Arc::clone(&feeds),
        hub: hub.clone(),
        rest: BinanceFeed::new(Vec::new()),
        prints: PrintBackfill::new(Arc::clone(&db), BinanceFeed::new(Vec::new())),
        alerts: Arc::clone(&alerts),
        ui_dir: config.ui_dir,
    };

    live::spawn_pump(Arc::clone(&db), hub.clone(), Arc::clone(&alerts), event_rx);
    // Publish each venue's state before the first client connects, so the strip reads
    // "not configured" rather than showing nothing at all.
    for venue in chartkit_ingest::credentials::ROUTED {
        feeds.ensure_running(venue);
    }
    let feed_timeframes = timeframes.clone();
    tokio::spawn(async move {
        if let Err(error) = BinanceFeed::new(feed_timeframes).run(cmd_rx, event_tx).await {
            tracing::error!("feed stopped: {error}");
        }
    });

    // Instrument list and history are best effort: a cold start with no network
    // still opens, and the next run catches up.
    {
        let state = state.clone();
        let boot_symbols = symbols.clone();
        let from = chartkit_core::now_ms() - config.backfill_days * 86_400_000;
        tokio::spawn(async move {
            match state.rest.load_instruments().await {
                Ok(items) => {
                    let _ = state.db.upsert_instruments(&items);
                    tracing::info!("instruments stored: {}", items.len());
                }
                Err(error) => tracing::warn!("instrument list unavailable: {error}"),
            }
            // Prints exist only for the time a server was streaming, so the window behind
            // the live stream is pulled from the venue's own history once per range.
            state.prints.boot_pass(&boot_symbols);
            let Some(boot_timeframe) = timeframes.first().copied() else { return };
            for symbol in boot_symbols {
                let _ = state.cmd_tx.send(FeedCommand::Subscribe {
                    venue: Venue::Binance,
                    symbol: symbol.clone(),
                    timeframe: boot_timeframe,
                });
                for timeframe in timeframes.clone() {
                    let state = state.clone();
                    let symbol = symbol.clone();
                    tokio::spawn(async move { backfill(&state, &symbol, timeframe, from).await });
                }
            }
        });
    }

    let app = axum::Router::new()
        .route("/api/health", axum::routing::get(api::health))
        .route("/api/coverage", axum::routing::get(api::coverage))
        .route("/api/instruments", axum::routing::get(api::instruments))
        .route("/api/feeds", axum::routing::get(api::feeds).post(api::save_feeds))
        .route("/api/bars", axum::routing::get(api::bars))
        .route("/api/trades", axum::routing::get(api::trades))
        .route("/api/footprint", axum::routing::get(api::footprint))
        .route("/api/profile", axum::routing::get(api::profile))
        .route("/api/cvd-by-size", axum::routing::get(api::size_bands))
        .route("/api/cluster-search", axum::routing::get(api::cluster_search))
        .route(
            "/api/workspaces",
            axum::routing::get(api::workspaces).post(api::save_workspace),
        )
        .route("/api/workspaces/{name}", axum::routing::delete(api::delete_workspace))
        .route(
            "/api/alerts",
            axum::routing::get(api::alerts).post(api::create_alert).delete(api::clear_alert_history),
        )
        .route("/api/alerts/history", axum::routing::get(api::alert_history))
        .route(
            "/api/alerts/{id}",
            axum::routing::put(api::update_alert).delete(api::delete_alert),
        )
        .route("/api/live", axum::routing::get(live::upgrade))
        .with_state(state.clone())
        .fallback(axum::routing::get(static_files::serve).with_state(state));

    let listener = TcpListener::bind(&config.addr).await?;
    let local = listener.local_addr()?;
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.map_err(|e| Box::from(e) as BoxError)
    });
    tracing::info!("listening on http://{local}");
    Ok(Running { local_addr: local, task })
}

/// Pull candles backwards in venue-sized batches until `from` is covered.
async fn backfill(state: &AppState, symbol: &str, timeframe: Timeframe, from: i64) {
    let step = timeframe.duration_ms().unwrap_or(60_000);
    let mut cursor = from;
    for _ in 0..40 {
        match state.rest.klines(symbol, timeframe, cursor, 1000).await {
            Ok(bars) if bars.is_empty() => return,
            Ok(bars) => {
                let id = format!("BINANCE:{symbol}");
                let _ = state.db.upsert_bars(&id, &timeframe.as_key(), &bars);
                let last = bars.last().map(|b| b.start).unwrap_or(cursor);
                let next = last + step;
                if next >= chartkit_core::now_ms() || next <= cursor {
                    return;
                }
                cursor = next;
            }
            Err(error) => {
                tracing::warn!("backfill {symbol} {timeframe} failed: {error}");
                return;
            }
        }
    }
}
