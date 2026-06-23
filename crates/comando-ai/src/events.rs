use comando_types::ai::{
    NativeAiEventBase, NativeAiMessageCompletedPayload, NativeAiMessageDeltaPayload,
    NativeAiMessageStartedPayload, NativeAiSessionClosedPayload, NativeAiSessionCreatedPayload,
    NativeAiSessionSummary, NativeAiSessionUpdatedPayload, NativeAiStatusEventPayload,
};
use comando_types::ids::{MessageId, RuntimeId, RuntimeSessionId, SessionId};
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub const AI_RUNTIME_STATUS_EVENT: &str = "ai://runtime-status";
pub const AI_RUNTIME_CONNECTION_EVENT: &str = "ai://runtime-connection";
pub const AI_SESSION_CREATED_EVENT: &str = "ai://session-created";
pub const AI_SESSION_UPDATED_EVENT: &str = "ai://session-updated";
pub const AI_SESSION_CLOSED_EVENT: &str = "ai://session-closed";
pub const AI_SESSION_CATALOG_UPDATED_EVENT: &str = "ai://session-catalog-updated";
pub const AI_SUBAGENT_CREATED_EVENT: &str = "ai://subagent-created";
pub const AI_SUBAGENT_BREADCRUMB_EVENT: &str = "ai://subagent-breadcrumb";
pub const AI_MESSAGE_STARTED_EVENT: &str = "ai://message-started";
pub const AI_MESSAGE_DELTA_EVENT: &str = "ai://message-delta";
pub const AI_MESSAGE_COMPLETED_EVENT: &str = "ai://message-completed";
pub const AI_THINKING_STARTED_EVENT: &str = "ai://thinking-started";
pub const AI_THINKING_DELTA_EVENT: &str = "ai://thinking-delta";
pub const AI_THINKING_COMPLETED_EVENT: &str = "ai://thinking-completed";
pub const AI_IMAGE_GENERATION_EVENT: &str = "ai://image-generation";
pub const AI_TOOL_ACTIVITY_EVENT: &str = "ai://tool-activity";
pub const AI_STATUS_EVENT: &str = "ai://status-event";
pub const AI_PLAN_UPDATED_EVENT: &str = "ai://plan-updated";
pub const AI_PERMISSION_REQUEST_EVENT: &str = "ai://permission-request";
pub const AI_USER_INPUT_REQUEST_EVENT: &str = "ai://user-input-request";
pub const AI_TOKEN_USAGE_EVENT: &str = "ai://token-usage";
pub const AI_ERROR_EVENT: &str = "ai://error";

#[derive(Debug, Clone, PartialEq)]
pub struct AiRuntimeEvent {
    pub event_name: String,
    pub payload: Value,
}

impl AiRuntimeEvent {
    pub fn new<T: Serialize>(event_name: impl Into<String>, payload: &T) -> Self {
        Self {
            event_name: event_name.into(),
            payload: serde_json::to_value(payload).expect("AI runtime event payload serializes"),
        }
    }
}

pub fn now_iso8601() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn event_base(
    session_id: &SessionId,
    runtime_id: &RuntimeId,
    runtime_session_id: Option<RuntimeSessionId>,
    updated_at: String,
) -> NativeAiEventBase {
    NativeAiEventBase {
        session_id: session_id.clone(),
        runtime_id: runtime_id.clone(),
        runtime_session_id,
        updated_at,
    }
}

pub fn session_created(summary: NativeAiSessionSummary) -> NativeAiSessionCreatedPayload {
    NativeAiSessionCreatedPayload { session: summary }
}

pub fn session_updated(session: &NativeAiSessionSummary) -> NativeAiSessionUpdatedPayload {
    NativeAiSessionUpdatedPayload {
        session_id: session.session_id.clone(),
        runtime_id: session.runtime_id.clone(),
        runtime_session_id: session.runtime_session_id.clone(),
        status: session.status.clone(),
        title: Some(session.title.clone()),
        updated_at: session.updated_at.clone(),
    }
}

pub fn session_closed(session: &NativeAiSessionSummary) -> NativeAiSessionClosedPayload {
    NativeAiSessionClosedPayload {
        session_id: session.session_id.clone(),
        runtime_id: session.runtime_id.clone(),
        runtime_session_id: session.runtime_session_id.clone(),
        updated_at: now_iso8601(),
    }
}

pub fn message_started(
    session: &NativeAiSessionSummary,
    message_id: MessageId,
    message_kind: impl Into<String>,
) -> NativeAiMessageStartedPayload {
    NativeAiMessageStartedPayload {
        base: event_base(
            &session.session_id,
            &session.runtime_id,
            session.runtime_session_id.clone(),
            now_iso8601(),
        ),
        message_id,
        message_kind: message_kind.into(),
        content: String::new(),
    }
}

pub fn message_delta(
    session: &NativeAiSessionSummary,
    message_id: MessageId,
    message_kind: impl Into<String>,
    delta: impl Into<String>,
    content: impl Into<String>,
) -> NativeAiMessageDeltaPayload {
    NativeAiMessageDeltaPayload {
        base: event_base(
            &session.session_id,
            &session.runtime_id,
            session.runtime_session_id.clone(),
            now_iso8601(),
        ),
        message_id,
        message_kind: message_kind.into(),
        delta: delta.into(),
        content: content.into(),
    }
}

pub fn message_completed(
    session: &NativeAiSessionSummary,
    message_id: MessageId,
    message_kind: impl Into<String>,
) -> NativeAiMessageCompletedPayload {
    NativeAiMessageCompletedPayload {
        base: event_base(
            &session.session_id,
            &session.runtime_id,
            session.runtime_session_id.clone(),
            now_iso8601(),
        ),
        message_id,
        message_kind: message_kind.into(),
    }
}

pub fn status_event(
    session: &NativeAiSessionSummary,
    event_id: impl Into<String>,
    status: impl Into<String>,
    title: impl Into<String>,
    detail: Option<String>,
) -> NativeAiStatusEventPayload {
    NativeAiStatusEventPayload {
        base: event_base(
            &session.session_id,
            &session.runtime_id,
            session.runtime_session_id.clone(),
            now_iso8601(),
        ),
        event_id: event_id.into(),
        status: status.into(),
        title: title.into(),
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_timestamp_as_rfc3339() {
        let value = now_iso8601();
        assert!(value.contains('T'));
        assert!(value.ends_with('Z'));
    }
}
