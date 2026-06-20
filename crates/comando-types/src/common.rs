use serde::{Deserialize, Serialize};

use crate::ids::OperationId;

pub type NativeProtocolVersion = u32;
pub type NativeCommandName = String;
pub type NativeEventName = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeDomain {
    Backend,
    Persistence,
    Projects,
    Fs,
    Index,
    Search,
    Git,
    Terminal,
    Settings,
    Secret,
    Ai,
    Review,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeOperationStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeCancellationToken {
    pub operation_id: OperationId,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct NativePageCursor(pub String);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativePage<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<NativePageCursor>,
    pub total_count: Option<u64>,
}
