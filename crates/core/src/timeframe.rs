use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

const SEC: i64 = 1_000;
const MIN: i64 = 60 * SEC;
const HOUR: i64 = 60 * MIN;
/// Calendar epoch offset: 1969-12-28 (Sunday) so week alignment lands on Mondays.
const WEEK_EPOCH: i64 = -345_600_000;

/// Chart interval. Time-based intervals align to UTC boundaries; count-based
/// intervals are rebuilt from the trade stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Timeframe {
    Second(u32),
    Minute(u32),
    Hour(u32),
    Day(u32),
    Week(u32),
    Month(u32),
    Tick(u32),
    Volume(u32),
    Session,
}

impl Timeframe {
    /// Milliseconds spanned by one bar, or None for count-based intervals.
    pub fn duration_ms(&self) -> Option<i64> {
        match self {
            Timeframe::Second(n) => Some(*n as i64 * SEC),
            Timeframe::Minute(n) => Some(*n as i64 * MIN),
            Timeframe::Hour(n) => Some(*n as i64 * HOUR),
            // Calendar intervals use nominal spans; the calendar walk happens in SQL.
            Timeframe::Day(n) => Some(*n as i64 * 24 * HOUR),
            Timeframe::Week(n) => Some(*n as i64 * 7 * 24 * HOUR),
            Timeframe::Month(_) => None,
            Timeframe::Tick(_) | Timeframe::Volume(_) | Timeframe::Session => None,
        }
    }

    /// Stable wire form used in URLs and stored rows, e.g. `5m`, `4h`, `tick:100`.
    pub fn as_key(&self) -> String {
        match self {
            Timeframe::Second(n) => format!("{n}s"),
            Timeframe::Minute(n) => format!("{n}m"),
            Timeframe::Hour(n) => format!("{n}h"),
            Timeframe::Day(n) => format!("{n}d"),
            Timeframe::Week(n) => format!("{n}w"),
            Timeframe::Month(n) => format!("{n}mo"),
            Timeframe::Tick(n) => format!("tick:{n}"),
            Timeframe::Volume(n) => format!("vol:{n}"),
            Timeframe::Session => "session".into(),
        }
    }

    /// Align a timestamp down to the bar boundary.
    pub fn align(&self, ts: i64) -> i64 {
        match self {
            Timeframe::Second(_)
            | Timeframe::Minute(_)
            | Timeframe::Hour(_)
            | Timeframe::Day(_) => {
                let d = self.duration_ms().unwrap_or(MIN);
                ts.div_euclid(d) * d
            }
            Timeframe::Week(_) => {
                let d = self.duration_ms().unwrap();
                (ts - WEEK_EPOCH).div_euclid(d) * d + WEEK_EPOCH
            }
            Timeframe::Month(_) => month_start(ts),
            Timeframe::Tick(_) | Timeframe::Volume(_) | Timeframe::Session => ts,
        }
    }
}

/// First instant of the UTC month containing `ts`.
fn month_start(ts: i64) -> i64 {
    let days = ts.div_euclid(24 * HOUR);
    // Civil-from-days on the proleptic Gregorian calendar.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let _ = y + if m <= 2 { 1 } else { 0 };
    // Walk back from the day-of-month to the first of the month.
    let dom = doy - (153 * mp + 2) / 5 + 1;
    (days - dom + 1) * 24 * HOUR
}

impl fmt::Display for Timeframe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_key())
    }
}

impl FromStr for Timeframe {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.trim().to_ascii_lowercase();
        if let Some(rest) = s.strip_prefix("tick:") {
            return rest.parse::<u32>().map(Timeframe::Tick).map_err(|_| "bad tick count".into());
        }
        if let Some(rest) = s.strip_prefix("vol:") {
            return rest.parse::<u32>().map(Timeframe::Volume).map_err(|_| "bad volume".into());
        }
        if s == "session" {
            return Ok(Timeframe::Session);
        }
        let split = s.find(|c: char| !c.is_ascii_digit()).ok_or("missing unit")?;
        let (num, unit) = (&s[..split], &s[split..]);
        let n: u32 = num.parse().map_err(|_| "missing count")?;
        if n == 0 {
            return Err("count must be positive".into());
        }
        match unit {
            "s" => Ok(Timeframe::Second(n)),
            "m" => Ok(Timeframe::Minute(n)),
            "h" => Ok(Timeframe::Hour(n)),
            "d" => Ok(Timeframe::Day(n)),
            "w" => Ok(Timeframe::Week(n)),
            "mo" => Ok(Timeframe::Month(n)),
            _ => Err(format!("unknown unit {unit:?}")),
        }
    }
}

impl Serialize for Timeframe {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.as_key())
    }
}

impl<'de> Deserialize<'de> for Timeframe {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Timeframe::from_str(&text).map_err(serde::de::Error::custom)
    }
}
