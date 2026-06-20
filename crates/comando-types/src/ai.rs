use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ids::{
    MessageId, ProjectId, RuntimeId, RuntimeSessionId, SessionId, ToolCallId, WorktreeId,
};

pub type NativeAiRuntimeId = RuntimeId;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeAiRuntimeSupportState {
    NativeReady,
    NativeUnavailable,
    LegacyOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiRuntimeCapabilities {
    pub streaming: bool,
    pub thinking: bool,
    pub tools: bool,
    pub plan_updates: bool,
    pub permissions: bool,
    pub user_input: bool,
    pub subagents: bool,
    pub resume_session: bool,
    pub load_session: bool,
    pub auth_terminal: bool,
    pub image_input: bool,
    pub embedded_context: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiRuntimeDescriptor {
    pub runtime_id: NativeAiRuntimeId,
    pub display_name: String,
    pub default_executable: String,
    pub acp_args: Vec<String>,
    pub native_ready: bool,
    pub legacy_ready: bool,
    pub support_state: NativeAiRuntimeSupportState,
    pub message: Option<String>,
    pub capabilities: NativeAiRuntimeCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiListRuntimesOutput {
    pub runtimes: Vec<NativeAiRuntimeDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeAiSessionStatus {
    Idle,
    Streaming,
    WaitingPermission,
    WaitingUserInput,
    ReviewRequired,
    Error,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiAuthMethod {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiRuntimeStatus {
    pub runtime_id: NativeAiRuntimeId,
    pub state: String,
    pub auth_method: Option<String>,
    pub auth_methods: Vec<NativeAiAuthMethod>,
    pub auth_ready: bool,
    pub checked_at: String,
    pub command: Option<String>,
    pub message: Option<String>,
    pub onboarding_required: bool,
    pub source: Option<String>,
    pub has_custom_binary_path: bool,
    pub has_gateway_config: bool,
    pub has_gateway_url: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiGetRuntimeStatusInput {
    pub runtime_id: NativeAiRuntimeId,
    pub launch: Option<NativeAiLaunchSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiLaunchSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub command: String,
    pub status: NativeAiRuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiPrepareSessionInput {
    pub window_id: String,
    pub session_id: SessionId,
    pub runtime_id: RuntimeId,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub cwd: String,
    pub title: String,
    pub model_id: Option<String>,
    pub mode_id: Option<String>,
    #[serde(default)]
    pub config_options: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub additional_roots: Vec<String>,
    pub launch: Option<NativeAiLaunchSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiPromptInput {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSendPromptInput {
    pub session_id: SessionId,
    pub message_id: MessageId,
    pub prompt: NativeAiPromptInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSendPromptOutput {
    pub accepted: bool,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSessionIdInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiCancelSessionOutput {
    pub cancelled: bool,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiCloseSessionOutput {
    pub closed: bool,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiPermissionResponseInput {
    pub session_id: SessionId,
    pub request_id: String,
    pub option_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiUserInputAnswer {
    pub question_id: String,
    pub answers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiUserInputResponseInput {
    pub session_id: SessionId,
    pub request_id: String,
    pub answers: Vec<NativeAiUserInputAnswer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSetSessionModeInput {
    pub session_id: SessionId,
    pub mode_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSetSessionModelInput {
    pub session_id: SessionId,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSetSessionConfigOptionInput {
    pub session_id: SessionId,
    pub option_id: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiModelOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiModeOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiConfigOption {
    pub id: String,
    pub label: String,
    pub category: String,
    #[serde(rename = "type")]
    pub option_type: String,
    pub value: serde_json::Value,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSessionSummary {
    pub session_id: SessionId,
    pub runtime_id: RuntimeId,
    pub runtime_session_id: Option<RuntimeSessionId>,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub title: String,
    pub status: NativeAiSessionStatus,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiEventBase {
    pub session_id: SessionId,
    pub runtime_id: RuntimeId,
    pub runtime_session_id: Option<RuntimeSessionId>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSessionCreatedPayload {
    #[serde(flatten)]
    pub session: NativeAiSessionSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSessionUpdatedPayload {
    pub session_id: SessionId,
    pub runtime_id: RuntimeId,
    pub runtime_session_id: Option<RuntimeSessionId>,
    pub status: NativeAiSessionStatus,
    pub title: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSessionClosedPayload {
    pub session_id: SessionId,
    pub runtime_id: RuntimeId,
    pub runtime_session_id: Option<RuntimeSessionId>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiRuntimeConnectionPayload {
    pub runtime_id: RuntimeId,
    pub status: String,
    pub message: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiStatusEventPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub event_id: String,
    pub status: String,
    pub title: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiMessageStartedPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub message_id: MessageId,
    pub message_kind: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiMessageDeltaPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub message_id: MessageId,
    pub message_kind: String,
    pub delta: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiMessageCompletedPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub message_id: MessageId,
    pub message_kind: String,
}

pub type NativeAiThinkingDeltaPayload = NativeAiMessageDeltaPayload;

pub type NativeAiThinkingStartedPayload = NativeAiMessageStartedPayload;

pub type NativeAiThinkingCompletedPayload = NativeAiMessageCompletedPayload;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiToolActivityPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub tool_call_id: ToolCallId,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiPlanEntryPayload {
    pub content: String,
    pub priority: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiPlanUpdatedPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub title: Option<String>,
    pub entries: Vec<NativeAiPlanEntryPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiPermissionRequestPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub request_id: String,
    pub tool_call_id: ToolCallId,
    pub title: String,
    pub description: Option<String>,
    pub options: Vec<NativeAiPermissionOptionPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiPermissionOptionPayload {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiUserInputRequestPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub request_id: String,
    pub title: String,
    pub tool_call_id: ToolCallId,
    pub turn_id: Option<String>,
    pub questions: Vec<NativeAiUserInputQuestionPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiUserInputQuestionPayload {
    pub id: String,
    pub header: String,
    pub question: String,
    pub is_other: bool,
    pub is_secret: bool,
    pub options: Vec<NativeAiUserInputQuestionOptionPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiUserInputQuestionOptionPayload {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiTokenUsagePayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub used: u64,
    pub size: u64,
    pub cost: Option<NativeAiTokenUsageCost>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiTokenUsageCost {
    pub amount: f64,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiTrackedFileSummary {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiErrorPayload {
    pub session_id: Option<SessionId>,
    pub runtime_id: Option<RuntimeId>,
    pub message: String,
    pub recoverable: bool,
    pub updated_at: String,
}
