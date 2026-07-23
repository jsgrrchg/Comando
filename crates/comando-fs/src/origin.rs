use std::collections::{HashMap, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct WriteTracker {
    written: Arc<Mutex<HashMap<PathBuf, TrackedWrite>>>,
}

#[derive(Debug, Clone)]
struct TrackedWrite {
    kind: TrackedWriteKind,
    tracked_at: Instant,
}

#[derive(Debug, Clone)]
enum TrackedWriteKind {
    Content { hash: u64 },
    Any,
}

const SELF_WRITE_WINDOW: Duration = Duration::from_secs(2);

impl WriteTracker {
    pub fn new() -> Self {
        Self {
            written: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn track_content(&self, path: PathBuf, content: &str) {
        self.track_entry(
            path,
            TrackedWriteKind::Content {
                hash: hash_bytes(content.as_bytes()),
            },
        );
    }

    pub fn track_bytes(&self, path: PathBuf, content: &[u8]) {
        self.track_entry(
            path,
            TrackedWriteKind::Content {
                hash: hash_bytes(content),
            },
        );
    }

    pub fn track_any(&self, path: PathBuf) {
        self.track_entry(path, TrackedWriteKind::Any);
    }

    pub fn forget(&self, path: &Path) {
        let mut written = self.written.lock().expect("write tracker lock");
        written.remove(path);
    }

    pub fn has_recent_match(&self, path: &PathBuf, current_hash: Option<u64>) -> bool {
        let mut written = self.written.lock().expect("write tracker lock");
        prune_expired(&mut written);

        let Some(entry) = written.get(path) else {
            return false;
        };

        match (&entry.kind, current_hash) {
            (TrackedWriteKind::Any, _) => true,
            (TrackedWriteKind::Content { hash }, Some(current_hash)) => *hash == current_hash,
            (TrackedWriteKind::Content { .. }, None) => false,
        }
    }

    pub fn has_recent_entry(&self, path: &PathBuf) -> bool {
        let mut written = self.written.lock().expect("write tracker lock");
        prune_expired(&mut written);
        written.contains_key(path)
    }

    fn track_entry(&self, path: PathBuf, kind: TrackedWriteKind) {
        let mut written = self.written.lock().expect("write tracker lock");
        prune_expired(&mut written);
        written.insert(
            path,
            TrackedWrite {
                kind,
                tracked_at: Instant::now(),
            },
        );
    }
}

impl Default for WriteTracker {
    fn default() -> Self {
        Self::new()
    }
}

pub fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn prune_expired(written: &mut HashMap<PathBuf, TrackedWrite>) {
    written.retain(|_, entry| entry.tracked_at.elapsed() <= SELF_WRITE_WINDOW);
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn content_tracking_matches_same_bytes() {
        let tracker = WriteTracker::new();
        let path = PathBuf::from("src/main.rs");

        tracker.track_content(path.clone(), "alpha");

        assert!(tracker.has_recent_match(&path, Some(hash_bytes(b"alpha"))));
        assert!(!tracker.has_recent_match(&path, Some(hash_bytes(b"beta"))));
    }

    #[test]
    fn any_tracking_matches_delete_or_rename() {
        let tracker = WriteTracker::new();
        let path = PathBuf::from("src/main.rs");

        tracker.track_any(path.clone());

        assert!(tracker.has_recent_match(&path, None));
        assert!(tracker.has_recent_match(&path, Some(hash_bytes(b"anything"))));
    }
}
