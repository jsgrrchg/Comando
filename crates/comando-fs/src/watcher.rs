use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use comando_types::fs::{
    NativeFsMutationOrigin, NativeFsWatchEvent, NativeProjectTreeInvalidation,
};
use comando_types::git::NativeGitRepositoryInvalidation;
use comando_types::ids::RelativePath;
use notify::{
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
    event::{ModifyKind, RenameMode},
};

use crate::error::FsError;
use crate::now_rfc3339;
use crate::origin::{WriteTracker, hash_bytes};
use crate::path::normalize_relative_path;
use crate::policy::{
    GitWatchInvalidationReason, git_watch_invalidation_reason, should_ignore_watch_path,
};
use crate::registry::ProjectRoot;

const WATCH_DEBOUNCE: Duration = Duration::from_millis(140);
const SELF_WRITE_HASH_RETRY_DELAY: Duration = Duration::from_millis(20);
const SELF_WRITE_HASH_RETRY_ATTEMPTS: usize = 5;
const MAX_RELATIVE_PATHS_PER_INVALIDATION: usize = 256;

#[derive(Debug)]
pub struct WatcherDrain {
    pub invalidations: Vec<NativeProjectTreeInvalidation>,
    pub fs_events: Vec<(String, NativeFsWatchEvent)>,
    pub git_invalidations: Vec<NativeGitRepositoryInvalidation>,
}

#[derive(Debug)]
pub struct WatcherRegistry {
    watchers: HashMap<String, RecommendedWatcher>,
    roots: HashMap<String, ProjectRoot>,
    write_tracker: WriteTracker,
    pending: Arc<Mutex<HashMap<String, PendingInvalidation>>>,
    pending_git_invalidations: Arc<Mutex<HashMap<String, PendingGitInvalidation>>>,
    fs_events: Arc<Mutex<Vec<(String, NativeFsWatchEvent)>>>,
}

#[derive(Debug, Clone)]
struct PendingInvalidation {
    project_id: comando_types::ids::ProjectId,
    worktree_id: Option<comando_types::ids::WorktreeId>,
    relative_paths: Option<HashSet<String>>,
    last_event_at: Instant,
}

#[derive(Debug, Clone)]
struct PendingGitInvalidation {
    project_id: comando_types::ids::ProjectId,
    worktree_id: Option<comando_types::ids::WorktreeId>,
    root_path: String,
    reason: GitWatchInvalidationReason,
    last_event_at: Instant,
}

impl WatcherRegistry {
    pub fn new() -> Self {
        Self {
            watchers: HashMap::new(),
            roots: HashMap::new(),
            write_tracker: WriteTracker::new(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            pending_git_invalidations: Arc::new(Mutex::new(HashMap::new())),
            fs_events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn write_tracker(&self) -> WriteTracker {
        self.write_tracker.clone()
    }

    pub fn sync_roots(&mut self, roots: Vec<ProjectRoot>) -> Result<(), FsError> {
        let desired = roots
            .into_iter()
            .filter(|root| root.root_path.is_dir())
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
            .filter(|(_, pending)| {
                force || now.duration_since(pending.last_event_at) >= WATCH_DEBOUNCE
            })
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

        let mut git_invalidations = Vec::new();
        let mut pending_git_invalidations = self
            .pending_git_invalidations
            .lock()
            .expect("git watch pending lock");
        let ready_git_keys = pending_git_invalidations
            .iter()
            .filter(|(_, pending)| {
                force || now.duration_since(pending.last_event_at) >= WATCH_DEBOUNCE
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();

        for key in ready_git_keys {
            if let Some(pending) = pending_git_invalidations.remove(&key) {
                git_invalidations.push(NativeGitRepositoryInvalidation {
                    project_id: pending.project_id,
                    worktree_id: pending.worktree_id,
                    root_path: Some(pending.root_path),
                    reason: pending.reason.as_native_reason().to_string(),
                    occurred_at: now_rfc3339(),
                });
            }
        }
        drop(pending_git_invalidations);

        let fs_events = {
            let mut events = self.fs_events.lock().expect("watch events lock");
            std::mem::take(&mut *events)
        };

        WatcherDrain {
            invalidations,
            fs_events,
            git_invalidations,
        }
    }

    fn start_root(&mut self, key: String, root: ProjectRoot) -> Result<(), FsError> {
        let watch_root = root.root_path.clone();
        let pending = Arc::clone(&self.pending);
        let pending_git_invalidations = Arc::clone(&self.pending_git_invalidations);
        let fs_events = Arc::clone(&self.fs_events);
        let write_tracker = self.write_tracker.clone();
        let root_for_callback = root.clone();
        let key_for_callback = key.clone();

        let mut watcher =
            notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
                let Ok(event) = result else {
                    return;
                };

                handle_notify_event(
                    NotifyEventContext {
                        key: &key_for_callback,
                        root: &root_for_callback,
                        watch_root: &watch_root,
                        write_tracker: &write_tracker,
                        pending: &pending,
                        pending_git_invalidations: &pending_git_invalidations,
                        fs_events: &fs_events,
                    },
                    event,
                );
            })?;
        watcher.watch(&root.root_path, RecursiveMode::Recursive)?;

        self.roots.insert(key.clone(), root);
        self.watchers.insert(key, watcher);
        Ok(())
    }

    #[cfg(feature = "test-hooks")]
    pub fn queue_test_invalidation_after_delay(
        &self,
        root: ProjectRoot,
        relative_path: String,
        delay: Duration,
    ) {
        let pending = Arc::clone(&self.pending);
        let pending_git_invalidations = Arc::clone(&self.pending_git_invalidations);
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            let key = watch_key(&root);
            record_test_watch_path(
                &key,
                &root,
                &relative_path,
                &pending,
                &pending_git_invalidations,
            );
        });
    }
}

impl Default for WatcherRegistry {
    fn default() -> Self {
        Self::new()
    }
}

struct NotifyEventContext<'a> {
    key: &'a str,
    root: &'a ProjectRoot,
    watch_root: &'a Path,
    write_tracker: &'a WriteTracker,
    pending: &'a Arc<Mutex<HashMap<String, PendingInvalidation>>>,
    pending_git_invalidations: &'a Arc<Mutex<HashMap<String, PendingGitInvalidation>>>,
    fs_events: &'a Arc<Mutex<Vec<(String, NativeFsWatchEvent)>>>,
}

