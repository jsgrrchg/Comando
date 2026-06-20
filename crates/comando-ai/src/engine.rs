use std::sync::{Arc, Mutex, mpsc};

use comando_types::ai::{
    NativeAiCancelSessionOutput, NativeAiCloseSessionOutput, NativeAiGetRuntimeStatusInput,
    NativeAiListRuntimesOutput, NativeAiPrepareSessionInput, NativeAiRuntimeStatus,
    NativeAiSendPromptInput, NativeAiSendPromptOutput, NativeAiSessionIdInput,
    NativeAiSessionStatus, NativeAiSessionSummary, NativeAiSetSessionConfigOptionInput,
    NativeAiSetSessionModeInput, NativeAiSetSessionModelInput,
};

use crate::acp::{AcpProcessSpec, start_acp_session};
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
    config: AiEngineConfig,
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
            config,
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
        self.registry.require_native(&input.runtime_id.0)?;
        if input.runtime_id.0 != self.config.selected_native_runtime {
            return Err(AiError::RuntimeNotNative {
                runtime_id: input.runtime_id.0,
            });
        }

        let launch = input.launch.clone();
        let session = NativeAiSession::from_prepare_input(input)?;
        let mut sessions = self.lock_sessions()?;
        if let Some(launch) = launch {
            if sessions.get(&session.session_id).is_ok() {
                return Err(AiError::SessionOwnerMismatch {
                    session_id: session.session_id.0,
                    owner: "native".to_string(),
                    expected: "new".to_string(),
                });
            }
            let event_sender = self.event_sender()?;
            drop(sessions);
            let spec = AcpProcessSpec::from_launch(&launch);
            let (session, controller) = start_acp_session(
                &self.runtime,
                spec,
                session,
                Arc::clone(&self.sessions),
                event_sender,
            )?;
            let mut sessions = self.lock_sessions()?;
            prepare_session_output(sessions.insert_with_acp_controller(session, controller)?)
                .pipe(Ok)
        } else {
            prepare_session_output(sessions.insert(session)?).pipe(Ok)
        }
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

        session.prompt_in_flight = true;
        session.active_message_id = Some(input.message_id.0.clone());
        session.set_status(NativeAiSessionStatus::Streaming);
        if let Some(controller) = session.acp_controller.clone() {
            if let Err(error) =
                controller.send_prompt(input.message_id.clone(), input.prompt.text.clone())
            {
                session.prompt_in_flight = false;
                session.active_message_id = None;
                session.set_status(NativeAiSessionStatus::Error);
                return Err(error);
            }
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
        self.require_known_session(&input.session_id)?;
        Err(AiError::Unsupported(
            "Native mode changes are not implemented for this runtime yet.".to_string(),
        ))
    }

    pub fn set_session_model(&self, input: NativeAiSetSessionModelInput) -> AiResult<()> {
        self.require_known_session(&input.session_id)?;
        Err(AiError::Unsupported(
            "Native model changes are not implemented for this runtime yet.".to_string(),
        ))
    }

    pub fn set_session_config_option(
        &self,
        input: NativeAiSetSessionConfigOptionInput,
    ) -> AiResult<()> {
        self.require_known_session(&input.session_id)?;
        Err(AiError::Unsupported(
            "Native config changes are not implemented for this runtime yet.".to_string(),
        ))
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

    fn require_known_session(&self, session_id: &comando_types::ids::SessionId) -> AiResult<()> {
        self.lock_sessions()?.get(session_id).map(|_| ())
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
    fn prepares_native_opencode_session() {
        let engine = AiEngine::default();
        let summary = engine
            .prepare_session(prepare_input("s1", "opencode"))
            .unwrap();

        assert_eq!(summary.session_id.0, "s1");
        assert_eq!(summary.runtime_id.0, "opencode");
        assert_eq!(summary.status, NativeAiSessionStatus::Idle);
    }

    #[test]
    fn rejects_non_native_runtime_before_session_creation() {
        let engine = AiEngine::default();

        assert!(matches!(
            engine.prepare_session(prepare_input("s1", "claude")),
            Err(AiError::RuntimeNotNative { .. })
        ));
    }

    #[test]
    fn prompt_marks_session_busy_until_cancel() {
        let engine = AiEngine::default();
        engine
            .prepare_session(prepare_input("s1", "opencode"))
            .unwrap();
        let input = NativeAiSendPromptInput {
            session_id: SessionId("s1".to_string()),
            message_id: comando_types::ids::MessageId("m1".to_string()),
            prompt: comando_types::ai::NativeAiPromptInput {
                text: "hello".to_string(),
                attachments: Vec::new(),
            },
        };

        assert!(engine.send_prompt(input.clone()).unwrap().0.accepted);
        assert!(matches!(
            engine.send_prompt(input.clone()),
            Err(AiError::SessionBusy { .. })
        ));

        engine
            .cancel_session(NativeAiSessionIdInput {
                session_id: SessionId("s1".to_string()),
            })
            .unwrap();
        assert!(engine.send_prompt(input).unwrap().0.accepted);
    }
}
