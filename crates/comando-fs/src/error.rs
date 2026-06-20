use std::io;

use comando_types::error::{NativeError, NativeErrorCode};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FsError {
    #[error("Invalid project path.")]
    InvalidPath,
    #[error("Project path escapes the allowed root.")]
    PathEscape,
    #[error("Filesystem entry was not found.")]
    NotFound,
    #[error("Filesystem entry already exists.")]
    AlreadyExists,
    #[error("Expected a directory.")]
    NotDirectory,
    #[error("Expected a file.")]
    IsDirectory,
    #[error("A directory cannot be moved or copied inside itself.")]
    DirectoryIntoItself,
    #[error("The file changed on disk.")]
    Conflict {
        current_content_hash: Option<String>,
        external_mtime_ms: Option<u64>,
    },
    #[error("The file is too large for this operation.")]
    TooLarge,
    #[error("Binary file preview is not available.")]
    BinaryFile,
    #[error("Permission denied.")]
    PermissionDenied,
    #[error("The project is not registered in the native backend.")]
    ProjectNotFound,
    #[error("The worktree is not registered in the native backend.")]
    WorktreeNotFound,
    #[error("Filesystem watcher error: {0}")]
    Watcher(#[from] notify::Error),
    #[error("Filesystem IO error: {0}")]
    Io(#[from] io::Error),
}

impl FsError {
    pub fn fs_code(&self) -> &'static str {
        match self {
            Self::InvalidPath => "invalid_path",
            Self::PathEscape => "path_escape",
            Self::NotFound => "not_found",
            Self::AlreadyExists => "already_exists",
            Self::NotDirectory => "not_directory",
            Self::IsDirectory => "is_directory",
            Self::DirectoryIntoItself => "directory_into_itself",
            Self::Conflict { .. } => "conflict",
            Self::TooLarge => "too_large",
            Self::BinaryFile => "binary_file",
            Self::PermissionDenied => "permission_denied",
            Self::ProjectNotFound => "project_not_found",
            Self::WorktreeNotFound => "worktree_not_found",
            Self::Watcher(_) => "watcher_error",
            Self::Io(_) => "io_error",
        }
    }

    pub fn to_native_error(&self) -> NativeError {
        let code = match self {
            Self::InvalidPath
            | Self::NotDirectory
            | Self::IsDirectory
            | Self::DirectoryIntoItself => NativeErrorCode::InvalidArgs,
            Self::PathEscape | Self::PermissionDenied => NativeErrorCode::PermissionDenied,
            Self::NotFound | Self::ProjectNotFound | Self::WorktreeNotFound => {
                NativeErrorCode::NotFound
            }
            Self::AlreadyExists | Self::Conflict { .. } => NativeErrorCode::Conflict,
            Self::TooLarge => NativeErrorCode::TooLarge,
            Self::BinaryFile => NativeErrorCode::BinaryFile,
            Self::Watcher(_) | Self::Io(_) => NativeErrorCode::InternalError,
        };

        let mut error = NativeError::new(code, self.to_string()).with_details(json!({
            "fsCode": self.fs_code(),
        }));

        if matches!(self, Self::Watcher(_) | Self::Io(_)) {
            error = error.retryable(true);
        }

        error
    }

    pub fn conflict_payload(&self) -> Option<(&Option<String>, &Option<u64>)> {
        match self {
            Self::Conflict {
                current_content_hash,
                external_mtime_ms,
            } => Some((current_content_hash, external_mtime_ms)),
            _ => None,
        }
    }
}
