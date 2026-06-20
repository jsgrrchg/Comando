use std::path::PathBuf;

use comando_types::error::{NativeError, NativeErrorCode};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProjectRegistryError {
    #[error("No project paths were provided.")]
    EmptyProjectPaths,

    #[error("Choose an existing folder for this project.")]
    DirectoryNotFound(PathBuf),

    #[error("The project path could not be resolved.")]
    ResolvePath {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("SQLite project registry error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("I/O project registry error: {0}")]
    Io(#[from] std::io::Error),
}

impl ProjectRegistryError {
    pub fn native_code(&self) -> NativeErrorCode {
        match self {
            Self::EmptyProjectPaths | Self::DirectoryNotFound(_) | Self::ResolvePath { .. } => {
                NativeErrorCode::InvalidArgs
            }
            Self::Sqlite(_) | Self::Io(_) => NativeErrorCode::InternalError,
        }
    }

    pub fn to_native_error(&self) -> NativeError {
        let mut error = NativeError::new(self.native_code(), self.to_string());
        match self {
            Self::DirectoryNotFound(path) => {
                error = error.with_details(json!({
                    "path": comando_persistence::redaction::redact_path(path),
                }));
            }
            Self::ResolvePath { path, .. } => {
                error = error.with_details(json!({
                    "path": comando_persistence::redaction::redact_path(path),
                }));
            }
            _ => {}
        }
        error
    }
}
