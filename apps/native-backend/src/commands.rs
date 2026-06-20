use comando_persistence::{NativeStorageConfig, SqlitePersistenceStore, closed_storage_health};
use comando_projects::{ProjectRegistry, ProjectRegistryError};
use comando_types::capabilities::{
    BACKEND_NAME, NativeBackendCapabilitiesOutput, NativeBackendHandshakeInput,
    NativeBackendHandshakeOutput, PROTOCOL_VERSION, RUST_VERSION, backend_capabilities,
    bootstrap_capabilities, negotiate_protocol_version,
};
use comando_types::commands::{
    BACKEND_CAPABILITIES, BACKEND_EMIT_TEST_EVENT, BACKEND_HANDSHAKE, BACKEND_PING,
    BACKEND_SHUTDOWN, PERSISTENCE_GET_SNAPSHOT, PERSISTENCE_GET_STORAGE_HEALTH,
    PERSISTENCE_OPEN_STORE, PROJECT_ADD, PROJECT_LIST,
};
use comando_types::error::{NativeError, NativeErrorCode};
use comando_types::events::BACKEND_TEST_EVENT;
use comando_types::ids::RequestId;
use comando_types::persistence::{
    NativePersistenceMode, NativePersistenceOpenStoreInput, NativePersistenceSnapshot,
};
use comando_types::projects::NativeProjectAddInput;
use serde_json::{Value, json};

use crate::protocol::{RpcOutput, RpcRequest, error_response, event, response_ok};

#[derive(Debug, Clone, PartialEq)]
pub struct CommandResult {
    pub outputs: Vec<RpcOutput>,
    pub should_shutdown: bool,
}

#[derive(Default)]
pub struct NativeBackend {
    persistence_store: Option<SqlitePersistenceStore>,
}

pub fn handle_request(request: RpcRequest) -> CommandResult {
    NativeBackend::default().handle_request(request)
}

impl NativeBackend {
    pub fn handle_request(&mut self, request: RpcRequest) -> CommandResult {
        match request.command.as_str() {
            BACKEND_PING => response_only(request.id, ping_payload()),
            BACKEND_HANDSHAKE => handle_handshake(request),
            BACKEND_CAPABILITIES => response_only(request.id, capabilities_payload()),
            BACKEND_SHUTDOWN => CommandResult {
                outputs: vec![response_ok(request.id, json!({"accepted": true}))],
                should_shutdown: true,
            },
            BACKEND_EMIT_TEST_EVENT => emit_test_event(request),
            PERSISTENCE_OPEN_STORE => self.open_persistence_store(request),
            PERSISTENCE_GET_STORAGE_HEALTH => self.get_storage_health(request),
            PERSISTENCE_GET_SNAPSHOT => self.get_snapshot(request),
            PROJECT_LIST => self.list_projects(request),
            PROJECT_ADD => self.add_projects(request),
            command => CommandResult {
                outputs: vec![error_response(
                    Some(request.id),
                    NativeError::new(
                        NativeErrorCode::UnknownCommand,
                        format!("Unknown command: {command}"),
                    ),
                )],
                should_shutdown: false,
            },
        }
    }

    fn open_persistence_store(&mut self, request: RpcRequest) -> CommandResult {
        let input =
            match serde_json::from_value::<NativePersistenceOpenStoreInput>(request.args.clone()) {
                Ok(input) => input,
                Err(error) => {
                    return error_only(
                        request.id,
                        NativeError::new(
                            NativeErrorCode::InvalidArgs,
                            format!("Invalid persistence_open_store args: {error}"),
                        ),
                    );
                }
            };
        let config = NativeStorageConfig {
            app_data_dir: input.app_data_dir.into(),
            database_path: input.database_path.into(),
            mode: input.mode,
        };

        match SqlitePersistenceStore::open(config) {
            Ok((store, output)) => {
                self.persistence_store = Some(store);
                CommandResult {
                    outputs: vec![
                        response_ok(
                            request.id,
                            serde_json::to_value(&output).expect("open store output serializes"),
                        ),
                        event(
                            "persistence://storage-opened",
                            serde_json::to_value(output).expect("open store event serializes"),
                        ),
                    ],
                    should_shutdown: false,
                }
            }
            Err(error) => error_only(request.id, error.to_native_error()),
        }
    }

    fn get_storage_health(&mut self, request: RpcRequest) -> CommandResult {
        let health = self
            .persistence_store
            .as_ref()
            .map(SqlitePersistenceStore::health)
            .unwrap_or_else(closed_storage_health);
        CommandResult {
            outputs: vec![
                response_ok(
                    request.id,
                    serde_json::to_value(&health).expect("health output serializes"),
                ),
                event(
                    "persistence://storage-health",
                    serde_json::to_value(health).expect("health event serializes"),
                ),
            ],
            should_shutdown: false,
        }
    }

