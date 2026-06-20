use std::collections::HashMap;
use std::fs;

use comando_fs::ProjectRoot;
use comando_fs::path::validate_untrusted_relative_path;
use comando_types::ids::{OperationId, ProjectId, WorktreeId};
use comando_types::projects::NativeProjectTreeEntry;

use crate::builder::{IndexBuildOptions, build_project_index};
use crate::cancellation::CancellationRegistry;
use crate::entry::{IndexEntryKind, IndexedProjectEntry};
use crate::error::{IndexError, IndexResult};
use crate::incremental::{
    IndexUpdate, IndexUpdateKind, refresh_has_children, remove_paths, should_rebuild_for_update,
};
use crate::query::ProjectSearchQuery;
use crate::ranking::{SearchMatch, search_entries_cancellable};
use crate::stats::{IndexBuildStats, IndexStatus, IndexStatusSnapshot};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEvent {
    pub event_name: &'static str,
    pub snapshot: IndexStatusSnapshot,
}

#[derive(Debug, Clone)]
struct ProjectIndex {
    entries: Vec<IndexedProjectEntry>,
    generation: u64,
    root: ProjectRoot,
    stats: IndexBuildStats,
    status: IndexStatus,
}

#[derive(Debug, Clone)]
pub struct IndexService {
    indexes: HashMap<String, ProjectIndex>,
    options: IndexBuildOptions,
    cancellations: CancellationRegistry,
}

impl Default for IndexService {
    fn default() -> Self {
        Self::new(IndexBuildOptions::default())
    }
}

impl IndexService {
    pub fn new(options: IndexBuildOptions) -> Self {
        Self {
            indexes: HashMap::new(),
            options,
            cancellations: CancellationRegistry::new(),
        }
    }

    pub fn rebuild_project(
        &mut self,
        root: ProjectRoot,
    ) -> IndexResult<(Vec<NativeProjectTreeEntry>, Vec<IndexEvent>)> {
        self.rebuild_project_with_options(root, self.options.clone())
    }

    pub fn rebuild_project_with_options(
        &mut self,
        root: ProjectRoot,
        options: IndexBuildOptions,
    ) -> IndexResult<(Vec<NativeProjectTreeEntry>, Vec<IndexEvent>)> {
        let scope_key = scope_key(&root.project_id, root.worktree_id.as_ref());
        let mut events = Vec::new();
        let building_snapshot = self.snapshot_for_root(
            &root,
            0,
            IndexStatus::Building,
            IndexBuildStats::default(),
            None,
        );
        events.push(IndexEvent {
            event_name: "index://building",
            snapshot: building_snapshot,
        });

        let built = build_project_index(&root, &options)?;
        let generation = self
            .indexes
            .get(&scope_key)
            .map(|index| index.generation + 1)
            .unwrap_or(1);
        let status = if built.stats.truncated {
            IndexStatus::Stale
        } else {
            IndexStatus::Ready
        };
        let entries = built.entries;
        let tree_entries = entries
            .iter()
            .map(IndexedProjectEntry::to_project_tree_entry)
            .collect::<Vec<_>>();
        let stats = built.stats;

        self.indexes.insert(
            scope_key,
            ProjectIndex {
                entries,
                generation,
                root: root.clone(),
                stats: stats.clone(),
                status,
            },
        );

        events.push(IndexEvent {
            event_name: index_status_event_name(status),
            snapshot: self.snapshot_for_root(&root, generation, status, stats, None),
        });

        Ok((tree_entries, events))
    }

    pub fn list_project_entries(
        &mut self,
        root: ProjectRoot,
    ) -> IndexResult<(Vec<NativeProjectTreeEntry>, Vec<IndexEvent>)> {
        let events = self.ensure_ready(root)?;
        let index = self.index_for_root(&events.0)?;
        let entries = index
            .entries
            .iter()
            .map(IndexedProjectEntry::to_project_tree_entry)
            .collect::<Vec<_>>();

        Ok((entries, events.1))
    }

