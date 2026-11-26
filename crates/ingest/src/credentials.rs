//! Where venue credentials come from: environment variables first, then a config file
//! beside the database. Nothing is compiled in, so a build carries no keys.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chartkit_core::instrument::VenueTag;
use chartkit_core::Venue;
use serde::{Deserialize, Serialize};

/// One credential field a venue understands, in the shape the settings panel renders.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSpec {
    pub key: String,
    /// Environment variable that overrides the file for this field.
    pub env: String,
    pub label: String,
    pub required: bool,
    /// Render as a password box and never echo the value back to the browser.
    pub secret: bool,
    pub placeholder: String,
}

/// What the UI needs to draw one venue row.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueStatus {
    pub venue: Venue,
    pub tag: String,
    /// Kebab-case name used by `chartkit --check-feed <venue>`.
    pub slug: String,
    pub configured: bool,
    /// Required fields still missing, as labels.
    pub missing: Vec<String>,
    /// Where the values that are set came from: `environment`, `file`, or `none`.
    pub source: String,
    pub fields: Vec<FieldSpec>,
    /// Present when a required field is set: the browser may show it, secrets never do.
    pub values: BTreeMap<String, String>,
    pub note: String,
}

/// One field: key, env var, label, required, secret, default-as-placeholder.
type Spec = (&'static str, &'static str, &'static str, bool, bool, &'static str);

const TRADOVATE: &[Spec] = &[
    ("user", "TRADOVATE_USER", "Login", true, false, ""),
    ("password", "TRADOVATE_PASSWORD", "Password", true, true, ""),
    ("server", "TRADOVATE_SERVER", "Server (live or demo)", false, false, "demo"),
    ("app_id", "TRADOVATE_APP_ID", "App id", false, false, "chartkit"),
    ("device_id", "TRADOVATE_DEVICE_ID", "Device id", false, false, "chartkit"),
];

const IBKR: &[Spec] = &[
    ("base_url", "IBKR_BASE_URL", "Gateway url", true, false, "https://localhost:5000"),
    ("bearer_token", "IBKR_BEARER_TOKEN", "OAuth bearer token", false, true, ""),
    ("account", "IBKR_ACCOUNT", "Account id (for depth)", false, false, "U0000000"),
];

const RITHMIC: &[Spec] = &[
    ("user", "RITHMIC_USER", "Login", true, false, ""),
    ("password", "RITHMIC_PASSWORD", "Password", true, true, ""),
    ("system", "RITHMIC_SYSTEM", "System name", true, false, "Rithmic Paper Trading"),
    ("gateway", "RITHMIC_GATEWAY", "Gateway", false, false, "wss://rprotocol.rithmic.com:443"),
];

const NOTES: [(&str, &str); 3] = [
    (
        "tradovate",
        "Futures over Tradovate's WebSocket API. Rithmic-backed CME data; the market-data \
         server answers only after the trading server authorizes the connection.",
    ),
    (
        "ibkr",
        "Equities through a locally running IBKR Client Portal Gateway. Without a streaming \
         entitlement the data is 15-20 minutes delayed, and the strip says so.",
    ),
    (
        "rithmic",
        "Futures depth straight from R|Protocol: Protocol Buffers over a TLS WebSocket. Needs \
         a Rithmic login from an FCM or a reseller.",
    ),
];

/// Venues that can be selected per instrument, in the order the UI lists them.
pub const ROUTED: [Venue; 3] = [Venue::Tradovate, Venue::InteractiveBrokers, Venue::Rithmic];

/// Kebab-case command-line name for a venue.
pub fn slug(venue: Venue) -> String {
    match venue {
        Venue::Tradovate => "tradovate",
        Venue::InteractiveBrokers => "ibkr",
        Venue::Rithmic => "rithmic",
        Venue::Binance => "binance",
        _ => "unknown",
    }
    .to_string()
}

/// Parse `--check-feed <venue>`; accepts the slug or the kebab-case serde name.
pub fn venue_from_slug(text: &str) -> Option<Venue> {
    match text.trim().to_ascii_lowercase().as_str() {
        "tradovate" => Some(Venue::Tradovate),
        "ibkr" | "ibkr-web" | "interactive-brokers" | "interactivebrokers" => {
            Some(Venue::InteractiveBrokers)
        }
        "rithmic" => Some(Venue::Rithmic),
        "binance" => Some(Venue::Binance),
        _ => None,
    }
}

fn specs(venue: Venue) -> &'static [Spec] {
    match venue {
        Venue::Tradovate => TRADOVATE,
        Venue::InteractiveBrokers => IBKR,
        Venue::Rithmic => RITHMIC,
        _ => &[],
    }
}

fn note(venue: Venue) -> &'static str {
    match venue {
        Venue::Tradovate => NOTES[0].1,
        Venue::InteractiveBrokers => NOTES[1].1,
        Venue::Rithmic => NOTES[2].1,
        _ => "",
    }
}

/// Values for one venue, keyed by field name.
pub type Values = BTreeMap<String, String>;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct FileShape(BTreeMap<String, Values>);

/// Credentials for every venue, read from `<data_dir>/feeds.json` and the environment.
#[derive(Clone, Debug)]
pub struct CredentialStore {
    path: PathBuf,
    file: FileShape,
}