fn handle_notify_event(context: NotifyEventContext<'_>, event: Event) {
    let event_name = event_name_for_kind(&event.kind);
    let event_kind = event_kind_for_kind(&event.kind);

    'paths: for path in event.paths {
        let absolute_path = if path.is_absolute() {
            path.clone()
        } else {
            context.watch_root.join(&path)
        };

        if absolute_path == context.watch_root {
            continue;
        }

        let Some(relative_path) = normalize_watched_path(context.watch_root, &absolute_path) else {
            continue;
        };
        if should_ignore_watch_path(&relative_path) {
            continue;
        }

        if let Some(reason) = git_watch_invalidation_reason(&relative_path) {
            record_pending_git_invalidation(
                context.key,
                context.root,
                reason,
                context.pending_git_invalidations,
            );
            continue;
        }

        let current_hash = std::fs::read(&absolute_path)
            .ok()
            .map(|bytes| hash_bytes(&bytes));
        if context
            .write_tracker
            .has_recent_match(&absolute_path, current_hash)
        {
            continue;
        }
        if context.write_tracker.has_recent_entry(&absolute_path) {
            // Some platforms can report a modify event while the file is between
            // truncate and final write. Give the content hash a tiny chance to
            // settle before treating the event as external.
            for _ in 0..SELF_WRITE_HASH_RETRY_ATTEMPTS {
                std::thread::sleep(SELF_WRITE_HASH_RETRY_DELAY);
                let current_hash = std::fs::read(&absolute_path)
                    .ok()
                    .map(|bytes| hash_bytes(&bytes));
                if context
                    .write_tracker
                    .has_recent_match(&absolute_path, current_hash)
                {
                    continue 'paths;
                }
            }
        }

        record_pending_invalidation(context.key, context.root, &relative_path, context.pending);
        context.fs_events.lock().expect("watch events lock").push((
            event_name.to_string(),
            NativeFsWatchEvent {
                project_id: context.root.project_id.clone(),
                worktree_id: context.root.worktree_id.clone(),
                relative_path: Some(RelativePath(relative_path)),
                kind: event_kind.to_string(),
                origin: NativeFsMutationOrigin::External,
                occurred_at: now_rfc3339(),
            },
        ));
    }
}

