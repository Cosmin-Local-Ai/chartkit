//! Which venue feeds are running, where a subscription goes, and what to say about a
//! venue that has no credentials.
//!
//! One command channel per venue, one router in front of them: the server keeps a single
//! sender, and a subscription carries the venue it belongs to. A venue with no credentials
//! never starts a task; it answers `not-configured` instead, which is neither an error nor
//! a success.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chartkit_core::instrument::VenueTag;
use chartkit_core::{Timeframe, Venue};
use chartkit_ingest::credentials::{CredentialStore, VenueStatus};
use chartkit_ingest::{
    BinanceFeed, FeedCommand, FeedEvent, FeedState, IbkrConfig, IbkrFeed, RithmicConfig, RithmicFeed,
    TradovateConfig, TradovateFeed,
};
use tokio::sync::mpsc;

use crate::state::Hub;

/// How long `--check-feed` watches the wire before reporting what arrived.
pub const PROBE_SECONDS: u64 = 15;

/// Everything that can route a subscription.
pub struct Feeds {
    credentials: Mutex<CredentialStore>,
    running: Mutex<HashMap<Venue, mpsc::UnboundedSender<FeedCommand>>>,
    event_tx: mpsc::UnboundedSender<FeedEvent>,
    timeframes: Vec<Timeframe>,
    data_dir: PathBuf,
    hub: Hub,
}

impl Feeds {
    /// Where `feeds.json` lives, so the panel can name the file it is writing.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

impl Feeds {
    pub fn new(
        data_dir: &Path,
        event_tx: mpsc::UnboundedSender<FeedEvent>,
        timeframes: Vec<Timeframe>,
        hub: Hub,
    ) -> Self {
        Self {
            credentials: Mutex::new(CredentialStore::load(data_dir)),
            running: Mutex::new(HashMap::new()),
            event_tx,
            timeframes,
            data_dir: data_dir.to_path_buf(),
            hub,
        }
    }

    fn store(&self) -> CredentialStore {
        self.credentials.lock().map(|store| store.clone()).unwrap_or_default()
    }

    /// What the settings panel lists: every routable venue, configured or not.
    pub fn statuses(&self) -> Vec<VenueStatus> {
        self.store().statuses()
    }

    /// Save credentials the UI posted, then re-read them so the next subscription can
    /// start the venue without a restart.
    pub fn save(
        &self,
        venue: Venue,
        values: &chartkit_ingest::credentials::Values,
    ) -> Result<Vec<VenueStatus>, String> {
        let updated = {
            let store = self.store();
            store
                .save(venue, values)
                .map_err(|error| format!("could not write {}: {error}", store.path().display()))?
        };
        if let Ok(mut store) = self.credentials.lock() {
            *store = updated;
        }
        // A venue that just got credentials can start now, so its stale "not configured"
        // status must not stay in the hub.
        self.ensure_running(venue);
        Ok(self.statuses())
    }

    /// Send a command to the venue it names, starting that venue's task if it is
    /// configured and not yet running.
    pub fn send(&self, command: FeedCommand) {
        let venue = match command {
            FeedCommand::Subscribe { venue, .. } | FeedCommand::Unsubscribe { venue, .. } => venue,
        };
        if venue == Venue::Binance {
            // Binance is started by the server itself and always has a channel.
            if let Some(sender) = self.running.lock().ok().and_then(|runs| runs.get(&venue).cloned()) {
                let _ = sender.send(command);
            }
            return;
        }
        if let Some(sender) = self.running.lock().ok().and_then(|runs| runs.get(&venue).cloned()) {
            let _ = sender.send(command);
            return;
        }
        self.ensure_running(venue);
        if let Some(sender) = self.running.lock().ok().and_then(|runs| runs.get(&venue).cloned()) {
            let _ = sender.send(command);
        }
    }

    /// Register a channel for a venue the server started itself, i.e. Binance.
    pub fn register(&self, venue: Venue, sender: mpsc::UnboundedSender<FeedCommand>) {
        if let Ok(mut running) = self.running.lock() {
            running.insert(venue, sender);
        }
    }

    /// A venue that just got credentials is not "not configured" any more, even while
    /// nothing is subscribed to it yet: without this the strip keeps the old reason.
    fn publish_ready(&self, venue: Venue) {
        let _ = self.event_tx.send(FeedEvent::venue_status(
            venue,
            FeedState::Connecting,
            "configured, waiting for a symbol",
        ));
    }

