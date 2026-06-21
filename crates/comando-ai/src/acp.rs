use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc as std_mpsc};

use agent_client_protocol::schema::{
    AuthenticateRequest, AvailableCommand, AvailableCommandsUpdate, CancelNotification,
    ClientCapabilities, ConfigOptionUpdate, ContentBlock, ContentChunk, CreateElicitationRequest,
    CreateElicitationResponse, ElicitationAcceptAction, ElicitationAction, ElicitationCapabilities,
    ElicitationContentValue, ElicitationFormCapabilities, ElicitationMode,
    ElicitationPropertySchema, InitializeRequest, InitializeResponse, LoadSessionRequest, Meta,
    MultiSelectItems, NewSessionRequest, PermissionOption, PromptRequest, ProtocolVersion,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigOptionValue, SessionConfigSelectOptions, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, StopReason, TextContent, ToolCall, ToolCallUpdate,
};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo};
use comando_types::ai::{
    NativeAiAvailableCommandPayload, NativeAiErrorPayload, NativeAiLaunchSpec,
    NativeAiPermissionOptionPayload, NativeAiPermissionRequestPayload,
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
    AI_ERROR_EVENT, AI_MESSAGE_COMPLETED_EVENT, AI_MESSAGE_DELTA_EVENT, AI_MESSAGE_STARTED_EVENT,
    AI_PERMISSION_REQUEST_EVENT, AI_PLAN_UPDATED_EVENT, AI_RUNTIME_CONNECTION_EVENT,
    AI_SESSION_CATALOG_UPDATED_EVENT, AI_SESSION_UPDATED_EVENT, AI_SUBAGENT_BREADCRUMB_EVENT,
    AI_SUBAGENT_CREATED_EVENT, AI_THINKING_COMPLETED_EVENT, AI_THINKING_DELTA_EVENT,
    AI_THINKING_STARTED_EVENT, AI_TOKEN_USAGE_EVENT, AI_TOOL_ACTIVITY_EVENT,
    AI_USER_INPUT_REQUEST_EVENT, AiRuntimeEvent, message_completed, message_delta, message_started,
    now_iso8601, session_updated,
};
use crate::redaction::redact_env_key_value;
use crate::runtime::{AcpProtocolFlavor, RuntimeDefinition};
use crate::session::{NativeAiSession, SessionRegistry};

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
const MESSAGE_DELTA_COALESCE_CHARS: usize = 512;
const MESSAGE_DELTA_COALESCE_CHUNKS: usize = 8;
const CODEX_ACP_STATUS_EVENT_TYPE_KEY: &str = "codexAcpEventType";
const CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE: &str = "subagent_session_created";
const CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE: &str = "subagent_breadcrumb";
const CODEX_ACP_PARENT_SESSION_ID_KEY: &str = "codexAcpParentSessionId";
const CODEX_ACP_CHILD_SESSION_ID_KEY: &str = "codexAcpChildSessionId";
const CODEX_ACP_AGENT_NICKNAME_KEY: &str = "codexAcpAgentNickname";

type PermissionWaiterMap = Arc<Mutex<HashMap<String, PendingPermissionRequest>>>;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ElicitationAnswerKind {
    Array,
    Boolean,
    Integer,
    Number,
    String,
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
    ClientCapabilities::new()
        .elicitation(ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()))
}

