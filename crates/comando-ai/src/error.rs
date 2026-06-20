use comando_types::error::{NativeError, NativeErrorCode};
use serde_json::json;
use thiserror::Error;

pub type AiResult<T> = Result<T, AiError>;

#[derive(Debug, Error)]
pub enum AiError {
    #[error("AI runtime `{runtime_id}` is not installed or could not be resolved.")]
    RuntimeMissing { runtime_id: String },
    #[error("AI runtime `{runtime_id}` is not available in the native backend.")]
    RuntimeNotNative { runtime_id: String },
    #[error("AI runtime `{runtime_id}` is not ready: {message}")]
    RuntimeNotReady { runtime_id: String, message: String },
    #[error("AI session `{session_id}` was not found.")]
    SessionNotFound { session_id: String },
    #[error("AI session `{session_id}` is busy.")]
    SessionBusy { session_id: String },
    #[error("AI session `{session_id}` is owned by {owner}, not {expected}.")]
    SessionOwnerMismatch {
        session_id: String,
        owner: String,
        expected: String,
    },
    #[error("AI prompt was rejected for session `{session_id}`: {message}")]
    PromptRejected { session_id: String, message: String },
    #[error("AI cancel failed for session `{session_id}`: {message}")]
    CancelFailed { session_id: String, message: String },
    #[error("AI permission request `{request_id}` was not found.")]
    PermissionNotFound { request_id: String },
    #[error("AI user input request `{request_id}` was not found.")]
    UserInputNotFound { request_id: String },
    #[error("AI runtime process exited: {message}")]
    RuntimeExited { message: String },
    #[error("Invalid AI input: {0}")]
    InvalidInput(String),
    #[error("AI operation is not supported yet: {0}")]
    Unsupported(String),
    #[error("Internal AI error: {0}")]
    Internal(String),
}

impl AiError {
    pub fn to_native_error(&self) -> NativeError {
        let code = match self {
            Self::RuntimeMissing { .. } => NativeErrorCode::AiRuntimeMissing,
            Self::RuntimeNotNative { .. } => NativeErrorCode::AiRuntimeNotNative,
            Self::RuntimeNotReady { .. } => NativeErrorCode::AiRuntimeNotReady,
            Self::SessionNotFound { .. } => NativeErrorCode::AiSessionNotFound,
            Self::SessionBusy { .. } => NativeErrorCode::AiSessionBusy,
            Self::SessionOwnerMismatch { .. } => NativeErrorCode::AiSessionOwnerMismatch,
            Self::PromptRejected { .. } => NativeErrorCode::AiPromptRejected,
            Self::CancelFailed { .. } => NativeErrorCode::AiCancelFailed,
            Self::PermissionNotFound { .. } => NativeErrorCode::AiPermissionNotFound,
            Self::UserInputNotFound { .. } => NativeErrorCode::AiUserInputNotFound,
            Self::RuntimeExited { .. } => NativeErrorCode::AiRuntimeExited,
            Self::InvalidInput(_) => NativeErrorCode::InvalidArgs,
            Self::Unsupported(_) => NativeErrorCode::NotSupported,
            Self::Internal(_) => NativeErrorCode::InternalError,
        };

        let mut native = NativeError::new(code, self.to_string());
        match self {
            Self::RuntimeMissing { runtime_id }
            | Self::RuntimeNotNative { runtime_id }
            | Self::RuntimeNotReady { runtime_id, .. } => {
                native = native.with_details(json!({ "runtimeId": runtime_id }));
            }
            Self::SessionNotFound { session_id }
            | Self::SessionBusy { session_id }
            | Self::PromptRejected { session_id, .. }
            | Self::CancelFailed { session_id, .. } => {
                native = native.with_details(json!({ "sessionId": session_id }));
            }
            Self::SessionOwnerMismatch {
                session_id,
                owner,
                expected,
            } => {
                native = native.with_details(json!({
                    "expected": expected,
                    "owner": owner,
                    "sessionId": session_id
                }));
            }
            Self::PermissionNotFound { request_id } | Self::UserInputNotFound { request_id } => {
                native = native.with_details(json!({ "requestId": request_id }));
            }
            Self::RuntimeExited { .. }
            | Self::InvalidInput(_)
            | Self::Unsupported(_)
            | Self::Internal(_) => {}
        }

        native
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_ai_error_to_native_code() {
        let error = AiError::SessionBusy {
            session_id: "s1".to_string(),
        }
        .to_native_error();

        assert_eq!(error.code, NativeErrorCode::AiSessionBusy);
        assert!(!error.retryable);
    }
}
