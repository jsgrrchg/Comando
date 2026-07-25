use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use comando_types::ai::{
    NativeAiRuntimeCapabilities, NativeAiRuntimeDescriptor, NativeAiRuntimeStatus,
    NativeAiRuntimeSupportState, NativeCustomAcpLaunchSpec,
};
use comando_types::ids::RuntimeId;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AiError, AiResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpProtocolFlavor {
    Current14,
    Legacy12,
}

#[derive(Debug, Clone)]
pub struct RuntimeDefinition {
    pub id: String,
    pub display_name: String,
    pub default_executable: String,
    pub acp_args: Vec<String>,
    pub protocol_flavor: AcpProtocolFlavor,
    pub support_state: NativeAiRuntimeSupportState,
    pub capabilities: NativeAiRuntimeCapabilities,
    pub message: Option<String>,
}

impl RuntimeDefinition {
    pub fn descriptor(&self) -> NativeAiRuntimeDescriptor {
        NativeAiRuntimeDescriptor {
            runtime_id: RuntimeId(self.id.clone()),
            display_name: self.display_name.clone(),
            default_executable: self.default_executable.clone(),
            acp_args: self.acp_args.clone(),
            native_ready: self.support_state == NativeAiRuntimeSupportState::NativeReady,
            legacy_ready: true,
            support_state: self.support_state,
            message: self.message.clone(),
            capabilities: self.capabilities,
        }
    }

    pub fn from_custom_launch(launch: &NativeCustomAcpLaunchSpec) -> AiResult<Self> {
        validate_custom_launch(launch)?;
        Ok(Self {
            id: launch.runtime_id.0.clone(),
            display_name: launch.display_name.clone(),
            default_executable: launch.executable.clone(),
            acp_args: launch.args.clone(),
            protocol_flavor: AcpProtocolFlavor::Current14,
            support_state: NativeAiRuntimeSupportState::NativeReady,
            capabilities: RuntimeCapabilitiesPreset::custom_acp().into(),
            message: None,
        })
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeRegistry {
    definitions: HashMap<String, RuntimeDefinition>,
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
                .map(|definition| (definition.id.clone(), definition))
                .collect(),
        }
    }

