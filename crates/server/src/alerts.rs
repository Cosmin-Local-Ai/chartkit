//! Server-side alerts: rules are judged in the live pump, so they hold with the page
//! closed, and every fire is stored before it is pushed.
//!
//! The contract is this project's own — no third-party alert payload was read when it was
//! designed. Two decisions shape it:
//!
//! * Price rules read every print, so an alert answers within one print of the level.
//!   Window rules (volume, delta) read a bar only once it has closed, so they never report
//!   a total that is still filling. Each rule says which point settles it.
//! * A fire is an edge, not a state. A rule answers when the value enters the state it
//!   watches and stays quiet until the value gives the level back, optionally by a re-arm
//!   gap, so a tape chopping across a level cannot fire print after print.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chartkit_core::{
    judge_downtime, step, Alert, AlertEvent, AlertFire, AlertKind, AlertTrigger, Downtime, Side,
    Timeframe,
};
use chartkit_ingest::FeedEvent;
use chartkit_store::{Db, StoreError};

use crate::state::Hub;

/// Prints summed into one bar, for the delta rules: aggressive buys minus aggressive
/// sells, read off the same prints the tape pane shows.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Bucket {
    start: i64,
    buy: f64,
    sell: f64,
}

/// The rules the evaluator holds in memory, plus the print sums the window rules need.
#[derive(Default)]
struct Book {
    alerts: Vec<Alert>,
    /// `(instrument, timeframe key)` to the bar currently filling.
    buckets: HashMap<(String, String), Bucket>,
}

/// Crossing state the evaluator owns: `(alert id, armed, last fired)`.
type StateChange = (String, bool, Option<i64>);

/// Judges rules against the live stream and handles what happens when one fires: store the
/// fire, save the rule's crossing state, push the event.
///
/// Rules are read once and kept, because a busy symbol delivers thousands of prints a
/// second; a REST change calls [`AlertEngine::reload`], which is a query over a handful of
/// rows. State is written back only when a crossing moves, never per print.
pub struct AlertEngine {
    db: Arc<Db>,
    hub: Hub,
    book: Mutex<Book>,
}

impl AlertEngine {
    pub fn new(db: Arc<Db>, hub: Hub) -> Arc<Self> {
        Arc::new(Self { db, hub, book: Mutex::new(Book::default()) })
    }

    /// Reads the rules and judges what the tape did while the server was down. Called once
    /// at startup, before the feed is pointed at the pump, so the newest stored observation
    /// is the last one the previous run saw.
    pub fn load(&self) {
        if let Err(error) = self.reload() {
            tracing::warn!("alerts unavailable: {error}");
            return;
        }
        self.reconcile_downtime();
    }

    /// Re-reads the rules after a REST change.
    pub fn reload(&self) -> Result<(), StoreError> {
        let alerts = self.db.alerts()?;
        let mut book = lock(&self.book);
        // Only delta rules sum prints, and only for the windows they name.
        let wanted: HashSet<(String, String)> = alerts
            .iter()
            .filter(|alert| alert.enabled && alert.kind == AlertKind::DeltaAbove)
            .filter_map(|alert| Some((alert.instrument.clone(), alert.timeframe?.as_key())))
            .collect();
        book.buckets.retain(|key, _| wanted.contains(key));
        book.alerts = alerts;
        Ok(())
    }

