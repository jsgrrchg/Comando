use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::secrets::{
    InMemoryRuntimeSecretStore, RuntimeSecretStore, SecretStoreError, default_runtime_secret_store,
    is_known_runtime_id, is_secret_env_key_for_runtime, secret_env_keys_for_runtime,
};

const RUNTIME_SETUP_STORE_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum RuntimeSetupError {
    #[error("Failed to read AI runtime setup store: {0}")]
    ReadFailed(String),
    #[error("Failed to parse AI runtime setup store: {0}")]
    ParseFailed(String),
    #[error("Failed to encode AI runtime setup store: {0}")]
    EncodeFailed(String),
    #[error("Failed to write AI runtime setup store: {0}")]
    WriteFailed(String),
    #[error("Invalid runtime id `{0}`.")]
    InvalidRuntime(String),
    #[error(transparent)]
    Secret(#[from] SecretStoreError),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetupState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_invalidated_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bedrock_gateway_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub secret_env_keys: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub non_secret_env: BTreeMap<String, String>,
}

impl RuntimeSetupState {
    pub fn is_empty(&self) -> bool {
        self.binary_path.as_deref().unwrap_or("").trim().is_empty()
            && self.auth_method.as_deref().unwrap_or("").trim().is_empty()
            && self.auth_invalidated_at_ms.is_none()
            && self
                .gateway_base_url
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            && self
                .bedrock_gateway_base_url
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            && self.secret_env_keys.is_empty()
            && self.non_secret_env.is_empty()
    }

    pub fn normalize(mut self, runtime_id: &str) -> Self {
        self.binary_path = normalize_optional_text(self.binary_path);
        self.auth_method = normalize_optional_text(self.auth_method);
        self.gateway_base_url = normalize_optional_text(self.gateway_base_url);
        self.bedrock_gateway_base_url = normalize_optional_text(self.bedrock_gateway_base_url);
        self.secret_env_keys
            .retain(|key| is_secret_env_key_for_runtime(runtime_id, key));
        self.non_secret_env = self
            .non_secret_env
            .into_iter()
            .filter_map(|(key, value)| {
                let value = value.trim();
                if value.is_empty() || is_secret_env_key_for_runtime(runtime_id, &key) {
                    None
                } else {
                    Some((key, value.to_string()))
                }
            })
            .collect();
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRuntimeSetupFile {
    pub version: u32,
    #[serde(default)]
    pub runtimes: BTreeMap<String, PersistedRuntimeSetupState>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRuntimeSetupState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_invalidated_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bedrock_gateway_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_env_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub non_secret_env: BTreeMap<String, String>,
}

impl PersistedRuntimeSetupState {
    fn into_runtime_setup(self, runtime_id: &str) -> RuntimeSetupState {
        RuntimeSetupState {
            binary_path: self.binary_path,
            auth_method: self.auth_method,
            auth_invalidated_at_ms: self.auth_invalidated_at_ms,
            gateway_base_url: self.gateway_base_url,
            bedrock_gateway_base_url: self.bedrock_gateway_base_url,
            secret_env_keys: self.secret_env_keys.into_iter().collect(),
            non_secret_env: self.non_secret_env,
        }
        .normalize(runtime_id)
    }

    fn from_runtime_setup(runtime_id: &str, setup: RuntimeSetupState) -> Option<Self> {
        let setup = setup.normalize(runtime_id);
        if setup.is_empty() {
            return None;
        }
        let secret_env_keys = setup.secret_env_keys.into_iter().collect::<Vec<_>>();
        Some(Self {
            binary_path: setup.binary_path,
            auth_method: setup.auth_method,
            auth_invalidated_at_ms: setup.auth_invalidated_at_ms,
            gateway_base_url: setup.gateway_base_url,
            bedrock_gateway_base_url: setup.bedrock_gateway_base_url,
            secret_env_keys,
            non_secret_env: setup.non_secret_env,
        })
    }
}

#[derive(Clone)]
pub struct RuntimeSetupStore {
    path: PathBuf,
    secrets: Arc<dyn RuntimeSecretStore>,
}

impl RuntimeSetupStore {
    pub fn new(path: PathBuf) -> Self {
        Self::with_secret_store(path, default_runtime_secret_store())
    }

    pub fn with_secret_store(path: PathBuf, secrets: Arc<dyn RuntimeSecretStore>) -> Self {
        Self { path, secrets }
    }

    pub fn in_memory_for_tests(path: PathBuf) -> Self {
        Self::with_secret_store(path, Arc::new(InMemoryRuntimeSecretStore::default()))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn secrets(&self) -> Arc<dyn RuntimeSecretStore> {
        Arc::clone(&self.secrets)
    }

    pub fn load_all(&self) -> Result<BTreeMap<String, RuntimeSetupState>, RuntimeSetupError> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeMap::new());
            }
            Err(error) => return Err(RuntimeSetupError::ReadFailed(error.to_string())),
        };
        let persisted: PersistedRuntimeSetupFile = serde_json::from_str(&raw).map_err(|error| {
            RuntimeSetupError::ParseFailed(redact_setup_error(error.to_string()))
        })?;
        if persisted.version != RUNTIME_SETUP_STORE_VERSION {
            return Ok(BTreeMap::new());
        }
        Ok(persisted
            .runtimes
            .into_iter()
            .filter(|(runtime_id, _)| is_known_runtime_id(runtime_id))
            .map(|(runtime_id, state)| {
                let state = state.into_runtime_setup(&runtime_id);
                (runtime_id, state)
            })
            .collect())
    }

    pub fn load_runtime(&self, runtime_id: &str) -> Result<RuntimeSetupState, RuntimeSetupError> {
        validate_runtime_id(runtime_id)?;
        Ok(self.load_all()?.remove(runtime_id).unwrap_or_default())
    }

    pub fn save_runtime(
        &self,
        runtime_id: &str,
        state: RuntimeSetupState,
    ) -> Result<(), RuntimeSetupError> {
        validate_runtime_id(runtime_id)?;
        let mut all = self.load_all()?;
        let state = state.normalize(runtime_id);
        if state.is_empty() {
            all.remove(runtime_id);
        } else {
            all.insert(runtime_id.to_string(), state);
        }
        self.save_all(&all)
    }

    pub fn update_runtime(
        &self,
        runtime_id: &str,
        update: impl FnOnce(&mut RuntimeSetupState),
    ) -> Result<RuntimeSetupState, RuntimeSetupError> {
        validate_runtime_id(runtime_id)?;
        let mut all = self.load_all()?;
        let mut state = all.remove(runtime_id).unwrap_or_default();
        update(&mut state);
        state = state.normalize(runtime_id);
        if state.is_empty() {
            all.remove(runtime_id);
        } else {
            all.insert(runtime_id.to_string(), state.clone());
        }
        self.save_all(&all)?;
        Ok(state)
    }

    pub fn set_secret(
        &self,
        runtime_id: &str,
        env_key: &str,
        value: &str,
    ) -> Result<(), RuntimeSetupError> {
        self.secrets.set_secret(runtime_id, env_key, value)?;
        self.update_runtime(runtime_id, |state| {
            state.secret_env_keys.insert(env_key.to_string());
        })?;
        Ok(())
    }

    pub fn delete_secret(&self, runtime_id: &str, env_key: &str) -> Result<(), RuntimeSetupError> {
        self.secrets.delete_secret(runtime_id, env_key)?;
        self.update_runtime(runtime_id, |state| {
            state.secret_env_keys.remove(env_key);
        })?;
        Ok(())
    }

    fn save_all(
        &self,
        states: &BTreeMap<String, RuntimeSetupState>,
    ) -> Result<(), RuntimeSetupError> {
        let runtimes = states
            .iter()
            .filter(|(runtime_id, _)| is_known_runtime_id(runtime_id))
            .filter_map(|(runtime_id, state)| {
                PersistedRuntimeSetupState::from_runtime_setup(runtime_id, state.clone())
                    .map(|persisted| (runtime_id.clone(), persisted))
            })
            .collect::<BTreeMap<_, _>>();

        if runtimes.is_empty() {
            match fs::remove_file(&self.path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(RuntimeSetupError::WriteFailed(error.to_string())),
            }
            return Ok(());
        }

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| RuntimeSetupError::WriteFailed(error.to_string()))?;
        }
        let persisted = PersistedRuntimeSetupFile {
            version: RUNTIME_SETUP_STORE_VERSION,
            runtimes,
        };
        let encoded = serde_json::to_vec_pretty(&persisted)
            .map_err(|error| RuntimeSetupError::EncodeFailed(error.to_string()))?;
        let temp_path = self.path.with_extension(format!(
            "json.tmp-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        write_secret_file(&temp_path, &encoded)?;
        replace_file(&temp_path, &self.path).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            RuntimeSetupError::WriteFailed(error.to_string())
        })
    }
}

