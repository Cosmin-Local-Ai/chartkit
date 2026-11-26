//! Where the desktop app keeps its data and its web client, and how it hosts the
//! server inside its own process.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use chartkit_core::Timeframe;
use chartkit_server::Config;
use tauri::Manager;

/// Candles to pull per timeframe the first time the app runs.
pub const BACKFILL_DAYS: i64 = 30;
/// Streams opened at startup. The watchlist subscribes to more on demand.
pub const START_SYMBOLS: [&str; 3] = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
/// Intervals the startup backfill and live feed cover.
pub const START_TIMEFRAMES: [&str; 4] = ["1m", "5m", "1h", "1d"];
/// Port 0 asks the OS for a free port, so the packaged app never collides with a
/// `chartkit` server started from the command line.
pub const BIND: &str = "127.0.0.1:0";
/// Overrides for the two directories, mainly for portable installs and for tests.
pub const UI_DIR_ENV: &str = "CHARTKIT_UI_DIR";
pub const DATA_DIR_ENV: &str = "CHARTKIT_DATA_DIR";
/// How long the window waits for the socket before reporting a failed start.
const START_TIMEOUT: Duration = Duration::from_secs(20);

/// The two directories the server needs.
pub struct Paths {
    pub data_dir: PathBuf,
    pub ui_dir: PathBuf,
}

/// Server config for a desktop run: loopback only, ephemeral port, fixed defaults
/// for what the CLI takes as flags.
pub fn server_config(paths: &Paths) -> Config {
    Config {
        data_dir: paths.data_dir.clone(),
        addr: BIND.to_string(),
        symbols: START_SYMBOLS.iter().map(|symbol| (*symbol).to_string()).collect(),
        timeframes: START_TIMEFRAMES
            .iter()
            .filter_map(|text| text.parse::<Timeframe>().ok())
            .collect(),
        backfill_days: BACKFILL_DAYS,
        ui_dir: paths.ui_dir.clone(),
    }
}

/// Runs the server on a dedicated thread that owns its own tokio runtime, so the
/// webview thread can never starve it and vice versa. Returns once the listener is
/// bound, with the port the OS handed out.
pub fn spawn(config: Config) -> Result<SocketAddr, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("chartkit-server".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(3)
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = tx.send(Err(format!("async runtime: {error}")));
                    return;
                }
            };
            runtime.block_on(async move {
                match chartkit_server::start(config).await {
                    Ok(running) => {
                        let addr = running.local_addr;
                        let _ = tx.send(Ok(addr));
                        if let Err(error) = running.wait().await {
                            tracing::error!("server stopped: {error}");
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(Err(format!("server: {error}")));
                    }
                }
            });
        })
        .map_err(|error| format!("server thread: {error}"))?;
    rx.recv_timeout(START_TIMEOUT)
        .map_err(|_| format!("server did not bind within {}s", START_TIMEOUT.as_secs()))?
}

/// Resolves the data dir and the bundled web client. `app` is absent when the same
/// hosting path runs without Tauri (`--serve-only`), where the standard per-user
/// app-data directory cannot be resolved without an app handle.
pub fn resolve(app: Option<&tauri::App>) -> Result<Paths, String> {
    let data_dir = match app {
        Some(app) => app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("data dir: {error}"))?,
        None => standalone_data_dir()?,
    };
    std::fs::create_dir_all(&data_dir).map_err(|error| format!("create {}: {error}", data_dir.display()))?;
    import_legacy_database(&data_dir);
    let ui_dir = pick_ui_dir(app)?;
    tracing::info!("data dir {} · web client {}", data_dir.display(), ui_dir.display());
    Ok(Paths { data_dir, ui_dir })
}

/// Per-user directory the command line server has always used.
fn standalone_data_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os(DATA_DIR_ENV) {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("no home directory; set {DATA_DIR_ENV}")?;
    Ok(PathBuf::from(home).join(".chartkit"))
}

/// First directory that actually holds a built client. The packaged layout puts the
/// client in the app's resources; a cargo build puts it next to the sources.
fn pick_ui_dir(app: Option<&tauri::App>) -> Result<PathBuf, String> {
    let mut tried = Vec::new();
    for candidate in ui_dir_candidates(app) {
        if candidate.join("index.html").is_file() {
            return Ok(candidate);
        }
        tried.push(candidate.display().to_string());
    }
    Err(format!(
        "built web client not found (looked in {}); run `npm run build` in ui/ or set {UI_DIR_ENV}",
        tried.join(", ")
    ))
}

fn ui_dir_candidates(app: Option<&tauri::App>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = std::env::var_os(UI_DIR_ENV) {
        candidates.push(PathBuf::from(dir));
    }
    if let Some(app) = app {
        if let Ok(resources) = app.path().resource_dir() {
            candidates.push(resources.join("ui"));
            candidates.push(resources.join("dist"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("ui"));
            candidates.push(dir.join("dist"));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui/dist"));
    candidates
}

/// The command line server keeps its database in `~/.chartkit`. A first desktop run
/// copies that history into the app data dir instead of starting empty; it copies
/// rather than moves, so the command line server keeps working too.
fn import_legacy_database(data_dir: &Path) {
    let target = data_dir.join("chartkit.db");
    if target.exists() {
        return;
    }
    let Some(legacy) = standalone_data_dir().ok().filter(|dir| dir != data_dir) else {
        return;
    };
    let source = legacy.join("chartkit.db");
    if !source.is_file() {
        return;
    }
    // A live database can hold recent writes in its write-ahead log, so the side
    // files come along when they exist.
    for suffix in ["", "-wal", "-shm"] {
        let file = format!("chartkit.db{suffix}");
        let from = legacy.join(&file);
        if !from.is_file() {
            continue;
        }
        if let Err(error) = std::fs::copy(&from, data_dir.join(&file)) {
            tracing::warn!("could not import {}: {error}", from.display());
            return;
        }
    }
    tracing::info!("imported existing database from {}", source.display());
}
