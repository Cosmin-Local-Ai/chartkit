use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Process-unique id with a readable prefix. Alert rules and their fired events are keyed
/// by these; a local single-user store needs no more than a counter, a clock and a hash.
pub fn new_id(prefix: &str) -> String {
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or_default();
    let mut hasher = RandomState::new().build_hasher();
    (count, nanos).hash(&mut hasher);
    format!("{prefix}{:016x}", hasher.finish())
}
