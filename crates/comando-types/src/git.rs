use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, RepositoryId, WorktreeId};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitRepositoryScope {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitStatusSummary {
    pub changed_count: u32,
    pub staged_count: u32,
    pub unstaged_count: u32,
    pub untracked_count: u32,
    pub conflicted_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitChangeEntry {
    pub path: String,
    pub previous_path: Option<String>,
    pub scope: String,
    pub kind: String,
    pub is_binary: bool,
    pub is_conflicted: bool,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub worktree_id: Option<WorktreeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitBranchSummary {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub is_detached: bool,
    pub upstream_name: Option<String>,
    pub commit_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitRemoteSummary {
    pub name: String,
    pub fetch_url: Option<String>,
    pub push_url: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitWorktreeSummary {
    pub id: WorktreeId,
    pub project_id: ProjectId,
    pub root_path: String,
    pub branch_name: Option<String>,
    pub commit_sha: Option<String>,
    pub is_primary: bool,
    pub is_current: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitDiffLine {
    pub id: String,
    #[serde(rename = "type")]
    pub line_type: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitDiffHunk {
    pub id: String,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub lines: Vec<NativeGitDiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitFileDiff {
    pub path: String,
    pub previous_path: Option<String>,
    pub kind: String,
    pub is_text: bool,
    pub is_too_large: bool,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub hunks: Vec<NativeGitDiffHunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitDiff {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub files: Vec<NativeGitFileDiff>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitCommitSummary {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author_name: String,
    pub authored_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitRepositorySnapshot {
    pub repository_id: RepositoryId,
    pub project_id: ProjectId,
    pub current_worktree_id: Option<WorktreeId>,
    pub repository_state: String,
    pub root_path: String,
    pub canonical_root_path: String,
    pub branch: Option<NativeGitBranchSummary>,
    pub remotes: Vec<NativeGitRemoteSummary>,
    pub changes: Vec<NativeGitChangeEntry>,
    pub status: NativeGitStatusSummary,
    pub worktrees: Vec<NativeGitWorktreeSummary>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitRepositoryInvalidation {
    pub occurred_at: String,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub root_path: Option<String>,
    pub reason: String,
}