    /// Start a venue's task when its credentials are present. Otherwise publish the reason
    /// the venue is not configured, which is what the status strip shows.
    pub fn ensure_running(&self, venue: Venue) {
        if self.running.lock().ok().and_then(|runs| runs.get(&venue).cloned()).is_some() {
            return;
        }
        let store = self.store();
        let status = store.status(venue);
        let (tx, rx) = mpsc::unbounded_channel();
        let timeframes = self.timeframes.clone();
        let event_tx = self.event_tx.clone();
        match venue {
            Venue::Tradovate => match TradovateConfig::from_store(&store) {
                Ok(config) => {
                    self.publish_ready(venue);
                    tokio::spawn(async move {
                        if let Err(error) = TradovateFeed::new(config, timeframes).run(rx, event_tx).await {
                            tracing::error!("tradovate feed stopped: {error}");
                        }
                    });
                }
                Err(reason) => self.report_not_configured(venue, &status, &reason),
            },
            Venue::InteractiveBrokers => match IbkrConfig::from_store(&store) {
                Ok(config) => {
                    self.publish_ready(venue);
                    tokio::spawn(async move {
                        if let Err(error) = IbkrFeed::new(config, timeframes).run(rx, event_tx).await {
                            tracing::error!("ibkr feed stopped: {error}");
                        }
                    });
                }
                Err(reason) => self.report_not_configured(venue, &status, &reason),
            },
            Venue::Rithmic => match RithmicConfig::from_store(&store) {
                Ok(config) => {
                    self.publish_ready(venue);
                    tokio::spawn(async move {
                        if let Err(error) = RithmicFeed::new(config, timeframes).run(rx, event_tx).await {
                            tracing::error!("rithmic feed stopped: {error}");
                        }
                    });
                }
                Err(reason) => self.report_not_configured(venue, &status, &reason),
            },
            _ => self.report_not_configured(venue, &status, "this venue has no adapter"),
        }
        // Only keep the channel when a task actually runs; otherwise the next subscription
        // gets another chance to start it, and the reason is re-published.
        if status.configured {
            if let Ok(mut running) = self.running.lock() {
                running.insert(venue, tx);
            }
        }
    }

    fn report_not_configured(&self, venue: Venue, status: &VenueStatus, reason: &str) {
        let event = FeedEvent::venue_status(venue, FeedState::NotConfigured, reason.to_string());
        if let Ok(text) = serde_json::to_string(&event) {
            self.hub.remember_status(&event.status_key().unwrap_or_else(|| venue.tag().to_string()), text.clone());
            self.hub.send(text);
        }
        tracing::info!("{} feed not configured: {reason}", status.slug);
    }
}

/// What one probe run saw on the wire.
#[derive(Clone, Debug)]
pub struct ProbeReport {
    pub venue: Venue,
    pub entitlement: String,
    pub first_sequence: Option<u64>,
    pub first_stamp: Option<i64>,
    pub bars: usize,
    pub trades: usize,
    pub depth: usize,
    pub status: Vec<String>,
    pub latency_ms: Option<i64>,
}

/// Run one venue against one symbol for a bounded time and report what actually arrived.
/// This is the live proof the user runs on their own machine.
pub async fn probe(
    venue: Venue,
    store: &CredentialStore,
    symbol: &str,
    timeframe: Timeframe,
    seconds: u64,
) -> Result<ProbeReport, String> {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let timeframes = vec![timeframe];
    // Each venue's own credential check produces the reason, so the command says what to
    // set rather than repeating a list of field names.
    macro_rules! spawn_feed {
        ($feed:expr) => {{
            let feed = $feed?;
            tokio::spawn(async move {
                if let Err(error) = feed.run(cmd_rx, event_tx).await {
                    tracing::warn!("probe feed stopped: {error}");
                }
            });
        }};
    }
    match venue {
        Venue::Binance => spawn_feed!(Ok::<_, String>(BinanceFeed::new(timeframes))),
        Venue::Tradovate => spawn_feed!(TradovateConfig::from_store(store).map(|config| TradovateFeed::new(config, timeframes))),
        Venue::InteractiveBrokers => spawn_feed!(IbkrConfig::from_store(store).map(|config| IbkrFeed::new(config, timeframes))),
        Venue::Rithmic => spawn_feed!(RithmicConfig::from_store(store).map(|config| RithmicFeed::new(config, timeframes))),
        other => return Err(format!("{} has no adapter to probe", other.tag())),
    }
    let _ = cmd_tx.send(FeedCommand::Subscribe { venue, symbol: symbol.to_string(), timeframe });

    let mut report = ProbeReport {
        venue,
        entitlement: "unknown".into(),
        first_sequence: None,
        first_stamp: None,
        bars: 0,
        trades: 0,
        depth: 0,
        status: Vec::new(),
        latency_ms: None,
    };
    // A total budget, not one timeout per frame: a venue that trickles must still be
    // reported on, and one that says nothing must not hang the command.
    let until = tokio::time::Instant::now() + Duration::from_secs(seconds);
    loop {
        let remaining = until.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let event = match tokio::time::timeout(remaining, event_rx.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => break,
            Err(_) => break,
        };
        match event {
            FeedEvent::Bar { bar, .. } => {
                report.bars += 1;
                report.first_stamp.get_or_insert(bar.start);
            }
            FeedEvent::Trades { trades, .. } => {
                if report.first_sequence.is_none() {
                    report.first_sequence = trades.first().map(|trade| trade.seq);
                    report.first_stamp = trades.first().map(|trade| trade.ts);
                }
                report.trades += trades.len();
            }
            FeedEvent::Depth { snapshot, .. } => {
                report.depth += 1;
                if report.latency_ms.is_none() && snapshot.ts > 0 {
                    report.latency_ms = Some(chartkit_core::now_ms() - snapshot.ts);
                }
            }
            FeedEvent::Status { state, detail, .. } => {
                if state == FeedState::Delayed || state == FeedState::Live {
                    report.entitlement = detail.clone();
                }
                report.status.push(format!("{}: {detail}", kebab(state)));
            }
            FeedEvent::Instruments { items, .. } => {
                report.status.push(format!("instruments: {}", items.len()));
            }
        }
    }
    Ok(report)
}

/// `FeedState` as the wire spells it, for the probe's own summary line.
fn kebab(state: FeedState) -> &'static str {
    match state {
        FeedState::Connecting => "connecting",
        FeedState::Backfilling => "backfilling",
        FeedState::Live => "live",
        FeedState::Delayed => "delayed",
        FeedState::Stalled => "stalled",
        FeedState::NotConfigured => "not-configured",
        FeedState::Failed => "failed",
    }
}