fn protocol_version_for_flavor(flavor: AcpProtocolFlavor) -> ProtocolVersion {
    match flavor {
        AcpProtocolFlavor::Current14 | AcpProtocolFlavor::Legacy12 => ProtocolVersion::V1,
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
    ) -> AiResult<()> {
        self.sender
            .send(AcpSessionCommand::Prompt {
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
    let user_input_waiters = Arc::new(Mutex::new(HashMap::new()));
    let controller = AcpSessionController {
        permission_waiters: Arc::clone(&permission_waiters),
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

async fn run_acp_session(
    spec: AcpProcessSpec,
    session: NativeAiSession,
    sessions: Arc<Mutex<SessionRegistry>>,
    event_sender: Option<std_mpsc::SyncSender<AiRuntimeEvent>>,
    mut command_receiver: tokio_mpsc::UnboundedReceiver<AcpSessionCommand>,
    started_sender: Arc<Mutex<Option<oneshot::Sender<Result<RuntimeSessionId, String>>>>>,
    permission_waiters: PermissionWaiterMap,
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
            let started_sender = Arc::clone(&started_sender);
            async move {
                let initialize_response = connection
                    .send_request(
                        InitializeRequest::new(protocol_version_for_flavor(spec.protocol_flavor))
                            .client_capabilities(acp_client_capabilities()),
                    )
                    .block_task()
                    .await?;
                run_acp_auth_handshake(&connection, &spec, &initialize_response).await?;

                let additional_directories = session
                    .scope
                    .additional_roots
                    .iter()
                    .map(PathBuf::from)
                    .collect::<Vec<_>>();
                let runtime_session_id =
                    if let Some(runtime_session_id) = spec.persisted_runtime_session_id.clone() {
                        let load_session = LoadSessionRequest::new(
                            agent_client_protocol::schema::SessionId::from(
                                runtime_session_id.0.clone(),
                            ),
                            PathBuf::from(&session.scope.cwd),
                        )
                        .additional_directories(additional_directories);
                        connection.send_request(load_session).block_task().await?;
                        runtime_session_id
                    } else {
                        let new_session = NewSessionRequest::new(PathBuf::from(&session.scope.cwd))
                            .additional_directories(additional_directories);
                        let new_session_response =
                            connection.send_request(new_session).block_task().await?;
                        RuntimeSessionId(new_session_response.session_id.to_string())
                    };
                notification_context.set_runtime_session_id(runtime_session_id.clone());
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
    sessions: &Arc<Mutex<SessionRegistry>>,
    event_sender: Option<&std_mpsc::SyncSender<AiRuntimeEvent>>,
    notification_context: &NotificationContext,
) {
    let runtime_session =
        agent_client_protocol::schema::SessionId::from(runtime_session_id.0.clone());
    let prompt_request = PromptRequest::new(
        runtime_session,
        vec![ContentBlock::Text(TextContent::new(prompt))],
    );

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
    ) -> Self {
        let inner = NotificationContextInner::new(
            session,
            event_sender,
            persisted_subagent_session_mappings,
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
    app_session_id_by_runtime_session_id: HashMap<String, SessionId>,
    event_sender: Option<std_mpsc::SyncSender<AiRuntimeEvent>>,
    open_messages: HashMap<String, StreamedMessage>,
    pending_content_chunks: HashMap<String, Vec<PendingContentChunk>>,
    runtime_session_id: Option<RuntimeSessionId>,
    session: NativeAiSession,
    subagents_by_runtime_session_id: HashMap<String, SubagentRuntimeSession>,
}

struct PendingContentChunk {
    chunk: ContentChunk,
    message_kind: &'static str,
}

#[derive(Clone)]
struct SubagentRuntimeSession {
    parent_session_id: SessionId,
    runtime_session_id: RuntimeSessionId,
    session_id: SessionId,
    title: String,
}

impl NotificationContextInner {
    fn new(
        session: NativeAiSession,
        event_sender: Option<std_mpsc::SyncSender<AiRuntimeEvent>>,
        persisted_subagent_session_mappings: Vec<NativeAiRuntimeSessionMapping>,
    ) -> Self {
        let mut app_session_id_by_runtime_session_id = HashMap::new();
        let mut subagents_by_runtime_session_id = HashMap::new();

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
                        title: "Subagent".to_string(),
                    },
                );
            }
        }

        if let Some(runtime_session_id) = session.runtime_session_id.clone() {
            app_session_id_by_runtime_session_id
                .insert(runtime_session_id.0.clone(), session.session_id.clone());
        }

        Self {
            app_session_id_by_runtime_session_id,
            event_sender,
            open_messages: HashMap::new(),
            pending_content_chunks: HashMap::new(),
            runtime_session_id: session.runtime_session_id.clone(),
            session,
            subagents_by_runtime_session_id,
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
                self.handle_tool_call(&runtime_session_id, tool_call, &meta);
            }
            SessionUpdate::ToolCallUpdate(tool_call_update) => {
                let meta = merged_meta(notification_meta.as_ref(), tool_call_update.meta.as_ref());
                self.prepare_runtime_session_event(&runtime_session_id, Some(&meta), None);
                self.handle_tool_call_update(&runtime_session_id, tool_call_update, &meta);
            }
            SessionUpdate::Plan(plan) => {
                self.prepare_runtime_session_event(&runtime_session_id, None, None);
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
            SessionUpdate::UserMessageChunk(_) | SessionUpdate::CurrentModeUpdate(_) => {}
            _ => {}
        }
    }

    fn handle_content_chunk(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        message_kind: &'static str,
        chunk: ContentChunk,
    ) {
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

        let delta = content_block_text(&chunk.content);
        if delta.is_empty() {
            return;
        }

        let message_id = chunk
            .message_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| format!("acp:{message_kind}:{}", self.open_messages.len() + 1));
        let stream_key = stream_message_key(runtime_session_id, &message_id);
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

        let should_flush = {
            let message = self
                .open_messages
                .entry(stream_key)
                .or_insert_with(|| StreamedMessage {
                    content: String::new(),
                    pending_chunks: 0,
                    pending_delta: String::new(),
                    kind: message_kind,
                    message_id: message_id.clone(),
                    runtime_session_id: runtime_session_id.clone(),
                });
            message.content.push_str(&delta);
            message.pending_delta.push_str(&delta);
            message.pending_chunks += 1;
            message.pending_delta.len() >= MESSAGE_DELTA_COALESCE_CHARS
                || message.pending_chunks >= MESSAGE_DELTA_COALESCE_CHUNKS
        };

        if should_flush {
            self.flush_message_delta(runtime_session_id, &message_id);
        }
    }

    fn handle_tool_call(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        tool_call: ToolCall,
        meta: &Meta,
    ) {
        let tool_call_id = NativeToolCallId(tool_call.tool_call_id.to_string());
        self.emit(
            AI_TOOL_ACTIVITY_EVENT,
            &NativeAiToolActivityPayload {
                base: self.event_base_for_runtime_session(runtime_session_id),
                kind: serde_label(&tool_call.kind),
                status: serde_label(&tool_call.status),
                summary: None,
                title: tool_call.title,
                tool_call_id: tool_call_id.clone(),
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
        let tool_call_id = NativeToolCallId(tool_call_update.tool_call_id.to_string());
        self.emit(
            AI_TOOL_ACTIVITY_EVENT,
            &NativeAiToolActivityPayload {
                base: self.event_base_for_runtime_session(runtime_session_id),
                kind: tool_call_update
                    .fields
                    .kind
                    .as_ref()
                    .map(serde_label)
                    .unwrap_or_else(|| "other".to_string()),
                status: tool_call_update
                    .fields
                    .status
                    .as_ref()
                    .map(serde_label)
                    .unwrap_or_else(|| "in_progress".to_string()),
                summary: tool_call_update
                    .fields
                    .content
                    .as_ref()
                    .and_then(|content| serde_json::to_string(content).ok()),
                title: tool_call_update
                    .fields
                    .title
                    .unwrap_or_else(|| "Tool activity".to_string()),
                tool_call_id: tool_call_id.clone(),
            },
        );
        self.emit_subagent_breadcrumb(runtime_session_id, tool_call_id, meta);
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
    }

    fn handle_session_info_update(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        info: agent_client_protocol::schema::SessionInfoUpdate,
        meta: &Meta,
    ) {
        let title = info.title.into_option();
        if meta_string(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY).as_deref()
            == Some(CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE)
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

        if let Some(title) = title {
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
            },
        );
    }

    fn ensure_subagent_runtime_session_from_meta(
        &mut self,
        notification_runtime_session_id: &RuntimeSessionId,
        meta: &Meta,
        fallback_title: Option<&str>,
    ) -> Option<SubagentRuntimeSession> {
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
                title: subagent.title.clone(),
            },
        );
        self.replay_pending_content_chunks(&child_runtime_session_id);
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

    fn flush_message_delta(&mut self, runtime_session_id: &RuntimeSessionId, message_id: &str) {
        let stream_key = stream_message_key(runtime_session_id, message_id);
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
            .map(|message| message.message_id.clone())
            .collect::<Vec<_>>();
        for message_id in message_ids {
            self.flush_message_delta(runtime_session_id, &message_id);
        }
    }

    fn prepare_runtime_session_event(
        &mut self,
        runtime_session_id: &RuntimeSessionId,
        meta: Option<&Meta>,
        fallback_title: Option<&str>,
    ) {
        if let Some(meta) = meta {
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
        fallback_title: Option<&str>,
    ) {
        if self.is_known_runtime_session(runtime_session_id) {
            return;
        }

        self.ensure_subagent_runtime_session_from_meta(
            runtime_session_id,
            &Meta::default(),
            fallback_title.or(Some("Subagent")),
        );
    }

    fn is_known_runtime_session(&self, runtime_session_id: &RuntimeSessionId) -> bool {
        self.runtime_session_id.as_ref() == Some(runtime_session_id)
            || self
                .subagents_by_runtime_session_id
                .contains_key(&runtime_session_id.0)
    }

    fn replay_pending_content_chunks(&mut self, runtime_session_id: &RuntimeSessionId) {
        let Some(chunks) = self.pending_content_chunks.remove(&runtime_session_id.0) else {
            return;
        };
        for pending in chunks {
            self.handle_content_chunk(runtime_session_id, pending.message_kind, pending.chunk);
        }
    }

    fn emit_pending_message_delta(&self, message: &mut StreamedMessage) {
        if message.pending_delta.is_empty() {
            return;
        }

        let summary = self.summary_for_runtime_session(&message.runtime_session_id);
        let pending_delta = std::mem::take(&mut message.pending_delta);
        message.pending_chunks = 0;
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

struct StreamedMessage {
    content: String,
    kind: &'static str,
    message_id: String,
    pending_chunks: usize,
    pending_delta: String,
    runtime_session_id: RuntimeSessionId,
}

fn stream_message_key(runtime_session_id: &RuntimeSessionId, message_id: &str) -> String {
    format!("{}\u{1f}{message_id}", runtime_session_id.0)
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
        meta.extend(update_meta.clone());
    }
    meta
}

fn meta_string(meta: &Meta, key: &str) -> Option<String> {
    meta.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn meta_references_subagent(meta: &Meta) -> bool {
    meta_string(meta, CODEX_ACP_CHILD_SESSION_ID_KEY).is_some()
        || meta_string(meta, CODEX_ACP_PARENT_SESSION_ID_KEY).is_some()
        || matches!(
            meta_string(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY).as_deref(),
            Some(
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE
                    | CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE
            )
        )
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
    use comando_types::ai::{
        NativeAiAuthHandshakeSpec, NativeAiDesiredSelections, NativeAiPrepareSessionInput,
        NativeAiRuntimeStatus, NativeAiUserInputAnswer,
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
            checked_at: now_iso8601(),
            command: Some(command.to_string()),
            message: None,
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

    fn native_test_session() -> NativeAiSession {
        NativeAiSession::from_prepare_input(NativeAiPrepareSessionInput {
            window_id: "window-1".to_string(),
            session_id: SessionId("session-1".to_string()),
            runtime_id: RuntimeId("codex".to_string()),
            project_id: None,
            worktree_id: None,
            cwd: "/tmp".to_string(),
            title: "Parent".to_string(),
            model_id: None,
            mode_id: None,
            config_options: BTreeMap::new(),
            additional_roots: Vec::new(),
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
    fn notification_context_projects_catalog_updates() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context = NotificationContext::new(native_test_session(), Some(sender), Vec::new());
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
    fn notification_context_projects_subagent_sessions_and_breadcrumbs() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context = NotificationContext::new(native_test_session(), Some(sender), Vec::new());
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
    fn notification_context_buffers_unknown_child_until_mapping_exists() {
        let (sender, receiver) = std_mpsc::sync_channel(8);
        let context = NotificationContext::new(native_test_session(), Some(sender), Vec::new());
        context.set_runtime_session_id(RuntimeSessionId("runtime-parent".to_string()));

        context.handle(SessionNotification::new(
            "runtime-child-late",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("Child output".into())),
        ));
        assert!(receiver.try_recv().is_err());

        context.handle(SessionNotification::new(
            "runtime-child-late",
            SessionUpdate::ToolCall(ToolCall::new("tool-child-1", "Read file")),
        ));

        let created_event = receiver.recv().unwrap();
        assert_eq!(created_event.event_name, AI_SUBAGENT_CREATED_EVENT);
        assert_eq!(
            created_event.payload["sessionId"],
            "session-1:subagent:runtime-child-late"
        );

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

        let tool_event = receiver.recv().unwrap();
        assert_eq!(tool_event.event_name, AI_TOOL_ACTIVITY_EVENT);
        assert_eq!(
            tool_event.payload["sessionId"],
            "session-1:subagent:runtime-child-late"
        );
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
