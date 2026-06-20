use std::path::PathBuf;

use comando_types::error::{NativeError, NativeErrorCode};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("The database path is empty.")]
    EmptyDatabasePath,

    #[error("The native storage schema is missing required table: {0}")]
    MissingRequiredTable(&'static str),

    #[error("The native storage schema is missing required column {column} on table {table}.")]
    MissingRequiredColumn {
        table: &'static str,
        column: &'static str,
    },

    #[error("The native storage schema version is not supported: {0}")]
    UnsupportedSchemaVersion(String),

    #[error("Could not open native storage at {path}: {source}")]
    OpenStorage {
        path: PathBuf,
        #[source]
        source: rusqlite::Error,
    },

    #[error("SQLite storage error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

impl PersistenceError {
    pub fn native_code(&self) -> NativeErrorCode {
        match self {
            Self::EmptyDatabasePath => NativeErrorCode::InvalidArgs,
            Self::MissingRequiredTable(_)
            | Self::MissingRequiredColumn { .. }
            | Self::UnsupportedSchemaVersion(_) => NativeErrorCode::UnsupportedSchemaVersion,
            Self::OpenStorage { .. } | Self::Sqlite(_) | Self::Io(_) => {
                NativeErrorCode::InternalError
            }
        }
    }

    pub fn to_native_error(&self) -> NativeError {
        let mut error = NativeError::new(self.native_code(), self.to_string());
        if let Self::OpenStorage { path, .. } = self {
            error = error.with_details(json!({
                "databasePath": crate::redaction::redact_path(path),
            }));
        }
        error
    }
}