    fn get_snapshot(&mut self, request: RpcRequest) -> CommandResult {
        response_only(
            request.id,
            serde_json::to_value(NativePersistenceSnapshot {
                active_project_id: None,
                active_worktree_id: None,
                workspace: None,
                updated_at: comando_persistence::store::now_rfc3339(),
            })
            .expect("snapshot output serializes"),
        )
    }

    fn list_projects(&mut self, request: RpcRequest) -> CommandResult {
        let Some(store) = self.persistence_store.as_mut() else {
            return backend_not_ready(request.id);
        };

        let mut registry = ProjectRegistry::new(store.connection_mut());
        match registry.list_projects() {
            Ok(result) => response_only(
                request.id,
                serde_json::to_value(result).expect("project list output serializes"),
            ),
            Err(error) => error_only(request.id, project_error(error)),
        }
    }

    fn add_projects(&mut self, request: RpcRequest) -> CommandResult {
        let Some(store) = self.persistence_store.as_mut() else {
            return backend_not_ready(request.id);
        };
        if !matches!(store.mode(), NativePersistenceMode::Write) {
            return error_only(
                request.id,
                NativeError::new(
                    NativeErrorCode::PermissionDenied,
                    "Native project_add requires project registry write mode.",
                ),
            );
        }
        let input = match serde_json::from_value::<NativeProjectAddInput>(request.args.clone()) {
            Ok(input) => input,
            Err(error) => {
                return error_only(
                    request.id,
                    NativeError::new(
                        NativeErrorCode::InvalidArgs,
                        format!("Invalid project_add args: {error}"),
                    ),
                );
            }
        };

        let mut registry = ProjectRegistry::new(store.connection_mut());
        match registry.add_project_paths(&input.project_paths) {
            Ok(result) => {
                let occurred_at = comando_persistence::store::now_rfc3339();
                let mut outputs = vec![response_ok(
                    request.id,
                    serde_json::to_value(&result).expect("project add output serializes"),
                )];
                for project_id in &result.project_ids_to_open {
                    outputs.push(event(
                        "project://updated",
                        json!({
                            "projectId": project_id.0.as_str(),
                            "worktreeId": format!("{}:primary", project_id.0.as_str()),
                            "reason": "project_add",
                            "occurredAt": occurred_at,
                        }),
                    ));
                }
                CommandResult {
                    outputs,
                    should_shutdown: false,
                }
            }
            Err(error) => error_only(request.id, project_error(error)),
        }
    }
}

fn response_only(id: RequestId, payload: Value) -> CommandResult {
    CommandResult {
        outputs: vec![response_ok(id, payload)],
        should_shutdown: false,
    }
}

fn error_only(id: RequestId, error: NativeError) -> CommandResult {
    CommandResult {
        outputs: vec![error_response(Some(id), error)],
        should_shutdown: false,
    }
}

fn backend_not_ready(id: RequestId) -> CommandResult {
    error_only(
        id,
        NativeError::new(
            NativeErrorCode::BackendNotReady,
            "Native persistence store has not been opened.",
        ),
    )
}

fn project_error(error: ProjectRegistryError) -> NativeError {
    error.to_native_error()
}

fn ping_payload() -> Value {
    json!({
        "pong": true,
        "backend": BACKEND_NAME,
    })
}

fn capabilities_payload() -> Value {
    serde_json::to_value(NativeBackendCapabilitiesOutput {
        backend_name: BACKEND_NAME.to_string(),
        backend_version: env!("CARGO_PKG_VERSION").to_string(),
        rust_version: RUST_VERSION.to_string(),
        protocol_version: PROTOCOL_VERSION,
        minimum_client_protocol_version: comando_types::MINIMUM_CLIENT_PROTOCOL_VERSION,
        minimum_backend_protocol_version: comando_types::MINIMUM_BACKEND_PROTOCOL_VERSION,
        capabilities: backend_capabilities(),
    })
    .expect("capabilities should serialize")
}

