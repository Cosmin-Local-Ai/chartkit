//! Live path: the store-and-fan-out pump, and the web socket clients use.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use chartkit_core::Timeframe;
use chartkit_ingest::{FeedCommand, FeedEvent};
use chartkit_store::Db;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::alerts::AlertEngine;
use crate::state::{AppState, Hub};

/// Single writer for every feed event: persist what belongs on disk, judge the alert
/// rules, then broadcast. Keeping one path means the chart, the store and the rules can
/// never disagree, and an alert is decided whether or not a page is open.
pub fn spawn_pump(
    db: Arc<Db>,
    hub: Hub,
    alerts: Arc<AlertEngine>,
    mut inbound: mpsc::UnboundedReceiver<FeedEvent>,
) {
    tokio::spawn(async move {
        while let Some(event) = inbound.recv().await {
            match &event {
                FeedEvent::Trades { instrument, trades } => {
                    if let Err(error) = db.record_trades(instrument, trades) {
                        tracing::warn!("trades not stored: {error}");
                    }
                }
                FeedEvent::Bar { instrument, timeframe, bar } => {
                    if let Err(error) = db.upsert_bars(instrument, &timeframe.as_key(), std::slice::from_ref(bar)) {
                        tracing::warn!("bar not stored: {error}");
                    }
                }
                FeedEvent::Instruments { items, .. } => {
                    if let Err(error) = db.upsert_instruments(items) {
                        tracing::warn!("instruments not stored: {error}");
                    }
                }
                FeedEvent::Depth { .. } | FeedEvent::Status { .. } => {}
            }
            alerts.on_event(&event);
            if let Ok(text) = serde_json::to_string(&event) {
                if let FeedEvent::Status { instrument, .. } = &event {
                    hub.remember_status(instrument.as_deref().unwrap_or("feed"), text.clone());
                }
                hub.send(text);
            }
        }
    });
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    #[serde(rename_all = "camelCase")]
    Subscribe { symbol: String, timeframe: String },
    #[serde(rename_all = "camelCase")]
    Unsubscribe { symbol: String },
}

pub async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| session(socket, state))
}

async fn session(mut socket: WebSocket, state: AppState) {
    let mut events = state.hub.subscribe();
    let hello = json!({ "type": "hello", "time": chartkit_core::now_ms() });
    if socket.send(Message::Text(hello.to_string().into())).await.is_err() {
        return;
    }
    // A socket opened after the feed connected still needs to know its state.
    for status in state.hub.status_snapshot() {
        if socket.send(Message::Text(status.into())).await.is_err() {
            return;
        }
    }
    // ...and what fired while it was not open. Older fires come from history over REST.
    for alert in state.hub.alert_snapshot() {
        if socket.send(Message::Text(alert.into())).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Text(text))) => {
                    match serde_json::from_str::<ClientMessage>(text.as_str()) {
                        Ok(ClientMessage::Subscribe { symbol, timeframe }) => {
                            match timeframe.parse::<Timeframe>() {
                                Ok(tf) => {
                                    let _ = state.cmd_tx.send(FeedCommand::Subscribe { symbol, timeframe: tf });
                                }
                                Err(error) => tracing::warn!("bad timeframe: {error}"),
                            }
                        }
                        Ok(ClientMessage::Unsubscribe { symbol }) => {
                            let _ = state.cmd_tx.send(FeedCommand::Unsubscribe { symbol });
                        }
                        Err(error) => tracing::warn!("bad client message: {error}"),
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                Some(Ok(_)) => {}
            },
            next = events.recv() => match next {
                Ok(text) => {
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        return;
                    }
                }
                // A client that falls behind loses frames rather than blocking feeds.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::debug!("client lagged, dropped {skipped} events");
                }
                Err(_) => return,
            },
        }
    }
}
