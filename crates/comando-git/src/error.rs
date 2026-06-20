use comando_types::error::{NativeError, NativeErrorCode};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("Git executable was not found.")]
    GitNotFound,
    #[error("The selected path is not a ready git repository.")]
    NotRepository,
    #[error("Bare repositories do not support this operation.")]
    BareRepository,
    #[error("Git command failed with exit code {code:?}.")]
    CommandFailed { code: Option<i32>, stderr: String },
    #[error("Git command timed out.")]
    CommandTimedOut,
    #[error("Git output exceeded the configured limit.")]
    OutputTooLarge {
        stream: &'static str,
        limit_bytes: usize,
    },
    #[error("Git path must be repository-relative.")]
    InvalidPath,
    #[error("Git path escapes the repository root.")]
    PathEscape,
    #[error("Resolve git conflicts before continuing.")]
    Conflict,
    #[error("{0}")]
    InvalidOperation(String),
    #[error("Git operation is disabled by native Git guardrails.")]
    OperationDisabled,
    #[error("Git network operation is disabled by native Git guardrails.")]
    NetworkDisabled,
    #[error("Permission denied.")]
    PermissionDenied,
    #[error("Git IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub type GitResult<T> = Result<T, GitError>;

impl GitError {
    pub fn git_code(&self) -> &'static str {
        match self {
            Self::GitNotFound => "git_not_found",
            Self::NotRepository => "not_repository",
            Self::BareRepository => "bare_repository",
            Self::CommandFailed { .. } => "git_command_failed",
            Self::CommandTimedOut => "git_command_timed_out",
            Self::OutputTooLarge { .. } => "git_output_too_large",
            Self::InvalidPath => "invalid_path",
            Self::PathEscape => "path_escape",
            Self::Conflict => "conflict",
            Self::InvalidOperation(_) => "invalid_operation",
            Self::OperationDisabled => "operation_disabled",
            Self::NetworkDisabled => "network_disabled",
            Self::PermissionDenied => "permission_denied",
            Self::Io(_) => "io_error",
        }
    }

    pub fn to_native_error(&self) -> NativeError {
        let code = match self {
            Self::GitNotFound | Self::NotRepository => NativeErrorCode::NotFound,
            Self::BareRepository | Self::InvalidPath | Self::InvalidOperation(_) => {
                NativeErrorCode::InvalidArgs
            }
            Self::PathEscape
            | Self::Conflict
            | Self::OperationDisabled
            | Self::NetworkDisabled
            | Self::PermissionDenied => NativeErrorCode::PermissionDenied,
            Self::CommandFailed { .. } => NativeErrorCode::InternalError,
            Self::CommandTimedOut => NativeErrorCode::OperationTimeout,
            Self::OutputTooLarge { .. } => NativeErrorCode::TooLarge,
            Self::Io(_) => NativeErrorCode::InternalError,
        };

        let mut details = json!({
            "gitCode": self.git_code(),
        });

        if let Self::CommandFailed { code, stderr } = self {
            details["exitCode"] = json!(code);
            details["stderr"] = json!(stderr);
        }

        NativeError::new(code, self.to_string()).with_details(details)
    }
}
