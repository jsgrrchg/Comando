use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, TerminalSessionId, WindowId, WorktreeId};

pub type NativeTerminalSessionId = TerminalSessionId;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeTerminalStatus {
    Running,
    Exited,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeTerminalCloseReason {
    User,
    ProcessExit,
    WindowClosed,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeTerminalPurpose {
    Workspace,
    Auth,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeTerminalLaunchedBy {
    User,
    Agent,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeTerminalWindowsShell {
    Default,
    Cmd,
    Powershell,
    Pwsh,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalShellPreference {
    pub windows_shell: NativeTerminalWindowsShell,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeTerminalLaunch {
    Shell,
    Command {
        program: String,
        args: Vec<String>,
        #[serde(default)]
        display_name: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalSession {
    pub session_id: NativeTerminalSessionId,
    pub window_id: WindowId,
    #[serde(default)]
    pub terminal_id: Option<String>,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub status: NativeTerminalStatus,
    pub exit_code: Option<i32>,
    pub signal_code: Option<String>,
    pub program: String,
    pub display_name: String,
    pub purpose: NativeTerminalPurpose,
    pub launched_by: NativeTerminalLaunchedBy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalCreateInput {
    pub window_id: WindowId,
    #[serde(default)]
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub preferred_session_id: Option<NativeTerminalSessionId>,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[serde(default)]
    pub extra_env: HashMap<String, String>,
    #[serde(default)]
    pub shell_preference: Option<NativeTerminalShellPreference>,
    pub purpose: NativeTerminalPurpose,
    pub launched_by: NativeTerminalLaunchedBy,
    pub launch: NativeTerminalLaunch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalWriteInput {
    pub window_id: WindowId,
    pub session_id: NativeTerminalSessionId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalResizeInput {
    pub window_id: WindowId,
    pub session_id: NativeTerminalSessionId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalKillInput {
    pub window_id: WindowId,
    pub session_id: NativeTerminalSessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalCloseInput {
    pub window_id: WindowId,
    pub id: String,
    pub reason: NativeTerminalCloseReason,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalCloseWindowInput {
    pub window_id: WindowId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalListInput {
    #[serde(default)]
    pub window_id: Option<WindowId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalListResult {
    pub sessions: Vec<NativeTerminalSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalCreatedEvent {
    pub session: NativeTerminalSession,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalDataEvent {
    pub window_id: WindowId,
    pub session_id: NativeTerminalSessionId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalExitEvent {
    pub window_id: WindowId,
    pub session_id: NativeTerminalSessionId,
    pub exit_code: Option<i32>,
    pub signal_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalClosedEvent {
    pub window_id: WindowId,
    pub session_id: NativeTerminalSessionId,
    pub terminal_id: Option<String>,
    pub reason: NativeTerminalCloseReason,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalErrorEvent {
    pub window_id: WindowId,
    pub session_id: Option<NativeTerminalSessionId>,
    pub terminal_id: Option<String>,
    pub message: String,
    pub retryable: bool,
}
