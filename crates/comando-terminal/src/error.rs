use std::io;

use comando_types::error::{NativeError, NativeErrorCode};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("Terminal session was not found.")]
    NotFound,
    #[error("Terminal session belongs to another window.")]
    ForeignWindow,
    #[error("Terminal working directory does not exist.")]
    CwdNotFound,
    #[error("Terminal working directory is not a directory.")]
    CwdNotDirectory,
    #[error("Terminal working directory is not accessible: {0}")]
    CwdIo(#[source] io::Error),
    #[error("Terminal PTY is not available.")]
    PtyUnavailable,
    #[error("Failed to create terminal PTY: {0}")]
    OpenPty(String),
    #[error("Failed to start terminal process: {0}")]
    Spawn(String),
    #[error("Failed to open terminal writer: {0}")]
    Writer(String),
    #[error("Failed to open terminal reader: {0}")]
    Reader(String),
    #[error("Failed to write to terminal session: {0}")]
    Write(String),
    #[error("Failed to resize terminal PTY: {0}")]
    Resize(String),
    #[error("Internal terminal state error: {0}")]
    State(String),
}

impl TerminalError {
    pub fn terminal_code(&self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::ForeignWindow => "foreign_window",
            Self::CwdNotFound => "cwd_not_found",
            Self::CwdNotDirectory => "cwd_not_directory",
            Self::CwdIo(_) => "cwd_io",
            Self::PtyUnavailable => "pty_unavailable",
            Self::OpenPty(_) => "open_pty",
            Self::Spawn(_) => "spawn",
            Self::Writer(_) => "writer",
            Self::Reader(_) => "reader",
            Self::Write(_) => "write",
            Self::Resize(_) => "resize",
            Self::State(_) => "state",
        }
    }

    pub fn to_native_error(&self) -> NativeError {
        let code = match self {
            Self::NotFound => NativeErrorCode::NotFound,
            Self::ForeignWindow => NativeErrorCode::PermissionDenied,
            Self::CwdNotFound | Self::CwdNotDirectory => NativeErrorCode::InvalidArgs,
            Self::CwdIo(_)
            | Self::PtyUnavailable
            | Self::OpenPty(_)
            | Self::Spawn(_)
            | Self::Writer(_)
            | Self::Reader(_)
            | Self::Write(_)
            | Self::Resize(_)
            | Self::State(_) => NativeErrorCode::InternalError,
        };

        NativeError::new(code, self.to_string()).with_details(json!({
            "terminalCode": self.terminal_code(),
        }))
    }
}
