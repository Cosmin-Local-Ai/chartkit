//! ChartKit desktop shell: one process that hosts the local server and shows it in
//! a native window. The window is pointed at the server's own origin, so the web
//! client keeps using relative `/api` and `/api/live` URLs and needs no base URL of
//! its own.

mod hosting;

use std::error::Error;

use clap::Parser;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "chartkit-desktop", about = "ChartKit desktop workspace")]
struct Cli {
    /// Host the server and print its address without opening a window. Same code
    /// path the window uses, for headless machines and browser-only use.
    #[arg(long)]
    serve_only: bool,
}

fn main() {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    if cli.serve_only {
        if let Err(error) = serve_only() {
            tracing::error!("{error}");
            std::process::exit(1);
        }
        return;
    }

    if let Err(error) = tauri::Builder::default()
        .setup(setup)
        .run(tauri::generate_context!())
    {
        tracing::error!("error while running ChartKit: {error}");
        std::process::exit(1);
    }
}

/// Start the server, then point the window at it. Declared in `tauri.conf.json` as
/// hidden so nothing paints until the socket answers.
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn Error>> {
    let paths = hosting::resolve(Some(app))?;
    let addr = hosting::spawn(hosting::server_config(&paths))?;
    let url = format!("http://{addr}/").parse()?;
    let window = app
        .get_webview_window("main")
        .ok_or("no window labelled `main` in tauri.conf.json")?;
    window.navigate(url)?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Plain local server, no webview: the hosting path minus the window. Uses the
/// command line server's `~/.chartkit` data dir, overridable with `CHARTKIT_DATA_DIR`.
fn serve_only() -> Result<(), chartkit_server::BoxError> {
    let paths = hosting::resolve(None)?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let running = runtime.block_on(chartkit_server::start(hosting::server_config(&paths)))?;
    println!(
        "chartkit serving http://{} (data: {}, web client: {})",
        running.local_addr,
        paths.data_dir.display(),
        paths.ui_dir.display()
    );
    runtime.block_on(running.wait())?;
    Ok(())
}
