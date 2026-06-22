use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ids::{
    MessageId, ProjectId, RuntimeId, RuntimeSessionId, SessionId, TerminalSessionId, ToolCallId,
    WindowId, WorktreeId,
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
#[serde(rename_all = "kebab-case")]
pub enum NativeAiCredentialSource {
    ComandoSecret,
    Environment,
    ExternalRuntime,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiRuntimeStatus {
    pub runtime_id: NativeAiRuntimeId,
    pub state: String,
    pub auth_method: Option<String>,
    pub auth_methods: Vec<NativeAiAuthMethod>,
    pub auth_ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_credential_source: Option<NativeAiCredentialSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_credential_source_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_session_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_storage_message: Option<String>,
    #[serde(default)]
    pub can_disconnect_auth: bool,
    #[serde(default)]
    pub can_logout_auth: bool,
    pub checked_at: String,
    pub command: Option<String>,
    #[serde(default)]
    pub available_commands: Vec<serde_json::Value>,
    #[serde(default)]
    pub config_options: Vec<serde_json::Value>,
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub modes: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default)]
    pub models: Vec<serde_json::Value>,
    pub onboarding_required: bool,
    pub source: Option<String>,
    pub has_custom_binary_path: bool,
    pub has_gateway_config: bool,
    pub has_gateway_url: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiGetRuntimeStatusInput {
    pub runtime_id: NativeAiRuntimeId,
    pub launch: Option<NativeAiLaunchSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSecretStorageStatus {
    pub backend: String,
    pub available: bool,
    pub weak: bool,
    pub message: Option<String>,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSecretSetInput {
    pub runtime_id: NativeAiRuntimeId,
    pub env_key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSecretDeleteInput {
    pub runtime_id: NativeAiRuntimeId,
    pub env_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSecretMutationOutput {
    pub runtime_id: NativeAiRuntimeId,
    pub env_key: String,
    pub present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeSecretPatchAction {
    Delete,
    Set,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSecretPatch {
    pub env_key: String,
    pub action: NativeSecretPatchAction,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiRuntimeSettingsPatch {
    #[serde(default)]
    pub binary_path: Option<String>,
    #[serde(default)]
    pub auth_method: Option<String>,
    #[serde(default)]
    pub auth_invalidated_at_ms: Option<u64>,
    #[serde(default)]
    pub gateway_base_url: Option<String>,
    #[serde(default)]
    pub bedrock_gateway_base_url: Option<String>,
    #[serde(default)]
    pub non_secret_env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSaveRuntimeSettingsInput {
    pub runtime_id: NativeAiRuntimeId,
    pub settings: NativeAiRuntimeSettingsPatch,
    #[serde(default)]
    pub secret_patches: Vec<NativeAiSecretPatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiRuntimeStatusOutput {
    pub status: NativeAiRuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiLaunchRuntimeAuthInput {
    pub runtime_id: NativeAiRuntimeId,
    pub method_id: String,
    pub window_id: WindowId,
    #[serde(default)]
    pub project_id: Option<ProjectId>,
    #[serde(default)]
    pub worktree_id: Option<WorktreeId>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiLaunchRuntimeAuthOutput {
    pub runtime_id: NativeAiRuntimeId,
    pub method_id: String,
    pub terminal_session_id: Option<TerminalSessionId>,
    pub status: NativeAiRuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiRuntimeAuthInput {
    pub runtime_id: NativeAiRuntimeId,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiAuthHandshakeSpec {
    pub env_method_id: String,
    pub external_method_id: String,
    #[serde(default)]
    pub meta: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiDesiredSelections {
    pub model_id: Option<String>,
    pub mode_id: Option<String>,
    #[serde(default)]
    pub config_options: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiLaunchSpec {
    pub runtime_id: RuntimeId,
    pub owner_window_id: String,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub project_root: Option<String>,
    #[serde(default)]
    pub additional_roots: Vec<String>,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub command: String,
    pub status: NativeAiRuntimeStatus,
    pub auth_method: Option<String>,
    pub auth_credential_source: Option<String>,
    pub auth_handshake: Option<NativeAiAuthHandshakeSpec>,
    pub persisted_runtime_session_id: Option<RuntimeSessionId>,
    #[serde(default)]
    pub persisted_subagent_session_mappings: Vec<NativeAiRuntimeSessionMapping>,
    pub desired_selections: NativeAiDesiredSelections,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiRuntimeSessionMapping {
    pub app_session_id: SessionId,
    pub parent_app_session_id: Option<SessionId>,
    pub parent_runtime_session_id: Option<RuntimeSessionId>,
    pub runtime_session_id: RuntimeSessionId,
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
    #[serde(default)]
    pub persisted_runtime_session_id: Option<RuntimeSessionId>,
    #[serde(default)]
    pub persisted_subagent_session_mappings: Vec<NativeAiRuntimeSessionMapping>,
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
    #[serde(default)]
    pub target_session_id: Option<SessionId>,
    #[serde(default)]
    pub runtime_session_id: Option<RuntimeSessionId>,
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
    #[serde(default)]
    pub target_session_id: Option<SessionId>,
    #[serde(default)]
    pub runtime_session_id: Option<RuntimeSessionId>,
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
    #[serde(default)]
    pub target_session_id: Option<SessionId>,
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
    #[serde(default)]
    pub target_session_id: Option<SessionId>,
    pub request_id: String,
    pub answers: Vec<NativeAiUserInputAnswer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSetSessionModeInput {
    pub session_id: SessionId,
    #[serde(default)]
    pub runtime_session_id: Option<RuntimeSessionId>,
    pub mode_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSetSessionModelInput {
    pub session_id: SessionId,
    #[serde(default)]
    pub runtime_session_id: Option<RuntimeSessionId>,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSetSessionConfigOptionInput {
    pub session_id: SessionId,
    #[serde(default)]
    pub runtime_session_id: Option<RuntimeSessionId>,
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
pub struct NativeAiListSessionHistoryInput {
    pub project_id: Option<ProjectId>,
    #[serde(default)]
    pub worktree_id: Option<WorktreeId>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiHistorySessionSummary {
    pub session_id: SessionId,
    pub parent_session_id: Option<SessionId>,
    pub runtime_id: RuntimeId,
    pub runtime_session_id: Option<RuntimeSessionId>,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub title: String,
    pub preview: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub pinned_at: Option<String>,
    pub message_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiLoadSessionTranscriptPageInput {
    pub session_id: SessionId,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSessionTranscriptPage {
    pub session_id: SessionId,
    pub offset: usize,
    pub total_messages: usize,
    #[serde(default)]
    pub messages: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiLoadSessionSnapshotInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiListSessionRuntimeMappingsInput {
    pub parent_session_id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSessionSnapshot {
    pub session_id: SessionId,
    pub parent_session_id: Option<SessionId>,
    pub runtime_id: RuntimeId,
    pub runtime_session_id: Option<RuntimeSessionId>,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub title: String,
    pub status: NativeAiSessionStatus,
    pub updated_at: String,
    pub active_turn_started_at: Option<String>,
    pub closed_at: Option<String>,
    pub last_error: Option<String>,
    pub mode_id: Option<String>,
    pub model_id: Option<String>,
    pub pending_permission: Option<serde_json::Value>,
    pub pending_user_input: Option<serde_json::Value>,
    pub plan: Option<serde_json::Value>,
    pub token_usage: Option<serde_json::Value>,
    #[serde(default)]
    pub available_commands: Vec<serde_json::Value>,
    #[serde(default)]
    pub config_options: Vec<serde_json::Value>,
    #[serde(default)]
    pub messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub modes: Vec<serde_json::Value>,
    #[serde(default)]
    pub models: Vec<serde_json::Value>,
    #[serde(default)]
    pub tool_activity: Vec<serde_json::Value>,
    #[serde(default)]
    pub tracked_files: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSetSessionPinnedInput {
    pub session_id: SessionId,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiDeleteSessionInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiRenameSessionInput {
    pub session_id: SessionId,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiMigrateSessionHistoryInput {
    #[serde(default)]
    pub source_database_path: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiHistoryMigrationError {
    pub session_id: Option<SessionId>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiMigrateSessionHistoryOutput {
    pub started_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub migrated_sessions: usize,
    pub skipped_sessions: usize,
    pub failed_sessions: usize,
    #[serde(default)]
    pub errors: Vec<NativeAiHistoryMigrationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiHistoryStorageHealth {
    pub healthy: bool,
    pub storage_version: u32,
    pub native_session_count: usize,
    pub legacy_fallback_available: bool,
    pub migration_manifest_exists: bool,
    pub orphaned_session_dirs: usize,
    pub latest_error: Option<String>,
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
pub struct NativeAiSubagentCreatedPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub child_session_id: SessionId,
    pub child_runtime_session_id: RuntimeSessionId,
    pub parent_session_id: SessionId,
    pub parent_runtime_session_id: Option<RuntimeSessionId>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSubagentBreadcrumbPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    pub child_session_id: SessionId,
    pub child_runtime_session_id: RuntimeSessionId,
    pub tool_call_id: ToolCallId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSessionCatalogUpdatedPayload {
    #[serde(flatten)]
    pub base: NativeAiEventBase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_commands: Option<Vec<NativeAiAvailableCommandPayload>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<NativeAiSessionConfigOptionPayload>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiAvailableCommandPayload {
    pub description: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSessionConfigOptionPayload {
    pub category: Option<String>,
    pub description: Option<String>,
    pub id: String,
    pub name: String,
    pub current_value: serde_json::Value,
    pub options: Option<Vec<NativeAiSessionConfigSelectEntryPayload>>,
    #[serde(rename = "type")]
    pub option_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAiSessionConfigSelectEntryPayload {
    pub description: Option<String>,
    pub group_label: Option<String>,
    pub name: String,
    pub value: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diffs: Vec<serde_json::Value>,
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
