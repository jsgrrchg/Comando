use std::sync::{Arc, Mutex, mpsc};

use comando_types::ai::{
    NativeAiCancelSessionOutput, NativeAiCloseSessionOutput, NativeAiGetRuntimeStatusInput,
    NativeAiListRuntimesOutput, NativeAiPermissionResponseInput, NativeAiPrepareSessionInput,
    NativeAiRuntimeStatus, NativeAiSendPromptInput, NativeAiSendPromptOutput,
    NativeAiSessionIdInput, NativeAiSessionStatus, NativeAiSessionSummary,
    NativeAiSetSessionConfigOptionInput, NativeAiSetSessionModeInput, NativeAiSetSessionModelInput,
    NativeAiUserInputResponseInput,
};

use crate::acp::{AcpProcessSpec, NativeAiConfigValue, start_acp_session};
use crate::commands::{
    cancel_session_output, close_session_output, list_runtimes_output, prepare_session_output,
    send_prompt_output,
};
use crate::error::{AiError, AiResult};
use crate::events::AiRuntimeEvent;
use crate::runtime::RuntimeRegistry;
use crate::session::{NativeAiSession, SessionRegistry};

#[derive(Debug, Clone)]
pub struct AiEngineConfig {
    pub selected_native_runtime: String,
}

impl Default for AiEngineConfig {
    fn default() -> Self {
        Self {
            selected_native_runtime: "opencode".to_string(),
        }
    }
}

#[derive(Clone)]
pub struct AiEngine {
    _config: AiEngineConfig,
    event_sender: Arc<Mutex<Option<mpsc::SyncSender<AiRuntimeEvent>>>>,
    registry: RuntimeRegistry,
    runtime: Arc<tokio::runtime::Runtime>,
    sessions: Arc<Mutex<SessionRegistry>>,
}

impl Default for AiEngine {
    fn default() -> Self {
        Self::new(AiEngineConfig::default())
    }
}

impl AiEngine {
    pub fn new(config: AiEngineConfig) -> Self {
        Self {
            _config: config,
            event_sender: Arc::new(Mutex::new(None)),
            registry: RuntimeRegistry::default(),
            runtime: Arc::new(
                tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .thread_name("comando-ai-acp")
                    .build()
                    .expect("native AI Tokio runtime starts"),
            ),
            sessions: Arc::new(Mutex::new(SessionRegistry::default())),
        }
    }

    pub fn set_event_sender(&self, sender: mpsc::SyncSender<AiRuntimeEvent>) -> AiResult<()> {
        let mut event_sender = self
            .event_sender
            .lock()
            .map_err(|error| AiError::Internal(format!("AI event sender lock failed: {error}")))?;
        *event_sender = Some(sender);
        Ok(())
    }

    pub fn list_runtimes(&self) -> NativeAiListRuntimesOutput {
        list_runtimes_output(self.registry.list())
    }

    pub fn get_runtime_status(
        &self,
        input: NativeAiGetRuntimeStatusInput,
    ) -> AiResult<NativeAiRuntimeStatus> {
        let runtime_id = input.runtime_id.0;
        let launch_status = input.launch.map(|launch| launch.status);
        self.registry.status_from_launch(&runtime_id, launch_status)
    }

    pub fn prepare_session(
        &self,
        input: NativeAiPrepareSessionInput,
    ) -> AiResult<NativeAiSessionSummary> {
        let definition = self.registry.require_native(&input.runtime_id.0)?;

        let runtime_id = input.runtime_id.0.clone();
        let launch = input
            .launch
            .clone()
            .ok_or_else(|| AiError::RuntimeLaunchContextInvalid {
                runtime_id: runtime_id.clone(),
                message: "Native AI sessions require a launch context.".to_string(),
            })?;
        let session = NativeAiSession::from_prepare_input(input)?;
        let sessions = self.lock_sessions()?;
        if sessions.get(&session.session_id).is_ok() {
            return Err(AiError::SessionOwnerMismatch {
                session_id: session.session_id.0,
                owner: "native".to_string(),
                expected: "new".to_string(),
            });
        }
        let event_sender = self.event_sender()?;
        drop(sessions);
        let spec = AcpProcessSpec::from_launch(definition, &launch)?;
        let (session, controller) = start_acp_session(
            &self.runtime,
            spec,
            session,
            Arc::clone(&self.sessions),
            event_sender,
        )?;
        let mut sessions = self.lock_sessions()?;
        prepare_session_output(sessions.insert_with_acp_controller(session, controller)?).pipe(Ok)
    }

