use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc as std_mpsc};

use agent_client_protocol::schema::{
    AuthenticateRequest, AvailableCommand, AvailableCommandsUpdate, CancelNotification,
    ClientCapabilities, ConfigOptionUpdate, ContentBlock, ContentChunk, CreateElicitationRequest,
    CreateElicitationResponse, ElicitationAcceptAction, ElicitationAction, ElicitationCapabilities,
    ElicitationContentValue, ElicitationFormCapabilities, ElicitationMode,
    ElicitationPropertySchema, ImageContent, InitializeRequest, InitializeResponse,
    LoadSessionRequest, LogoutRequest, Meta, MultiSelectItems, NewSessionRequest, PermissionOption,
    PromptCapabilities, PromptRequest, ProtocolVersion, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, ResumeSessionRequest,
    SelectedPermissionOutcome, SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigOptionValue, SessionConfigSelectOptions, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, StopReason, TextContent, ToolCall, ToolCallContent,
    ToolCallStatus, ToolCallUpdate, ToolKind,
};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo};
use comando_types::ai::{
    NativeAiAvailableCommandPayload, NativeAiErrorPayload, NativeAiGeneratedImage,
    NativeAiImageAttachment, NativeAiImageGenerationPayload, NativeAiImageMessage,
    NativeAiLaunchSpec, NativeAiPermissionOptionPayload, NativeAiPermissionRequestPayload,
    NativeAiPermissionResponseInput, NativeAiPlanEntryPayload, NativeAiPlanUpdatedPayload,
    NativeAiRuntimeConnectionPayload, NativeAiRuntimeSessionMapping,
    NativeAiSessionCatalogUpdatedPayload, NativeAiSessionConfigOptionPayload,
    NativeAiSessionConfigSelectEntryPayload, NativeAiSessionStatus, NativeAiSessionSummary,
    NativeAiSubagentBreadcrumbPayload, NativeAiSubagentCreatedPayload, NativeAiTokenUsageCost,
    NativeAiTokenUsagePayload, NativeAiToolActivityPayload, NativeAiUserInputQuestionOptionPayload,
    NativeAiUserInputQuestionPayload, NativeAiUserInputRequestPayload,
    NativeAiUserInputResponseInput,
};
use comando_types::ids::{
    MessageId, RuntimeId, RuntimeSessionId, SessionId, ToolCallId as NativeToolCallId,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::runtime::Runtime;
use tokio::sync::{mpsc as tokio_mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::error::{AiError, AiResult};
use crate::events::{
    AI_ERROR_EVENT, AI_IMAGE_GENERATION_EVENT, AI_MESSAGE_COMPLETED_EVENT, AI_MESSAGE_DELTA_EVENT,
    AI_MESSAGE_STARTED_EVENT, AI_PERMISSION_REQUEST_EVENT, AI_PLAN_UPDATED_EVENT,
    AI_RUNTIME_CONNECTION_EVENT, AI_SESSION_CATALOG_UPDATED_EVENT, AI_SESSION_CLOSED_EVENT,
    AI_SESSION_UPDATED_EVENT, AI_SUBAGENT_BREADCRUMB_EVENT, AI_SUBAGENT_CREATED_EVENT,
    AI_THINKING_COMPLETED_EVENT, AI_THINKING_DELTA_EVENT, AI_THINKING_STARTED_EVENT,
    AI_TOKEN_USAGE_EVENT, AI_TOOL_ACTIVITY_EVENT, AI_USER_INPUT_REQUEST_EVENT, AiRuntimeEvent,
    message_completed, message_delta, message_started, now_iso8601, session_closed,
    session_updated,
};
use crate::redaction::redact_env_key_value;
use crate::runtime::{AcpProtocolFlavor, RuntimeDefinition};
use crate::session::{NativeAiSession, SessionRegistry};

const CODEX_ACP_DIFF_HUNKS_KEY: &str = "codexAcpHunks";
const CODEX_ACP_DIFF_PREVIOUS_PATH_KEY: &str = "codexAcpPreviousPath";

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
const CODEX_ACP_STATUS_EVENT_TYPE_KEY: &str = "codexAcpEventType";
const CODEX_ACP_TURN_EVENT_TYPE_KEY: &str = "codexAcpTurnEventType";
const CODEX_ACP_TURN_ID_KEY: &str = "codexAcpTurnId";
const CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE: &str = "turn_lifecycle";
const CODEX_ACP_TURN_STARTED_EVENT_TYPE: &str = "turn_started";
const CODEX_ACP_TURN_COMPLETE_EVENT_TYPE: &str = "turn_complete";
const CODEX_ACP_TURN_ABORTED_EVENT_TYPE: &str = "turn_aborted";
const CODEX_ACP_SHUTDOWN_COMPLETE_EVENT_TYPE: &str = "shutdown_complete";
const CODEX_ACP_IMAGE_GENERATION_EVENT_TYPE: &str = "image_generation";
const CODEX_ACP_IMAGE_GENERATION_EVENT_ID_PREFIX: &str = "codex-acp:image:";
const CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE: &str = "subagent_session_created";
const CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE: &str = "subagent_breadcrumb";
const CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY: &str = "codexAcpSubagentEventType";
const CODEX_ACP_PARENT_SESSION_ID_KEY: &str = "codexAcpParentSessionId";
const CODEX_ACP_CHILD_SESSION_ID_KEY: &str = "codexAcpChildSessionId";
const CODEX_ACP_AGENT_NICKNAME_KEY: &str = "codexAcpAgentNickname";
const CODEX_ACP_AGENT_STATUS_KEY: &str = "codexAcpAgentStatus";
const CODEX_ACP_AGENT_STATUSES_KEY: &str = "codexAcpAgentStatuses";
const CODEX_ACP_MODEL_KEY: &str = "codexAcpModel";
const CODEX_ACP_REASONING_EFFORT_KEY: &str = "codexAcpReasoningEffort";
const ACP_TERMINAL_OUTPUT_META_KEY: &str = "terminal_output";
const ACP_TERMINAL_EXIT_META_KEY: &str = "terminal_exit";
const ACP_TERMINAL_ID_META_KEY: &str = "terminal_id";
const ACP_TERMINAL_OUTPUT_DATA_META_KEY: &str = "data";
const ACP_TERMINAL_OUTPUT_MODE_META_KEY: &str = "mode";
const ACP_TERMINAL_EXIT_CODE_META_KEY: &str = "exit_code";
const TERMINAL_OUTPUT_MAX_LENGTH: usize = 10_000;

type PermissionWaiterMap = Arc<Mutex<HashMap<String, PendingPermissionRequest>>>;
type PromptCapabilitiesState = Arc<Mutex<AcpPromptCapabilities>>;
type UserInputWaiterMap = Arc<Mutex<HashMap<String, PendingUserInputRequest>>>;

#[derive(Debug)]
struct PendingPermissionRequest {
    runtime_session_id: RuntimeSessionId,
    sender: oneshot::Sender<RequestPermissionOutcome>,
    target_session_id: SessionId,
}

#[derive(Debug)]
struct PendingUserInputRequest {
    runtime_session_id: Option<RuntimeSessionId>,
    schema: BTreeMap<String, ElicitationAnswerKind>,
    sender: oneshot::Sender<CreateElicitationResponse>,
    target_session_id: SessionId,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct AcpPromptCapabilities {
    image: bool,
}

impl From<&PromptCapabilities> for AcpPromptCapabilities {
    fn from(value: &PromptCapabilities) -> Self {
        Self { image: value.image }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ElicitationAnswerKind {
    Array,
    Boolean,
    Integer,
    Number,
    String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PersistedSessionStartMethod {
    Load,
    Resume,
}

#[derive(Debug, Clone)]
pub enum NativeAiConfigValue {
    Boolean(bool),
    ValueId(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct AcpProcessSpec {
    pub runtime_id: String,
    pub command: String,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub protocol_flavor: AcpProtocolFlavor,
    pub auth_method: Option<String>,
    pub auth_credential_source: Option<String>,
    pub auth_handshake: Option<comando_types::ai::NativeAiAuthHandshakeSpec>,
    pub persisted_runtime_session_id: Option<RuntimeSessionId>,
    pub persisted_subagent_session_mappings: Vec<NativeAiRuntimeSessionMapping>,
    pub supports_resume_session: bool,
    pub supports_subagents: bool,
}

impl AcpProcessSpec {
    pub fn from_launch(
        definition: RuntimeDefinition,
        launch: &NativeAiLaunchSpec,
    ) -> AiResult<Self> {
        validate_launch_context(definition, launch)?;
        Ok(Self {
            runtime_id: launch.runtime_id.0.clone(),
            command: launch.command.clone(),
            executable: launch.executable.clone(),
            args: launch.args.clone(),
            cwd: launch.cwd.clone(),
            env: launch.env.clone(),
            protocol_flavor: definition.protocol_flavor,
            auth_method: launch.auth_method.clone(),
            auth_credential_source: launch.auth_credential_source.clone(),
            auth_handshake: launch.auth_handshake.clone(),
            persisted_runtime_session_id: launch.persisted_runtime_session_id.clone(),
            persisted_subagent_session_mappings: launch.persisted_subagent_session_mappings.clone(),
            supports_resume_session: definition.capabilities.resume_session,
            supports_subagents: definition.capabilities.subagents,
        })
    }

    pub fn redacted_env(&self) -> BTreeMap<String, String> {
        self.env
            .iter()
            .map(|(key, value)| (key.clone(), redact_env_key_value(key, value)))
            .collect()
    }
}

fn validate_launch_context(
    definition: RuntimeDefinition,
    launch: &NativeAiLaunchSpec,
) -> AiResult<()> {
    let runtime_id = definition.id.to_string();
    if launch.runtime_id.0 != definition.id {
        return Err(AiError::RuntimeLaunchContextInvalid {
            runtime_id,
            message: format!(
                "Launch context runtime `{}` does not match descriptor `{}`.",
                launch.runtime_id.0, definition.id
            ),
        });
    }

    if launch.status.runtime_id != launch.runtime_id {
        return Err(AiError::RuntimeLaunchContextInvalid {
            runtime_id,
            message: "Launch status belongs to a different runtime.".to_string(),
        });
    }

    if launch.executable.trim().is_empty() {
        return Err(AiError::RuntimeLaunchContextInvalid {
            runtime_id,
            message: "Launch executable is missing.".to_string(),
        });
    }

    if launch.cwd.trim().is_empty() {
        return Err(AiError::RuntimeLaunchContextInvalid {
            runtime_id,
            message: "Launch cwd is missing.".to_string(),
        });
    }

    if launch.status.state != "ready" || launch.status.onboarding_required {
        return Err(AiError::RuntimeNotReady {
            runtime_id,
            message: launch
                .status
                .message
                .clone()
                .unwrap_or_else(|| "Native runtime launch status is not ready.".to_string()),
        });
    }

    if definition.id != "claude" && launch.args != definition_args(definition) {
        return Err(AiError::RuntimeLaunchContextInvalid {
            runtime_id,
            message: format!(
                "Launch args do not match the native ACP contract for {}.",
                definition.display_name
            ),
        });
    }

    if launch.auth_handshake.is_some()
        && launch
            .auth_method
            .as_deref()
            .is_none_or(|method| method.trim().is_empty())
    {
        return Err(AiError::RuntimeAuthMissing {
            runtime_id,
            message: "Launch context requested an auth handshake without an auth method."
                .to_string(),
        });
    }

    Ok(())
}

fn acp_client_capabilities() -> ClientCapabilities {
    let mut meta = Meta::default();
    meta.insert(
        ACP_TERMINAL_OUTPUT_META_KEY.to_string(),
        serde_json::json!(true),
    );
    ClientCapabilities::new()
        .elicitation(ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()))
        .meta(meta)
}

fn set_prompt_capabilities(
    state: &PromptCapabilitiesState,
    initialize_response: &InitializeResponse,
) -> Result<(), String> {
    let mut capabilities = state
        .lock()
        .map_err(|error| format!("ACP prompt capabilities lock failed: {error}"))?;
    *capabilities =
        AcpPromptCapabilities::from(&initialize_response.agent_capabilities.prompt_capabilities);
    Ok(())
}

fn protocol_version_for_flavor(flavor: AcpProtocolFlavor) -> ProtocolVersion {
    match flavor {
        AcpProtocolFlavor::Current14 | AcpProtocolFlavor::Legacy12 => ProtocolVersion::V1,
    }
}

fn persisted_session_start_method(spec: &AcpProcessSpec) -> PersistedSessionStartMethod {
    if spec.supports_resume_session {
        PersistedSessionStartMethod::Resume
    } else {
        PersistedSessionStartMethod::Load
    }
}

fn definition_args(definition: RuntimeDefinition) -> Vec<String> {
    definition
        .acp_args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect()
}

async fn run_acp_auth_handshake(
    connection: &ConnectionTo<Agent>,
    spec: &AcpProcessSpec,
    initialize_response: &InitializeResponse,
) -> Result<(), agent_client_protocol::Error> {
    let Some(request) = acp_auth_handshake_request(spec, initialize_response)
        .map_err(|message| agent_client_protocol::Error::internal_error().data(message))?
    else {
        return Ok(());
    };

    let mut authenticate = AuthenticateRequest::new(request.method_id);
    if let Some(meta) = request.meta {
        authenticate = authenticate.meta(meta);
    }
    connection.send_request(authenticate).block_task().await?;
    Ok(())
}

#[derive(Debug)]
struct AcpAuthHandshakeRequest {
    method_id: String,
    meta: Option<agent_client_protocol::schema::Meta>,
}

fn acp_auth_handshake_request(
    spec: &AcpProcessSpec,
    initialize_response: &InitializeResponse,
) -> Result<Option<AcpAuthHandshakeRequest>, String> {
    let Some(handshake) = spec.auth_handshake.as_ref() else {
        return Ok(None);
    };
    let method_id = match spec.auth_credential_source.as_deref() {
        Some("environment" | "comando-secret") => handshake.env_method_id.clone(),
        Some("external-runtime") => handshake.external_method_id.clone(),
        _ => match spec.auth_method.as_deref() {
            Some("xai-api-key") => handshake.env_method_id.clone(),
            Some("grok-login") => handshake.external_method_id.clone(),
            Some(method) => {
                return Err(format!(
                    "{} auth method `{method}` cannot be used for the native ACP auth handshake.",
                    spec.runtime_id
                ));
            }
            None => return Ok(None),
        },
    };

    if !initialize_response
        .auth_methods
        .iter()
        .any(|method| method.id().0.as_ref() == method_id)
    {
        return Err(format!(
            "{} ACP runtime did not advertise required auth method `{method_id}`.",
            spec.runtime_id
        ));
    }

    let meta = (!handshake.meta.is_empty()).then(|| {
        handshake
            .meta
            .clone()
            .into_iter()
            .collect::<agent_client_protocol::schema::Meta>()
    });
    Ok(Some(AcpAuthHandshakeRequest { method_id, meta }))
}

#[derive(Debug, Clone)]
pub struct AcpSessionController {
    permission_waiters: PermissionWaiterMap,
    prompt_capabilities: PromptCapabilitiesState,
    sender: tokio_mpsc::UnboundedSender<AcpSessionCommand>,
    user_input_waiters: UserInputWaiterMap,
}

impl AcpSessionController {
    pub fn send_prompt(
        &self,
        runtime_session_id: RuntimeSessionId,
        target_session_id: SessionId,
        message_id: MessageId,
        prompt: String,
        attachments: Vec<NativeAiImageAttachment>,
    ) -> AiResult<()> {
        if !attachments.is_empty() {
            let capabilities = self.prompt_capabilities.lock().map_err(|error| {
                AiError::Internal(format!("ACP prompt capabilities lock failed: {error}"))
            })?;
            if !capabilities.image {
                return Err(AiError::Unsupported(
                    "This AI runtime does not support image attachments.".to_string(),
                ));
            }
        }

        self.sender
            .send(AcpSessionCommand::Prompt {
                attachments,
                message_id,
                prompt,
                runtime_session_id,
                target_session_id,
            })
            .map_err(|_| AiError::RuntimeExited {
                message: "The ACP runtime session is no longer running.".to_string(),
            })
    }

    pub fn cancel(&self, runtime_session_id: RuntimeSessionId) -> AiResult<()> {
        self.sender
            .send(AcpSessionCommand::Cancel { runtime_session_id })
            .map_err(|_| AiError::RuntimeExited {
                message: "The ACP runtime session is no longer running.".to_string(),
            })
    }

    pub fn set_config_option(
        &self,
        runtime_session_id: RuntimeSessionId,
        config_id: String,
        value: NativeAiConfigValue,
    ) -> AiResult<()> {
        let (result_sender, result_receiver) = std_mpsc::sync_channel(1);
        self.sender
            .send(AcpSessionCommand::SetConfigOption {
                config_id,
                result_sender,
                runtime_session_id,
                value,
            })
            .map_err(|_| AiError::RuntimeExited {
                message: "The ACP runtime session is no longer running.".to_string(),
            })?;
        result_receiver
            .recv()
            .map_err(|_| AiError::RuntimeExited {
                message: "The ACP runtime session is no longer running.".to_string(),
            })?
            .map_err(|message| AiError::RuntimeExited { message })
    }

    pub fn close(&self) {
        self.cancel_pending_requests();
        let _ = self.sender.send(AcpSessionCommand::Close);
    }

    pub fn respond_permission(&self, input: NativeAiPermissionResponseInput) -> AiResult<()> {
        let waiter = self
            .permission_waiters
            .lock()
            .map_err(|error| {
                AiError::Internal(format!("AI permission waiter lock failed: {error}"))
            })?
            .remove(&input.request_id)
            .ok_or_else(|| AiError::PermissionNotFound {
                request_id: input.request_id.clone(),
            })?;
        let outcome = input
            .option_id
            .filter(|option_id| !option_id.trim().is_empty())
            .map(|option_id| {
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
            })
            .unwrap_or(RequestPermissionOutcome::Cancelled);
        waiter
            .sender
            .send(outcome)
            .map_err(|_| AiError::RuntimeExited {
                message: "The ACP permission request is no longer waiting.".to_string(),
            })
    }

    pub fn respond_user_input(&self, input: NativeAiUserInputResponseInput) -> AiResult<()> {
        let waiter = self
            .user_input_waiters
            .lock()
            .map_err(|error| {
                AiError::Internal(format!("AI user input waiter lock failed: {error}"))
            })?
            .remove(&input.request_id)
            .ok_or_else(|| AiError::UserInputNotFound {
                request_id: input.request_id.clone(),
            })?;
        let response = create_elicitation_response_from_input(input, &waiter.schema);
        waiter
            .sender
            .send(response)
            .map_err(|_| AiError::RuntimeExited {
                message: "The ACP user input request is no longer waiting.".to_string(),
            })
    }

    pub fn cancel_pending_requests(&self) {
        if let Ok(mut waiters) = self.permission_waiters.lock() {
            for (_, waiter) in waiters.drain() {
                let _ = waiter.sender.send(RequestPermissionOutcome::Cancelled);
            }
        }
        if let Ok(mut waiters) = self.user_input_waiters.lock() {
            for (_, waiter) in waiters.drain() {
                let _ = waiter
                    .sender
                    .send(CreateElicitationResponse::new(ElicitationAction::Cancel));
            }
        }
    }

    pub fn cancel_pending_requests_for_target(
        &self,
        runtime_session_id: &RuntimeSessionId,
        target_session_id: &SessionId,
    ) {
        if let Ok(mut waiters) = self.permission_waiters.lock() {
            let request_ids = waiters
                .iter()
                .filter(|(_, waiter)| {
                    waiter.runtime_session_id == *runtime_session_id
                        && waiter.target_session_id == *target_session_id
                })
                .map(|(request_id, _)| request_id.clone())
                .collect::<Vec<_>>();
            for request_id in request_ids {
                if let Some(waiter) = waiters.remove(&request_id) {
                    let _ = waiter.sender.send(RequestPermissionOutcome::Cancelled);
                }
            }
        }
        if let Ok(mut waiters) = self.user_input_waiters.lock() {
            let request_ids = waiters
                .iter()
                .filter(|(_, waiter)| {
                    waiter.runtime_session_id.as_ref() == Some(runtime_session_id)
                        && waiter.target_session_id == *target_session_id
                })
                .map(|(request_id, _)| request_id.clone())
                .collect::<Vec<_>>();
            for request_id in request_ids {
                if let Some(waiter) = waiters.remove(&request_id) {
                    let _ = waiter
                        .sender
                        .send(CreateElicitationResponse::new(ElicitationAction::Cancel));
                }
            }
        }
    }
}

#[derive(Debug)]
enum AcpSessionCommand {
    Prompt {
        attachments: Vec<NativeAiImageAttachment>,
        message_id: MessageId,
        prompt: String,
        runtime_session_id: RuntimeSessionId,
        target_session_id: SessionId,
    },
    Cancel {
        runtime_session_id: RuntimeSessionId,
    },
    SetConfigOption {
        config_id: String,
        result_sender: std_mpsc::SyncSender<Result<(), String>>,
        runtime_session_id: RuntimeSessionId,
        value: NativeAiConfigValue,
    },
    Close,
}

pub fn start_acp_session(
    runtime: &Runtime,
    spec: AcpProcessSpec,
    mut session: NativeAiSession,
    sessions: Arc<Mutex<SessionRegistry>>,
    event_sender: Option<std_mpsc::SyncSender<AiRuntimeEvent>>,
) -> AiResult<(NativeAiSession, AcpSessionController)> {
    let (command_sender, command_receiver) = tokio_mpsc::unbounded_channel();
    let permission_waiters = Arc::new(Mutex::new(HashMap::new()));
    let prompt_capabilities = Arc::new(Mutex::new(AcpPromptCapabilities::default()));
    let user_input_waiters = Arc::new(Mutex::new(HashMap::new()));
    let controller = AcpSessionController {
        permission_waiters: Arc::clone(&permission_waiters),
        prompt_capabilities: Arc::clone(&prompt_capabilities),
        sender: command_sender,
        user_input_waiters: Arc::clone(&user_input_waiters),
    };
    let (started_sender, started_receiver) = oneshot::channel::<Result<RuntimeSessionId, String>>();
    let started_sender = Arc::new(Mutex::new(Some(started_sender)));
    let task_started_sender = Arc::clone(&started_sender);
    let task_session = session.clone();
    let task_sessions = Arc::clone(&sessions);

    runtime.spawn(async move {
        let result = run_acp_session(
            spec,
            task_session,
            task_sessions,
            event_sender,
            command_receiver,
            Arc::clone(&task_started_sender),
            permission_waiters,
            prompt_capabilities,
            user_input_waiters,
        )
        .await;
        if let Err(error) = result {
            send_start_result(&task_started_sender, Err(error.clone()));
        }
    });

    let runtime_session_id = runtime
        .block_on(async { started_receiver.await })
        .map_err(|_| AiError::RuntimeExited {
            message: "The ACP runtime exited before creating a session.".to_string(),
        })?
        .map_err(|message| AiError::RuntimeExited { message })?;
    session.runtime_session_id = Some(runtime_session_id);
    session.updated_at = now_iso8601();
    Ok((session, controller))
}

#[derive(Debug, Clone)]
pub enum AcpRuntimeAuthAction {
    Authenticate { method_id: String },
    Logout,
}

pub fn run_acp_runtime_auth(
    runtime: &Runtime,
    spec: AcpProcessSpec,
    action: AcpRuntimeAuthAction,
) -> AiResult<()> {
    runtime
        .block_on(run_acp_runtime_auth_async(spec, action))
        .map_err(|message| AiError::RuntimeExited { message })
}

async fn run_acp_runtime_auth_async(
    spec: AcpProcessSpec,
    action: AcpRuntimeAuthAction,
) -> Result<(), String> {
    let mut command = Command::new(&spec.executable);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(&spec.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start ACP runtime `{}`: {error}", spec.executable))?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(drain_stderr(stderr));
    }
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "ACP runtime stdin was not available.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ACP runtime stdout was not available.".to_string())?;
    let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());

    let result = Client
        .builder()
        .connect_with(transport, |connection: ConnectionTo<Agent>| {
            let spec = spec.clone();
            let action = action.clone();
            async move {
                let initialize_response = connection
                    .send_request(
                        InitializeRequest::new(protocol_version_for_flavor(spec.protocol_flavor))
                            .client_capabilities(acp_client_capabilities()),
                    )
                    .block_task()
                    .await?;
                match action {
                    AcpRuntimeAuthAction::Authenticate { method_id } => {
                        if !initialize_response
                            .auth_methods
                            .iter()
                            .any(|method| method.id().0.as_ref() == method_id)
                        {
                            return Err(agent_client_protocol::Error::internal_error().data(
                                format!(
                                    "{} ACP runtime did not advertise auth method `{method_id}`.",
                                    spec.runtime_id
                                ),
                            ));
                        }
                        connection
                            .send_request(AuthenticateRequest::new(method_id))
                            .block_task()
                            .await?;
                    }
                    AcpRuntimeAuthAction::Logout => {
                        if initialize_response.agent_capabilities.auth.logout.is_none() {
                            return Err(agent_client_protocol::Error::internal_error().data(
                                format!(
                                    "{} ACP runtime did not advertise logout support.",
                                    spec.runtime_id
                                ),
                            ));
                        }
                        connection
                            .send_request(LogoutRequest::new())
                            .block_task()
                            .await?;
                    }
                }
                Ok(())
            }
        })
        .await
        .map_err(|error| format!("ACP runtime authentication failed: {error}"));

    let _ = child.kill().await;
    result
}

async fn run_acp_session(
    spec: AcpProcessSpec,
    session: NativeAiSession,
    sessions: Arc<Mutex<SessionRegistry>>,
    event_sender: Option<std_mpsc::SyncSender<AiRuntimeEvent>>,
    mut command_receiver: tokio_mpsc::UnboundedReceiver<AcpSessionCommand>,
    started_sender: Arc<Mutex<Option<oneshot::Sender<Result<RuntimeSessionId, String>>>>>,
    permission_waiters: PermissionWaiterMap,
    prompt_capabilities: PromptCapabilitiesState,
    user_input_waiters: UserInputWaiterMap,
) -> Result<(), String> {
    let mut command = Command::new(&spec.executable);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(&spec.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start ACP runtime `{}`: {error}", spec.executable))?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(drain_stderr(stderr));
    }
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "ACP runtime stdin was not available.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ACP runtime stdout was not available.".to_string())?;
    let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());

    let notification_context = NotificationContext::new(
        session.clone(),
        event_sender.clone(),
        spec.persisted_subagent_session_mappings.clone(),
        spec.supports_subagents,
    );
    let notification_context_for_handler = notification_context.clone();
    let permission_event_sender = event_sender.clone();
    let permission_notification_context = notification_context.clone();
    let permission_session = session.clone();
    let permission_sessions = Arc::clone(&sessions);
    let permission_waiters_for_handler = Arc::clone(&permission_waiters);
    let user_input_event_sender = event_sender.clone();
    let user_input_notification_context = notification_context.clone();
    let user_input_session = session.clone();
    let user_input_sessions = Arc::clone(&sessions);
    let user_input_waiters_for_handler = Arc::clone(&user_input_waiters);
    let connect_result = Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                notification_context_for_handler.handle(notification);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                let outcome = handle_permission_request(
                    request,
                    &permission_session,
                    &permission_sessions,
                    permission_event_sender.as_ref(),
                    &permission_waiters_for_handler,
                    &permission_notification_context,
                )
                .await;
                let response = RequestPermissionResponse::new(outcome);
                responder.respond(response)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CreateElicitationRequest, responder, _connection| {
                let response = handle_user_input_request(
                    request,
                    &user_input_session,
                    &user_input_sessions,
                    user_input_event_sender.as_ref(),
                    &user_input_waiters_for_handler,
                    &user_input_notification_context,
                )
                .await;
                responder.respond(response)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(transport, |connection: ConnectionTo<Agent>| {
            let session = session.clone();
            let sessions = Arc::clone(&sessions);
            let event_sender = event_sender.clone();
            let notification_context = notification_context.clone();
            let prompt_capabilities = Arc::clone(&prompt_capabilities);
            let started_sender = Arc::clone(&started_sender);
            async move {
                let initialize_response = connection
                    .send_request(
                        InitializeRequest::new(protocol_version_for_flavor(spec.protocol_flavor))
                            .client_capabilities(acp_client_capabilities()),
                    )
                    .block_task()
                    .await?;
                set_prompt_capabilities(&prompt_capabilities, &initialize_response).map_err(
                    |message| agent_client_protocol::Error::internal_error().data(message),
                )?;
                run_acp_auth_handshake(&connection, &spec, &initialize_response).await?;

                let additional_directories = session
                    .scope
                    .additional_roots
                    .iter()
                    .map(PathBuf::from)
                    .collect::<Vec<_>>();
                let (runtime_session_id, initial_config_options) = if let Some(runtime_session_id) =
                    spec.persisted_runtime_session_id.clone()
                {
                    let config_options = match persisted_session_start_method(&spec) {
                        PersistedSessionStartMethod::Resume => {
                            let resume_session = ResumeSessionRequest::new(
                                agent_client_protocol::schema::SessionId::from(
                                    runtime_session_id.0.clone(),
                                ),
                                PathBuf::from(&session.scope.cwd),
                            )
                            .additional_directories(additional_directories);
                            connection
                                .send_request(resume_session)
                                .block_task()
                                .await?
                                .config_options
                        }
                        PersistedSessionStartMethod::Load => {
                            let load_session = LoadSessionRequest::new(
                                agent_client_protocol::schema::SessionId::from(
                                    runtime_session_id.0.clone(),
                                ),
                                PathBuf::from(&session.scope.cwd),
                            )
                            .additional_directories(additional_directories);
                            notification_context.set_loading_persisted_session(true);
                            let response = connection.send_request(load_session).block_task().await;
                            notification_context.set_loading_persisted_session(false);
                            response?.config_options
                        }
                    };
                    (runtime_session_id, config_options)
                } else {
                    let new_session = NewSessionRequest::new(PathBuf::from(&session.scope.cwd))
                        .additional_directories(additional_directories);
                    let new_session_response =
                        connection.send_request(new_session).block_task().await?;
                    (
                        RuntimeSessionId(new_session_response.session_id.to_string()),
                        new_session_response.config_options,
                    )
                };
                notification_context.set_runtime_session_id(runtime_session_id.clone());
                emit_initial_config_options(
                    event_sender.as_ref(),
                    &session,
                    &runtime_session_id,
                    initial_config_options,
                );
                emit_event(
                    event_sender.as_ref(),
                    AI_RUNTIME_CONNECTION_EVENT,
                    &NativeAiRuntimeConnectionPayload {
                        runtime_id: session.runtime_id.clone(),
                        status: "ready".to_string(),
                        message: None,
                        updated_at: now_iso8601(),
                    },
                );
                send_start_result(&started_sender, Ok(runtime_session_id.clone()));

                while let Some(command) = command_receiver.recv().await {
                    match command {
                        AcpSessionCommand::Prompt {
                            attachments,
                            message_id,
                            prompt,
                            runtime_session_id,
                            target_session_id,
                        } => {
                            let connection = connection.clone();
                            let event_sender = event_sender.clone();
                            let notification_context = notification_context.clone();
                            let runtime_id = session.runtime_id.clone();
                            let root_session_id = session.session_id.clone();
                            let sessions = Arc::clone(&sessions);
                            tokio::spawn(async move {
                                run_prompt(
                                    &connection,
                                    &root_session_id,
                                    &target_session_id,
                                    &runtime_id,
                                    &runtime_session_id,
                                    message_id,
                                    prompt,
                                    attachments,
                                    &sessions,
                                    event_sender.as_ref(),
                                    &notification_context,
                                )
                                .await;
                            });
                        }
                        AcpSessionCommand::Cancel { runtime_session_id } => {
                            connection.send_notification(CancelNotification::new(
                                agent_client_protocol::schema::SessionId::from(
                                    runtime_session_id.0.clone(),
                                ),
                            ))?;
                        }
                        AcpSessionCommand::SetConfigOption {
                            config_id,
                            result_sender,
                            runtime_session_id,
                            value,
                        } => {
                            let request = SetSessionConfigOptionRequest::new(
                                agent_client_protocol::schema::SessionId::from(
                                    runtime_session_id.0,
                                ),
                                config_id,
                                acp_config_value(value),
                            );
                            let result = connection
                                .send_request(request)
                                .block_task()
                                .await
                                .map(|_| ())
                                .map_err(|error| error.to_string());
                            let _ = result_sender.send(result);
                        }
                        AcpSessionCommand::Close => break,
                    }
                }

                Ok(())
            }
        })
        .await;

    if let Err(error) = &connect_result {
        send_start_result(&started_sender, Err(error.to_string()));
    }
    let _ = child.kill().await;
    connect_result.map_err(|error| error.to_string())
}

async fn run_prompt(
    connection: &ConnectionTo<Agent>,
    session_id: &SessionId,
    target_session_id: &SessionId,
    runtime_id: &RuntimeId,
    runtime_session_id: &RuntimeSessionId,
    message_id: MessageId,
    prompt: String,
    attachments: Vec<NativeAiImageAttachment>,
    sessions: &Arc<Mutex<SessionRegistry>>,
    event_sender: Option<&std_mpsc::SyncSender<AiRuntimeEvent>>,
    notification_context: &NotificationContext,
) {
    let runtime_session =
        agent_client_protocol::schema::SessionId::from(runtime_session_id.0.clone());
    let prompt_request =
        PromptRequest::new(runtime_session, prompt_content_blocks(prompt, attachments));

    let response = connection.send_request(prompt_request).block_task().await;
    notification_context.complete_open_messages();
    match response {
        Ok(response) => {
            let summary = mark_session_idle(sessions, session_id);
            if let Some(summary) = summary.as_ref() {
                let mut target_summary = summary.clone();
                if target_session_id != session_id {
                    target_summary.session_id = target_session_id.clone();
                    target_summary.runtime_session_id = Some(runtime_session_id.clone());
                    target_summary.status = NativeAiSessionStatus::Idle;
                }
                emit_event(
                    event_sender,
                    AI_SESSION_UPDATED_EVENT,
                    &session_updated(&target_summary),
                );
                emit_event(
                    event_sender,
                    crate::events::AI_STATUS_EVENT,
                    &crate::events::status_event(
                        &target_summary,
                        format!("acp:turn:{}", message_id.0),
                        "completed",
                        "Completed",
                        Some(format!(
                            "Stop reason: {}",
                            stop_reason_label(response.stop_reason)
                        )),
                    ),
                );
            }
        }
        Err(error) => {
            let summary = mark_session_error(sessions, session_id);
            let updated_at = now_iso8601();
            emit_event(
                event_sender,
                AI_ERROR_EVENT,
                &NativeAiErrorPayload {
                    session_id: Some(target_session_id.clone()),
                    runtime_id: Some(runtime_id.clone()),
                    message: error.to_string(),
                    recoverable: true,
                    updated_at,
                },
            );
            if let Some(summary) = summary.as_ref() {
                let mut target_summary = summary.clone();
                if target_session_id != session_id {
                    target_summary.session_id = target_session_id.clone();
                    target_summary.runtime_session_id = Some(runtime_session_id.clone());
                    target_summary.status = NativeAiSessionStatus::Error;
                }
                emit_event(
                    event_sender,
                    AI_SESSION_UPDATED_EVENT,
                    &session_updated(&target_summary),
                );
            }
        }
    }
}

fn prompt_content_blocks(
    prompt: String,
    attachments: Vec<NativeAiImageAttachment>,
) -> Vec<ContentBlock> {
    let text = prompt.trim();
    let text_block_count = if text.is_empty() { 0 } else { 1 };
    let mut blocks = Vec::with_capacity(text_block_count + attachments.len());
    if !text.is_empty() {
        blocks.push(ContentBlock::Text(TextContent::new(text.to_string())));
    }
    blocks.extend(attachments.into_iter().map(|attachment| {
        ContentBlock::Image(ImageContent::new(
            attachment.data_base64,
            attachment.mime_type,
        ))
    }));
    blocks
}

async fn handle_permission_request(
    request: RequestPermissionRequest,
    session: &NativeAiSession,
    sessions: &Arc<Mutex<SessionRegistry>>,
    event_sender: Option<&std_mpsc::SyncSender<AiRuntimeEvent>>,
    waiters: &PermissionWaiterMap,
    notification_context: &NotificationContext,
) -> RequestPermissionOutcome {
    let request_id = next_request_id("permission");
    let runtime_session_id = RuntimeSessionId(request.session_id.to_string());
    notification_context.ensure_known_runtime_session(&runtime_session_id, Some("Subagent"));
    notification_context.flush_runtime_messages(&runtime_session_id);
    let target_summary = notification_context
        .summary_for_runtime_session(&runtime_session_id)
        .unwrap_or_else(|| {
            let mut summary = session.summary();
            summary.runtime_session_id = Some(runtime_session_id.clone());
            summary
        });
    let title = request
        .tool_call
        .fields
        .title
        .clone()
        .unwrap_or_else(|| "Permission required".to_string());
    let tool_call_id = NativeToolCallId(request.tool_call.tool_call_id.to_string());
    let options = request
        .options
        .iter()
        .map(permission_option_payload)
        .collect::<Vec<_>>();
    let (sender, receiver) = oneshot::channel();
    if waiters
        .lock()
        .map(|mut waiters| {
            waiters.insert(
                request_id.clone(),
                PendingPermissionRequest {
                    runtime_session_id: runtime_session_id.clone(),
                    sender,
                    target_session_id: target_summary.session_id.clone(),
                },
            )
        })
        .is_err()
    {
        emit_ai_error(
            event_sender,
            session,
            "Native AI permission state is unavailable.",
        );
        return RequestPermissionOutcome::Cancelled;
    }

    if target_summary.session_id == session.session_id {
        emit_session_status(
            sessions,
            event_sender,
            &session.session_id,
            NativeAiSessionStatus::WaitingPermission,
        );
    } else {
        let mut summary = target_summary.clone();
        summary.status = NativeAiSessionStatus::WaitingPermission;
        emit_event(
            event_sender,
            AI_SESSION_UPDATED_EVENT,
            &session_updated(&summary),
        );
    }
    emit_event(
        event_sender,
        AI_PERMISSION_REQUEST_EVENT,
        &NativeAiPermissionRequestPayload {
            base: crate::events::event_base(
                &target_summary.session_id,
                &session.runtime_id,
                Some(runtime_session_id.clone()),
                now_iso8601(),
            ),
            request_id: request_id.clone(),
            tool_call_id,
            title,
            description: None,
            options,
        },
    );

    let outcome = receiver
        .await
        .unwrap_or(RequestPermissionOutcome::Cancelled);
    let cancelled = matches!(outcome, RequestPermissionOutcome::Cancelled);
    if target_summary.session_id == session.session_id {
        emit_session_status_if_current(
            sessions,
            event_sender,
            &session.session_id,
            NativeAiSessionStatus::WaitingPermission,
            NativeAiSessionStatus::Streaming,
        );
    } else {
        let mut summary = target_summary;
        summary.status = if cancelled {
            NativeAiSessionStatus::Idle
        } else {
            NativeAiSessionStatus::Streaming
        };
        emit_event(
            event_sender,
            AI_SESSION_UPDATED_EVENT,
            &session_updated(&summary),
        );
    }
    outcome
}

async fn handle_user_input_request(
    request: CreateElicitationRequest,
    session: &NativeAiSession,
    sessions: &Arc<Mutex<SessionRegistry>>,
    event_sender: Option<&std_mpsc::SyncSender<AiRuntimeEvent>>,
    waiters: &UserInputWaiterMap,
    notification_context: &NotificationContext,
) -> CreateElicitationResponse {
    let ElicitationMode::Form(form) = &request.mode else {
        return CreateElicitationResponse::new(ElicitationAction::Cancel);
    };
    let request_id = next_request_id("user-input");
    let runtime_session_id = runtime_session_id_from_elicitation(&request)
        .or_else(|| session.runtime_session_id.clone());
    if let Some(runtime_session_id) = runtime_session_id.as_ref() {
        notification_context.ensure_known_runtime_session(runtime_session_id, Some("Subagent"));
        notification_context.flush_runtime_messages(runtime_session_id);
    }
    let target_summary = runtime_session_id
        .as_ref()
        .and_then(|runtime_session_id| {
            notification_context.summary_for_runtime_session(runtime_session_id)
        })
        .unwrap_or_else(|| session.summary());
    let questions = elicitation_questions(form);
    let schema = elicitation_answer_schema(form);
    let (sender, receiver) = oneshot::channel();
    if waiters
        .lock()
        .map(|mut waiters| {
            waiters.insert(
                request_id.clone(),
                PendingUserInputRequest {
                    runtime_session_id: runtime_session_id.clone(),
                    schema,
                    sender,
                    target_session_id: target_summary.session_id.clone(),
                },
            )
        })
        .is_err()
    {
        emit_ai_error(
            event_sender,
            session,
            "Native AI user input state is unavailable.",
        );
        return CreateElicitationResponse::new(ElicitationAction::Cancel);
    }

    if target_summary.session_id == session.session_id {
        emit_session_status(
            sessions,
            event_sender,
            &session.session_id,
            NativeAiSessionStatus::WaitingUserInput,
        );
    } else {
        let mut summary = target_summary.clone();
        summary.status = NativeAiSessionStatus::WaitingUserInput;
        emit_event(
            event_sender,
            AI_SESSION_UPDATED_EVENT,
            &session_updated(&summary),
        );
    }
    emit_event(
        event_sender,
        AI_USER_INPUT_REQUEST_EVENT,
        &NativeAiUserInputRequestPayload {
            base: crate::events::event_base(
                &target_summary.session_id,
                &session.runtime_id,
                runtime_session_id.clone(),
                now_iso8601(),
            ),
            request_id: request_id.clone(),
            title: request.message,
            tool_call_id: NativeToolCallId(format!("elicitation:{request_id}")),
            turn_id: None,
            questions,
        },
    );

    let response = receiver
        .await
        .unwrap_or_else(|_| CreateElicitationResponse::new(ElicitationAction::Cancel));
    let cancelled = matches!(&response.action, ElicitationAction::Cancel);
    if target_summary.session_id == session.session_id {
        emit_session_status_if_current(
            sessions,
            event_sender,
            &session.session_id,
            NativeAiSessionStatus::WaitingUserInput,
            NativeAiSessionStatus::Streaming,
        );
    } else {
        let mut summary = target_summary;
        summary.status = if cancelled {
            NativeAiSessionStatus::Idle
        } else {
            NativeAiSessionStatus::Streaming
        };
        emit_event(
            event_sender,
            AI_SESSION_UPDATED_EVENT,
            &session_updated(&summary),
        );
    }
    response
}

async fn drain_stderr(stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while lines.next_line().await.ok().flatten().is_some() {}
}

fn mark_session_idle(
    sessions: &Arc<Mutex<SessionRegistry>>,
    session_id: &SessionId,
) -> Option<NativeAiSessionSummary> {
    mark_session_status(sessions, session_id, NativeAiSessionStatus::Idle)
}

fn mark_session_error(
    sessions: &Arc<Mutex<SessionRegistry>>,
    session_id: &SessionId,
) -> Option<NativeAiSessionSummary> {
    mark_session_status(sessions, session_id, NativeAiSessionStatus::Error)
}

fn mark_session_status(
    sessions: &Arc<Mutex<SessionRegistry>>,
    session_id: &SessionId,
    status: NativeAiSessionStatus,
) -> Option<NativeAiSessionSummary> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(session_id).ok()?;
    if matches!(
        status,
        NativeAiSessionStatus::Idle | NativeAiSessionStatus::Error | NativeAiSessionStatus::Closed
    ) {
        session.prompt_in_flight = false;
        session.active_message_id = None;
    }
    session.set_status(status);
    Some(session.session.summary())
}

fn send_start_result(
    sender: &Arc<Mutex<Option<oneshot::Sender<Result<RuntimeSessionId, String>>>>>,
    result: Result<RuntimeSessionId, String>,
) {
    if let Ok(mut sender) = sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
}

fn emit_event<T: serde::Serialize>(
    sender: Option<&std_mpsc::SyncSender<AiRuntimeEvent>>,
    event_name: impl Into<String>,
    payload: &T,
) {
    if let Some(sender) = sender {
        let _ = sender.send(AiRuntimeEvent::new(event_name, payload));
    }
}

fn emit_initial_config_options(
    sender: Option<&std_mpsc::SyncSender<AiRuntimeEvent>>,
    session: &NativeAiSession,
    runtime_session_id: &RuntimeSessionId,
    config_options: Option<Vec<SessionConfigOption>>,
) {
    if let Some(config_options) = config_options {
        emit_event(
            sender,
            AI_SESSION_CATALOG_UPDATED_EVENT,
            &NativeAiSessionCatalogUpdatedPayload {
                base: crate::events::event_base(
                    &session.session_id,
                    &session.runtime_id,
                    Some(runtime_session_id.clone()),
                    now_iso8601(),
                ),
                available_commands: None,
                config_options: Some(
                    config_options
                        .into_iter()
                        .map(session_config_option_payload)
                        .collect(),
                ),
                mode_id: None,
            },
        );
    }
}

fn emit_session_status(
    sessions: &Arc<Mutex<SessionRegistry>>,
    sender: Option<&std_mpsc::SyncSender<AiRuntimeEvent>>,
    session_id: &SessionId,
    status: NativeAiSessionStatus,
) {
    let summary = mark_session_status(sessions, session_id, status);
    if let Some(summary) = summary.as_ref() {
        emit_event(sender, AI_SESSION_UPDATED_EVENT, &session_updated(summary));
    }
}

fn emit_session_status_if_current(
    sessions: &Arc<Mutex<SessionRegistry>>,
    sender: Option<&std_mpsc::SyncSender<AiRuntimeEvent>>,
    session_id: &SessionId,
    expected: NativeAiSessionStatus,
    status: NativeAiSessionStatus,
) {
    let summary = {
        let mut sessions = match sessions.lock() {
            Ok(sessions) => sessions,
            Err(_) => return,
        };
        let session = match sessions.get_mut(session_id) {
            Ok(session) => session,
            Err(_) => return,
        };
        if session.session.status != expected {
            return;
        }
        session.set_status(status);
        session.session.summary()
    };
    emit_event(sender, AI_SESSION_UPDATED_EVENT, &session_updated(&summary));
}

fn emit_ai_error(
    sender: Option<&std_mpsc::SyncSender<AiRuntimeEvent>>,
    session: &NativeAiSession,
    message: impl Into<String>,
) {
    emit_event(
        sender,
        AI_ERROR_EVENT,
        &NativeAiErrorPayload {
            session_id: Some(session.session_id.clone()),
            runtime_id: Some(session.runtime_id.clone()),
            message: message.into(),
            recoverable: true,
            updated_at: now_iso8601(),
        },
    );
}

fn next_request_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}",
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn permission_option_payload(option: &PermissionOption) -> NativeAiPermissionOptionPayload {
    NativeAiPermissionOptionPayload {
        option_id: option.option_id.to_string(),
        name: option.name.clone(),
        kind: serde_label(&option.kind),
    }
}

fn acp_config_value(value: NativeAiConfigValue) -> SessionConfigOptionValue {
    match value {
        NativeAiConfigValue::Boolean(value) => SessionConfigOptionValue::boolean(value),
        NativeAiConfigValue::ValueId(value) => SessionConfigOptionValue::value_id(value),
    }
}

fn runtime_session_id_from_elicitation(
    request: &CreateElicitationRequest,
) -> Option<RuntimeSessionId> {
    match request.mode.scope() {
        agent_client_protocol::schema::ElicitationScope::Session(scope) => {
            Some(RuntimeSessionId(scope.session_id.to_string()))
        }
        _ => None,
    }
}

fn elicitation_questions(
    form: &agent_client_protocol::schema::ElicitationFormMode,
) -> Vec<NativeAiUserInputQuestionPayload> {
    let questions = form
        .requested_schema
        .properties
        .iter()
        .map(|(id, property)| elicitation_question(id, property))
        .collect::<Vec<_>>();

    if questions.is_empty() {
        return vec![NativeAiUserInputQuestionPayload {
            id: "input".to_string(),
            header: form
                .requested_schema
                .title
                .clone()
                .unwrap_or_else(|| "Input".to_string()),
            question: form
                .requested_schema
                .description
                .clone()
                .unwrap_or_else(|| "Provide the requested input.".to_string()),
            is_other: false,
            is_secret: false,
            options: Vec::new(),
        }];
    }

    questions
}

fn elicitation_answer_schema(
    form: &agent_client_protocol::schema::ElicitationFormMode,
) -> BTreeMap<String, ElicitationAnswerKind> {
    form.requested_schema
        .properties
        .iter()
        .map(|(id, property)| (id.clone(), elicitation_answer_kind(property)))
        .collect()
}

fn elicitation_answer_kind(property: &ElicitationPropertySchema) -> ElicitationAnswerKind {
    match property {
        ElicitationPropertySchema::Array(_) => ElicitationAnswerKind::Array,
        ElicitationPropertySchema::Boolean(_) => ElicitationAnswerKind::Boolean,
        ElicitationPropertySchema::Integer(_) => ElicitationAnswerKind::Integer,
        ElicitationPropertySchema::Number(_) => ElicitationAnswerKind::Number,
        _ => ElicitationAnswerKind::String,
    }
}

fn elicitation_question(
    id: &str,
    property: &ElicitationPropertySchema,
) -> NativeAiUserInputQuestionPayload {
    let metadata = elicitation_property_metadata(id, property);
    NativeAiUserInputQuestionPayload {
        id: id.to_string(),
        header: metadata.header,
        question: metadata.question,
        is_other: false,
        is_secret: metadata.is_secret,
        options: metadata.options,
    }
}

struct ElicitationQuestionMetadata {
    header: String,
    question: String,
    is_secret: bool,
    options: Vec<NativeAiUserInputQuestionOptionPayload>,
}

fn elicitation_property_metadata(
    id: &str,
    property: &ElicitationPropertySchema,
) -> ElicitationQuestionMetadata {
    match property {
        ElicitationPropertySchema::String(schema) => ElicitationQuestionMetadata {
            header: schema.title.clone().unwrap_or_else(|| id.to_string()),
            question: schema
                .description
                .clone()
                .or_else(|| schema.title.clone())
                .unwrap_or_else(|| id.to_string()),
            is_secret: schema
                .format
                .as_ref()
                .is_some_and(|format| serde_label(format).contains("password")),
            options: string_property_options(schema),
        },
        ElicitationPropertySchema::Number(schema) => ElicitationQuestionMetadata {
            header: schema.title.clone().unwrap_or_else(|| id.to_string()),
            question: schema
                .description
                .clone()
                .or_else(|| schema.title.clone())
                .unwrap_or_else(|| id.to_string()),
            is_secret: false,
            options: Vec::new(),
        },
        ElicitationPropertySchema::Integer(schema) => ElicitationQuestionMetadata {
            header: schema.title.clone().unwrap_or_else(|| id.to_string()),
            question: schema
                .description
                .clone()
                .or_else(|| schema.title.clone())
                .unwrap_or_else(|| id.to_string()),
            is_secret: false,
            options: Vec::new(),
        },
        ElicitationPropertySchema::Boolean(schema) => ElicitationQuestionMetadata {
            header: schema.title.clone().unwrap_or_else(|| id.to_string()),
            question: schema
                .description
                .clone()
                .or_else(|| schema.title.clone())
                .unwrap_or_else(|| id.to_string()),
            is_secret: false,
            options: vec![
                NativeAiUserInputQuestionOptionPayload {
                    label: "true".to_string(),
                    description: None,
                },
                NativeAiUserInputQuestionOptionPayload {
                    label: "false".to_string(),
                    description: None,
                },
            ],
        },
        ElicitationPropertySchema::Array(schema) => ElicitationQuestionMetadata {
            header: schema.title.clone().unwrap_or_else(|| id.to_string()),
            question: schema
                .description
                .clone()
                .or_else(|| schema.title.clone())
                .unwrap_or_else(|| id.to_string()),
            is_secret: false,
            options: multi_select_options(&schema.items),
        },
        _ => ElicitationQuestionMetadata {
            header: id.to_string(),
            question: id.to_string(),
            is_secret: false,
            options: Vec::new(),
        },
    }
}

fn string_property_options(
    schema: &agent_client_protocol::schema::StringPropertySchema,
) -> Vec<NativeAiUserInputQuestionOptionPayload> {
    if let Some(options) = &schema.one_of {
        return options
            .iter()
            .map(|option| NativeAiUserInputQuestionOptionPayload {
                label: option.value.clone(),
                description: Some(option.title.clone()),
            })
            .collect();
    }

    schema
        .enum_values
        .as_ref()
        .map(|values| {
            values
                .iter()
                .map(|value| NativeAiUserInputQuestionOptionPayload {
                    label: value.clone(),
                    description: None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn multi_select_options(items: &MultiSelectItems) -> Vec<NativeAiUserInputQuestionOptionPayload> {
    match items {
        MultiSelectItems::Untitled(items) => items
            .values
            .iter()
            .map(|value| NativeAiUserInputQuestionOptionPayload {
                label: value.clone(),
                description: None,
            })
            .collect(),
        MultiSelectItems::Titled(items) => items
            .options
            .iter()
            .map(|option| NativeAiUserInputQuestionOptionPayload {
                label: option.value.clone(),
                description: Some(option.title.clone()),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn create_elicitation_response_from_input(
    input: NativeAiUserInputResponseInput,
    schema: &BTreeMap<String, ElicitationAnswerKind>,
) -> CreateElicitationResponse {
    let mut content = BTreeMap::new();
    for answer in input.answers {
        let values = answer
            .answers
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>();
        if values.is_empty() {
            continue;
        }
        let kind = schema
            .get(&answer.question_id)
            .copied()
            .unwrap_or(ElicitationAnswerKind::String);
        if let Some(value) = elicitation_content_value(kind, values) {
            content.insert(answer.question_id, value);
        }
    }

    if content.is_empty() {
        return CreateElicitationResponse::new(ElicitationAction::Cancel);
    }

    CreateElicitationResponse::new(ElicitationAction::Accept(
        ElicitationAcceptAction::new().content(content),
    ))
}

fn elicitation_content_value(
    kind: ElicitationAnswerKind,
    values: Vec<String>,
) -> Option<ElicitationContentValue> {
    match kind {
        ElicitationAnswerKind::Array => Some(ElicitationContentValue::StringArray(values)),
        ElicitationAnswerKind::Boolean => values
            .first()
            .and_then(|value| match value.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" => Some(true),
                "false" | "0" | "no" => Some(false),
                _ => None,
            })
            .map(ElicitationContentValue::Boolean),
        ElicitationAnswerKind::Integer => values
            .first()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .map(ElicitationContentValue::Integer),
        ElicitationAnswerKind::Number => values
            .first()
            .and_then(|value| value.trim().parse::<f64>().ok())
            .map(ElicitationContentValue::Number),
        ElicitationAnswerKind::String => match values.as_slice() {
            [value] => Some(ElicitationContentValue::String(value.clone())),
            _ => Some(ElicitationContentValue::StringArray(values)),
        },
    }
}

fn stop_reason_label(reason: StopReason) -> &'static str {
    match reason {
        StopReason::EndTurn => "end_turn",
        StopReason::MaxTokens => "max_tokens",
        StopReason::MaxTurnRequests => "max_turn_requests",
        StopReason::Refusal => "refusal",
        StopReason::Cancelled => "cancelled",
        _ => "unknown",
    }
}

#[derive(Clone)]
struct NotificationContext {
    inner: Arc<Mutex<NotificationContextInner>>,
}

impl NotificationContext {
    fn new(
        session: NativeAiSession,
        event_sender: Option<std_mpsc::SyncSender<AiRuntimeEvent>>,
        persisted_subagent_session_mappings: Vec<NativeAiRuntimeSessionMapping>,
        supports_subagents: bool,
    ) -> Self {
        let inner = NotificationContextInner::new(
            session,
            event_sender,
            persisted_subagent_session_mappings,
            supports_subagents,
        );
        Self {
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    fn set_runtime_session_id(&self, runtime_session_id: RuntimeSessionId) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.set_root_runtime_session_id(runtime_session_id);
        }
    }

    fn set_loading_persisted_session(&self, loading: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.loading_persisted_session = loading;
        }
    }

    fn handle(&self, notification: SessionNotification) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.handle(notification);
        }
    }

    fn complete_open_messages(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.complete_open_messages();
        }
    }

    fn flush_runtime_messages(&self, runtime_session_id: &RuntimeSessionId) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.flush_runtime_messages(runtime_session_id);
        }
    }

    fn ensure_known_runtime_session(
        &self,
        runtime_session_id: &RuntimeSessionId,
        fallback_title: Option<&str>,
    ) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.ensure_known_runtime_session(runtime_session_id, fallback_title);
        }
    }

    fn summary_for_runtime_session(
        &self,
        runtime_session_id: &RuntimeSessionId,
    ) -> Option<NativeAiSessionSummary> {
        self.inner
            .lock()
            .ok()
            .map(|inner| inner.summary_for_runtime_session(runtime_session_id))
    }
}

struct NotificationContextInner {
    active_subagent_runtime_session_ids: HashSet<String>,
    app_session_id_by_runtime_session_id: HashMap<String, SessionId>,
    event_sender: Option<std_mpsc::SyncSender<AiRuntimeEvent>>,
    image_generation_created_at: HashMap<String, String>,
    loading_persisted_session: bool,
    open_messages: HashMap<String, StreamedMessage>,
    pending_content_chunks: HashMap<String, Vec<PendingContentChunk>>,
    pending_unknown_runtime_tool_activities: HashMap<String, Vec<PendingToolActivity>>,
    runtime_session_id: Option<RuntimeSessionId>,
    session: NativeAiSession,
    subagents_by_runtime_session_id: HashMap<String, SubagentRuntimeSession>,
    structured_subagent_runtime_session_ids: HashSet<String>,
    subagent_active_turn_ids: HashMap<String, String>,
    supports_subagents: bool,
    synthetic_message_ids: HashMap<String, String>,
    synthetic_message_next_id: usize,
    terminal_output_buffers: HashMap<String, String>,
    tool_calls: HashMap<String, ToolCall>,
}

struct PendingContentChunk {
    chunk: ContentChunk,
    message_kind: &'static str,
}

#[derive(Clone)]
struct PendingToolActivity {
    diffs: Vec<serde_json::Value>,
    kind: String,
    raw_input: Option<serde_json::Value>,
    raw_output: Option<serde_json::Value>,
    status: String,
    summary: Option<String>,
    terminal_output: Option<String>,
    exit_code: Option<i32>,
    title: String,
    tool_call_id: NativeToolCallId,
}

#[derive(Clone)]
struct TerminalToolUpdate {
    terminal_output: Option<String>,
    exit_code: Option<i32>,
}

#[derive(Clone)]
struct SubagentRuntimeSession {
    parent_session_id: SessionId,
    runtime_session_id: RuntimeSessionId,
    session_id: SessionId,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
    title: String,
}

impl NotificationContextInner {
    fn new(
        session: NativeAiSession,
        event_sender: Option<std_mpsc::SyncSender<AiRuntimeEvent>>,
        persisted_subagent_session_mappings: Vec<NativeAiRuntimeSessionMapping>,
        supports_subagents: bool,
    ) -> Self {
        let mut app_session_id_by_runtime_session_id = HashMap::new();
        let mut subagents_by_runtime_session_id = HashMap::new();

        if supports_subagents {
            for mapping in persisted_subagent_session_mappings {
                app_session_id_by_runtime_session_id.insert(
                    mapping.runtime_session_id.0.clone(),
                    mapping.app_session_id.clone(),
                );
                if mapping
                    .parent_app_session_id
                    .as_ref()
                    .is_some_and(|parent_session_id| parent_session_id == &session.session_id)
                {
                    subagents_by_runtime_session_id.insert(
                        mapping.runtime_session_id.0.clone(),
                        SubagentRuntimeSession {
                            parent_session_id: session.session_id.clone(),
                            runtime_session_id: mapping.runtime_session_id.clone(),
                            session_id: mapping.app_session_id,
                            model_id: None,
                            reasoning_effort: None,
                            title: "Subagent".to_string(),
                        },
                    );
                }
            }
        }

        if let Some(runtime_session_id) = session.runtime_session_id.clone() {
            app_session_id_by_runtime_session_id
                .insert(runtime_session_id.0.clone(), session.session_id.clone());
        }

        Self {
            active_subagent_runtime_session_ids: HashSet::new(),
            app_session_id_by_runtime_session_id,
            event_sender,
            image_generation_created_at: HashMap::new(),
            loading_persisted_session: false,
            open_messages: HashMap::new(),
            pending_content_chunks: HashMap::new(),
            pending_unknown_runtime_tool_activities: HashMap::new(),
            runtime_session_id: session.runtime_session_id.clone(),
            session,
            subagents_by_runtime_session_id,
            structured_subagent_runtime_session_ids: HashSet::new(),
            subagent_active_turn_ids: HashMap::new(),
            supports_subagents,
            synthetic_message_ids: HashMap::new(),
            synthetic_message_next_id: 1,
            terminal_output_buffers: HashMap::new(),
            tool_calls: HashMap::new(),
        }
    }

    fn set_root_runtime_session_id(&mut self, runtime_session_id: RuntimeSessionId) {
        self.runtime_session_id = Some(runtime_session_id.clone());
        self.app_session_id_by_runtime_session_id.insert(
            runtime_session_id.0.clone(),
            self.session.session_id.clone(),
        );
    }

    fn handle(&mut self, notification: SessionNotification) {
        let runtime_session_id = RuntimeSessionId(notification.session_id.to_string());
        let notification_meta = notification.meta;
        if self.loading_persisted_session
            && should_suppress_persisted_load_notification(&notification.update)
        {
            return;
        }
        match notification.update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                let meta = merged_meta(notification_meta.as_ref(), chunk.meta.as_ref());
                if meta_references_subagent(&meta) {
                    self.ensure_subagent_runtime_session_from_meta(
                        &runtime_session_id,
                        &meta,
                        None,
                    );
                }
                self.handle_content_chunk(&runtime_session_id, "assistant", chunk);
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                let meta = merged_meta(notification_meta.as_ref(), chunk.meta.as_ref());
                if meta_references_subagent(&meta) {
                    self.ensure_subagent_runtime_session_from_meta(
                        &runtime_session_id,
                        &meta,
                        None,
                    );
                }
                self.handle_content_chunk(&runtime_session_id, "thinking", chunk);
            }
            SessionUpdate::ToolCall(tool_call) => {
                let meta = merged_meta(notification_meta.as_ref(), tool_call.meta.as_ref());
                self.prepare_runtime_session_event(&runtime_session_id, Some(&meta), None);
                self.complete_runtime_messages(&runtime_session_id);
                self.handle_subagent_lifecycle_from_meta(&runtime_session_id, &meta);
                self.handle_tool_call(&runtime_session_id, tool_call, &meta);
            }
            SessionUpdate::ToolCallUpdate(tool_call_update) => {
                let meta = merged_meta(notification_meta.as_ref(), tool_call_update.meta.as_ref());
                self.prepare_runtime_session_event(&runtime_session_id, Some(&meta), None);
                self.complete_runtime_messages(&runtime_session_id);
                self.handle_subagent_lifecycle_from_meta(&runtime_session_id, &meta);
                self.handle_tool_call_update(&runtime_session_id, tool_call_update, &meta);
            }
            SessionUpdate::Plan(plan) => {
                self.prepare_runtime_session_event(&runtime_session_id, None, None);
                self.complete_runtime_messages(&runtime_session_id);
                self.emit(
                    AI_PLAN_UPDATED_EVENT,
                    &NativeAiPlanUpdatedPayload {
                        base: self.event_base_for_runtime_session(&runtime_session_id),
                        title: None,
                        entries: plan
                            .entries
                            .into_iter()
                            .map(|entry| NativeAiPlanEntryPayload {
                                content: entry.content,
                                priority: serde_label(&entry.priority),
                                status: serde_label(&entry.status),
                            })
                            .collect(),
                    },
                );
            }
            SessionUpdate::UsageUpdate(usage) => {
                self.prepare_runtime_session_event(&runtime_session_id, None, None);
                self.emit(
                    AI_TOKEN_USAGE_EVENT,
                    &NativeAiTokenUsagePayload {
                        base: self.event_base_for_runtime_session(&runtime_session_id),
                        cost: usage.cost.map(|cost| NativeAiTokenUsageCost {
                            amount: cost.amount,
                            currency: cost.currency,
                        }),
                        size: usage.size,
                        used: usage.used,
                    },
                );
            }
            SessionUpdate::SessionInfoUpdate(info) => {
                let meta = merged_meta(notification_meta.as_ref(), info.meta.as_ref());
                self.handle_session_info_update(&runtime_session_id, info, &meta);
            }
            SessionUpdate::AvailableCommandsUpdate(update) => {
                self.prepare_runtime_session_event(&runtime_session_id, None, None);
                self.handle_available_commands_update(&runtime_session_id, update);
            }
            SessionUpdate::ConfigOptionUpdate(update) => {
                self.prepare_runtime_session_event(&runtime_session_id, None, None);
                self.handle_config_option_update(&runtime_session_id, update);
            }
            SessionUpdate::CurrentModeUpdate(update) => {
                self.prepare_runtime_session_event(&runtime_session_id, update.meta.as_ref(), None);
                self.handle_current_mode_update(
                    &runtime_session_id,
                    update.current_mode_id.0.to_string(),
                );
            }
            SessionUpdate::UserMessageChunk(chunk) => {
                if self.supports_subagents
                    && self.runtime_session_id.as_ref() != Some(&runtime_session_id)
                {
                    self.handle_user_message_chunk(&runtime_session_id, chunk);
                }
            }
            _ => {}
        }
    }

    fn handle_user_message_chunk(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        chunk: ContentChunk,
    ) {
        if !self.is_known_runtime_session(runtime_session_id) {
            self.ensure_known_runtime_session(runtime_session_id, None);
            if !self.is_known_runtime_session(runtime_session_id) {
                self.pending_content_chunks
                    .entry(runtime_session_id.0.clone())
                    .or_default()
                    .push(PendingContentChunk {
                        chunk,
                        message_kind: "user",
                    });
                return;
            }
        }

        let delta = content_block_text(&chunk.content);
        if delta.is_empty() {
            return;
        }

        self.mark_subagent_active(runtime_session_id);

        let message_id = self.resolve_stream_message_id(runtime_session_id, "user", &chunk);
        let summary = self.summary_for_runtime_session(runtime_session_id);
        self.emit(
            AI_MESSAGE_STARTED_EVENT,
            &message_started(&summary, MessageId(message_id.clone()), "user"),
        );
        self.emit(
            AI_MESSAGE_DELTA_EVENT,
            &message_delta(
                &summary,
                MessageId(message_id.clone()),
                "user",
                delta.clone(),
                delta,
            ),
        );
        self.emit(
            AI_MESSAGE_COMPLETED_EVENT,
            &message_completed(&summary, MessageId(message_id), "user"),
        );
        self.clear_synthetic_message_id(runtime_session_id, "user");
    }

    fn handle_content_chunk(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        message_kind: &'static str,
        chunk: ContentChunk,
    ) {
        if !self.is_known_runtime_session(runtime_session_id) {
            self.ensure_known_runtime_session(runtime_session_id, None);
            if !self.is_known_runtime_session(runtime_session_id) {
                self.pending_content_chunks
                    .entry(runtime_session_id.0.clone())
                    .or_default()
                    .push(PendingContentChunk {
                        chunk,
                        message_kind,
                    });
                return;
            }
        }

        let delta = content_block_text(&chunk.content);
        if delta.is_empty() {
            return;
        }

        self.mark_subagent_active(runtime_session_id);

        let message_id = self.resolve_stream_message_id(runtime_session_id, message_kind, &chunk);
        let stream_key = stream_message_key(runtime_session_id, message_kind, &message_id);
        let is_new = !self.open_messages.contains_key(&stream_key);
        if is_new {
            let summary = self.summary_for_runtime_session(runtime_session_id);
            let payload = if message_kind == "thinking" {
                AiRuntimeEvent::new(
                    AI_THINKING_STARTED_EVENT,
                    &message_started(&summary, MessageId(message_id.clone()), message_kind),
                )
            } else {
                AiRuntimeEvent::new(
                    AI_MESSAGE_STARTED_EVENT,
                    &message_started(&summary, MessageId(message_id.clone()), message_kind),
                )
            };
            self.send(payload);
        }

        {
            let message = self
                .open_messages
                .entry(stream_key)
                .or_insert_with(|| StreamedMessage {
                    content: String::new(),
                    pending_delta: String::new(),
                    kind: message_kind,
                    message_id: message_id.clone(),
                    runtime_session_id: runtime_session_id.clone(),
                });
            message.content.push_str(&delta);
            message.pending_delta.push_str(&delta);
        }
        self.flush_message_delta(runtime_session_id, message_kind, &message_id);
    }

    fn handle_tool_call(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        tool_call: ToolCall,
        meta: &Meta,
    ) {
        if should_suppress_status_tool_call(&tool_call, meta) {
            return;
        }

        let tool_call = self.upsert_tool_call(runtime_session_id, tool_call, meta);
        let tool_call_id = NativeToolCallId(tool_call.tool_call_id.to_string());
        if is_image_generation_tool_update(&tool_call_id, meta) {
            self.emit_image_generation(runtime_session_id, &tool_call_id, &tool_call);
            return;
        }
        let terminal_update = self.consume_terminal_meta(runtime_session_id, meta);
        let diffs = self.tool_call_activity_diffs_for_runtime_session(
            runtime_session_id,
            tool_call_id.clone(),
            &tool_call,
            tool_call.meta.as_ref().unwrap_or(meta),
            terminal_update.clone(),
        );
        self.emit(
            AI_TOOL_ACTIVITY_EVENT,
            &NativeAiToolActivityPayload {
                base: self.event_base_for_runtime_session(runtime_session_id),
                kind: serde_label(&tool_call.kind),
                status: serde_label(&tool_call.status),
                summary: tool_call_summary(&tool_call),
                raw_input: tool_call.raw_input.clone(),
                raw_output: tool_call.raw_output.clone(),
                title: tool_call.title,
                tool_call_id: tool_call_id.clone(),
                diffs,
                terminal_output: terminal_update.terminal_output,
                exit_code: terminal_update.exit_code,
            },
        );
        self.emit_subagent_breadcrumb(runtime_session_id, tool_call_id, meta);
    }

    fn handle_tool_call_update(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        tool_call_update: ToolCallUpdate,
        meta: &Meta,
    ) {
        if should_suppress_status_tool_call_update(&tool_call_update, meta) {
            return;
        }

        let Some(tool_call) =
            self.apply_tool_call_update(runtime_session_id, tool_call_update, meta)
        else {
            return;
        };

        let tool_call_id = NativeToolCallId(tool_call.tool_call_id.to_string());
        if is_image_generation_tool_update(&tool_call_id, meta) {
            self.emit_image_generation(runtime_session_id, &tool_call_id, &tool_call);
            return;
        }
        let terminal_update = self.consume_terminal_meta(runtime_session_id, meta);
        let diffs = self.tool_call_activity_diffs_for_runtime_session(
            runtime_session_id,
            tool_call_id.clone(),
            &tool_call,
            tool_call.meta.as_ref().unwrap_or(meta),
            terminal_update.clone(),
        );
        self.emit(
            AI_TOOL_ACTIVITY_EVENT,
            &NativeAiToolActivityPayload {
                base: self.event_base_for_runtime_session(runtime_session_id),
                kind: serde_label(&tool_call.kind),
                status: serde_label(&tool_call.status),
                summary: tool_call_summary(&tool_call),
                raw_input: tool_call.raw_input.clone(),
                raw_output: tool_call.raw_output.clone(),
                title: tool_call.title,
                tool_call_id: tool_call_id.clone(),
                diffs,
                terminal_output: terminal_update.terminal_output,
                exit_code: terminal_update.exit_code,
            },
        );
        self.emit_subagent_breadcrumb(runtime_session_id, tool_call_id, meta);
    }

    fn tool_call_activity_diffs_for_runtime_session(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        tool_call_id: NativeToolCallId,
        tool_call: &ToolCall,
        meta: &Meta,
        terminal_update: TerminalToolUpdate,
    ) -> Vec<serde_json::Value> {
        let diffs = tool_call_content_diffs(
            &tool_call.content,
            meta,
            tool_call.raw_output.as_ref(),
            &self.session.scope.cwd,
        );
        if diffs.is_empty() || !self.should_buffer_unknown_runtime_diffs(runtime_session_id) {
            return diffs;
        }

        self.buffer_unknown_runtime_tool_activity(
            runtime_session_id,
            tool_call_id,
            tool_call,
            diffs,
            terminal_update,
        );
        Vec::new()
    }

    fn should_buffer_unknown_runtime_diffs(&self, runtime_session_id: &RuntimeSessionId) -> bool {
        self.supports_subagents
            && self.runtime_session_id.as_ref() != Some(runtime_session_id)
            && !self
                .subagents_by_runtime_session_id
                .contains_key(&runtime_session_id.0)
    }

    fn buffer_unknown_runtime_tool_activity(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        tool_call_id: NativeToolCallId,
        tool_call: &ToolCall,
        diffs: Vec<serde_json::Value>,
        terminal_update: TerminalToolUpdate,
    ) {
        let pending = PendingToolActivity {
            diffs,
            kind: serde_label(&tool_call.kind),
            raw_input: tool_call.raw_input.clone(),
            raw_output: tool_call.raw_output.clone(),
            status: serde_label(&tool_call.status),
            summary: tool_call_summary(tool_call),
            terminal_output: terminal_update.terminal_output,
            exit_code: terminal_update.exit_code,
            title: tool_call.title.clone(),
            tool_call_id,
        };
        let bucket = self
            .pending_unknown_runtime_tool_activities
            .entry(runtime_session_id.0.clone())
            .or_default();
        if let Some(existing) = bucket
            .iter_mut()
            .find(|activity| activity.tool_call_id == pending.tool_call_id)
        {
            *existing = pending;
        } else {
            bucket.push(pending);
        }
    }

    fn flush_pending_tool_activities(&mut self, runtime_session_id: &RuntimeSessionId) {
        let Some(activities) = self
            .pending_unknown_runtime_tool_activities
            .remove(&runtime_session_id.0)
        else {
            return;
        };

        for activity in activities {
            self.emit(
                AI_TOOL_ACTIVITY_EVENT,
                &NativeAiToolActivityPayload {
                    base: self.event_base_for_runtime_session(runtime_session_id),
                    kind: activity.kind,
                    raw_input: activity.raw_input,
                    raw_output: activity.raw_output,
                    status: activity.status,
                    summary: activity.summary,
                    title: activity.title,
                    tool_call_id: activity.tool_call_id,
                    diffs: activity.diffs,
                    terminal_output: activity.terminal_output,
                    exit_code: activity.exit_code,
                },
            );
        }
    }

    fn consume_terminal_meta(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        meta: &Meta,
    ) -> TerminalToolUpdate {
        let mut terminal_output = self.consume_terminal_output_meta(runtime_session_id, meta);
        let mut exit_code = None;

        if let Some(exit_meta) = meta
            .get(ACP_TERMINAL_EXIT_META_KEY)
            .and_then(serde_json::Value::as_object)
        {
            let terminal_id = exit_meta
                .get(ACP_TERMINAL_ID_META_KEY)
                .and_then(serde_json::Value::as_str);
            if let Some(code) = exit_meta
                .get(ACP_TERMINAL_EXIT_CODE_META_KEY)
                .and_then(serde_json::Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
            {
                exit_code = Some(code);
            }
            if let Some(terminal_id) = terminal_id {
                let buffer_key = terminal_output_buffer_key(runtime_session_id, terminal_id);
                if let Some(final_output) = self.terminal_output_buffers.remove(&buffer_key) {
                    terminal_output = Some(final_output);
                }
            }
        }

        TerminalToolUpdate {
            terminal_output,
            exit_code,
        }
    }

    fn consume_terminal_output_meta(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        meta: &Meta,
    ) -> Option<String> {
        let output_meta = meta
            .get(ACP_TERMINAL_OUTPUT_META_KEY)
            .and_then(serde_json::Value::as_object)?;
        let terminal_id = output_meta
            .get(ACP_TERMINAL_ID_META_KEY)
            .and_then(serde_json::Value::as_str)?;
        let data = output_meta
            .get(ACP_TERMINAL_OUTPUT_DATA_META_KEY)
            .and_then(serde_json::Value::as_str)?;
        let mode = output_meta
            .get(ACP_TERMINAL_OUTPUT_MODE_META_KEY)
            .and_then(serde_json::Value::as_str);
        let buffer_key = terminal_output_buffer_key(runtime_session_id, terminal_id);
        let previous = self
            .terminal_output_buffers
            .get(&buffer_key)
            .map(String::as_str)
            .unwrap_or_default();
        let next = merge_terminal_output_buffer(previous, data, mode);
        self.terminal_output_buffers
            .insert(buffer_key, next.clone());
        Some(next)
    }

    fn emit_image_generation(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        tool_call_id: &NativeToolCallId,
        tool_call: &ToolCall,
    ) {
        let base = self.event_base_for_runtime_session(runtime_session_id);
        let created_at = self
            .image_generation_created_at
            .entry(tool_call_id.0.clone())
            .or_insert_with(|| base.updated_at.clone())
            .clone();
        let message = image_generation_message(tool_call_id, tool_call, created_at);
        if message.status == "completed" {
            self.image_generation_created_at.remove(&tool_call_id.0);
        }
        self.emit(
            AI_IMAGE_GENERATION_EVENT,
            &NativeAiImageGenerationPayload { base, message },
        );
    }

    fn upsert_tool_call(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        mut tool_call: ToolCall,
        meta: &Meta,
    ) -> ToolCall {
        merge_tool_call_meta(&mut tool_call, meta.clone());
        let key = tool_call_state_key(runtime_session_id, &tool_call.tool_call_id.to_string());
        self.tool_calls.insert(key, tool_call.clone());
        tool_call
    }

    fn apply_tool_call_update(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        mut tool_call_update: ToolCallUpdate,
        meta: &Meta,
    ) -> Option<ToolCall> {
        let resolved_tool_call_id =
            self.resolve_tool_call_id_for_update(runtime_session_id, &tool_call_update);
        tool_call_update.tool_call_id = resolved_tool_call_id.into();
        let key = tool_call_state_key(
            runtime_session_id,
            &tool_call_update.tool_call_id.to_string(),
        );
        if let Some(existing) = self.tool_calls.get_mut(&key) {
            existing.update(tool_call_update.fields);
            merge_tool_call_meta(existing, meta.clone());
            return Some(existing.clone());
        }

        tool_call_update.meta = (!meta.is_empty()).then_some(meta.clone());
        let tool_call = ToolCall::try_from(tool_call_update).ok()?;
        self.upsert_tool_call(runtime_session_id, tool_call, meta);
        self.tool_calls.get(&key).cloned()
    }

    fn resolve_tool_call_id_for_update(
        &self,
        runtime_session_id: &RuntimeSessionId,
        tool_call_update: &ToolCallUpdate,
    ) -> String {
        let incoming_id = tool_call_update.tool_call_id.to_string();
        if self
            .tool_calls
            .contains_key(&tool_call_state_key(runtime_session_id, &incoming_id))
        {
            return incoming_id;
        }

        let candidates = self
            .tool_calls
            .iter()
            .filter_map(|(key, candidate)| {
                let expected_key =
                    tool_call_state_key(runtime_session_id, &candidate.tool_call_id.to_string());
                if key == &expected_key && is_canonical_tool_call_candidate(candidate) {
                    Some(candidate)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        if let Some(raw_input) = tool_call_update.fields.raw_input.as_ref() {
            let raw_input_matches = candidates
                .iter()
                .copied()
                .filter(|candidate| {
                    candidate.raw_input.as_ref() == Some(raw_input)
                        && has_same_tool_action_shape(candidate, tool_call_update)
                })
                .collect::<Vec<_>>();
            if raw_input_matches.len() == 1 {
                return raw_input_matches[0].tool_call_id.to_string();
            }
        }

        if !has_weak_tool_action_signal(tool_call_update) {
            return incoming_id;
        }

        let weak_matches = candidates
            .iter()
            .copied()
            .filter(|candidate| has_same_tool_action_shape(candidate, tool_call_update))
            .collect::<Vec<_>>();
        if weak_matches.len() == 1 {
            weak_matches[0].tool_call_id.to_string()
        } else {
            incoming_id
        }
    }

    fn complete_open_messages(&mut self) {
        let messages = std::mem::take(&mut self.open_messages);
        for (_stream_key, mut message) in messages {
            self.emit_pending_message_delta(&mut message);
            let summary = self.summary_for_runtime_session(&message.runtime_session_id);
            if message.kind == "thinking" {
                self.emit(
                    AI_THINKING_COMPLETED_EVENT,
                    &message_completed(&summary, MessageId(message.message_id), message.kind),
                );
            } else {
                self.emit(
                    AI_MESSAGE_COMPLETED_EVENT,
                    &message_completed(&summary, MessageId(message.message_id), message.kind),
                );
            }
        }
        self.synthetic_message_ids.clear();
        self.emit_active_subagent_idle_updates();
    }

    fn handle_session_info_update(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        info: agent_client_protocol::schema::SessionInfoUpdate,
        meta: &Meta,
    ) {
        let title = info
            .title
            .into_option()
            .filter(|title| !title.trim().is_empty());
        if self.handle_turn_lifecycle_update(runtime_session_id, meta) {
            return;
        }
        if meta_string(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY).as_deref()
            == Some(CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE)
            || meta_references_subagent(meta)
        {
            self.ensure_subagent_runtime_session_from_meta(
                runtime_session_id,
                meta,
                title.as_deref(),
            );
            return;
        }

        if !self.is_known_runtime_session(runtime_session_id) {
            self.ensure_known_runtime_session(runtime_session_id, title.as_deref());
        }
        self.flush_runtime_messages(runtime_session_id);

        if let Some(subagent) = self
            .subagents_by_runtime_session_id
            .get_mut(&runtime_session_id.0)
        {
            if let Some(title) = title {
                subagent.title = title;
                let summary = self.summary_for_runtime_session(runtime_session_id);
                self.emit(AI_SESSION_UPDATED_EVENT, &session_updated(&summary));
            }
            return;
        }

        if let Some(title) = title.filter(|title| !is_generic_subagent_title(title)) {
            self.session.title = title;
            let summary = self.summary_for_runtime_session(runtime_session_id);
            self.emit(AI_SESSION_UPDATED_EVENT, &session_updated(&summary));
        }
    }

    fn handle_available_commands_update(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        update: AvailableCommandsUpdate,
    ) {
        self.emit(
            AI_SESSION_CATALOG_UPDATED_EVENT,
            &NativeAiSessionCatalogUpdatedPayload {
                base: self.event_base_for_runtime_session(runtime_session_id),
                available_commands: Some(
                    update
                        .available_commands
                        .into_iter()
                        .map(available_command_payload)
                        .collect(),
                ),
                config_options: None,
                mode_id: None,
            },
        );
    }

    fn handle_config_option_update(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        update: ConfigOptionUpdate,
    ) {
        self.emit(
            AI_SESSION_CATALOG_UPDATED_EVENT,
            &NativeAiSessionCatalogUpdatedPayload {
                base: self.event_base_for_runtime_session(runtime_session_id),
                available_commands: None,
                config_options: Some(
                    update
                        .config_options
                        .into_iter()
                        .map(session_config_option_payload)
                        .collect(),
                ),
                mode_id: None,
            },
        );
    }

    fn handle_current_mode_update(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        mode_id: String,
    ) {
        self.emit(
            AI_SESSION_CATALOG_UPDATED_EVENT,
            &NativeAiSessionCatalogUpdatedPayload {
                base: self.event_base_for_runtime_session(runtime_session_id),
                available_commands: None,
                config_options: None,
                mode_id: Some(mode_id),
            },
        );
    }

    fn handle_turn_lifecycle_update(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        meta: &Meta,
    ) -> bool {
        if meta_string(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY).as_deref()
            != Some(CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE)
        {
            return false;
        }

        let Some(event_type) = meta_string(meta, CODEX_ACP_TURN_EVENT_TYPE_KEY) else {
            return true;
        };
        let turn_id = meta_string(meta, CODEX_ACP_TURN_ID_KEY);

        match event_type.as_str() {
            CODEX_ACP_TURN_STARTED_EVENT_TYPE => {
                if let Some(turn_id) = turn_id {
                    self.subagent_active_turn_ids
                        .insert(runtime_session_id.0.clone(), turn_id);
                }
                self.mark_runtime_session_streaming(runtime_session_id, true);
            }
            CODEX_ACP_TURN_COMPLETE_EVENT_TYPE
            | CODEX_ACP_TURN_ABORTED_EVENT_TYPE
            | CODEX_ACP_SHUTDOWN_COMPLETE_EVENT_TYPE => {
                if self.is_stale_turn_lifecycle(runtime_session_id, turn_id.as_deref()) {
                    return true;
                }
                self.subagent_active_turn_ids.remove(&runtime_session_id.0);
                self.emit_runtime_session_status(runtime_session_id, NativeAiSessionStatus::Idle);
            }
            _ => {}
        }

        true
    }

    fn is_stale_turn_lifecycle(
        &self,
        runtime_session_id: &RuntimeSessionId,
        turn_id: Option<&str>,
    ) -> bool {
        let Some(turn_id) = turn_id else {
            return false;
        };
        self.subagent_active_turn_ids
            .get(&runtime_session_id.0)
            .is_some_and(|active_turn_id| active_turn_id != turn_id)
    }

    fn has_active_turn_lifecycle(&self, runtime_session_id: &RuntimeSessionId) -> bool {
        self.subagent_active_turn_ids
            .contains_key(&runtime_session_id.0)
    }

    fn handle_subagent_lifecycle_from_meta(
        &mut self,
        notification_runtime_session_id: &RuntimeSessionId,
        meta: &Meta,
    ) {
        if meta_string(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY).as_deref()
            != Some(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE)
        {
            return;
        }

        match meta_string(meta, CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY).as_deref() {
            Some("interaction_begin" | "resume_begin" | "close_begin") => {
                if let Some(child_runtime_session_id) =
                    self.child_runtime_session_from_meta(notification_runtime_session_id, meta)
                {
                    self.mark_runtime_session_streaming(&child_runtime_session_id, true);
                }
            }
            Some("interaction_end" | "resume_end" | "close_end") => {
                if let Some(child_runtime_session_id) =
                    self.child_runtime_session_from_meta(notification_runtime_session_id, meta)
                {
                    self.apply_subagent_agent_status_from_meta(
                        &child_runtime_session_id,
                        meta,
                        meta_string(meta, CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY).as_deref()
                            == Some("close_end"),
                    );
                }
            }
            Some("waiting_end") => {
                self.apply_waiting_end_agent_statuses(notification_runtime_session_id, meta);
            }
            _ => {}
        }
    }

    fn child_runtime_session_from_meta(
        &mut self,
        notification_runtime_session_id: &RuntimeSessionId,
        meta: &Meta,
    ) -> Option<RuntimeSessionId> {
        self.ensure_subagent_runtime_session_from_meta(notification_runtime_session_id, meta, None)
            .map(|subagent| subagent.runtime_session_id)
    }

    fn apply_subagent_agent_status_from_meta(
        &mut self,
        child_runtime_session_id: &RuntimeSessionId,
        meta: &Meta,
        close_on_terminal: bool,
    ) {
        let Some(status) = meta.get(CODEX_ACP_AGENT_STATUS_KEY) else {
            return;
        };
        self.apply_subagent_agent_status(child_runtime_session_id, status, close_on_terminal);
    }

    fn apply_waiting_end_agent_statuses(
        &mut self,
        notification_runtime_session_id: &RuntimeSessionId,
        meta: &Meta,
    ) {
        let Some(statuses) = meta
            .get(CODEX_ACP_AGENT_STATUSES_KEY)
            .and_then(|value| value.as_array())
            .cloned()
        else {
            return;
        };

        for status_entry in statuses {
            let Some(entry) = status_entry.as_object() else {
                continue;
            };
            let Some(child_runtime_session_id) = entry
                .get(CODEX_ACP_CHILD_SESSION_ID_KEY)
                .and_then(|value| value.as_str())
                .map(|value| RuntimeSessionId(value.to_string()))
            else {
                continue;
            };
            self.ensure_subagent_runtime_session_from_meta(
                notification_runtime_session_id,
                &entry
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
                None,
            );
            if !self
                .subagents_by_runtime_session_id
                .contains_key(&child_runtime_session_id.0)
            {
                continue;
            }
            let Some(status) = entry.get(CODEX_ACP_AGENT_STATUS_KEY) else {
                continue;
            };
            self.apply_subagent_agent_status(&child_runtime_session_id, status, false);
        }
    }

    fn apply_subagent_agent_status(
        &mut self,
        child_runtime_session_id: &RuntimeSessionId,
        status: &serde_json::Value,
        close_on_terminal: bool,
    ) {
        if agent_status_is_running(status) {
            self.mark_runtime_session_streaming(child_runtime_session_id, true);
            return;
        }
        if agent_status_is_closed(status) || close_on_terminal && agent_status_is_terminal(status) {
            self.emit_runtime_session_closed(child_runtime_session_id);
            return;
        }
        if self.has_active_turn_lifecycle(child_runtime_session_id) {
            return;
        }
        if agent_status_is_error(status) {
            self.emit_runtime_session_status(
                child_runtime_session_id,
                NativeAiSessionStatus::Error,
            );
            return;
        }
        if agent_status_is_terminal(status) {
            self.emit_runtime_session_status(child_runtime_session_id, NativeAiSessionStatus::Idle);
        }
    }

    fn ensure_subagent_runtime_session_from_meta(
        &mut self,
        notification_runtime_session_id: &RuntimeSessionId,
        meta: &Meta,
        fallback_title: Option<&str>,
    ) -> Option<SubagentRuntimeSession> {
        if !self.supports_subagents {
            return None;
        }

        let child_runtime_session_id = meta_string(meta, CODEX_ACP_CHILD_SESSION_ID_KEY)
            .map(RuntimeSessionId)
            .unwrap_or_else(|| notification_runtime_session_id.clone());
        if self
            .subagents_by_runtime_session_id
            .contains_key(&child_runtime_session_id.0)
        {
            let (subagent, title_changed) = {
                let existing = self
                    .subagents_by_runtime_session_id
                    .get_mut(&child_runtime_session_id.0)
                    .expect("subagent exists");
                let title_changed = fallback_title
                    .filter(|title| !title.trim().is_empty())
                    .is_some_and(|title| {
                        if existing.title == title {
                            return false;
                        }
                        existing.title = title.to_string();
                        true
                    });
                (existing.clone(), title_changed)
            };
            if title_changed {
                let summary = self.summary_for_runtime_session(&child_runtime_session_id);
                self.emit(AI_SESSION_UPDATED_EVENT, &session_updated(&summary));
            }
            self.flush_pending_tool_activities(&child_runtime_session_id);
            return Some(subagent);
        }
        let parent_runtime_session_id =
            meta_string(meta, CODEX_ACP_PARENT_SESSION_ID_KEY).map(RuntimeSessionId);
        let parent_session_id = parent_runtime_session_id
            .as_ref()
            .and_then(|runtime_session_id| {
                self.app_session_id_by_runtime_session_id
                    .get(&runtime_session_id.0)
                    .cloned()
            })
            .unwrap_or_else(|| self.session.session_id.clone());
        if parent_session_id != self.session.session_id {
            return None;
        }

        let title = meta_string(meta, CODEX_ACP_AGENT_NICKNAME_KEY)
            .or_else(|| fallback_title.map(ToOwned::to_owned))
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| "Subagent".to_string());
        let model_id =
            meta_string(meta, CODEX_ACP_MODEL_KEY).filter(|model_id| !model_id.trim().is_empty());
        let reasoning_effort = meta_string(meta, CODEX_ACP_REASONING_EFFORT_KEY)
            .filter(|reasoning_effort| !reasoning_effort.trim().is_empty());
        let session_id = self
            .app_session_id_by_runtime_session_id
            .get(&child_runtime_session_id.0)
            .cloned()
            .unwrap_or_else(|| {
                SessionId(format!(
                    "{}:subagent:{}",
                    self.session.session_id.0, child_runtime_session_id.0
                ))
            });
        let subagent = SubagentRuntimeSession {
            parent_session_id,
            runtime_session_id: child_runtime_session_id.clone(),
            session_id: session_id.clone(),
            model_id,
            reasoning_effort,
            title,
        };
        self.app_session_id_by_runtime_session_id
            .insert(child_runtime_session_id.0.clone(), session_id.clone());
        self.subagents_by_runtime_session_id
            .insert(child_runtime_session_id.0.clone(), subagent.clone());
        self.emit(
            AI_SUBAGENT_CREATED_EVENT,
            &NativeAiSubagentCreatedPayload {
                base: self.event_base_for_subagent(&subagent),
                child_runtime_session_id: child_runtime_session_id.clone(),
                child_session_id: session_id,
                parent_runtime_session_id,
                parent_session_id: subagent.parent_session_id.clone(),
                model_id: subagent.model_id.clone(),
                reasoning_effort: subagent.reasoning_effort.clone(),
                title: subagent.title.clone(),
            },
        );
        self.flush_pending_tool_activities(&child_runtime_session_id);
        self.replay_pending_content_chunks(&child_runtime_session_id);
        if self
            .subagent_active_turn_ids
            .contains_key(&child_runtime_session_id.0)
        {
            self.mark_runtime_session_streaming(&child_runtime_session_id, true);
        }
        Some(subagent)
    }

    fn emit_subagent_breadcrumb(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        tool_call_id: NativeToolCallId,
        meta: &Meta,
    ) {
        if meta_string(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY).as_deref()
            != Some(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE)
        {
            return;
        }

        let Some(child_runtime_session_id) =
            meta_string(meta, CODEX_ACP_CHILD_SESSION_ID_KEY).map(RuntimeSessionId)
        else {
            return;
        };
        let subagent = self
            .subagents_by_runtime_session_id
            .get(&child_runtime_session_id.0)
            .cloned()
            .or_else(|| {
                self.ensure_subagent_runtime_session_from_meta(runtime_session_id, meta, None)
            });
        let Some(subagent) = subagent else {
            return;
        };

        self.emit(
            AI_SUBAGENT_BREADCRUMB_EVENT,
            &NativeAiSubagentBreadcrumbPayload {
                base: self.event_base_for_runtime_session(runtime_session_id),
                child_runtime_session_id,
                child_session_id: subagent.session_id,
                tool_call_id,
            },
        );
    }

    fn flush_message_delta(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        message_kind: &str,
        message_id: &str,
    ) {
        let stream_key = stream_message_key(runtime_session_id, message_kind, message_id);
        let mut message = match self.open_messages.remove(&stream_key) {
            Some(message) => message,
            None => return,
        };
        self.emit_pending_message_delta(&mut message);
        self.open_messages.insert(stream_key, message);
    }

    fn flush_runtime_messages(&mut self, runtime_session_id: &RuntimeSessionId) {
        let message_ids = self
            .open_messages
            .values()
            .filter(|message| message.runtime_session_id == *runtime_session_id)
            .map(|message| (message.kind, message.message_id.clone()))
            .collect::<Vec<_>>();
        for (message_kind, message_id) in message_ids {
            self.flush_message_delta(runtime_session_id, message_kind, &message_id);
        }
    }

    fn complete_runtime_messages(&mut self, runtime_session_id: &RuntimeSessionId) {
        let stream_keys = self
            .open_messages
            .iter()
            .filter(|(_key, message)| message.runtime_session_id == *runtime_session_id)
            .map(|(key, _message)| key.clone())
            .collect::<Vec<_>>();

        for stream_key in stream_keys {
            let Some(mut message) = self.open_messages.remove(&stream_key) else {
                continue;
            };
            self.emit_pending_message_delta(&mut message);
            let summary = self.summary_for_runtime_session(&message.runtime_session_id);
            if message.kind == "thinking" {
                self.emit(
                    AI_THINKING_COMPLETED_EVENT,
                    &message_completed(&summary, MessageId(message.message_id), message.kind),
                );
            } else {
                self.emit(
                    AI_MESSAGE_COMPLETED_EVENT,
                    &message_completed(&summary, MessageId(message.message_id), message.kind),
                );
            }
        }

        self.clear_synthetic_message_ids_for_runtime(runtime_session_id);
    }

    fn mark_subagent_active(&mut self, runtime_session_id: &RuntimeSessionId) {
        self.mark_runtime_session_streaming(runtime_session_id, false);
    }

    fn mark_runtime_session_streaming(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        structured: bool,
    ) {
        if self
            .subagents_by_runtime_session_id
            .contains_key(&runtime_session_id.0)
        {
            let became_active = self
                .active_subagent_runtime_session_ids
                .insert(runtime_session_id.0.clone());
            if structured {
                self.structured_subagent_runtime_session_ids
                    .insert(runtime_session_id.0.clone());
            }
            if became_active {
                self.emit_runtime_session_status(
                    runtime_session_id,
                    NativeAiSessionStatus::Streaming,
                );
            }
        }
    }

    fn emit_active_subagent_idle_updates(&mut self) {
        let runtime_session_ids = std::mem::take(&mut self.active_subagent_runtime_session_ids);
        for runtime_session_id in runtime_session_ids {
            if self
                .structured_subagent_runtime_session_ids
                .contains(&runtime_session_id)
                && self
                    .subagent_active_turn_ids
                    .contains_key(&runtime_session_id)
            {
                self.active_subagent_runtime_session_ids
                    .insert(runtime_session_id);
                continue;
            }
            if !self
                .subagents_by_runtime_session_id
                .contains_key(&runtime_session_id)
            {
                continue;
            }
            self.emit_runtime_session_status(
                &RuntimeSessionId(runtime_session_id),
                NativeAiSessionStatus::Idle,
            );
        }
    }

    fn emit_runtime_session_status(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        status: NativeAiSessionStatus,
    ) {
        match status {
            NativeAiSessionStatus::Streaming => {
                if self
                    .subagents_by_runtime_session_id
                    .contains_key(&runtime_session_id.0)
                {
                    self.active_subagent_runtime_session_ids
                        .insert(runtime_session_id.0.clone());
                }
            }
            NativeAiSessionStatus::Idle
            | NativeAiSessionStatus::Error
            | NativeAiSessionStatus::Closed => {
                self.active_subagent_runtime_session_ids
                    .remove(&runtime_session_id.0);
                self.structured_subagent_runtime_session_ids
                    .remove(&runtime_session_id.0);
                self.subagent_active_turn_ids.remove(&runtime_session_id.0);
            }
            _ => {}
        }

        if !self.is_known_runtime_session(runtime_session_id) {
            return;
        }

        let mut summary = self.summary_for_runtime_session(runtime_session_id);
        summary.status = status;
        summary.updated_at = now_iso8601();
        self.emit(AI_SESSION_UPDATED_EVENT, &session_updated(&summary));
    }

    fn emit_runtime_session_closed(&mut self, runtime_session_id: &RuntimeSessionId) {
        self.active_subagent_runtime_session_ids
            .remove(&runtime_session_id.0);
        self.structured_subagent_runtime_session_ids
            .remove(&runtime_session_id.0);
        self.subagent_active_turn_ids.remove(&runtime_session_id.0);

        if !self.is_known_runtime_session(runtime_session_id) {
            return;
        }

        let mut summary = self.summary_for_runtime_session(runtime_session_id);
        summary.status = NativeAiSessionStatus::Closed;
        summary.updated_at = now_iso8601();
        self.emit(AI_SESSION_CLOSED_EVENT, &session_closed(&summary));
    }

    fn prepare_runtime_session_event(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        meta: Option<&Meta>,
        fallback_title: Option<&str>,
    ) {
        if let Some(meta) = meta.filter(|meta| meta_references_subagent(meta)) {
            self.ensure_subagent_runtime_session_from_meta(
                runtime_session_id,
                meta,
                fallback_title,
            );
        }
        self.ensure_known_runtime_session(runtime_session_id, fallback_title);
        self.flush_runtime_messages(runtime_session_id);
    }

    fn ensure_known_runtime_session(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        _fallback_title: Option<&str>,
    ) {
        if self.is_known_runtime_session(runtime_session_id) {
            return;
        }

        if !self.supports_subagents {
            self.app_session_id_by_runtime_session_id.insert(
                runtime_session_id.0.clone(),
                self.session.session_id.clone(),
            );
            self.replay_pending_content_chunks(runtime_session_id);
        }
    }

    fn is_known_runtime_session(&self, runtime_session_id: &RuntimeSessionId) -> bool {
        self.runtime_session_id.as_ref() == Some(runtime_session_id)
            || self
                .subagents_by_runtime_session_id
                .contains_key(&runtime_session_id.0)
            || (!self.supports_subagents
                && self
                    .app_session_id_by_runtime_session_id
                    .get(&runtime_session_id.0)
                    == Some(&self.session.session_id))
    }

    fn replay_pending_content_chunks(&mut self, runtime_session_id: &RuntimeSessionId) {
        let Some(chunks) = self.pending_content_chunks.remove(&runtime_session_id.0) else {
            return;
        };
        for pending in chunks {
            if pending.message_kind == "user" {
                self.handle_user_message_chunk(runtime_session_id, pending.chunk);
            } else {
                self.handle_content_chunk(runtime_session_id, pending.message_kind, pending.chunk);
            }
        }
    }

    fn emit_pending_message_delta(&self, message: &mut StreamedMessage) {
        if message.pending_delta.is_empty() {
            return;
        }

        let summary = self.summary_for_runtime_session(&message.runtime_session_id);
        let pending_delta = std::mem::take(&mut message.pending_delta);
        let payload = message_delta(
            &summary,
            MessageId(message.message_id.clone()),
            message.kind,
            pending_delta,
            message.content.clone(),
        );
        if message.kind == "thinking" {
            self.emit(AI_THINKING_DELTA_EVENT, &payload);
        } else {
            self.emit(AI_MESSAGE_DELTA_EVENT, &payload);
        }
    }

    fn resolve_stream_message_id(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        message_kind: &'static str,
        chunk: &ContentChunk,
    ) -> String {
        if let Some(message_id) = chunk.message_id.as_ref() {
            return runtime_message_id(message_kind, &message_id.to_string());
        }

        let synthetic_key = synthetic_message_key(runtime_session_id, message_kind);
        if let Some(message_id) = self.synthetic_message_ids.get(&synthetic_key) {
            return message_id.clone();
        }

        let message_id = format!("acp:{message_kind}:{}", self.synthetic_message_next_id);
        self.synthetic_message_next_id += 1;
        self.synthetic_message_ids
            .insert(synthetic_key, message_id.clone());
        message_id
    }

    fn clear_synthetic_message_ids_for_runtime(&mut self, runtime_session_id: &RuntimeSessionId) {
        let prefix = format!("{}\u{1f}", runtime_session_id.0);
        self.synthetic_message_ids
            .retain(|key, _message_id| !key.starts_with(&prefix));
    }

    fn clear_synthetic_message_id(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        message_kind: &str,
    ) {
        self.synthetic_message_ids
            .remove(&synthetic_message_key(runtime_session_id, message_kind));
    }

    fn summary_for_runtime_session(
        &self,
        runtime_session_id: &RuntimeSessionId,
    ) -> NativeAiSessionSummary {
        if let Some(subagent) = self
            .subagents_by_runtime_session_id
            .get(&runtime_session_id.0)
        {
            let mut summary = self.session.summary();
            summary.session_id = subagent.session_id.clone();
            summary.runtime_session_id = Some(subagent.runtime_session_id.clone());
            summary.title = subagent.title.clone();
            return summary;
        }

        let mut session = self.session.clone();
        session.runtime_session_id = Some(runtime_session_id.clone());
        session.summary()
    }

    fn event_base_for_runtime_session(
        &self,
        runtime_session_id: &RuntimeSessionId,
    ) -> comando_types::ai::NativeAiEventBase {
        if let Some(subagent) = self
            .subagents_by_runtime_session_id
            .get(&runtime_session_id.0)
        {
            return self.event_base_for_subagent(subagent);
        }

        crate::events::event_base(
            &self.session.session_id,
            &self.session.runtime_id,
            Some(runtime_session_id.clone()),
            now_iso8601(),
        )
    }

    fn event_base_for_subagent(
        &self,
        subagent: &SubagentRuntimeSession,
    ) -> comando_types::ai::NativeAiEventBase {
        crate::events::event_base(
            &subagent.session_id,
            &self.session.runtime_id,
            Some(subagent.runtime_session_id.clone()),
            now_iso8601(),
        )
    }

    fn emit<T: serde::Serialize>(&self, event_name: impl Into<String>, payload: &T) {
        self.send(AiRuntimeEvent::new(event_name, payload));
    }

    fn send(&self, event: AiRuntimeEvent) {
        if let Some(sender) = &self.event_sender {
            let _ = sender.send(event);
        }
    }
}

fn should_suppress_persisted_load_notification(update: &SessionUpdate) -> bool {
    matches!(
        update,
        SessionUpdate::AgentMessageChunk(_)
            | SessionUpdate::AgentThoughtChunk(_)
            | SessionUpdate::ToolCall(_)
            | SessionUpdate::ToolCallUpdate(_)
            | SessionUpdate::Plan(_)
            | SessionUpdate::UsageUpdate(_)
            | SessionUpdate::UserMessageChunk(_)
    )
}

struct StreamedMessage {
    content: String,
    kind: &'static str,
    message_id: String,
    pending_delta: String,
    runtime_session_id: RuntimeSessionId,
}

fn stream_message_key(
    runtime_session_id: &RuntimeSessionId,
    message_kind: &str,
    message_id: &str,
) -> String {
    format!(
        "{}\u{1f}{message_kind}\u{1f}{message_id}",
        runtime_session_id.0
    )
}

fn synthetic_message_key(runtime_session_id: &RuntimeSessionId, message_kind: &str) -> String {
    format!("{}\u{1f}{message_kind}", runtime_session_id.0)
}

fn runtime_message_id(message_kind: &str, message_id: &str) -> String {
    if message_kind == "thinking" {
        return format!("acp:thinking:{message_id}");
    }
    message_id.to_string()
}

fn available_command_payload(command: AvailableCommand) -> NativeAiAvailableCommandPayload {
    NativeAiAvailableCommandPayload {
        description: command.description,
        name: command.name,
    }
}

fn session_config_option_payload(
    option: SessionConfigOption,
) -> NativeAiSessionConfigOptionPayload {
    let category = option.category.as_ref().map(config_option_category_label);
    match option.kind {
        SessionConfigKind::Select(select) => NativeAiSessionConfigOptionPayload {
            category,
            current_value: serde_json::Value::String(select.current_value.to_string()),
            description: option.description,
            id: option.id.to_string(),
            name: option.name,
            option_type: "select".to_string(),
            options: Some(select_options_payload(select.options)),
        },
        #[allow(unreachable_patterns)]
        SessionConfigKind::Boolean(boolean) => NativeAiSessionConfigOptionPayload {
            category,
            current_value: serde_json::Value::Bool(boolean.current_value),
            description: option.description,
            id: option.id.to_string(),
            name: option.name,
            option_type: "boolean".to_string(),
            options: None,
        },
        _ => NativeAiSessionConfigOptionPayload {
            category,
            current_value: serde_json::Value::Null,
            description: option.description,
            id: option.id.to_string(),
            name: option.name,
            option_type: "select".to_string(),
            options: Some(Vec::new()),
        },
    }
}

fn select_options_payload(
    options: SessionConfigSelectOptions,
) -> Vec<NativeAiSessionConfigSelectEntryPayload> {
    match options {
        SessionConfigSelectOptions::Ungrouped(options) => options
            .into_iter()
            .map(|option| NativeAiSessionConfigSelectEntryPayload {
                description: option.description,
                group_label: None,
                name: option.name,
                value: option.value.to_string(),
            })
            .collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .into_iter()
            .flat_map(|group| {
                let group_label = group.name;
                group.options.into_iter().map(move |option| {
                    NativeAiSessionConfigSelectEntryPayload {
                        description: option.description,
                        group_label: Some(group_label.clone()),
                        name: option.name,
                        value: option.value.to_string(),
                    }
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn config_option_category_label(category: &SessionConfigOptionCategory) -> String {
    match category {
        SessionConfigOptionCategory::Mode => "mode".to_string(),
        SessionConfigOptionCategory::Model => "model".to_string(),
        SessionConfigOptionCategory::ThoughtLevel => "thought_level".to_string(),
        SessionConfigOptionCategory::Other(value) => value.clone(),
        _ => "other".to_string(),
    }
}

fn merged_meta(notification_meta: Option<&Meta>, update_meta: Option<&Meta>) -> Meta {
    let mut meta = notification_meta.cloned().unwrap_or_default();
    if let Some(update_meta) = update_meta {
        deep_merge_meta(&mut meta, update_meta);
    }
    meta
}

fn merge_tool_call_meta(tool_call: &mut ToolCall, meta: Meta) {
    if meta.is_empty() {
        return;
    }

    deep_merge_meta(tool_call.meta.get_or_insert_with(Meta::default), &meta);
}

fn deep_merge_meta(target: &mut Meta, incoming: &Meta) {
    for (key, value) in incoming {
        match (target.get_mut(key), value) {
            (
                Some(serde_json::Value::Object(target_object)),
                serde_json::Value::Object(incoming_object),
            ) => {
                deep_merge_meta(target_object, incoming_object);
            }
            _ => {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

fn is_canonical_tool_call_candidate(tool_call: &ToolCall) -> bool {
    matches!(
        tool_call.status,
        ToolCallStatus::Pending | ToolCallStatus::InProgress
    )
}

fn has_same_tool_action_shape(tool_call: &ToolCall, update: &ToolCallUpdate) -> bool {
    let update_kind = update
        .fields
        .kind
        .as_ref()
        .and_then(normalize_tool_kind_token);
    let tool_kind = normalize_tool_kind_token(&tool_call.kind);
    if let (Some(update_kind), Some(tool_kind)) = (update_kind.as_deref(), tool_kind.as_deref())
        && update_kind != tool_kind
    {
        return false;
    }

    let update_title = update
        .fields
        .title
        .as_ref()
        .and_then(|title| normalize_tool_action_token(title));
    let tool_title = normalize_tool_action_token(&tool_call.title);
    if let (Some(update_title), Some(tool_title)) = (update_title.as_deref(), tool_title.as_deref())
        && update_title != tool_title
    {
        return false;
    }

    update_kind.is_some() || tool_kind.is_some() || update_title.is_some() || tool_title.is_some()
}

fn has_weak_tool_action_signal(update: &ToolCallUpdate) -> bool {
    matches!(
        update.fields.status,
        Some(ToolCallStatus::Completed | ToolCallStatus::Failed)
    ) || update.fields.raw_output.is_some()
        || update
            .fields
            .content
            .as_ref()
            .is_some_and(|content| !content.is_empty())
}

fn normalize_tool_kind_token(kind: &ToolKind) -> Option<String> {
    if matches!(kind, ToolKind::Other) {
        return None;
    }
    normalize_tool_action_token(&serde_label(kind))
}

fn normalize_tool_action_token(value: &str) -> Option<String> {
    let normalized = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    (!normalized.is_empty()).then_some(normalized)
}

fn tool_call_state_key(runtime_session_id: &RuntimeSessionId, tool_call_id: &str) -> String {
    format!("{}::{tool_call_id}", runtime_session_id.0)
}

fn meta_string(meta: &Meta, key: &str) -> Option<String> {
    meta.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn agent_status_is_running(status: &serde_json::Value) -> bool {
    agent_status_has_variant(status, &["pendinginit", "running"])
}

fn agent_status_is_error(status: &serde_json::Value) -> bool {
    agent_status_has_variant(status, &["errored"])
}

fn agent_status_is_closed(status: &serde_json::Value) -> bool {
    agent_status_has_variant(status, &["notfound"])
}

fn agent_status_is_terminal(status: &serde_json::Value) -> bool {
    agent_status_has_variant(
        status,
        &["completed", "interrupted", "shutdown", "notfound"],
    )
}

fn agent_status_has_variant(status: &serde_json::Value, expected: &[&str]) -> bool {
    if let Some(status) = status.as_str() {
        return expected.contains(&normalized_status_variant(status).as_str());
    }

    let Some(object) = status.as_object() else {
        return false;
    };

    object
        .keys()
        .any(|key| expected.contains(&normalized_status_variant(key).as_str()))
}

fn normalized_status_variant(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn meta_references_subagent(meta: &Meta) -> bool {
    meta_string(meta, CODEX_ACP_CHILD_SESSION_ID_KEY).is_some()
        || matches!(
            meta_string(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY).as_deref(),
            Some(CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE)
        )
}

fn is_generic_subagent_title(title: &str) -> bool {
    title.trim().eq_ignore_ascii_case("subagent")
}

fn terminal_output_buffer_key(runtime_session_id: &RuntimeSessionId, terminal_id: &str) -> String {
    format!("{}:{terminal_id}", runtime_session_id.0)
}

fn merge_terminal_output_buffer(previous: &str, data: &str, mode: Option<&str>) -> String {
    if data.is_empty() {
        return previous.to_string();
    }

    match mode {
        Some("delta") => trim_terminal_output_buffer(&format!("{previous}{data}")),
        Some("snapshot") => trim_terminal_output_buffer(data),
        _ => merge_legacy_terminal_output_buffer(previous, data),
    }
}

fn merge_legacy_terminal_output_buffer(previous: &str, data: &str) -> String {
    if previous.is_empty() || data.starts_with(previous) {
        return trim_terminal_output_buffer(data);
    }

    if let Some(previous_in_data_index) = data.rfind(previous) {
        return trim_terminal_output_buffer(&format!(
            "{}{}",
            previous,
            &data[previous_in_data_index + previous.len()..]
        ));
    }

    let overlap_length = find_terminal_output_overlap_length(previous, data);
    let overlap_start = next_char_boundary(data, overlap_length);
    trim_terminal_output_buffer(&format!("{}{}", previous, &data[overlap_start..]))
}

fn find_terminal_output_overlap_length(previous: &str, data: &str) -> usize {
    let previous_bytes = previous.as_bytes();
    let data_bytes = data.as_bytes();
    let max_length = previous_bytes.len().min(data_bytes.len());
    for length in (1..=max_length).rev() {
        if previous_bytes.ends_with(&data_bytes[..length]) {
            return length;
        }
    }
    0
}

fn trim_terminal_output_buffer(output: &str) -> String {
    if output.len() > TERMINAL_OUTPUT_MAX_LENGTH {
        let start = output
            .char_indices()
            .map(|(index, _)| index)
            .find(|index| output.len() - *index <= TERMINAL_OUTPUT_MAX_LENGTH)
            .unwrap_or(0);
        output[start..].to_string()
    } else {
        output.to_string()
    }
}

fn next_char_boundary(value: &str, index: usize) -> usize {
    let mut candidate = index.min(value.len());
    while candidate < value.len() && !value.is_char_boundary(candidate) {
        candidate += 1;
    }
    candidate
}

fn should_suppress_status_tool_call(tool_call: &ToolCall, meta: &Meta) -> bool {
    let _ = meta;
    is_suppressed_status_title(&tool_call.title)
}

fn should_suppress_status_tool_call_update(update: &ToolCallUpdate, meta: &Meta) -> bool {
    let _ = meta;
    update
        .fields
        .title
        .as_deref()
        .is_some_and(is_suppressed_status_title)
}

fn is_suppressed_status_title(title: &str) -> bool {
    matches!(
        title.trim(),
        "Preparing input" | "Drafting response" | "Changing files"
    )
}

fn tool_call_content_summary(content: &[ToolCallContent]) -> Option<String> {
    content.iter().find_map(|item| match item {
        ToolCallContent::Content(content) => match &content.content {
            ContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        },
        ToolCallContent::Diff(diff) => Some(format!("Updated {}", diff.path.display())),
        ToolCallContent::Terminal(_) => Some("Terminal output available.".to_string()),
        _ => None,
    })
}

fn tool_call_summary(tool_call: &ToolCall) -> Option<String> {
    tool_call_content_summary(&tool_call.content)
        .or_else(|| raw_tool_output_summary(tool_call.raw_output.as_ref()))
}

fn raw_tool_output_summary(raw_output: Option<&serde_json::Value>) -> Option<String> {
    let raw_output = raw_output?;
    let output = match raw_output {
        serde_json::Value::String(value) => value.clone(),
        value => serde_json::to_string(value).ok()?,
    };

    if output.is_empty() {
        return None;
    }

    if output.len() <= 100 {
        return Some(output);
    }

    let lines = output.lines().count().max(1);
    Some(format!(
        "{lines} line{} of output",
        if lines == 1 { "" } else { "s" }
    ))
}

fn is_image_generation_tool_update(tool_call_id: &NativeToolCallId, meta: &Meta) -> bool {
    tool_call_id
        .0
        .starts_with(CODEX_ACP_IMAGE_GENERATION_EVENT_ID_PREFIX)
        || meta
            .get(CODEX_ACP_STATUS_EVENT_TYPE_KEY)
            .and_then(serde_json::Value::as_str)
            == Some(CODEX_ACP_IMAGE_GENERATION_EVENT_TYPE)
}

fn image_generation_message(
    tool_call_id: &NativeToolCallId,
    tool_call: &ToolCall,
    created_at: String,
) -> NativeAiImageMessage {
    let raw_input = tool_call.raw_input.as_ref();
    let raw_status =
        read_json_string(raw_input, "status").unwrap_or_else(|| serde_label(&tool_call.status));
    let image_status = normalize_image_generation_status(&raw_status);
    let image_path = read_json_string(raw_input, "path");
    let result = read_json_string(raw_input, "result");
    let revised_prompt = read_json_string(raw_input, "revised_prompt")
        .or_else(|| read_json_string(raw_input, "revisedPrompt"));
    let mime_type = read_json_string(raw_input, "mime_type")
        .or_else(|| read_json_string(raw_input, "mimeType"))
        .or_else(|| {
            image_path
                .as_deref()
                .and_then(infer_generated_image_mime_type)
        });
    let is_failure = is_terminal_image_generation_status(&image_status);
    let error = read_json_string(raw_input, "error")
        .or_else(|| is_failure.then(|| result.clone()).flatten());
    let title = if tool_call.title.trim().is_empty() {
        image_generation_title(&image_status, error.as_deref())
    } else {
        tool_call.title.trim().to_string()
    };
    let generated_image = NativeAiGeneratedImage {
        error,
        mime_type,
        path: image_path,
        result,
        revised_prompt,
        status: image_status.clone(),
        title,
    };
    let message_status = if is_active_image_generation_status(&image_status) {
        "streaming"
    } else {
        "completed"
    };

    NativeAiImageMessage {
        attachments: Vec::new(),
        content: image_generation_content(&generated_image),
        created_at,
        generated_image,
        id: format!("image:{}", tool_call_id.0),
        kind: "image".to_string(),
        status: message_status.to_string(),
    }
}

fn read_json_string(value: Option<&serde_json::Value>, key: &str) -> Option<String> {
    value?
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
}

fn normalize_image_generation_status(status: &str) -> String {
    let normalized = status.trim().to_lowercase();
    if normalized.is_empty() {
        "in_progress".to_string()
    } else {
        normalized
    }
}

fn is_active_image_generation_status(status: &str) -> bool {
    matches!(status, "pending" | "in_progress" | "running")
}

fn is_terminal_image_generation_status(status: &str) -> bool {
    matches!(status, "failed" | "error" | "cancelled" | "canceled")
}

fn image_generation_title(status: &str, error: Option<&str>) -> String {
    if is_active_image_generation_status(status) {
        return "Generating image".to_string();
    }
    if is_terminal_image_generation_status(status) || error.is_some() {
        return "Image generation failed".to_string();
    }
    "Generated image".to_string()
}

fn image_generation_content(image: &NativeAiGeneratedImage) -> String {
    if is_active_image_generation_status(&image.status) {
        return "Generating image...".to_string();
    }
    if is_terminal_image_generation_status(&image.status) || image.error.is_some() {
        return "Image generation failed".to_string();
    }
    "Generated image".to_string()
}

fn infer_generated_image_mime_type(path: &str) -> Option<String> {
    let pathname = path.split(['?', '#']).next().unwrap_or(path);
    let extension = pathname.rsplit_once('.')?.1.to_lowercase();
    let mime_type = match extension.as_str() {
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "jpe" | "jpeg" | "jfif" | "jpg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => return None,
    };
    Some(mime_type.to_string())
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ProviderDiffHunk {
    #[serde(alias = "oldStart")]
    old_start: u32,
    #[serde(alias = "oldCount")]
    old_count: u32,
    #[serde(alias = "newStart")]
    new_start: u32,
    #[serde(alias = "newCount")]
    new_count: u32,
    lines: Vec<ProviderDiffHunkLine>,
    #[serde(default = "default_true")]
    old_trailing_newline: bool,
    #[serde(default = "default_true")]
    new_trailing_newline: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ProviderDiffHunkLine {
    #[serde(rename = "type")]
    line_type: String,
    text: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ClaudeStructuredPatchHunk {
    #[serde(alias = "oldStart")]
    old_start: u32,
    #[serde(alias = "oldLines")]
    old_lines: u32,
    #[serde(alias = "newStart")]
    new_start: u32,
    #[serde(alias = "newLines")]
    new_lines: u32,
    lines: Vec<String>,
}

#[derive(Debug, Clone)]
struct AnchoredDiffCandidate {
    changed_new_text: String,
    changed_old_text: String,
    hunks: Vec<comando_diff::AiDiffHunk>,
    match_mode: AnchoredDiffMatchMode,
    new_text: String,
    old_text: String,
    path: Option<String>,
    previous_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnchoredDiffMatchMode {
    Contains,
    Exact,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ToolDiffDedupeKey {
    anchor_key: Option<Vec<(u32, u32, u32, u32)>>,
    new_text: String,
    old_text: Option<String>,
    path: String,
}

fn default_true() -> bool {
    true
}

fn tool_call_content_diffs(
    content: &[ToolCallContent],
    meta: &Meta,
    raw_output: Option<&serde_json::Value>,
    cwd: &str,
) -> Vec<serde_json::Value> {
    let mut seen_plain = HashSet::new();
    let mut seen_projected = HashSet::new();
    let mut claude_candidates = claude_structured_patch_candidates(meta);
    let mut opencode_candidates = opencode_filediff_candidates(raw_output);
    content
        .iter()
        .filter_map(|item| {
            let ToolCallContent::Diff(diff) = item else {
                return None;
            };
            let path = diff.path.to_string_lossy().to_string();
            let old_text = diff.old_text.clone();
            let plain_key = (path.clone(), old_text.clone(), diff.new_text.clone());
            let projected = project_tool_diff(
                diff,
                old_text.as_deref().unwrap_or_default(),
                &path,
                cwd,
                &mut claude_candidates,
                &mut opencode_candidates,
            );
            if projected.anchored {
                let dedupe_key = ToolDiffDedupeKey {
                    anchor_key: Some(projected.hunk_anchor_key()),
                    new_text: diff.new_text.clone(),
                    old_text: old_text.clone(),
                    path: path.clone(),
                };
                if !seen_projected.insert(dedupe_key) {
                    return None;
                }
                seen_plain.insert(plain_key);
            } else if !seen_plain.insert(plain_key) {
                return None;
            }
            let diff_kind = if old_text.is_none() {
                "create"
            } else if projected.previous_path.is_some() {
                "move"
            } else {
                "update"
            };
            Some(serde_json::json!({
                "hunks": projected.hunks,
                "isText": true,
                "kind": diff_kind,
                "newText": diff.new_text,
                "oldText": old_text,
                "path": path,
                "previousPath": projected.previous_path,
                "reversible": true
            }))
        })
        .collect()
}

struct ProjectedToolDiff {
    anchored: bool,
    hunks: Vec<comando_diff::AiDiffHunk>,
    previous_path: Option<String>,
}

impl ProjectedToolDiff {
    fn anchored(
        hunks: Vec<comando_diff::AiDiffHunk>,
        previous_path: Option<String>,
    ) -> ProjectedToolDiff {
        ProjectedToolDiff {
            anchored: true,
            hunks,
            previous_path,
        }
    }

    fn fallback(
        hunks: Vec<comando_diff::AiDiffHunk>,
        previous_path: Option<String>,
    ) -> ProjectedToolDiff {
        ProjectedToolDiff {
            anchored: false,
            hunks,
            previous_path,
        }
    }

    fn hunk_anchor_key(&self) -> Vec<(u32, u32, u32, u32)> {
        self.hunks
            .iter()
            .map(|hunk| {
                (
                    hunk.old_start,
                    hunk.old_count,
                    hunk.new_start,
                    hunk.new_count,
                )
            })
            .collect()
    }
}

fn project_tool_diff(
    diff: &agent_client_protocol::schema::Diff,
    old_text: &str,
    path: &str,
    cwd: &str,
    claude_candidates: &mut [Option<AnchoredDiffCandidate>],
    opencode_candidates: &mut [Option<AnchoredDiffCandidate>],
) -> ProjectedToolDiff {
    let diff_previous_path = read_meta_string(diff.meta.as_ref(), CODEX_ACP_DIFF_PREVIOUS_PATH_KEY);
    if let Some(hunks) = codex_meta_hunks(diff, path) {
        return ProjectedToolDiff::anchored(hunks, diff_previous_path);
    }

    if let Some((hunks, previous_path)) =
        take_matching_anchored_candidate(claude_candidates, diff, old_text, path, cwd)
    {
        return ProjectedToolDiff::anchored(hunks, previous_path.or(diff_previous_path));
    }

    if let Some((hunks, previous_path)) =
        take_matching_anchored_candidate(opencode_candidates, diff, old_text, path, cwd)
    {
        return ProjectedToolDiff::anchored(hunks, previous_path.or(diff_previous_path));
    }

    ProjectedToolDiff::fallback(
        comando_diff::compute_diff_hunks(old_text, &diff.new_text, path),
        diff_previous_path,
    )
}

fn codex_meta_hunks(
    diff: &agent_client_protocol::schema::Diff,
    seed: &str,
) -> Option<Vec<comando_diff::AiDiffHunk>> {
    let meta = diff.meta.as_ref()?;
    let value = meta.get(CODEX_ACP_DIFF_HUNKS_KEY)?.clone();
    let provider_hunks: Vec<ProviderDiffHunk> = serde_json::from_value(value).ok()?;
    provider_hunks_to_ai_hunks(provider_hunks, seed).filter(|hunks| !hunks.is_empty())
}

fn claude_structured_patch_candidates(meta: &Meta) -> Vec<Option<AnchoredDiffCandidate>> {
    let Some(claude_code) = meta
        .get("claudeCode")
        .and_then(serde_json::Value::as_object)
    else {
        return Vec::new();
    };
    let tool_name = claude_code
        .get("toolName")
        .and_then(serde_json::Value::as_str);
    if !matches!(tool_name, Some("Edit" | "Write")) {
        return Vec::new();
    }
    let Some(tool_response) = claude_code
        .get("toolResponse")
        .and_then(serde_json::Value::as_object)
    else {
        return Vec::new();
    };
    let path = tool_response
        .get("filePath")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned);
    let Some(structured_patch) = tool_response.get("structuredPatch") else {
        return Vec::new();
    };
    let Ok(hunks) =
        serde_json::from_value::<Vec<ClaudeStructuredPatchHunk>>(structured_patch.clone())
    else {
        return Vec::new();
    };

    hunks
        .into_iter()
        .enumerate()
        .filter_map(|(index, hunk)| claude_hunk_candidate(path.clone(), index, hunk))
        .map(Some)
        .collect()
}

fn claude_hunk_candidate(
    path: Option<String>,
    index: usize,
    hunk: ClaudeStructuredPatchHunk,
) -> Option<AnchoredDiffCandidate> {
    let (old_text, new_text) = snapshot_texts_from_prefixed_lines(&hunk.lines);
    if old_text.is_empty() && new_text.is_empty() {
        return None;
    }
    let provider_hunk = ProviderDiffHunk {
        old_start: hunk.old_start,
        old_count: hunk.old_lines,
        new_start: hunk.new_start,
        new_count: hunk.new_lines,
        lines: prefixed_lines_to_provider_lines(&hunk.lines),
        old_trailing_newline: false,
        new_trailing_newline: false,
    };
    let seed = path.as_deref().unwrap_or("claude-structured-patch");
    let hunks = provider_hunks_to_ai_hunks(vec![provider_hunk], seed)?;
    Some(AnchoredDiffCandidate {
        changed_new_text: new_text.clone(),
        changed_old_text: old_text.clone(),
        hunks: hunks
            .into_iter()
            .map(|mut hunk| {
                hunk.id = format!(
                    "anchored-diff:{seed}:{}:{}:{index}",
                    hunk.old_start, hunk.new_start
                );
                for (line_index, line) in hunk.lines.iter_mut().enumerate() {
                    line.id = format!(
                        "anchored-line:{seed}:{}:{}:{index}:{line_index}",
                        hunk.old_start, hunk.new_start
                    );
                }
                hunk
            })
            .collect(),
        match_mode: AnchoredDiffMatchMode::Exact,
        new_text,
        old_text,
        path,
        previous_path: None,
    })
}

fn opencode_filediff_candidates(
    raw_output: Option<&serde_json::Value>,
) -> Vec<Option<AnchoredDiffCandidate>> {
    let Some(filediff) = raw_output
        .and_then(|value| value.get("metadata"))
        .and_then(|value| value.get("filediff"))
        .and_then(serde_json::Value::as_object)
    else {
        return Vec::new();
    };
    let path = filediff
        .get("file")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned);
    let Some(patch) = filediff.get("patch").and_then(serde_json::Value::as_str) else {
        return Vec::new();
    };

    parse_unified_patch_hunks(patch)
        .into_iter()
        .enumerate()
        .filter_map(|(index, hunk)| {
            let old_text = hunk_text(&hunk, true);
            let new_text = hunk_text(&hunk, false);
            let changed_old_text = hunk_changed_text(&hunk, true);
            let changed_new_text = hunk_changed_text(&hunk, false);
            if old_text.is_empty() && new_text.is_empty() {
                return None;
            }
            let seed = path.as_deref().unwrap_or("opencode-filediff");
            let hunks = provider_hunks_to_ai_hunks(vec![hunk], seed)?;
            Some(AnchoredDiffCandidate {
                hunks: hunks
                    .into_iter()
                    .map(|mut hunk| {
                        hunk.id = format!(
                            "anchored-diff:{seed}:{}:{}:{index}",
                            hunk.old_start, hunk.new_start
                        );
                        hunk
                    })
                    .collect(),
                changed_new_text,
                changed_old_text,
                match_mode: AnchoredDiffMatchMode::Contains,
                new_text,
                old_text,
                path: path.clone(),
                previous_path: None,
            })
        })
        .map(Some)
        .collect()
}

fn take_matching_anchored_candidate(
    candidates: &mut [Option<AnchoredDiffCandidate>],
    diff: &agent_client_protocol::schema::Diff,
    old_text: &str,
    path: &str,
    cwd: &str,
) -> Option<(Vec<comando_diff::AiDiffHunk>, Option<String>)> {
    let index = candidates.iter().position(|candidate| {
        candidate.as_ref().is_some_and(|candidate| {
            anchored_candidate_matches_diff(candidate, diff, old_text, path, cwd)
        })
    })?;
    let candidate = candidates.get_mut(index)?.take()?;
    Some((candidate.hunks, candidate.previous_path))
}

fn anchored_candidate_matches_diff(
    candidate: &AnchoredDiffCandidate,
    diff: &agent_client_protocol::schema::Diff,
    old_text: &str,
    path: &str,
    cwd: &str,
) -> bool {
    if let Some(candidate_path) = candidate.path.as_deref() {
        if !paths_match(candidate_path, path, cwd) {
            return false;
        }
    }

    match candidate.match_mode {
        AnchoredDiffMatchMode::Exact => {
            old_text == candidate.old_text && diff.new_text == candidate.new_text
        }
        AnchoredDiffMatchMode::Contains => {
            snippet_matches_candidate_text(old_text, &candidate.old_text)
                && snippet_matches_candidate_text(&diff.new_text, &candidate.new_text)
                && changed_text_matches_snippet(&candidate.changed_old_text, old_text)
                && changed_text_matches_snippet(&candidate.changed_new_text, &diff.new_text)
                && (!candidate.changed_old_text.is_empty()
                    || !candidate.changed_new_text.is_empty())
        }
    }
}

fn provider_hunks_to_ai_hunks(
    provider_hunks: Vec<ProviderDiffHunk>,
    seed: &str,
) -> Option<Vec<comando_diff::AiDiffHunk>> {
    provider_hunks
        .into_iter()
        .enumerate()
        .map(|(index, hunk)| provider_hunk_to_ai_hunk(hunk, seed, index))
        .collect()
}

fn provider_hunk_to_ai_hunk(
    hunk: ProviderDiffHunk,
    seed: &str,
    index: usize,
) -> Option<comando_diff::AiDiffHunk> {
    let lines = hunk
        .lines
        .into_iter()
        .enumerate()
        .map(|(line_index, line)| {
            let line_type = match line.line_type.as_str() {
                "add" => comando_diff::AiDiffLineType::Add,
                "remove" => comando_diff::AiDiffLineType::Remove,
                "context" => comando_diff::AiDiffLineType::Context,
                _ => comando_diff::AiDiffLineType::Context,
            };
            comando_diff::AiDiffHunkLine {
                id: format!(
                    "line:{seed}:{}:{}:{line_index}",
                    hunk.old_start, hunk.new_start
                ),
                text: line.text,
                line_type,
            }
        })
        .collect();
    let visual_start_line = hunk.new_start.max(1);
    let visual_end_line = visual_start_line
        .saturating_add(hunk.new_count.max(1))
        .saturating_sub(1);
    Some(comando_diff::AiDiffHunk {
        id: format!("{seed}:{}:{}:{index}", hunk.old_start, hunk.new_start),
        lines,
        new_count: hunk.new_count,
        new_start: hunk.new_start,
        old_count: hunk.old_count,
        old_start: hunk.old_start,
        visual_end_line: Some(visual_end_line),
        visual_start_line: Some(visual_start_line),
    })
}

fn prefixed_lines_to_provider_lines(lines: &[String]) -> Vec<ProviderDiffHunkLine> {
    lines
        .iter()
        .filter_map(|line| {
            if line == r"\ No newline at end of file" {
                return None;
            }
            let (line_type, text) = prefixed_line_parts(line);
            Some(ProviderDiffHunkLine {
                line_type: line_type.to_string(),
                text: text.to_string(),
            })
        })
        .collect()
}

fn snapshot_texts_from_prefixed_lines(lines: &[String]) -> (String, String) {
    let mut old_lines = Vec::new();
    let mut new_lines = Vec::new();
    for line in lines {
        if line == r"\ No newline at end of file" {
            continue;
        }
        let (line_type, text) = prefixed_line_parts(line);
        match line_type {
            "add" => new_lines.push(text.to_string()),
            "remove" => old_lines.push(text.to_string()),
            _ => {
                old_lines.push(text.to_string());
                new_lines.push(text.to_string());
            }
        }
    }
    (old_lines.join("\n"), new_lines.join("\n"))
}

fn prefixed_line_parts(line: &str) -> (&'static str, &str) {
    if let Some(text) = line.strip_prefix('+') {
        ("add", text)
    } else if let Some(text) = line.strip_prefix('-') {
        ("remove", text)
    } else if let Some(text) = line.strip_prefix(' ') {
        ("context", text)
    } else {
        ("context", line)
    }
}

fn parse_unified_patch_hunks(patch: &str) -> Vec<ProviderDiffHunk> {
    let mut hunks = Vec::new();
    let mut current: Option<ProviderDiffHunk> = None;
    let mut previous_line_type: Option<&'static str> = None;

    for line in patch.replace("\r\n", "\n").replace('\r', "\n").lines() {
        if let Some((old_start, old_count, new_start, new_count)) = parse_unified_patch_header(line)
        {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            current = Some(ProviderDiffHunk {
                old_start,
                old_count,
                new_start,
                new_count,
                lines: Vec::new(),
                old_trailing_newline: true,
                new_trailing_newline: true,
            });
            previous_line_type = None;
            continue;
        }

        let Some(hunk) = current.as_mut() else {
            continue;
        };
        if line == r"\ No newline at end of file" {
            match previous_line_type {
                Some("context") => {
                    hunk.old_trailing_newline = false;
                    hunk.new_trailing_newline = false;
                }
                Some("remove") => hunk.old_trailing_newline = false,
                Some("add") => hunk.new_trailing_newline = false,
                _ => {}
            }
            continue;
        }
        let Some((line_type, text)) = line
            .strip_prefix(' ')
            .map(|text| ("context", text))
            .or_else(|| line.strip_prefix('+').map(|text| ("add", text)))
            .or_else(|| line.strip_prefix('-').map(|text| ("remove", text)))
        else {
            continue;
        };
        hunk.lines.push(ProviderDiffHunkLine {
            line_type: line_type.to_string(),
            text: text.to_string(),
        });
        previous_line_type = Some(line_type);
    }

    if let Some(hunk) = current {
        hunks.push(hunk);
    }
    hunks
}

fn parse_unified_patch_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let header = line.strip_prefix("@@ -")?;
    let (old_part, rest) = header.split_once(" +")?;
    let (new_part, _) = rest.split_once(" @@")?;
    let (old_start, old_count) = parse_unified_patch_range(old_part)?;
    let (new_start, new_count) = parse_unified_patch_range(new_part)?;
    Some((old_start, old_count, new_start, new_count))
}

fn parse_unified_patch_range(range: &str) -> Option<(u32, u32)> {
    let (start, count) = range.split_once(',').unwrap_or((range, "1"));
    Some((start.parse().ok()?, count.parse().ok()?))
}

fn hunk_text(hunk: &ProviderDiffHunk, old_side: bool) -> String {
    let mut text = hunk
        .lines
        .iter()
        .filter_map(|line| match (old_side, line.line_type.as_str()) {
            (true, "add") | (false, "remove") => None,
            _ => Some(line.text.clone()),
        })
        .collect::<Vec<_>>()
        .join("\n");
    let has_side_lines = hunk.lines.iter().any(|line| match old_side {
        true => line.line_type != "add",
        false => line.line_type != "remove",
    });
    let has_trailing_newline = if old_side {
        hunk.old_trailing_newline
    } else {
        hunk.new_trailing_newline
    };
    if has_side_lines && has_trailing_newline {
        text.push('\n');
    }
    text
}

fn hunk_changed_text(hunk: &ProviderDiffHunk, old_side: bool) -> String {
    let mut text = hunk
        .lines
        .iter()
        .filter_map(|line| match (old_side, line.line_type.as_str()) {
            (true, "remove") | (false, "add") => Some(line.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let has_changed_lines = !text.is_empty();
    let last_side_line_type = hunk
        .lines
        .iter()
        .rev()
        .find(|line| match old_side {
            true => line.line_type != "add",
            false => line.line_type != "remove",
        })
        .map(|line| line.line_type.as_str());
    let has_trailing_newline = if old_side {
        hunk.old_trailing_newline
    } else {
        hunk.new_trailing_newline
    };
    let last_side_line_is_changed = matches!(
        (old_side, last_side_line_type),
        (true, Some("remove")) | (false, Some("add"))
    );
    if has_changed_lines && has_trailing_newline && last_side_line_is_changed {
        text.push('\n');
    }
    text
}

fn snippet_matches_candidate_text(snippet: &str, candidate_text: &str) -> bool {
    snippet.is_empty() || candidate_text.contains(snippet)
}

fn changed_text_matches_snippet(changed_text: &str, snippet: &str) -> bool {
    changed_text.is_empty() || line_sequence_is_subsequence(changed_text, snippet)
}

fn line_sequence_is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut haystack_lines = haystack.split('\n');
    for needle_line in needle.split('\n') {
        if !haystack_lines.any(|haystack_line| haystack_line == needle_line) {
            return false;
        }
    }
    true
}

fn read_meta_string(meta: Option<&Meta>, key: &str) -> Option<String> {
    meta.and_then(|meta| meta.get(key))
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
}

fn paths_match(candidate_path: &str, diff_path: &str, cwd: &str) -> bool {
    candidate_path == diff_path
        || normalize_diff_path(candidate_path, cwd) == normalize_diff_path(diff_path, cwd)
}

fn normalize_diff_path(path: &str, cwd: &str) -> String {
    let path = Path::new(path);
    let stripped = if path.is_absolute() {
        path.strip_prefix(cwd).unwrap_or(path)
    } else {
        path
    };
    stripped
        .components()
        .as_path()
        .to_string_lossy()
        .trim_start_matches("./")
        .to_string()
}

fn content_block_text(content: &ContentBlock) -> String {
    match content {
        ContentBlock::Text(text) => text.text.clone(),
        _ => serde_json::to_string(content).unwrap_or_default(),
    }
}

fn serde_label<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "unknown".to_string())
}

trait MaybeUndefinedExt<T> {
    fn into_option(self) -> Option<T>;
}

impl<T> MaybeUndefinedExt<T> for agent_client_protocol::schema::MaybeUndefined<T> {
    fn into_option(self) -> Option<T> {
        match self {
            agent_client_protocol::schema::MaybeUndefined::Value(value) => Some(value),
            agent_client_protocol::schema::MaybeUndefined::Null
            | agent_client_protocol::schema::MaybeUndefined::Undefined => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeRegistry;
    use agent_client_protocol::schema::{ToolCallStatus, ToolCallUpdateFields, ToolKind};
    use comando_types::ai::{
        NativeAiAuthHandshakeSpec, NativeAiDesiredSelections, NativeAiImageAttachment,
        NativeAiPrepareSessionInput, NativeAiRuntimeStatus, NativeAiUserInputAnswer,
    };

    fn initialize_response_with_auth(method_id: &str) -> InitializeResponse {
        InitializeResponse::new(ProtocolVersion::V1).auth_methods(vec![
            agent_client_protocol::schema::AuthMethod::Agent(
                agent_client_protocol::schema::AuthMethodAgent::new(
                    method_id.to_string(),
                    method_id.to_string(),
                ),
            ),
        ])
    }

    fn ready_status(runtime_id: &str, command: &str) -> NativeAiRuntimeStatus {
        NativeAiRuntimeStatus {
            runtime_id: RuntimeId(runtime_id.to_string()),
            state: "ready".to_string(),
            auth_method: None,
            auth_methods: Vec::new(),
            auth_ready: true,
            auth_credential_source: None,
            auth_credential_source_label: None,
            auth_session_message: None,
            auth_storage_message: None,
            can_disconnect_auth: false,
            can_logout_auth: false,
            checked_at: now_iso8601(),
            command: Some(command.to_string()),
            available_commands: Vec::new(),
            config_options: Vec::new(),
            message: None,
            mode_id: None,
            modes: Vec::new(),
            model_id: None,
            models: Vec::new(),
            onboarding_required: false,
            source: Some("path".to_string()),
            has_custom_binary_path: false,
            has_gateway_config: false,
            has_gateway_url: false,
        }
    }

    fn launch_spec(runtime_id: &str, executable: &str, args: Vec<&str>) -> NativeAiLaunchSpec {
        let mut env = BTreeMap::new();
        env.insert("OPENAI_API_KEY".to_string(), "sk-secret".to_string());
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        let args = args
            .into_iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();

        let command = std::iter::once(executable.to_string())
            .chain(args.clone())
            .collect::<Vec<_>>()
            .join(" ");

        NativeAiLaunchSpec {
            runtime_id: RuntimeId(runtime_id.to_string()),
            owner_window_id: "window_main".to_string(),
            project_id: None,
            worktree_id: None,
            project_root: Some("/tmp".to_string()),
            additional_roots: Vec::new(),
            executable: executable.to_string(),
            args: args.clone(),
            cwd: "/tmp".to_string(),
            env,
            command: command.clone(),
            status: ready_status(runtime_id, &command),
            auth_method: None,
            auth_credential_source: None,
            auth_handshake: None,
            persisted_runtime_session_id: None,
            persisted_subagent_session_mappings: Vec::new(),
            desired_selections: NativeAiDesiredSelections {
                model_id: None,
                mode_id: None,
                config_options: BTreeMap::new(),
            },
        }
    }

    #[test]
    fn persisted_codex_sessions_use_resume_start_method() {
        let registry = RuntimeRegistry::default();

        let mut codex_launch = launch_spec("codex", "codex-acp", vec![]);
        codex_launch.persisted_runtime_session_id =
            Some(RuntimeSessionId("runtime-codex".to_string()));
        let codex_spec =
            AcpProcessSpec::from_launch(registry.get("codex").unwrap(), &codex_launch).unwrap();

        assert!(codex_spec.supports_resume_session);
        assert_eq!(
            persisted_session_start_method(&codex_spec),
            PersistedSessionStartMethod::Resume
        );

        let mut opencode_launch = launch_spec("opencode", "opencode", vec!["acp"]);
        opencode_launch.persisted_runtime_session_id =
            Some(RuntimeSessionId("runtime-opencode".to_string()));
        let opencode_spec =
            AcpProcessSpec::from_launch(registry.get("opencode").unwrap(), &opencode_launch)
                .unwrap();

        assert!(!opencode_spec.supports_resume_session);
        assert_eq!(
            persisted_session_start_method(&opencode_spec),
            PersistedSessionStartMethod::Load
        );
    }

    fn native_test_session() -> NativeAiSession {
        native_test_session_for_runtime("codex")
    }

    fn native_test_session_for_runtime(runtime_id: &str) -> NativeAiSession {
        NativeAiSession::from_prepare_input(NativeAiPrepareSessionInput {
            window_id: "window-1".to_string(),
            session_id: SessionId("session-1".to_string()),
            runtime_id: RuntimeId(runtime_id.to_string()),
            project_id: None,
            worktree_id: None,
            cwd: "/tmp".to_string(),
            title: "Parent".to_string(),
            model_id: None,
            mode_id: None,
            config_options: BTreeMap::new(),
            additional_roots: Vec::new(),
            persisted_runtime_session_id: None,
            persisted_subagent_session_mappings: Vec::new(),
            launch: None,
        })
        .unwrap()
    }

    fn test_meta(entries: &[(&str, &str)]) -> Meta {
        let mut meta = Meta::new();
        for (key, value) in entries {
            meta.insert(
                (*key).to_string(),
                serde_json::Value::String((*value).to_string()),
            );
        }
        meta
    }

    #[test]
    fn prompt_content_blocks_include_image_attachments() {
        let blocks = prompt_content_blocks(
            "  describe this  ".to_string(),
            vec![NativeAiImageAttachment {
                id: "image-1".to_string(),
                data_base64: "aGVsbG8=".to_string(),
                mime_type: "image/png".to_string(),
                name: Some("capture.png".to_string()),
                size_bytes: Some(5),
            }],
        );

        assert_eq!(blocks.len(), 2);
        match &blocks[0] {
            ContentBlock::Text(text) => assert_eq!(text.text, "describe this"),
            other => panic!("expected text block, got {other:?}"),
        }
        match &blocks[1] {
            ContentBlock::Image(image) => {
                assert_eq!(image.data, "aGVsbG8=");
                assert_eq!(image.mime_type, "image/png");
            }
            other => panic!("expected image block, got {other:?}"),
        }
    }

    #[test]
    fn image_generation_tool_call_maps_to_image_message() {
        let message = image_generation_message(
            &NativeToolCallId("codex-acp:image:ig-1".to_string()),
            &ToolCall::new("codex-acp:image:ig-1", "Generated image")
                .kind(ToolKind::Other)
                .status(ToolCallStatus::Completed)
                .raw_input(serde_json::json!({
                    "path": "/Users/example/.codex/generated_images/image.png",
                    "result": "created image",
                    "revised_prompt": "A tiny brass robot",
                    "status": "completed"
                })),
            "2026-06-20T00:00:00.000Z".to_string(),
        );

        assert_eq!(message.id, "image:codex-acp:image:ig-1");
        assert_eq!(message.kind, "image");
        assert_eq!(message.status, "completed");
        assert_eq!(message.content, "Generated image");
        assert_eq!(
            message.generated_image.mime_type.as_deref(),
            Some("image/png")
        );
        assert_eq!(
            message.generated_image.revised_prompt.as_deref(),
            Some("A tiny brass robot")
        );
    }

    #[test]
    fn emits_initial_config_options_from_session_response() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let session = native_test_session();

        emit_initial_config_options(
            Some(&sender),
            &session,
            &RuntimeSessionId("runtime-parent".to_string()),
            Some(vec![
                SessionConfigOption::select(
                    "model",
                    "Model",
                    "gpt-5",
                    vec![
                        agent_client_protocol::schema::SessionConfigSelectOption::new(
                            "gpt-5", "GPT-5",
                        ),
                    ],
                )
                .category(SessionConfigOptionCategory::Model),
            ]),
        );

        let event = receiver.recv().unwrap();
        assert_eq!(event.event_name, AI_SESSION_CATALOG_UPDATED_EVENT);
        assert_eq!(event.payload["sessionId"], "session-1");
        assert_eq!(event.payload["runtimeSessionId"], "runtime-parent");
        assert_eq!(event.payload["configOptions"][0]["id"], "model");
        assert_eq!(event.payload["configOptions"][0]["currentValue"], "gpt-5");
    }

    #[test]
    fn notification_context_projects_catalog_updates() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AvailableCommandsUpdate(AvailableCommandsUpdate::new(vec![
                AvailableCommand::new("plan", "Create a plan"),
            ])),
        ));
        let commands_event = receiver.recv().unwrap();
        assert_eq!(commands_event.event_name, AI_SESSION_CATALOG_UPDATED_EVENT);
        assert_eq!(
            commands_event.payload["availableCommands"][0]["name"],
            "plan"
        );

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(vec![
                SessionConfigOption::select(
                    "model",
                    "Model",
                    "gpt-5",
                    vec![
                        agent_client_protocol::schema::SessionConfigSelectOption::new(
                            "gpt-5", "GPT-5",
                        )
                        .description("Fast model"),
                    ],
                )
                .category(SessionConfigOptionCategory::Model),
            ])),
        ));
        let config_event = receiver.recv().unwrap();
        assert_eq!(config_event.event_name, AI_SESSION_CATALOG_UPDATED_EVENT);
        assert_eq!(config_event.payload["configOptions"][0]["id"], "model");
        assert_eq!(
            config_event.payload["configOptions"][0]["options"][0]["groupLabel"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn notification_context_keeps_synthetic_message_id_stable_for_chunks_without_ids() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("Hello ".into())),
        ));
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("world".into())),
        ));
        context.complete_open_messages();

        let started = receiver.recv().unwrap();
        let first_delta = receiver.recv().unwrap();
        let second_delta = receiver.recv().unwrap();
        let completed = receiver.recv().unwrap();

        assert_eq!(started.event_name, AI_MESSAGE_STARTED_EVENT);
        assert_eq!(first_delta.event_name, AI_MESSAGE_DELTA_EVENT);
        assert_eq!(second_delta.event_name, AI_MESSAGE_DELTA_EVENT);
        assert_eq!(completed.event_name, AI_MESSAGE_COMPLETED_EVENT);
        assert_eq!(
            started.payload["messageId"],
            first_delta.payload["messageId"]
        );
        assert_eq!(
            started.payload["messageId"],
            second_delta.payload["messageId"]
        );
        assert_eq!(started.payload["messageId"], completed.payload["messageId"]);
        assert_eq!(first_delta.payload["content"], "Hello ");
        assert_eq!(first_delta.payload["delta"], "Hello ");
        assert_eq!(second_delta.payload["content"], "Hello world");
        assert_eq!(second_delta.payload["delta"], "world");
    }

    #[test]
    fn notification_context_suppresses_replayed_load_session_activity() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));
        context.set_loading_persisted_session(true);

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AgentThoughtChunk(ContentChunk::new("Old reasoning".into())),
        ));
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("Old answer".into())),
        ));
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(ToolCall::new("tool-1", "Read file")),
        ));
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AvailableCommandsUpdate(AvailableCommandsUpdate::new(vec![
                AvailableCommand::new("plan", "Create a plan"),
            ])),
        ));

        let catalog_event = receiver.recv().unwrap();
        assert_eq!(catalog_event.event_name, AI_SESSION_CATALOG_UPDATED_EVENT);
        assert!(receiver.try_recv().is_err());

        context.set_loading_persisted_session(false);
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("Live answer".into())),
        ));

        let started = receiver.recv().unwrap();
        let delta = receiver.recv().unwrap();
        assert_eq!(started.event_name, AI_MESSAGE_STARTED_EVENT);
        assert_eq!(delta.event_name, AI_MESSAGE_DELTA_EVENT);
        assert_eq!(delta.payload["content"], "Live answer");
    }

    #[test]
    fn notification_context_separates_thinking_and_assistant_chunks_with_shared_message_id() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        // OpenCode can reuse one ACP messageId for thought and assistant streams.
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AgentThoughtChunk(
                ContentChunk::new("Reasoning".into()).message_id("msg-shared"),
            ),
        ));
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AgentMessageChunk(
                ContentChunk::new("Visible answer".into()).message_id("msg-shared"),
            ),
        ));

        let thinking_started = receiver.recv().unwrap();
        let thinking_delta = receiver.recv().unwrap();
        let message_started = receiver.recv().unwrap();
        let message_delta = receiver.recv().unwrap();

        assert_eq!(thinking_started.event_name, AI_THINKING_STARTED_EVENT);
        assert_eq!(thinking_delta.event_name, AI_THINKING_DELTA_EVENT);
        assert_eq!(message_started.event_name, AI_MESSAGE_STARTED_EVENT);
        assert_eq!(message_delta.event_name, AI_MESSAGE_DELTA_EVENT);
        assert_eq!(
            thinking_delta.payload["messageId"],
            "acp:thinking:msg-shared"
        );
        assert_eq!(message_delta.payload["messageId"], "msg-shared");
        assert_ne!(
            thinking_delta.payload["messageId"],
            message_delta.payload["messageId"]
        );
        assert_eq!(thinking_delta.payload["content"], "Reasoning");
        assert_eq!(message_delta.payload["content"], "Visible answer");
    }

    #[test]
    fn notification_context_emits_image_generation_messages() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(
                ToolCall::new("codex-acp:image:ig-1", "Generating image")
                    .kind(ToolKind::Other)
                    .status(ToolCallStatus::InProgress)
                    .raw_input(serde_json::json!({ "status": "in_progress" })),
            ),
        ));

        let started = receiver.recv().unwrap();
        assert_eq!(started.event_name, AI_IMAGE_GENERATION_EVENT);
        assert_eq!(
            started.payload["message"]["id"],
            "image:codex-acp:image:ig-1"
        );
        assert_eq!(started.payload["message"]["kind"], "image");
        assert_eq!(started.payload["message"]["status"], "streaming");
        assert_eq!(
            started.payload["message"]["generatedImage"]["status"],
            "in_progress"
        );

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                "codex-acp:image:ig-1",
                ToolCallUpdateFields::new()
                    .title("Generated image".to_string())
                    .status(ToolCallStatus::Completed)
                    .raw_input(serde_json::json!({
                        "path": "/Users/example/.codex/generated_images/image.png",
                        "result": "created image",
                        "revised_prompt": "A tiny brass robot",
                        "status": "completed"
                    })),
            )),
        ));

        let completed = receiver.recv().unwrap();
        assert_eq!(completed.event_name, AI_IMAGE_GENERATION_EVENT);
        assert_eq!(completed.payload["message"]["status"], "completed");
        assert_eq!(completed.payload["message"]["content"], "Generated image");
        assert_eq!(
            completed.payload["message"]["createdAt"],
            started.payload["message"]["createdAt"]
        );
        assert_eq!(
            completed.payload["message"]["generatedImage"]["path"],
            "/Users/example/.codex/generated_images/image.png"
        );
    }

    #[test]
    fn notification_context_projects_subagent_sessions_and_breadcrumbs() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-1"),
            (CODEX_ACP_AGENT_NICKNAME_KEY, "Galileo"),
            (CODEX_ACP_MODEL_KEY, "gpt-5"),
            (CODEX_ACP_REASONING_EFFORT_KEY, "high"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-1",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .title("Fallback".to_string())
                        .meta(created_meta.clone()),
                ),
            )
            .meta(created_meta),
        );
        let created_event = receiver.recv().unwrap();
        assert_eq!(created_event.event_name, AI_SUBAGENT_CREATED_EVENT);
        assert_eq!(
            created_event.payload["sessionId"],
            "session-1:subagent:runtime-child-1"
        );
        assert_eq!(created_event.payload["parentSessionId"], "session-1");
        assert_eq!(created_event.payload["modelId"], "gpt-5");
        assert_eq!(created_event.payload["reasoningEffort"], "high");
        assert_eq!(created_event.payload["title"], "Galileo");

        let breadcrumb_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-1"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-parent",
                SessionUpdate::ToolCall(
                    ToolCall::new("codex-acp:subagent:interaction-1", "Contacting subagent")
                        .meta(breadcrumb_meta.clone()),
                ),
            )
            .meta(breadcrumb_meta),
        );

        let tool_event = receiver.recv().unwrap();
        assert_eq!(tool_event.event_name, AI_TOOL_ACTIVITY_EVENT);
        let breadcrumb_event = receiver.recv().unwrap();
        assert_eq!(breadcrumb_event.event_name, AI_SUBAGENT_BREADCRUMB_EVENT);
        assert_eq!(breadcrumb_event.payload["sessionId"], "session-1");
        assert_eq!(
            breadcrumb_event.payload["childSessionId"],
            "session-1:subagent:runtime-child-1"
        );
        assert_eq!(
            breadcrumb_event.payload["toolCallId"],
            "codex-acp:subagent:interaction-1"
        );
    }

    #[test]
    fn notification_context_marks_active_subagents_idle_at_turn_end() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-1"),
            (CODEX_ACP_AGENT_NICKNAME_KEY, "Galileo"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-1",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(created_meta.clone()),
                ),
            )
            .meta(created_meta),
        );
        let created_event = receiver.recv().unwrap();
        assert_eq!(created_event.event_name, AI_SUBAGENT_CREATED_EVENT);
        assert!(created_event.payload.get("reasoningEffort").is_none());

        context.handle(SessionNotification::new(
            "runtime-child-1",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("Child output".into())),
        ));
        let streaming_event = receiver.recv().unwrap();
        assert_eq!(streaming_event.event_name, AI_SESSION_UPDATED_EVENT);
        assert_eq!(
            streaming_event.payload["sessionId"],
            "session-1:subagent:runtime-child-1"
        );
        assert_eq!(streaming_event.payload["status"], "streaming");
        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_MESSAGE_STARTED_EVENT
        );
        assert_eq!(receiver.recv().unwrap().event_name, AI_MESSAGE_DELTA_EVENT);

        context.complete_open_messages();

        let completed_event = receiver.recv().unwrap();
        assert_eq!(completed_event.event_name, AI_MESSAGE_COMPLETED_EVENT);
        assert_eq!(
            completed_event.payload["sessionId"],
            "session-1:subagent:runtime-child-1"
        );

        let idle_event = receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .expect("expected subagent idle session update at turn end");
        assert_eq!(idle_event.event_name, AI_SESSION_UPDATED_EVENT);
        assert_eq!(
            idle_event.payload["sessionId"],
            "session-1:subagent:runtime-child-1"
        );
        assert_eq!(idle_event.payload["status"], "idle");
    }

    #[test]
    fn notification_context_applies_waiting_end_statuses_per_subagent() {
        let (sender, receiver) = std_mpsc::sync_channel(16);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        for child in ["runtime-child-1", "runtime-child-2"] {
            let created_meta = test_meta(&[
                (
                    CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                    CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
                ),
                (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
                (CODEX_ACP_CHILD_SESSION_ID_KEY, child),
            ]);
            context.handle(
                SessionNotification::new(
                    child,
                    SessionUpdate::SessionInfoUpdate(
                        agent_client_protocol::schema::SessionInfoUpdate::new()
                            .meta(created_meta.clone()),
                    ),
                )
                .meta(created_meta),
            );
            assert_eq!(
                receiver.recv().unwrap().event_name,
                AI_SUBAGENT_CREATED_EVENT
            );

            context.handle(SessionNotification::new(
                child,
                SessionUpdate::AgentMessageChunk(ContentChunk::new("Child output".into())),
            ));
            assert_eq!(
                receiver.recv().unwrap().event_name,
                AI_SESSION_UPDATED_EVENT
            );
            assert_eq!(
                receiver.recv().unwrap().event_name,
                AI_MESSAGE_STARTED_EVENT
            );
            assert_eq!(receiver.recv().unwrap().event_name, AI_MESSAGE_DELTA_EVENT);
        }

        let mut waiting_end_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE,
            ),
            (CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY, "waiting_end"),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
        ]);
        waiting_end_meta.insert(
            CODEX_ACP_AGENT_STATUSES_KEY.to_string(),
            serde_json::json!([
                {
                    "codexAcpChildSessionId": "runtime-child-1",
                    "codexAcpAgentStatus": { "completed": "done" }
                },
                {
                    "codexAcpChildSessionId": "runtime-child-2",
                    "codexAcpAgentStatus": "running"
                }
            ]),
        );
        context.handle(
            SessionNotification::new(
                "runtime-parent",
                SessionUpdate::ToolCallUpdate(
                    ToolCallUpdate::new(
                        "codex-acp:subagent:waiting-1",
                        ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
                    )
                    .meta(waiting_end_meta.clone()),
                ),
            )
            .meta(waiting_end_meta),
        );

        let idle_event = receiver.recv().unwrap();
        assert_eq!(idle_event.event_name, AI_SESSION_UPDATED_EVENT);
        assert_eq!(
            idle_event.payload["sessionId"],
            "session-1:subagent:runtime-child-1"
        );
        assert_eq!(idle_event.payload["status"], "idle");
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn notification_context_ignores_stale_waiting_end_while_turn_is_active() {
        let (sender, receiver) = std_mpsc::sync_channel(16);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-1"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-1",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(created_meta.clone()),
                ),
            )
            .meta(created_meta),
        );
        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_SUBAGENT_CREATED_EVENT
        );

        let turn_started_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE,
            ),
            (
                CODEX_ACP_TURN_EVENT_TYPE_KEY,
                CODEX_ACP_TURN_STARTED_EVENT_TYPE,
            ),
            (CODEX_ACP_TURN_ID_KEY, "turn-2"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-1",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(turn_started_meta.clone()),
                ),
            )
            .meta(turn_started_meta),
        );
        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_SESSION_UPDATED_EVENT
        );

        let mut waiting_end_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE,
            ),
            (CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY, "waiting_end"),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
        ]);
        waiting_end_meta.insert(
            CODEX_ACP_AGENT_STATUSES_KEY.to_string(),
            serde_json::json!([
                {
                    "codexAcpChildSessionId": "runtime-child-1",
                    "codexAcpAgentStatus": { "completed": "old result" }
                }
            ]),
        );
        context.handle(
            SessionNotification::new(
                "runtime-parent",
                SessionUpdate::ToolCallUpdate(
                    ToolCallUpdate::new(
                        "codex-acp:subagent:waiting-old",
                        ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
                    )
                    .meta(waiting_end_meta.clone()),
                ),
            )
            .meta(waiting_end_meta),
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn notification_context_closes_subagent_on_close_end_terminal_status() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-1"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-1",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(created_meta.clone()),
                ),
            )
            .meta(created_meta),
        );
        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_SUBAGENT_CREATED_EVENT
        );

        let mut close_end_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE,
            ),
            (CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY, "close_end"),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-1"),
        ]);
        close_end_meta.insert(
            CODEX_ACP_AGENT_STATUS_KEY.to_string(),
            serde_json::json!("shutdown"),
        );
        context.handle(
            SessionNotification::new(
                "runtime-parent",
                SessionUpdate::ToolCallUpdate(
                    ToolCallUpdate::new(
                        "codex-acp:subagent:close-1",
                        ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
                    )
                    .meta(close_end_meta.clone()),
                ),
            )
            .meta(close_end_meta),
        );

        let closed_event = receiver.recv().unwrap();
        assert_eq!(closed_event.event_name, AI_SESSION_CLOSED_EVENT);
        assert_eq!(
            closed_event.payload["sessionId"],
            "session-1:subagent:runtime-child-1"
        );
    }

    #[test]
    fn notification_context_fallback_idles_structured_subagent_without_active_turn() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-1"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-1",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(created_meta.clone()),
                ),
            )
            .meta(created_meta),
        );
        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_SUBAGENT_CREATED_EVENT
        );

        let interaction_begin_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE,
            ),
            (CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY, "interaction_begin"),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-1"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-parent",
                SessionUpdate::ToolCall(
                    ToolCall::new("codex-acp:subagent:interaction-1", "Contacting subagent")
                        .meta(interaction_begin_meta.clone()),
                ),
            )
            .meta(interaction_begin_meta),
        );
        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_SESSION_UPDATED_EVENT
        );
        assert_eq!(receiver.recv().unwrap().event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_SUBAGENT_BREADCRUMB_EVENT
        );

        context.complete_open_messages();
        let idle_event = receiver.recv().unwrap();
        assert_eq!(idle_event.event_name, AI_SESSION_UPDATED_EVENT);
        assert_eq!(idle_event.payload["status"], "idle");
    }

    #[test]
    fn notification_context_projects_subagent_user_message_chunks() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-1"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-1",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(created_meta.clone()),
                ),
            )
            .meta(created_meta),
        );
        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_SUBAGENT_CREATED_EVENT
        );

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::UserMessageChunk(ContentChunk::new("Root prompt".into())),
        ));
        assert!(receiver.try_recv().is_err());

        context.handle(SessionNotification::new(
            "runtime-child-1",
            SessionUpdate::UserMessageChunk(ContentChunk::new("Child prompt".into())),
        ));

        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_SESSION_UPDATED_EVENT
        );
        let started_event = receiver.recv().unwrap();
        assert_eq!(started_event.event_name, AI_MESSAGE_STARTED_EVENT);
        assert_eq!(started_event.payload["messageKind"], "user");
        assert_eq!(
            started_event.payload["sessionId"],
            "session-1:subagent:runtime-child-1"
        );
        let delta_event = receiver.recv().unwrap();
        assert_eq!(delta_event.event_name, AI_MESSAGE_DELTA_EVENT);
        assert_eq!(delta_event.payload["messageKind"], "user");
        assert_eq!(delta_event.payload["delta"], "Child prompt");
        let completed_event = receiver.recv().unwrap();
        assert_eq!(completed_event.event_name, AI_MESSAGE_COMPLETED_EVENT);
        assert_eq!(completed_event.payload["messageKind"], "user");
        assert_eq!(
            completed_event.payload["sessionId"],
            "session-1:subagent:runtime-child-1"
        );
    }

    #[test]
    fn notification_context_ignores_stale_subagent_turn_completion() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-1"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-1",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(created_meta.clone()),
                ),
            )
            .meta(created_meta),
        );
        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_SUBAGENT_CREATED_EVENT
        );

        for turn_id in ["turn-1", "turn-2"] {
            let turn_started_meta = test_meta(&[
                (
                    CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                    CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE,
                ),
                (
                    CODEX_ACP_TURN_EVENT_TYPE_KEY,
                    CODEX_ACP_TURN_STARTED_EVENT_TYPE,
                ),
                (CODEX_ACP_TURN_ID_KEY, turn_id),
            ]);
            context.handle(
                SessionNotification::new(
                    "runtime-child-1",
                    SessionUpdate::SessionInfoUpdate(
                        agent_client_protocol::schema::SessionInfoUpdate::new()
                            .meta(turn_started_meta.clone()),
                    ),
                )
                .meta(turn_started_meta),
            );
        }

        let streaming_event = receiver.recv().unwrap();
        assert_eq!(streaming_event.event_name, AI_SESSION_UPDATED_EVENT);
        assert_eq!(streaming_event.payload["status"], "streaming");
        assert!(receiver.try_recv().is_err());

        let stale_complete_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE,
            ),
            (
                CODEX_ACP_TURN_EVENT_TYPE_KEY,
                CODEX_ACP_TURN_COMPLETE_EVENT_TYPE,
            ),
            (CODEX_ACP_TURN_ID_KEY, "turn-1"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-1",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(stale_complete_meta.clone()),
                ),
            )
            .meta(stale_complete_meta),
        );
        assert!(receiver.try_recv().is_err());

        let current_complete_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE,
            ),
            (
                CODEX_ACP_TURN_EVENT_TYPE_KEY,
                CODEX_ACP_TURN_COMPLETE_EVENT_TYPE,
            ),
            (CODEX_ACP_TURN_ID_KEY, "turn-2"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-1",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(current_complete_meta.clone()),
                ),
            )
            .meta(current_complete_meta),
        );

        let idle_event = receiver.recv().unwrap();
        assert_eq!(idle_event.event_name, AI_SESSION_UPDATED_EVENT);
        assert_eq!(idle_event.payload["status"], "idle");
    }

    #[test]
    fn notification_context_replays_early_turn_started_when_subagent_is_created() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let turn_started_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE,
            ),
            (
                CODEX_ACP_TURN_EVENT_TYPE_KEY,
                CODEX_ACP_TURN_STARTED_EVENT_TYPE,
            ),
            (CODEX_ACP_TURN_ID_KEY, "turn-early"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-early",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(turn_started_meta.clone()),
                ),
            )
            .meta(turn_started_meta),
        );
        assert!(receiver.try_recv().is_err());

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-early"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-early",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(created_meta.clone()),
                ),
            )
            .meta(created_meta),
        );

        assert_eq!(
            receiver.recv().unwrap().event_name,
            AI_SUBAGENT_CREATED_EVENT
        );
        let streaming_event = receiver.recv().unwrap();
        assert_eq!(streaming_event.event_name, AI_SESSION_UPDATED_EVENT);
        assert_eq!(
            streaming_event.payload["sessionId"],
            "session-1:subagent:runtime-child-early"
        );
        assert_eq!(streaming_event.payload["status"], "streaming");
    }

    #[test]
    fn notification_context_does_not_rename_root_session_to_generic_subagent() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::SessionInfoUpdate(
                agent_client_protocol::schema::SessionInfoUpdate::new()
                    .title("Subagent".to_string()),
            ),
        ));

        assert!(receiver.try_recv().is_err());
        let summary = context
            .summary_for_runtime_session(&RuntimeSessionId("runtime-parent".to_string()))
            .expect("root runtime session should have a summary");
        assert_eq!(summary.title, "Parent");
    }

    #[test]
    fn notification_context_projects_tool_diffs() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(ToolCall::new("tool-1", "Edit file").content(
                vec![ToolCallContent::Diff(
                    agent_client_protocol::schema::Diff::new("src/main.rs", "fn main() {}\n")
                        .old_text(""),
                )],
            )),
        ));

        let event = (0..4)
            .map(|_| receiver.recv().unwrap())
            .find(|event| event.event_name == AI_TOOL_ACTIVITY_EVENT)
            .expect("tool activity event");
        assert_eq!(event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(event.payload["diffs"][0]["path"], "src/main.rs");
        assert_eq!(event.payload["diffs"][0]["kind"], "update");
        assert_eq!(event.payload["diffs"][0]["hunks"][0]["newStart"], 1);
    }

    #[test]
    fn notification_context_anchors_claude_structured_patch_tool_diffs() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let mut meta = Meta::new();
        meta.insert(
            "claudeCode".to_string(),
            serde_json::json!({
                "toolName": "Edit",
                "toolResponse": {
                    "filePath": "/tmp/src/main.rs",
                    "structuredPatch": [{
                        "oldStart": 1338,
                        "oldLines": 5,
                        "newStart": 1338,
                        "newLines": 5,
                        "lines": [
                            " const text = match[1].trim()",
                            "-if (selectionTouchesRange(start, end)) {",
                            "+if (selectionEditsRange(start, end)) {",
                            "  return false",
                            " }"
                        ]
                    }]
                }
            }),
        );

        context.handle(
            SessionNotification::new(
                "runtime-parent",
                SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                    "tool-1",
                    ToolCallUpdateFields::new()
                        .title("Edit src/main.rs".to_string())
                        .kind(ToolKind::Edit)
                        .status(ToolCallStatus::Completed)
                        .content(vec![ToolCallContent::Diff(
                            agent_client_protocol::schema::Diff::new(
                                "/tmp/src/main.rs",
                                "const text = match[1].trim()\nif (selectionEditsRange(start, end)) {\n return false\n}",
                            )
                            .old_text(
                                "const text = match[1].trim()\nif (selectionTouchesRange(start, end)) {\n return false\n}",
                            ),
                        )]),
                )),
            )
            .meta(meta),
        );

        let event = receiver.recv().unwrap();
        assert_eq!(event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(event.payload["diffs"][0]["hunks"][0]["newStart"], 1338);
        assert_eq!(event.payload["diffs"][0]["hunks"][0]["oldStart"], 1338);
    }

    #[test]
    fn notification_context_preserves_claude_anchor_after_followup_update() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let mut anchored_meta = Meta::new();
        anchored_meta.insert(
            "claudeCode".to_string(),
            serde_json::json!({
                "toolName": "Edit",
                "toolResponse": {
                    "filePath": "/tmp/src/main.rs",
                    "structuredPatch": [{
                        "oldStart": 749,
                        "oldLines": 2,
                        "newStart": 749,
                        "newLines": 2,
                        "lines": [
                            "-cursor: \"text\",",
                            "+cursor: \"default\","
                        ]
                    }]
                }
            }),
        );
        let mut followup_meta = Meta::new();
        followup_meta.insert(
            "claudeCode".to_string(),
            serde_json::json!({
                "toolName": "Edit"
            }),
        );

        let diff = ToolCallContent::Diff(
            agent_client_protocol::schema::Diff::new("/tmp/src/main.rs", "cursor: \"default\",")
                .old_text("cursor: \"text\","),
        );
        context.handle(
            SessionNotification::new(
                "runtime-parent",
                SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                    "tool-1",
                    ToolCallUpdateFields::new()
                        .title("Edit src/main.rs".to_string())
                        .kind(ToolKind::Edit)
                        .status(ToolCallStatus::InProgress)
                        .content(vec![diff.clone()]),
                )),
            )
            .meta(anchored_meta),
        );
        context.handle(
            SessionNotification::new(
                "runtime-parent",
                SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                    "tool-1",
                    ToolCallUpdateFields::new()
                        .status(ToolCallStatus::Completed)
                        .content(vec![diff]),
                )),
            )
            .meta(followup_meta),
        );

        let initial_event = receiver.recv().unwrap();
        let followup_event = receiver.recv().unwrap();
        assert_eq!(
            initial_event.payload["diffs"][0]["hunks"][0]["newStart"],
            749
        );
        assert_eq!(
            followup_event.payload["diffs"][0]["hunks"][0]["newStart"],
            749
        );
    }

    #[test]
    fn tool_call_content_diffs_keeps_identical_claude_replace_all_hunks() {
        let mut meta = Meta::new();
        meta.insert(
            "claudeCode".to_string(),
            serde_json::json!({
                "toolName": "Edit",
                "toolResponse": {
                    "filePath": "/tmp/src/main.rs",
                    "structuredPatch": [
                        {
                            "oldStart": 40,
                            "oldLines": 1,
                            "newStart": 40,
                            "newLines": 1,
                            "lines": ["-enabled", "+disabled"]
                        },
                        {
                            "oldStart": 90,
                            "oldLines": 1,
                            "newStart": 90,
                            "newLines": 1,
                            "lines": ["-enabled", "+disabled"]
                        }
                    ]
                }
            }),
        );

        let diff = ToolCallContent::Diff(
            agent_client_protocol::schema::Diff::new("/tmp/src/main.rs", "disabled")
                .old_text("enabled"),
        );
        let diffs = tool_call_content_diffs(&[diff.clone(), diff], &meta, None, "/tmp");

        assert_eq!(diffs.len(), 2);
        assert_eq!(diffs[0]["hunks"][0]["newStart"], 40);
        assert_eq!(diffs[1]["hunks"][0]["newStart"], 90);
    }

    #[test]
    fn tool_call_content_diffs_uses_codex_acp_hunks_from_diff_meta() {
        let mut diff_meta = Meta::new();
        diff_meta.insert(
            CODEX_ACP_DIFF_PREVIOUS_PATH_KEY.to_string(),
            serde_json::json!("src/old.rs"),
        );
        diff_meta.insert(
            CODEX_ACP_DIFF_HUNKS_KEY.to_string(),
            serde_json::json!([{
                "old_start": 44,
                "old_count": 1,
                "new_start": 47,
                "new_count": 1,
                "lines": [
                    { "type": "remove", "text": "let value = 1;" },
                    { "type": "add", "text": "let value = 2;" }
                ]
            }]),
        );

        let diffs = tool_call_content_diffs(
            &[ToolCallContent::Diff(
                agent_client_protocol::schema::Diff::new("src/new.rs", "let value = 2;")
                    .old_text("let value = 1;")
                    .meta(diff_meta),
            )],
            &Meta::new(),
            None,
            "/tmp",
        );

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0]["hunks"][0]["newStart"], 47);
        assert_eq!(diffs[0]["hunks"][0]["oldStart"], 44);
        assert_eq!(diffs[0]["previousPath"], "src/old.rs");
        assert_eq!(diffs[0]["kind"], "move");
    }

    #[test]
    fn tool_call_content_diffs_ignores_invalid_codex_hunks() {
        let mut diff_meta = Meta::new();
        diff_meta.insert(
            CODEX_ACP_DIFF_HUNKS_KEY.to_string(),
            serde_json::json!("not hunks"),
        );

        let diffs = tool_call_content_diffs(
            &[ToolCallContent::Diff(
                agent_client_protocol::schema::Diff::new("src/main.rs", "b\n")
                    .old_text("a\n")
                    .meta(diff_meta),
            )],
            &Meta::new(),
            None,
            "/tmp",
        );

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0]["hunks"][0]["newStart"], 1);
    }

    #[test]
    fn tool_call_content_diffs_anchors_opencode_filediff_patch_hunks() {
        let patch = [
            "Index: /tmp/src/main.rs",
            "===================================================================",
            "--- /tmp/src/main.rs",
            "+++ /tmp/src/main.rs",
            "@@ -2219,7 +2220,8 @@",
            " syntaxTree(state).iterate({",
            "   enter(node) {",
            "-    return false;",
            "+    return true;",
            "   }",
            " }",
            "",
        ]
        .join("\n");
        let raw_output = serde_json::json!({
            "metadata": {
                "filediff": {
                    "file": "/tmp/src/main.rs",
                    "patch": patch
                }
            }
        });

        let diffs = tool_call_content_diffs(
            &[ToolCallContent::Diff(
                agent_client_protocol::schema::Diff::new(
                    "/tmp/src/main.rs",
                    "syntaxTree(state).iterate({\n  enter(node) {\n    return true;\n  }\n}",
                )
                .old_text(
                    "syntaxTree(state).iterate({\n  enter(node) {\n    return false;\n  }\n}",
                ),
            )],
            &Meta::new(),
            Some(&raw_output),
            "/tmp",
        );

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0]["hunks"][0]["newStart"], 2220);
        assert_eq!(diffs[0]["hunks"][0]["oldStart"], 2219);
    }

    #[test]
    fn tool_call_content_diffs_anchors_opencode_snippets_contained_in_patch_hunk() {
        let patch = [
            "Index: /tmp/src/main.rs",
            "===================================================================",
            "--- /tmp/src/main.rs",
            "+++ /tmp/src/main.rs",
            "@@ -10,3 +10,4 @@",
            " alpha",
            " anchor",
            "+inserted",
            " omega",
            "",
        ]
        .join("\n");
        let raw_output = serde_json::json!({
            "metadata": {
                "filediff": {
                    "file": "/tmp/src/main.rs",
                    "patch": patch
                }
            }
        });

        let diffs = tool_call_content_diffs(
            &[ToolCallContent::Diff(
                agent_client_protocol::schema::Diff::new("/tmp/src/main.rs", "anchor\ninserted\n")
                    .old_text("anchor\n"),
            )],
            &Meta::new(),
            Some(&raw_output),
            "/tmp",
        );

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0]["hunks"][0]["newStart"], 10);
        assert_eq!(diffs[0]["hunks"][0]["oldStart"], 10);
    }

    #[test]
    fn tool_call_content_diffs_skips_opencode_context_only_snippet_matches() {
        let patch = [
            "Index: /tmp/src/main.rs",
            "===================================================================",
            "--- /tmp/src/main.rs",
            "+++ /tmp/src/main.rs",
            "@@ -10,3 +10,4 @@",
            " alpha",
            " remove me",
            "+inserted elsewhere",
            " omega",
            "@@ -40,3 +41,2 @@",
            " before",
            "-remove me",
            " after",
            "",
        ]
        .join("\n");
        let raw_output = serde_json::json!({
            "metadata": {
                "filediff": {
                    "file": "/tmp/src/main.rs",
                    "patch": patch
                }
            }
        });

        let diffs = tool_call_content_diffs(
            &[ToolCallContent::Diff(
                agent_client_protocol::schema::Diff::new("/tmp/src/main.rs", "")
                    .old_text("remove me\n"),
            )],
            &Meta::new(),
            Some(&raw_output),
            "/tmp",
        );

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0]["hunks"][0]["newStart"], 41);
        assert_eq!(diffs[0]["hunks"][0]["oldStart"], 40);
    }

    #[test]
    fn tool_call_content_diffs_anchors_opencode_hunks_with_context_between_changes() {
        let patch = [
            "Index: /tmp/src/main.rs",
            "===================================================================",
            "--- /tmp/src/main.rs",
            "+++ /tmp/src/main.rs",
            "@@ -80,4 +80,2 @@",
            " before",
            "-remove first",
            " keep context",
            "-remove second",
            "",
        ]
        .join("\n");
        let raw_output = serde_json::json!({
            "metadata": {
                "filediff": {
                    "file": "/tmp/src/main.rs",
                    "patch": patch
                }
            }
        });

        let diffs = tool_call_content_diffs(
            &[ToolCallContent::Diff(
                agent_client_protocol::schema::Diff::new(
                    "/tmp/src/main.rs",
                    "before\nkeep context\n",
                )
                .old_text("before\nremove first\nkeep context\nremove second\n"),
            )],
            &Meta::new(),
            Some(&raw_output),
            "/tmp",
        );

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0]["hunks"][0]["newStart"], 80);
        assert_eq!(diffs[0]["hunks"][0]["oldStart"], 80);
    }

    #[test]
    fn tool_call_content_diffs_anchors_opencode_trailing_newline_patch_hunks() {
        let patch = [
            "Index: /tmp/src/main.rs",
            "===================================================================",
            "--- /tmp/src/main.rs",
            "+++ /tmp/src/main.rs",
            "@@ -20,2 +20,2 @@",
            " alpha",
            "-beta",
            "+beta",
            r"\ No newline at end of file",
            "",
        ]
        .join("\n");
        let raw_output = serde_json::json!({
            "metadata": {
                "filediff": {
                    "file": "/tmp/src/main.rs",
                    "patch": patch
                }
            }
        });

        let diffs = tool_call_content_diffs(
            &[ToolCallContent::Diff(
                agent_client_protocol::schema::Diff::new("/tmp/src/main.rs", "beta")
                    .old_text("beta\n"),
            )],
            &Meta::new(),
            Some(&raw_output),
            "/tmp",
        );

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0]["hunks"][0]["newStart"], 20);
        assert_eq!(diffs[0]["hunks"][0]["oldStart"], 20);
    }

    #[test]
    fn notification_context_merges_partial_tool_updates_before_emitting_activity() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(
                ToolCall::new("tool-1", "Edit file")
                    .kind(ToolKind::Edit)
                    .status(ToolCallStatus::InProgress)
                    .content(vec![ToolCallContent::Diff(
                        agent_client_protocol::schema::Diff::new("src/main.rs", "fn main() {}\n")
                            .old_text(""),
                    )]),
            ),
        ));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                "tool-1",
                ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
            )),
        ));

        let initial_event = receiver.recv().unwrap();
        assert_eq!(initial_event.event_name, AI_TOOL_ACTIVITY_EVENT);
        let update_event = receiver.recv().unwrap();
        assert_eq!(update_event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(update_event.payload["title"], "Edit file");
        assert_eq!(update_event.payload["kind"], "edit");
        assert_eq!(update_event.payload["status"], "completed");
        assert_eq!(update_event.payload["diffs"][0]["path"], "src/main.rs");
    }

    #[test]
    fn notification_context_canonicalizes_tool_update_with_new_id() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(
                ToolCall::new("edit-start", "Edit cuento.md")
                    .kind(ToolKind::Edit)
                    .status(ToolCallStatus::InProgress)
                    .raw_input(serde_json::json!({ "file_path": "cuento.md" })),
            ),
        ));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                "edit-complete",
                ToolCallUpdateFields::new()
                    .kind(ToolKind::Edit)
                    .status(ToolCallStatus::Completed)
                    .raw_input(serde_json::json!({ "file_path": "cuento.md" }))
                    .raw_output(serde_json::json!("done")),
            )),
        ));

        let initial_event = receiver.recv().unwrap();
        assert_eq!(initial_event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(initial_event.payload["toolCallId"], "edit-start");

        let update_event = receiver.recv().unwrap();
        assert_eq!(update_event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(update_event.payload["toolCallId"], "edit-start");
        assert_eq!(update_event.payload["title"], "Edit cuento.md");
        assert_eq!(update_event.payload["status"], "completed");
        assert_eq!(update_event.payload["rawOutput"], "done");
    }

    #[test]
    fn notification_context_deduplicates_exact_repeated_tool_diffs() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let diff = agent_client_protocol::schema::Diff::new("cuento.md", "line one\nline two\n")
            .old_text("line one\n");
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(
                ToolCall::new("edit-1", "Edit cuento.md")
                    .kind(ToolKind::Edit)
                    .status(ToolCallStatus::Completed)
                    .content(vec![
                        ToolCallContent::Diff(diff.clone()),
                        ToolCallContent::Diff(diff),
                    ]),
            ),
        ));

        let event = receiver.recv().unwrap();
        assert_eq!(event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(event.payload["diffs"].as_array().map(Vec::len), Some(1));
        assert_eq!(event.payload["diffs"][0]["path"], "cuento.md");
    }

    #[test]
    fn notification_context_projects_tool_raw_input_and_output() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(
                ToolCall::new("tool-1", "List .personal")
                    .kind(ToolKind::Search)
                    .status(ToolCallStatus::Completed)
                    .raw_input(serde_json::json!({
                        "path": ".personal"
                    }))
                    .raw_output(serde_json::json!(
                        "20/722 matches\nSidebarAgentsPanel.tsx git:clean"
                    )),
            ),
        ));

        let event = receiver.recv().unwrap();
        assert_eq!(event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(event.payload["rawInput"]["path"], ".personal");
        assert_eq!(
            event.payload["rawOutput"],
            "20/722 matches\nSidebarAgentsPanel.tsx git:clean"
        );
        assert_eq!(
            event.payload["summary"],
            "20/722 matches\nSidebarAgentsPanel.tsx git:clean"
        );
    }

    #[test]
    fn notification_context_completes_text_segments_before_tool_activity() {
        let (sender, receiver) = std_mpsc::sync_channel(16);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("Before tool".into())),
        ));
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(ToolCall::new("tool-1", "Read file")),
        ));
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("After tool".into())),
        ));

        let events = (0..6).map(|_| receiver.recv().unwrap()).collect::<Vec<_>>();

        assert_eq!(events[0].event_name, AI_MESSAGE_STARTED_EVENT);
        assert_eq!(events[1].event_name, AI_MESSAGE_DELTA_EVENT);
        assert_eq!(events[2].event_name, AI_MESSAGE_COMPLETED_EVENT);
        assert_eq!(events[3].event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(events[4].event_name, AI_MESSAGE_STARTED_EVENT);
        assert_eq!(events[5].event_name, AI_MESSAGE_DELTA_EVENT);
        assert_ne!(
            events[0].payload["messageId"],
            events[4].payload["messageId"]
        );
    }

    #[test]
    fn notification_context_suppresses_internal_status_tool_activity() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let status_meta = test_meta(&[(CODEX_ACP_STATUS_EVENT_TYPE_KEY, "status")]);
        context.handle(
            SessionNotification::new(
                "runtime-parent",
                SessionUpdate::ToolCall(
                    ToolCall::new("status-1", "Drafting response").meta(status_meta.clone()),
                ),
            )
            .meta(status_meta.clone()),
        );
        context.handle(
            SessionNotification::new(
                "runtime-parent",
                SessionUpdate::ToolCallUpdate(
                    ToolCallUpdate::new(
                        "status-1",
                        agent_client_protocol::schema::ToolCallUpdateFields::new()
                            .title("Preparing input".to_string()),
                    )
                    .meta(status_meta.clone()),
                ),
            )
            .meta(status_meta),
        );

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(ToolCall::new("status-2", "Preparing input")),
        ));
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(ToolCall::new("status-3", "Changing files")),
        ));

        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn notification_context_projects_tool_activity_summary() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(ToolCall::new("tool-1", "Run command").content(vec![
                ToolCallContent::from(ContentBlock::Text(TextContent::new("Command completed"))),
            ])),
        ));

        let event = receiver.recv().unwrap();
        assert_eq!(event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(event.payload["summary"], "Command completed");
    }

    #[test]
    fn notification_context_projects_terminal_output_metadata() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCall(ToolCall::new("tool-1", "Run command")),
        ));
        let started = receiver.recv().unwrap();
        assert_eq!(started.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert!(started.payload.get("terminalOutput").is_none());

        let mut first_meta = Meta::default();
        first_meta.insert(
            ACP_TERMINAL_OUTPUT_META_KEY.to_string(),
            serde_json::json!({
                "terminal_id": "tool-1",
                "data": "hello",
                "mode": "delta",
            }),
        );
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCallUpdate(
                agent_client_protocol::schema::ToolCallUpdate::new(
                    "tool-1",
                    ToolCallUpdateFields::new().status(ToolCallStatus::InProgress),
                )
                .meta(first_meta),
            ),
        ));

        let first_output = receiver.recv().unwrap();
        assert_eq!(first_output.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(first_output.payload["terminalOutput"], "hello");

        let mut exit_meta = Meta::default();
        exit_meta.insert(
            ACP_TERMINAL_OUTPUT_META_KEY.to_string(),
            serde_json::json!({
                "terminal_id": "tool-1",
                "data": " world",
                "mode": "delta",
            }),
        );
        exit_meta.insert(
            ACP_TERMINAL_EXIT_META_KEY.to_string(),
            serde_json::json!({
                "terminal_id": "tool-1",
                "exit_code": 0,
            }),
        );
        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::ToolCallUpdate(
                agent_client_protocol::schema::ToolCallUpdate::new(
                    "tool-1",
                    ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
                )
                .meta(exit_meta),
            ),
        ));

        let completed = receiver.recv().unwrap();
        assert_eq!(completed.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(completed.payload["terminalOutput"], "hello world");
        assert_eq!(completed.payload["exitCode"], 0);
    }

    #[test]
    fn notification_context_projects_current_mode_updates() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-parent",
            SessionUpdate::CurrentModeUpdate(
                agent_client_protocol::schema::CurrentModeUpdate::new("build"),
            ),
        ));

        let event = receiver.recv().unwrap();
        assert_eq!(event.event_name, AI_SESSION_CATALOG_UPDATED_EVENT);
        assert_eq!(event.payload["modeId"], "build");
    }

    #[test]
    fn notification_context_buffers_unknown_child_until_explicit_subagent_metadata() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-child-late",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("Child output".into())),
        ));
        assert!(receiver.try_recv().is_err());

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-late"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-late",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(created_meta.clone()),
                ),
            )
            .meta(created_meta),
        );

        let created_event = receiver.recv().unwrap();
        assert_eq!(created_event.event_name, AI_SUBAGENT_CREATED_EVENT);
        assert_eq!(
            created_event.payload["sessionId"],
            "session-1:subagent:runtime-child-late"
        );

        let streaming_event = receiver.recv().unwrap();
        assert_eq!(streaming_event.event_name, AI_SESSION_UPDATED_EVENT);
        assert_eq!(
            streaming_event.payload["sessionId"],
            "session-1:subagent:runtime-child-late"
        );
        assert_eq!(streaming_event.payload["status"], "streaming");

        let started_event = receiver.recv().unwrap();
        assert_eq!(started_event.event_name, AI_MESSAGE_STARTED_EVENT);
        assert_eq!(
            started_event.payload["sessionId"],
            "session-1:subagent:runtime-child-late"
        );

        let delta_event = receiver.recv().unwrap();
        assert_eq!(delta_event.event_name, AI_MESSAGE_DELTA_EVENT);
        assert_eq!(
            delta_event.payload["sessionId"],
            "session-1:subagent:runtime-child-late"
        );
        assert_eq!(delta_event.payload["delta"], "Child output");
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn notification_context_does_not_create_subagent_from_unknown_tool_without_metadata() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-child-without-meta",
            SessionUpdate::ToolCall(ToolCall::new("tool-child-1", "Read file")),
        ));

        let tool_event = receiver.recv().unwrap();
        assert_eq!(tool_event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(tool_event.payload["sessionId"], "session-1");
        assert_eq!(
            tool_event.payload["runtimeSessionId"],
            "runtime-child-without-meta"
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn notification_context_buffers_diffs_from_unknown_child_until_metadata_arrives() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-child-without-meta",
            SessionUpdate::ToolCall(ToolCall::new("tool-child-1", "Edit file").content(vec![
                ToolCallContent::Diff(
                    agent_client_protocol::schema::Diff::new("src/main.rs", "fn main() {}\n")
                        .old_text(""),
                ),
            ])),
        ));

        let tool_event = receiver.recv().unwrap();
        assert_eq!(tool_event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(tool_event.payload["sessionId"], "session-1");
        assert_eq!(
            tool_event.payload["runtimeSessionId"],
            "runtime-child-without-meta"
        );
        assert!(tool_event.payload.get("diffs").is_none());
        assert!(receiver.try_recv().is_err());

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-without-meta"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-without-meta",
                SessionUpdate::SessionInfoUpdate(
                    agent_client_protocol::schema::SessionInfoUpdate::new()
                        .meta(created_meta.clone()),
                ),
            )
            .meta(created_meta),
        );

        let created_event = receiver.recv().unwrap();
        assert_eq!(created_event.event_name, AI_SUBAGENT_CREATED_EVENT);

        let child_tool_event = receiver.recv().unwrap();
        assert_eq!(child_tool_event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(
            child_tool_event.payload["sessionId"],
            "session-1:subagent:runtime-child-without-meta"
        );
        assert_eq!(
            child_tool_event.payload["runtimeSessionId"],
            "runtime-child-without-meta"
        );
        assert_eq!(child_tool_event.payload["diffs"][0]["path"], "src/main.rs");
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn notification_context_keeps_diffs_for_child_tool_with_metadata() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context =
            NotificationContext::new(native_test_session(), Some(sender), Vec::new(), true);
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        let created_meta = test_meta(&[
            (
                CODEX_ACP_STATUS_EVENT_TYPE_KEY,
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
            ),
            (CODEX_ACP_PARENT_SESSION_ID_KEY, "runtime-parent"),
            (CODEX_ACP_CHILD_SESSION_ID_KEY, "runtime-child-known"),
        ]);
        context.handle(
            SessionNotification::new(
                "runtime-child-known",
                SessionUpdate::ToolCall(ToolCall::new("tool-child-1", "Edit file").content(
                    vec![ToolCallContent::Diff(
                        agent_client_protocol::schema::Diff::new("src/main.rs", "fn main() {}\n")
                            .old_text(""),
                    )],
                )),
            )
            .meta(created_meta),
        );

        let created_event = receiver.recv().unwrap();
        assert_eq!(created_event.event_name, AI_SUBAGENT_CREATED_EVENT);
        let tool_event = receiver.recv().unwrap();
        assert_eq!(tool_event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(
            tool_event.payload["sessionId"],
            "session-1:subagent:runtime-child-known"
        );
        assert_eq!(tool_event.payload["diffs"][0]["path"], "src/main.rs");
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn notification_context_routes_unknown_runtime_sessions_to_root_without_subagent_support() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context = NotificationContext::new(
            native_test_session_for_runtime("opencode"),
            Some(sender),
            Vec::new(),
            false,
        );
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-opencode-alias",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("Root output".into())),
        ));

        let started_event = receiver.recv().unwrap();
        assert_eq!(started_event.event_name, AI_MESSAGE_STARTED_EVENT);
        assert_eq!(started_event.payload["sessionId"], "session-1");
        assert_eq!(
            started_event.payload["runtimeSessionId"],
            "runtime-opencode-alias"
        );

        let delta_event = receiver.recv().unwrap();
        assert_eq!(delta_event.event_name, AI_MESSAGE_DELTA_EVENT);
        assert_eq!(delta_event.payload["sessionId"], "session-1");
        assert_eq!(delta_event.payload["delta"], "Root output");
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn redacts_launch_env() {
        let registry = RuntimeRegistry::default();
        let definition = registry.get("opencode").unwrap();
        let spec = AcpProcessSpec::from_launch(
            definition,
            &launch_spec("opencode", "opencode", vec!["acp"]),
        )
        .unwrap();

        assert_eq!(spec.redacted_env()["OPENAI_API_KEY"], "[redacted]");
        assert_eq!(spec.redacted_env()["PATH"], "/usr/bin");
    }

    #[test]
    fn validates_process_args_for_pr9_runtime_matrix() {
        let registry = RuntimeRegistry::default();
        let cases = [
            ("codex", "codex-acp", vec![]),
            ("claude", "node", vec!["/vendor/claude-agent-acp.js"]),
            ("opencode", "opencode", vec!["acp"]),
            ("kilo", "kilo", vec!["acp"]),
            ("grok", "grok", vec!["--no-auto-update", "agent", "stdio"]),
        ];

        for (runtime_id, executable, args) in cases {
            let definition = registry.get(runtime_id).unwrap();
            let spec =
                AcpProcessSpec::from_launch(definition, &launch_spec(runtime_id, executable, args))
                    .unwrap();
            assert_eq!(spec.runtime_id, runtime_id);
        }
    }

    #[test]
    fn rejects_runtime_mismatch_before_spawn() {
        let registry = RuntimeRegistry::default();
        let definition = registry.get("kilo").unwrap();

        assert!(matches!(
            AcpProcessSpec::from_launch(
                definition,
                &launch_spec("opencode", "opencode", vec!["acp"]),
            ),
            Err(AiError::RuntimeLaunchContextInvalid { .. })
        ));
    }

    #[test]
    fn rejects_grok_without_no_auto_update_args() {
        let registry = RuntimeRegistry::default();
        let definition = registry.get("grok").unwrap();

        assert!(matches!(
            AcpProcessSpec::from_launch(definition, &launch_spec("grok", "grok", vec!["agent"])),
            Err(AiError::RuntimeLaunchContextInvalid { .. })
        ));
    }

    #[test]
    fn maps_user_input_answers_to_elicitation_accept_content() {
        let schema = BTreeMap::from([
            ("branch".to_string(), ElicitationAnswerKind::String),
            ("checks".to_string(), ElicitationAnswerKind::Array),
            ("confirmed".to_string(), ElicitationAnswerKind::Boolean),
            ("retries".to_string(), ElicitationAnswerKind::Integer),
            ("threshold".to_string(), ElicitationAnswerKind::Number),
        ]);
        let response = create_elicitation_response_from_input(
            NativeAiUserInputResponseInput {
                session_id: SessionId("s1".to_string()),
                target_session_id: None,
                request_id: "user-input-1".to_string(),
                answers: vec![
                    NativeAiUserInputAnswer {
                        question_id: "branch".to_string(),
                        answers: vec!["main".to_string()],
                    },
                    NativeAiUserInputAnswer {
                        question_id: "checks".to_string(),
                        answers: vec!["lint".to_string(), "test".to_string()],
                    },
                    NativeAiUserInputAnswer {
                        question_id: "confirmed".to_string(),
                        answers: vec!["true".to_string()],
                    },
                    NativeAiUserInputAnswer {
                        question_id: "retries".to_string(),
                        answers: vec!["3".to_string()],
                    },
                    NativeAiUserInputAnswer {
                        question_id: "threshold".to_string(),
                        answers: vec!["0.75".to_string()],
                    },
                ],
            },
            &schema,
        );

        let ElicitationAction::Accept(action) = response.action else {
            panic!("expected accepted elicitation response");
        };
        let content = action.content.unwrap();
        assert_eq!(
            content.get("branch"),
            Some(&ElicitationContentValue::String("main".to_string()))
        );
        assert_eq!(
            content.get("checks"),
            Some(&ElicitationContentValue::StringArray(vec![
                "lint".to_string(),
                "test".to_string()
            ]))
        );
        assert_eq!(
            content.get("confirmed"),
            Some(&ElicitationContentValue::Boolean(true))
        );
        assert_eq!(
            content.get("retries"),
            Some(&ElicitationContentValue::Integer(3))
        );
        assert_eq!(
            content.get("threshold"),
            Some(&ElicitationContentValue::Number(0.75))
        );
    }

    #[test]
    fn maps_empty_user_input_to_elicitation_cancel() {
        let response = create_elicitation_response_from_input(
            NativeAiUserInputResponseInput {
                session_id: SessionId("s1".to_string()),
                target_session_id: None,
                request_id: "user-input-1".to_string(),
                answers: Vec::new(),
            },
            &BTreeMap::new(),
        );

        assert!(matches!(response.action, ElicitationAction::Cancel));
    }

    #[test]
    fn grok_api_key_auth_uses_xai_api_key_handshake() {
        let registry = RuntimeRegistry::default();
        let definition = registry.get("grok").unwrap();
        let mut launch = launch_spec("grok", "grok", vec!["--no-auto-update", "agent", "stdio"]);
        launch.auth_method = Some("xai-api-key".to_string());
        launch.auth_credential_source = Some("comando-secret".to_string());
        launch.auth_handshake = Some(NativeAiAuthHandshakeSpec {
            env_method_id: "xai.api_key".to_string(),
            external_method_id: "cached_token".to_string(),
            meta: BTreeMap::new(),
        });
        let spec = AcpProcessSpec::from_launch(definition, &launch).unwrap();
        let request =
            acp_auth_handshake_request(&spec, &initialize_response_with_auth("xai.api_key"))
                .unwrap()
                .unwrap();

        assert_eq!(request.method_id, "xai.api_key");
    }

    #[test]
    fn grok_login_auth_uses_cached_token_handshake() {
        let registry = RuntimeRegistry::default();
        let definition = registry.get("grok").unwrap();
        let mut launch = launch_spec("grok", "grok", vec!["--no-auto-update", "agent", "stdio"]);
        launch.auth_method = Some("grok-login".to_string());
        launch.auth_credential_source = Some("external-runtime".to_string());
        launch.auth_handshake = Some(NativeAiAuthHandshakeSpec {
            env_method_id: "xai.api_key".to_string(),
            external_method_id: "cached_token".to_string(),
            meta: BTreeMap::new(),
        });
        let spec = AcpProcessSpec::from_launch(definition, &launch).unwrap();
        let request =
            acp_auth_handshake_request(&spec, &initialize_response_with_auth("cached_token"))
                .unwrap()
                .unwrap();

        assert_eq!(request.method_id, "cached_token");
    }

    #[test]
    fn auth_handshake_requires_advertised_method() {
        let registry = RuntimeRegistry::default();
        let definition = registry.get("grok").unwrap();
        let mut launch = launch_spec("grok", "grok", vec!["--no-auto-update", "agent", "stdio"]);
        launch.auth_method = Some("xai-api-key".to_string());
        launch.auth_credential_source = Some("comando-secret".to_string());
        launch.auth_handshake = Some(NativeAiAuthHandshakeSpec {
            env_method_id: "xai.api_key".to_string(),
            external_method_id: "cached_token".to_string(),
            meta: BTreeMap::new(),
        });
        let spec = AcpProcessSpec::from_launch(definition, &launch).unwrap();
        let error =
            acp_auth_handshake_request(&spec, &initialize_response_with_auth("cached_token"))
                .unwrap_err();

        assert!(error.contains("xai.api_key"));
    }

    #[test]
    fn extracts_text_content_from_acp_blocks() {
        let block = ContentBlock::Text(TextContent::new("hello"));
        assert_eq!(content_block_text(&block), "hello");
    }
}
