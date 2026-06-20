use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use comando_types::fs::{
    NativeFsMutationOrigin, NativeFsWatchEvent, NativeProjectTreeInvalidation,
};
use comando_types::ids::RelativePath;
use notify::{
    event::{ModifyKind, RenameMode},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};

use crate::error::FsError;
use crate::now_rfc3339;
use crate::origin::{hash_bytes, WriteTracker};
use crate::path::normalize_relative_path;
use crate::policy::should_ignore_watch_path;
use crate::registry::ProjectRoot;

const WATCH_DEBOUNCE: Duration = Duration::from_millis(140);
const MAX_RELATIVE_PATHS_PER_INVALIDATION: usize = 256;

#[derive(Debug)]
pub struct WatcherDrain {
    pub invalidations: Vec<NativeProjectTreeInvalidation>,
    pub fs_events: Vec<(String, NativeFsWatchEvent)>,
}

#[derive(Debug)]
pub struct WatcherRegistry {
    watchers: HashMap<String, RecommendedWatcher>,
    roots: HashMap<String, ProjectRoot>,
    write_tracker: WriteTracker,
    pending: Arc<Mutex<HashMap<String, PendingInvalidation>>>,
    fs_events: Arc<Mutex<Vec<(String, NativeFsWatchEvent)>>>,
}

#[derive(Debug, Clone)]
struct PendingInvalidation {
    project_id: comando_types::ids::ProjectId,
    worktree_id: Option<comando_types::ids::WorktreeId>,
    relative_paths: Option<HashSet<String>>,
    last_event_at: Instant,
}

impl WatcherRegistry {
    pub fn new() -> Self {
        Self {
            watchers: HashMap::new(),
            roots: HashMap::new(),
            write_tracker: WriteTracker::new(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            fs_events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn write_tracker(&self) -> WriteTracker {
        self.write_tracker.clone()
    }

    pub fn sync_roots(&mut self, roots: Vec<ProjectRoot>) -> Result<(), FsError> {
        let desired = roots
            .into_iter()
            .map(|root| (watch_key(&root), root))
            .collect::<HashMap<_, _>>();

        let current_keys = self.watchers.keys().cloned().collect::<Vec<_>>();
        for key in current_keys {
            if !desired.contains_key(&key) {
                self.watchers.remove(&key);
                self.roots.remove(&key);
            }
        }

        for (key, root) in desired {
            if self.watchers.contains_key(&key) {
                self.roots.insert(key, root);
                continue;
            }

            self.start_root(key, root)?;
        }

        Ok(())
    }

    pub fn start(&mut self, root: ProjectRoot) -> Result<(), FsError> {
        let key = watch_key(&root);
        if self.watchers.contains_key(&key) {
            return Ok(());
        }
        self.start_root(key, root)
    }

    pub fn stop(&mut self, root: &ProjectRoot) {
        let key = watch_key(root);
        self.watchers.remove(&key);
        self.roots.remove(&key);
    }

    pub fn drain(&mut self, force: bool) -> WatcherDrain {
        let now = Instant::now();
        let mut invalidations = Vec::new();
        let mut pending = self.pending.lock().expect("watch pending lock");
        let ready_keys = pending
            .iter()
            .filter(|(_, pending)| force || now.duration_since(pending.last_event_at) >= WATCH_DEBOUNCE)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();

        for key in ready_keys {
            if let Some(pending) = pending.remove(&key) {
                invalidations.push(NativeProjectTreeInvalidation {
                    project_id: pending.project_id,
                    worktree_id: pending.worktree_id,
                    relative_paths: pending.relative_paths.map(|paths| {
                        let mut paths = paths.into_iter().map(RelativePath).collect::<Vec<_>>();
                        paths.sort_by(|left, right| left.0.cmp(&right.0));
                        paths
                    }),
                    occurred_at: now_rfc3339(),
                });
            }
        }
        drop(pending);

        let fs_events = {
            let mut events = self.fs_events.lock().expect("watch events lock");
            std::mem::take(&mut *events)
        };

        WatcherDrain {
            invalidations,
            fs_events,
        }
    }

    fn start_root(&mut self, key: String, root: ProjectRoot) -> Result<(), FsError> {
        let watch_root = root.root_path.clone();
        let pending = Arc::clone(&self.pending);
        let fs_events = Arc::clone(&self.fs_events);
        let write_tracker = self.write_tracker.clone();
        let root_for_callback = root.clone();
        let key_for_callback = key.clone();

        let mut watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
            let Ok(event) = result else {
                return;
            };

            handle_notify_event(
                &key_for_callback,
                &root_for_callback,
                &watch_root,
                &write_tracker,
                &pending,
                &fs_events,
                event,
            );
        })?;
        watcher.watch(&root.root_path, RecursiveMode::Recursive)?;

        self.roots.insert(key.clone(), root);
        self.watchers.insert(key, watcher);
        Ok(())
    }
}

impl Default for WatcherRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn handle_notify_event(
    key: &str,
    root: &ProjectRoot,
    watch_root: &Path,
    write_tracker: &WriteTracker,
    pending: &Arc<Mutex<HashMap<String, PendingInvalidation>>>,
    fs_events: &Arc<Mutex<Vec<(String, NativeFsWatchEvent)>>>,
    event: Event,
) {
    let event_name = event_name_for_kind(&event.kind);
    let event_kind = event_kind_for_kind(&event.kind);

    for path in event.paths {
        let absolute_path = if path.is_absolute() {
            path.clone()
        } else {
            watch_root.join(&path)
        };

        if absolute_path == watch_root {
            continue;
        }

        let Some(relative_path) = normalize_watched_path(watch_root, &absolute_path) else {
            continue;
        };
        if should_ignore_watch_path(&relative_path) {
            continue;
        }

        let current_hash = std::fs::read(&absolute_path).ok().map(|bytes| hash_bytes(&bytes));
        if write_tracker.has_recent_match(&absolute_path, current_hash) {
            continue;
        }

        record_pending_invalidation(key, root, &relative_path, pending);
        fs_events.lock().expect("watch events lock").push((
            event_name.to_string(),
            NativeFsWatchEvent {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: Some(RelativePath(relative_path)),
                kind: event_kind.to_string(),
                origin: NativeFsMutationOrigin::External,
                occurred_at: now_rfc3339(),
            },
        ));
    }
}

fn record_pending_invalidation(
    key: &str,
    root: &ProjectRoot,
    relative_path: &str,
    pending: &Arc<Mutex<HashMap<String, PendingInvalidation>>>,
) {
    let mut pending = pending.lock().expect("watch pending lock");
    let entry = pending
        .entry(key.to_string())
        .or_insert_with(|| PendingInvalidation {
            project_id: root.project_id.clone(),
            worktree_id: root.worktree_id.clone(),
            relative_paths: Some(HashSet::new()),
            last_event_at: Instant::now(),
        });

    entry.last_event_at = Instant::now();
    if let Some(paths) = entry.relative_paths.as_mut() {
        paths.insert(relative_path.to_string());
        if paths.len() > MAX_RELATIVE_PATHS_PER_INVALIDATION {
            entry.relative_paths = None;
        }
    }
}

fn normalize_watched_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let normalized = normalize_relative_path(relative);
    (!normalized.is_empty()).then_some(normalized)
}