/// Print a probe the way the user reads it: what the venue said, not what the code hoped.
/// How many different reports one probe prints before it stops listing them.
const MAX_REPORTED_STATUSES: usize = 8;

pub fn print_probe(report: &ProbeReport) {
    println!("{} probe", report.venue.tag());
    println!("  entitlement      {}", report.entitlement);
    println!(
        "  first sequence   {}",
        report.first_sequence.map(|v| v.to_string()).unwrap_or_else(|| "none seen".into())
    );
    println!(
        "  first stamp      {}",
        report.first_stamp.map(|v| v.to_string()).unwrap_or_else(|| "none seen".into())
    );
    println!("  bars             {}", report.bars);
    println!("  trades           {}", report.trades);
    println!("  depth snapshots  {}", report.depth);
    println!(
        "  latency          {}",
        match report.latency_ms {
            Some(ms) => format!("{ms} ms (venue stamp minus arrival, includes clock skew)"),
            None => "not measurable (no stamped frame)".into(),
        }
    );
    // A feed that retries says the same thing several times; the report says it once.
    let mut shown: Vec<(String, usize)> = Vec::new();
    for line in &report.status {
        if let Some((last, count)) = shown.last_mut() {
            if last == line {
                *count += 1;
                continue;
            }
        }
        if shown.len() < MAX_REPORTED_STATUSES {
            shown.push((line.clone(), 1));
        }
    }
    for (line, count) in shown {
        let suffix = if count > 1 { format!(" (said {count} times)") } else { String::new() };
        println!("  status           {line}{suffix}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alerts::AlertEngine;
    use crate::live::spawn_pump;
    use crate::state::Hub;
    use chartkit_core::{Timeframe, Venue};
    use chartkit_store::{BarFilter, Db};
    use futures_util::{SinkExt, StreamExt};
    use serde_json::Value;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::path::Path;
    use tokio::net::TcpListener;
    use tokio::sync::broadcast;
    use tokio_tungstenite::accept_hdr_async;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::Message;

    /// Captured venue messages live next to the adapters that parse them.
    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../ingest/fixtures");

    fn fixture(venue: &str, name: &str) -> String {
        std::fs::read_to_string(Path::new(FIXTURES).join(venue).join(name))
            .unwrap_or_else(|error| panic!("{venue}/{name}: {error}"))
    }

    /// One move of a fake venue: put a frame on the wire, or wait for the adapter to ask
    /// for something. Waiting is what keeps a replay honest — a real venue only sends data
    /// once the client has subscribed, and a script that fires immediately would let the
    /// adapter look broken when it is merely late.
    #[derive(Clone)]
    enum Step {
        Send(Message),
        /// Read up to n frames from the adapter, giving up after a moment of silence.
        Await(usize),
    }

    /// A localhost venue: replays one script per connection, records every frame the
    /// adapter sends, then hangs up so the adapter has to reconnect.
    struct FakeVenue {
        addr: SocketAddr,
        /// Frames the adapter sent, as text (hex for binary frames).
        requests: mpsc::UnboundedReceiver<String>,
        /// `Cookie` headers the adapter presented, one per connection.
        cookies: mpsc::UnboundedReceiver<String>,
        task: tokio::task::JoinHandle<()>,
    }

    impl FakeVenue {
        /// `patience` is how long a connection stays open after its script ran: the window
        /// in which a resubscribe or a gap fill is expected.
        async fn start(scripts: Vec<Vec<Step>>, patience: Duration) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().expect("addr");
            let (request_tx, requests) = mpsc::unbounded_channel();
            let (cookie_tx, cookies) = mpsc::unbounded_channel();
            let task = tokio::spawn(async move {
                let mut index = 0;
                while let Ok((stream, _)) = listener.accept().await {
                    let script = scripts[index.min(scripts.len() - 1)].clone();
                    index += 1;
                    let mut socket = match accept_hdr_async(
                        stream,
                        |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
                            let cookie = request
                                .headers()
                                .get("cookie")
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or("")
                                .to_string();
                            let _ = cookie_tx.send(cookie);
                            Ok(response)
                        },
                    )
                    .await
                    {
                        Ok(socket) => socket,
                        Err(error) => {
                            tracing::warn!("fake venue handshake failed: {error}");
                            continue;
                        }
                    };
                    let mut broken = false;
                    for step in script {
                        match step {
                            Step::Send(message) => {
                                if socket.send(message).await.is_err() {
                                    broken = true;
                                    break;
                                }
                            }
                            Step::Await(want) => {
                                let mut got = 0;
                                while got < want {
                                    match tokio::time::timeout(
                                        Duration::from_millis(800),
                                        socket.next(),
                                    )
                                    .await
                                    {
                                        Ok(Some(Ok(frame))) => {
                                            if record(&request_tx, frame) {
                                                got += 1;
                                            }
                                        }
                                        _ => break,
                                    }
                                }
                            }
                        }
                    }
                    if !broken {
                        let deadline = tokio::time::Instant::now() + patience;
                        loop {
                            let left =
                                deadline.saturating_duration_since(tokio::time::Instant::now());
                            if left.is_zero() {
                                break;
                            }
                            match tokio::time::timeout(left, socket.next()).await {
                                Ok(Some(Ok(frame))) => {
                                    record(&request_tx, frame);
                                }
                                _ => break,
                            }
                        }
                        // Hang up: the adapter has to prove it can come back.
                        let _ = socket.close(None).await;
                        let _ = socket.flush().await;
                    }
                }
            });
            Self { addr, requests, cookies, task }
        }

        /// Everything the adapter asked for, for up to `patience`.
        async fn drain(&mut self, patience: Duration) -> Vec<String> {
            let mut out = Vec::new();
            let deadline = tokio::time::Instant::now() + patience;
            loop {
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                if left.is_zero() {
                    return out;
                }
                match tokio::time::timeout(left, self.requests.recv()).await {
                    Ok(Some(text)) => out.push(text),
                    _ => return out,
                }
            }
        }

        async fn cookie(&mut self) -> Option<String> {
            tokio::time::timeout(Duration::from_secs(5), self.cookies.recv())
                .await
                .ok()
                .flatten()
        }

        fn url(&self, path: &str) -> String {
            format!("ws://{}{path}", self.addr)
        }
    }

    impl Drop for FakeVenue {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// Record one frame the adapter sent. Returns whether it was data (a close or a ping
    /// does not count as an answer to an `Await`).
    fn record(tx: &mpsc::UnboundedSender<String>, frame: Message) -> bool {
        match frame {
            Message::Text(text) => tx.send(text.to_string()).is_ok(),
            Message::Binary(bytes) => {
                let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
                tx.send(hex).is_ok()
            }
            Message::Close(_) | Message::Ping(_) | Message::Pong(_) => false,
            Message::Frame(_) => false,
        }
    }

    /// Store, hub, alert engine and pump, wired as `start()` wires them. The hub subscriber
    /// stands in for a connected client.
    fn harness() -> (
        Arc<Db>,
        Hub,
        mpsc::UnboundedSender<FeedEvent>,
        broadcast::Receiver<String>,
    ) {
        let db = Arc::new(Db::in_memory().expect("in-memory store"));
        let hub = Hub::new();
        let alerts = AlertEngine::new(Arc::new(Db::in_memory().expect("rules store")), hub.clone());
        let (tx, rx) = mpsc::unbounded_channel();
        spawn_pump(Arc::clone(&db), hub.clone(), alerts, rx);
        let events = hub.subscribe();
        (db, hub, tx, events)
    }

    /// Everything the hub carries for `budget`, in order: one timeline to assert against
    /// rather than a race between the socket, the store and the client.
    async fn gather(events: &mut broadcast::Receiver<String>, budget: Duration) -> Vec<Value> {
        let mut seen = Vec::new();
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return seen;
            }
            match tokio::time::timeout(left, events.recv()).await {
                Ok(Ok(text)) => match serde_json::from_str(&text) {
                    Ok(value) => seen.push(value),
                    Err(_) => {}
                },
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                _ => return seen,
            }
        }
    }

    /// The status states the hub has carried, oldest first.
    fn states(seen: &[Value]) -> Vec<String> {
        seen.iter()
            .filter(|value| value["type"] == "status")
            .map(|value| value["state"].as_str().unwrap_or("?").to_string())
            .collect()
    }

    /// Events of one kind, in order.
    fn of<'a>(seen: &'a [Value], kind: &str) -> Vec<&'a Value> {
        seen.iter()
            .filter(|value| value["type"] == kind)
            .collect()
    }

    /// The position of a state, or a plain failure naming the whole timeline.
    fn position(seen: &[Value], state: &str) -> usize {
        states(seen)
            .iter()
            .position(|row| row == state)
            .unwrap_or_else(|| panic!("no {state} status in {:?}", states(seen)))
    }

    fn text(body: &str) -> Message {
        Message::Text(body.to_string().into())
    }

    /// A frame from `fixtures/rithmic/frames.json`.
    fn rithmic_frame(name: &str) -> Message {
        let document: Value =
            serde_json::from_str(&fixture("rithmic", "frames.json")).expect("frames.json");
        let hex = document[name].as_str().expect(name);
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
            .collect();
        Message::Binary(bytes.into())
    }

    fn hex_decode(frame: &str) -> Vec<u8> {
        (0..frame.len())
            .step_by(2)
            .filter_map(|i| u8::from_str_radix(&frame[i..i + 2], 16).ok())
            .collect()
    }

    /// A Tradovate request frame: endpoint, id, query, body, each on its own line.
    struct VenueRequest {
        endpoint: String,
        id: u64,
        body: String,
    }

    fn parse_requests(frames: &[String]) -> Vec<VenueRequest> {
        frames
            .iter()
            .filter_map(|frame| {
                let mut lines = frame.trim_end().split('\n');
                let endpoint = lines.next()?.to_string();
                let id = lines.next()?.parse().ok()?;
                let _query = lines.next()?;
                let body = lines.collect();
                Some(VenueRequest { endpoint, id, body })
            })
            .collect()
    }

    /// Same for a quote or DOM row, which the docs key by `contractId`; a subscription made
    /// by symbol has no contract id to match, so the reply carries the symbol.
    fn quote_reply(fixture: &str, key: &str, symbol: &str) -> String {
        let mut document: Value = serde_json::from_str(fixture).expect("quote fixture");
        document["d"][key][0]["symbol"] = Value::from(symbol);
        format!("a[{}]", document)
    }

    fn tradovate_config(url: &str) -> TradovateConfig {
        TradovateConfig {
            server: chartkit_ingest::tradovate::TradovateServer::Demo,
            user: "user".into(),
            password: "secret".into(),
            app_id: "chartkit".into(),
            device_id: "test".into(),
            ws_url: Some(url.into()),
            token: Some("ag_test".into()),
        }
    }

    fn ibkr_config(url: &str) -> IbkrConfig {
        IbkrConfig {
            base_url: "http://127.0.0.1:1".into(),
            bearer_token: None,
            account: Some("U1234567".into()),
            ws_url: Some(url.into()),
            resubscribe_after: Duration::from_millis(400),
            session: Some("d21b8cf5ebc8ea01c6ce37c8125ec83f".into()),
        }
    }

    fn rithmic_config(url: &str) -> RithmicConfig {
        RithmicConfig {
            user: "user".into(),
            password: "secret".into(),
            system: "Rithmic Paper Trading".into(),
            gateway: "wss://rprotocol.rithmic.com:443".into(),
            app_name: "chartkit".into(),
            ws_url: Some(url.into()),
            partial_book_after: Duration::from_millis(300),
        }
    }

    /// Tradovate: captured frames replay through the pump into the store and out to a
    /// client; the socket then drops and the prints that follow carry a gap the adapter
    /// notices and fills.
    #[tokio::test]
    async fn tradovate_frames_replay_through_store_and_hub_and_survive_a_gap() {
        let authorized = r#"a[{"s":200,"i":1}]"#;
        // Four requests follow an authorize: quote, DOM, candles, ticks.
        let first = vec![
            Step::Send(text("o")),
            Step::Send(text(authorized)),
            Step::Await(4),
            Step::Send(text(&quote_fixture("ESZ6"))),
            Step::Send(text(&dom_fixture("ESZ6"))),
            Step::Send(text(&chart_fixture("ESZ6", "MinuteBar"))),
            Step::Send(text(&chart_fixture("ESZ6", "Tick"))),
        ];
        let second = vec![
            Step::Send(text("o")),
            Step::Send(text(authorized)),
            Step::Await(4),
            Step::Send(text(&tick_fixture("ESZ6", "tick-gap.json"))),
        ];
        let mut venue = FakeVenue::start(vec![first, second], Duration::from_millis(900)).await;

        let (db, _hub, tx, mut events) = harness();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let feed = TradovateFeed::new(
            tradovate_config(&venue.url("/v1/websocket")),
            vec![Timeframe::Minute(1)],
        );
        let task = tokio::spawn(async move { feed.run(cmd_rx, tx).await });
        cmd_tx
            .send(FeedCommand::Subscribe {
                venue: Venue::Tradovate,
                symbol: "ESZ6".into(),
                timeframe: Timeframe::Minute(1),
            })
            .expect("subscribe");

        let seen = gather(&mut events, Duration::from_secs(6)).await;
        let asked = venue.drain(Duration::from_millis(2_500)).await;
        task.abort();

        // The requests: one line each for endpoint, id, query and body, as the docs demand.
        let requests = parse_requests(&asked);
        let bars = requests
            .iter()
            .find(|request| request.endpoint == "md/getChart" && request.body.contains("MinuteBar"))
            .unwrap_or_else(|| panic!("no candle request in {asked:?}"));
        let ticks = requests
            .iter()
            .find(|request| request.endpoint == "md/getChart" && request.body.contains("\"Tick\""))
            .unwrap_or_else(|| panic!("no tick request in {asked:?}"));
        assert!(bars.body.contains("ESZ6"), "the chart asked for the wrong symbol");
        assert!(ticks.body.contains("ESZ6"), "the tick chart asked for the wrong symbol");
        assert_ne!(bars.id, ticks.id, "two requests cannot share an id");
        // The replies below are stamped with these ids, so they have to be the real ones.
        assert_eq!(bars.id, BAR_REQUEST);
        assert_eq!(ticks.id, TICK_REQUEST);
        assert!(requests
            .iter()
            .any(|request| request.endpoint == "md/subscribeQuote" && request.body.contains("ESZ6")));
        assert!(requests
            .iter()
            .any(|request| request.endpoint == "md/subscribeDOM" && request.body.contains("ESZ6")));
        // A reconnect re-authorizes and re-subscribes; the ids repeat per connection.
        assert!(
            asked.iter().filter(|frame| frame.starts_with("authorize")).count() >= 2,
            "no authorize after the drop: {asked:?}"
        );

        // The client sees the venue go live, then the ladder, prints and candles.
        let order = states(&seen);
        assert!(order.contains(&"live".to_string()), "never live: {seen:?}");
        let depths = of(&seen, "depth");
        // The quote carries one level per side; the DOM carries the book.
        assert_eq!(depths[0]["snapshot"]["bids"].as_array().unwrap().len(), 1);
        assert_eq!(depths[0]["snapshot"]["asks"][0]["price"], 18_410.012);
        assert_eq!(depths[1]["snapshot"]["bids"].as_array().unwrap().len(), 3);
        assert_eq!(depths[1]["snapshot"]["bids"][2]["qty"], 758.21);
        let prints = of(&seen, "trades");
        assert_eq!(prints[0]["instrument"], "TRADOVATE:ESZ6");
        assert_eq!(prints[0]["trades"][0]["seq"], 11_768_401);
        assert_eq!(prints[0]["trades"][0]["price"], 2979.25);
        assert_eq!(prints[0]["trades"][0]["aggressor"], "buy");
        assert_eq!(prints[0]["trades"].as_array().unwrap().len(), 3);
        assert_eq!(prints[0]["trades"][2]["seq"], 11_768_403);
        // The reconnect replays the prints it already had, then jumps over four missing
        // ticks; the print beyond the hole still reaches the client.
        let seqs: Vec<u64> = prints
            .iter()
            .flat_map(|event| {
                event["trades"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|trade| trade["seq"].as_u64().unwrap())
            })
            .collect();
        assert!(seqs.contains(&11_768_407), "the print past the gap is missing: {seqs:?}");
        let bars_seen = of(&seen, "bar");
        assert_eq!(bars_seen[0]["instrument"], "TRADOVATE:ESZ6");
        assert_eq!(bars_seen[0]["bar"]["high"], 2334.5);
        assert_eq!(bars_seen.len(), 2, "both candles of the fixture reach the client");

        // The pump wrote the same events to disk.
        let stored = db
            .bars(BarFilter {
                instrument: "TRADOVATE:ESZ6".into(),
                timeframe: Timeframe::Minute(1),
                from: None,
                to: None,
                limit: 50,
            })
            .expect("bars");
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0].start, 1_492_081_200_000);
        let stored_trades = db.trades("TRADOVATE:ESZ6", None, None, 50).expect("trades");
        assert_eq!(
            stored_trades.last().map(|trade| trade.seq),
            Some(11_768_407),
            "the print past the gap is stored too: {stored_trades:?}"
        );

        // The second connection's packet jumps from tick id 11768402 to 11768407. The
        // adapter says so on the wire and re-asks for the chart from the last tick applied.
        assert!(
            order.contains(&"backfilling".to_string()),
            "the client was never told about the gap: {order:?}"
        );
        let details: Vec<&str> = of(&seen, "status")
            .iter()
            .filter(|value| value["state"] == "backfilling")
            .map(|value| value["detail"].as_str().unwrap_or(""))
            .collect();
        assert!(
            details.last().unwrap().contains("11768407"),
            "the gap report names the wrong tick: {details:?}"
        );
        let fills = requests
            .iter()
            .filter(|request| request.body.contains("asFarAsTimestamp") && request.body.contains("2019-07-18"))
            .count();
        assert!(fills >= 1, "no gap-fill request in {asked:?}");
    }

    /// A fixture with the id Tradovate echoes for the request that asked for it.
    fn chart_fixture(symbol: &str, kind: &str) -> String {
        let name = if kind == "Tick" { "tick-packet.json" } else { "chart-bars.json" };
        let mut document: Value = serde_json::from_str(&fixture("tradovate", name)).expect(name);
        let packet = &mut document["d"]["charts"][0];
        packet["symbol"] = Value::from(symbol);
        // The venue answers with the id of the request; the test replays both the candle
        // and the tick reply, so the id has to be the one that request used.
        packet["id"] = Value::from(if kind == "Tick" { TICK_REQUEST } else { BAR_REQUEST });
        format!("a[{document}]")
    }

    /// A tick packet under a different name: the same shape, with the ids that jump.
    fn tick_fixture(symbol: &str, name: &str) -> String {
        let mut document: Value = serde_json::from_str(&fixture("tradovate", name)).expect(name);
        let packet = &mut document["d"]["charts"][0];
        packet["symbol"] = Value::from(symbol);
        packet["id"] = Value::from(TICK_REQUEST);
        format!("a[{document}]")
    }

    fn quote_fixture(symbol: &str) -> String {
        quote_reply(&fixture("tradovate", "quote.json"), "quotes", symbol)
    }

    fn dom_fixture(symbol: &str) -> String {
        quote_reply(&fixture("tradovate", "dom.json"), "doms", symbol)
    }

    /// Request ids the adapter assigns, asserted below rather than assumed: authorize takes
    /// 1, then quote, DOM, the tick chart, then the candles.
    const BAR_REQUEST: u64 = 5;
    const TICK_REQUEST: u64 = 4;

    /// IBKR: the venue's own entitlement marker decides whether the strip says live or
    /// delayed, a frame whose stamp went backwards is reported instead of drawn, and a
    /// reconnect asks for the stream again.
    #[tokio::test]
    async fn ibkr_reports_delay_then_live_and_drops_a_stale_frame() {
        let live = fixture("ibkr", "smd-realtime.json");
        let delayed = fixture("ibkr", "smd-delayed.json");
        let mut stale: Value = serde_json::from_str(&delayed).expect("smd fixture");
        stale["31"] = serde_json::json!("182.10");
        stale["_updated"] = serde_json::json!(1_699_885_800_100i64); // older than the last applied
        let stale = stale.to_string();

        // Two requests open the stream: the fields, and the BookTrader ladder.
        let first = vec![
            Step::Await(2),
            Step::Send(text(&live)),
            Step::Send(text(&delayed)),
            Step::Send(text(&stale)),
        ];
        let second = vec![Step::Await(2), Step::Send(text(&live))];
        let mut venue = FakeVenue::start(vec![first, second], Duration::from_millis(700)).await;

        let (db, _hub, tx, mut events) = harness();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let feed = IbkrFeed::new(ibkr_config(&venue.url("/v1/api/ws")), vec![Timeframe::Minute(1)]);
        let task = tokio::spawn(async move { feed.run(cmd_rx, tx).await });
        cmd_tx
            .send(FeedCommand::Subscribe {
                venue: Venue::InteractiveBrokers,
                symbol: "AAPL@265598".into(),
                timeframe: Timeframe::Minute(1),
            })
            .expect("subscribe");

        let seen = gather(&mut events, Duration::from_secs(6)).await;
        let asked = venue.drain(Duration::from_millis(2_500)).await;
        let cookie = venue.cookie().await.expect("a cookie");
        task.abort();

        // The gateway authenticates the socket with a session cookie, and nothing else.
        assert!(
            cookie.contains(r#"api={"d21b8cf5ebc8ea01c6ce37c8125ec83f"}"#),
            "the cookie the connection guide requires is missing: {cookie:?}"
        );

        // Entitlement is decided by the venue, in the order its frames arrived.
        let order = states(&seen);
        let live_at = position(&seen, "live");
        let delayed_at = position(&seen, "delayed");
        let stalled_at = position(&seen, "stalled");
        assert!(live_at < delayed_at && delayed_at < stalled_at, "wrong order: {order:?}");
        let detail = of(&seen, "status")
            .iter()
            .filter(|value| value["state"] == "delayed")
            .last()
            .expect("a delayed status")["detail"]
            .to_string();
        assert_eq!(detail, "\"delayed 15-20 min\"");

        // The frame stamped before the last applied one is never shown as a print.
        let prints = of(&seen, "trades");
        assert_eq!(prints[0]["instrument"], "IBKR:AAPL");
        assert_eq!(prints[0]["trades"][0]["price"], 182.50);
        assert_eq!(prints[1]["trades"][0]["price"], 182.30);
        assert!(
            !prints
                .iter()
                .any(|event| event["trades"][0]["price"] == serde_json::json!(182.10)),
            "a stale print reached the client: {seen:?}"
        );
        let stored = db.trades("IBKR:AAPL", None, None, 50).expect("trades");
        assert_eq!(stored.len(), 2, "the store keeps the same two prints: {stored:?}");

        // The venue hangs up; the next connection asks for the stream again.
        let market_data = asked
            .iter()
            .filter(|frame| frame.starts_with("smd+265598+"))
            .count();
        assert!(market_data >= 2, "no resubscribe after the drop: {asked:?}");
        assert!(
            asked
                .iter()
                .any(|frame| frame.starts_with("sbd+U1234567+265598")),
            "the price ladder was never asked for: {asked:?}"
        );
        assert!(asked.iter().any(|frame| frame == "tic"), "no keep-alive ping: {asked:?}");
    }

    /// Rithmic: binary R|Protocol frames log in, publish prints and a book, recover an
    /// unfinished depth snapshot, and log in again when the socket drops.
    #[tokio::test]
    async fn rithmic_logs_in_streams_depth_and_recovers_an_unfinished_book() {
        let first = vec![
            Step::Await(1),
            Step::Send(rithmic_frame("response-login")),
            Step::Await(1),
            Step::Send(rithmic_frame("last-trade-1")),
            Step::Send(rithmic_frame("last-trade-2")),
            Step::Send(rithmic_frame("order-book")),
            Step::Send(rithmic_frame("order-book-begin-only")),
        ];
        let second = vec![
            Step::Await(1),
            Step::Send(rithmic_frame("response-login")),
            Step::Await(1),
            Step::Send(rithmic_frame("last-trade-3")),
        ];
        let mut venue = FakeVenue::start(vec![first, second], Duration::from_millis(1_200)).await;

        let (db, _hub, tx, mut events) = harness();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let feed = RithmicFeed::new(rithmic_config(&venue.url("/")), vec![Timeframe::Minute(1)]);
        let task = tokio::spawn(async move { feed.run(cmd_rx, tx).await });
        cmd_tx
            .send(FeedCommand::Subscribe {
                venue: Venue::Rithmic,
                symbol: "MES@CME".into(),
                timeframe: Timeframe::Minute(1),
            })
            .expect("subscribe");

        let seen = gather(&mut events, Duration::from_secs(6)).await;
        let asked = venue.drain(Duration::from_millis(2_500)).await;
        task.abort();

        // What the adapter put on the wire: a login, then market data subscriptions, and a
        // login again after the drop.
        let sent: Vec<chartkit_ingest::rithmic::Decoded> = asked
            .iter()
            .filter_map(|frame| chartkit_ingest::rithmic::decode_frame(&hex_decode(frame)).ok())
            .collect();
        let template_of = |message: &chartkit_ingest::rithmic::Decoded| {
            message.varint(chartkit_ingest::rithmic::field::TEMPLATE_ID).unwrap_or(0)
        };
        let logins = sent.iter().filter(|m| template_of(m) == 10).count();
        assert!(logins >= 2, "expected a login per connection, got {logins}");
        let subscribes = sent.iter().filter(|m| template_of(m) == 100).count();
        assert!(subscribes >= 2, "expected a subscription per connection, got {subscribes}");

        let order = states(&seen);
        assert!(order.contains(&"live".to_string()), "never logged in: {seen:?}");
        let prints = of(&seen, "trades");
        assert_eq!(prints[0]["instrument"], "RITHMIC:MES@CME");
        assert_eq!(prints[0]["trades"][0]["price"], 5_101.25);
        assert_eq!(prints[0]["trades"][0]["aggressor"], "buy");
        assert_eq!(prints[1]["trades"][0]["price"], 5_101.00);
        assert_eq!(prints[1]["trades"][0]["aggressor"], "sell");
        let books = of(&seen, "depth");
        assert_eq!(books[0]["snapshot"]["bids"].as_array().unwrap().len(), 2);
        assert_eq!(books[0]["snapshot"]["asks"][0]["price"], 5_101.00);
        assert_eq!(books[0]["snapshot"]["bids"][0]["qty"], 12.0);

        let stored = db.trades("RITHMIC:MES@CME", None, None, 50).expect("trades");
        assert_eq!(stored.len(), 3, "both prints plus the one the reconnect delivered: {stored:?}");
        assert_eq!(stored[2].price, 5_101.50, "the reconnect's print is stored too");

        // A BEGIN with no END means rows went missing in flight: the book is not to be
        // trusted, so the adapter says the feed is stalled and re-asks for the market data.
        assert!(
            order.contains(&"stalled".to_string()),
            "the unfinished book was never reported: {order:?}"
        );
        let detail = of(&seen, "status")
            .iter()
            .filter(|value| value["state"] == "stalled")
            .last()
            .expect("a stalled status")["detail"]
            .to_string();
        assert!(detail.contains("depth"), "the report says nothing about depth: {detail}");
        // The re-ask is the same request as a subscribe, so the count is the evidence: one
        // market-data request per connection, plus one for the book that never finished.
        assert!(
            subscribes > logins,
            "expected {logins} subscriptions plus a re-ask, got {subscribes}: {asked:?}"
        );
    }

    /// An unconfigured venue answers `not-configured`, not an error and not a fake success.
    #[tokio::test]
    async fn an_unconfigured_venue_reports_itself_and_a_saved_credential_starts_it() {
        let dir = std::env::temp_dir().join(format!("ck-feeds-{}", chartkit_core::new_id("t")));
        std::fs::create_dir_all(&dir).expect("dir");
        let (_db, hub, tx, mut events) = harness();
        let feeds = Feeds::new(&dir, tx, vec![Timeframe::Minute(1)], hub.clone());
        feeds.ensure_running(Venue::Tradovate);
        let replayed = hub.status_snapshot();
        assert_eq!(replayed.len(), 1, "one status for one venue");
        let value: Value = serde_json::from_str(&replayed[0]).expect("a status");
        assert_eq!(value["state"], "not-configured");
        assert_eq!(value["venue"], "tradovate");
        assert!(value["detail"]
            .as_str()
            .unwrap()
            .contains("TRADOVATE_USER"));

        // A client that connects later gets the same answer, the way the hub replays any
        // other feed state.
        let next = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .ok()
            .and_then(|value| value.ok())
            .expect("a broadcast");
        assert!(next.contains("not-configured"), "{next}");

        // Saving credentials through the path the settings panel uses clears the state.
        let mut patch = chartkit_ingest::credentials::Values::new();
        patch.insert("user".into(), "trader".into());
        patch.insert("password".into(), "secret".into());
        let statuses = feeds.save(Venue::Tradovate, &patch).expect("save");
        let tradovate = statuses
            .iter()
            .find(|status| status.venue == Venue::Tradovate)
            .expect("tradovate");
        assert!(tradovate.configured);
        assert!(tradovate.missing.is_empty());
        // The stale "not configured" must not outlive the credentials that replaced it, and
        // the client on the other end of the socket has to hear about the change.
        let mut announced = None;
        for _ in 0..20 {
            let Ok(Ok(text)) = tokio::time::timeout(Duration::from_secs(1), events.recv()).await
            else {
                break;
            };
            if text.contains("waiting for a symbol") {
                announced = Some(text);
                break;
            }
        }
        let status: Value = serde_json::from_str(&announced.expect("the saved venue announced itself")).expect("a status");
        assert_eq!(status["state"], "connecting");
        assert_eq!(status["venue"], "tradovate");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_probe_summary_reads_as_what_the_venue_sent() {
        let report = ProbeReport {
            venue: Venue::Rithmic,
            entitlement: "realtime".into(),
            first_sequence: Some(1_700_000_000_250_000),
            first_stamp: Some(1_700_000_000_250),
            bars: 0,
            trades: 3,
            depth: 1,
            status: vec!["live: logged in, streaming".into()],
            latency_ms: Some(41),
        };
        print_probe(&report);
        assert_eq!(kebab(FeedState::NotConfigured), "not-configured");
        assert_eq!(kebab(FeedState::Delayed), "delayed");
    }
}
