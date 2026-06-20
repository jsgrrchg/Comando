use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeErrorCode {
    InvalidJson,
    InvalidRequest,
    UnknownCommand,
    InvalidArgs,
    UnsupportedProtocolVersion,
    BackendNotReady,
    OperationCancelled,
    OperationTimeout,
    PermissionDenied,
    NotFound,
    Conflict,
    TooLarge,
    BinaryFile,
    ExternalChange,
    InternalError,
}

impl NativeErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::InvalidRequest => "invalid_request",
            Self::UnknownCommand => "unknown_command",
            Self::InvalidArgs => "invalid_args",
            Self::UnsupportedProtocolVersion => "unsupported_protocol_version",
            Self::BackendNotReady => "backend_not_ready",
            Self::OperationCancelled => "operation_cancelled",
            Self::OperationTimeout => "operation_timeout",
            Self::PermissionDenied => "permission_denied",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::TooLarge => "too_large",
            Self::BinaryFile => "binary_file",
            Self::ExternalChange => "external_change",
            Self::InternalError => "internal_error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    pub code: NativeErrorCode,
    pub message: String,
    pub details: Option<Value>,
    pub retryable: bool,
}

impl NativeError {
    pub fn new(code: NativeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
            retryable: false,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}
