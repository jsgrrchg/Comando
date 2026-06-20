pub mod ai;
pub mod capabilities;
pub mod commands;
pub mod common;
pub mod error;
pub mod events;
pub mod fs;
pub mod git;
pub mod ids;
pub mod index;
pub mod persistence;
pub mod projects;
pub mod protocol;
pub mod review;
pub mod settings;
pub mod terminal;
pub mod workspace;

pub use capabilities::{
    BACKEND_NAME, MINIMUM_BACKEND_PROTOCOL_VERSION, MINIMUM_CLIENT_PROTOCOL_VERSION,
    PROTOCOL_VERSION,
};
pub use error::{NativeError, NativeErrorCode};
pub use ids::{
    FilePath, MessageId, OperationId, ProjectId, RelativePath, RepositoryId, RequestId, RuntimeId,
    RuntimeSessionId, SessionId, TerminalSessionId, ToolCallId, WindowId, WorkspaceId, WorktreeId,
};
pub use protocol::{
    JsonlWriter, NativeEventMeta, NativeRequestMeta, NativeResponseMeta, NativeRpcEvent,
    NativeRpcOutput, NativeRpcRequest, NativeRpcResponse, RequestParseError, error_response, event,
    parse_request_line, parse_request_value, response_ok,
};