fn handle_handshake(request: RpcRequest) -> CommandResult {
    let input = match serde_json::from_value::<NativeBackendHandshakeInput>(request.args.clone()) {
        Ok(input) => input,
        Err(error) => {
            return CommandResult {
                outputs: vec![error_response(
                    Some(request.id),
                    NativeError::new(
                        NativeErrorCode::InvalidArgs,
                        format!("Invalid backend_handshake args: {error}"),
                    ),
                )],
                should_shutdown: false,
            };
        }
    };

    let Some(protocol_version) =
        negotiate_protocol_version(input.protocol_version, &input.supported_protocol_versions)
    else {
        return CommandResult {
            outputs: vec![error_response(
                Some(request.id),
                NativeError::new(
                    NativeErrorCode::UnsupportedProtocolVersion,
                    format!(
                        "Unsupported protocol version: client={} backend={}",
                        input.protocol_version, PROTOCOL_VERSION
                    ),
                )
                .with_details(json!({
                    "clientProtocolVersion": input.protocol_version,
                    "supportedProtocolVersions": input.supported_protocol_versions,
                    "backendProtocolVersion": PROTOCOL_VERSION,
                })),
            )],
            should_shutdown: false,
        };
    };

    response_only(
        request.id,
        serde_json::to_value(NativeBackendHandshakeOutput {
            backend_name: BACKEND_NAME.to_string(),
            backend_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version,
            minimum_client_protocol_version: comando_types::MINIMUM_CLIENT_PROTOCOL_VERSION,
            capabilities: bootstrap_capabilities(),
        })
        .expect("handshake should serialize"),
    )
}