pub fn validate_runtime_id(runtime_id: &str) -> Result<(), RuntimeSetupError> {
    if is_known_runtime_id(runtime_id) {
        Ok(())
    } else {
        Err(RuntimeSetupError::InvalidRuntime(runtime_id.to_string()))
    }
}

pub fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

pub fn default_runtime_setup_state(runtime_id: &str) -> RuntimeSetupState {
    RuntimeSetupState {
        secret_env_keys: secret_env_keys_for_runtime(runtime_id)
            .iter()
            .filter_map(|key| {
                if is_secret_env_key_for_runtime(runtime_id, key) {
                    Some((*key).to_string())
                } else {
                    None
                }
            })
            .collect::<BTreeSet<_>>(),
        ..RuntimeSetupState::default()
    }
}

fn write_secret_file(path: &Path, bytes: &[u8]) -> Result<(), RuntimeSetupError> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| RuntimeSetupError::WriteFailed(error.to_string()))?;
    file.write_all(bytes)
        .map_err(|error| RuntimeSetupError::WriteFailed(error.to_string()))?;
    file.flush()
        .map_err(|error| RuntimeSetupError::WriteFailed(error.to_string()))
}

#[cfg(windows)]
fn replace_file(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    match fs::remove_file(target_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    fs::rename(temp_path, target_path)
}

#[cfg(not(windows))]
fn replace_file(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    fs::rename(temp_path, target_path)
}

fn redact_setup_error(message: String) -> String {
    let mut redacted = message;
    for marker in [
        "sk-",
        "xai-",
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "XAI_API_KEY",
        "KILO_API_KEY",
    ] {
        if redacted.contains(marker) {
            redacted = redacted.replace(marker, "[REDACTED]");
        }
    }
    redacted
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn setup_store_round_trips_non_secret_metadata() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = RuntimeSetupStore::in_memory_for_tests(temp.path().join("runtime-setup.json"));
        let mut state = RuntimeSetupState {
            binary_path: Some(" /usr/local/bin/claude ".to_string()),
            auth_method: Some("gateway".to_string()),
            gateway_base_url: Some("https://gateway.example.com".to_string()),
            ..RuntimeSetupState::default()
        };
        state.non_secret_env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "https://api.example.com".to_string(),
        );

        store.save_runtime("claude", state).expect("save");
        let loaded = store.load_runtime("claude").expect("load");

        assert_eq!(loaded.binary_path.as_deref(), Some("/usr/local/bin/claude"));
        assert_eq!(loaded.auth_method.as_deref(), Some("gateway"));
        assert_eq!(
            loaded.gateway_base_url.as_deref(),
            Some("https://gateway.example.com")
        );
        assert_eq!(
            loaded
                .non_secret_env
                .get("ANTHROPIC_BASE_URL")
                .map(String::as_str),
            Some("https://api.example.com")
        );
    }

    #[test]
    fn setup_store_does_not_serialize_secret_values() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = RuntimeSetupStore::in_memory_for_tests(temp.path().join("runtime-setup.json"));

        store
            .set_secret("grok", "XAI_API_KEY", "xai-super-secret")
            .expect("set secret");

        let encoded = fs::read_to_string(store.path()).expect("runtime setup json");
        assert!(encoded.contains("secretEnvKeys"));
        assert!(encoded.contains("XAI_API_KEY"));
        assert!(!encoded.contains("xai-super-secret"));
    }

    #[test]
    fn setup_store_rejects_cross_runtime_secret_marker() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = RuntimeSetupStore::in_memory_for_tests(temp.path().join("runtime-setup.json"));
        let mut state = RuntimeSetupState::default();
        state.secret_env_keys.insert("OPENAI_API_KEY".to_string());

        store.save_runtime("grok", state).expect("save");
        let loaded = store.load_runtime("grok").expect("load");

        assert!(loaded.secret_env_keys.is_empty());
    }

    #[test]
    fn corrupt_json_returns_redacted_parse_error() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("runtime-setup.json");
        fs::write(&path, "{\"secret\":\"sk-secret-value\"").expect("write");
        let store = RuntimeSetupStore::in_memory_for_tests(path);

        let error = store.load_all().expect_err("parse error");

        assert!(!error.to_string().contains("sk-secret-value"));
    }

    #[test]
    fn corrupt_json_is_not_overwritten_by_save() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("runtime-setup.json");
        fs::write(&path, "{\"secret\":\"sk-secret-value\"").expect("write");
        let store = RuntimeSetupStore::in_memory_for_tests(path.clone());

        let error = store
            .save_runtime(
                "codex",
                RuntimeSetupState {
                    auth_method: Some("chatgpt".to_string()),
                    ..RuntimeSetupState::default()
                },
            )
            .expect_err("parse error");

        assert!(!error.to_string().contains("sk-secret-value"));
        assert_eq!(
            fs::read_to_string(path).expect("runtime setup json"),
            "{\"secret\":\"sk-secret-value\""
        );
    }

    #[test]
    fn empty_state_removes_store_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("runtime-setup.json");
        let store = RuntimeSetupStore::in_memory_for_tests(path.clone());
        store
            .save_runtime(
                "codex",
                RuntimeSetupState {
                    auth_method: Some("chatgpt".to_string()),
                    ..RuntimeSetupState::default()
                },
            )
            .expect("save");
        assert!(path.exists());

        store
            .save_runtime("codex", RuntimeSetupState::default())
            .expect("clear");

        assert!(!path.exists());
    }
}
