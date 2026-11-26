//! Price and volume alerts: what a rule records, and the rule that decides when it fires.
//!
//! Rules are judged on the server, in the same pump that stores bars and prints, so an
//! alert holds when the page is closed. The shape here is this project's own contract:
//! no third-party alert payload was read when it was designed.

use serde::{Deserialize, Serialize};

use crate::{now_ms, Timeframe};

/// Where an observation comes from, which is what settles a rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlertTrigger {
    /// Every print as it lands, so a price rule answers within one print of the level.
    Print,
    /// One bar, once it has closed, so a window rule never reads a partial total.
    BarClose,
}

/// What a rule watches.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlertKind {
    /// Last price moves above `threshold`.
    PriceAbove,
    /// Last price moves below `threshold`.
    PriceBelow,
    /// Last price sits between `threshold` and `threshold_high`.
    PriceInRange,
    /// A closed bar's traded quantity exceeds `threshold`.
    VolumeAbove,
    /// A closed bar's aggressive-buy minus aggressive-sell quantity exceeds `threshold`.
    DeltaAbove,
}

impl AlertKind {
    /// Stable text form, used in stored rows and in the REST body.
    pub fn as_key(self) -> &'static str {
        match self {
            AlertKind::PriceAbove => "price-above",
            AlertKind::PriceBelow => "price-below",
            AlertKind::PriceInRange => "price-in-range",
            AlertKind::VolumeAbove => "volume-above",
            AlertKind::DeltaAbove => "delta-above",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "price-above" => Some(AlertKind::PriceAbove),
            "price-below" => Some(AlertKind::PriceBelow),
            "price-in-range" => Some(AlertKind::PriceInRange),
            "volume-above" => Some(AlertKind::VolumeAbove),
            "delta-above" => Some(AlertKind::DeltaAbove),
            _ => None,
        }
    }

    /// Whether a live print or a settled bar decides this kind.
    pub fn trigger(self) -> AlertTrigger {
        match self {
            AlertKind::PriceAbove | AlertKind::PriceBelow | AlertKind::PriceInRange => AlertTrigger::Print,
            AlertKind::VolumeAbove | AlertKind::DeltaAbove => AlertTrigger::BarClose,
        }
    }

    /// Kinds that sum a window need the window named.
    pub fn needs_timeframe(self) -> bool {
        matches!(self, AlertKind::VolumeAbove | AlertKind::DeltaAbove)
    }

    /// The range kind reads a second edge; `threshold` alone is its lower bound.
    pub fn has_upper_edge(self) -> bool {
        self == AlertKind::PriceInRange
    }

    /// Whether `threshold` is read as a price or as a quantity.
    pub fn is_price(self) -> bool {
        matches!(self, AlertKind::PriceAbove | AlertKind::PriceBelow | AlertKind::PriceInRange)
    }
}

/// A rule, as stored and as the API returns it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: String,
    /// `VENUE:SYMBOL`, e.g. `BINANCE:BTCUSDT`.
    pub instrument: String,
    pub kind: AlertKind,
    /// The level: the line a price rule watches, or the quantity a window rule must beat.
    pub threshold: f64,
    /// Upper bound, range kind only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold_high: Option<f64>,
    /// Window a bar rule sums over; a price rule ignores it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeframe: Option<Timeframe>,
    /// How far back the value has to give up the level before the rule can fire again.
    /// Zero re-arms on the plain crossing back through the level.
    pub rearm_gap: f64,
    /// Short text describing the rule, shown in the list and in the history row.
    pub label: String,
    pub enabled: bool,
    /// A muted rule still fires and is still listed; it only stops the desktop popup.
    pub muted: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// True while the rule waits to enter the state it watches. Stored, so a restart can
    /// neither re-fire a level that is still held nor forget one that has to re-arm.
    pub armed: bool,
    /// When the last fire was decided, epoch milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_fired_at: Option<i64>,
}

/// The bounds of a range rule, lowest first, tolerating edges given the other way round.
fn range_edges(alert: &Alert) -> (f64, f64) {
    let high = alert.threshold_high.unwrap_or(alert.threshold);
    (alert.threshold.min(high), alert.threshold.max(high))
}

impl Alert {
    /// A new rule with an id, timestamps and a waiting crossing state.
    pub fn new(instrument: impl Into<String>, kind: AlertKind, threshold: f64) -> Self {
        let now = now_ms();
        Self {
            id: crate::new_id("al"),
            instrument: instrument.into(),
            kind,
            threshold,
            threshold_high: None,
            timeframe: None,
            rearm_gap: 0.0,
            label: String::new(),
            enabled: true,
            muted: false,
            created_at: now,
            updated_at: now,
            // Waiting, so a rule that already holds its condition answers on the next
            // observation rather than after a pointless round trip past the level.
            armed: true,
            last_fired_at: None,
        }
    }

