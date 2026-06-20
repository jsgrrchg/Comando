use std::collections::{HashMap, HashSet};

use crate::builder::{IndexBuildOptions, build_project_index};
use crate::entry::IndexedProjectEntry;
use crate::error::IndexResult;
use crate::policy::IndexPolicy;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexUpdateKind {
    Created,
    Updated,
    Deleted,
    Renamed,
    Invalidated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexUpdate {
    pub kind: IndexUpdateKind,
    pub relative_paths: Option<Vec<String>>,
}

impl IndexUpdate {
    pub fn invalidated() -> Self {
        Self {
            kind: IndexUpdateKind::Invalidated,
            relative_paths: None,
        }
    }

    pub fn paths(kind: IndexUpdateKind, relative_paths: Vec<String>) -> Self {
        Self {
            kind,
            relative_paths: Some(relative_paths),
        }
    }
}

pub fn should_rebuild_for_update(update: &IndexUpdate, policy: &IndexPolicy) -> bool {
    update.relative_paths.as_ref().is_none_or(|paths| {
        paths.is_empty()
            || policy.is_huge_burst(paths.len())
            || matches!(
                update.kind,
                IndexUpdateKind::Invalidated | IndexUpdateKind::Renamed
            )
    })
}

pub fn remove_paths(
    entries: &[IndexedProjectEntry],
    relative_paths: &[String],
) -> Vec<IndexedProjectEntry> {
    if relative_paths.is_empty() {
        return entries.to_vec();
    }

    entries
        .iter()
        .filter(|entry| {
            !relative_paths.iter().any(|path| {
                entry.relative_path == *path || entry.relative_path.starts_with(&format!("{path}/"))
            })
        })
        .cloned()
        .collect()
}

pub fn merge_rebuilt_entries(
    current_entries: &[IndexedProjectEntry],
    rebuilt_entries: Vec<IndexedProjectEntry>,
    touched_paths: &[String],
) -> Vec<IndexedProjectEntry> {
    let mut next_entries = remove_paths(current_entries, touched_paths);
    let mut existing_paths = next_entries
        .iter()
        .map(|entry| entry.relative_path.clone())
        .collect::<HashSet<_>>();

    for entry in rebuilt_entries {
        if existing_paths.insert(entry.relative_path.clone()) {
            next_entries.push(entry);
        }
    }

    next_entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    refresh_has_children(next_entries)
}

pub fn refresh_has_children(entries: Vec<IndexedProjectEntry>) -> Vec<IndexedProjectEntry> {
    let mut children_by_parent = HashMap::<String, bool>::new();
    for entry in &entries {
        if let Some(parent) = &entry.parent_relative_path {
            children_by_parent.insert(parent.clone(), true);
        }
    }

    entries
        .into_iter()
        .map(|mut entry| {
            if entry.kind.is_directory() {
                entry.has_children = children_by_parent
                    .get(&entry.relative_path)
                    .copied()
                    .unwrap_or(false);
            }
            entry
        })
        .collect()
}

pub fn rebuild_scope(
    root: &comando_fs::ProjectRoot,
    options: &IndexBuildOptions,
) -> IndexResult<Vec<IndexedProjectEntry>> {
    build_project_index(root, options).map(|built| built.entries)
}

#[cfg(test)]
mod tests {
    use comando_types::ids::ProjectId;

    use crate::entry::IndexEntryKind;
    use crate::policy::IndexPolicyState;

    use super::*;

    fn entry(path: &str, kind: IndexEntryKind) -> IndexedProjectEntry {
        let name = path.rsplit('/').next().unwrap_or(path);
        IndexedProjectEntry::new(
            ProjectId("project_1".to_string()),
            None,
            name.to_string(),
            path.to_string(),
            kind,
            false,
            IndexPolicyState::Indexed,
        )
    }

    #[test]
    fn removes_directory_subtrees() {
        let entries = vec![
            entry("src", IndexEntryKind::Directory),
            entry("src/main.rs", IndexEntryKind::File),
            entry("README.md", IndexEntryKind::File),
        ];

        let next = remove_paths(&entries, &["src".to_string()]);

        assert_eq!(
            next.iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["README.md"]
        );
    }

    #[test]
    fn huge_burst_requires_rebuild() {
        let policy = IndexPolicy::default();
        let update = IndexUpdate::paths(
            IndexUpdateKind::Updated,
            (0..300).map(|index| format!("{index}.txt")).collect(),
        );

        assert!(should_rebuild_for_update(&update, &policy));
    }
}
