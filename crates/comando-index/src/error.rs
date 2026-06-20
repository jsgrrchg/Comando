use comando_types::error::{NativeError, NativeErrorCode};
use thiserror::Error;

pub type IndexResult<T> = Result<T, IndexError>;

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("Project index scope was not found.")]
    ScopeNotFound,
    #[error("Project index is not ready.")]
    IndexNotReady,
    #[error("Operation was cancelled.")]
    Cancelled,
    #[error("Native content search is disabled.")]
    ContentSearchDisabled,
    #[error("Project index exceeded configured limits.")]
    LimitExceeded,
    #[error("Filesystem error while indexing project: {0}")]
    Io(#[from] std::io::Error),
    #[error("Filesystem policy error while indexing project: {0}")]
    Fs(#[from] comando_fs::FsError),
    #[error("{0}")]
    Internal(String),
}

impl IndexError {
    pub fn to_native_error(&self) -> NativeError {
        match self {
            Self::ScopeNotFound => NativeError::new(
                NativeErrorCode::NotFound,
                "Native project index scope was not found.",
            ),
            Self::IndexNotReady => NativeError::new(
                NativeErrorCode::BackendNotReady,
                "Native project index is not ready yet.",
            )
            .retryable(true),
            Self::Cancelled => NativeError::new(
                NativeErrorCode::OperationCancelled,
                "Native search operation was cancelled.",
            ),
            Self::ContentSearchDisabled => NativeError::new(
                NativeErrorCode::NotSupported,
                "Native content search is not supported by this rollout.",
            ),
            Self::LimitExceeded => NativeError::new(
                NativeErrorCode::TooLarge,
                "Native project index exceeded configured limits.",
            )
            .retryable(true),
            Self::Io(_) | Self::Fs(_) => NativeError::new(
                NativeErrorCode::InternalError,
                "Native project index failed while reading the project tree.",
            )
            .retryable(true),
            Self::Internal(message) => NativeError::new(NativeErrorCode::InternalError, message),
        }
    }
}