    /// Rejects a rule the evaluator could not judge, with the reason for the client.
    pub fn validate(&self) -> Result<(), String> {
        if self.instrument.trim().is_empty() {
            return Err("an alert needs an instrument".into());
        }
        if !self.threshold.is_finite() {
            return Err(format!("threshold must be a finite number, got {}", self.threshold));
        }
        if self.kind.has_upper_edge() {
            let high = self.threshold_high.ok_or("a range alert needs an upper bound")?;
            if !high.is_finite() {
                return Err("the upper bound must be a finite number".into());
            }
            if high <= self.threshold {
                return Err("the upper bound has to sit above the lower bound".into());
            }
        }
        if self.kind.needs_timeframe() {
            let frame = self.timeframe.ok_or("a window alert needs a timeframe")?;
            if frame.duration_ms().is_none() {
                return Err(format!("{} has no fixed span, so a window alert cannot sum it", frame.as_key()));
            }
        }
        if !self.rearm_gap.is_finite() || self.rearm_gap < 0.0 {
            return Err(format!("the re-arm gap must be zero or more, got {}", self.rearm_gap));
        }
        if self.label.chars().count() > 120 {
            return Err("the label is limited to 120 characters".into());
        }
        Ok(())
    }

    /// The window the rule sums over, in the timeframe's own wire form.
    pub fn timeframe_key(&self) -> Option<String> {
        self.timeframe.map(|frame| frame.as_key())
    }
}

/// Whether an observation leaves the rule in the state it watches for.
pub fn is_satisfied(alert: &Alert, value: f64) -> bool {
    if !value.is_finite() {
        return false;
    }
    match alert.kind {
        AlertKind::PriceAbove | AlertKind::VolumeAbove | AlertKind::DeltaAbove => value > alert.threshold,
        AlertKind::PriceBelow => value < alert.threshold,
        AlertKind::PriceInRange => {
            let (low, high) = range_edges(alert);
            value >= low && value <= high
        }
    }
}

/// Whether an observation has given the level back far enough for the rule to fire again.
/// The gap is what keeps a price chopping across a level from firing print after print.
pub fn has_given_back(alert: &Alert, value: f64) -> bool {
    if !value.is_finite() {
        return false;
    }
    let gap = alert.rearm_gap.max(0.0);
    match alert.kind {
        AlertKind::PriceAbove | AlertKind::VolumeAbove | AlertKind::DeltaAbove => value < alert.threshold - gap,
        AlertKind::PriceBelow => value > alert.threshold + gap,
        AlertKind::PriceInRange => {
            let (low, high) = range_edges(alert);
            value < low - gap || value > high + gap
        }
    }
}

/// Decides one observation against a rule and moves its crossing state. This is the whole
/// firing rule: a rule answers once as the value enters the state it watches, then stays
/// quiet until the value has given the level back.
pub fn step(alert: &mut Alert, value: f64, ts: i64, bar_start: Option<i64>) -> Option<AlertFire> {
    if !alert.enabled {
        return None;
    }
    if !alert.armed {
        // Already answered for this crossing. Only giving the level back opens it again.
        alert.armed = has_given_back(alert, value);
        return None;
    }
    if !is_satisfied(alert, value) {
        return None;
    }
    alert.armed = false;
    alert.last_fired_at = Some(ts);
    Some(AlertFire::from_alert(alert, value, ts, bar_start, false))
}

/// What startup concluded about one rule, judging the newest observation the store holds
/// against the crossing state that was saved with it.
#[derive(Clone, Debug, PartialEq)]
pub enum Downtime {
    /// Nothing to report: the rule still waits where it was left.
    Nothing,
    /// The level was given back while the server was down, so the rule can fire again.
    Rearmed,
    /// The level was taken while the server was down. One fire, flagged as missed.
    Missed(AlertFire),
}

/// Reconstructs a downtime gap without replaying history: a rule that would have fired is
/// reported once, marked missed, and is not pushed to open sockets as though it had just
/// happened. A rule that would have re-armed is simply re-armed.
pub fn judge_downtime(alert: &mut Alert, value: f64, ts: i64, bar_start: Option<i64>) -> Downtime {
    if !alert.enabled || !value.is_finite() {
        return Downtime::Nothing;
    }
    if alert.armed {
        return match step(alert, value, ts, bar_start) {
            None => Downtime::Nothing,
            Some(mut fire) => {
                fire.missed = true;
                Downtime::Missed(fire)
            },
        };
    }
    if has_given_back(alert, value) {
        alert.armed = true;
        return Downtime::Rearmed;
    }
    Downtime::Nothing
}

