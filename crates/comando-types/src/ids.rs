use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    Number(i64),
}

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_string())
            }
        }
    };
}

string_id!(WindowId);
string_id!(WorkspaceId);
string_id!(ProjectId);
string_id!(WorktreeId);
string_id!(RuntimeId);
string_id!(SessionId);
string_id!(RuntimeSessionId);
string_id!(MessageId);
string_id!(ToolCallId);
string_id!(TerminalSessionId);
string_id!(RepositoryId);
string_id!(OperationId);
string_id!(FilePath);
string_id!(RelativePath);
string_id!(ReviewDeltaId);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ReviewRevision(pub u64);
