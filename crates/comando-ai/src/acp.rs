use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc as std_mpsc};

use agent_client_protocol::schema::{
    AuthenticateRequest, CancelNotification, ClientCapabilities, ContentBlock, ContentChunk,
    CreateElicitationRequest, CreateElicitationResponse, ElicitationAcceptAction,
    ElicitationAction, ElicitationCapabilities, ElicitationContentValue,
    ElicitationFormCapabilities, ElicitationMode, ElicitationPropertySchema, InitializeRequest,
    InitializeResponse, MultiSelectItems, NewSessionRequest, PermissionOption, PromptRequest,
    ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, StopReason, TextContent,
    ToolCall, ToolCallUpdate,
};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo};
use comando_types::ai::{
    NativeAiErrorPayload, NativeAiLaunchSpec, NativeAiPermissionOptionPayload,
    NativeAiPermissionRequestPayload, NativeAiPermissionResponseInput, NativeAiPlanEntryPayload,
    NativeAiPlanUpdatedPayload, NativeAiSessionStatus, NativeAiSessionSummary,
    NativeAiTokenUsageCost, NativeAiTokenUsagePayload, NativeAiToolActivityPayload,
    NativeAiUserInputQuestionOptionPayload, NativeAiUserInputQuestionPayload,
    NativeAiUserInputRequestPayload, NativeAiUserInputResponseInput,
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
    AI_PERMISSION_REQUEST_EVENT, AI_PLAN_UPDATED_EVENT, AI_SESSION_UPDATED_EVENT,
    AI_THINKING_COMPLETED_EVENT, AI_THINKING_DELTA_EVENT, AI_THINKING_STARTED_EVENT,
    AI_TOKEN_USAGE_EVENT, AI_TOOL_ACTIVITY_EVENT, AI_USER_INPUT_REQUEST_EVENT, AiRuntimeEvent,
    message_completed, message_delta, message_started, now_iso8601, session_updated,
};
use crate::redaction::redact_env_key_value;
use crate::runtime::{AcpProtocolFlavor, RuntimeDefinition};
use crate::session::{NativeAiSession, SessionRegistry};

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