    pub fn search_project_entries(
        &mut self,
        root: ProjectRoot,
        query: &ProjectSearchQuery,
        limit: usize,
        include_ancestor_directories: bool,
        context_key: Option<&str>,
    ) -> IndexResult<(
        Vec<IndexedProjectEntry>,
        Vec<SearchMatch>,
        OperationId,
        Vec<IndexEvent>,
    )> {
        if query.is_empty() {
            let token = self.cancellations.start_operation(context_key);
            let operation_id = token.operation_id().clone();
            self.cancellations.clear(&operation_id);
            return Ok((Vec::new(), Vec::new(), operation_id, Vec::new()));
        }

        let events = self.ensure_ready(root)?;
        let token = self.cancellations.start_operation(context_key);
        let operation_id = token.operation_id().clone();
        let index = self.index_for_root(&events.0)?;
        let matches = match search_entries_cancellable(&index.entries, query, limit, Some(&token)) {
            Ok(matches) => matches,
            Err(error) => {
                self.cancellations.clear(&operation_id);
                return Err(error);
            }
        };
        if token.is_cancelled() {
            self.cancellations.clear(&operation_id);
            return Err(IndexError::Cancelled);
        }

        let entries = if include_ancestor_directories {
            include_ancestor_directory_entries(&matches, &index.entries)
        } else {
            matches.iter().map(|match_| match_.entry.clone()).collect()
        };
        self.cancellations.clear(&operation_id);

        Ok((entries, matches, operation_id, events.1))
    }

    pub fn ensure_project_index(&mut self, root: ProjectRoot) -> IndexResult<Vec<IndexEvent>> {
        self.ensure_ready(root).map(|(_, events)| events)
    }

    pub fn search_project_entries_with_operation(
        &mut self,
        root: ProjectRoot,
        query: &ProjectSearchQuery,
        limit: usize,
        include_ancestor_directories: bool,
        operation_id: OperationId,
    ) -> IndexResult<(Vec<IndexedProjectEntry>, Vec<SearchMatch>)> {
        let index = self.index_for_root(&root)?;
        let token = self.cancellations.token_for_operation(operation_id.clone());
        let matches = match search_entries_cancellable(&index.entries, query, limit, Some(&token)) {
            Ok(matches) => matches,
            Err(error) => {
                self.cancellations.clear(&operation_id);
                return Err(error);
            }
        };
        if token.is_cancelled() {
            self.cancellations.clear(&operation_id);
            return Err(IndexError::Cancelled);
        }

        let entries = if include_ancestor_directories {
            include_ancestor_directory_entries(&matches, &index.entries)
        } else {
            matches.iter().map(|match_| match_.entry.clone()).collect()
        };
        self.cancellations.clear(&operation_id);

        Ok((entries, matches))
    }

    pub fn update_entries(
        &mut self,
        root: ProjectRoot,
        update: IndexUpdate,
    ) -> IndexResult<Vec<IndexEvent>> {
        let scope_key = scope_key(&root.project_id, root.worktree_id.as_ref());
        if should_rebuild_for_update(&update, &self.options.policy) {
            return self.rebuild_project(root).map(|(_, events)| events);
        }

        let Some(index) = self.indexes.get_mut(&scope_key) else {
            return self.rebuild_project(root).map(|(_, events)| events);
        };
        let relative_paths = update.relative_paths.unwrap_or_default();
        let mut next_entries = remove_paths(&index.entries, &relative_paths);

        if matches!(
            update.kind,
            IndexUpdateKind::Created | IndexUpdateKind::Updated
        ) {
            for relative_path in &relative_paths {
                let Some(entry) =
                    indexed_entry_for_relative_path(&root, relative_path, &self.options)?
                else {
                    continue;
                };

                if entry.kind.is_directory() {
                    return self.rebuild_project(root).map(|(_, events)| events);
                }

                next_entries.push(entry);
            }
        }

        next_entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        index.entries = refresh_has_children(next_entries);
        index.generation += 1;
        index.stats.entry_count = index.entries.len();
        index.stats.indexed_file_count = index
            .entries
            .iter()
            .filter(|entry| !entry.kind.is_directory())
            .count();
        index.stats.indexed_directory_count = index
            .entries
            .iter()
            .filter(|entry| entry.kind.is_directory())
            .count();
        index.status = IndexStatus::Ready;

        Ok(vec![IndexEvent {
            event_name: "index://updated",
            snapshot: status_snapshot(index),
        }])
    }

    pub fn get_status(
        &self,
        project_id: &ProjectId,
        worktree_id: Option<&WorktreeId>,
    ) -> IndexStatusSnapshot {
        let scope_key = scope_key(project_id, worktree_id);
        self.indexes
            .get(&scope_key)
            .map(status_snapshot)
            .unwrap_or_else(|| IndexStatusSnapshot {
                project_id: project_id.0.clone(),
                worktree_id: worktree_id.map(|id| id.0.clone()),
                generation: 0,
                status: IndexStatus::Idle,
                stats: IndexBuildStats::default(),
                operation_id: None,
                occurred_at: now_rfc3339(),
            })
    }

