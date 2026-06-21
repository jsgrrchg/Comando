use std::collections::BTreeMap;
use std::sync::Mutex;

use comando_types::ai::NativeSecretStorageStatus;
use thiserror::Error;

const SECRET_SERVICE_NAME: &str = "Comando AI Provider Secrets";
const NATIVE_SECRET_STORE_ENV: &str = "COMANDO_NATIVE_SECRET_STORE";

#[derive(Debug, Error)]
pub enum SecretStoreError {
    #[error("Secret storage is unavailable: {0}")]
    Unavailable(String),
    #[error("Invalid secret key `{env_key}` for runtime `{runtime_id}`.")]
    InvalidSecretKey { runtime_id: String, env_key: String },
    #[error("Failed to read AI provider secret from secure storage: {0}")]
    ReadFailed(String),
    #[error("Failed to save AI provider secret to secure storage: {0}")]
    WriteFailed(String),
    #[error("Failed to remove AI provider secret from secure storage: {0}")]
    DeleteFailed(String),
    #[error("Secret store lock failed: {0}")]
    LockFailed(String),
}

pub trait RuntimeSecretStore: Send + Sync {
    fn get_secret(
        &self,
        runtime_id: &str,
        env_key: &str,
    ) -> Result<Option<String>, SecretStoreError>;
    fn set_secret(
        &self,
        runtime_id: &str,
        env_key: &str,
        value: &str,
    ) -> Result<(), SecretStoreError>;
    fn delete_secret(&self, runtime_id: &str, env_key: &str) -> Result<(), SecretStoreError>;
    fn status(&self) -> NativeSecretStorageStatus;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeSecretStoreMode {
    Keyring,
    Memory,
    ElectronBridge,
}

impl RuntimeSecretStoreMode {
    pub fn from_env_value(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("memory") => Self::Memory,
            Some("electron-bridge") => Self::ElectronBridge,
            _ => Self::Keyring,
        }
    }
}

pub fn default_runtime_secret_store() -> std::sync::Arc<dyn RuntimeSecretStore> {
    match RuntimeSecretStoreMode::from_env_value(std::env::var(NATIVE_SECRET_STORE_ENV).ok().as_deref()) {
        RuntimeSecretStoreMode::Keyring => std::sync::Arc::new(KeyringRuntimeSecretStore),
        RuntimeSecretStoreMode::Memory => std::sync::Arc::new(InMemoryRuntimeSecretStore::default()),
        RuntimeSecretStoreMode::ElectronBridge => std::sync::Arc::new(UnsupportedRuntimeSecretStore {
            backend: "electron-bridge",
            message: "Electron bridge secret storage is not available inside the native backend yet.",
        }),
    }
}

#[derive(Debug)]
pub struct KeyringRuntimeSecretStore;

impl KeyringRuntimeSecretStore {
    fn entry(runtime_id: &str, env_key: &str) -> Result<keyring::Entry, SecretStoreError> {
        validate_secret_env_key(runtime_id, env_key)?;
        keyring::Entry::new(SECRET_SERVICE_NAME, &runtime_secret_account(runtime_id, env_key))
            .map_err(|error| SecretStoreError::Unavailable(error.to_string()))
    }
}

