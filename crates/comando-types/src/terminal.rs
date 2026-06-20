use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, TerminalSessionId, WindowId, WorktreeId};

pub type NativeTerminalSessionId = TerminalSessionId;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeTerminalCloseReason {
    User,
    ProcessExit,
    WindowClosed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalSession {
    pub session_id: NativeTerminalSessionId,
    pub window_id: WindowId,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub status: String,
    pub exit_code: Option<i32>,
    pub signal_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalCreateInput {
    pub window_id: WindowId,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalWriteInput {
    pub session_id: NativeTerminalSessionId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalResizeInput {
    pub session_id: NativeTerminalSessionId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalDataEvent {
    pub session_id: NativeTerminalSessionId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalExitEvent {
    pub session_id: NativeTerminalSessionId,
    pub exit_code: Option<i32>,
    pub signal_code: Option<String>,
}
