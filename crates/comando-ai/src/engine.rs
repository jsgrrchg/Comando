use std::sync::{Arc, Mutex};

use comando_types::ai::{
    NativeAiCancelSessionOutput, NativeAiCloseSessionOutput, NativeAiGetRuntimeStatusInput,
    NativeAiListRuntimesOutput, NativeAiPrepareSessionInput, NativeAiRuntimeStatus,
    NativeAiSendPromptInput, NativeAiSendPromptOutput, NativeAiSessionIdInput,
    NativeAiSessionStatus, NativeAiSessionSummary, NativeAiSetSessionConfigOptionInput,
    NativeAiSetSessionModeInput, NativeAiSetSessionModelInput,
};

use crate::commands::{
    cancel_session_output, close_session_output, list_runtimes_output, prepare_session_output,
    send_prompt_output,
};
use crate::error::{AiError, AiResult};
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
    registry: RuntimeRegistry,
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
            registry: RuntimeRegistry::default(),
            sessions: Arc::new(Mutex::new(SessionRegistry::default())),
        }
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

        let session = NativeAiSession::from_prepare_input(input)?;
        let mut sessions = self.lock_sessions()?;
        prepare_session_output(sessions.insert(session)?).pipe(Ok)
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

        let mut sessions = self.lock_sessions()?;
        let session = sessions.get_mut(&input.session_id)?;
        if session.prompt_in_flight || session.session.status == NativeAiSessionStatus::Streaming {
            return Err(AiError::SessionBusy {
                session_id: input.session_id.0,
            });
        }

        session.prompt_in_flight = true;
        session.active_message_id = Some(input.message_id.0);
        session.set_status(NativeAiSessionStatus::Streaming);
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
            .map(|session| session.session.summary())
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