impl RuntimeSecretStore for KeyringRuntimeSecretStore {
    fn get_secret(
        &self,
        runtime_id: &str,
        env_key: &str,
    ) -> Result<Option<String>, SecretStoreError> {
        match Self::entry(runtime_id, env_key)?.get_password() {
            Ok(value) => Ok(normalize_secret(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(SecretStoreError::ReadFailed(error.to_string())),
        }
    }

    fn set_secret(
        &self,
        runtime_id: &str,
        env_key: &str,
        value: &str,
    ) -> Result<(), SecretStoreError> {
        let value = value.trim();
        if value.is_empty() {
            return self.delete_secret(runtime_id, env_key);
        }
        Self::entry(runtime_id, env_key)?
            .set_password(value)
            .map_err(|error| SecretStoreError::WriteFailed(error.to_string()))
    }

    fn delete_secret(&self, runtime_id: &str, env_key: &str) -> Result<(), SecretStoreError> {
        match Self::entry(runtime_id, env_key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(SecretStoreError::DeleteFailed(error.to_string())),
        }
    }

    fn status(&self) -> NativeSecretStorageStatus {
        NativeSecretStorageStatus {
            backend: "keyring".to_string(),
            available: true,
            weak: false,
            message: None,
            platform: std::env::consts::OS.to_string(),
        }
    }
}

#[derive(Default)]
pub struct InMemoryRuntimeSecretStore {
    values: Mutex<BTreeMap<(String, String), String>>,
}

impl InMemoryRuntimeSecretStore {
    pub fn stored_secret(&self, runtime_id: &str, env_key: &str) -> Option<String> {
        self.values
            .lock()
            .ok()?
            .get(&(runtime_id.to_string(), env_key.to_string()))
            .cloned()
    }
}

impl RuntimeSecretStore for InMemoryRuntimeSecretStore {
    fn get_secret(
        &self,
        runtime_id: &str,
        env_key: &str,
    ) -> Result<Option<String>, SecretStoreError> {
        validate_secret_env_key(runtime_id, env_key)?;
        Ok(self
            .values
            .lock()
            .map_err(|error| SecretStoreError::LockFailed(error.to_string()))?
            .get(&(runtime_id.to_string(), env_key.to_string()))
            .cloned())
    }

    fn set_secret(
        &self,
        runtime_id: &str,
        env_key: &str,
        value: &str,
    ) -> Result<(), SecretStoreError> {
        validate_secret_env_key(runtime_id, env_key)?;
        let value = value.trim();
        if value.is_empty() {
            return self.delete_secret(runtime_id, env_key);
        }
        self.values
            .lock()
            .map_err(|error| SecretStoreError::LockFailed(error.to_string()))?
            .insert((runtime_id.to_string(), env_key.to_string()), value.to_string());
        Ok(())
    }

    fn delete_secret(&self, runtime_id: &str, env_key: &str) -> Result<(), SecretStoreError> {
        validate_secret_env_key(runtime_id, env_key)?;
        self.values
            .lock()
            .map_err(|error| SecretStoreError::LockFailed(error.to_string()))?
            .remove(&(runtime_id.to_string(), env_key.to_string()));
        Ok(())
    }

    fn status(&self) -> NativeSecretStorageStatus {
        NativeSecretStorageStatus {
            backend: "memory".to_string(),
            available: true,
            weak: true,
            message: Some("In-memory secret storage is for tests and development only.".to_string()),
            platform: std::env::consts::OS.to_string(),
        }
    }
}

pub struct UnsupportedRuntimeSecretStore {
    pub backend: &'static str,
    pub message: &'static str,
}

impl RuntimeSecretStore for UnsupportedRuntimeSecretStore {
    fn get_secret(
        &self,
        runtime_id: &str,
        env_key: &str,
    ) -> Result<Option<String>, SecretStoreError> {
        validate_secret_env_key(runtime_id, env_key)?;
        Err(SecretStoreError::Unavailable(self.message.to_string()))
    }

    fn set_secret(
        &self,
        runtime_id: &str,
        env_key: &str,
        _value: &str,
    ) -> Result<(), SecretStoreError> {
        validate_secret_env_key(runtime_id, env_key)?;
        Err(SecretStoreError::Unavailable(self.message.to_string()))
    }

    fn delete_secret(&self, runtime_id: &str, env_key: &str) -> Result<(), SecretStoreError> {
        validate_secret_env_key(runtime_id, env_key)?;
        Err(SecretStoreError::Unavailable(self.message.to_string()))
    }

    fn status(&self) -> NativeSecretStorageStatus {
        NativeSecretStorageStatus {
            backend: self.backend.to_string(),
            available: false,
            weak: false,
            message: Some(self.message.to_string()),
            platform: std::env::consts::OS.to_string(),
        }
    }
}

pub fn secret_env_keys_for_runtime(runtime_id: &str) -> &'static [&'static str] {
    match runtime_id {
        "codex" => &["CODEX_API_KEY", "OPENAI_API_KEY"],
        "claude" => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_CUSTOM_HEADERS",
        ],
        "grok" => &["XAI_API_KEY"],
        "kilo" => &["KILO_API_KEY"],
        "opencode" => &[],
        _ => &[],
    }
}

pub fn is_secret_env_key_for_runtime(runtime_id: &str, env_key: &str) -> bool {
    secret_env_keys_for_runtime(runtime_id).contains(&env_key)
}

pub fn validate_secret_env_key(runtime_id: &str, env_key: &str) -> Result<(), SecretStoreError> {
    if is_secret_env_key_for_runtime(runtime_id, env_key) {
        return Ok(());
    }
    Err(SecretStoreError::InvalidSecretKey {
        runtime_id: runtime_id.to_string(),
        env_key: env_key.to_string(),
    })
}

pub fn is_known_runtime_id(runtime_id: &str) -> bool {
    matches!(runtime_id, "claude" | "codex" | "grok" | "kilo" | "opencode")
}

fn runtime_secret_account(runtime_id: &str, env_key: &str) -> String {
    format!("{runtime_id}:{env_key}")
}

fn normalize_secret(value: String) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_sets_gets_and_deletes_secret() {
        let store = InMemoryRuntimeSecretStore::default();

        store
            .set_secret("codex", "OPENAI_API_KEY", " sk-test ")
            .expect("set");
        assert_eq!(
            store.get_secret("codex", "OPENAI_API_KEY").expect("get"),
            Some("sk-test".to_string())
        );

        store
            .delete_secret("codex", "OPENAI_API_KEY")
            .expect("delete");
        assert_eq!(
            store.get_secret("codex", "OPENAI_API_KEY").expect("get"),
            None
        );
    }

    #[test]
    fn memory_store_empty_value_deletes_secret() {
        let store = InMemoryRuntimeSecretStore::default();

        store
            .set_secret("kilo", "KILO_API_KEY", "kilo-secret")
            .expect("set");
        store.set_secret("kilo", "KILO_API_KEY", " ").expect("clear");

        assert_eq!(store.get_secret("kilo", "KILO_API_KEY").expect("get"), None);
    }

    #[test]
    fn allowlist_rejects_cross_runtime_secret_keys() {
        let store = InMemoryRuntimeSecretStore::default();
        let error = store
            .set_secret("grok", "OPENAI_API_KEY", "super-private-value")
            .expect_err("invalid key");

        assert!(matches!(error, SecretStoreError::InvalidSecretKey { .. }));
        assert!(!error.to_string().contains("super-private-value"));
    }

    #[test]
    fn memory_status_is_marked_weak() {
        let status = InMemoryRuntimeSecretStore::default().status();

        assert_eq!(status.backend, "memory");
        assert!(status.available);
        assert!(status.weak);
    }
}
