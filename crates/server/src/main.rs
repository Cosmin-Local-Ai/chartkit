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
    /// Probe one venue with the credentials on this machine and print what actually came
    /// back: entitlement, first sequence number, counts, latency. Exits cleanly with
    /// "not configured" when the venue has no credentials, so it is safe to run blind.
    #[arg(long, value_name = "VENUE")]
    check_feed: Option<String>,
    /// Symbol the feed check subscribes to. Defaults to one each venue is known for.
    #[arg(long, default_value = "")]
    check_symbol: String,
    /// Seconds the feed check watches the wire.
    #[arg(long, default_value_t = 15)]
    check_seconds: u64,
}

#[tokio::main]
async fn main() -> Result<(), chartkit_server::BoxError> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cli = Cli::parse();
    if let Some(text) = cli.check_feed.as_deref() {
        return run_check(&cli, text).await;
    }
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

/// `--check-feed <venue>`: prove a venue from this machine, without anyone else seeing
/// the credentials. No server, no database, no writes.
async fn run_check(cli: &Cli, text: &str) -> Result<(), chartkit_server::BoxError> {
    use chartkit_core::instrument::VenueTag;
    use chartkit_core::Venue;
    use chartkit_ingest::credentials::{venue_from_slug, CredentialStore};
    let Some(venue) = venue_from_slug(text) else {
        println!("unknown venue {text:?}; try tradovate, ibkr, rithmic or binance");
        return Ok(());
    };
    let store = CredentialStore::load(&resolve_data_dir(&cli.data_dir)?);
    let symbol = if !cli.check_symbol.is_empty() {
        cli.check_symbol.clone()
    } else {
        match venue {
            Venue::Tradovate | Venue::Rithmic => "MES".to_string(),
            Venue::InteractiveBrokers => "AAPL@265598".to_string(),
            Venue::Binance => "BTCUSDT".to_string(),
            _ => return Ok(()),
        }
    };
    let timeframe = cli
        .timeframes
        .first()
        .map(|text| text.parse::<Timeframe>())
        .transpose()?
        .unwrap_or(Timeframe::Minute(1));
    match chartkit_server::feeds::probe(venue, &store, &symbol, timeframe, cli.check_seconds).await {
        Ok(report) => {
            chartkit_server::feeds::print_probe(&report);
            Ok(())
        }
        Err(reason) => {
            println!("{}: not configured — {reason}", venue.tag().to_lowercase());
            Ok(())
        }
    }
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