fn event_name_for_kind(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "fs://entry-created",
        EventKind::Remove(_) => "fs://entry-deleted",
        EventKind::Modify(ModifyKind::Name(RenameMode::Both | RenameMode::From | RenameMode::To)) => {
            "fs://entry-renamed"
        }
        EventKind::Modify(_) => "fs://entry-updated",
        _ => "fs://entry-updated",
    }
}

fn event_kind_for_kind(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "created",
        EventKind::Remove(_) => "deleted",
        EventKind::Modify(ModifyKind::Name(_)) => "renamed",
        EventKind::Modify(_) => "updated",
        _ => "updated",
    }
}

fn watch_key(root: &ProjectRoot) -> String {
    format!(
        "{}:{}",
        root.project_id.0,
        root.worktree_id
            .as_ref()
            .map(|id| id.0.as_str())
            .unwrap_or("primary")
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::thread;
    use std::time::Duration;

    use tempfile::TempDir;

    use super::*;
    use crate::test_support::project_root;

    #[test]
    fn coalesces_pending_events() {
        let temp = TempDir::new().expect("temp");
        let root = project_root(temp.path());
        let mut watchers = WatcherRegistry::new();

        record_pending_invalidation("project_1:project_1:primary", &root, "a.txt", &watchers.pending);
        record_pending_invalidation("project_1:project_1:primary", &root, "b.txt", &watchers.pending);
        thread::sleep(Duration::from_millis(160));

        let drain = watchers.drain(false);
        assert!(
            drain
                .invalidations
                .iter()
                .any(|invalidation| invalidation.relative_paths.as_ref().is_some_and(|paths| {
                    let values = paths.iter().map(|path| path.0.as_str()).collect::<Vec<_>>();
                    values.contains(&"a.txt") || values.contains(&"b.txt")
                }))
        );
    }

    #[test]
    fn write_tracker_suppresses_own_writes() {
        let temp = TempDir::new().expect("temp");
        let path = temp.path().join("owned.txt");
        fs::write(&path, "owned").expect("write");
        let root = project_root(temp.path());
        let mut watchers = WatcherRegistry::new();
        let tracker = watchers.write_tracker();
        tracker.track_content(path.clone(), "owned");

        watchers.start(root).expect("start");
        thread::sleep(Duration::from_millis(100));
        fs::write(&path, "owned").expect("write same");
        thread::sleep(Duration::from_millis(220));

        let drain = watchers.drain(true);
        assert!(drain.invalidations.is_empty());
    }

}