fn emit_test_event(request: RpcRequest) -> CommandResult {
    let message = request
        .args
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("hello");

    CommandResult {
        outputs: vec![
            response_ok(request.id, json!({"emitted": true})),
            event(BACKEND_TEST_EVENT, json!({"message": message})),
        ],
        should_shutdown: false,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::Connection;
    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::*;
    use comando_types::ids::RequestId;

    use crate::protocol::{RpcOutput, RpcRequest};

    fn request(command: &str, args: Value) -> RpcRequest {
        RpcRequest {
            id: RequestId::Number(1),
            command: command.to_string(),
            args,
            meta: None,
        }
    }

    #[test]
    fn handles_ping() {
        let result = handle_request(request("backend_ping", json!({})));

        assert_eq!(
            result.outputs,
            vec![response_ok(
                RequestId::Number(1),
                json!({"pong": true, "backend": BACKEND_NAME})
            )]
        );
        assert!(!result.should_shutdown);
    }

    #[test]
    fn handles_capabilities() {
        let result = handle_request(request("backend_capabilities", json!({})));

        assert_eq!(
            result.outputs,
            vec![response_ok(RequestId::Number(1), capabilities_payload())]
        );
    }

    #[test]
    fn handles_test_event() {
        let result = handle_request(request(
            "backend_emit_test_event",
            json!({"message": "hola"}),
        ));

        assert_eq!(
            result.outputs,
            vec![
                response_ok(RequestId::Number(1), json!({"emitted": true})),
                event(BACKEND_TEST_EVENT, json!({"message": "hola"})),
            ]
        );
    }

    #[test]
    fn handles_shutdown() {
        let result = handle_request(request("backend_shutdown", json!({})));

        assert_eq!(
            result.outputs,
            vec![response_ok(RequestId::Number(1), json!({"accepted": true}))]
        );
        assert!(result.should_shutdown);
    }

    #[test]
    fn rejects_unknown_command() {
        let result = handle_request(request("backend_missing", json!({})));
        let [RpcOutput::Response(response)] = result.outputs.as_slice() else {
            panic!("expected one response");
        };

        assert!(!response.ok);
        assert!(response.result.is_none());
        assert_eq!(
            response.error.as_ref().map(|error| error.code.as_str()),
            Some("unknown_command")
        );
    }

    #[test]
    fn reports_closed_storage_health_before_open() {
        let mut backend = NativeBackend::default();

        let result = backend.handle_request(request("persistence_get_storage_health", json!({})));

        let response = only_response(&result);
        assert!(response.ok);
        assert_eq!(response.result.as_ref().unwrap()["opened"], false);
        assert_eq!(
            response.result.as_ref().unwrap()["databaseReachable"],
            false
        );
        assert_eq!(result.outputs.len(), 2);
    }

    #[test]
    fn returns_versioned_snapshot_stub() {
        let mut backend = NativeBackend::default();

        let result = backend.handle_request(request("persistence_get_snapshot", json!({})));

        let response = only_response(&result);
        assert!(response.ok);
        assert_eq!(
            response.result.as_ref().unwrap()["activeProjectId"],
            Value::Null
        );
        assert_eq!(
            response.result.as_ref().unwrap()["activeWorktreeId"],
            Value::Null
        );
        assert_eq!(response.result.as_ref().unwrap()["workspace"], Value::Null);
    }

    #[test]
    fn project_add_requires_write_mode_and_does_not_write_in_shadow() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("comando.sqlite3");
        let project_path = temp_dir.path().join("project-shadow");
        fs::create_dir_all(&project_path).expect("project dir");
        create_current_schema(&database_path);
        let mut backend = NativeBackend::default();

        let open_result = backend.handle_request(request(
            "persistence_open_store",
            json!({
                "appDataDir": temp_dir.path(),
                "databasePath": database_path,
                "mode": "shadow",
            }),
        ));
        assert!(only_response(&open_result).ok);

        let add_result = backend.handle_request(request(
            "project_add",
            json!({
                "projectPaths": [project_path],
                "ownerWindowId": null,
            }),
        ));
        let add_response = only_response(&add_result);
        assert!(!add_response.ok);
        assert_eq!(
            add_response.error.as_ref().map(|error| error.code.as_str()),
            Some("permission_denied")
        );
        assert_eq!(count_rows(&database_path, "projects"), 0);
    }

    #[test]
    fn opens_storage_and_handles_project_add_and_list() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("comando.sqlite3");
        let project_path = temp_dir.path().join("project-alpha");
        fs::create_dir_all(&project_path).expect("project dir");
        create_current_schema(&database_path);
        let mut backend = NativeBackend::default();

        let open_result = backend.handle_request(request(
            "persistence_open_store",
            json!({
                "appDataDir": temp_dir.path(),
                "databasePath": database_path,
                "mode": "write",
            }),
        ));
        let open_response = only_response(&open_result);
        assert!(open_response.ok);
        assert_eq!(open_response.result.as_ref().unwrap()["opened"], true);
        assert_eq!(open_result.outputs.len(), 2);

        let add_result = backend.handle_request(request(
            "project_add",
            json!({
                "projectPaths": [project_path],
                "ownerWindowId": null,
            }),
        ));
        let add_response = only_response(&add_result);
        assert!(add_response.ok);
        assert_eq!(
            add_response.result.as_ref().unwrap()["state"]["projects"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(add_result.outputs.len(), 2);
        let Some(RpcOutput::Event(updated_event)) = add_result.outputs.get(1) else {
            panic!("expected project updated event");
        };
        assert_eq!(updated_event.event_name, "project://updated");
        assert_eq!(updated_event.payload["reason"], "project_add");
        assert_eq!(updated_event.payload["projectId"].as_str().is_some(), true);
        assert_eq!(
            updated_event.payload["worktreeId"].as_str().unwrap(),
            format!(
                "{}:primary",
                updated_event.payload["projectId"].as_str().unwrap()
            )
        );

        let list_result = backend.handle_request(request("project_list", json!({})));
        let list_response = only_response(&list_result);
        assert!(list_response.ok);
        assert_eq!(
            list_response.result.as_ref().unwrap()["projects"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_response.result.as_ref().unwrap()["worktrees"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn project_errors_do_not_include_raw_paths() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("comando.sqlite3");
        let missing_path = temp_dir.path().join("missing-project");
        create_current_schema(&database_path);
        let mut backend = NativeBackend::default();

        let open_result = backend.handle_request(request(
            "persistence_open_store",
            json!({
                "appDataDir": temp_dir.path(),
                "databasePath": database_path,
                "mode": "write",
            }),
        ));
        assert!(only_response(&open_result).ok);

        let add_result = backend.handle_request(request(
            "project_add",
            json!({
                "projectPaths": [missing_path],
                "ownerWindowId": null,
            }),
        ));
        let response = only_response(&add_result);
        let error = response.error.as_ref().expect("native error");

        assert!(
            !error
                .message
                .contains(temp_dir.path().to_string_lossy().as_ref())
        );
        assert!(!error.message.contains("missing-project"));
        assert!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("path"))
                .and_then(Value::as_str)
                .is_some_and(|path| path.contains("<redacted>"))
        );
    }

    fn only_response(result: &CommandResult) -> &comando_types::protocol::NativeRpcResponse {
        let Some(RpcOutput::Response(response)) = result.outputs.first() else {
            panic!("expected first output to be a response");
        };
        response
    }

    fn create_current_schema(database_path: &std::path::Path) {
        let connection = Connection::open(database_path).expect("db");
        connection
            .execute_batch(
                "
                PRAGMA foreign_keys = ON;
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    canonical_root_path TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    is_hidden INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE project_roots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    root_path TEXT NOT NULL UNIQUE,
                    is_primary INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE project_worktrees (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    root_path TEXT NOT NULL UNIQUE,
                    branch_name TEXT,
                    head_sha TEXT,
                    is_primary INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE recent_projects (
                    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                    last_opened_at TEXT NOT NULL
                );
                CREATE TABLE workspace_sessions (
                    id TEXT PRIMARY KEY,
                    active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                    active_worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL,
                    last_opened_at TEXT NOT NULL
                );
                ",
            )
            .expect("schema");
    }

    fn count_rows(database_path: &std::path::Path, table: &str) -> u64 {
        let connection = Connection::open(database_path).expect("db");
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count rows");
        u64::try_from(count).unwrap_or(0)
    }
}