    /// One feed event. Called from the pump, after the event itself has been stored.
    pub fn on_event(&self, event: &FeedEvent) {
        let mut book = lock(&self.book);
        let mut moved: Vec<StateChange> = Vec::new();
        let mut fired: Vec<AlertFire> = Vec::new();
        match event {
            FeedEvent::Trades { instrument, trades } => {
                let frames = delta_frames(&book.alerts, instrument);
                for trade in trades {
                    for alert in book.alerts.iter_mut() {
                        if !watches(alert, instrument) || alert.kind.trigger() != AlertTrigger::Print {
                            continue;
                        }
                        let before = (alert.armed, alert.last_fired_at);
                        if let Some(fire) = step(alert, trade.price, trade.ts, None) {
                            fired.push(fire);
                        }
                        if (alert.armed, alert.last_fired_at) != before {
                            moved.push((alert.id.clone(), alert.armed, alert.last_fired_at));
                        }
                    }
                    for frame in &frames {
                        let start = frame.align(trade.ts);
                        let entry = book
                            .buckets
                            .entry((instrument.clone(), frame.as_key()))
                            .or_insert(Bucket::default());
                        // A boundary crossed while the stream was quiet enough to skip a
                        // kline starts a fresh bucket rather than merge into the old one.
                        if entry.start != start {
                            *entry = Bucket { start, ..Default::default() };
                        }
                        match trade.aggressor {
                            Side::Buy => entry.buy += trade.qty,
                            Side::Sell => entry.sell += trade.qty,
                        }
                    }
                }
            },
            FeedEvent::Bar { instrument, timeframe, bar } => {
                // An open bar carries a total that is still filling, so a window rule waits
                // for the closed one. That is the whole of the open-bar behaviour.
                if !bar.closed {
                    return;
                }
                let key = (instrument.clone(), timeframe.as_key());
                let summed = book.buckets.remove(&key).filter(|bucket| bucket.start == bar.start);
                for alert in book.alerts.iter_mut() {
                    if !watches(alert, instrument) || alert.timeframe != Some(*timeframe) {
                        continue;
                    }
                    let value = match alert.kind {
                        AlertKind::VolumeAbove => bar.volume,
                        AlertKind::DeltaAbove => match summed {
                            Some(bucket) => bucket.buy - bucket.sell,
                            // No prints were summed for this bar, so there is no delta to
                            // judge; a bar the venue closed without prints is not a spike.
                            None => continue,
                        },
                        _ => continue,
                    };
                    let before = (alert.armed, alert.last_fired_at);
                    if let Some(fire) = step(alert, value, bar.start, Some(bar.start)) {
                        fired.push(fire);
                    }
                    if (alert.armed, alert.last_fired_at) != before {
                        moved.push((alert.id.clone(), alert.armed, alert.last_fired_at));
                    }
                }
            },
            _ => {},
        }
        drop(book);
        for (id, armed, last_fired_at) in moved {
            if let Err(error) = self.db.note_alert_state(&id, armed, last_fired_at) {
                tracing::warn!("alert state not stored for {id}: {error}");
            }
        }
        for fire in fired {
            self.record(&fire, true);
        }
    }

    /// Stores a fire, and pushes it when it belongs to the live stream. A missed fire is
    /// stored only: a page that opens afterwards reads it from history.
    fn record(&self, fire: &AlertFire, push: bool) {
        if let Err(error) = self.db.record_alert_fire(fire) {
            tracing::warn!("alert fire not stored: {error}");
            return;
        }
        if !push {
            return;
        }
        match serde_json::to_string(&AlertEvent::new(fire.clone())) {
            Ok(text) => {
                self.hub.remember_alert(text.clone());
                self.hub.send(text);
            },
            Err(error) => tracing::warn!("alert event not encoded: {error}"),
        }
    }

    /// Reports what the rules would have done during the gap between runs, from the newest
    /// observation the store still holds: one fire flagged missed, or a re-arm.
    fn reconcile_downtime(&self) {
        let alerts = match self.db.alerts() {
            Ok(alerts) => alerts,
            Err(error) => {
                tracing::warn!("alerts unavailable: {error}");
                return;
            },
        };
        for mut alert in alerts {
            if !alert.enabled {
                continue;
            }
            let Some((value, ts, bar_start)) = newest_observation(&self.db, &alert) else { continue };
            let before = (alert.armed, alert.last_fired_at);
            match judge_downtime(&mut alert, value, ts, bar_start) {
                Downtime::Missed(fire) => {
                    tracing::info!("alert {} reported {} as missed while down", alert.id, fire.value);
                    self.record(&fire, false);
                },
                Downtime::Rearmed => tracing::debug!("alert {} rearmed after the gap", alert.id),
                Downtime::Nothing => continue,
            }
            if (alert.armed, alert.last_fired_at) != before {
                if let Err(error) = self.db.note_alert_state(&alert.id, alert.armed, alert.last_fired_at) {
                    tracing::warn!("alert state not stored for {}: {error}", alert.id);
                }
            }
        }
    }
}

/// Takes the book lock, tolerating a panic elsewhere rather than dropping the rules.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether this rule watches this instrument and is switched on.
fn watches(alert: &Alert, instrument: &str) -> bool {
    alert.enabled && alert.instrument.eq_ignore_ascii_case(instrument)
}

/// The windows the delta rules of one instrument need summed.
fn delta_frames(alerts: &[Alert], instrument: &str) -> Vec<Timeframe> {
    let mut frames: Vec<Timeframe> = alerts
        .iter()
        .filter(|alert| alert.enabled && alert.kind == AlertKind::DeltaAbove && alert.instrument.eq_ignore_ascii_case(instrument))
        .filter_map(|alert| alert.timeframe)
        .collect();
    frames.sort_by_key(Timeframe::as_key);
    frames.dedup();
    frames
}