    pub fn get(&self, runtime_id: &str) -> AiResult<RuntimeDefinition> {
        self.definitions
            .get(runtime_id)
            .cloned()
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
            return Ok(native_unavailable_status(&definition));
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
            id: "codex".to_string(),
            display_name: "Codex".to_string(),
            default_executable: "codex-acp".to_string(),
            acp_args: Vec::new(),
            protocol_flavor: AcpProtocolFlavor::Current14,
            support_state: NativeAiRuntimeSupportState::NativeReady,
            capabilities: RuntimeCapabilitiesPreset::codex().into(),
            message: None,
        },
        RuntimeDefinition {
            id: "claude".to_string(),
            display_name: "Claude".to_string(),
            default_executable: "claude-agent-acp".to_string(),
            acp_args: Vec::new(),
            protocol_flavor: AcpProtocolFlavor::Current14,
            support_state: NativeAiRuntimeSupportState::NativeReady,
            capabilities: RuntimeCapabilitiesPreset::claude().into(),
            message: None,
        },
        RuntimeDefinition {
            id: "grok".to_string(),
            display_name: "Grok".to_string(),
            default_executable: "grok".to_string(),
            acp_args: vec![
                "--no-auto-update".to_string(),
                "agent".to_string(),
                "stdio".to_string(),
            ],
            protocol_flavor: AcpProtocolFlavor::Current14,
            support_state: NativeAiRuntimeSupportState::NativeReady,
            capabilities: RuntimeCapabilitiesPreset::grok().into(),
            message: None,
        },
        RuntimeDefinition {
            id: "kilo".to_string(),
            display_name: "Kilo".to_string(),
            default_executable: "kilo".to_string(),
            acp_args: vec!["acp".to_string()],
            protocol_flavor: AcpProtocolFlavor::Current14,
            support_state: NativeAiRuntimeSupportState::NativeReady,
            capabilities: RuntimeCapabilitiesPreset::kilo().into(),
            message: None,
        },
        RuntimeDefinition {
            id: "opencode".to_string(),
            display_name: "OpenCode".to_string(),
            default_executable: "opencode".to_string(),
            acp_args: vec!["acp".to_string()],
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
    const fn custom_acp() -> Self {
        Self {
            thinking: true,
            tools: true,
            plan_updates: true,
            permissions: true,
            user_input: true,
            subagents: false,
            resume_session: false,
            load_session: false,
            auth_terminal: false,
            image_input: true,
            embedded_context: true,
        }
    }

    const fn codex() -> Self {
        Self {
            thinking: true,
            tools: true,
            plan_updates: true,
            permissions: true,
            user_input: true,
            subagents: true,
            resume_session: true,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomLaunchFingerprintInput<'a> {
    args: &'a [String],
    auth_mode: &'a str,
    command: &'a str,
    env: &'a BTreeMap<String, String>,
    profile: &'static str,
}

fn validate_custom_launch(launch: &NativeCustomAcpLaunchSpec) -> AiResult<()> {
    const MAX_DISPLAY_NAME_LENGTH: usize = 80;
    const MAX_COMMAND_LENGTH: usize = 4_096;
    const MAX_ARG_COUNT: usize = 64;
    const MAX_ARG_LENGTH: usize = 4_096;
    const MAX_TOTAL_LAUNCH_TEXT_LENGTH: usize = 32_768;
    let runtime_id = launch.runtime_id.0.clone();
    validate_custom_runtime_id(&runtime_id)?;
    if launch.display_name.trim().is_empty()
        || launch.display_name.len() > MAX_DISPLAY_NAME_LENGTH
        || launch.command.trim().is_empty()
        || launch.command.len() > MAX_COMMAND_LENGTH
    {
        return invalid_custom_launch(&runtime_id, "Custom runtime name and command are required.");
    }
    if launch.auth_mode != "external"
        || launch.protocol_version != "acp-current14"
        || launch.product_profile != "conservative"
    {
        return invalid_custom_launch(
            &runtime_id,
            "Custom runtime launch profile is not supported.",
        );
    }
    if launch.revision == 0 || launch.state != "ready" {
        return invalid_custom_launch(
            &runtime_id,
            "Custom runtime launch is not in a ready revision.",
        );
    }
    if launch.executable.trim().is_empty()
        || launch.executable.contains('\0')
        || !Path::new(&launch.executable).is_absolute()
    {
        return invalid_custom_launch(
            &runtime_id,
            "Custom runtime executable must be an absolute path.",
        );
    }
    validate_resolved_executable(&runtime_id, &launch.executable)?;
    if launch.command.contains('\0')
        || launch.args.len() > MAX_ARG_COUNT
        || launch
            .args
            .iter()
            .any(|arg| arg.contains('\0') || arg.len() > MAX_ARG_LENGTH)
    {
        return invalid_custom_launch(
            &runtime_id,
            "Custom runtime arguments exceed the native launch limits.",
        );
    }
    validate_custom_environment(launch)?;
    let launch_text_length = launch.command.len()
        + launch.args.iter().map(String::len).sum::<usize>()
        + launch
            .configured_env
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>();
    if launch_text_length > MAX_TOTAL_LAUNCH_TEXT_LENGTH {
        return invalid_custom_launch(
            &runtime_id,
            "Custom runtime launch exceeds the native size limit.",
        );
    }

    let normalized = CustomLaunchFingerprintInput {
        args: &launch.args,
        auth_mode: &launch.auth_mode,
        command: &launch.command,
        env: &launch.configured_env,
        profile: "acp-current14-custom-v1",
    };
    let serialized = serde_json::to_vec(&normalized).map_err(|error| {
        AiError::Internal(format!(
            "Custom runtime launch fingerprint serialization failed: {error}"
        ))
    })?;
    let actual_fingerprint = format!("{:x}", Sha256::digest(serialized));
    if launch.launch_fingerprint != actual_fingerprint {
        return invalid_custom_launch(
            &runtime_id,
            "Custom runtime launch fingerprint does not match its definition.",
        );
    }
    Ok(())
}

fn validate_resolved_executable(runtime_id: &str, executable: &str) -> AiResult<()> {
    let metadata =
        std::fs::metadata(executable).map_err(|_| AiError::RuntimeLaunchContextInvalid {
            runtime_id: runtime_id.to_string(),
            message: "Custom runtime executable is no longer available.".to_string(),
        })?;
    if !metadata.is_file() {
        return invalid_custom_launch(
            runtime_id,
            "Custom runtime executable does not resolve to a file.",
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return invalid_custom_launch(
                runtime_id,
                "Custom runtime executable is not executable.",
            );
        }
    }
    Ok(())
}

fn validate_custom_runtime_id(runtime_id: &str) -> AiResult<()> {
    let Some(uuid_text) = runtime_id.strip_prefix("custom:") else {
        return invalid_custom_launch(
            runtime_id,
            "Custom runtime ID must use the reserved custom prefix.",
        );
    };
    let valid = Uuid::parse_str(uuid_text)
        .is_ok_and(|uuid| uuid.to_string() == uuid_text.to_ascii_lowercase());
    if !valid {
        return invalid_custom_launch(
            runtime_id,
            "Custom runtime ID must contain a canonical UUID.",
        );
    }
    Ok(())
}

fn validate_custom_environment(launch: &NativeCustomAcpLaunchSpec) -> AiResult<()> {
    const MAX_ENV_COUNT: usize = 32;
    const MAX_ENV_VALUE_LENGTH: usize = 8_192;
    const PLATFORM_ENV_KEYS: [&str; 13] = [
        "APPDATA",
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "SystemRoot",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    ];
    let runtime_id = launch.runtime_id.0.as_str();
    let platform_keys = PLATFORM_ENV_KEYS.into_iter().collect::<HashSet<_>>();
    if launch.configured_env.len() > MAX_ENV_COUNT {
        return invalid_custom_launch(
            runtime_id,
            "Custom runtime configured environment exceeds the native variable limit.",
        );
    }

    for (key, value) in &launch.configured_env {
        if !is_valid_env_key(key)
            || matches!(key.to_ascii_uppercase().as_str(), "PATH" | "PATHEXT")
            || looks_secret_env_key(key)
            || value.contains('\0')
            || value.len() > MAX_ENV_VALUE_LENGTH
        {
            return invalid_custom_launch(
                runtime_id,
                "Custom runtime configured environment contains a forbidden variable.",
            );
        }
        if launch.env.get(key) != Some(value) {
            return invalid_custom_launch(
                runtime_id,
                "Custom runtime effective environment does not match its definition.",
            );
        }
    }

    for (key, value) in &launch.env {
        let is_platform = platform_keys.contains(key.as_str())
            || key == "PATH"
            || cfg!(windows) && key == "PATHEXT";
        if (!is_platform && !launch.configured_env.contains_key(key))
            || !is_valid_env_key(key)
            || value.contains('\0')
        {
            return invalid_custom_launch(
                runtime_id,
                "Custom runtime effective environment contains an unexpected variable.",
            );
        }
    }
    if launch.env.get("PATH").is_none_or(String::is_empty) {
        return invalid_custom_launch(
            runtime_id,
            "Custom runtime effective environment requires a controlled PATH.",
        );
    }
    Ok(())
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn looks_secret_env_key(key: &str) -> bool {
    let segments = key
        .to_ascii_uppercase()
        .split('_')
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    segments.iter().any(|segment| {
        matches!(
            segment.as_str(),
            "APIKEY" | "AUTH" | "CREDENTIAL" | "PASSWORD" | "PRIVATE" | "SECRET" | "TOKEN"
        )
    }) || segments
        .windows(2)
        .any(|segments| segments[0] == "API" && segments[1] == "KEY")
}

fn invalid_custom_launch<T>(runtime_id: &str, message: &str) -> AiResult<T> {
    Err(AiError::RuntimeLaunchContextInvalid {
        runtime_id: runtime_id.to_string(),
        message: message.to_string(),
    })
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

fn native_unavailable_status(definition: &RuntimeDefinition) -> NativeAiRuntimeStatus {
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
            std::iter::once(definition.default_executable.as_str())
                .chain(definition.acp_args.iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" "),
        ),
        available_commands: Vec::new(),
        config_options: Vec::new(),
        message: definition.message.clone(),
        mode_id: None,
        modes: Vec::new(),
        model_id: None,
        models: Vec::new(),
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
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FingerprintContractFixture {
        args: Vec<String>,
        auth_mode: String,
        command: String,
        env: BTreeMap<String, String>,
        expected_fingerprint: String,
        profile: String,
    }

    fn custom_launch(runtime_id: &str, display_name: &str) -> NativeCustomAcpLaunchSpec {
        let configured_env = BTreeMap::from([("PI_PROFILE".to_string(), "test".to_string())]);
        let args = vec!["--stdio".to_string()];
        let normalized = CustomLaunchFingerprintInput {
            args: &args,
            auth_mode: "external",
            command: "pi-acp",
            env: &configured_env,
            profile: "acp-current14-custom-v1",
        };
        let launch_fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&normalized).unwrap())
        );
        NativeCustomAcpLaunchSpec {
            args,
            auth_mode: "external".to_string(),
            command: "pi-acp".to_string(),
            configured_env,
            display_name: display_name.to_string(),
            env: BTreeMap::from([
                ("HOME".to_string(), "/tmp/custom-home".to_string()),
                ("PATH".to_string(), "/usr/bin:/bin".to_string()),
                ("PI_PROFILE".to_string(), "test".to_string()),
            ]),
            executable: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            launch_fingerprint,
            product_profile: "conservative".to_string(),
            protocol_version: "acp-current14".to_string(),
            revision: 1,
            runtime_id: RuntimeId(runtime_id.to_string()),
            state: "ready".to_string(),
        }
    }

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

    #[test]
    fn builds_owned_custom_definitions_without_mutating_built_in_registry() {
        let registry = RuntimeRegistry::default();
        let before = registry.list();
        let first = custom_launch(
            "custom:550e8400-e29b-41d4-a716-446655440000",
            "Pi development",
        );
        let second = custom_launch(
            "custom:7d444840-9dc0-11d1-b245-5ffdce74fad2",
            "Internal agent",
        );
        assert_eq!(
            first.launch_fingerprint,
            "43cf1fd37a117acccec79c584901101018ec30df75ed039e09ddd86477156568"
        );

        let first_thread =
            std::thread::spawn(move || RuntimeDefinition::from_custom_launch(&first).unwrap());
        let second_thread =
            std::thread::spawn(move || RuntimeDefinition::from_custom_launch(&second).unwrap());
        let first_definition = first_thread.join().unwrap();
        let second_definition = second_thread.join().unwrap();

        assert_eq!(first_definition.display_name, "Pi development");
        assert_eq!(second_definition.display_name, "Internal agent");
        assert_ne!(first_definition.id, second_definition.id);
        assert_eq!(registry.list(), before);
    }

    #[test]
    fn rejects_custom_launch_with_mismatched_fingerprint() {
        let mut launch = custom_launch("custom:550e8400-e29b-41d4-a716-446655440000", "Pi");
        launch.args.push("--changed".to_string());

        let error = RuntimeDefinition::from_custom_launch(&launch).unwrap_err();

        assert!(matches!(
            error,
            AiError::RuntimeLaunchContextInvalid { message, .. }
                if message.contains("fingerprint")
        ));
    }

    #[test]
    fn accepts_typescript_fingerprint_contract_with_mixed_case_environment() {
        let fixture: FingerprintContractFixture = serde_json::from_str(include_str!(
            "../tests/fixtures/custom-launch-fingerprint.json"
        ))
        .expect("shared fingerprint fixture");
        assert_eq!(fixture.profile, "acp-current14-custom-v1");
        let normalized = CustomLaunchFingerprintInput {
            args: &fixture.args,
            auth_mode: &fixture.auth_mode,
            command: &fixture.command,
            env: &fixture.env,
            profile: "acp-current14-custom-v1",
        };
        let actual_fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&normalized).unwrap())
        );
        assert_eq!(actual_fingerprint, fixture.expected_fingerprint);

        let mut launch = custom_launch("custom:550e8400-e29b-41d4-a716-446655440000", "Pi");
        launch.args = fixture.args;
        launch.auth_mode = fixture.auth_mode;
        launch.command = fixture.command;
        launch.configured_env = fixture.env;
        launch.env = BTreeMap::from([
            ("HOME".to_string(), "/tmp/custom-home".to_string()),
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
        ]);
        launch.env.extend(launch.configured_env.clone());
        launch.launch_fingerprint = fixture.expected_fingerprint;

        RuntimeDefinition::from_custom_launch(&launch)
            .expect("native runtime should accept the TypeScript fingerprint");
    }

    #[test]
    fn rejects_custom_launch_with_forbidden_environment() {
        let mut launch = custom_launch("custom:550e8400-e29b-41d4-a716-446655440000", "Pi");
        launch
            .configured_env
            .insert("INTERNAL_API_TOKEN".to_string(), "hidden".to_string());
        launch
            .env
            .insert("INTERNAL_API_TOKEN".to_string(), "hidden".to_string());

        let error = RuntimeDefinition::from_custom_launch(&launch).unwrap_err();

        assert!(matches!(
            error,
            AiError::RuntimeLaunchContextInvalid { message, .. }
                if message.contains("forbidden variable")
        ));
    }

    #[test]
    fn rejects_noncanonical_custom_runtime_id() {
        let launch = custom_launch("custom:codex", "Pi");

        let error = RuntimeDefinition::from_custom_launch(&launch).unwrap_err();

        assert!(matches!(
            error,
            AiError::RuntimeLaunchContextInvalid { message, .. }
                if message.contains("canonical UUID")
        ));
    }
}
