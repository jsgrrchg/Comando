use std::collections::HashMap;

use comando_fs::ProjectRoot;
use comando_types::ids::{OperationId, ProjectId, WorktreeId};
use comando_types::projects::NativeProjectTreeEntry;

use crate::builder::{IndexBuildOptions, build_project_index};
use crate::cancellation::CancellationRegistry;
use crate::entry::IndexedProjectEntry;
use crate::error::{IndexError, IndexResult};
use crate::incremental::{IndexUpdate, remove_paths, should_rebuild_for_update};
use crate::query::ProjectSearchQuery;
use crate::ranking::{SearchMatch, search_entries};
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

        let built = build_project_index(&root, &self.options)?;
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
            event_name: "index://ready",
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
    ) -> IndexResult<(Vec<NativeProjectTreeEntry>, OperationId, Vec<IndexEvent>)> {
        if query.is_empty() {
            let token = self.cancellations.start_operation();
            let operation_id = token.operation_id().clone();
            self.cancellations.clear(&operation_id);
            return Ok((Vec::new(), operation_id, Vec::new()));
        }

        let events = self.ensure_ready(root)?;
        let token = self.cancellations.start_operation();
        let operation_id = token.operation_id().clone();
        let index = self.index_for_root(&events.0)?;
        let matches = search_entries(&index.entries, query, limit);
        if token.is_cancelled() {
            self.cancellations.clear(&operation_id);
            return Err(IndexError::Cancelled);
        }

        let entries = if include_ancestor_directories {
            include_ancestor_directory_entries(&matches, &index.entries)
        } else {
            matches.into_iter().map(|match_| match_.entry).collect()
        };
        self.cancellations.clear(&operation_id);

        Ok((
            entries
                .iter()
                .map(IndexedProjectEntry::to_project_tree_entry)
                .collect(),
            operation_id,
            events.1,
        ))
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
        index.entries = remove_paths(&index.entries, &relative_paths);
        index.generation += 1;
        index.stats.entry_count = index.entries.len();
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

fn scope_key(project_id: &ProjectId, worktree_id: Option<&WorktreeId>) -> String {
    format!(
        "{}:{}",
        project_id.0,
        worktree_id.map(|id| id.0.as_str()).unwrap_or("primary")
    )
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

        let (entries, _, _) = service
            .search_project_entries(
                project_root(temp.path()),
                &ProjectSearchQuery::new("search"),
                1,
                true,
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
}
