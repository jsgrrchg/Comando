use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, RuntimeId};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeSettings {
    pub runtime_id: RuntimeId,
    pub auth_method: Option<String>,
    pub binary_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSettingsSnapshot {
    pub runtimes: Vec<NativeRuntimeSettings>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectSettingsSnapshot {
    pub project_id: ProjectId,
    pub editor: serde_json::Value,
    pub appearance: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSecretRef {
    pub id: String,
    pub label: String,
    pub redacted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeSecretStatus {
    Missing,
    Present,
    Invalid,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSecretRedactionPolicy {
    pub field_paths: Vec<String>,
    pub replacement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeEnvResolution {
    pub runtime_id: RuntimeId,
    pub inherited_path: Option<String>,
    pub resolved_command: Option<String>,
    pub redactions: Vec<NativeSecretRedactionPolicy>,
}
