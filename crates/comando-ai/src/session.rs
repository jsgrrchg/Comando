use std::collections::HashMap;

use comando_types::ai::{
    NativeAiPrepareSessionInput, NativeAiSessionStatus, NativeAiSessionSummary,
};
use comando_types::ids::{RuntimeId, RuntimeSessionId, SessionId};

use crate::acp::AcpSessionController;
use crate::error::{AiError, AiResult};
use crate::events::now_iso8601;
use crate::scope::SessionScope;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeAiSession {
    pub owner_window_id: String,
    pub runtime_id: RuntimeId,
    pub runtime_session_id: Option<RuntimeSessionId>,
    pub scope: SessionScope,
    pub session_id: SessionId,
    pub status: NativeAiSessionStatus,
    pub title: String,
    pub updated_at: String,
}

impl NativeAiSession {
    pub fn from_prepare_input(input: NativeAiPrepareSessionInput) -> AiResult<Self> {
        if input.window_id.trim().is_empty() {
            return Err(AiError::InvalidInput(
                "Native AI sessions require an owner window.".to_string(),
            ));
        }

        let runtime_session_id = input
            .launch
            .as_ref()
            .and_then(|launch| launch.persisted_runtime_session_id.clone());

        Ok(Self {
            owner_window_id: input.window_id,
            runtime_id: input.runtime_id,
            runtime_session_id,
            scope: SessionScope::new(
                input.project_id,
                input.worktree_id,
                input.cwd,
                input.additional_roots,
            )?,
            session_id: input.session_id,
            status: NativeAiSessionStatus::Idle,
            title: if input.title.trim().is_empty() {
                "AI Session".to_string()
            } else {
                input.title
            },
            updated_at: now_iso8601(),
        })
    }

