use std::collections::BTreeMap;

use comando_types::ai::NativeAiLaunchSpec;

use crate::redaction::redact_env_key_value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpProcessSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
}

impl AcpProcessSpec {
    pub fn from_launch(launch: &NativeAiLaunchSpec) -> Self {
        Self {
            executable: launch.executable.clone(),
            args: launch.args.clone(),
            cwd: launch.cwd.clone(),
            env: launch.env.clone(),
        }
    }

    pub fn redacted_env(&self) -> BTreeMap<String, String> {
        self.env
            .iter()
            .map(|(key, value)| (key.clone(), redact_env_key_value(key, value)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use comando_types::ai::NativeAiRuntimeStatus;
    use comando_types::ids::RuntimeId;

    #[test]
    fn redacts_launch_env() {
        let mut env = BTreeMap::new();
        env.insert("OPENAI_API_KEY".to_string(), "sk-secret".to_string());
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        let spec = AcpProcessSpec::from_launch(&NativeAiLaunchSpec {
            executable: "opencode".to_string(),
            args: vec!["acp".to_string()],
            cwd: "/tmp".to_string(),
            env,
            command: "opencode acp".to_string(),
            status: NativeAiRuntimeStatus {
                runtime_id: RuntimeId("opencode".to_string()),
                state: "ready".to_string(),
                auth_method: None,
                auth_methods: Vec::new(),
                auth_ready: true,
                checked_at: crate::events::now_iso8601(),
                command: Some("opencode acp".to_string()),
                message: None,
                onboarding_required: false,
                source: Some("path".to_string()),
                has_custom_binary_path: false,
                has_gateway_config: false,
                has_gateway_url: false,
            },
        });

        assert_eq!(spec.redacted_env()["OPENAI_API_KEY"], "[redacted]");
        assert_eq!(spec.redacted_env()["PATH"], "/usr/bin");
    }
}