    pub fn send_prompt(
        &self,
        input: NativeAiSendPromptInput,
    ) -> AiResult<(NativeAiSendPromptOutput, NativeAiSessionSummary)> {
        if input.prompt.text.trim().is_empty() && input.prompt.attachments.is_empty() {
            return Err(AiError::PromptRejected {
                session_id: input.session_id.0,
                message: "Type a prompt before sending it.".to_string(),
            });
        }
        if !input.prompt.attachments.is_empty() {
            return Err(AiError::Unsupported(
                "Native AI image attachments are not supported in this rollout yet.".to_string(),
            ));
        }

        let mut sessions = self.lock_sessions()?;
        let session = sessions.get_mut(&input.session_id)?;
        if session.prompt_in_flight || session.session.status == NativeAiSessionStatus::Streaming {
            return Err(AiError::SessionBusy {
                session_id: input.session_id.0,
            });
        }
        let Some(controller) = session.acp_controller.clone() else {
            return Err(AiError::Unsupported(
                "Native prompts require an ACP-backed session.".to_string(),
            ));
        };

        session.prompt_in_flight = true;
        session.active_message_id = Some(input.message_id.0.clone());
        session.set_status(NativeAiSessionStatus::Streaming);
        if let Err(error) =
            controller.send_prompt(input.message_id.clone(), input.prompt.text.clone())
        {
            session.prompt_in_flight = false;
            session.active_message_id = None;
            session.set_status(NativeAiSessionStatus::Error);
            return Err(error);
        }
        let summary = session.session.summary();
        Ok((send_prompt_output(input.session_id), summary))
    }

    pub fn cancel_session(
        &self,
        input: NativeAiSessionIdInput,
    ) -> AiResult<(NativeAiCancelSessionOutput, NativeAiSessionSummary)> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions.get_mut(&input.session_id)?;
        session.prompt_in_flight = false;
        session.active_message_id = None;
        if let (Some(controller), Some(runtime_session_id)) = (
            session.acp_controller.clone(),
            session.session.runtime_session_id.clone(),
        ) {
            controller.cancel_pending_requests();
            controller.cancel(runtime_session_id)?;
        }
        session.set_status(NativeAiSessionStatus::Idle);
        let summary = session.session.summary();
        Ok((cancel_session_output(input.session_id), summary))
    }

    pub fn close_session(
        &self,
        input: NativeAiSessionIdInput,
    ) -> AiResult<(NativeAiCloseSessionOutput, NativeAiSessionSummary)> {
        let mut sessions = self.lock_sessions()?;
        let mut session = sessions.close(&input.session_id)?;
        if let Some(controller) = session.acp_controller.take() {
            controller.close();
        }
        session.prompt_in_flight = false;
        session.active_message_id = None;
        session.set_status(NativeAiSessionStatus::Closed);
        let summary = session.session.summary();
        Ok((close_session_output(input.session_id), summary))
    }

    pub fn set_session_mode(&self, input: NativeAiSetSessionModeInput) -> AiResult<()> {
        self.set_session_config_value(
            &input.session_id,
            "mode".to_string(),
            NativeAiConfigValue::ValueId(input.mode_id),
        )
    }

    pub fn set_session_model(&self, input: NativeAiSetSessionModelInput) -> AiResult<()> {
        self.set_session_config_value(
            &input.session_id,
            "model".to_string(),
            NativeAiConfigValue::ValueId(input.model_id),
        )
    }

    pub fn set_session_config_option(
        &self,
        input: NativeAiSetSessionConfigOptionInput,
    ) -> AiResult<()> {
        let value = native_config_value(input.value)?;
        self.set_session_config_value(&input.session_id, input.option_id, value)
    }

    pub fn respond_permission(&self, input: NativeAiPermissionResponseInput) -> AiResult<()> {
        let controller = self
            .lock_sessions()?
            .get(&input.session_id)?
            .acp_controller
            .clone()
            .ok_or_else(|| {
                AiError::Unsupported(
                    "Native permission responses require an ACP-backed session.".to_string(),
                )
            })?;
        controller.respond_permission(input)
    }

    pub fn respond_user_input(&self, input: NativeAiUserInputResponseInput) -> AiResult<()> {
        let controller = self
            .lock_sessions()?
            .get(&input.session_id)?
            .acp_controller
            .clone()
            .ok_or_else(|| {
                AiError::Unsupported(
                    "Native user input responses require an ACP-backed session.".to_string(),
                )
            })?;
        controller.respond_user_input(input)
    }

    pub fn close_owned_by_window(
        &self,
        owner_window_id: &str,
    ) -> AiResult<Vec<NativeAiSessionSummary>> {
        let mut sessions = self.lock_sessions()?;
        Ok(sessions
            .close_owned_by_window(owner_window_id)
            .into_iter()
            .map(|mut session| {
                if let Some(controller) = session.acp_controller.take() {
                    controller.close();
                }
                session.session.summary()
            })
            .collect())
    }

    fn set_session_config_value(
        &self,
        session_id: &comando_types::ids::SessionId,
        config_id: String,
        value: NativeAiConfigValue,
    ) -> AiResult<()> {
        let session = self.lock_sessions()?.get(session_id)?.session.clone();
        let runtime_session_id = session.runtime_session_id.clone().ok_or_else(|| {
            AiError::Unsupported("Native config changes require an ACP-backed session.".to_string())
        })?;
        let controller = self
            .lock_sessions()?
            .get(session_id)?
            .acp_controller
            .clone()
            .ok_or_else(|| {
                AiError::Unsupported(
                    "Native config changes require an ACP-backed session.".to_string(),
                )
            })?;
        controller.set_config_option(runtime_session_id, config_id, value)
    }

    fn lock_sessions(&self) -> AiResult<std::sync::MutexGuard<'_, SessionRegistry>> {
        self.sessions
            .lock()
            .map_err(|error| AiError::Internal(format!("AI session registry lock failed: {error}")))
    }

    fn event_sender(&self) -> AiResult<Option<mpsc::SyncSender<AiRuntimeEvent>>> {
        self.event_sender
            .lock()
            .map(|sender| sender.clone())
            .map_err(|error| AiError::Internal(format!("AI event sender lock failed: {error}")))
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}