/// The newest observation a rule could have acted on while the server was down: the last
/// print for a price rule, the last closed bar for a volume rule. A delta rule cannot be
/// reconstructed here, because its total was summed in memory by the pump.
fn newest_observation(db: &Db, alert: &Alert) -> Option<(f64, i64, Option<i64>)> {
    match alert.kind {
        AlertKind::PriceAbove | AlertKind::PriceBelow | AlertKind::PriceInRange => {
            let (price, ts) = db.newest_print(&alert.instrument).ok()??;
            Some((price, ts, None))
        },
        AlertKind::VolumeAbove => {
            let frame = alert.timeframe?;
            let bar = db.newest_closed_bar(&alert.instrument, &frame.as_key()).ok()??;
            Some((bar.volume, bar.start, Some(bar.start)))
        },
        AlertKind::DeltaAbove => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chartkit_core::{Bar, Side, Timeframe, Trade, WireEvent};
    use chartkit_ingest::FeedState;
    use chartkit_store::BarFilter;
    use std::time::Duration;
    use tokio::sync::{broadcast, mpsc};

    const ID: &str = "BINANCE:BTCUSDT";
    const MINUTE: i64 = 60_000;

    fn print(ts: i64, price: f64, aggressor: Side) -> Trade {
        Trade { ts, seq: ts as u64, price, qty: 2.0, aggressor }
    }

    fn lot(ts: i64, qty: f64, aggressor: Side) -> Trade {
        Trade { ts, seq: ts as u64, price: 100.0, qty, aggressor }
    }

    fn bar_at(start: i64, volume: f64, closed: bool) -> Bar {
        Bar { start, open: 100.0, high: 101.0, low: 99.0, close: 100.0, volume, trades: 3, closed }
    }

    fn priced(level: f64) -> Alert {
        Alert::new(ID, AlertKind::PriceAbove, level)
    }

    fn windowed(kind: AlertKind, threshold: f64, frame: Timeframe) -> Alert {
        let mut alert = Alert::new(ID, kind, threshold);
        alert.timeframe = Some(frame);
        alert
    }

    /// Store, hub and engine over one database, with the rules already in place. The
    /// receiver is taken before the engine loads, so every push the test causes is seen.
    fn harness(rules: Vec<Alert>) -> (Arc<Db>, Hub, Arc<AlertEngine>, broadcast::Receiver<String>) {
        let db = Arc::new(Db::in_memory().expect("in-memory store"));
        for rule in rules {
            db.insert_alert(&rule).expect("insert rule");
        }
        let hub = Hub::new();
        let events = hub.subscribe();
        let engine = AlertEngine::new(Arc::clone(&db), hub.clone());
        engine.load();
        (db, hub, engine, events)
    }

    /// Everything the hub has pushed since the last read.
    fn drained(events: &mut broadcast::Receiver<String>) -> Vec<AlertEvent> {
        let mut out = Vec::new();
        while let Ok(text) = events.try_recv() {
            let event: AlertEvent = serde_json::from_str(&text).expect("an alert event");
            assert_eq!(event.event_type, WireEvent::Alert);
            out.push(event);
        }
        out
    }

    fn tape(engine: &AlertEngine, prices: &[(i64, f64)]) {
        engine.on_event(&FeedEvent::Trades {
            instrument: ID.into(),
            trades: prices.iter().map(|(ts, price)| print(*ts, *price, Side::Buy)).collect(),
        });
    }

    fn closed(engine: &AlertEngine, frame: Timeframe, start: i64, volume: f64) {
        engine.on_event(&FeedEvent::Bar { instrument: ID.into(), timeframe: frame, bar: bar_at(start, volume, true) });
    }

    #[test]
    fn a_crossing_print_fires_once_and_the_level_being_held_is_quiet() {
        let (db, hub, engine, mut events) = harness(vec![priced(100.0)]);
        tape(&engine, &[(1, 101.0)]);
        let fired = drained(&mut events);
        assert_eq!(fired.len(), 1, "the crossing print fires");
        assert_eq!(fired[0].fire.value, 101.0);
        assert_eq!(fired[0].fire.instrument, ID);
        assert!(!fired[0].fire.missed);

        // Held above the level, print after print: nothing more is said.
        tape(&engine, &[(2, 140.0), (3, 100.5), (4, 100.0001)]);
        assert!(drained(&mut events).is_empty(), "no repeat while the level is held");

        // Given back, then crossed again: a fresh crossing earns a fresh fire.
        tape(&engine, &[(5, 99.0)]);
        assert!(drained(&mut events).is_empty(), "giving the level back is not a fire");
        tape(&engine, &[(6, 100.5)]);
        assert_eq!(drained(&mut events).len(), 1);
        assert_eq!(db.alert_fires(None, 50).expect("history").len(), 2);

        // A socket that opens now is told both, so a page reconnecting misses nothing.
        assert_eq!(hub.alert_snapshot().len(), 2);
        // The other half of the stream is left alone: a depth or status event cannot fire
        // a price rule.
        engine.on_event(&FeedEvent::Status {
            venue: chartkit_core::Venue::Binance,
            instrument: None,
            state: FeedState::Live,
            detail: String::new(),
        });
        assert!(drained(&mut events).is_empty());
    }

    #[test]
    fn a_rearm_gap_holds_off_a_tape_chopping_across_the_level() {
        let mut rule = priced(100.0);
        rule.rearm_gap = 2.0;
        let (_db, _hub, engine, mut events) = harness(vec![rule]);
        tape(&engine, &[(1, 101.0)]);
        assert_eq!(drained(&mut events).len(), 1);
        // 99 has not given up 100 - 2, so the next print above 100 is not a new crossing.
        tape(&engine, &[(2, 99.0), (3, 100.5)]);
        assert!(drained(&mut events).is_empty());
        tape(&engine, &[(4, 97.0)]);
        tape(&engine, &[(5, 100.5)]);
        assert_eq!(drained(&mut events).len(), 1);
    }

    #[test]
    fn a_window_rule_waits_for_the_bar_to_close() {
        let frame = Timeframe::Minute(1);
        let (db, _hub, engine, mut events) = harness(vec![windowed(AlertKind::VolumeAbove, 500.0, frame)]);

        // The live bar already carries 900, and it is not a fire: the total is still filling.
        engine.on_event(&FeedEvent::Bar { instrument: ID.into(), timeframe: frame, bar: bar_at(0, 900.0, false) });
        assert!(drained(&mut events).is_empty(), "an open bar cannot fire a window rule");
        assert!(db.alert_fires(None, 50).expect("history").is_empty());

        closed(&engine, frame, 0, 900.0);
        let fired = drained(&mut events);
        assert_eq!(fired.len(), 1, "the closed bar settles it");
        assert_eq!(fired[0].fire.value, 900.0);
        assert_eq!(fired[0].fire.bar_start, Some(0));
        assert_eq!(fired[0].fire.timeframe, Some(frame));

        // The next bar is still above the threshold: one fire per crossing, not per bar.
        closed(&engine, frame, MINUTE, 800.0);
        assert!(drained(&mut events).is_empty());
        // A bar back below the threshold re-arms, quietly.
        closed(&engine, frame, 2 * MINUTE, 10.0);
        assert!(drained(&mut events).is_empty());
        closed(&engine, frame, 3 * MINUTE, 700.0);
        assert_eq!(drained(&mut events).len(), 1);

        // A different window is not the rule's window.
        closed(&engine, Timeframe::Hour(1), 3 * MINUTE, 9_999.0);
        assert!(drained(&mut events).is_empty());
        // A rule on another instrument is not this tape.
        engine.on_event(&FeedEvent::Bar {
            instrument: "BINANCE:ETHUSDT".into(),
            timeframe: frame,
            bar: bar_at(4 * MINUTE, 9_999.0, true),
        });
        assert!(drained(&mut events).is_empty());
    }

    #[test]
    fn a_delta_rule_sums_the_prints_of_its_own_bar() {
        let frame = Timeframe::Minute(1);
        let (db, _hub, engine, mut events) = harness(vec![windowed(AlertKind::DeltaAbove, 5.0, frame)]);

        // Four bought, then three more: 7 of aggressive buying over a threshold of 5. The
        // bar's own traded quantity is 4.0, which is not what the rule reads.
        engine.on_event(&FeedEvent::Trades {
            instrument: ID.into(),
            trades: vec![lot(1_000, 4.0, Side::Buy), lot(2_000, 3.0, Side::Buy)],
        });
        assert!(drained(&mut events).is_empty(), "the bar is still open");
        closed(&engine, frame, 0, 4.0);
        let fired = drained(&mut events);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].fire.value, 7.0);

        // The next bar is sold into, so the delta goes the other way and stays under.
        engine.on_event(&FeedEvent::Trades {
            instrument: ID.into(),
            trades: vec![lot(MINUTE + 1_000, 6.0, Side::Sell), lot(MINUTE + 2_000, 1.0, Side::Buy)],
        });
        closed(&engine, frame, MINUTE, 7.0);
        assert!(drained(&mut events).is_empty(), "a delta of -5 does not beat 5");
        assert_eq!(db.alert_fires(None, 50).expect("history").len(), 1);
    }

    #[test]
    fn a_bar_without_prints_gives_a_delta_rule_nothing_to_judge() {
        let frame = Timeframe::Minute(1);
        // A threshold this low would be beaten by a delta of zero, so a fire here could
        // only come from reading a bar that had no prints at all.
        let (_db, _hub, engine, mut events) = harness(vec![windowed(AlertKind::DeltaAbove, -5.0, frame)]);
        closed(&engine, frame, 0, 900.0);
        assert!(drained(&mut events).is_empty(), "no prints means no delta, not a zero one");
        engine.on_event(&FeedEvent::Trades { instrument: ID.into(), trades: vec![lot(MINUTE + 1_000, 1.0, Side::Buy)] });
        closed(&engine, frame, MINUTE, 1.0);
        assert_eq!(drained(&mut events).len(), 1, "the bar that did have prints is judged");
    }

    #[test]
    fn a_switched_off_rule_never_fires() {
        let mut rule = priced(100.0);
        rule.enabled = false;
        let id = rule.id.clone();
        let (db, _hub, engine, mut events) = harness(vec![rule]);
        tape(&engine, &[(1, 140.0), (2, 141.0)]);
        closed(&engine, Timeframe::Minute(1), 0, 900.0);
        assert!(drained(&mut events).is_empty());
        assert!(db.alert_fires(None, 50).expect("history").is_empty());
        assert!(db.alert(&id).expect("rule").expect("rule").armed, "its state stays where it was left");
    }

    #[test]
    fn a_muted_rule_still_fires_and_is_marked_muted() {
        let mut rule = priced(100.0);
        rule.muted = true;
        let (_db, _hub, engine, mut events) = harness(vec![rule]);
        tape(&engine, &[(1, 101.0)]);
        let fired = drained(&mut events);
        assert_eq!(fired.len(), 1, "muting stops the popup, not the alert");
        assert!(fired[0].fire.muted, "the push says so, so the page stays quiet");
    }

    #[test]
    fn a_rule_that_already_fired_does_not_fire_again_after_a_restart() {
        let db = Arc::new(Db::in_memory().expect("in-memory store"));
        let rule = priced(100.0);
        let id = rule.id.clone();
        db.insert_alert(&rule).expect("insert rule");
        let hub = Hub::new();

        let first = AlertEngine::new(Arc::clone(&db), hub.clone());
        first.load();
        tape(&first, &[(1, 105.0)]);
        assert_eq!(db.alert_fires(None, 50).expect("history").len(), 1);

        // The process stops and comes back with the same store: the level is still held.
        drop(first);
        let second = AlertEngine::new(Arc::clone(&db), hub.clone());
        second.load();
        assert_eq!(db.alert_fires(None, 50).expect("history").len(), 1, "the restart found nothing to report");
        tape(&second, &[(2, 106.0), (3, 120.0)]);
        assert_eq!(db.alert_fires(None, 50).expect("history").len(), 1, "a held level is not a new crossing");

        // Give the level back and the reloaded rule answers again.
        tape(&second, &[(4, 90.0)]);
        tape(&second, &[(5, 101.0)]);
        assert_eq!(db.alert_fires(None, 50).expect("history").len(), 2);
        assert!(!db.alert(&id).expect("rule").expect("rule").armed);
    }

    #[test]
    fn a_level_taken_while_down_is_recorded_once_as_missed() {
        let db = Arc::new(Db::in_memory().expect("in-memory store"));
        db.insert_alert(&priced(100.0)).expect("insert rule");
        // The tape the previous run stored, taken above the level while nothing judged it.
        db.record_trades(ID, &[print(5_000, 140.0, Side::Buy)]).expect("stored print");
        let hub = Hub::new();

        let engine = AlertEngine::new(Arc::clone(&db), hub.clone());
        engine.load();
        let history = db.alert_fires(None, 50).expect("history");
        assert_eq!(history.len(), 1, "the gap is reported");
        assert!(history[0].missed, "and reported as missed, not as a live fire");
        assert_eq!(history[0].value, 140.0);
        assert_eq!(history[0].ts, 5_000, "stamped when the tape took the level");
        assert!(hub.alert_snapshot().is_empty(), "a missed fire is not pushed as though it had just happened");

        // A further restart with the same stored observation says it once.
        drop(engine);
        let again = AlertEngine::new(Arc::clone(&db), hub.clone());
        again.load();
        assert_eq!(db.alert_fires(None, 50).expect("history").len(), 1);
    }

    #[test]
    fn a_level_given_back_while_down_rearms_the_rule() {
        let db = Arc::new(Db::in_memory().expect("in-memory store"));
        let mut rule = priced(100.0);
        rule.armed = false;
        db.insert_alert(&rule).expect("insert rule");
        db.record_trades(ID, &[print(5_000, 90.0, Side::Buy)]).expect("stored print");
        let engine = AlertEngine::new(Arc::clone(&db), Hub::new());
        engine.load();
        assert!(db.alert(&rule.id).expect("rule").expect("rule").armed);
        assert!(db.alert_fires(None, 50).expect("history").is_empty(), "a level released is not a fire");
    }

    #[test]
    fn a_volume_rule_judges_the_newest_stored_bar_after_a_gap() {
        let db = Arc::new(Db::in_memory().expect("in-memory store"));
        let frame = Timeframe::Minute(1);
        db.insert_alert(&windowed(AlertKind::VolumeAbove, 500.0, frame)).expect("insert rule");
        db.upsert_bars(ID, &frame.as_key(), &[bar_at(0, 120.0, false), bar_at(MINUTE, 900.0, true)])
            .expect("stored bars");
        let engine = AlertEngine::new(Arc::clone(&db), Hub::new());
        engine.load();
        let history = db.alert_fires(None, 50).expect("history");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].value, 900.0, "the newest closed bar, not the live one");
        assert!(history[0].missed);
    }

    #[test]
    fn a_rule_that_cannot_be_reconstructed_is_left_alone() {
        let db = Arc::new(Db::in_memory().expect("in-memory store"));
        let frame = Timeframe::Minute(1);
        db.insert_alert(&windowed(AlertKind::DeltaAbove, 5.0, frame)).expect("insert rule");
        db.record_trades(ID, &[print(5_000, 140.0, Side::Buy)]).expect("stored print");
        let engine = AlertEngine::new(Arc::clone(&db), Hub::new());
        engine.load();
        assert!(
            db.alert_fires(None, 50).expect("history").is_empty(),
            "a delta is summed in memory, so a gap in it is not guessed from prints"
        );
    }

    #[tokio::test]
    async fn the_pump_stores_the_bar_and_pushes_the_fire_it_judged() {
        let db = Arc::new(Db::in_memory().expect("in-memory store"));
        let frame = Timeframe::Minute(1);
        db.insert_alert(&windowed(AlertKind::VolumeAbove, 500.0, frame)).expect("insert rule");
        let hub = Hub::new();
        let engine = AlertEngine::new(Arc::clone(&db), hub.clone());
        engine.load();
        let mut events = hub.subscribe();
        let (tx, rx) = mpsc::unbounded_channel();
        crate::live::spawn_pump(Arc::clone(&db), hub.clone(), Arc::clone(&engine), rx);

        tx.send(FeedEvent::Bar { instrument: ID.into(), timeframe: frame, bar: bar_at(0, 900.0, true) })
            .expect("send bar");

        let mut alert: Option<AlertEvent> = None;
        let mut saw_bar = false;
        for _ in 0..4 {
            let text = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("an event")
                .expect("the hub is open");
            if text.contains(r#""type":"bar""#) {
                saw_bar = true;
            } else {
                alert = Some(serde_json::from_str(&text).expect("an alert event"));
            }
            if saw_bar && alert.is_some() {
                break;
            }
        }
        let fired = alert.expect("the fire reached the socket");
        assert_eq!(fired.fire.value, 900.0);
        assert_eq!(fired.fire.alert_id, db.alerts().expect("rules")[0].id);
        assert_eq!(
            db.bars(BarFilter { instrument: ID.into(), timeframe: frame, from: None, to: None, limit: 10 })
                .expect("bars")
                .len(),
            1,
            "the bar itself is still stored by the same pump"
        );
    }
}