/// One fired rule. The condition is copied in rather than looked up, so a rule that has
/// since been edited or deleted still reads correctly in the history list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertFire {
    pub id: String,
    pub alert_id: String,
    pub instrument: String,
    pub kind: AlertKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeframe: Option<Timeframe>,
    pub threshold: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold_high: Option<f64>,
    /// The observation that satisfied the rule: a print price, or a closed bar's volume
    /// or delta.
    pub value: f64,
    /// Bar open time for a bar-decided fire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bar_start: Option<i64>,
    /// When the satisfying observation was stamped, epoch milliseconds.
    pub ts: i64,
    pub label: String,
    /// The rule was muted when this fired: no popup, but the entry is here anyway.
    pub muted: bool,
    /// Reconstructed at startup from data stored while the server was down, so the fire
    /// is reported as missed rather than replayed as if it had just happened.
    pub missed: bool,
}

impl AlertFire {
    /// Snapshot the rule as it stands at the moment it fires.
    pub fn from_alert(alert: &Alert, value: f64, ts: i64, bar_start: Option<i64>, missed: bool) -> Self {
        Self {
            id: crate::new_id("fv"),
            alert_id: alert.id.clone(),
            instrument: alert.instrument.clone(),
            kind: alert.kind,
            timeframe: alert.timeframe,
            threshold: alert.threshold,
            threshold_high: alert.threshold_high,
            value,
            bar_start,
            ts,
            label: alert.label.clone(),
            muted: alert.muted,
            missed,
        }
    }
}

/// The name a fired rule carries on the live socket, next to the feed's own event names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WireEvent {
    Alert,
}

/// The push form of one fire: the fire's own fields, flat, with a `type` beside them, so
/// a client reads it the way it reads every other event on the socket.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertEvent {
    #[serde(rename = "type")]
    pub event_type: WireEvent,
    #[serde(flatten)]
    pub fire: AlertFire,
}

