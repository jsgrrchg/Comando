use std::collections::HashMap;

use comando_types::ai::{
    NativeAiRuntimeCapabilities, NativeAiRuntimeDescriptor, NativeAiRuntimeStatus,
    NativeAiRuntimeSupportState,
};
use comando_types::ids::RuntimeId;

use crate::error::{AiError, AiResult};

const NO_ARGS: &[&str] = &[];
const ACP_ARG: &[&str] = &["acp"];
const GROK_ARGS: &[&str] = &["--no-auto-update", "agent", "stdio"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpProtocolFlavor {
    Current14,
    Legacy12,
}

#[derive(Debug, Clone, Copy)]
pub struct RuntimeDefinition {
    pub id: &'static str,
    pub display_name: &'static str,
    pub default_executable: &'static str,
    pub acp_args: &'static [&'static str],
    pub protocol_flavor: AcpProtocolFlavor,
    pub support_state: NativeAiRuntimeSupportState,
    pub capabilities: NativeAiRuntimeCapabilities,
    pub message: Option<&'static str>,
}

impl RuntimeDefinition {
    pub fn descriptor(self) -> NativeAiRuntimeDescriptor {
        NativeAiRuntimeDescriptor {
            runtime_id: RuntimeId(self.id.to_string()),
            display_name: self.display_name.to_string(),
            default_executable: self.default_executable.to_string(),
            acp_args: self.acp_args.iter().map(|arg| (*arg).to_string()).collect(),
            native_ready: self.support_state == NativeAiRuntimeSupportState::NativeReady,
            legacy_ready: true,
            support_state: self.support_state,
            message: self.message.map(ToString::to_string),
            capabilities: self.capabilities,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeRegistry {
    definitions: HashMap<&'static str, RuntimeDefinition>,
}

impl Default for RuntimeRegistry {
    fn default() -> Self {
        Self::new(default_runtime_definitions())
    }
}

impl RuntimeRegistry {
    pub fn new(definitions: impl IntoIterator<Item = RuntimeDefinition>) -> Self {
        Self {
            definitions: definitions
                .into_iter()
                .map(|definition| (definition.id, definition))
                .collect(),
        }
    }

    pub fn get(&self, runtime_id: &str) -> AiResult<RuntimeDefinition> {
        self.definitions
            .get(runtime_id)
            .copied()
            .ok_or_else(|| AiError::RuntimeMissing {
                runtime_id: runtime_id.to_string(),
            })
    }

    pub fn require_native(&self, runtime_id: &str) -> AiResult<RuntimeDefinition> {
        let definition = self.get(runtime_id)?;
        if definition.support_state != NativeAiRuntimeSupportState::NativeReady {
            return Err(AiError::RuntimeNotNative {
                runtime_id: runtime_id.to_string(),
            });
        }
        Ok(definition)
    }

    pub fn list(&self) -> Vec<NativeAiRuntimeDescriptor> {
        let mut descriptors = self
            .definitions
            .values()
            .copied()
            .map(RuntimeDefinition::descriptor)
            .collect::<Vec<_>>();
        descriptors.sort_by(|left, right| left.runtime_id.0.cmp(&right.runtime_id.0));
        descriptors
    }

    pub fn status_from_launch(
        &self,
        runtime_id: &str,
        launch_status: Option<NativeAiRuntimeStatus>,
    ) -> AiResult<NativeAiRuntimeStatus> {
        let definition = self.get(runtime_id)?;
        if definition.support_state != NativeAiRuntimeSupportState::NativeReady {
            return Ok(native_unavailable_status(definition));
        }
        launch_status.ok_or_else(|| AiError::RuntimeNotReady {
            runtime_id: runtime_id.to_string(),
            message: "Native runtime launch details are missing.".to_string(),
        })
    }
}

fn default_runtime_definitions() -> [RuntimeDefinition; 5] {
    [
        RuntimeDefinition {
            id: "codex",
            display_name: "Codex",
            default_executable: "codex-acp",
            acp_args: NO_ARGS,
            protocol_flavor: AcpProtocolFlavor::Current14,
            support_state: NativeAiRuntimeSupportState::NativeReady,
            capabilities: RuntimeCapabilitiesPreset::codex().into(),
            message: None,
        },
        RuntimeDefinition {
            id: "claude",
            display_name: "Claude",
            default_executable: "claude-agent-acp",
            acp_args: NO_ARGS,
            protocol_flavor: AcpProtocolFlavor::Current14,
            support_state: NativeAiRuntimeSupportState::NativeReady,
            capabilities: RuntimeCapabilitiesPreset::claude().into(),
            message: None,
        },
        RuntimeDefinition {
            id: "grok",
            display_name: "Grok",
            default_executable: "grok",
            acp_args: GROK_ARGS,
            protocol_flavor: AcpProtocolFlavor::Current14,
            support_state: NativeAiRuntimeSupportState::NativeReady,
            capabilities: RuntimeCapabilitiesPreset::grok().into(),
            message: None,
        },
        RuntimeDefinition {
            id: "kilo",
            display_name: "Kilo",
            default_executable: "kilo",
            acp_args: ACP_ARG,
            protocol_flavor: AcpProtocolFlavor::Current14,
            support_state: NativeAiRuntimeSupportState::NativeReady,
            capabilities: RuntimeCapabilitiesPreset::kilo().into(),
            message: None,
        },
        RuntimeDefinition {
            id: "opencode",
            display_name: "OpenCode",
            default_executable: "opencode",
            acp_args: ACP_ARG,
            protocol_flavor: AcpProtocolFlavor::Current14,
            support_state: NativeAiRuntimeSupportState::NativeReady,
            capabilities: RuntimeCapabilitiesPreset::opencode().into(),
            message: None,
        },
    ]
}

#[derive(Debug, Clone, Copy)]
struct RuntimeCapabilitiesPreset {
    thinking: bool,
    tools: bool,
    plan_updates: bool,
    permissions: bool,
    user_input: bool,
    subagents: bool,
    resume_session: bool,
    load_session: bool,
    auth_terminal: bool,
    image_input: bool,
    embedded_context: bool,
}

impl RuntimeCapabilitiesPreset {
    const fn codex() -> Self {
        Self {
            thinking: true,
            tools: true,
            plan_updates: true,
            permissions: true,
            user_input: true,
            subagents: true,
            resume_session: false,
            load_session: true,
            auth_terminal: false,
            image_input: true,
            embedded_context: true,
        }
    }

    const fn claude() -> Self {
        Self {
            thinking: true,
            tools: true,
            plan_updates: true,
            permissions: true,
            user_input: true,
            subagents: false,
            resume_session: false,
            load_session: true,
            auth_terminal: true,
            image_input: true,
            embedded_context: true,
        }
    }

    const fn grok() -> Self {
        Self {
            thinking: true,
            tools: true,
            plan_updates: false,
            permissions: true,
            user_input: true,
            subagents: false,
            resume_session: false,
            load_session: true,
            auth_terminal: true,
            image_input: true,
            embedded_context: false,
        }
    }

    const fn kilo() -> Self {
        Self {
            thinking: true,
            tools: true,
            plan_updates: true,
            permissions: true,
            user_input: true,
            subagents: false,
            resume_session: false,
            load_session: true,
            auth_terminal: true,
            image_input: true,
            embedded_context: true,
        }
    }

    const fn opencode() -> Self {
        Self {
            thinking: true,
            tools: true,
            plan_updates: true,
            permissions: true,
            user_input: true,
            subagents: false,
            resume_session: false,
            load_session: true,
            auth_terminal: true,
            image_input: false,
            embedded_context: true,
        }
    }
}

impl From<RuntimeCapabilitiesPreset> for NativeAiRuntimeCapabilities {
    fn from(value: RuntimeCapabilitiesPreset) -> Self {
        Self {
            streaming: true,
            thinking: value.thinking,
            tools: value.tools,
            plan_updates: value.plan_updates,
            permissions: value.permissions,
            user_input: value.user_input,
            subagents: value.subagents,
            resume_session: value.resume_session,
            load_session: value.load_session,
            auth_terminal: value.auth_terminal,
            image_input: value.image_input,
            embedded_context: value.embedded_context,
        }
    }
}

fn native_unavailable_status(definition: RuntimeDefinition) -> NativeAiRuntimeStatus {
    NativeAiRuntimeStatus {
        runtime_id: RuntimeId(definition.id.to_string()),
        state: "unavailable".to_string(),
        auth_method: None,
        auth_methods: Vec::new(),
        auth_ready: false,
        auth_credential_source: None,
        auth_credential_source_label: None,
        auth_session_message: None,
        auth_storage_message: None,
        can_disconnect_auth: false,
        can_logout_auth: false,
        checked_at: crate::events::now_iso8601(),
        command: Some(
            std::iter::once(definition.default_executable)
                .chain(definition.acp_args.iter().copied())
                .collect::<Vec<_>>()
                .join(" "),
        ),
        message: definition.message.map(ToString::to_string),
        onboarding_required: true,
        source: Some("native".to_string()),
        has_custom_binary_path: false,
        has_gateway_config: false,
        has_gateway_url: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_all_comando_runtimes() {
        let ids = RuntimeRegistry::default()
            .list()
            .into_iter()
            .map(|runtime| runtime.runtime_id.0)
            .collect::<Vec<_>>();

        assert_eq!(ids, ["claude", "codex", "grok", "kilo", "opencode"]);
    }

    #[test]
    fn all_pr9_matrix_runtimes_are_native_ready() {
        let registry = RuntimeRegistry::default();

        for runtime_id in ["claude", "codex", "grok", "kilo", "opencode"] {
            assert!(registry.require_native(runtime_id).is_ok());
        }
    }
}
