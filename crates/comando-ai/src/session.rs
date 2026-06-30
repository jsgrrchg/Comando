use std::collections::HashMap;

use comando_types::ai::{
    NativeAiPrepareSessionInput, NativeAiSessionStatus, NativeAiSessionSummary,
};
use comando_types::ids::{RuntimeId, RuntimeSessionId, SessionId};

use crate::acp::AcpSessionController;
use crate::error::{AiError, AiResult};
use crate::events::now_iso8601;
use crate::scope::SessionScope;

const DEFAULT_CHAT_TITLE_RUNTIMES: &[&str] =
    &["Claude", "Grok", "Codex", "Kilo", "OpenCode", "Agent"];
const CHAT_TITLE_STORED_MAX_CHARS: usize = 100;
const MAX_TITLE_WORDS: usize = 12;
const PILL_OPEN: &str = "\u{200B}\u{00AB}";
const PILL_CLOSE: &str = "\u{00BB}\u{200B}";

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
    pub active_message_id: Option<String>,
    pub prompt_in_flight: bool,
}

impl ManagedAiSession {
    pub fn new(session: NativeAiSession) -> Self {
        Self {
            session,
            acp_controller: None,
            active_message_id: None,
            prompt_in_flight: false,
        }
    }

    pub fn with_acp_controller(
        session: NativeAiSession,
        acp_controller: AcpSessionController,
    ) -> Self {
        Self {
            session,
            acp_controller: Some(acp_controller),
            active_message_id: None,
            prompt_in_flight: false,
        }
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

pub(crate) fn resolve_session_title_on_prompt(
    current_title: &str,
    fallback_title: &str,
    display_content: &str,
    has_prior_user_message: bool,
) -> String {
    if !current_title.trim().is_empty() && !is_default_chat_title(current_title) {
        return current_title.to_string();
    }
    if !has_prior_user_message {
        let inferred = infer_chat_title_from_prompt(display_content);
        if !inferred.is_empty() {
            return inferred;
        }
    }
    if fallback_title.trim().is_empty() {
        current_title.to_string()
    } else {
        fallback_title.to_string()
    }
}

fn is_default_chat_title(title: &str) -> bool {
    let trimmed = title.trim();
    let Some((runtime, number)) = trimmed.rsplit_once(' ') else {
        return false;
    };
    DEFAULT_CHAT_TITLE_RUNTIMES.contains(&runtime)
        && !number.is_empty()
        && number.chars().all(|character| character.is_ascii_digit())
}

fn infer_chat_title_from_prompt(serialized_content: &str) -> String {
    if serialized_content.trim().is_empty() {
        return String::new();
    }

    let cleaned = serialized_content
        .replace(PILL_OPEN, "")
        .replace(PILL_CLOSE, "")
        .replace('\u{1F4CE}', "");
    let words = cleaned
        .split_whitespace()
        .filter_map(clean_title_token)
        .filter(|token| !token.is_empty())
        .take(MAX_TITLE_WORDS)
        .collect::<Vec<_>>();

    truncate_chat_title(&words.join(" "), CHAT_TITLE_STORED_MAX_CHARS)
}

fn clean_title_token(token: &str) -> Option<String> {
    if token == "@fetch" || token == "/plan" {
        return None;
    }
    let Some(mention) = token.strip_prefix('@') else {
        return Some(token.to_string());
    };
    if mention.contains('@') {
        return Some(token.to_string());
    }
    Some(
        mention
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(mention)
            .to_string(),
    )
}

fn truncate_chat_title(title: &str, max_chars: usize) -> String {
    let trimmed = title.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let budget = max_chars.saturating_sub(1).max(1);
    let mut head = trimmed.chars().take(budget).collect::<String>();
    if let Some(index) = head.rfind(' ')
        && index > budget * 3 / 5
    {
        head.truncate(index);
        return format!("{}\u{2026}", head.trim_end());
    }
    format!("{head}\u{2026}")
}

#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions: HashMap<String, ManagedAiSession>,
}

impl SessionRegistry {
    pub fn insert(&mut self, session: NativeAiSession) -> AiResult<NativeAiSessionSummary> {
        let session_id = session.session_id.0.clone();
        if self.sessions.contains_key(&session_id) {
            return Err(AiError::SessionOwnerMismatch {
                session_id,
                owner: "native".to_string(),
                expected: "new".to_string(),
            });
        }

        let summary = session.summary();
        self.sessions
            .insert(summary.session_id.0.clone(), ManagedAiSession::new(session));
        Ok(summary)
    }

    pub fn insert_with_acp_controller(
        &mut self,
        session: NativeAiSession,
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
    fn resolves_title_from_first_prompt_for_default_title() {
        assert_eq!(
            resolve_session_title_on_prompt(
                "Codex 3",
                "Codex 3",
                "Revisa el bug de login en \u{200B}\u{00AB}@auth/session.ts\u{00BB}\u{200B}",
                false,
            ),
            "Revisa el bug de login en session.ts"
        );
    }

    #[test]
    fn preserves_custom_title_on_prompt() {
        assert_eq!(
            resolve_session_title_on_prompt(
                "Manual review title",
                "Codex 3",
                "Should not replace this",
                false,
            ),
            "Manual review title"
        );
    }

    #[test]
    fn keeps_default_title_after_first_user_message() {
        assert_eq!(
            resolve_session_title_on_prompt("Codex 3", "Codex 3", "Second prompt", true),
            "Codex 3"
        );
    }

    #[test]
    fn cleans_noisy_prompt_tokens_for_title_inference() {
        assert_eq!(
            resolve_session_title_on_prompt(
                "OpenCode 1",
                "OpenCode 1",
                "\u{200B}\u{00AB}@fetch\u{00BB}\u{200B} Analiza el repo \u{200B}\u{00AB}/plan\u{00BB}\u{200B} \u{1F4CE}screenshot.png",
                false,
            ),
            "Analiza el repo screenshot.png"
        );
    }
}