fn record_pending_git_invalidation(
    key: &str,
    root: &ProjectRoot,
    reason: GitWatchInvalidationReason,
    pending_git_invalidations: &Arc<Mutex<HashMap<String, PendingGitInvalidation>>>,
) {
    let mut pending = pending_git_invalidations
        .lock()
        .expect("git watch pending lock");
    let entry = pending
        .entry(key.to_string())
        .or_insert_with(|| PendingGitInvalidation {
            project_id: root.project_id.clone(),
            worktree_id: root.worktree_id.clone(),
            root_path: root.root_path.display().to_string(),
            reason,
            last_event_at: Instant::now(),
        });

    entry.reason = merge_git_invalidation_reason(entry.reason, reason);
    entry.last_event_at = Instant::now();
}

#[cfg(feature = "test-hooks")]
fn record_test_watch_path(
    key: &str,
    root: &ProjectRoot,
    relative_path: &str,
    pending: &Arc<Mutex<HashMap<String, PendingInvalidation>>>,
    pending_git_invalidations: &Arc<Mutex<HashMap<String, PendingGitInvalidation>>>,
) {
    if should_ignore_watch_path(relative_path) {
        return;
    }

    if let Some(reason) = git_watch_invalidation_reason(relative_path) {
        record_pending_git_invalidation(key, root, reason, pending_git_invalidations);
        return;
    }

    record_pending_invalidation(key, root, relative_path, pending);
}

