//! Command line entry point: parse flags, then hand off to [`chartkit_server`].

use std::path::PathBuf;

use chartkit_core::Timeframe;
use chartkit_server::Config;
use clap::Parser;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "chartkit", about = "Local charting and order-flow workspace")]
struct Cli {
    /// Where the SQLite database lives. Defaults to ~/.chartkit
    #[arg(long, default_value = "")]
    data_dir: String,
    #[arg(long, default_value = "127.0.0.1:8786")]
    addr: String,
    /// Venue symbols to stream at startup.
    #[arg(long, value_delimiter = ',', default_value = "BTCUSDT,ETHUSDT,SOLUSDT")]
    symbols: Vec<String>,
    #[arg(long, value_delimiter = ',', default_value = "1m,5m,1h,1d")]
    timeframes: Vec<String>,
    /// Days of candles to pull per timeframe on first run.
    #[arg(long, default_value_t = 30)]
    backfill_days: i64,
    /// Directory holding the built web client.
    #[arg(long, default_value = "ui/dist")]
    ui_dir: String,
}

#[tokio::main]
async fn main() -> Result<(), chartkit_server::BoxError> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cli = Cli::parse();
    let timeframes: Vec<Timeframe> = cli
        .timeframes
        .iter()
        .map(|text| text.parse::<Timeframe>())
        .collect::<Result<Vec<_>, _>>()?;

    let running = chartkit_server::start(Config {
        data_dir: resolve_data_dir(&cli.data_dir)?,
        addr: cli.addr,
        symbols: cli.symbols,
        timeframes,
        backfill_days: cli.backfill_days,
        ui_dir: PathBuf::from(&cli.ui_dir),
    })
    .await?;

    running.wait().await
}

fn resolve_data_dir(raw: &str) -> Result<PathBuf, std::io::Error> {
    if !raw.is_empty() {
        return Ok(PathBuf::from(raw));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| std::io::Error::other("no home directory; pass --data-dir"))?;
    Ok(PathBuf::from(home).join(".chartkit"))
}