    pub fn drop_project(
        &mut self,
        project_id: &ProjectId,
        worktree_id: Option<&WorktreeId>,
    ) -> bool {
        self.indexes
            .remove(&scope_key(project_id, worktree_id))
            .is_some()
    }

    pub fn cancel_search(&self, operation_id: &OperationId) -> bool {
        self.cancellations.cancel(operation_id)
    }

    pub fn begin_search_operation(&self, context_key: Option<&str>) -> OperationId {
        self.cancellations
            .start_operation(context_key)
            .operation_id()
            .clone()
    }

    fn ensure_ready(&mut self, root: ProjectRoot) -> IndexResult<(ProjectRoot, Vec<IndexEvent>)> {
        let scope_key = scope_key(&root.project_id, root.worktree_id.as_ref());
        if self.indexes.contains_key(&scope_key) {
            return Ok((root, Vec::new()));
        }

        let (_, events) = self.rebuild_project(root.clone())?;
        Ok((root, events))
    }

    fn index_for_root(&self, root: &ProjectRoot) -> IndexResult<&ProjectIndex> {
        self.indexes
            .get(&scope_key(&root.project_id, root.worktree_id.as_ref()))
            .ok_or(IndexError::IndexNotReady)
    }

    fn snapshot_for_root(
        &self,
        root: &ProjectRoot,
        generation: u64,
        status: IndexStatus,
        stats: IndexBuildStats,
        operation_id: Option<OperationId>,
    ) -> IndexStatusSnapshot {
        IndexStatusSnapshot {
            project_id: root.project_id.0.clone(),
            worktree_id: root.worktree_id.as_ref().map(|id| id.0.clone()),
            generation,
            status,
            stats,
            operation_id: operation_id.map(|id| id.0),
            occurred_at: now_rfc3339(),
        }
    }
}

fn include_ancestor_directory_entries(
    matches: &[SearchMatch],
    entries: &[IndexedProjectEntry],
) -> Vec<IndexedProjectEntry> {
    let entries_by_path = entries
        .iter()
        .map(|entry| (entry.relative_path.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let mut result = Vec::<IndexedProjectEntry>::new();
    let mut seen = std::collections::HashSet::<String>::new();

    for match_ in matches {
        for ancestor_path in ancestor_directory_paths(&match_.entry.relative_path) {
            if let Some(ancestor) = entries_by_path.get(ancestor_path.as_str()) {
                if ancestor.kind.is_directory() && seen.insert(ancestor.relative_path.clone()) {
                    result.push((*ancestor).clone());
                }
            }
        }

        if seen.insert(match_.entry.relative_path.clone()) {
            result.push(match_.entry.clone());
        }
    }

    result
}

fn ancestor_directory_paths(relative_path: &str) -> Vec<String> {
    let mut ancestors = Vec::new();
    let mut cursor = String::new();
    let segments = relative_path.split('/').collect::<Vec<_>>();

    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        if segment.is_empty() {
            continue;
        }
        if cursor.is_empty() {
            cursor.push_str(segment);
        } else {
            cursor.push('/');
            cursor.push_str(segment);
        }
        ancestors.push(cursor.clone());
    }

    ancestors
}

fn status_snapshot(index: &ProjectIndex) -> IndexStatusSnapshot {
    IndexStatusSnapshot {
        project_id: index.root.project_id.0.clone(),
        worktree_id: index.root.worktree_id.as_ref().map(|id| id.0.clone()),
        generation: index.generation,
        status: index.status,
        stats: index.stats.clone(),
        operation_id: None,
        occurred_at: now_rfc3339(),
    }
}

fn index_status_event_name(status: IndexStatus) -> &'static str {
    match status {
        IndexStatus::Idle => "index://progress",
        IndexStatus::Building => "index://building",
        IndexStatus::Ready => "index://ready",
        IndexStatus::Stale => "index://stale",
        IndexStatus::Error => "index://error",
    }
}

fn indexed_entry_for_relative_path(
    root: &ProjectRoot,
    relative_path: &str,
    options: &IndexBuildOptions,
) -> IndexResult<Option<IndexedProjectEntry>> {
    let validated = validate_untrusted_relative_path(relative_path, false)?;
    let absolute_path = root.root_path.join(validated);
    let metadata = match fs::symlink_metadata(&absolute_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let name = absolute_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| IndexError::Internal("Indexed path had no file name.".to_string()))?
        .to_string();
    let kind = if metadata.file_type().is_symlink() {
        IndexEntryKind::Symlink
    } else if metadata.is_dir() {
        IndexEntryKind::Directory
    } else if metadata.is_file() {
        IndexEntryKind::File
    } else {
        IndexEntryKind::Other
    };
    if !options
        .policy
        .should_index_entry(&name, kind.is_directory())
    {
        return Ok(None);
    }

    Ok(Some(IndexedProjectEntry::new(
        root.project_id.clone(),
        root.worktree_id.clone(),
        name.clone(),
        relative_path.to_string(),
        kind,
        false,
        options.policy.state_for_entry(&name, kind.is_directory()),
    )))
}

