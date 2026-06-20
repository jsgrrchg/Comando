use std::path::Path;

use comando_fs::path::parent_relative_path;
use comando_types::ids::{ProjectId, WorktreeId};
use comando_types::projects::NativeProjectTreeEntry;
use serde::{Deserialize, Serialize};

use crate::policy::IndexPolicyState;
use crate::query::compact_project_search_value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

impl IndexEntryKind {
    pub fn as_project_tree_kind(self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::File | Self::Symlink | Self::Other => "file",
        }
    }

    pub fn is_directory(self) -> bool {
        matches!(self, Self::Directory)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct IndexedProjectEntry {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub name: String,
    pub relative_path: String,
    pub parent_relative_path: Option<String>,
    pub kind: IndexEntryKind,
    pub extension: Option<String>,
    pub has_children: bool,
    pub policy_state: IndexPolicyState,
    pub lower_name: String,
    pub lower_path: String,
    pub compact_path: String,
    pub depth: usize,
}

impl IndexedProjectEntry {
    pub fn new(
        project_id: ProjectId,
        worktree_id: Option<WorktreeId>,
        name: String,
        relative_path: String,
        kind: IndexEntryKind,
        has_children: bool,
        policy_state: IndexPolicyState,
    ) -> Self {
        let extension = if kind.is_directory() {
            None
        } else {
            Path::new(&name)
                .extension()
                .and_then(|extension| extension.to_str())
                .map(str::to_string)
                .filter(|extension| !extension.is_empty())
        };

        Self {
            project_id,
            worktree_id,
            parent_relative_path: parent_relative_path(&relative_path),
            lower_name: name.to_lowercase(),
            lower_path: relative_path.to_lowercase(),
            compact_path: compact_project_search_value(&relative_path),
            depth: get_project_search_depth(&relative_path),
            extension,
            has_children,
            kind,
            name,
            policy_state,
            relative_path,
        }
    }

    pub fn to_project_tree_entry(&self) -> NativeProjectTreeEntry {
        NativeProjectTreeEntry {
            id: format!("{}:{}", self.project_id.0, self.relative_path),
            project_id: self.project_id.clone(),
            worktree_id: self.worktree_id.clone(),
            name: self.name.clone(),
            parent_relative_path: self.parent_relative_path.clone(),
            relative_path: self.relative_path.clone(),
            kind: self.kind.as_project_tree_kind().to_string(),
            extension: self.extension.clone(),
            has_children: self.has_children,
            is_git_ignored: false,
            git_status: None,
            absolute_path: None,
            visibility: None,
        }
    }
}

pub fn get_project_search_depth(relative_path: &str) -> usize {
    relative_path.split('/').count().saturating_sub(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculates_depth_like_typescript() {
        assert_eq!(get_project_search_depth(""), 0);
        assert_eq!(get_project_search_depth("src/index.ts"), 1);
        assert_eq!(get_project_search_depth("src/a/b/c.ts"), 3);
    }
}
