use std::path::PathBuf;

use comando_types::error::{NativeError, NativeErrorCode};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("The database path is empty.")]
    EmptyDatabasePath,

    #[error("Native storage database does not exist.")]
    DatabaseNotFound(PathBuf),

    #[error("The native storage schema is missing required table: {0}")]
    MissingRequiredTable(&'static str),

    #[error("The native storage schema is missing required column {column} on table {table}.")]
    MissingRequiredColumn {
        table: &'static str,
        column: &'static str,
    },

    #[error("The native storage schema version is not supported: {0}")]
    UnsupportedSchemaVersion(String),

    #[error("The durable workspace input is invalid: {0}")]
    InvalidWorkspaceInput(String),

    #[error("The durable workspace was not found: {0}")]
    WorkspaceNotFound(String),

    #[error("The durable workspace already exists: {0}")]
    WorkspaceAlreadyExists(String),

    #[error("The workspace reassociation target was not found: {0}")]
    WorkspaceReassociationTargetNotFound(String),

    #[error("The workspace deletion operation was not found: {0}")]
    WorkspaceDeletionNotFound(String),

    #[error("The workspace deletion transition is invalid: {from} -> {to}.")]
    InvalidWorkspaceDeletionTransition { from: String, to: String },

    #[error("The immutable workspace backup checksum does not match: {0}")]
    WorkspaceBackupChecksumMismatch(PathBuf),

    #[error(
        "The {entity} revision changed (expected {expected_revision}, actual {actual_revision})."
    )]
    RevisionConflict {
        entity: &'static str,
        expected_revision: u64,
        actual_revision: u64,
    },

    #[error("The native schema migration was interrupted at {0}.")]
    MigrationInterrupted(&'static str),

    #[error("Could not open native storage.")]
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
            Self::EmptyDatabasePath | Self::InvalidWorkspaceInput(_) => {
                NativeErrorCode::InvalidArgs
            }
            Self::DatabaseNotFound(_)
            | Self::WorkspaceNotFound(_)
            | Self::WorkspaceReassociationTargetNotFound(_)
            | Self::WorkspaceDeletionNotFound(_) => NativeErrorCode::NotFound,
            Self::WorkspaceAlreadyExists(_)
            | Self::InvalidWorkspaceDeletionTransition { .. }
            | Self::RevisionConflict { .. } => NativeErrorCode::Conflict,
            Self::MissingRequiredTable(_)
            | Self::MissingRequiredColumn { .. }
            | Self::UnsupportedSchemaVersion(_) => NativeErrorCode::UnsupportedSchemaVersion,
            Self::MigrationInterrupted(_)
            | Self::WorkspaceBackupChecksumMismatch(_)
            | Self::OpenStorage { .. }
            | Self::Sqlite(_)
            | Self::Io(_) => NativeErrorCode::InternalError,
        }
    }

    pub fn to_native_error(&self) -> NativeError {
        let mut error = NativeError::new(self.native_code(), self.to_string());
        match self {
            Self::DatabaseNotFound(path)
            | Self::WorkspaceBackupChecksumMismatch(path)
            | Self::OpenStorage { path, .. } => {
                error = error.with_details(json!({
                    "databasePath": crate::redaction::redact_path(path),
                }));
            }
            Self::RevisionConflict {
                entity,
                expected_revision,
                actual_revision,
            } => {
                error = error.with_details(json!({
                    "entity": entity,
                    "expectedRevision": expected_revision,
                    "actualRevision": actual_revision,
                }));
            }
            _ => {}
        }
        error
    }
}