fn merge_git_invalidation_reason(
    existing: GitWatchInvalidationReason,
    incoming: GitWatchInvalidationReason,
) -> GitWatchInvalidationReason {
    if incoming.priority() > existing.priority() {
        incoming
    } else {
        existing
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
        EventKind::Modify(ModifyKind::Name(
            RenameMode::Both | RenameMode::From | RenameMode::To,
        )) => "fs://entry-renamed",
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
    use std::fs::{self, OpenOptions};
    use std::thread;
    use std::time::Duration;

    use comando_types::ids::{ProjectId, WorktreeId};
    use tempfile::TempDir;

    use super::*;
    use crate::test_support::project_root;

    #[test]
    fn coalesces_pending_events() {
        let temp = TempDir::new().expect("temp");
        let root = project_root(temp.path());
        let mut watchers = WatcherRegistry::new();

        record_pending_invalidation(
            "project_1:project_1:primary",
            &root,
            "a.txt",
            &watchers.pending,
        );
        record_pending_invalidation(
            "project_1:project_1:primary",
            &root,
            "b.txt",
            &watchers.pending,
        );
        thread::sleep(Duration::from_millis(160));

        let drain = watchers.drain(false);
        assert!(drain.invalidations.iter().any(|invalidation| {
            invalidation.relative_paths.as_ref().is_some_and(|paths| {
                let values = paths.iter().map(|path| path.0.as_str()).collect::<Vec<_>>();
                values.contains(&"a.txt") || values.contains(&"b.txt")
            })
        }));
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

    #[test]
    fn external_write_after_owned_write_still_invalidates_the_file() {
        let temp = TempDir::new().expect("temp");
        let path = temp.path().join("owned.txt");
        fs::write(&path, "owned").expect("write");
        let root = project_root(temp.path());
        let mut watchers = WatcherRegistry::new();
        let tracker = watchers.write_tracker();

        tracker.track_content(path.clone(), "owned");
        fs::write(&path, "owned").expect("write same");
        fs::write(&path, "external").expect("write external");
        let key = watch_key(&root);
        let mut event = Event::new(EventKind::Modify(ModifyKind::Any));
        event.paths.push(path);
        handle_notify_event(
            NotifyEventContext {
                key: &key,
                root: &root,
                watch_root: temp.path(),
                write_tracker: &tracker,
                pending: &watchers.pending,
                pending_git_invalidations: &watchers.pending_git_invalidations,
                fs_events: &watchers.fs_events,
            },
            event,
        );

        let drain = watchers.drain(true);
        assert!(drain.invalidations.iter().any(|invalidation| {
            invalidation
                .relative_paths
                .as_ref()
                .is_some_and(|paths| paths.iter().any(|path| path.0 == "owned.txt"))
        }));
        assert!(drain.fs_events.iter().any(|(_, event)| {
            event
                .relative_path
                .as_ref()
                .is_some_and(|path| path.0 == "owned.txt")
                && event.origin == NativeFsMutationOrigin::External
        }));
    }

    #[test]
    fn waits_for_a_truncated_owned_write_to_settle_before_invalidating() {
        let temp = TempDir::new().expect("temp");
        let path = temp.path().join("owned.txt");
        fs::write(&path, "owned").expect("write");
        let root = project_root(temp.path());
        let mut watchers = WatcherRegistry::new();
        let tracker = watchers.write_tracker();

        tracker.track_content(path.clone(), "owned");
        let replacement_path = path.clone();
        let replacement = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            fs::write(replacement_path, "owned").expect("restore owned content");
        });
        OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .expect("truncate owned file");
        let key = watch_key(&root);
        let mut event = Event::new(EventKind::Modify(ModifyKind::Any));
        event.paths.push(path);
        handle_notify_event(
            NotifyEventContext {
                key: &key,
                root: &root,
                watch_root: temp.path(),
                write_tracker: &tracker,
                pending: &watchers.pending,
                pending_git_invalidations: &watchers.pending_git_invalidations,
                fs_events: &watchers.fs_events,
            },
            event,
        );
        replacement.join().expect("replacement thread");

        let drain = watchers.drain(true);
        assert!(drain.invalidations.is_empty());
        assert!(drain.fs_events.is_empty());
    }

    #[test]
    fn sync_roots_ignores_missing_directories() {
        let temp = TempDir::new().expect("temp");
        let missing = temp.path().join("missing");
        let mut watchers = WatcherRegistry::new();

        watchers
            .sync_roots(vec![project_root(&missing)])
            .expect("missing roots should not fail registry sync");

        assert!(watchers.watchers.is_empty());
        assert!(watchers.roots.is_empty());
    }

    #[test]
    fn coalesces_pending_git_events() {
        let temp = TempDir::new().expect("temp");
        let root = project_root(temp.path());
        let watchers = WatcherRegistry::new();

        record_pending_git_invalidation(
            "project_1:project_1:primary",
            &root,
            GitWatchInvalidationReason::Status,
            &watchers.pending_git_invalidations,
        );
        record_pending_git_invalidation(
            "project_1:project_1:primary",
            &root,
            GitWatchInvalidationReason::Branch,
            &watchers.pending_git_invalidations,
        );
        thread::sleep(Duration::from_millis(160));

        let mut watchers = watchers;
        let drain = watchers.drain(false);
        assert_eq!(drain.git_invalidations.len(), 1);
        assert_eq!(drain.git_invalidations[0].reason, "branch");
        assert_eq!(
            drain.git_invalidations[0].root_path.as_deref(),
            Some(temp.path().to_string_lossy().as_ref()),
        );
    }

    #[test]
    fn discards_events_from_a_worktree_removed_before_its_callback_runs() {
        let temp = TempDir::new().expect("temp");
        let active_path = temp.path().join("active");
        let removed_path = temp.path().join("removed");
        fs::create_dir(&active_path).expect("active directory");
        fs::create_dir(&removed_path).expect("removed directory");
        let removed_file = removed_path.join("stale.txt");
        fs::write(&removed_file, "stale").expect("stale file");

        let active_root = worktree_root(&active_path, "worktree-active");
        let removed_root = worktree_root(&removed_path, "worktree-removed");
        let mut watchers = WatcherRegistry::new();
        let active_key = watch_key(&active_root);
        let removed_key = watch_key(&removed_root);
        watchers
            .roots
            .insert(active_key.clone(), active_root.clone());
        watchers
            .roots
            .insert(removed_key.clone(), removed_root.clone());

        watchers.stop(&removed_root);

        let tracker = watchers.write_tracker();
        let mut event = Event::new(EventKind::Modify(ModifyKind::Any));
        event.paths.push(removed_file);
        handle_notify_event(
            NotifyEventContext {
                key: &removed_key,
                root: &removed_root,
                watch_root: &removed_path,
                write_tracker: &tracker,
                pending: &watchers.pending,
                pending_git_invalidations: &watchers.pending_git_invalidations,
                fs_events: &watchers.fs_events,
            },
            event,
        );
        record_pending_git_invalidation(
            &removed_key,
            &removed_root,
            GitWatchInvalidationReason::Status,
            &watchers.pending_git_invalidations,
        );
        record_pending_invalidation(
            &active_key,
            &active_root,
            "still-active.txt",
            &watchers.pending,
        );

        let drain = watchers.drain(true);

        assert_eq!(drain.invalidations.len(), 1);
        assert_eq!(drain.invalidations[0].worktree_id, active_root.worktree_id,);
        assert!(drain.git_invalidations.is_empty());
        assert!(drain.fs_events.is_empty());
    }

    fn worktree_root(path: &Path, worktree_id: &str) -> ProjectRoot {
        ProjectRoot {
            project_id: ProjectId("project_1".to_string()),
            worktree_id: Some(WorktreeId(worktree_id.to_string())),
            root_path: path.to_path_buf(),
        }
    }
}
