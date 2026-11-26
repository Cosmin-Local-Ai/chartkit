use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chartkit_ingest::{BinanceFeed, FeedCommand};
use chartkit_store::Db;
use tokio::sync::{broadcast, mpsc};

use crate::alerts::AlertEngine;
use crate::prints::PrintBackfill;

/// Fan-out of feed events to every connected web socket. A local single-user app,
/// so one shared channel is enough; slow clients drop messages instead of stalling
/// the pump.
#[derive(Clone)]
pub struct Hub {
    sender: broadcast::Sender<String>,
    /// Feed state is edge-triggered, but sockets join at any moment, so the newest
    /// value per key is kept and replayed to each new client.
    latest_status: Arc<Mutex<HashMap<String, String>>>,
    /// The same idea for fired alerts: a page that reconnects, or opens late, learns what
    /// it missed from the events the hub still holds. History is the authority for older
    /// fires; this only covers the gap the socket was not open for.
    recent_alerts: Arc<Mutex<VecDeque<String>>>,
}

impl Hub {
    pub fn new() -> Self {
        Self {
            sender: broadcast::channel(4096).0,
            latest_status: Arc::new(Mutex::new(HashMap::new())),
            recent_alerts: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.sender.subscribe()
    }

    pub fn send(&self, text: impl Into<String>) {
        let _ = self.sender.send(text.into());
    }

    pub fn remember_status(&self, key: &str, text: impl Into<String>) {
        let Ok(mut latest) = self.latest_status.lock() else { return };
        latest.insert(key.to_string(), text.into());
    }

    pub fn remember_alert(&self, text: impl Into<String>) {
        let Ok(mut recent) = self.recent_alerts.lock() else { return };
        recent.push_back(text.into());
        while recent.len() > REPLAYED_ALERTS {
            recent.pop_front();
        }
    }

    /// The alerts the hub still holds, oldest first.
    pub fn alert_snapshot(&self) -> Vec<String> {
        self.recent_alerts.lock().map(|recent| recent.iter().cloned().collect()).unwrap_or_default()
    }

    pub fn status_snapshot(&self) -> Vec<String> {
        self.latest_status.lock().map(|latest| latest.values().cloned().collect()).unwrap_or_default()
    }
}

/// How many fired alerts the hub still holds for a socket that joins late.
const REPLAYED_ALERTS: usize = 50;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    pub cmd_tx: mpsc::UnboundedSender<FeedCommand>,
    pub hub: Hub,
    /// REST-only handle for instrument lists and candle backfill.
    pub rest: BinanceFeed,
    /// Pulls prints the live stream never saw into the store, on demand and at boot.
    pub prints: PrintBackfill,
    /// The rules the live pump judges, so a REST change can be handed straight to it.
    pub alerts: Arc<AlertEngine>,
    pub ui_dir: PathBuf,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}