impl CredentialStore {
    /// Reads the file if it exists. A missing or unreadable file is not an error: an
    /// unconfigured venue has to read as unconfigured, not as a failure.
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("feeds.json");
        let file = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => FileShape::default(),
        };
        Self { path, file }
    }

    /// The value in force for one field: environment first, then the file, then nothing.
    pub fn value(&self, venue: Venue, key: &str) -> Option<String> {
        let spec = specs(venue).iter().find(|spec| spec.0 == key)?;
        if let Ok(text) = std::env::var(spec.1) {
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
        self.file
            .0
            .get(&slug(venue))?
            .get(key)
            .filter(|text| !text.is_empty())
            .cloned()
    }

    pub fn values(&self, venue: Venue) -> Values {
        let mut out = Values::new();
        for spec in specs(venue) {
            if let Some(value) = self.value(venue, spec.0) {
                out.insert(spec.0.to_string(), value);
            }
        }
        out
    }

    /// Everything the settings panel and `--check-feed` need to say about one venue.
    pub fn status(&self, venue: Venue) -> VenueStatus {
        let values = self.values(venue);
        let missing: Vec<String> = specs(venue)
            .iter()
            .filter(|spec| spec.3 && !values.contains_key(spec.0))
            .map(|spec| spec.2.to_string())
            .collect();
        let from_file = self.file.0.get(&slug(venue)).is_some_and(|rows| {
            rows.iter().any(|(key, value)| {
                !value.is_empty() && specs(venue).iter().any(|spec| spec.0 == *key)
            })
        });
        let from_env = specs(venue)
            .iter()
            .any(|spec| std::env::var(spec.1).is_ok_and(|text| !text.trim().is_empty()));
        let source = if from_env && from_file {
            "environment-and-file"
        } else if from_env {
            "environment"
        } else if from_file {
            "file"
        } else {
            "none"
        };
        let fields = specs(venue)
            .iter()
            .map(|spec| FieldSpec {
                key: spec.0.to_string(),
                env: spec.1.to_string(),
                label: spec.2.to_string(),
                required: spec.3,
                secret: spec.4,
                placeholder: spec.5.to_string(),
            })
            .collect();
        // Secrets are reported as present or absent, never as their value.
        let shown = values
            .iter()
            .map(|(key, value)| {
                let secret = specs(venue)
                    .iter()
                    .find(|spec| spec.0 == *key)
                    .map(|spec| spec.4)
                    .unwrap_or(false);
                (
                    key.clone(),
                    if secret { REDACTED.to_string() } else { value.clone() },
                )
            })
            .collect();
        VenueStatus {
            venue,
            tag: venue.tag().to_string(),
            slug: slug(venue),
            configured: missing.is_empty(),
            missing,
            source: source.to_string(),
            fields,
            values: shown,
            note: note(venue).to_string(),
        }
    }

    pub fn statuses(&self) -> Vec<VenueStatus> {
        ROUTED.iter().map(|venue| self.status(*venue)).collect()
    }

    /// Merge `patch` into the venue's stored values and write the file back.
    pub fn save(&self, venue: Venue, patch: &Values) -> Result<Self, std::io::Error> {
        let mut next = self.clone();
        let rows = next.file.0.entry(slug(venue)).or_default();
        for (key, value) in patch {
            if specs(venue).iter().any(|spec| spec.0 == *key) {
                if value.is_empty() {
                    rows.remove(key);
                } else {
                    rows.insert(key.clone(), value.clone());
                }
            }
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(&next.file)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        write_private(&self.path, text.as_bytes())?;
        next.path = self.path.clone();
        Ok(next)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Default for CredentialStore {
    fn default() -> Self {
        Self { path: PathBuf::from("feeds.json"), file: FileShape::default() }
    }
}

/// What a secret is replaced with on the way to the browser.
const REDACTED: &str = "••••••";

/// Write a file that holds secrets so that only the owner can read it.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_the_command_line_names() {
        assert_eq!(slug(Venue::Tradovate), "tradovate");
        assert_eq!(slug(Venue::InteractiveBrokers), "ibkr");
        assert_eq!(slug(Venue::Rithmic), "rithmic");
        assert_eq!(venue_from_slug("IBKR"), Some(Venue::InteractiveBrokers));
        assert_eq!(venue_from_slug("rithmic"), Some(Venue::Rithmic));
        assert_eq!(venue_from_slug("nope"), None);
    }

    #[test]
    fn an_empty_store_reports_missing_fields_not_an_error() {
        let store = CredentialStore::default();
        let status = store.status(Venue::Tradovate);
        assert!(!status.configured);
        assert_eq!(status.source, "none");
        assert_eq!(status.missing, vec!["Login".to_string(), "Password".to_string()]);
    }

    #[test]
    fn saved_credentials_are_read_back_and_secrets_stay_hidden() {
        let dir = std::env::temp_dir().join(format!("ck-creds-{}", chartkit_core::new_id("t")));
        std::fs::create_dir_all(&dir).unwrap();
        let store = CredentialStore::load(&dir);
        let mut patch = Values::new();
        patch.insert("user".into(), "trader".into());
        patch.insert("password".into(), "hunter2".into());
        patch.insert("system".into(), "Rithmic Paper Trading".into());
        let reloaded = store.save(Venue::Rithmic, &patch).unwrap().status(Venue::Rithmic);
        assert!(reloaded.configured, "{reloaded:?}");
        assert_eq!(reloaded.values.get("user").map(String::as_str), Some("trader"));
        assert_eq!(reloaded.values.get("password").map(String::as_str), Some("••••••"));
        let raw = std::fs::read_to_string(dir.join("feeds.json")).unwrap();
        assert!(raw.contains("hunter2"), "the file must hold the secret");
        assert!(!serde_json::to_string(&reloaded).unwrap().contains("hunter2"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