    pub fn summary(&self) -> NativeAiSessionSummary {
        NativeAiSessionSummary {
            session_id: self.session_id.clone(),
            runtime_id: self.runtime_id.clone(),
            runtime_session_id: self.runtime_session_id.clone(),
            project_id: self.scope.project_id.clone(),
            worktree_id: self.scope.worktree_id.clone(),
            title: self.title.clone(),
            status: self.status.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

#[derive(Debug)]
pub struct ManagedAiSession {
    pub session: NativeAiSession,
    pub acp_controller: Option<AcpSessionController>,
    active_prompt_message_ids: HashMap<String, String>,
}

impl ManagedAiSession {
    pub fn new(session: NativeAiSession) -> Self {
        Self {
            session,
            acp_controller: None,
            active_prompt_message_ids: HashMap::new(),
        }
    }

    pub fn with_acp_controller(
        session: NativeAiSession,
        acp_controller: AcpSessionController,
    ) -> Self {
        Self {
            session,
            acp_controller: Some(acp_controller),
            active_prompt_message_ids: HashMap::new(),
        }
    }

    pub fn begin_prompt(&mut self, target_session_id: &SessionId, message_id: &str) -> bool {
        if self
            .active_prompt_message_ids
            .contains_key(&target_session_id.0)
        {
            return false;
        }
        self.active_prompt_message_ids
            .insert(target_session_id.0.clone(), message_id.to_string());
        true
    }

    pub fn finish_prompt(&mut self, target_session_id: &SessionId, message_id: &str) -> bool {
        if self
            .active_prompt_message_ids
            .get(&target_session_id.0)
            .is_none_or(|active_message_id| active_message_id != message_id)
        {
            return false;
        }
        self.active_prompt_message_ids.remove(&target_session_id.0);
        true
    }

    pub fn cancel_prompt(&mut self, target_session_id: &SessionId) -> Option<String> {
        self.active_prompt_message_ids.remove(&target_session_id.0)
    }

    pub fn clear_prompts(&mut self) {
        self.active_prompt_message_ids.clear();
    }

    pub fn set_status(&mut self, status: NativeAiSessionStatus) {
        self.session.status = status;
        self.session.updated_at = now_iso8601();
    }

    pub fn set_runtime_session_id(&mut self, runtime_session_id: RuntimeSessionId) {
        self.session.runtime_session_id = Some(runtime_session_id);
        self.session.updated_at = now_iso8601();
    }
}

#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions: HashMap<String, ManagedAiSession>,
    pending_runtime_titles: HashMap<String, String>,
}

impl SessionRegistry {
    pub fn insert(&mut self, mut session: NativeAiSession) -> AiResult<NativeAiSessionSummary> {
        let session_id = session.session_id.0.clone();
        if self.sessions.contains_key(&session_id) {
            return Err(AiError::SessionOwnerMismatch {
                session_id,
                owner: "native".to_string(),
                expected: "new".to_string(),
            });
        }

        self.apply_pending_runtime_title(&mut session);
        let summary = session.summary();
        self.sessions
            .insert(summary.session_id.0.clone(), ManagedAiSession::new(session));
        Ok(summary)
    }

    pub fn insert_with_acp_controller(
        &mut self,
        mut session: NativeAiSession,
        acp_controller: AcpSessionController,
    ) -> AiResult<NativeAiSessionSummary> {
        let session_id = session.session_id.0.clone();
        if self.sessions.contains_key(&session_id) {
            return Err(AiError::SessionOwnerMismatch {
                session_id,
                owner: "native".to_string(),
                expected: "new".to_string(),
            });
        }

        self.apply_pending_runtime_title(&mut session);
        let summary = session.summary();
        self.sessions.insert(
            summary.session_id.0.clone(),
            ManagedAiSession::with_acp_controller(session, acp_controller),
        );
        Ok(summary)
    }

    pub fn get(&self, session_id: &SessionId) -> AiResult<&ManagedAiSession> {
        self.sessions
            .get(&session_id.0)
            .ok_or_else(|| AiError::SessionNotFound {
                session_id: session_id.0.clone(),
            })
    }

    pub fn get_mut(&mut self, session_id: &SessionId) -> AiResult<&mut ManagedAiSession> {
        self.sessions
            .get_mut(&session_id.0)
            .ok_or_else(|| AiError::SessionNotFound {
                session_id: session_id.0.clone(),
            })
    }

    pub fn mark_status(
        &mut self,
        session_id: &SessionId,
        status: NativeAiSessionStatus,
    ) -> AiResult<NativeAiSessionSummary> {
        let session = self.get_mut(session_id)?;
        session.set_status(status);
        Ok(session.session.summary())
    }

    pub fn set_runtime_title(&mut self, session_id: &SessionId, title: String) {
        let Some(session) = self.sessions.get_mut(&session_id.0) else {
            // ACP can publish SessionInfo before its startup path has inserted
            // the root session. Keep that title so the first status cannot win.
            self.pending_runtime_titles
                .insert(session_id.0.clone(), title);
            return;
        };
        if session.session.title != title {
            // Runtime titles must update the same session record used by turn
            // lifecycle events so later status updates cannot restore a stale title.
            session.session.title = title;
            session.session.updated_at = now_iso8601();
        }
    }

    fn apply_pending_runtime_title(&mut self, session: &mut NativeAiSession) {
        let Some(title) = self.pending_runtime_titles.remove(&session.session_id.0) else {
            return;
        };
        if session.title != title {
            session.title = title;
            session.updated_at = now_iso8601();
        }
    }

    pub fn close(&mut self, session_id: &SessionId) -> AiResult<ManagedAiSession> {
        self.sessions
            .remove(&session_id.0)
            .ok_or_else(|| AiError::SessionNotFound {
                session_id: session_id.0.clone(),
            })
    }

    pub fn close_owned_by_window(&mut self, owner_window_id: &str) -> Vec<ManagedAiSession> {
        let session_ids = self
            .sessions
            .iter()
            .filter(|(_, session)| session.session.owner_window_id == owner_window_id)
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();

        session_ids
            .into_iter()
            .filter_map(|session_id| self.sessions.remove(&session_id))
            .collect()
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepare_input(session_id: &str, window_id: &str) -> NativeAiPrepareSessionInput {
        NativeAiPrepareSessionInput {
            window_id: window_id.to_string(),
            session_id: SessionId(session_id.to_string()),
            runtime_id: RuntimeId("opencode".to_string()),
            project_id: None,
            worktree_id: None,
            cwd: "/tmp".to_string(),
            title: "Test".to_string(),
            model_id: None,
            mode_id: None,
            config_options: Default::default(),
            additional_roots: Vec::new(),
            custom_acp_launch: None,
            persisted_runtime_session_id: None,
            persisted_subagent_session_mappings: Vec::new(),
            launch: None,
        }
    }

    #[test]
    fn creates_and_closes_session() {
        let mut registry = SessionRegistry::default();
        let session = NativeAiSession::from_prepare_input(prepare_input("s1", "w1")).unwrap();
        let summary = registry.insert(session).unwrap();

        assert_eq!(summary.session_id.0, "s1");
        assert_eq!(registry.len(), 1);
        registry.close(&SessionId("s1".to_string())).unwrap();
        assert!(registry.is_empty());
    }

    #[test]
    fn rejects_duplicate_session() {
        let mut registry = SessionRegistry::default();
        registry
            .insert(NativeAiSession::from_prepare_input(prepare_input("s1", "w1")).unwrap())
            .unwrap();

        assert!(matches!(
            registry
                .insert(NativeAiSession::from_prepare_input(prepare_input("s1", "w1")).unwrap()),
            Err(AiError::SessionOwnerMismatch { .. })
        ));
    }

    #[test]
    fn closes_sessions_by_owner_window() {
        let mut registry = SessionRegistry::default();
        registry
            .insert(NativeAiSession::from_prepare_input(prepare_input("s1", "w1")).unwrap())
            .unwrap();
        registry
            .insert(NativeAiSession::from_prepare_input(prepare_input("s2", "w2")).unwrap())
            .unwrap();

        let closed = registry.close_owned_by_window("w1");
        assert_eq!(closed.len(), 1);
        assert!(registry.get(&SessionId("s2".to_string())).is_ok());
    }

    #[test]
    fn tracks_active_prompts_independently_by_target() {
        let root_session_id = SessionId("root".to_string());
        let child_session_id = SessionId("child".to_string());
        let session = NativeAiSession::from_prepare_input(prepare_input("root", "w1")).unwrap();
        let mut managed = ManagedAiSession::new(session);

        assert!(managed.begin_prompt(&root_session_id, "root-message"));
        assert!(managed.begin_prompt(&child_session_id, "child-message"));
        assert!(!managed.begin_prompt(&child_session_id, "child-message-2"));

        assert!(managed.finish_prompt(&child_session_id, "child-message"));
        assert!(managed.begin_prompt(&child_session_id, "child-message-2"));
        assert!(!managed.begin_prompt(&root_session_id, "root-message-2"));

        assert_eq!(
            managed.cancel_prompt(&root_session_id),
            Some("root-message".to_string())
        );
        assert!(managed.begin_prompt(&root_session_id, "root-message-2"));
    }

    #[test]
    fn runtime_title_replaces_the_default_session_title() {
        let mut registry = SessionRegistry::default();
        registry
            .insert(NativeAiSession::from_prepare_input(prepare_input("s1", "w1")).unwrap())
            .unwrap();

        registry.set_runtime_title(
            &SessionId("s1".to_string()),
            "Investigate startup crash".to_string(),
        );
        let summary = registry
            .get(&SessionId("s1".to_string()))
            .unwrap()
            .session
            .summary();

        assert_eq!(summary.title, "Investigate startup crash");
    }

    #[test]
    fn applies_runtime_title_received_before_session_registration() {
        let mut registry = SessionRegistry::default();
        registry.set_runtime_title(
            &SessionId("s1".to_string()),
            "Investigate startup crash".to_string(),
        );

        let summary = registry
            .insert(NativeAiSession::from_prepare_input(prepare_input("s1", "w1")).unwrap())
            .unwrap();

        assert_eq!(summary.title, "Investigate startup crash");
        assert_eq!(
            registry
                .mark_status(&SessionId("s1".to_string()), NativeAiSessionStatus::Idle)
                .unwrap()
                .title,
            "Investigate startup crash"
        );
    }
}
