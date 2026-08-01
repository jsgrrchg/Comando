use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
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
#[cfg(feature = "test-hooks")]
use crate::policy::git_watch_invalidation_reason;
use crate::policy::{GitWatchInvalidationReason, should_ignore_watch_path};
use crate::registry::{GitWatchScope, ProjectRoot};

const WATCH_DEBOUNCE: Duration = Duration::from_millis(140);
const GIT_WATCH_DEBOUNCE: Duration = Duration::from_millis(75);
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
    metadata_managed_root_keys: HashSet<String>,
    metadata_watchers: HashMap<String, RecommendedWatcher>,
    metadata_roots: HashMap<String, GitMetadataWatchRoot>,
    write_tracker: WriteTracker,
    pending: Arc<Mutex<HashMap<String, PendingInvalidation>>>,
    pending_git_invalidations: Arc<Mutex<HashMap<String, PendingGitInvalidation>>>,
    fs_events: Arc<Mutex<Vec<PendingFsEvent>>>,
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

#[derive(Debug, Clone)]
struct PendingFsEvent {
    event_name: String,
    event: NativeFsWatchEvent,
    watch_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitMetadataWatchRoot {
    watch_path: PathBuf,
    common_dir_path: PathBuf,
    scopes: Vec<GitWatchScope>,
}

impl WatcherRegistry {
    pub fn new() -> Self {
        Self {
            watchers: HashMap::new(),
            roots: HashMap::new(),
            metadata_managed_root_keys: HashSet::new(),
            metadata_watchers: HashMap::new(),
            metadata_roots: HashMap::new(),
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
        self.sync_topology(roots, Vec::new())
    }

    pub fn sync_topology(
        &mut self,
        roots: Vec<ProjectRoot>,
        git_scopes: Vec<GitWatchScope>,
    ) -> Result<(), FsError> {
        let metadata_managed_root_keys = git_scopes
            .iter()
            .map(|scope| watch_key(&scope.root))
            .collect::<HashSet<_>>();
        // Metadata watchers must be live before working-tree callbacks start
        // ignoring .git, otherwise a partial sync could create a blind spot.
        self.sync_metadata_roots(git_scopes)?;
        let desired = roots
            .into_iter()
            .filter(|root| root.root_path.is_dir())
            .map(|root| (watch_key(&root), root))
            .collect::<HashMap<_, _>>();

        for (key, root) in &desired {
            let metadata_managed = metadata_managed_root_keys.contains(key);
            if self.roots.get(key) == Some(root)
                && self.watchers.contains_key(key)
                && self.metadata_managed_root_keys.contains(key) == metadata_managed
            {
                continue;
            }

            self.start_root(key.clone(), root.clone(), metadata_managed)?;
        }

        // Stop obsolete watchers only after every replacement is live.
        let current_keys = self.roots.keys().cloned().collect::<Vec<_>>();
        for key in current_keys {
            if !desired.contains_key(&key) {
                self.remove_root(&key);
            }
        }

        self.metadata_managed_root_keys = metadata_managed_root_keys;
        Ok(())
    }

    pub fn start(&mut self, root: ProjectRoot) -> Result<(), FsError> {
        let key = watch_key(&root);
        if self.watchers.contains_key(&key) {
            return Ok(());
        }
        self.start_root(key, root, false)
    }

    pub fn stop(&mut self, root: &ProjectRoot) {
        let key = watch_key(root);
        self.remove_root(&key);
    }

    pub fn drain(&mut self, force: bool) -> WatcherDrain {
        let now = Instant::now();
        let active_keys = self.roots.keys().cloned().collect::<HashSet<_>>();
        let mut invalidations = Vec::new();
        let mut pending = self.pending.lock().expect("watch pending lock");
        // A notify callback can enqueue after a root is removed, so only active roots may publish.
        pending.retain(|key, _| active_keys.contains(key));
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
        pending_git_invalidations.retain(|key, _| active_keys.contains(key));
        let ready_git_keys = pending_git_invalidations
            .iter()
            .filter(|(_, pending)| {
                force || now.duration_since(pending.last_event_at) >= GIT_WATCH_DEBOUNCE
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
                .into_iter()
                .filter(|event| active_keys.contains(&event.watch_key))
                .map(|event| (event.event_name, event.event))
                .collect()
        };

        WatcherDrain {
            invalidations,
            fs_events,
            git_invalidations,
        }
    }

    fn start_root(
        &mut self,
        key: String,
        root: ProjectRoot,
        metadata_managed: bool,
    ) -> Result<(), FsError> {
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
                        metadata_managed,
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

    fn sync_metadata_roots(&mut self, git_scopes: Vec<GitWatchScope>) -> Result<(), FsError> {
        let desired = build_metadata_watch_roots(git_scopes);
        for (key, metadata_root) in &desired {
            if self.metadata_roots.get(key) == Some(metadata_root)
                && self.metadata_watchers.contains_key(key)
            {
                continue;
            }
            self.start_metadata_root(key.clone(), metadata_root.clone())?;
        }

        let current_keys = self.metadata_roots.keys().cloned().collect::<Vec<_>>();
        for key in current_keys {
            if !desired.contains_key(&key) {
                self.metadata_watchers.remove(&key);
                self.metadata_roots.remove(&key);
            }
        }

        Ok(())
    }

    fn start_metadata_root(
        &mut self,
        key: String,
        metadata_root: GitMetadataWatchRoot,
    ) -> Result<(), FsError> {
        let pending_git_invalidations = Arc::clone(&self.pending_git_invalidations);
        let root_for_callback = metadata_root.clone();

        let mut watcher =
            notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
                match result {
                    Ok(event) => handle_git_metadata_event(
                        &root_for_callback,
                        &pending_git_invalidations,
                        event,
                    ),
                    Err(_) => {
                        // An overflow or backend error means the exact mutation is unknown.
                        // Refresh every scope so the next registry sync can heal the topology.
                        for scope in &root_for_callback.scopes {
                            record_pending_git_invalidation(
                                &watch_key(&scope.root),
                                &scope.root,
                                GitWatchInvalidationReason::Unknown,
                                &pending_git_invalidations,
                            );
                        }
                    }
                }
            })?;
        watcher.watch(&metadata_root.watch_path, RecursiveMode::Recursive)?;

        // Inserting only after watch() succeeds keeps the previous watcher alive on failure.
        self.metadata_roots.insert(key.clone(), metadata_root);
        self.metadata_watchers.insert(key, watcher);
        Ok(())
    }

    fn remove_root(&mut self, key: &str) {
        self.watchers.remove(key);
        self.roots.remove(key);
        self.metadata_managed_root_keys.remove(key);
        self.pending.lock().expect("watch pending lock").remove(key);
        self.pending_git_invalidations
            .lock()
            .expect("git watch pending lock")
            .remove(key);
        self.fs_events
            .lock()
            .expect("watch events lock")
            .retain(|event| event.watch_key != key);
    }

    #[cfg(feature = "test-hooks")]
    pub fn queue_test_invalidation_after_delay(
        &mut self,
        root: ProjectRoot,
        relative_path: String,
        delay: Duration,
    ) {
        self.roots.insert(watch_key(&root), root.clone());
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
    metadata_managed: bool,
    fs_events: &'a Arc<Mutex<Vec<PendingFsEvent>>>,
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
        // Git metadata has a separate topology-aware watcher. Ignoring it here
        // prevents linked-worktree events from being attributed to the primary scope.
        if is_git_admin_path(&relative_path) {
            if !context.metadata_managed {
                record_pending_git_invalidation(
                    context.key,
                    context.root,
                    GitWatchInvalidationReason::Unknown,
                    context.pending_git_invalidations,
                );
            }
            continue;
        }
        if should_ignore_watch_path(&relative_path) {
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
        context
            .fs_events
            .lock()
            .expect("watch events lock")
            .push(PendingFsEvent {
                event_name: event_name.to_string(),
                event: NativeFsWatchEvent {
                    project_id: context.root.project_id.clone(),
                    worktree_id: context.root.worktree_id.clone(),
                    relative_path: Some(RelativePath(relative_path)),
                    kind: event_kind.to_string(),
                    origin: NativeFsMutationOrigin::External,
                    occurred_at: now_rfc3339(),
                },
                watch_key: context.key.to_string(),
            });
    }
}

fn build_metadata_watch_roots(
    mut scopes: Vec<GitWatchScope>,
) -> HashMap<String, GitMetadataWatchRoot> {
    scopes.sort_by(|left, right| {
        left.root
            .project_id
            .0
            .cmp(&right.root.project_id.0)
            .then_with(|| watch_key(&left.root).cmp(&watch_key(&right.root)))
    });
    let mut roots = HashMap::<String, GitMetadataWatchRoot>::new();

    for scope in scopes {
        if !scope.common_dir_path.is_dir() || !scope.git_dir_path.is_dir() {
            continue;
        }

        let common_key = metadata_watch_key(&scope.common_dir_path);
        roots
            .entry(common_key)
            .or_insert_with(|| GitMetadataWatchRoot {
                watch_path: scope.common_dir_path.clone(),
                common_dir_path: scope.common_dir_path.clone(),
                scopes: Vec::new(),
            })
            .scopes
            .push(scope.clone());

        // Standard linked worktree gitdirs live below commonDir. Keep support
        // for separate layouts without installing duplicate recursive watchers.
        if !scope.git_dir_path.starts_with(&scope.common_dir_path) {
            let git_dir_key = metadata_watch_key(&scope.git_dir_path);
            roots
                .entry(git_dir_key)
                .or_insert_with(|| GitMetadataWatchRoot {
                    watch_path: scope.git_dir_path.clone(),
                    common_dir_path: scope.common_dir_path.clone(),
                    scopes: Vec::new(),
                })
                .scopes
                .push(scope);
        }
    }

    for root in roots.values_mut() {
        root.scopes.sort_by_key(|scope| watch_key(&scope.root));
        root.scopes.dedup_by(|left, right| left.root == right.root);
    }

    roots
}

fn handle_git_metadata_event(
    metadata_root: &GitMetadataWatchRoot,
    pending_git_invalidations: &Arc<Mutex<HashMap<String, PendingGitInvalidation>>>,
    event: Event,
) {
    for path in event.paths {
        let absolute_path = if path.is_absolute() {
            path
        } else {
            metadata_root.watch_path.join(path)
        };

        for (root, reason) in route_git_metadata_path(metadata_root, &absolute_path) {
            record_pending_git_invalidation(
                &watch_key(&root),
                &root,
                reason,
                pending_git_invalidations,
            );
        }
    }
}

fn route_git_metadata_path(
    metadata_root: &GitMetadataWatchRoot,
    absolute_path: &Path,
) -> Vec<(ProjectRoot, GitWatchInvalidationReason)> {
    let common_relative = normalize_watched_path(&metadata_root.common_dir_path, absolute_path);
    if common_relative
        .as_deref()
        .is_some_and(is_worktree_inventory_path)
    {
        return metadata_root
            .scopes
            .iter()
            .map(|scope| (scope.root.clone(), GitWatchInvalidationReason::Worktree))
            .collect();
    }

    let exact_scope = metadata_root
        .scopes
        .iter()
        .filter(|scope| absolute_path.starts_with(&scope.git_dir_path))
        .max_by_key(|scope| scope.git_dir_path.components().count());

    if let Some(scope) = exact_scope.filter(|scope| {
        scope.git_dir_path != scope.common_dir_path
            || metadata_root.watch_path != scope.common_dir_path
    }) {
        let Some(relative_path) = normalize_watched_path(&scope.git_dir_path, absolute_path) else {
            return Vec::new();
        };
        return git_dir_invalidation_reason(&relative_path)
            .map(|reason| vec![(scope.root.clone(), reason)])
            .unwrap_or_default();
    }

    let Some(relative_path) = common_relative else {
        return Vec::new();
    };
    let normalized = relative_path.replace('\\', "/").to_lowercase();

    if let Some(reason) = primary_git_dir_invalidation_reason(&normalized) {
        return metadata_root
            .scopes
            .iter()
            .filter(|scope| scope.is_primary)
            .map(|scope| (scope.root.clone(), reason))
            .collect();
    }

    let Some(reason) = common_git_invalidation_reason(&normalized) else {
        return Vec::new();
    };
    metadata_root
        .scopes
        .iter()
        .map(|scope| (scope.root.clone(), reason))
        .collect()
}

fn is_worktree_inventory_path(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/").to_lowercase();
    let segments = normalized.split('/').collect::<Vec<_>>();
    segments.first() == Some(&"worktrees")
        // Directory metadata changes are emitted for ordinary index writes on some
        // backends, so only Git's topology marker files may invalidate every scope.
        && segments.len() >= 3
        && segments
            .last()
            .is_some_and(|segment| matches!(*segment, "gitdir" | "commondir" | "locked"))
}

fn git_dir_invalidation_reason(relative_path: &str) -> Option<GitWatchInvalidationReason> {
    let normalized = relative_path.replace('\\', "/").to_lowercase();
    match normalized.as_str() {
        "index" | "index.lock" => Some(GitWatchInvalidationReason::Status),
        "head" | "logs/head" => Some(GitWatchInvalidationReason::Branch),
        "orig_head" | "merge_head" | "cherry_pick_head" | "rebase_head" => {
            Some(GitWatchInvalidationReason::Status)
        }
        "gitdir" | "commondir" | "locked" => Some(GitWatchInvalidationReason::Worktree),
        path if path.starts_with("rebase-merge/")
            || path.starts_with("rebase-apply/")
            || path.starts_with("sequencer/") =>
        {
            Some(GitWatchInvalidationReason::Status)
        }
        path if path.starts_with("refs/") || path.starts_with("logs/refs/") => {
            Some(GitWatchInvalidationReason::Branch)
        }
        _ => None,
    }
}

fn primary_git_dir_invalidation_reason(relative_path: &str) -> Option<GitWatchInvalidationReason> {
    match relative_path {
        "index" | "index.lock" => Some(GitWatchInvalidationReason::Status),
        "head" | "logs/head" => Some(GitWatchInvalidationReason::Branch),
        "orig_head" | "merge_head" | "cherry_pick_head" | "rebase_head" => {
            Some(GitWatchInvalidationReason::Status)
        }
        path if path.starts_with("rebase-merge/")
            || path.starts_with("rebase-apply/")
            || path.starts_with("sequencer/") =>
        {
            Some(GitWatchInvalidationReason::Status)
        }
        _ => None,
    }
}

fn common_git_invalidation_reason(relative_path: &str) -> Option<GitWatchInvalidationReason> {
    match relative_path {
        "packed-refs" => Some(GitWatchInvalidationReason::Branch),
        "fetch_head" | "config" => Some(GitWatchInvalidationReason::Remote),
        path if path.starts_with("refs/remotes/") || path.starts_with("logs/refs/remotes/") => {
            Some(GitWatchInvalidationReason::Remote)
        }
        path if path.starts_with("refs/") || path.starts_with("logs/refs/") => {
            Some(GitWatchInvalidationReason::Branch)
        }
        path if path.starts_with("worktrees/") => Some(GitWatchInvalidationReason::Worktree),
        _ => None,
    }
}

fn is_git_admin_path(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/").to_lowercase();
    normalized == ".git" || normalized.starts_with(".git/")
}

fn metadata_watch_key(path: &Path) -> String {
    format!("git-metadata:{}", path.to_string_lossy())
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
    use std::process::Command;
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
        let key = watch_key(&root);
        watchers.roots.insert(key.clone(), root.clone());

        record_pending_invalidation(&key, &root, "a.txt", &watchers.pending);
        record_pending_invalidation(&key, &root, "b.txt", &watchers.pending);
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
        watchers.roots.insert(watch_key(&root), root.clone());
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
        watchers.roots.insert(watch_key(&root), root.clone());

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
                metadata_managed: false,
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
                metadata_managed: false,
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
        let mut watchers = WatcherRegistry::new();
        let key = watch_key(&root);
        watchers.roots.insert(key.clone(), root.clone());

        record_pending_git_invalidation(
            &key,
            &root,
            GitWatchInvalidationReason::Status,
            &watchers.pending_git_invalidations,
        );
        record_pending_git_invalidation(
            &key,
            &root,
            GitWatchInvalidationReason::Branch,
            &watchers.pending_git_invalidations,
        );
        thread::sleep(Duration::from_millis(160));

        let drain = watchers.drain(false);
        assert_eq!(drain.git_invalidations.len(), 1);
        assert_eq!(drain.git_invalidations[0].reason, "branch");
        assert_eq!(
            drain.git_invalidations[0].root_path.as_deref(),
            Some(temp.path().to_string_lossy().as_ref()),
        );
    }

    #[test]
    fn unmanaged_git_directory_creation_requests_topology_recovery() {
        let temp = TempDir::new().expect("temp");
        let git_dir = temp.path().join(".git");
        fs::create_dir(&git_dir).expect("git dir");
        let head_path = git_dir.join("HEAD");
        fs::write(&head_path, "ref: refs/heads/main\n").expect("head");
        let root = project_root(temp.path());
        let mut watchers = WatcherRegistry::new();
        let key = watch_key(&root);
        watchers.roots.insert(key.clone(), root.clone());
        let tracker = watchers.write_tracker();
        let mut event = Event::new(EventKind::Create(notify::event::CreateKind::File));
        event.paths.push(head_path);

        handle_notify_event(
            NotifyEventContext {
                key: &key,
                root: &root,
                watch_root: temp.path(),
                write_tracker: &tracker,
                pending: &watchers.pending,
                pending_git_invalidations: &watchers.pending_git_invalidations,
                metadata_managed: false,
                fs_events: &watchers.fs_events,
            },
            event,
        );

        let drain = watchers.drain(true);
        assert_eq!(drain.git_invalidations.len(), 1);
        assert_eq!(drain.git_invalidations[0].reason, "unknown");
        assert!(drain.invalidations.is_empty());
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
                metadata_managed: false,
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

    #[test]
    fn routes_linked_worktree_index_to_its_exact_scope() {
        let temp = TempDir::new().expect("temp");
        let common_dir = temp.path().join("repo/.git");
        let primary_root = worktree_root(&temp.path().join("repo"), "project_1:primary");
        let linked_root = worktree_root(&temp.path().join("linked"), "worktree-linked");
        let linked_git_dir = common_dir.join("worktrees/linked");
        let metadata_root = GitMetadataWatchRoot {
            watch_path: common_dir.clone(),
            common_dir_path: common_dir.clone(),
            scopes: vec![
                git_watch_scope(&primary_root, &common_dir, &common_dir, true),
                git_watch_scope(&linked_root, &linked_git_dir, &common_dir, false),
            ],
        };

        let routed = route_git_metadata_path(&metadata_root, &linked_git_dir.join("index"));

        assert_eq!(
            routed,
            vec![(linked_root, GitWatchInvalidationReason::Status)]
        );
    }

    #[test]
    fn ignores_linked_worktree_directory_metadata_events() {
        let temp = TempDir::new().expect("temp");
        let common_dir = temp.path().join("repo/.git");
        let primary_root = worktree_root(&temp.path().join("repo"), "project_1:primary");
        let linked_root = worktree_root(&temp.path().join("linked"), "worktree-linked");
        let metadata_root = GitMetadataWatchRoot {
            watch_path: common_dir.clone(),
            common_dir_path: common_dir.clone(),
            scopes: vec![
                git_watch_scope(&primary_root, &common_dir, &common_dir, true),
                git_watch_scope(
                    &linked_root,
                    &common_dir.join("worktrees/linked"),
                    &common_dir,
                    false,
                ),
            ],
        };

        let routed = route_git_metadata_path(&metadata_root, &common_dir.join("worktrees/linked"));

        assert!(routed.is_empty());
    }

    #[test]
    fn routes_shared_refs_to_every_worktree_scope() {
        let temp = TempDir::new().expect("temp");
        let common_dir = temp.path().join("repo/.git");
        let primary_root = worktree_root(&temp.path().join("repo"), "project_1:primary");
        let linked_root = worktree_root(&temp.path().join("linked"), "worktree-linked");
        let metadata_root = GitMetadataWatchRoot {
            watch_path: common_dir.clone(),
            common_dir_path: common_dir.clone(),
            scopes: vec![
                git_watch_scope(&primary_root, &common_dir, &common_dir, true),
                git_watch_scope(
                    &linked_root,
                    &common_dir.join("worktrees/linked"),
                    &common_dir,
                    false,
                ),
            ],
        };

        let routed =
            route_git_metadata_path(&metadata_root, &common_dir.join("refs/heads/feature"));

        assert_eq!(routed.len(), 2);
        assert!(
            routed
                .iter()
                .all(|(_, reason)| { *reason == GitWatchInvalidationReason::Branch })
        );
    }

    #[test]
    fn observes_git_add_and_commit_inside_a_real_linked_worktree() {
        let temp = TempDir::new().expect("temp");
        let primary_path = temp.path().join("primary");
        let linked_path = temp.path().join("linked");
        fs::create_dir(&primary_path).expect("primary directory");
        run_git(&primary_path, &["init", "-b", "main"]);
        run_git(&primary_path, &["config", "user.name", "Test User"]);
        run_git(
            &primary_path,
            &["config", "user.email", "test@example.invalid"],
        );
        fs::write(primary_path.join("tracked.txt"), "base\n").expect("base file");
        run_git(&primary_path, &["add", "tracked.txt"]);
        run_git(&primary_path, &["commit", "-m", "initial"]);
        run_git(
            &primary_path,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                linked_path.to_str().expect("linked path"),
            ],
        );

        let common_dir = git_path(&linked_path, "--git-common-dir");
        let primary_git_dir = git_path(&primary_path, "--git-dir");
        let linked_git_dir = git_path(&linked_path, "--git-dir");
        let primary_root = worktree_root(&primary_path, "project_1:primary");
        let linked_root = worktree_root(&linked_path, "worktree-linked");
        let mut watchers = WatcherRegistry::new();
        watchers
            .sync_topology(
                vec![primary_root.clone(), linked_root.clone()],
                vec![
                    git_watch_scope(&primary_root, &primary_git_dir, &common_dir, true),
                    git_watch_scope(&linked_root, &linked_git_dir, &common_dir, false),
                ],
            )
            .expect("watch topology");
        thread::sleep(Duration::from_millis(120));

        fs::write(linked_path.join("tracked.txt"), "changed\n").expect("linked change");
        thread::sleep(Duration::from_millis(250));
        let _ = watchers.drain(true);
        run_git(&linked_path, &["add", "tracked.txt"]);

        let invalidations = wait_for_git_invalidations(&mut watchers, |invalidation| {
            invalidation.worktree_id == linked_root.worktree_id && invalidation.reason == "status"
        });
        assert!(invalidations.iter().any(|invalidation| {
            invalidation.worktree_id == linked_root.worktree_id && invalidation.reason == "status"
        }));
        assert!(
            !invalidations
                .iter()
                .any(|invalidation| invalidation.worktree_id == primary_root.worktree_id)
        );

        run_git(&linked_path, &["commit", "-m", "linked commit"]);
        let commit_invalidations = wait_for_git_invalidations(&mut watchers, |invalidation| {
            invalidation.worktree_id == linked_root.worktree_id && invalidation.reason == "branch"
        });
        assert!(commit_invalidations.iter().any(|invalidation| {
            invalidation.worktree_id == linked_root.worktree_id && invalidation.reason == "branch"
        }));
    }

    fn git_watch_scope(
        root: &ProjectRoot,
        git_dir_path: &Path,
        common_dir_path: &Path,
        is_primary: bool,
    ) -> GitWatchScope {
        GitWatchScope {
            root: root.clone(),
            git_dir_path: git_dir_path.to_path_buf(),
            common_dir_path: common_dir_path.to_path_buf(),
            is_primary,
        }
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_path(cwd: &Path, argument: &str) -> PathBuf {
        let output = Command::new("git")
            .args(["rev-parse", "--path-format=absolute", argument])
            .current_dir(cwd)
            .output()
            .expect("resolve git path");
        assert!(output.status.success(), "resolve {argument}");
        PathBuf::from(
            String::from_utf8(output.stdout)
                .expect("utf8 git path")
                .trim(),
        )
    }

    fn wait_for_git_invalidations<F>(
        watchers: &mut WatcherRegistry,
        is_expected: F,
    ) -> Vec<NativeGitRepositoryInvalidation>
    where
        F: Fn(&NativeGitRepositoryInvalidation) -> bool,
    {
        let started = Instant::now();
        let mut invalidations = Vec::new();
        while started.elapsed() < Duration::from_secs(3) {
            thread::sleep(Duration::from_millis(50));
            invalidations.extend(watchers.drain(false).git_invalidations);
            if invalidations.iter().any(&is_expected) {
                break;
            }
        }
        invalidations
    }

    fn worktree_root(path: &Path, worktree_id: &str) -> ProjectRoot {
        ProjectRoot {
            project_id: ProjectId("project_1".to_string()),
            worktree_id: Some(WorktreeId(worktree_id.to_string())),
            root_path: path.to_path_buf(),
        }
    }
}
