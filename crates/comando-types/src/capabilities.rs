use serde::{Deserialize, Serialize};

use crate::commands::{BACKEND_COMMANDS, all_commands};
use crate::common::NativeProtocolVersion;
use crate::events::{BACKEND_EVENTS, all_events};
use crate::protocol::NativeRequestMeta;

pub const BACKEND_NAME: &str = "comando-native-backend";
pub const PROTOCOL_VERSION: NativeProtocolVersion = 1;
pub const MINIMUM_CLIENT_PROTOCOL_VERSION: NativeProtocolVersion = 1;
pub const MINIMUM_BACKEND_PROTOCOL_VERSION: NativeProtocolVersion = 1;
pub const RUST_VERSION: &str = "1.96";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeCapabilitySet {
    pub domains: Vec<String>,
    pub commands: Vec<String>,
    pub events: Vec<String>,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendHandshakeInput {
    pub client_name: String,
    pub client_version: String,
    pub protocol_version: NativeProtocolVersion,
    pub supported_protocol_versions: Vec<NativeProtocolVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendHandshakeOutput {
    pub backend_name: String,
    pub backend_version: String,
    pub protocol_version: NativeProtocolVersion,
    pub minimum_client_protocol_version: NativeProtocolVersion,
    pub capabilities: NativeCapabilitySet,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackendCapabilitiesOutput {
    pub backend_name: String,
    pub backend_version: String,
    pub rust_version: String,
    pub protocol_version: NativeProtocolVersion,
    pub minimum_client_protocol_version: NativeProtocolVersion,
    pub minimum_backend_protocol_version: NativeProtocolVersion,
    pub capabilities: NativeCapabilitySet,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProtocolCompatibility {
    pub protocol_version: NativeProtocolVersion,
    pub minimum_client_protocol_version: NativeProtocolVersion,
    pub minimum_backend_protocol_version: NativeProtocolVersion,
    pub supported_protocol_versions: Vec<NativeProtocolVersion>,
}

pub fn backend_capabilities() -> NativeCapabilitySet {
    NativeCapabilitySet {
        domains: vec![
            "backend".to_string(),
            "persistence".to_string(),
            "projects".to_string(),
            "project-tree".to_string(),
            "fs".to_string(),
            "index".to_string(),
            "search".to_string(),
            "git".to_string(),
            "terminal".to_string(),
            "settings".to_string(),
            "secret".to_string(),
            "ai".to_string(),
            "review".to_string(),
            "workspace".to_string(),
        ],
        commands: all_commands().into_iter().map(str::to_string).collect(),
        events: all_events().into_iter().map(str::to_string).collect(),
        features: vec![
            "bootstrap".to_string(),
            "versioned-protocol".to_string(),
            "json-fixtures".to_string(),
            "native-persistence".to_string(),
            "native-project-registry".to_string(),
            "native-fs".to_string(),
            "native-watchers".to_string(),
        ],
    }
}

pub fn bootstrap_capabilities() -> NativeCapabilitySet {
    NativeCapabilitySet {
        domains: vec!["backend".to_string()],
        commands: BACKEND_COMMANDS
            .iter()
            .map(|command| command.to_string())
            .collect(),
        events: BACKEND_EVENTS
            .iter()
            .map(|event| event.to_string())
            .collect(),
        features: vec!["bootstrap".to_string(), "versioned-protocol".to_string()],
    }
}

pub fn default_request_meta() -> NativeRequestMeta {
    NativeRequestMeta::default()
}

pub fn negotiate_protocol_version(
    client_protocol_version: NativeProtocolVersion,
    client_supported_protocol_versions: &[NativeProtocolVersion],
) -> Option<NativeProtocolVersion> {
    if client_protocol_version < MINIMUM_CLIENT_PROTOCOL_VERSION {
        return None;
    }

    if PROTOCOL_VERSION < MINIMUM_BACKEND_PROTOCOL_VERSION {
        return None;
    }

    client_supported_protocol_versions
        .contains(&PROTOCOL_VERSION)
        .then_some(PROTOCOL_VERSION)
}

pub fn is_protocol_supported(
    client_protocol_version: NativeProtocolVersion,
    client_supported_protocol_versions: &[NativeProtocolVersion],
) -> bool {
    negotiate_protocol_version(client_protocol_version, client_supported_protocol_versions)
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_protocol_v1_when_client_supports_it() {
        assert_eq!(negotiate_protocol_version(1, &[1]), Some(1));
    }

    #[test]
    fn rejects_clients_without_a_common_protocol() {
        assert_eq!(negotiate_protocol_version(99, &[99]), None);
    }

    #[test]
    fn rejects_clients_below_backend_minimum() {
        assert_eq!(negotiate_protocol_version(0, &[0, 1]), None);
    }
}