fn scope_key(project_id: &ProjectId, worktree_id: Option<&WorktreeId>) -> String {
    format!(
        "{}:{}",
        project_id.0,
        normalized_scope_worktree_id(worktree_id).unwrap_or("primary")
    )
}

fn normalized_scope_worktree_id(worktree_id: Option<&WorktreeId>) -> Option<&str> {
    worktree_id
        .map(|id| id.0.as_str())
        .filter(|id| !id.ends_with(":primary"))
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::incremental::{IndexUpdate, IndexUpdateKind};
    use crate::test_support::project_root;

    use super::*;

    #[test]
    fn list_builds_on_demand() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("README.md"), "readme").expect("readme");
        let mut service = IndexService::default();

        let (entries, events) = service
            .list_project_entries(project_root(temp.path()))
            .expect("entries");

        assert_eq!(entries.len(), 1);
        assert!(
            events
                .iter()
                .any(|event| event.event_name == "index://ready")
        );
    }

    #[test]
    fn search_can_include_ancestors() {
        let temp = TempDir::new().expect("temp");
        fs::create_dir_all(temp.path().join("src/shared")).expect("dirs");
        fs::write(temp.path().join("src/shared/search.ts"), "search").expect("file");
        let mut service = IndexService::default();

        let (entries, _, _, _) = service
            .search_project_entries(
                project_root(temp.path()),
                &ProjectSearchQuery::new("search"),
                1,
                true,
                None,
            )
            .expect("search");
        let paths = entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["src", "src/shared", "src/shared/search.ts"]);
    }

    #[test]
    fn update_can_remove_deleted_entry() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("README.md"), "readme").expect("readme");
        let root = project_root(temp.path());
        let mut service = IndexService::default();
        service.list_project_entries(root.clone()).expect("build");

        service
            .update_entries(
                root.clone(),
                IndexUpdate::paths(IndexUpdateKind::Deleted, vec!["README.md".to_string()]),
            )
            .expect("update");
        let (entries, _) = service.list_project_entries(root).expect("list");

        assert!(entries.is_empty());
    }

    #[test]
    fn update_can_add_created_file_without_full_rebuild() {
        let temp = TempDir::new().expect("temp");
        let root = project_root(temp.path());
        let mut service = IndexService::default();
        service.list_project_entries(root.clone()).expect("build");
        fs::write(temp.path().join("created.ts"), "created").expect("created");

        service
            .update_entries(
                root.clone(),
                IndexUpdate::paths(IndexUpdateKind::Created, vec!["created.ts".to_string()]),
            )
            .expect("update");
        let (entries, _) = service.list_project_entries(root).expect("list");

        assert!(
            entries
                .iter()
                .any(|entry| entry.relative_path == "created.ts")
        );
    }

    #[test]
    fn truncated_rebuild_emits_stale_event() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("a.ts"), "a").expect("a");
        fs::write(temp.path().join("b.ts"), "b").expect("b");
        let mut service = IndexService::new(IndexBuildOptions {
            policy: crate::policy::IndexPolicy::default().with_max_entries(1),
        });

        let (_, events) = service
            .rebuild_project(project_root(temp.path()))
            .expect("rebuild");

        assert!(
            events
                .iter()
                .any(|event| event.event_name == "index://stale")
        );
    }

    #[test]
    fn context_key_supersedes_previous_search_operation() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("a.ts"), "a").expect("a");
        let mut service = IndexService::default();
        let root = project_root(temp.path());
        service.ensure_project_index(root.clone()).expect("index");

        let first = service.begin_search_operation(Some("quick-open"));
        let second = service.begin_search_operation(Some("quick-open"));

        assert!(matches!(
            service.search_project_entries_with_operation(
                root,
                &ProjectSearchQuery::new("a"),
                10,
                false,
                first.clone(),
            ),
            Err(IndexError::Cancelled)
        ));
        assert!(!service.cancel_search(&first));
        assert!(service.cancel_search(&second));
    }
}
