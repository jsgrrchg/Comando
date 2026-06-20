use serde::{Deserialize, Serialize};

use crate::ids::{
    MessageId, ProjectId, RuntimeId, RuntimeSessionId, SessionId, ToolCallId, WorktreeId,
};

pub type NativeAiRuntimeId = RuntimeId;

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
    pub status: NativeAiSessionStatus,
    pub title: Option<String>,
    pub updated_at: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiUserInputRequestPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub request_id: String,
    pub title: String,
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