impl AlertEvent {
    pub fn new(fire: AlertFire) -> Self {
        Self { event_type: WireEvent::Alert, fire }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn price_alert(kind: AlertKind, level: f64) -> Alert {
        Alert::new("BINANCE:TEST", kind, level)
    }

    /// Walks a rule through a series of observations and reports which steps fired. This
    /// is the sequence the server's evaluator runs, one call per observation.
    fn walk(alert: &mut Alert, prices: &[f64]) -> Vec<bool> {
        prices.iter().map(|price| step(alert, *price, *price as i64, None).is_some()).collect()
    }

    #[test]
    fn a_crossing_above_fires_once_and_stays_quiet() {
        let mut alert = price_alert(AlertKind::PriceAbove, 100.0);
        assert!(walk(&mut alert, &[101.0]).first().copied().unwrap_or(false));
        // Held above the level: nothing more to say, print after print.
        assert_eq!(walk(&mut alert, &[102.0, 140.0, 100.5, 100.0001]), [false; 4]);
        // Given back, then crossed again: a fresh crossing, so a fresh fire.
        assert_eq!(walk(&mut alert, &[99.0]), [false]);
        assert!(walk(&mut alert, &[101.0]).first().copied().unwrap_or(false));
        assert!(!alert.armed, "a fire leaves the rule waiting for the level to be given back");
    }

    #[test]
    fn a_crossing_below_mirrors_the_crossing_above() {
        let mut alert = price_alert(AlertKind::PriceBelow, 100.0);
        assert_eq!(walk(&mut alert, &[101.0, 99.0, 98.0, 99.5, 100.5, 99.0]), [false, true, false, false, false, true]);
    }

    #[test]
    fn a_rearm_gap_holds_the_rule_off_through_chop() {
        let mut alert = price_alert(AlertKind::PriceAbove, 100.0);
        alert.rearm_gap = 2.0;
        // 99 is above 100 - 2, so the rule stays fired and the next print above 100 is
        // not a new crossing.
        assert_eq!(walk(&mut alert, &[101.0, 99.0, 100.5]), [true, false, false]);
        assert_eq!(walk(&mut alert, &[97.0, 100.5]), [false, true]);
    }

    #[test]
    fn a_rule_created_on_a_breached_level_answers_at_once() {
        let mut alert = price_alert(AlertKind::PriceAbove, 100.0);
        assert!(walk(&mut alert, &[105.0]).first().copied().unwrap_or(false));
        assert_eq!(walk(&mut alert, &[106.0, 104.0]), [false, false]);
    }

    #[test]
    fn a_range_rule_fires_on_entry_and_not_again_inside() {
        let mut alert = price_alert(AlertKind::PriceInRange, 100.0);
        alert.threshold_high = Some(110.0);
        assert_eq!(
            walk(&mut alert, &[105.0, 108.0, 100.0, 110.0, 99.0, 109.0]),
            [true, false, false, false, false, true]
        );
        // A gap keeps a price grazing the edge from re-entering on every print.
        let mut edged = price_alert(AlertKind::PriceInRange, 100.0);
        edged.threshold_high = Some(110.0);
        edged.rearm_gap = 1.0;
        assert_eq!(walk(&mut edged, &[105.0, 99.5, 105.0, 98.0, 105.0]), [true, false, false, false, true]);
    }

    #[test]
    fn a_window_rule_reads_quantity_not_price() {
        let mut alert = price_alert(AlertKind::VolumeAbove, 500.0);
        assert_eq!(walk(&mut alert, &[400.0, 900.0, 800.0, 100.0, 700.0]), [false, true, false, false, true]);
    }

    #[test]
    fn an_unusable_value_never_satisfies_a_rule() {
        let alert = price_alert(AlertKind::PriceAbove, 100.0);
        assert!(!is_satisfied(&alert, f64::NAN));
        assert!(!is_satisfied(&alert, f64::INFINITY));
        assert!(!has_given_back(&alert, f64::NAN));
    }

    #[test]
    fn a_disabled_rule_never_fires_and_its_state_never_moves() {
        let mut alert = price_alert(AlertKind::PriceAbove, 100.0);
        alert.enabled = false;
        assert_eq!(walk(&mut alert, &[101.0, 99.0, 102.0]), [false; 3]);
        assert!(alert.armed, "a switched-off rule keeps waiting where it was left");
        assert_eq!(alert.last_fired_at, None);
        // Switched back on, it answers the next time the condition holds.
        alert.enabled = true;
        assert!(walk(&mut alert, &[101.0]).first().copied().unwrap_or(false));
    }

    #[test]
    fn a_level_taken_while_down_is_reported_once_as_missed() {
        let mut alert = price_alert(AlertKind::PriceAbove, 100.0);
        // The rule was waiting when the server stopped, and the tape has since gone above.
        alert.armed = true;
        let first = judge_downtime(&mut alert, 118.0, 2_000, None);
        match &first {
            Downtime::Missed(fire) => {
                assert!(fire.missed);
                assert_eq!(fire.value, 118.0);
                assert_eq!(fire.ts, 2_000);
            },
            other => panic!("expected a missed fire, got {other:?}"),
        }
        // The same stored observation cannot report it twice across further restarts.
        assert_eq!(judge_downtime(&mut alert, 118.0, 2_000, None), Downtime::Nothing);
    }

    #[test]
    fn a_level_given_back_while_down_rearms_the_rule() {
        let mut alert = price_alert(AlertKind::PriceAbove, 100.0);
        // It had fired before the server stopped.
        alert.armed = false;
        assert_eq!(judge_downtime(&mut alert, 90.0, 2_000, None), Downtime::Rearmed);
        assert!(alert.armed);
        // Still held below the level: nothing to say, and the rule stays armed.
        assert_eq!(judge_downtime(&mut alert, 91.0, 2_001, None), Downtime::Nothing);
        assert!(alert.armed);
        // A rule that fired and still holds its level has nothing to report.
        let mut held = price_alert(AlertKind::PriceAbove, 100.0);
        held.armed = false;
        assert_eq!(judge_downtime(&mut held, 140.0, 2_002, None), Downtime::Nothing);
        let mut off = price_alert(AlertKind::PriceAbove, 100.0);
        off.enabled = false;
        assert_eq!(judge_downtime(&mut off, 140.0, 2_002, None), Downtime::Nothing);
    }

    #[test]
    fn kinds_round_trip_through_their_text_form() {
        for kind in [
            AlertKind::PriceAbove,
            AlertKind::PriceBelow,
            AlertKind::PriceInRange,
            AlertKind::VolumeAbove,
            AlertKind::DeltaAbove,
        ] {
            assert_eq!(AlertKind::parse(kind.as_key()), Some(kind));
        }
        assert_eq!(AlertKind::parse("price-above"), Some(AlertKind::PriceAbove));
        assert_eq!(AlertKind::parse("PRICE-ABOVE"), Some(AlertKind::PriceAbove));
        assert_eq!(AlertKind::parse("made-up"), None);
        assert_eq!(AlertKind::parse(""), None);
    }

    #[test]
    fn each_kind_names_the_point_that_settles_it() {
        assert_eq!(AlertKind::PriceAbove.trigger(), AlertTrigger::Print);
        assert_eq!(AlertKind::PriceInRange.trigger(), AlertTrigger::Print);
        assert_eq!(AlertKind::VolumeAbove.trigger(), AlertTrigger::BarClose);
        assert_eq!(AlertKind::DeltaAbove.trigger(), AlertTrigger::BarClose);
        assert!(AlertKind::VolumeAbove.needs_timeframe());
        assert!(AlertKind::DeltaAbove.needs_timeframe());
        assert!(!AlertKind::PriceAbove.needs_timeframe());
        assert!(AlertKind::PriceInRange.has_upper_edge());
        assert!(!AlertKind::PriceAbove.has_upper_edge());
        assert!(AlertKind::PriceBelow.is_price());
        assert!(!AlertKind::DeltaAbove.is_price());
    }

    #[test]
    fn a_rule_is_only_accepted_when_the_evaluator_can_judge_it() {
        let mut alert = Alert::new("BINANCE:TEST", AlertKind::VolumeAbove, 500.0);
        assert_eq!(
            alert.validate().err().as_deref(),
            Some("a window alert needs a timeframe"),
            "a window rule with no window cannot be summed"
        );
        alert.timeframe = Some(Timeframe::Minute(5));
        assert!(alert.validate().is_ok());
        alert.timeframe = Some(Timeframe::Tick(50));
        assert!(alert.validate().is_err(), "a count bar has no fixed span to sum");

        let mut range = Alert::new("BINANCE:TEST", AlertKind::PriceInRange, 100.0);
        assert_eq!(range.validate().err().as_deref(), Some("a range alert needs an upper bound"));
        range.threshold_high = Some(90.0);
        assert!(range.validate().is_err(), "an inverted range is a mistake, not a rule");
        range.threshold_high = Some(110.0);
        assert!(range.validate().is_ok());

        let mut blank = Alert::new("  ", AlertKind::PriceAbove, 100.0);
        assert!(blank.validate().is_err());
        blank.instrument = "BINANCE:TEST".into();
        blank.threshold = f64::NAN;
        assert!(blank.validate().is_err());
        blank.threshold = 100.0;
        blank.rearm_gap = -1.0;
        assert!(blank.validate().is_err(), "a negative gap would arm the rule before it fired");
        blank.rearm_gap = 0.0;
        assert!(blank.validate().is_ok());
    }

    #[test]
    fn a_fire_snapshots_the_rule_that_made_it() {
        let mut alert = Alert::new("BINANCE:ETHUSDT", AlertKind::PriceAbove, 3_000.0);
        alert.label = "eth reclaims 3k".into();
        alert.muted = true;
        alert.timeframe = Some(Timeframe::Hour(1));
        let fire = AlertFire::from_alert(&alert, 3_012.5, 1_700_000_000_000, None, false);
        assert_eq!(fire.alert_id, alert.id);
        assert_eq!(fire.label, "eth reclaims 3k");
        assert!(fire.muted);
        assert_eq!(fire.timeframe, Some(Timeframe::Hour(1)));
        assert!(!fire.missed);
        assert!(fire.id != alert.id);

        let json = serde_json::to_string(&fire).unwrap();
        let back: AlertFire = serde_json::from_str(&json).unwrap();
        assert_eq!(back, fire);
        assert!(json.contains("\"instrument\":\"BINANCE:ETHUSDT\""));
        assert!(json.contains("\"kind\":\"price-above\""), "{json}");
    }

    #[test]
    fn a_fire_pushes_as_a_flat_alert_event() {
        let alert = Alert::new("BINANCE:BTCUSDT", AlertKind::VolumeAbove, 500.0);
        let fire = AlertFire::from_alert(&alert, 900.0, 1_700_000_000_000, Some(1_700_000_000_000), false);
        let text = serde_json::to_string(&AlertEvent::new(fire.clone())).unwrap();
        assert!(text.contains(r#""type":"alert""#), "{text}");
        assert!(text.contains(r#""value":900"#), "{text}");
        let back: AlertEvent = serde_json::from_str(&text).unwrap();
        assert_eq!(back.fire, fire);
        assert_eq!(back.event_type, WireEvent::Alert);
    }

    #[test]
    fn rule_ids_are_unique_and_prefixed() {
        let mut ids: Vec<String> = Vec::new();
        for _ in 0..500 {
            ids.push(crate::new_id("al"));
        }
        let unique: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
        assert_eq!(unique.len(), ids.len(), "two rules created in the same millisecond collided");
        assert!(ids.iter().all(|id| id.starts_with("al") && id.len() == 18));
    }
}
