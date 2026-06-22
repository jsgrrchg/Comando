use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, RepositoryId, WorktreeId};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitRepositoryScope {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub root_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitCloneRepositoryInput {
    pub parent_directory: String,
    pub repository_url: String,
    pub target_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitRepositoryResolution {
    pub input_path: String,
    pub canonical_root_path: Option<String>,
    pub git_dir_path: Option<String>,
    pub is_bare: bool,
    pub is_work_tree: bool,
    pub message: Option<String>,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitSyncStatus {
    pub ahead: i64,
    pub behind: i64,
    pub branch_name: Option<String>,
    pub commit: Option<String>,
    pub detached: bool,
    pub tracking_branch_name: Option<String>,
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
    pub id: String,
    pub path: String,
    pub name: String,
    pub parent_relative_path: Option<String>,
    pub previous_path: Option<String>,
    pub scopes: Vec<String>,
    pub scope: String,
    pub kind: String,
    pub status_index: String,
    pub status_working_dir: String,
    pub is_binary: bool,
    pub is_conflicted: bool,
    pub is_renamed: bool,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub worktree_id: Option<WorktreeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitChangeTreeNode {
    pub id: String,
    pub change_entry_id: Option<String>,
    pub children: Vec<NativeGitChangeTreeNode>,
    pub counts: NativeGitScopeCounts,
    pub kind: String,
    pub name: String,
    pub parent_relative_path: Option<String>,
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitScopeCounts {
    pub conflicted: u32,
    pub staged: u32,
    pub untracked: u32,
    pub unstaged: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitStatusSnapshot {
    pub counts: NativeGitScopeCounts,
    pub entries: Vec<NativeGitChangeEntry>,
    pub has_conflicts: bool,
    pub has_staged: bool,
    pub has_unstaged: bool,
    pub has_untracked: bool,
    pub is_clean: bool,
    pub summary: NativeGitStatusSummary,
    pub sync: Option<NativeGitSyncStatus>,
    pub tree: Vec<NativeGitChangeTreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitBranchSummary {
    pub name: String,
    pub label: Option<String>,
    pub is_current: bool,
    pub is_remote: bool,
    pub is_detached: bool,
    pub linked_work_tree: bool,
    pub upstream_name: Option<String>,
    pub commit_sha: Option<String>,
    pub ahead_by: i64,
    pub behind_by: i64,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitRemoteSummary {
    pub name: String,
    pub fetch_url: Option<String>,
    pub push_url: Option<String>,
    pub is_default: bool,
    pub ref_name: Option<String>,
    pub ahead_by: i64,
    pub behind_by: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitWorktreeSummary {
    pub id: WorktreeId,
    pub project_id: ProjectId,
    pub root_path: String,
    pub canonical_path: String,
    pub branch_name: Option<String>,
    pub branch_ref: Option<String>,
    pub commit_sha: Option<String>,
    pub detached: bool,
    pub is_primary: bool,
    pub is_current: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitDiffStatRecord {
    pub additions: i64,
    pub deletions: i64,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitDiffLine {
    pub id: String,
    #[serde(rename = "type")]
    pub line_type: String,
    pub text: String,
    pub old_line_number: Option<u32>,
    pub new_line_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitDiffHunk {
    pub id: String,
    pub header: String,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub lines: Vec<NativeGitDiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitFileDiffSummary {
    pub insertions: i64,
    pub deletions: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitFileDiff {
    pub path: String,
    pub previous_path: Option<String>,
    pub kind: String,
    pub staged: bool,
    pub is_binary: bool,
    pub is_text: bool,
    pub is_too_large: bool,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub raw: String,
    pub summary: NativeGitFileDiffSummary,
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
pub struct NativeGitOriginalFile {
    pub base_text: Option<String>,
    pub is_text: bool,
    pub kind: String,
    pub path: String,
    pub previous_path: Option<String>,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitCommitReference {
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitCommitSummary {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub parent_shas: Vec<String>,
    pub refs: Vec<NativeGitCommitReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitHistoryListResult {
    pub commits: Vec<NativeGitCommitSummary>,
    pub matched_count: u32,
    pub total_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitCommitDiffFile {
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub hunks: Vec<NativeGitDiffHunk>,
    pub is_text: bool,
    pub kind: String,
    pub new_text: Option<String>,
    pub old_text: Option<String>,
    pub path: String,
    pub previous_path: Option<String>,
    pub reversible: bool,
    pub status_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitCommitDetail {
    #[serde(flatten)]
    pub summary: NativeGitCommitSummary,
    pub changed_file_count: u32,
    pub committed_at: String,
    pub committer_email: String,
    pub committer_name: String,
    pub deletions: i64,
    pub files: Vec<NativeGitCommitDiffFile>,
    pub insertions: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitWorktreeDiffFile {
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub diff: Option<NativeGitFileDiff>,
    pub error: Option<String>,
    pub is_binary: bool,
    pub is_conflicted: bool,
    pub kind: String,
    pub path: String,
    pub previous_path: Option<String>,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitWorktreeDiffSection {
    pub scope: String,
    pub files: Vec<NativeGitWorktreeDiffFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitWorktreeDiffResult {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub sections: Vec<NativeGitWorktreeDiffSection>,
    pub updated_at: String,
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
    pub resolution: NativeGitRepositoryResolution,
    pub branch: Option<NativeGitBranchSummary>,
    pub branches: Vec<NativeGitBranchSummary>,
    pub remotes: Vec<NativeGitRemoteSummary>,
    pub changes: Vec<NativeGitChangeEntry>,
    pub status: NativeGitStatusSnapshot,
    pub worktrees: Vec<NativeGitWorktreeSummary>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitOperationResult {
    pub ok: bool,
    pub message: Option<String>,
    pub commit_sha: Option<String>,
    pub snapshot: Option<NativeGitRepositorySnapshot>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitPathInput {
    pub scope: NativeGitRepositoryScope,
    pub path: String,
    pub previous_path: Option<String>,
    pub change_kind: Option<String>,
    pub diff_scope: Option<String>,
    pub staged: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitHistoryInput {
    pub scope: NativeGitRepositoryScope,
    pub case_sensitive: Option<bool>,
    pub limit: Option<u32>,
    pub query: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitCommitDetailInput {
    pub scope: NativeGitRepositoryScope,
    pub commit_sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitPathsInput {
    pub scope: NativeGitRepositoryScope,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitCommitInput {
    pub scope: NativeGitRepositoryScope,
    pub message: String,
    pub amend: Option<bool>,
    pub no_verify: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitCheckoutBranchInput {
    pub scope: NativeGitRepositoryScope,
    pub branch_name: String,
    pub force: Option<bool>,
    pub new_branch_name: Option<String>,
    pub start_point: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitWorktreeMutationInput {
    pub scope: NativeGitRepositoryScope,
    pub branch_name: Option<String>,
    pub force: Option<bool>,
    pub path: String,
    pub start_point: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitDeleteLocalBranchInput {
    pub scope: NativeGitRepositoryScope,
    pub branch_name: String,
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitDeleteRemoteBranchInput {
    pub scope: NativeGitRepositoryScope,
    pub remote_name: String,
    pub remote_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitFetchInput {
    pub scope: NativeGitRepositoryScope,
    pub all: Option<bool>,
    pub prune: Option<bool>,
    pub remote_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitPullInput {
    pub scope: NativeGitRepositoryScope,
    pub rebase: Option<bool>,
    pub remote_name: Option<String>,
    pub remote_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGitPushInput {
    pub scope: NativeGitRepositoryScope,
    pub force: Option<bool>,
    pub force_with_lease: Option<bool>,
    pub remote_name: Option<String>,
    pub remote_ref: Option<String>,
    pub set_upstream: Option<bool>,
}