impl<T> Pipe for T {}

fn native_config_value(value: serde_json::Value) -> AiResult<NativeAiConfigValue> {
    match value {
        serde_json::Value::Bool(value) => Ok(NativeAiConfigValue::Boolean(value)),
        serde_json::Value::String(value) if !value.trim().is_empty() => {
            Ok(NativeAiConfigValue::ValueId(value))
        }
        _ => Err(AiError::Unsupported(
            "Native config changes only support boolean and select values.".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use comando_types::ids::{RuntimeId, SessionId};

    fn prepare_input(session_id: &str, runtime_id: &str) -> NativeAiPrepareSessionInput {
        NativeAiPrepareSessionInput {
            window_id: "window_main".to_string(),
            session_id: SessionId(session_id.to_string()),
            runtime_id: RuntimeId(runtime_id.to_string()),
            project_id: None,
            worktree_id: None,
            cwd: "/tmp".to_string(),
            title: "AI Session".to_string(),
            model_id: None,
            mode_id: None,
            config_options: Default::default(),
            additional_roots: Vec::new(),
            launch: None,
        }
    }

    #[test]
    fn rejects_missing_launch_before_session_creation() {
        let engine = AiEngine::default();

        assert!(matches!(
            engine.prepare_session(prepare_input("s1", "opencode")),
            Err(AiError::RuntimeLaunchContextInvalid { .. })
        ));
    }

    #[test]
    fn rejects_unknown_runtime_before_session_creation() {
        let engine = AiEngine::default();

        assert!(matches!(
            engine.prepare_session(prepare_input("s1", "gemini")),
            Err(AiError::RuntimeMissing { .. })
        ));
    }

    #[test]
    fn prompt_requires_acp_backed_session() {
        let engine = AiEngine::default();
        {
            let mut sessions = engine.lock_sessions().unwrap();
            sessions
                .insert(
                    NativeAiSession::from_prepare_input(prepare_input("s1", "opencode")).unwrap(),
                )
                .unwrap();
        }
        let input = NativeAiSendPromptInput {
            session_id: SessionId("s1".to_string()),
            message_id: comando_types::ids::MessageId("m1".to_string()),
            prompt: comando_types::ai::NativeAiPromptInput {
                text: "hello".to_string(),
                attachments: Vec::new(),
            },
        };

        assert!(matches!(
            engine.send_prompt(input),
            Err(AiError::Unsupported(_))
        ));
    }
}