type PermissionWaiterMap = Arc<Mutex<HashMap<String, oneshot::Sender<RequestPermissionOutcome>>>>;
type UserInputWaiterMap = Arc<Mutex<HashMap<String, oneshot::Sender<CreateElicitationResponse>>>>;

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
    pub fn send_prompt(&self, message_id: MessageId, prompt: String) -> AiResult<()> {
        self.sender
            .send(AcpSessionCommand::Prompt { message_id, prompt })
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
        waiter.send(outcome).map_err(|_| AiError::RuntimeExited {
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
        let response = create_elicitation_response_from_input(input);
        waiter.send(response).map_err(|_| AiError::RuntimeExited {
            message: "The ACP user input request is no longer waiting.".to_string(),
        })
    }

    pub fn cancel_pending_requests(&self) {
        if let Ok(mut waiters) = self.permission_waiters.lock() {
            for (_, waiter) in waiters.drain() {
                let _ = waiter.send(RequestPermissionOutcome::Cancelled);
            }
        }
        if let Ok(mut waiters) = self.user_input_waiters.lock() {
            for (_, waiter) in waiters.drain() {
                let _ = waiter.send(CreateElicitationResponse::new(ElicitationAction::Cancel));
            }
        }
    }
}

#[derive(Debug)]
enum AcpSessionCommand {
    Prompt {
        message_id: MessageId,
        prompt: String,
    },
    Cancel {
        runtime_session_id: RuntimeSessionId,
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

    let notification_context = NotificationContext::new(session.clone(), event_sender.clone());
    let notification_context_for_handler = notification_context.clone();
    let permission_event_sender = event_sender.clone();
    let permission_session = session.clone();
    let permission_sessions = Arc::clone(&sessions);
    let permission_waiters_for_handler = Arc::clone(&permission_waiters);
    let user_input_event_sender = event_sender.clone();
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
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_capabilities(acp_client_capabilities()),
                    )
                    .block_task()
                    .await?;
                run_acp_auth_handshake(&connection, &spec, &initialize_response).await?;

                let new_session = NewSessionRequest::new(PathBuf::from(&session.scope.cwd))
                    .additional_directories(
                        session
                            .scope
                            .additional_roots
                            .iter()
                            .map(PathBuf::from)
                            .collect(),
                    );
                let new_session_response =
                    connection.send_request(new_session).block_task().await?;
                let runtime_session_id =
                    RuntimeSessionId(new_session_response.session_id.to_string());
                notification_context.set_runtime_session_id(runtime_session_id.clone());
                send_start_result(&started_sender, Ok(runtime_session_id.clone()));

                while let Some(command) = command_receiver.recv().await {
                    match command {
                        AcpSessionCommand::Prompt { message_id, prompt } => {
                            run_prompt(
                                &connection,
                                &session.session_id,
                                &session.runtime_id,
                                &runtime_session_id,
                                message_id,
                                prompt,
                                &sessions,
                                event_sender.as_ref(),
                                &notification_context,
                            )
                            .await;
                        }
                        AcpSessionCommand::Cancel { runtime_session_id } => {
                            connection.send_notification(CancelNotification::new(
                                agent_client_protocol::schema::SessionId::from(
                                    runtime_session_id.0.clone(),
                                ),
                            ))?;
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
                emit_event(
                    event_sender,
                    AI_SESSION_UPDATED_EVENT,
                    &session_updated(summary),
                );
                emit_event(
                    event_sender,
                    crate::events::AI_STATUS_EVENT,
                    &crate::events::status_event(
                        summary,
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
                    session_id: Some(session_id.clone()),
                    runtime_id: Some(runtime_id.clone()),
                    message: error.to_string(),
                    recoverable: true,
                    updated_at,
                },
            );
            if let Some(summary) = summary.as_ref() {
                emit_event(
                    event_sender,
                    AI_SESSION_UPDATED_EVENT,
                    &session_updated(summary),
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
) -> RequestPermissionOutcome {
    let request_id = next_request_id("permission");
    let runtime_session_id = RuntimeSessionId(request.session_id.to_string());
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
        .map(|mut waiters| waiters.insert(request_id.clone(), sender))
        .is_err()
    {
        emit_ai_error(
            event_sender,
            session,
            "Native AI permission state is unavailable.",
        );
        return RequestPermissionOutcome::Cancelled;
    }

    emit_session_status(
        sessions,
        event_sender,
        &session.session_id,
        NativeAiSessionStatus::WaitingPermission,
    );
    emit_event(
        event_sender,
        AI_PERMISSION_REQUEST_EVENT,
        &NativeAiPermissionRequestPayload {
            base: crate::events::event_base(
                &session.session_id,
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
    emit_session_status(
        sessions,
        event_sender,
        &session.session_id,
        NativeAiSessionStatus::Streaming,
    );
    outcome
}

async fn handle_user_input_request(
    request: CreateElicitationRequest,
    session: &NativeAiSession,
    sessions: &Arc<Mutex<SessionRegistry>>,
    event_sender: Option<&std_mpsc::SyncSender<AiRuntimeEvent>>,
    waiters: &UserInputWaiterMap,
) -> CreateElicitationResponse {
    let ElicitationMode::Form(form) = &request.mode else {
        return CreateElicitationResponse::new(ElicitationAction::Cancel);
    };
    let request_id = next_request_id("user-input");
    let runtime_session_id = runtime_session_id_from_elicitation(&request)
        .or_else(|| session.runtime_session_id.clone());
    let questions = elicitation_questions(form);
    let (sender, receiver) = oneshot::channel();
    if waiters
        .lock()
        .map(|mut waiters| waiters.insert(request_id.clone(), sender))
        .is_err()
    {
        emit_ai_error(
            event_sender,
            session,
            "Native AI user input state is unavailable.",
        );
        return CreateElicitationResponse::new(ElicitationAction::Cancel);
    }

    emit_session_status(
        sessions,
        event_sender,
        &session.session_id,
        NativeAiSessionStatus::WaitingUserInput,
    );
    emit_event(
        event_sender,
        AI_USER_INPUT_REQUEST_EVENT,
        &NativeAiUserInputRequestPayload {
            base: crate::events::event_base(
                &session.session_id,
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
    emit_session_status(
        sessions,
        event_sender,
        &session.session_id,
        NativeAiSessionStatus::Streaming,
    );
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
) -> CreateElicitationResponse {
    let mut content = BTreeMap::new();
    for answer in input.answers {
        let values = answer
            .answers
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>();
        match values.as_slice() {
            [] => {}
            [value] => {
                content.insert(
                    answer.question_id,
                    ElicitationContentValue::String(value.clone()),
                );
            }
            _ => {
                content.insert(
                    answer.question_id,
                    ElicitationContentValue::StringArray(values),
                );
            }
        }
    }

    if content.is_empty() {
        return CreateElicitationResponse::new(ElicitationAction::Cancel);
    }

    CreateElicitationResponse::new(ElicitationAction::Accept(
        ElicitationAcceptAction::new().content(content),
    ))
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
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(NotificationContextInner {
                event_sender,
                open_messages: HashMap::new(),
                runtime_session_id: session.runtime_session_id.clone(),
                session,
            })),
        }
    }

    fn set_runtime_session_id(&self, runtime_session_id: RuntimeSessionId) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.runtime_session_id = Some(runtime_session_id);
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
}

struct NotificationContextInner {
    event_sender: Option<std_mpsc::SyncSender<AiRuntimeEvent>>,
    open_messages: HashMap<String, StreamedMessage>,
    runtime_session_id: Option<RuntimeSessionId>,
    session: NativeAiSession,
}

impl NotificationContextInner {
    fn handle(&mut self, notification: SessionNotification) {
        let runtime_session_id = RuntimeSessionId(notification.session_id.to_string());
        self.runtime_session_id = Some(runtime_session_id);
        match notification.update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                self.handle_content_chunk("assistant", chunk);
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                self.handle_content_chunk("thinking", chunk);
            }
            SessionUpdate::ToolCall(tool_call) => {
                self.handle_tool_call(tool_call);
            }
            SessionUpdate::ToolCallUpdate(tool_call_update) => {
                self.handle_tool_call_update(tool_call_update);
            }
            SessionUpdate::Plan(plan) => {
                self.emit(
                    AI_PLAN_UPDATED_EVENT,
                    &NativeAiPlanUpdatedPayload {
                        base: self.event_base(),
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
                self.emit(
                    AI_TOKEN_USAGE_EVENT,
                    &NativeAiTokenUsagePayload {
                        base: self.event_base(),
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
                if let Some(title) = info.title.into_option() {
                    self.session.title = title;
                    let summary = self.session.summary();
                    self.emit(AI_SESSION_UPDATED_EVENT, &session_updated(&summary));
                }
            }
            SessionUpdate::UserMessageChunk(_)
            | SessionUpdate::AvailableCommandsUpdate(_)
            | SessionUpdate::CurrentModeUpdate(_)
            | SessionUpdate::ConfigOptionUpdate(_) => {}
            _ => {}
        }
    }

    fn handle_content_chunk(&mut self, message_kind: &'static str, chunk: ContentChunk) {
        let delta = content_block_text(&chunk.content);
        if delta.is_empty() {
            return;
        }

        let message_id = chunk
            .message_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| format!("acp:{message_kind}:{}", self.open_messages.len() + 1));
        let is_new = !self.open_messages.contains_key(&message_id);
        if is_new {
            let payload = if message_kind == "thinking" {
                AiRuntimeEvent::new(
                    AI_THINKING_STARTED_EVENT,
                    &message_started(&self.summary(), MessageId(message_id.clone()), message_kind),
                )
            } else {
                AiRuntimeEvent::new(
                    AI_MESSAGE_STARTED_EVENT,
                    &message_started(&self.summary(), MessageId(message_id.clone()), message_kind),
                )
            };
            self.send(payload);
        }

        let content = {
            let message = self
                .open_messages
                .entry(message_id.clone())
                .or_insert_with(|| StreamedMessage {
                    content: String::new(),
                    kind: message_kind,
                });
            message.content.push_str(&delta);
            message.content.clone()
        };
        let summary = self.summary();
        if message_kind == "thinking" {
            self.emit(
                AI_THINKING_DELTA_EVENT,
                &message_delta(
                    &summary,
                    MessageId(message_id),
                    message_kind,
                    delta,
                    content,
                ),
            );
        } else {
            self.emit(
                AI_MESSAGE_DELTA_EVENT,
                &message_delta(
                    &summary,
                    MessageId(message_id),
                    message_kind,
                    delta,
                    content,
                ),
            );
        }
    }

    fn handle_tool_call(&mut self, tool_call: ToolCall) {
        self.emit(
            AI_TOOL_ACTIVITY_EVENT,
            &NativeAiToolActivityPayload {
                base: self.event_base(),
                kind: serde_label(&tool_call.kind),
                status: serde_label(&tool_call.status),
                summary: None,
                title: tool_call.title,
                tool_call_id: NativeToolCallId(tool_call.tool_call_id.to_string()),
            },
        );
    }

    fn handle_tool_call_update(&mut self, tool_call_update: ToolCallUpdate) {
        self.emit(
            AI_TOOL_ACTIVITY_EVENT,
            &NativeAiToolActivityPayload {
                base: self.event_base(),
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
                tool_call_id: NativeToolCallId(tool_call_update.tool_call_id.to_string()),
            },
        );
    }

    fn complete_open_messages(&mut self) {
        let messages = std::mem::take(&mut self.open_messages);
        let summary = self.summary();
        for (message_id, message) in messages {
            if message.kind == "thinking" {
                self.emit(
                    AI_THINKING_COMPLETED_EVENT,
                    &message_completed(&summary, MessageId(message_id), message.kind),
                );
            } else {
                self.emit(
                    AI_MESSAGE_COMPLETED_EVENT,
                    &message_completed(&summary, MessageId(message_id), message.kind),
                );
            }
        }
    }

    fn summary(&self) -> NativeAiSessionSummary {
        let mut session = self.session.clone();
        session.runtime_session_id = self.runtime_session_id.clone();
        session.summary()
    }

    fn event_base(&self) -> comando_types::ai::NativeAiEventBase {
        crate::events::event_base(
            &self.session.session_id,
            &self.session.runtime_id,
            self.runtime_session_id.clone(),
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
        NativeAiAuthHandshakeSpec, NativeAiDesiredSelections, NativeAiRuntimeStatus,
        NativeAiUserInputAnswer,
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
            desired_selections: NativeAiDesiredSelections {
                model_id: None,
                mode_id: None,
                config_options: BTreeMap::new(),
            },
        }
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
        let response = create_elicitation_response_from_input(NativeAiUserInputResponseInput {
            session_id: SessionId("s1".to_string()),
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
            ],
        });

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
    }

    #[test]
    fn maps_empty_user_input_to_elicitation_cancel() {
        let response = create_elicitation_response_from_input(NativeAiUserInputResponseInput {
            session_id: SessionId("s1".to_string()),
            request_id: "user-input-1".to_string(),
            answers: Vec::new(),
        });

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
