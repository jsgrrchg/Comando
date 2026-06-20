use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, SessionId, ToolCallId, WorktreeId};

pub use crate::git::{NativeGitDiffHunk as NativeDiffHunk, NativeGitDiffLine as NativeDiffLine};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeTrackedFileStatus {
    Pending,
    Kept,
    Rejected,
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTrackedFile {
    pub session_id: SessionId,
    pub tool_call_id: Option<ToolCallId>,
    pub path: String,
    pub previous_path: Option<String>,
    pub status: NativeTrackedFileStatus,
    pub is_text: bool,
    pub is_too_large: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeReviewDecision {
    Keep,
    Reject,
    KeepHunks,
    RejectHunks,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewState {
    pub session_id: SessionId,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub tracked_files: Vec<NativeTrackedFile>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAgentSpan {
    pub session_id: SessionId,
    pub tool_call_id: Option<ToolCallId>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeInlineAnchor {
    pub path: String,
    pub line: u32,
    pub column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewConflict {
    pub path: String,
    pub reason: String,
    pub external_change_hash: Option<String>,
}
