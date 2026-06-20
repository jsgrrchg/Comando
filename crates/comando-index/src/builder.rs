use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use comando_fs::ProjectRoot;
use comando_fs::path::normalize_relative_path;

use crate::entry::{IndexEntryKind, IndexedProjectEntry};
use crate::error::IndexResult;
use crate::policy::{IndexPolicy, IndexPolicyState};
use crate::stats::IndexBuildStats;

#[derive(Debug, Clone)]
pub struct IndexBuildOptions {
    pub policy: IndexPolicy,
}

impl Default for IndexBuildOptions {
    fn default() -> Self {
        Self {
            policy: IndexPolicy::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BuiltProjectIndex {
    pub entries: Vec<IndexedProjectEntry>,
    pub stats: IndexBuildStats,
}

#[derive(Debug, Clone)]
struct PendingEntry {
    absolute_path: PathBuf,
    kind: IndexEntryKind,
    name: String,
    policy_state: IndexPolicyState,
    relative_path: String,
}

pub fn build_project_index(
    root: &ProjectRoot,
    options: &IndexBuildOptions,
) -> IndexResult<BuiltProjectIndex> {
    let started = Instant::now();
    let mut queue = VecDeque::from([root.root_path.clone()]);
    let mut pending_entries = Vec::<PendingEntry>::new();
    let mut directory_children = HashMap::<String, bool>::new();
    let mut skipped_count = 0_usize;
    let mut truncated = false;

    while let Some(directory) = queue.pop_front() {
        let current_depth = depth_from_root(&root.root_path, &directory);
        let mut children =
            match read_directory_entries(&root.root_path, &directory, &options.policy) {
                Ok(children) => children,
                Err(error) => {
                    skipped_count += 1;
                    if error.kind() == std::io::ErrorKind::PermissionDenied {
                        continue;
                    }
                    continue;
                }
            };
        sort_pending_entries(&mut children);

        let current_relative_path = normalize_relative_path(
            directory
                .strip_prefix(&root.root_path)
                .unwrap_or_else(|_| Path::new("")),
        );
        if !current_relative_path.is_empty() {
            directory_children.insert(current_relative_path, !children.is_empty());
        }

        for child in children {
            if pending_entries.len() >= options.policy.max_entries {
                truncated = true;
                break;
            }

            let is_directory = child.kind == IndexEntryKind::Directory;
            if !options.policy.should_index_entry(&child.name, is_directory) {
                skipped_count += 1;
                continue;
            }

            if is_directory
                && options
                    .policy
                    .should_descend_directory(&child.name, current_depth)
            {
                queue.push_back(child.absolute_path.clone());
            }

            if child.kind == IndexEntryKind::Symlink
                && options.policy.should_follow_symlink(&child.absolute_path)
            {
                queue.push_back(child.absolute_path.clone());
            }

            pending_entries.push(child);
        }

        if truncated {
            break;
        }
    }

    let mut stats = IndexBuildStats {
        entry_count: pending_entries.len(),
        indexed_file_count: pending_entries
            .iter()
            .filter(|entry| !entry.kind.is_directory())
            .count(),
        indexed_directory_count: pending_entries
            .iter()
            .filter(|entry| entry.kind.is_directory())
            .count(),
        skipped_count,
        duration_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        truncated,
        reason: truncated.then(|| "max_entries".to_string()),
    };

    let entries = pending_entries
        .into_iter()
        .map(|entry| {
            let has_children = entry.kind.is_directory()
                && directory_children
                    .get(&entry.relative_path)
                    .copied()
                    .unwrap_or(false);
            IndexedProjectEntry::new(
                root.project_id.clone(),
                root.worktree_id.clone(),
                entry.name,
                entry.relative_path,
                entry.kind,
                has_children,
                entry.policy_state,
            )
        })
        .collect::<Vec<_>>();

    stats.entry_count = entries.len();
    Ok(BuiltProjectIndex { entries, stats })
}

fn read_directory_entries(
    root_path: &Path,
    directory: &Path,
    policy: &IndexPolicy,
) -> std::io::Result<Vec<PendingEntry>> {
    let mut entries = Vec::new();
    for entry_result in fs::read_dir(directory)? {
        let entry = entry_result?;
        let absolute_path = entry.path();
        let file_type = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().to_string();
        let relative_path = normalize_relative_path(
            absolute_path
                .strip_prefix(root_path)
                .unwrap_or_else(|_| Path::new("")),
        );
        let kind = if file_type.is_symlink() {
            IndexEntryKind::Symlink
        } else if file_type.is_dir() {
            IndexEntryKind::Directory
        } else if file_type.is_file() {
            IndexEntryKind::File
        } else {
            IndexEntryKind::Other
        };
        let policy_state = policy.state_for_entry(&name, kind.is_directory());

        entries.push(PendingEntry {
            absolute_path,
            kind,
            name,
            policy_state,
            relative_path,
        });
    }

    Ok(entries)
}

fn sort_pending_entries(entries: &mut [PendingEntry]) {
    entries.sort_by(
        |left, right| match (left.kind.is_directory(), right.kind.is_directory()) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        },
    );
}

fn depth_from_root(root_path: &Path, directory: &Path) -> usize {
    directory
        .strip_prefix(root_path)
        .ok()
        .map(|path| path.components().count())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::test_support::project_root;

    use super::*;

    #[test]
    fn builds_index_from_temp_project() {
        let temp = TempDir::new().expect("temp");
        fs::create_dir(temp.path().join("src")).expect("src");
        fs::write(temp.path().join("src/main.rs"), "fn main() {}\n").expect("file");
        fs::write(temp.path().join(".env"), "APP=1\n").expect("env");
        let root = project_root(temp.path());

        let index = build_project_index(&root, &IndexBuildOptions::default()).expect("index");
        let paths = index
            .entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&".env"));
        assert!(paths.contains(&"src"));
        assert!(paths.contains(&"src/main.rs"));
        assert_eq!(index.stats.indexed_file_count, 2);
        assert_eq!(index.stats.indexed_directory_count, 1);
    }

    #[test]
    fn excludes_noisy_dirs_from_path_index() {
        let temp = TempDir::new().expect("temp");
        fs::create_dir(temp.path().join("node_modules")).expect("node_modules");
        fs::write(temp.path().join("node_modules/pkg.js"), "pkg").expect("pkg");
        let root = project_root(temp.path());

        let index = build_project_index(&root, &IndexBuildOptions::default()).expect("index");

        assert!(
            !index
                .entries
                .iter()
                .any(|entry| entry.relative_path == "node_modules")
        );
        assert_eq!(index.stats.skipped_count, 1);
    }

    #[test]
    fn marks_truncated_large_projects() {
        let temp = TempDir::new().expect("temp");
        for index in 0..5 {
            fs::write(temp.path().join(format!("{index}.txt")), "file").expect("file");
        }
        let root = project_root(temp.path());

        let index = build_project_index(
            &root,
            &IndexBuildOptions {
                policy: IndexPolicy::default().with_max_entries(2),
            },
        )
        .expect("index");

        assert!(index.stats.truncated);
        assert_eq!(index.entries.len(), 2);
    }
}
