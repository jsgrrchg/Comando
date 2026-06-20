use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, mpsc as std_mpsc};

use agent_client_protocol::schema::{
    CancelNotification, ContentBlock, ContentChunk, InitializeRequest, NewSessionRequest,
    PromptRequest, ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionNotification, SessionUpdate,
    StopReason, TextContent, ToolCall, ToolCallUpdate,
};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo};
use comando_types::ai::{
    NativeAiErrorPayload, NativeAiLaunchSpec, NativeAiPlanEntryPayload, NativeAiPlanUpdatedPayload,
    NativeAiSessionStatus, NativeAiSessionSummary, NativeAiTokenUsageCost,
    NativeAiTokenUsagePayload, NativeAiToolActivityPayload,
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
    AI_PLAN_UPDATED_EVENT, AI_SESSION_UPDATED_EVENT, AI_THINKING_COMPLETED_EVENT,
    AI_THINKING_DELTA_EVENT, AI_THINKING_STARTED_EVENT, AI_TOKEN_USAGE_EVENT,
    AI_TOOL_ACTIVITY_EVENT, AiRuntimeEvent, message_completed, message_delta, message_started,
    now_iso8601, session_updated,
};
use crate::redaction::redact_env_key_value;
use crate::session::{NativeAiSession, SessionRegistry};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpProcessSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
}

impl AcpProcessSpec {
    pub fn from_launch(launch: &NativeAiLaunchSpec) -> Self {
        Self {
            executable: launch.executable.clone(),
            args: launch.args.clone(),
            cwd: launch.cwd.clone(),
            env: launch.env.clone(),
        }
    }

    pub fn redacted_env(&self) -> BTreeMap<String, String> {
        self.env
            .iter()
            .map(|(key, value)| (key.clone(), redact_env_key_value(key, value)))
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct AcpSessionController {
    sender: tokio_mpsc::UnboundedSender<AcpSessionCommand>,
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
        let _ = self.sender.send(AcpSessionCommand::Close);
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
    let controller = AcpSessionController {
        sender: command_sender,
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
                if let Some(sender) = &permission_event_sender {
                    let _ = sender.send(AiRuntimeEvent::new(
                        AI_ERROR_EVENT,
                        &NativeAiErrorPayload {
                            session_id: Some(permission_session.session_id.clone()),
                            runtime_id: Some(permission_session.runtime_id.clone()),
                            message: "Native AI permission prompts are not supported in this rollout yet.".to_string(),
                            recoverable: true,
                            updated_at: now_iso8601(),
                        },
                    ));
                }
                let selected_reject = request
                    .options
                    .iter()
                    .find(|option| {
                        serde_json::to_value(&option.kind)
                            .ok()
                            .as_ref()
                            .and_then(|v| v.as_str())
                            .is_some_and(|kind| kind.starts_with("reject"))
                    })
                    .map(|option| option.option_id.clone());
                let response = selected_reject
                    .map(|option_id| {
                        RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
                            SelectedPermissionOutcome::new(option_id),
                        ))
                    })
                    .unwrap_or_else(|| {
                        RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)
                    });
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
                connection
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

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

async fn drain_stderr(stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while lines.next_line().await.ok().flatten().is_some() {}
}

fn mark_session_idle(
    sessions: &Arc<Mutex<SessionRegistry>>,
    session_id: &SessionId,
) -> Option<NativeAiSessionSummary> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(session_id).ok()?;
    session.prompt_in_flight = false;
    session.active_message_id = None;
    session.set_status(NativeAiSessionStatus::Idle);
    Some(session.session.summary())
}

fn mark_session_error(
    sessions: &Arc<Mutex<SessionRegistry>>,
    session_id: &SessionId,
) -> Option<NativeAiSessionSummary> {
    let mut sessions = sessions.lock().ok()?;
    let session = sessions.get_mut(session_id).ok()?;
    session.prompt_in_flight = false;
    session.active_message_id = None;
    session.set_status(NativeAiSessionStatus::Error);
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
    use comando_types::ai::NativeAiRuntimeStatus;

    #[test]
    fn redacts_launch_env() {
        let mut env = BTreeMap::new();
        env.insert("OPENAI_API_KEY".to_string(), "sk-secret".to_string());
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        let spec = AcpProcessSpec::from_launch(&NativeAiLaunchSpec {
            executable: "opencode".to_string(),
            args: vec!["acp".to_string()],
            cwd: "/tmp".to_string(),
            env,
            command: "opencode acp".to_string(),
            status: NativeAiRuntimeStatus {
                runtime_id: RuntimeId("opencode".to_string()),
                state: "ready".to_string(),
                auth_method: None,
                auth_methods: Vec::new(),
                auth_ready: true,
                checked_at: now_iso8601(),
                command: Some("opencode acp".to_string()),
                message: None,
                onboarding_required: false,
                source: Some("path".to_string()),
                has_custom_binary_path: false,
                has_gateway_config: false,
                has_gateway_url: false,
            },
        });

        assert_eq!(spec.redacted_env()["OPENAI_API_KEY"], "[redacted]");
        assert_eq!(spec.redacted_env()["PATH"], "/usr/bin");
    }

    #[test]
    fn extracts_text_content_from_acp_blocks() {
        let block = ContentBlock::Text(TextContent::new("hello"));
        assert_eq!(content_block_text(&block), "hello");
    }
}
