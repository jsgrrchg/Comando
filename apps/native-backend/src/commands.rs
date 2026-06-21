use std::collections::HashMap;
use std::env;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;

use comando_ai::AiEngine;
use comando_ai::events::{
    AI_ERROR_EVENT, AI_RUNTIME_STATUS_EVENT, AI_SESSION_CLOSED_EVENT, AI_SESSION_CREATED_EVENT,
    AI_SESSION_UPDATED_EVENT, AiRuntimeEvent, session_closed, session_created, session_updated,
};
use comando_ai::history::{
    AiHistoryMigrationMode, AiHistoryMigrationOptions, AiHistoryMigrator, AiHistoryStore,
    LegacyAiHistoryReader,
};
use comando_ai::runtime_setup::invalidate_grok_auth_on_error;
use comando_fs::{FsError, ProjectFsService, ProjectRoot};
use comando_git::{
    GitBranchListScope, GitError, GitFileDiffRequest, GitRunner, checkout_branch, commit,
    create_branch, create_worktree, delete_local_branch, delete_remote_branch, discard_paths,
    fetch, get_commit_detail, get_diff_stats, get_file_diff, get_original_file,
    get_repository_snapshot, get_status, init_repository, list_branches, list_history,
    list_remotes, list_worktree_diff, list_worktrees, pull, push, remove_worktree,
    resolve_repository, stage_paths, unstage_paths,
};
use comando_index::{
    IndexBuildOptions, IndexEvent, IndexPolicy, IndexService, IndexUpdate, IndexUpdateKind,
    ProjectSearchQuery, SearchMatch, search_project_entries_snapshot,
};
use comando_persistence::{NativeStorageConfig, SqlitePersistenceStore, closed_storage_health};
use comando_projects::{ProjectRegistry, ProjectRegistryError};
use comando_settings::{RuntimeSetupState, RuntimeSetupStore, secret_env_keys_for_runtime};
use comando_terminal::{TerminalRuntimeEvent, TerminalService};
use comando_types::capabilities::{
    BACKEND_NAME, NativeBackendCapabilitiesOutput, NativeBackendHandshakeInput,
    NativeBackendHandshakeOutput, PROTOCOL_VERSION, RUST_VERSION, backend_capabilities,
    bootstrap_capabilities, negotiate_protocol_version,
};
use comando_types::commands::{
    BACKEND_CAPABILITIES, BACKEND_EMIT_TEST_EVENT, BACKEND_HANDSHAKE, BACKEND_PING,
    BACKEND_SHUTDOWN, PERSISTENCE_GET_SNAPSHOT, PERSISTENCE_GET_STORAGE_HEALTH,
    PERSISTENCE_OPEN_STORE, PROJECT_ADD, PROJECT_LIST, PROJECT_SYNC_WORKTREES,
};
use comando_types::error::{NativeError, NativeErrorCode};
use comando_types::events::BACKEND_TEST_EVENT;
use comando_types::ids::{RequestId, RuntimeId};
use comando_types::persistence::{
    NativePersistenceMode, NativePersistenceOpenStoreInput, NativePersistenceSnapshot,
};
use comando_types::projects::{NativeProjectAddInput, NativeProjectState};
use comando_types::{
    ai as native_ai, fs as native_fs, git as native_git, index as native_index,
    projects as native_projects, terminal as native_terminal,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::protocol::{RpcOutput, RpcRequest, error_response, event, response_ok};
use crate::review::{
    NativeReviewCommandOutput, NativeReviewFileBufferInput, NativeReviewFileMutationInput,
    NativeReviewHunkMutationInput, NativeReviewService, NativeReviewSessionInput,
};

#[derive(Debug, Clone, PartialEq)]
pub struct CommandResult {
    pub outputs: Vec<RpcOutput>,
    pub should_shutdown: bool,
}

#[derive(Default)]
pub struct NativeBackend {
    ai_engine: AiEngine,
    ai_event_bridge_started: bool,
    auth_terminal_sessions: Arc<Mutex<HashMap<String, AuthTerminalSession>>>,
    fs_service: ProjectFsService,
    git_runner: GitRunner,
    index_service: IndexService,
    persistence_store: Option<SqlitePersistenceStore>,
    review_service: NativeReviewService,
    runtime_setup_store: Option<RuntimeSetupStore>,
    runtime_setup_store_shared: Arc<Mutex<Option<RuntimeSetupStore>>>,
    terminal_service: Option<TerminalService>,
}

#[derive(Debug, Clone)]
struct AuthTerminalSession {
    runtime_id: String,
    method_id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeGitListBranchesInput {
    scope: native_git::NativeGitRepositoryScope,
    branch_scope: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeGitListRemotesInput {
    scope: native_git::NativeGitRepositoryScope,
    tracking_branch_name: Option<String>,
    ahead_by: Option<i64>,
    behind_by: Option<i64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeGitWorktreeDiffInput {
    scope: native_git::NativeGitRepositoryScope,
    scopes: Option<Vec<String>>,
}

pub fn handle_request(request: RpcRequest) -> CommandResult {
    NativeBackend::default().handle_request(request)
}

impl NativeBackend {
    const AI_EVENT_CHANNEL_CAPACITY: usize = 256;
    const TERMINAL_EVENT_CHANNEL_CAPACITY: usize = 256;

    pub fn handle_request_background(
        &mut self,
        request: RpcRequest,
        background_sender: mpsc::SyncSender<Vec<RpcOutput>>,
    ) -> CommandResult {
        match request.command.as_str() {
            "project_search_entries" | "search_project_entries" => {
                self.spawn_search_project_entries(request, background_sender)
            }
            "terminal_create"
            | "terminal_write"
            | "terminal_resize"
            | "terminal_kill"
            | "terminal_close"
            | "terminal_close_window"
            | "terminal_list" => self.handle_terminal_request(request, background_sender),
            "ai_list_runtimes"
            | "ai_get_runtime_status"
            | "ai_save_runtime_settings"
            | "ai_launch_runtime_auth"
            | "ai_disconnect_runtime_auth"
            | "ai_logout_runtime_auth"
            | "ai_prepare_session"
            | "ai_send_prompt"
            | "ai_cancel_session"
            | "ai_close_session"
            | "ai_respond_permission"
            | "ai_respond_user_input"
            | "ai_set_session_model"
            | "ai_set_session_mode"
            | "ai_set_session_config_option"
            | "ai_rename_session"
            | "ai_list_session_history"
            | "ai_load_session_transcript_page"
            | "ai_load_session_snapshot"
            | "ai_list_session_runtime_mappings"
            | "ai_set_session_pinned"
            | "ai_delete_session"
            | "ai_migrate_session_history"
            | "ai_get_history_storage_health"
            | "ai_capture_review_baseline"
            | "ai_reconcile_tracked_files"
            | "ai_list_tracked_files"
            | "ai_load_review_state"
            | "ai_keep_tracked_file"
            | "ai_reject_tracked_file"
            | "ai_keep_tracked_file_hunks"
            | "ai_reject_tracked_file_hunks"
            | "ai_keep_all_tracked_files"
            | "ai_reject_all_tracked_files"
            | "ai_notify_file_buffer" => {
                if let Err(error) = self.ensure_ai_event_bridge(background_sender.clone()) {
                    return error_only(request.id, error);
                }
                if request.command == "ai_launch_runtime_auth" {
                    self.handle_ai_auth_terminal_request(request, background_sender)
                } else {
                    self.handle_ai_request(request)
                }
            }
            _ => self.handle_request(request),
        }
    }

    pub fn handle_request(&mut self, request: RpcRequest) -> CommandResult {
        let mut result = match request.command.as_str() {
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
            PROJECT_SYNC_WORKTREES => self.sync_project_worktrees(request),
            "project_open" | "project_refresh" => self.refresh_projects(request),
            "project_list_tree_children" => self.list_project_tree_children(request),
            "project_list_entries" => self.list_project_entries(request),
            "project_search_entries" => self.search_project_entries(request),
            "fs_read_file" => self.read_file(request),
            "fs_write_file" => self.write_file(request),
            "fs_create_file" => self.create_file(request),
            "fs_create_directory" => self.create_directory(request),
            "fs_rename_entry" => self.rename_entry(request),
            "fs_delete_entry" => self.delete_entry(request),
            "fs_copy_entries" => self.copy_entries(request),
            "fs_copy_external_entries" => self.copy_external_entries(request),
            "fs_record_external_mutation" => self.record_external_mutation(request),
            "fs_reveal_entry_info" => self.reveal_entry_info(request),
            "fs_watch_start" => self.watch_start(request),
            "fs_watch_stop" => self.watch_stop(request),
            "fs_watch_sync_registry" => self.watch_sync_registry(request),
            "index_rebuild_project" => self.index_rebuild_project(request),
            "index_update_entries" => self.index_update_entries(request),
            "index_get_status" => self.index_get_status(request),
            "index_drop_project" => self.index_drop_project(request),
            "search_project_entries" => self.search_project_entries(request),
            "search_project_content" => self.search_project_content(request),
            "search_cancel" => self.search_cancel(request),
            "git_resolve_repository" => self.git_resolve_repository(request),
            "git_get_repository_snapshot" => self.git_get_repository_snapshot(request),
            "git_get_status" => self.git_get_status(request),
            "git_get_diff" => self.git_get_diff(request),
            "git_get_file_diff" => self.git_get_file_diff(request),
            "git_get_original_file" => self.git_get_original_file(request),
            "git_get_history" => self.git_get_history(request),
            "git_get_commit_detail" => self.git_get_commit_detail(request),
            "git_list_branches" => self.git_list_branches(request),
            "git_list_worktrees" => self.git_list_worktrees(request),
            "git_list_remotes" => self.git_list_remotes(request),
            "git_get_diff_stats" => self.git_get_diff_stats(request),
            "git_list_worktree_diff" => self.git_list_worktree_diff(request),
            "git_init_repository" => self.git_init_repository(request),
            "git_stage_paths" => self.git_stage_paths(request),
            "git_unstage_paths" => self.git_unstage_paths(request),
            "git_discard_paths" => self.git_discard_paths(request),
            "git_commit" => self.git_commit(request),
            "git_checkout_branch" => self.git_checkout_branch(request),
            "git_create_branch" => self.git_create_branch(request),
            "git_delete_local_branch" => self.git_delete_local_branch(request),
            "git_create_worktree" => self.git_create_worktree(request),
            "git_remove_worktree" => self.git_remove_worktree(request),
            "git_fetch" => self.git_fetch(request),
            "git_pull" => self.git_pull(request),
            "git_push" => self.git_push(request),
            "git_delete_remote_branch" => self.git_delete_remote_branch(request),
            "ai_list_runtimes"
            | "ai_get_runtime_status"
            | "ai_save_runtime_settings"
            | "ai_disconnect_runtime_auth"
            | "ai_logout_runtime_auth"
            | "ai_prepare_session"
            | "ai_send_prompt"
            | "ai_cancel_session"
            | "ai_close_session"
            | "ai_respond_permission"
            | "ai_respond_user_input"
            | "ai_set_session_model"
            | "ai_set_session_mode"
            | "ai_set_session_config_option"
            | "ai_rename_session"
            | "ai_list_session_history"
            | "ai_load_session_transcript_page"
            | "ai_load_session_snapshot"
            | "ai_list_session_runtime_mappings"
            | "ai_set_session_pinned"
            | "ai_delete_session"
            | "ai_migrate_session_history"
            | "ai_get_history_storage_health"
            | "ai_capture_review_baseline"
            | "ai_reconcile_tracked_files"
            | "ai_list_tracked_files"
            | "ai_load_review_state"
            | "ai_keep_tracked_file"
            | "ai_reject_tracked_file"
            | "ai_keep_tracked_file_hunks"
            | "ai_reject_tracked_file_hunks"
            | "ai_keep_all_tracked_files"
            | "ai_reject_all_tracked_files"
            | "ai_notify_file_buffer" => self.handle_ai_request(request),
            "secret_status" => self.secret_status(request),
            "secret_set" => self.secret_set(request),
            "secret_delete" => self.secret_delete(request),
            #[cfg(test)]
            "backend_queue_test_fs_event" => self.queue_test_fs_event(request),
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
        };

        result
            .outputs
            .extend(self.drain_fs_events(result.should_shutdown));
        result
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
                let history_store = match AiHistoryStore::new(store.app_data_dir().to_path_buf()) {
                    Ok(history_store) => Some(history_store),
                    Err(error) => return error_only(request.id, error.to_native_error()),
                };
                if let Err(error) = self.ai_engine.set_history_store(history_store) {
                    return error_only(request.id, error.to_native_error());
                }
                let runtime_setup_store = RuntimeSetupStore::new(
                    store.app_data_dir().join("ai").join("runtime-setup.json"),
                );
                if let Err(error) = self
                    .ai_engine
                    .set_runtime_setup_store(Some(runtime_setup_store.clone()))
                {
                    return error_only(request.id, error.to_native_error());
                }
                self.review_service
                    .set_app_data_dir(store.app_data_dir().to_path_buf());
                if let Ok(mut shared_store) = self.runtime_setup_store_shared.lock() {
                    *shared_store = Some(runtime_setup_store.clone());
                }
                self.runtime_setup_store = Some(runtime_setup_store);
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

    fn secret_status(&mut self, request: RpcRequest) -> CommandResult {
        let Some(store) = self.runtime_setup_store.as_ref() else {
            return backend_not_ready(request.id);
        };
        response_only(
            request.id,
            serde_json::to_value(store.secrets().status()).expect("secret status serializes"),
        )
    }

    fn secret_set(&mut self, request: RpcRequest) -> CommandResult {
        let Some(store) = self.runtime_setup_store.as_ref() else {
            return backend_not_ready(request.id);
        };
        let input = match parse_args::<native_ai::NativeSecretSetInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let value = input.value.trim().to_string();
        let present = !value.is_empty();
        let result = if present {
            store.set_secret(&input.runtime_id.0, &input.env_key, &value)
        } else {
            store.delete_secret(&input.runtime_id.0, &input.env_key)
        };
        match result {
            Ok(()) => response_only(
                request.id,
                serde_json::to_value(native_ai::NativeSecretMutationOutput {
                    runtime_id: input.runtime_id,
                    env_key: input.env_key,
                    present,
                })
                .expect("secret set output serializes"),
            ),
            Err(error) => error_only(request.id, runtime_setup_native_error(error.to_string())),
        }
    }

    fn secret_delete(&mut self, request: RpcRequest) -> CommandResult {
        let Some(store) = self.runtime_setup_store.as_ref() else {
            return backend_not_ready(request.id);
        };
        let input = match parse_args::<native_ai::NativeSecretDeleteInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        match store.delete_secret(&input.runtime_id.0, &input.env_key) {
            Ok(()) => response_only(
                request.id,
                serde_json::to_value(native_ai::NativeSecretMutationOutput {
                    runtime_id: input.runtime_id,
                    env_key: input.env_key,
                    present: false,
                })
                .expect("secret delete output serializes"),
            ),
            Err(error) => error_only(request.id, runtime_setup_native_error(error.to_string())),
        }
    }

    fn ai_save_runtime_settings(&mut self, request: RpcRequest) -> CommandResult {
        let Some(store) = self.runtime_setup_store.clone() else {
            return backend_not_ready(request.id);
        };
        let input = match parse_args::<native_ai::NativeAiSaveRuntimeSettingsInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let runtime_id = input.runtime_id.0.clone();
        let result = apply_runtime_settings(&store, input)
            .and_then(|_| self.runtime_status_output(&runtime_id));
        match result {
            Ok(status) => runtime_status_response(request.id, status),
            Err(error) => error_only(request.id, error),
        }
    }

    fn ai_disconnect_runtime_auth(&mut self, request: RpcRequest) -> CommandResult {
        let Some(store) = self.runtime_setup_store.clone() else {
            return backend_not_ready(request.id);
        };
        let input = match parse_args::<native_ai::NativeAiRuntimeAuthInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let runtime_id = input.runtime_id.0.clone();
        let result = disconnect_runtime_auth(&store, &runtime_id)
            .and_then(|_| self.runtime_status_output(&runtime_id));
        match result {
            Ok(status) => runtime_status_response(request.id, status),
            Err(error) => error_only(request.id, error),
        }
    }

    fn ai_logout_runtime_auth(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<native_ai::NativeAiRuntimeAuthInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let message = if input.runtime_id.0 == "codex" {
            "Codex ChatGPT logout requires the legacy ACP logout flow until native logout reaches parity."
        } else {
            "This runtime does not support native logout yet."
        };
        error_only(
            request.id,
            NativeError::new(NativeErrorCode::NotSupported, message),
        )
    }

    fn handle_ai_auth_terminal_request(
        &mut self,
        request: RpcRequest,
        background_sender: mpsc::SyncSender<Vec<RpcOutput>>,
    ) -> CommandResult {
        let Some(store) = self.runtime_setup_store.clone() else {
            return backend_not_ready(request.id);
        };
        let input = match parse_args::<native_ai::NativeAiLaunchRuntimeAuthInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let runtime_id = input.runtime_id.0.clone();
        let method_id = input.method_id.clone();
        let launch = match self
            .ai_engine
            .prepare_auth_terminal_launch(&runtime_id, &method_id)
        {
            Ok(launch) => launch,
            Err(error) => return error_only(request.id, error.to_native_error()),
        };
        let cwd = input.cwd.clone().or_else(|| {
            self.resolve_auth_terminal_cwd(input.project_id.as_ref(), input.worktree_id.as_ref())
        });
        let terminal_input = native_terminal::NativeTerminalCreateInput {
            window_id: input.window_id.clone(),
            terminal_id: None,
            preferred_session_id: None,
            project_id: input.project_id.clone(),
            worktree_id: input.worktree_id.clone(),
            cwd,
            cols: input.cols,
            rows: input.rows,
            extra_env: launch.env.into_iter().collect(),
            shell_preference: None,
            purpose: native_terminal::NativeTerminalPurpose::Auth,
            launched_by: native_terminal::NativeTerminalLaunchedBy::System,
            launch: native_terminal::NativeTerminalLaunch::Command {
                program: launch.program,
                args: launch.args,
                display_name: Some(format!("{runtime_id} auth")),
            },
        };
        let session = match self
            .ensure_terminal_service(background_sender)
            .create_session(terminal_input)
        {
            Ok(session) => session,
            Err(error) => return error_only(request.id, error.to_native_error()),
        };
        if let Err(error) = store.update_runtime(&runtime_id, |state| {
            state.auth_method = Some(method_id.clone());
            state.auth_invalidated_at_ms = Some(now_ms());
        }) {
            return error_only(request.id, runtime_setup_native_error(error.to_string()));
        }
        if let Ok(mut sessions) = self.auth_terminal_sessions.lock() {
            sessions.insert(
                session.session_id.0.clone(),
                AuthTerminalSession {
                    runtime_id: runtime_id.clone(),
                    method_id: method_id.clone(),
                },
            );
        }
        let status = match self.runtime_status_output(&runtime_id) {
            Ok(status) => status,
            Err(error) => return error_only(request.id, error),
        };
        CommandResult {
            outputs: vec![
                response_ok(
                    request.id,
                    serde_json::to_value(native_ai::NativeAiLaunchRuntimeAuthOutput {
                        runtime_id: input.runtime_id,
                        method_id: input.method_id,
                        terminal_session_id: Some(session.session_id.clone()),
                        status: status.clone(),
                    })
                    .expect("ai auth launch output serializes"),
                ),
                event(
                    AI_RUNTIME_STATUS_EVENT,
                    serde_json::to_value(&status).expect("ai runtime status event serializes"),
                ),
                event(
                    "ai://auth-terminal-started",
                    json!({
                        "runtimeId": runtime_id,
                        "methodId": method_id,
                        "terminalSessionId": session.session_id.0,
                    }),
                ),
            ],
            should_shutdown: false,
        }
    }

    fn runtime_status_output(
        &self,
        runtime_id: &str,
    ) -> Result<native_ai::NativeAiRuntimeStatus, NativeError> {
        self.ai_engine
            .get_runtime_status(native_ai::NativeAiGetRuntimeStatusInput {
                runtime_id: comando_types::ids::RuntimeId(runtime_id.to_string()),
                launch: None,
            })
            .map_err(|error| error.to_native_error())
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
                self.fs_service.sync_state(result.state.clone());
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

    fn sync_project_worktrees(&mut self, request: RpcRequest) -> CommandResult {
        let Some(store) = self.persistence_store.as_mut() else {
            return backend_not_ready(request.id);
        };
        if !matches!(store.mode(), NativePersistenceMode::Write) {
            return error_only(
                request.id,
                NativeError::new(
                    NativeErrorCode::PermissionDenied,
                    "Native project_sync_worktrees requires project registry write mode.",
                ),
            );
        }
        let input = match serde_json::from_value::<native_projects::NativeProjectSyncWorktreesInput>(
            request.args.clone(),
        ) {
            Ok(input) => input,
            Err(error) => {
                return error_only(
                    request.id,
                    NativeError::new(
                        NativeErrorCode::InvalidArgs,
                        format!("Invalid project_sync_worktrees args: {error}"),
                    ),
                );
            }
        };

        let mut registry = ProjectRegistry::new(store.connection_mut());
        match registry.sync_project_worktrees(&input.project_id, &input.worktrees) {
            Ok(worktrees) => {
                if let Ok(state) = registry.list_projects() {
                    self.fs_service.sync_state(NativeProjectState {
                        projects: state.projects,
                        worktrees: state.worktrees,
                    });
                }
                response_only(
                    request.id,
                    serde_json::to_value(worktrees).expect("project worktrees serialize"),
                )
            }
            Err(error) => error_only(request.id, project_error(error)),
        }
    }

    fn refresh_projects(&mut self, request: RpcRequest) -> CommandResult {
        match self.sync_fs_registry_from_store() {
            Ok(state) => response_only(
                request.id,
                serde_json::to_value(state).expect("project state serializes"),
            ),
            Err(error) => error_only(request.id, error),
        }
    }

    fn list_project_tree_children(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_projects::NativeProjectTreeChildrenInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        match self.fs_service.list_tree_children(&input) {
            Ok(result) => response_only(
                request.id,
                serde_json::to_value(result).expect("tree children serializes"),
            ),
            Err(error) => error_only(request.id, fs_error(error)),
        }
    }

    fn list_project_entries(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_projects::NativeProjectListEntriesInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let root = match self
            .fs_service
            .resolve_root(&input.project_id, input.worktree_id.as_ref())
        {
            Ok(root) => root,
            Err(error) => return error_only(request.id, fs_error(error)),
        };

        match self.index_service.list_project_entries(root) {
            Ok((mut entries, events)) => {
                let truncated = input.limit.is_some_and(|limit| entries.len() > limit);
                if let Some(limit) = input.limit {
                    entries.truncate(limit);
                }
                let mut outputs = vec![response_ok(
                    request.id,
                    serde_json::to_value(native_projects::NativeProjectListEntriesResult {
                        entries,
                        truncated,
                    })
                    .expect("project entries serializes"),
                )];
                outputs.extend(index_event_outputs(events));
                CommandResult {
                    outputs,
                    should_shutdown: false,
                }
            }
            Err(error) => error_only(request.id, error.to_native_error()),
        }
    }

    fn read_file(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_fs::NativeFsReadFileInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        match self.fs_service.read_file(&input) {
            Ok(result) => response_only(
                request.id,
                serde_json::to_value(result).expect("read file serializes"),
            ),
            Err(error) => error_only(request.id, fs_error(error)),
        }
    }

    fn write_file(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_fs::NativeFsWriteFileInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let relative_path = input.relative_path.clone();
        let project_id = input.project_id.clone();
        let worktree_id = input.worktree_id.clone();

        match self.fs_service.write_file(&input) {
            Ok(result) => {
                let mut outputs = vec![response_ok(
                    request.id,
                    serde_json::to_value(result).expect("write file serializes"),
                )];
                outputs.push(tree_invalidation_event(
                    project_id,
                    worktree_id,
                    vec![relative_path],
                ));
                CommandResult {
                    outputs,
                    should_shutdown: false,
                }
            }
            Err(error) => error_only(request.id, fs_error(error)),
        }
    }

    fn create_file(&mut self, request: RpcRequest) -> CommandResult {
        self.create_entry(request, true)
    }

    fn create_directory(&mut self, request: RpcRequest) -> CommandResult {
        self.create_entry(request, false)
    }

    fn create_entry(&mut self, request: RpcRequest, file: bool) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_fs::NativeFsCreateEntryInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        let result = if file {
            self.fs_service.create_file(&input)
        } else {
            self.fs_service.create_directory(&input)
        };
        match result {
            Ok(result) => mutation_response(request.id, result),
            Err(error) => error_only(request.id, fs_error(error)),
        }
    }

    fn rename_entry(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_fs::NativeFsRenameEntryInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let old_path = input.relative_path.clone();

        match self.fs_service.rename_entry(&input) {
            Ok(result) => {
                let mut outputs = mutation_outputs(request.id, &result);
                outputs.push(tree_invalidation_event(
                    input.project_id,
                    input.worktree_id,
                    vec![old_path, result.relative_path.clone()],
                ));
                CommandResult {
                    outputs,
                    should_shutdown: false,
                }
            }
            Err(error) => error_only(request.id, fs_error(error)),
        }
    }

    fn delete_entry(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_fs::NativeFsDeleteEntryInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        match self.fs_service.delete_entry(&input) {
            Ok(result) => {
                let mut outputs = mutation_outputs(request.id, &result);
                outputs.push(tree_invalidation_event(
                    input.project_id,
                    input.worktree_id,
                    vec![input.relative_path],
                ));
                CommandResult {
                    outputs,
                    should_shutdown: false,
                }
            }
            Err(error) => error_only(request.id, fs_error(error)),
        }
    }

    fn copy_entries(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_fs::NativeFsCopyEntriesInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        match self.fs_service.copy_entries(&input) {
            Ok(result) => {
                mutation_list_response(request.id, input.project_id, input.worktree_id, result)
            }
            Err(error) => error_only(request.id, fs_error(error)),
        }
    }

    fn copy_external_entries(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_fs::NativeFsCopyExternalEntriesInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        match self.fs_service.copy_external_entries(&input) {
            Ok(result) => {
                mutation_list_response(request.id, input.project_id, input.worktree_id, result)
            }
            Err(error) => error_only(request.id, fs_error(error)),
        }
    }

    fn record_external_mutation(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<native_fs::NativeFsRecordExternalMutationInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        CommandResult {
            outputs: vec![
                response_ok(request.id, json!({"recorded": true})),
                tree_invalidation_event(input.project_id, input.worktree_id, input.relative_paths),
            ],
            should_shutdown: false,
        }
    }

    fn reveal_entry_info(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_fs::NativeFsRevealEntryInfoInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let root = match self
            .fs_service
            .resolve_root(&input.project_id, input.worktree_id.as_ref())
        {
            Ok(root) => root,
            Err(error) => return error_only(request.id, fs_error(error)),
        };
        let path = match comando_fs::path::resolve_scoped_path(
            &root.root_path,
            input.relative_path.as_ref().map(|path| path.0.as_str()),
            true,
            comando_fs::path::ScopedPathIntent::CreateTarget,
        ) {
            Ok(path) => path,
            Err(error) => return error_only(request.id, fs_error(error)),
        };
        let metadata = std::fs::metadata(&path.absolute_path);
        let kind = metadata
            .as_ref()
            .map(|metadata| {
                if metadata.is_dir() {
                    native_fs::NativeFsEntryKind::Directory
                } else if metadata.is_file() {
                    native_fs::NativeFsEntryKind::File
                } else {
                    native_fs::NativeFsEntryKind::Other
                }
            })
            .unwrap_or(native_fs::NativeFsEntryKind::Other);

        response_only(
            request.id,
            serde_json::to_value(native_fs::NativeFsRevealEntryInfoResult {
                project_id: input.project_id,
                worktree_id: input.worktree_id,
                path: path.absolute_path.to_string_lossy().to_string(),
                relative_path: input.relative_path,
                exists: metadata.is_ok(),
                kind,
            })
            .expect("reveal entry info serializes"),
        )
    }

    fn watch_start(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_fs::NativeFsWatchInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let root = match self
            .fs_service
            .resolve_root(&input.project_id, input.worktree_id.as_ref())
        {
            Ok(root) => root,
            Err(error) => return error_only(request.id, fs_error(error)),
        };
        match self.fs_service.watcher_mut().start(root) {
            Ok(()) => CommandResult {
                outputs: vec![
                    response_ok(request.id, json!({"started": true})),
                    event(
                        "fs://watch-started",
                        json!({
                            "projectId": input.project_id.0,
                            "worktreeId": input.worktree_id.map(|id| id.0),
                        }),
                    ),
                ],
                should_shutdown: false,
            },
            Err(error) => error_only(request.id, fs_error(error)),
        }
    }

    fn watch_stop(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_fs::NativeFsWatchInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let root = match self
            .fs_service
            .resolve_root(&input.project_id, input.worktree_id.as_ref())
        {
            Ok(root) => root,
            Err(error) => return error_only(request.id, fs_error(error)),
        };
        self.fs_service.watcher_mut().stop(&root);
        CommandResult {
            outputs: vec![
                response_ok(request.id, json!({"stopped": true})),
                event(
                    "fs://watch-stopped",
                    json!({
                        "projectId": input.project_id.0,
                        "worktreeId": input.worktree_id.map(|id| id.0),
                    }),
                ),
            ],
            should_shutdown: false,
        }
    }

    fn watch_sync_registry(&mut self, request: RpcRequest) -> CommandResult {
        let state = if request
            .args
            .as_object()
            .is_some_and(|args| args.contains_key("projects"))
        {
            match parse_args::<native_fs::NativeFsWatchSyncRegistryInput>(&request) {
                Ok(input) => NativeProjectState {
                    projects: input.projects,
                    worktrees: input.worktrees,
                },
                Err(error) => return error_only(request.id, error),
            }
        } else {
            match self.load_project_state_from_store() {
                Ok(state) => state,
                Err(error) => return error_only(request.id, error),
            }
        };

        self.fs_service.sync_state(state);
        match self.fs_service.sync_watchers_from_registry() {
            Ok(()) => response_only(request.id, json!({"synced": true})),
            Err(error) => error_only(request.id, fs_error(error)),
        }
    }

    fn index_rebuild_project(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_index::NativeIndexRebuildProjectInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let root = match self.resolve_index_root(&input.project_id, input.worktree_id.as_ref()) {
            Ok(root) => root,
            Err(error) => return error_only(request.id, error),
        };

        let rebuild_result = match input.policy.as_ref() {
            Some(policy) => self
                .index_service
                .rebuild_project_with_options(root, native_index_policy(policy)),
            None => self.index_service.rebuild_project(root),
        };

        match rebuild_result {
            Ok((entries, events)) => {
                let status = self
                    .index_service
                    .get_status(&input.project_id, input.worktree_id.as_ref());
                let mut outputs = vec![response_ok(
                    request.id,
                    serde_json::to_value(native_index::NativeIndexRebuildProjectResult {
                        status: native_index_status(status),
                        entries: entries.into_iter().map(Into::into).collect(),
                    })
                    .expect("index rebuild result serializes"),
                )];
                outputs.extend(index_event_outputs(events));
                CommandResult {
                    outputs,
                    should_shutdown: false,
                }
            }
            Err(error) => error_only(request.id, error.to_native_error()),
        }
    }

    fn index_update_entries(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_index::NativeIndexUpdateEntriesInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let root = match self.resolve_index_root(&input.project_id, input.worktree_id.as_ref()) {
            Ok(root) => root,
            Err(error) => return error_only(request.id, error),
        };
        let update = native_index_update(input.kind, input.relative_paths.clone());

        match self.index_service.update_entries(root, update) {
            Ok(events) => {
                let status = self
                    .index_service
                    .get_status(&input.project_id, input.worktree_id.as_ref());
                let mut outputs = vec![response_ok(
                    request.id,
                    serde_json::to_value(native_index::NativeIndexUpdateEntriesResult {
                        status: native_index_status(status),
                    })
                    .expect("index update result serializes"),
                )];
                outputs.extend(index_event_outputs(events));
                CommandResult {
                    outputs,
                    should_shutdown: false,
                }
            }
            Err(error) => error_only(request.id, error.to_native_error()),
        }
    }

    fn index_get_status(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<native_index::NativeIndexStatusInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        response_only(
            request.id,
            serde_json::to_value(native_index_status(
                self.index_service
                    .get_status(&input.project_id, input.worktree_id.as_ref()),
            ))
            .expect("index status serializes"),
        )
    }

    fn index_drop_project(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<native_index::NativeIndexDropProjectInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        response_only(
            request.id,
            serde_json::to_value(native_index::NativeIndexDropProjectResult {
                dropped: self
                    .index_service
                    .drop_project(&input.project_id, input.worktree_id.as_ref()),
            })
            .expect("index drop result serializes"),
        )
    }

    fn search_project_entries(&mut self, request: RpcRequest) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_index::NativeProjectEntrySearchInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let root = match self.resolve_index_root(&input.project_id, input.worktree_id.as_ref()) {
            Ok(root) => root,
            Err(error) => return error_only(request.id, error),
        };
        let query = ProjectSearchQuery::new(&input.query);
        let limit = input.limit.max(1) as usize;

        match self.index_service.search_project_entries(
            root,
            &query,
            limit,
            input.include_ancestor_directories,
            input.context_key.as_deref(),
        ) {
            Ok((entries, matches, operation_id, events)) => {
                let status = self
                    .index_service
                    .get_status(&input.project_id, input.worktree_id.as_ref());
                let mut outputs = vec![response_ok(
                    request.id,
                    serde_json::to_value(native_index::NativeProjectEntrySearchResult {
                        operation_id,
                        generation: status.generation,
                        status: native_index_status_kind(status.status),
                        entries: entries.into_iter().map(indexed_project_entry).collect(),
                        matches: path_search_matches(matches),
                        stats: native_index_stats(status.stats),
                    })
                    .expect("project entry search result serializes"),
                )];
                outputs.extend(index_event_outputs(events));
                CommandResult {
                    outputs,
                    should_shutdown: false,
                }
            }
            Err(error) => error_only(request.id, error.to_native_error()),
        }
    }

    fn spawn_search_project_entries(
        &mut self,
        request: RpcRequest,
        background_sender: mpsc::SyncSender<Vec<RpcOutput>>,
    ) -> CommandResult {
        if let Err(error) = self.sync_fs_registry_from_store().map(|_| ()) {
            return error_only(request.id, error);
        }
        let input = match parse_args::<native_index::NativeProjectEntrySearchInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let root = match self.resolve_index_root(&input.project_id, input.worktree_id.as_ref()) {
            Ok(root) => root,
            Err(error) => return error_only(request.id, error),
        };
        let query = ProjectSearchQuery::new(&input.query);
        let limit = input.limit.max(1) as usize;
        if query.is_empty() {
            return match self.index_service.search_project_entries(
                root,
                &query,
                limit,
                input.include_ancestor_directories,
                input.context_key.as_deref(),
            ) {
                Ok((entries, matches, operation_id, events)) => {
                    let status = self
                        .index_service
                        .get_status(&input.project_id, input.worktree_id.as_ref());
                    let mut outputs = vec![response_ok(
                        request.id,
                        serde_json::to_value(native_index::NativeProjectEntrySearchResult {
                            operation_id,
                            generation: status.generation,
                            status: native_index_status_kind(status.status),
                            entries: entries.into_iter().map(indexed_project_entry).collect(),
                            matches: path_search_matches(matches),
                            stats: native_index_stats(status.stats),
                        })
                        .expect("project entry search result serializes"),
                    )];
                    outputs.extend(index_event_outputs(events));
                    CommandResult {
                        outputs,
                        should_shutdown: false,
                    }
                }
                Err(error) => error_only(request.id, error.to_native_error()),
            };
        }
        let events = match self.index_service.ensure_project_index(root.clone()) {
            Ok(events) => events,
            Err(error) => return error_only(request.id, error.to_native_error()),
        };
        let snapshot = match self.index_service.search_snapshot_for_root(&root) {
            Ok(snapshot) => snapshot,
            Err(error) => return error_only(request.id, error.to_native_error()),
        };
        let operation_id = self
            .index_service
            .begin_search_operation(input.context_key.as_deref());
        let operation = self.index_service.search_operation(operation_id.clone());
        let request_id = request.id;
        let include_ancestor_directories = input.include_ancestor_directories;

        thread::spawn(move || {
            let outputs = match search_project_entries_snapshot(
                &snapshot,
                &query,
                limit,
                include_ancestor_directories,
                operation,
            ) {
                Ok((entries, matches)) => vec![response_ok(
                    request_id,
                    serde_json::to_value(native_index::NativeProjectEntrySearchResult {
                        operation_id,
                        generation: snapshot.generation,
                        status: native_index_status_kind(snapshot.status),
                        entries: entries.into_iter().map(indexed_project_entry).collect(),
                        matches: path_search_matches(matches),
                        stats: native_index_stats(snapshot.stats),
                    })
                    .expect("project entry search result serializes"),
                )],
                Err(error) => vec![error_response(Some(request_id), error.to_native_error())],
            };
            let _ = background_sender.send(outputs);
        });

        CommandResult {
            outputs: index_event_outputs(events),
            should_shutdown: false,
        }
    }

    fn handle_terminal_request(
        &mut self,
        request: RpcRequest,
        background_sender: mpsc::SyncSender<Vec<RpcOutput>>,
    ) -> CommandResult {
        let command = request.command.clone();
        match command.as_str() {
            "terminal_create" => {
                let input = match parse_args::<native_terminal::NativeTerminalCreateInput>(&request)
                {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self
                    .ensure_terminal_service(background_sender)
                    .create_session(input)
                {
                    Ok(session) => response_only(
                        request.id,
                        serde_json::to_value(session).expect("terminal session serializes"),
                    ),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "terminal_write" => {
                let input = match parse_args::<native_terminal::NativeTerminalWriteInput>(&request)
                {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self
                    .ensure_terminal_service(background_sender)
                    .write_input(input)
                {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "terminal_resize" => {
                let input = match parse_args::<native_terminal::NativeTerminalResizeInput>(&request)
                {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self
                    .ensure_terminal_service(background_sender)
                    .resize_session(input)
                {
                    Ok(Some(session)) => response_only(
                        request.id,
                        serde_json::to_value(session).expect("terminal session serializes"),
                    ),
                    Ok(None) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "terminal_kill" => {
                let input = match parse_args::<native_terminal::NativeTerminalKillInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self
                    .ensure_terminal_service(background_sender)
                    .kill_session(input)
                {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "terminal_close" => {
                let input = match parse_args::<native_terminal::NativeTerminalCloseInput>(&request)
                {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self
                    .ensure_terminal_service(background_sender)
                    .close_session(input)
                {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "terminal_close_window" => {
                let input =
                    match parse_args::<native_terminal::NativeTerminalCloseWindowInput>(&request) {
                        Ok(input) => input,
                        Err(error) => return error_only(request.id, error),
                    };
                match self
                    .ensure_terminal_service(background_sender)
                    .close_window(input)
                {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "terminal_list" => {
                let input = match parse_args::<native_terminal::NativeTerminalListInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self
                    .ensure_terminal_service(background_sender)
                    .list_sessions(input)
                {
                    Ok(result) => response_only(
                        request.id,
                        serde_json::to_value(result).expect("terminal list serializes"),
                    ),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            _ => CommandResult {
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

    fn handle_ai_request(&mut self, request: RpcRequest) -> CommandResult {
        match request.command.as_str() {
            "ai_list_runtimes" => response_only(
                request.id,
                serde_json::to_value(self.ai_engine.list_runtimes())
                    .expect("ai list runtimes output serializes"),
            ),
            "ai_get_runtime_status" => {
                let input = match parse_args::<native_ai::NativeAiGetRuntimeStatusInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.ai_engine.get_runtime_status(input) {
                    Ok(status) => CommandResult {
                        outputs: vec![
                            response_ok(
                                request.id,
                                serde_json::to_value(&status)
                                    .expect("ai runtime status serializes"),
                            ),
                            event(
                                AI_RUNTIME_STATUS_EVENT,
                                serde_json::to_value(status)
                                    .expect("ai runtime status event serializes"),
                            ),
                        ],
                        should_shutdown: false,
                    },
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "ai_save_runtime_settings" => self.ai_save_runtime_settings(request),
            "ai_disconnect_runtime_auth" => self.ai_disconnect_runtime_auth(request),
            "ai_logout_runtime_auth" => self.ai_logout_runtime_auth(request),
            "ai_prepare_session" => {
                let input = match parse_args::<native_ai::NativeAiPrepareSessionInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.ai_engine.prepare_session(input) {
                    Ok(summary) => CommandResult {
                        outputs: vec![
                            response_ok(
                                request.id,
                                serde_json::to_value(&summary)
                                    .expect("ai prepare output serializes"),
                            ),
                            event(
                                AI_SESSION_CREATED_EVENT,
                                serde_json::to_value(session_created(summary.clone()))
                                    .expect("ai session created event serializes"),
                            ),
                            event(
                                AI_SESSION_UPDATED_EVENT,
                                serde_json::to_value(session_updated(&summary))
                                    .expect("ai session updated event serializes"),
                            ),
                        ],
                        should_shutdown: false,
                    },
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "ai_send_prompt" => {
                let input = match parse_args::<native_ai::NativeAiSendPromptInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.ai_engine.send_prompt(input) {
                    Ok((output, summary)) => CommandResult {
                        outputs: vec![
                            response_ok(
                                request.id,
                                serde_json::to_value(output)
                                    .expect("ai send prompt output serializes"),
                            ),
                            event(
                                AI_SESSION_UPDATED_EVENT,
                                serde_json::to_value(session_updated(&summary))
                                    .expect("ai session updated event serializes"),
                            ),
                        ],
                        should_shutdown: false,
                    },
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "ai_cancel_session" => {
                let input = match parse_args::<native_ai::NativeAiSessionIdInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.ai_engine.cancel_session(input) {
                    Ok((output, summary)) => CommandResult {
                        outputs: vec![
                            response_ok(
                                request.id,
                                serde_json::to_value(output).expect("ai cancel output serializes"),
                            ),
                            event(
                                AI_SESSION_UPDATED_EVENT,
                                serde_json::to_value(session_updated(&summary))
                                    .expect("ai session updated event serializes"),
                            ),
                        ],
                        should_shutdown: false,
                    },
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "ai_close_session" => {
                let input = match parse_args::<native_ai::NativeAiSessionIdInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.ai_engine.close_session(input) {
                    Ok((output, summary)) => CommandResult {
                        outputs: vec![
                            response_ok(
                                request.id,
                                serde_json::to_value(output).expect("ai close output serializes"),
                            ),
                            event(
                                AI_SESSION_CLOSED_EVENT,
                                serde_json::to_value(session_closed(&summary))
                                    .expect("ai session closed event serializes"),
                            ),
                        ],
                        should_shutdown: false,
                    },
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "ai_set_session_mode" => {
                let input = match parse_args::<native_ai::NativeAiSetSessionModeInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.ai_engine.set_session_mode(input) {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "ai_set_session_model" => {
                let input = match parse_args::<native_ai::NativeAiSetSessionModelInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.ai_engine.set_session_model(input) {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "ai_set_session_config_option" => {
                let input =
                    match parse_args::<native_ai::NativeAiSetSessionConfigOptionInput>(&request) {
                        Ok(input) => input,
                        Err(error) => return error_only(request.id, error),
                    };
                match self.ai_engine.set_session_config_option(input) {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "ai_list_session_history" => {
                let input = match parse_args::<native_ai::NativeAiListSessionHistoryInput>(&request)
                {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.list_ai_session_history(input) {
                    Ok(history) => response_only(
                        request.id,
                        serde_json::to_value(history).expect("ai history list serializes"),
                    ),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_load_session_transcript_page" => {
                let input =
                    match parse_args::<native_ai::NativeAiLoadSessionTranscriptPageInput>(&request)
                    {
                        Ok(input) => input,
                        Err(error) => return error_only(request.id, error),
                    };
                match self.load_ai_session_transcript_page(input) {
                    Ok(page) => response_only(
                        request.id,
                        serde_json::to_value(page).expect("ai transcript page serializes"),
                    ),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_load_session_snapshot" => {
                let input =
                    match parse_args::<native_ai::NativeAiLoadSessionSnapshotInput>(&request) {
                        Ok(input) => input,
                        Err(error) => return error_only(request.id, error),
                    };
                match self.load_ai_session_snapshot(input.session_id) {
                    Ok(snapshot) => response_only(
                        request.id,
                        serde_json::to_value(snapshot).expect("ai snapshot serializes"),
                    ),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_list_session_runtime_mappings" => {
                let input = match parse_args::<native_ai::NativeAiListSessionRuntimeMappingsInput>(
                    &request,
                ) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.list_ai_session_runtime_mappings(input.parent_session_id) {
                    Ok(mappings) => response_only(
                        request.id,
                        serde_json::to_value(mappings).expect("ai runtime mappings serialize"),
                    ),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_set_session_pinned" => {
                let input = match parse_args::<native_ai::NativeAiSetSessionPinnedInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.set_ai_session_pinned(input) {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_delete_session" => {
                let input = match parse_args::<native_ai::NativeAiDeleteSessionInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.delete_ai_session(input.session_id) {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_rename_session" => {
                let input = match parse_args::<native_ai::NativeAiRenameSessionInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.rename_ai_session(input) {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_migrate_session_history" => {
                let input =
                    match parse_args::<native_ai::NativeAiMigrateSessionHistoryInput>(&request) {
                        Ok(input) => input,
                        Err(error) => return error_only(request.id, error),
                    };
                match self.migrate_ai_session_history(input) {
                    Ok(output) => response_only(
                        request.id,
                        serde_json::to_value(output).expect("ai history migration serializes"),
                    ),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_get_history_storage_health" => match self.get_ai_history_storage_health() {
                Ok(health) => response_only(
                    request.id,
                    serde_json::to_value(health).expect("ai history health serializes"),
                ),
                Err(error) => error_only(request.id, error),
            },
            "ai_capture_review_baseline" => {
                let input = match parse_args::<NativeReviewSessionInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                let session = match self.ai_engine.session_for_review(&input.session_id) {
                    Ok(session) => session,
                    Err(error) => return error_only(request.id, error.to_native_error()),
                };
                match self.review_service.capture_baseline(&session) {
                    Ok(output) => response_only(
                        request.id,
                        serde_json::to_value(output).expect("review baseline output serializes"),
                    ),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_reconcile_tracked_files" => {
                let input = match parse_args::<NativeReviewSessionInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                let session = match self.ai_engine.session_for_review(&input.session_id) {
                    Ok(session) => session,
                    Err(error) => return error_only(request.id, error.to_native_error()),
                };
                match self.review_service.reconcile_tracked_files(&session) {
                    Ok(output) => self.review_response(request.id, &session, output),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_list_tracked_files" | "ai_load_review_state" => {
                let input = match parse_args::<NativeReviewSessionInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                let session = match self.ai_engine.session_for_review(&input.session_id) {
                    Ok(session) => session,
                    Err(error) => return error_only(request.id, error.to_native_error()),
                };
                match self.review_service.list_tracked_files(&session) {
                    Ok(output) => self.review_response(request.id, &session, output),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_keep_tracked_file" => {
                let input = match parse_args::<NativeReviewFileMutationInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                let session = match self.ai_engine.session_for_review(&input.session_id) {
                    Ok(session) => session,
                    Err(error) => return error_only(request.id, error.to_native_error()),
                };
                match self.review_service.keep_file(&session, input) {
                    Ok(output) => self.review_response(request.id, &session, output),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_reject_tracked_file" => {
                let input = match parse_args::<NativeReviewFileMutationInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                let session = match self.ai_engine.session_for_review(&input.session_id) {
                    Ok(session) => session,
                    Err(error) => return error_only(request.id, error.to_native_error()),
                };
                let write_tracker = self.fs_service.write_tracker();
                match self
                    .review_service
                    .reject_file(&session, input, &write_tracker)
                {
                    Ok(output) => self.review_response(request.id, &session, output),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_keep_tracked_file_hunks" => {
                let input = match parse_args::<NativeReviewHunkMutationInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                let session = match self.ai_engine.session_for_review(&input.session_id) {
                    Ok(session) => session,
                    Err(error) => return error_only(request.id, error.to_native_error()),
                };
                match self.review_service.keep_hunks(&session, input) {
                    Ok(output) => self.review_response(request.id, &session, output),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_reject_tracked_file_hunks" => {
                let input = match parse_args::<NativeReviewHunkMutationInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                let session = match self.ai_engine.session_for_review(&input.session_id) {
                    Ok(session) => session,
                    Err(error) => return error_only(request.id, error.to_native_error()),
                };
                let write_tracker = self.fs_service.write_tracker();
                match self
                    .review_service
                    .reject_hunks(&session, input, &write_tracker)
                {
                    Ok(output) => self.review_response(request.id, &session, output),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_keep_all_tracked_files" => {
                let input = match parse_args::<NativeReviewSessionInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                let session = match self.ai_engine.session_for_review(&input.session_id) {
                    Ok(session) => session,
                    Err(error) => return error_only(request.id, error.to_native_error()),
                };
                match self.review_service.keep_all(&session) {
                    Ok(output) => self.review_response(request.id, &session, output),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_reject_all_tracked_files" => {
                let input = match parse_args::<NativeReviewSessionInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                let session = match self.ai_engine.session_for_review(&input.session_id) {
                    Ok(session) => session,
                    Err(error) => return error_only(request.id, error.to_native_error()),
                };
                let write_tracker = self.fs_service.write_tracker();
                match self.review_service.reject_all(&session, &write_tracker) {
                    Ok(output) => self.review_response(request.id, &session, output),
                    Err(error) => error_only(request.id, error),
                }
            }
            "ai_notify_file_buffer" => {
                let input = match parse_args::<NativeReviewFileBufferInput>(&request) {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                self.review_service.notify_file_buffer(input);
                response_only(request.id, json!({"ok": true}))
            }
            "ai_respond_permission" => {
                let input = match parse_args::<native_ai::NativeAiPermissionResponseInput>(&request)
                {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.ai_engine.respond_permission(input) {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
            "ai_respond_user_input" => {
                let input = match parse_args::<native_ai::NativeAiUserInputResponseInput>(&request)
                {
                    Ok(input) => input,
                    Err(error) => return error_only(request.id, error),
                };
                match self.ai_engine.respond_user_input(input) {
                    Ok(()) => response_only(request.id, json!({"ok": true})),
                    Err(error) => error_only(request.id, error.to_native_error()),
                }
            }
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

    fn ai_history_store(&self) -> Result<AiHistoryStore, NativeError> {
        let Some(store) = self.persistence_store.as_ref() else {
            return Err(NativeError::new(
                NativeErrorCode::BackendNotReady,
                "Native persistence store has not been opened.",
            ));
        };
        AiHistoryStore::new(store.app_data_dir().to_path_buf())
            .map_err(|error| error.to_native_error())
    }

    fn list_ai_session_history(
        &self,
        input: native_ai::NativeAiListSessionHistoryInput,
    ) -> Result<Vec<native_ai::NativeAiHistorySessionSummary>, NativeError> {
        let limit = input.limit;
        let store = self.ai_history_store()?;
        let mut history = store
            .list_session_history(input.clone())
            .map_err(|error| error.to_native_error())?;
        if let Some(persistence_store) = self.persistence_store.as_ref() {
            let legacy = LegacyAiHistoryReader::new(persistence_store.connection())
                .list_session_history(input)
                .map_err(|error| error.to_native_error())?;
            let mut seen = history
                .iter()
                .map(|summary| summary.session_id.0.clone())
                .collect::<std::collections::HashSet<_>>();
            for summary in legacy {
                if seen.insert(summary.session_id.0.clone()) {
                    history.push(summary);
                }
            }
        }
        history.sort_by(|left, right| {
            match (left.pinned_at.is_some(), right.pinned_at.is_some()) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => right.updated_at.cmp(&left.updated_at),
            }
        });
        if let Some(limit) = limit {
            history.truncate(limit);
        }
        Ok(history)
    }

    fn load_ai_session_transcript_page(
        &self,
        input: native_ai::NativeAiLoadSessionTranscriptPageInput,
    ) -> Result<Option<native_ai::NativeAiSessionTranscriptPage>, NativeError> {
        let store = self.ai_history_store()?;
        if store.has_session(&input.session_id) {
            return store
                .load_transcript_page(input)
                .map_err(|error| error.to_native_error());
        }
        let Some(persistence_store) = self.persistence_store.as_ref() else {
            return Ok(None);
        };
        LegacyAiHistoryReader::new(persistence_store.connection())
            .load_transcript_page(input)
            .map_err(|error| error.to_native_error())
    }

    fn load_ai_session_snapshot(
        &self,
        session_id: comando_types::ids::SessionId,
    ) -> Result<Option<native_ai::NativeAiSessionSnapshot>, NativeError> {
        let store = self.ai_history_store()?;
        if store.has_session(&session_id) {
            return store
                .load_session_snapshot(&session_id)
                .map_err(|error| error.to_native_error());
        }
        let Some(persistence_store) = self.persistence_store.as_ref() else {
            return Ok(None);
        };
        LegacyAiHistoryReader::new(persistence_store.connection())
            .load_session_snapshot(&session_id)
            .map_err(|error| error.to_native_error())
    }

    fn list_ai_session_runtime_mappings(
        &self,
        parent_session_id: comando_types::ids::SessionId,
    ) -> Result<Vec<native_ai::NativeAiRuntimeSessionMapping>, NativeError> {
        let store = self.ai_history_store()?;
        let mut mappings = store
            .list_runtime_mappings_for_parent(&parent_session_id)
            .map_err(|error| error.to_native_error())?;
        if let Some(persistence_store) = self.persistence_store.as_ref() {
            let legacy = LegacyAiHistoryReader::new(persistence_store.connection())
                .list_runtime_mappings_for_parent(&parent_session_id)
                .map_err(|error| error.to_native_error())?;
            let mut seen = mappings
                .iter()
                .map(|mapping| {
                    (
                        mapping.app_session_id.0.clone(),
                        mapping.runtime_session_id.0.clone(),
                    )
                })
                .collect::<std::collections::HashSet<_>>();
            for mapping in legacy {
                let key = (
                    mapping.app_session_id.0.clone(),
                    mapping.runtime_session_id.0.clone(),
                );
                if seen.insert(key) {
                    mappings.push(mapping);
                }
            }
        }
        Ok(mappings)
    }

    fn set_ai_session_pinned(
        &self,
        input: native_ai::NativeAiSetSessionPinnedInput,
    ) -> Result<(), NativeError> {
        let store = self.ai_history_store()?;
        if !store.has_session(&input.session_id) {
            return Err(comando_ai::AiError::SessionNotFound {
                session_id: input.session_id.0,
            }
            .to_native_error());
        }
        store
            .set_session_pinned(&input.session_id, input.pinned)
            .map_err(|error| error.to_native_error())
    }

    fn delete_ai_session(
        &self,
        session_id: comando_types::ids::SessionId,
    ) -> Result<(), NativeError> {
        let store = self.ai_history_store()?;
        if !store.has_session(&session_id) {
            return Err(comando_ai::AiError::SessionNotFound {
                session_id: session_id.0,
            }
            .to_native_error());
        }
        store
            .delete_session(&session_id)
            .map_err(|error| error.to_native_error())
    }

    fn rename_ai_session(
        &self,
        input: native_ai::NativeAiRenameSessionInput,
    ) -> Result<(), NativeError> {
        let store = self.ai_history_store()?;
        if !store.has_session(&input.session_id) {
            return Err(comando_ai::AiError::SessionNotFound {
                session_id: input.session_id.0,
            }
            .to_native_error());
        }
        self.ai_engine
            .rename_session(input)
            .map_err(|error| error.to_native_error())
    }

    fn migrate_ai_session_history(
        &self,
        input: native_ai::NativeAiMigrateSessionHistoryInput,
    ) -> Result<native_ai::NativeAiMigrateSessionHistoryOutput, NativeError> {
        let store = self.ai_history_store()?;
        let Some(persistence_store) = self.persistence_store.as_ref() else {
            return Err(NativeError::new(
                NativeErrorCode::BackendNotReady,
                "Native persistence store has not been opened.",
            ));
        };
        let source_database_path = input.source_database_path.or_else(|| {
            Some(
                persistence_store
                    .database_path()
                    .to_string_lossy()
                    .to_string(),
            )
        });
        let mode = AiHistoryMigrationMode::from_optional(input.mode.as_deref())
            .map_err(|error| error.to_native_error())?;
        let options = AiHistoryMigrationOptions {
            mode,
            limit: input.limit,
        };
        AiHistoryMigrator::new(&store, persistence_store.connection(), source_database_path)
            .copy_legacy_history_with_options(options)
            .map_err(|error| error.to_native_error())
    }

    fn get_ai_history_storage_health(
        &self,
    ) -> Result<native_ai::NativeAiHistoryStorageHealth, NativeError> {
        let store = self.ai_history_store()?;
        let mut health = store
            .storage_health()
            .map_err(|error| error.to_native_error())?;
        health.legacy_fallback_available = self.persistence_store.is_some();
        Ok(health)
    }

    fn review_response(
        &self,
        id: RequestId,
        session: &comando_ai::NativeAiSession,
        output: NativeReviewCommandOutput,
    ) -> CommandResult {
        let mut outputs = vec![response_ok(
            id,
            serde_json::to_value(&output).expect("review command output serializes"),
        )];
        outputs.push(event(
            "ai://review-updated",
            serde_json::to_value(self.review_service.review_updated_payload(session, &output))
                .expect("review updated event serializes"),
        ));
        for tracked_file_event in &output.tracked_file_events {
            outputs.push(event(
                "ai://tracked-file-updated",
                serde_json::to_value(tracked_file_event)
                    .expect("tracked file updated event serializes"),
            ));
        }
        if let Some(project_id) = session.scope.project_id.clone()
            && !output.changed_files.is_empty()
        {
            outputs.push(tree_invalidation_event(
                project_id,
                session.scope.worktree_id.clone(),
                output
                    .changed_files
                    .iter()
                    .cloned()
                    .map(comando_types::ids::RelativePath)
                    .collect(),
            ));
        }

        CommandResult {
            outputs,
            should_shutdown: false,
        }
    }

    fn ensure_terminal_service(
        &mut self,
        background_sender: mpsc::SyncSender<Vec<RpcOutput>>,
    ) -> &TerminalService {
        self.terminal_service.get_or_insert_with(|| {
            let (event_sender, event_receiver) =
                mpsc::sync_channel::<TerminalRuntimeEvent>(Self::TERMINAL_EVENT_CHANNEL_CAPACITY);
            let auth_terminal_sessions = Arc::clone(&self.auth_terminal_sessions);
            let runtime_setup_store = Arc::clone(&self.runtime_setup_store_shared);
            let ai_engine = self.ai_engine.clone();
            thread::spawn(move || {
                for event_payload in event_receiver {
                    let mut outputs = vec![terminal_runtime_event_output(event_payload.clone())];
                    outputs.extend(auth_terminal_runtime_outputs(
                        &auth_terminal_sessions,
                        &runtime_setup_store,
                        &ai_engine,
                        &event_payload,
                    ));
                    if background_sender.send(outputs).is_err() {
                        break;
                    }
                }
            });

            TerminalService::new(event_sender)
        })
    }

    fn ensure_ai_event_bridge(
        &mut self,
        background_sender: mpsc::SyncSender<Vec<RpcOutput>>,
    ) -> Result<(), NativeError> {
        if self.ai_event_bridge_started {
            return Ok(());
        }

        let (event_sender, event_receiver) =
            mpsc::sync_channel::<AiRuntimeEvent>(Self::AI_EVENT_CHANNEL_CAPACITY);
        self.ai_engine
            .set_event_sender(event_sender)
            .map_err(|error| error.to_native_error())?;
        let ai_engine = self.ai_engine.clone();
        let runtime_setup_store = Arc::clone(&self.runtime_setup_store_shared);
        thread::spawn(move || {
            for ai_event in event_receiver {
                if let Err(error) = ai_engine.record_history_event(&ai_event) {
                    eprintln!(
                        "[comando-native-backend] Native AI history event write failed: {error}"
                    );
                }
                let mut outputs = vec![ai_runtime_event_output(ai_event.clone())];
                outputs.extend(ai_error_runtime_outputs(
                    &runtime_setup_store,
                    &ai_engine,
                    &ai_event,
                ));
                if background_sender.send(outputs).is_err() {
                    break;
                }
            }
        });
        self.ai_event_bridge_started = true;
        Ok(())
    }

    fn search_project_content(&mut self, request: RpcRequest) -> CommandResult {
        match parse_args::<native_index::NativeContentSearchInput>(&request) {
            Ok(_) => error_only(
                request.id,
                comando_index::IndexError::ContentSearchDisabled.to_native_error(),
            ),
            Err(error) => error_only(request.id, error),
        }
    }

    fn search_cancel(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<native_index::NativeSearchCancelInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        response_only(
            request.id,
            serde_json::to_value(native_index::NativeSearchCancelled {
                cancelled: self.index_service.cancel_search(&input.operation_id),
                operation_id: input.operation_id,
                cancelled_at: comando_persistence::store::now_rfc3339(),
            })
            .expect("search cancel result serializes"),
        )
    }

    fn git_resolve_repository(&mut self, request: RpcRequest) -> CommandResult {
        let scope = match parse_args::<native_git::NativeGitRepositoryScope>(&request) {
            Ok(scope) => scope,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            resolve_repository(&self.git_runner, scope.root_path),
            "git resolve repository output serializes",
        )
    }

    fn git_get_repository_snapshot(&mut self, request: RpcRequest) -> CommandResult {
        let scope = match parse_args::<native_git::NativeGitRepositoryScope>(&request) {
            Ok(scope) => scope,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            get_repository_snapshot(&self.git_runner, &scope),
            "git repository snapshot serializes",
        )
    }

    fn git_get_status(&mut self, request: RpcRequest) -> CommandResult {
        let scope = match parse_args::<native_git::NativeGitRepositoryScope>(&request) {
            Ok(scope) => scope,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            get_status(&self.git_runner, scope.root_path, scope.worktree_id),
            "git status serializes",
        )
    }

    fn git_get_diff(&mut self, request: RpcRequest) -> CommandResult {
        self.git_list_worktree_diff(request)
    }

    fn git_get_file_diff(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<native_git::NativeGitPathInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let diff_request = GitFileDiffRequest {
            relative_path: input.path,
            previous_path: input.previous_path,
            change_kind: input.change_kind,
            scope: input.diff_scope.unwrap_or_else(|| "auto".to_string()),
            staged: input.staged.unwrap_or(false),
        };

        git_response(
            request.id,
            get_file_diff(&self.git_runner, input.scope.root_path, &diff_request),
            "git file diff serializes",
        )
    }

    fn git_get_original_file(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<native_git::NativeGitPathInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            get_original_file(
                &self.git_runner,
                input.scope.root_path,
                &input.path,
                input.previous_path.as_deref(),
                input.change_kind.as_deref().unwrap_or("modified"),
                input.diff_scope.as_deref().unwrap_or("auto"),
            ),
            "git original file serializes",
        )
    }

    fn git_get_history(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<native_git::NativeGitHistoryInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            list_history(
                &self.git_runner,
                input.scope.root_path,
                input.query.as_deref(),
                input.case_sensitive.unwrap_or(false),
                input.limit,
            ),
            "git history serializes",
        )
    }

    fn git_get_commit_detail(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<native_git::NativeGitCommitDetailInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            get_commit_detail(&self.git_runner, input.scope.root_path, &input.commit_sha),
            "git commit detail serializes",
        )
    }

    fn git_list_branches(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<NativeGitListBranchesInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let status = get_status(
            &self.git_runner,
            &input.scope.root_path,
            input.scope.worktree_id.clone(),
        )
        .ok();
        let branch_scope = if input.branch_scope.as_deref() == Some("local") {
            GitBranchListScope::Local
        } else {
            GitBranchListScope::All
        };

        git_response(
            request.id,
            list_branches(
                &self.git_runner,
                input.scope.root_path,
                branch_scope,
                status.as_ref().and_then(|status| status.sync.as_ref()),
            ),
            "git branches serializes",
        )
    }

    fn git_list_worktrees(&mut self, request: RpcRequest) -> CommandResult {
        let scope = match parse_args::<native_git::NativeGitRepositoryScope>(&request) {
            Ok(scope) => scope,
            Err(error) => return error_only(request.id, error),
        };
        let updated_at = comando_persistence::store::now_rfc3339();

        git_response(
            request.id,
            list_worktrees(
                &self.git_runner,
                &scope.root_path,
                scope.project_id,
                &scope.root_path,
                &scope.root_path,
                updated_at,
            ),
            "git worktrees serializes",
        )
    }

    fn git_list_remotes(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<NativeGitListRemotesInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        response_only(
            request.id,
            serde_json::to_value(list_remotes(
                &self.git_runner,
                input.scope.root_path,
                input.tracking_branch_name.as_deref(),
                input.ahead_by.unwrap_or(0),
                input.behind_by.unwrap_or(0),
            ))
            .expect("git remotes serialize"),
        )
    }

    fn git_get_diff_stats(&mut self, request: RpcRequest) -> CommandResult {
        let scope = match parse_args::<native_git::NativeGitRepositoryScope>(&request) {
            Ok(scope) => scope,
            Err(error) => return error_only(request.id, error),
        };

        response_only(
            request.id,
            serde_json::to_value(get_diff_stats(&self.git_runner, scope.root_path))
                .expect("git diff stats serialize"),
        )
    }

    fn git_list_worktree_diff(&mut self, request: RpcRequest) -> CommandResult {
        let input = match parse_args::<NativeGitWorktreeDiffInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            list_worktree_diff(
                &self.git_runner,
                input.scope.root_path,
                input.scope.project_id,
                input.scope.worktree_id,
                input.scopes.as_deref(),
            ),
            "git worktree diff serializes",
        )
    }

    fn git_init_repository(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_mutations_enabled() {
            return disabled_git_operation(request);
        }
        let scope = match parse_args::<native_git::NativeGitRepositoryScope>(&request) {
            Ok(scope) => scope,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            init_repository(&self.git_runner, &scope),
            "git init result serializes",
        )
    }

    fn git_stage_paths(&mut self, request: RpcRequest) -> CommandResult {
        self.git_paths_operation(request, stage_paths, "git stage result serializes")
    }

    fn git_unstage_paths(&mut self, request: RpcRequest) -> CommandResult {
        self.git_paths_operation(request, unstage_paths, "git unstage result serializes")
    }

    fn git_discard_paths(&mut self, request: RpcRequest) -> CommandResult {
        self.git_paths_operation(request, discard_paths, "git discard result serializes")
    }

    fn git_commit(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_mutations_enabled() {
            return disabled_git_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitCommitInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            commit(
                &self.git_runner,
                &input.scope,
                &input.message,
                input.amend.unwrap_or(false),
                input.no_verify.unwrap_or(false),
            ),
            "git commit result serializes",
        )
    }

    fn git_checkout_branch(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_mutations_enabled() {
            return disabled_git_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitCheckoutBranchInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            checkout_branch(
                &self.git_runner,
                &input.scope,
                &input.branch_name,
                input.force.unwrap_or(false),
                input.new_branch_name.as_deref(),
                input.start_point.as_deref(),
            ),
            "git checkout branch result serializes",
        )
    }

    fn git_create_branch(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_mutations_enabled() {
            return disabled_git_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitCheckoutBranchInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            create_branch(
                &self.git_runner,
                &input.scope,
                input
                    .new_branch_name
                    .as_deref()
                    .unwrap_or(input.branch_name.as_str()),
                input.start_point.as_deref(),
            ),
            "git create branch result serializes",
        )
    }

    fn git_delete_local_branch(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_mutations_enabled() {
            return disabled_git_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitDeleteLocalBranchInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            delete_local_branch(
                &self.git_runner,
                &input.scope,
                &input.branch_name,
                input.force.unwrap_or(false),
            ),
            "git delete local branch result serializes",
        )
    }

    fn git_create_worktree(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_mutations_enabled() {
            return disabled_git_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitWorktreeMutationInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };
        let Some(branch_name) = input.branch_name.as_deref() else {
            return error_only(
                request.id,
                GitError::InvalidOperation(
                    "A branch name is required to create a worktree.".to_string(),
                )
                .to_native_error(),
            );
        };

        git_response(
            request.id,
            create_worktree(
                &self.git_runner,
                &input.scope,
                branch_name,
                input.force.unwrap_or(false),
                &input.path,
                input.start_point.as_deref(),
            ),
            "git create worktree result serializes",
        )
    }

    fn git_remove_worktree(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_mutations_enabled() {
            return disabled_git_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitWorktreeMutationInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            remove_worktree(
                &self.git_runner,
                &input.scope,
                &input.path,
                input.force.unwrap_or(false),
            ),
            "git remove worktree result serializes",
        )
    }

    fn git_fetch(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_network_enabled() {
            return disabled_git_network_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitFetchInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            fetch(
                &self.git_runner,
                &input.scope,
                input.all.unwrap_or(false),
                input.prune.unwrap_or(false),
                input.remote_name.as_deref(),
            ),
            "git fetch result serializes",
        )
    }

    fn git_pull(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_network_enabled() {
            return disabled_git_network_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitPullInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            pull(
                &self.git_runner,
                &input.scope,
                input.rebase.unwrap_or(false),
                input.remote_name.as_deref(),
                input.remote_ref.as_deref(),
            ),
            "git pull result serializes",
        )
    }

    fn git_push(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_network_enabled() {
            return disabled_git_network_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitPushInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            push(
                &self.git_runner,
                &input.scope,
                input.force.unwrap_or(false),
                input.force_with_lease.unwrap_or(false),
                input.remote_name.as_deref(),
                input.remote_ref.as_deref(),
                input.set_upstream.unwrap_or(false),
            ),
            "git push result serializes",
        )
    }

    fn git_delete_remote_branch(&mut self, request: RpcRequest) -> CommandResult {
        if !native_git_network_enabled() {
            return disabled_git_network_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitDeleteRemoteBranchInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            delete_remote_branch(
                &self.git_runner,
                &input.scope,
                &input.remote_name,
                &input.remote_ref,
            ),
            "git delete remote branch result serializes",
        )
    }

    fn git_paths_operation(
        &mut self,
        request: RpcRequest,
        operation: fn(
            &GitRunner,
            &native_git::NativeGitRepositoryScope,
            &[String],
        ) -> comando_git::GitResult<native_git::NativeGitOperationResult>,
        serialize_message: &'static str,
    ) -> CommandResult {
        if !native_git_mutations_enabled() {
            return disabled_git_operation(request);
        }
        let input = match parse_args::<native_git::NativeGitPathsInput>(&request) {
            Ok(input) => input,
            Err(error) => return error_only(request.id, error),
        };

        git_response(
            request.id,
            operation(&self.git_runner, &input.scope, &input.paths),
            serialize_message,
        )
    }

    fn sync_fs_registry_from_store(&mut self) -> Result<NativeProjectState, NativeError> {
        let state = self.load_project_state_from_store()?;
        self.fs_service.sync_state(state.clone());
        Ok(state)
    }

    fn load_project_state_from_store(&mut self) -> Result<NativeProjectState, NativeError> {
        let Some(store) = self.persistence_store.as_mut() else {
            return Err(NativeError::new(
                NativeErrorCode::BackendNotReady,
                "Native persistence store has not been opened.",
            ));
        };
        let mut registry = ProjectRegistry::new(store.connection_mut());
        registry
            .list_projects()
            .map(|result| NativeProjectState {
                projects: result.projects,
                worktrees: result.worktrees,
            })
            .map_err(project_error)
    }

    fn resolve_index_root(
        &self,
        project_id: &comando_types::ids::ProjectId,
        worktree_id: Option<&comando_types::ids::WorktreeId>,
    ) -> Result<ProjectRoot, NativeError> {
        self.fs_service
            .resolve_root(project_id, worktree_id)
            .map_err(fs_error)
    }

    fn resolve_auth_terminal_cwd(
        &mut self,
        project_id: Option<&comando_types::ids::ProjectId>,
        worktree_id: Option<&comando_types::ids::WorktreeId>,
    ) -> Option<String> {
        let project_id = project_id?;
        let _ = self.sync_fs_registry_from_store();
        self.fs_service
            .resolve_root(project_id, worktree_id)
            .ok()
            .map(|root| root.root_path.display().to_string())
    }

    pub(crate) fn drain_fs_events(&mut self, force: bool) -> Vec<RpcOutput> {
        let drain = self.fs_service.drain_watchers(force);
        let mut outputs = Vec::new();
        for invalidation in drain.invalidations {
            outputs.push(event(
                "project://tree-invalidated",
                serde_json::to_value(invalidation).expect("invalidation event serializes"),
            ));
        }
        for (event_name, payload) in drain.fs_events {
            outputs.push(event(
                &event_name,
                serde_json::to_value(payload).expect("fs event serializes"),
            ));
        }
        outputs
    }

    #[cfg(test)]
    fn queue_test_fs_event(&mut self, request: RpcRequest) -> CommandResult {
        self.fs_service.queue_test_invalidation_after_delay(
            comando_fs::ProjectRoot {
                project_id: "project_test".into(),
                worktree_id: Some("project_test:primary".into()),
                root_path: "/tmp/project-test".into(),
            },
            "src/idle.txt".to_string(),
            std::time::Duration::from_millis(200),
        );

        response_only(request.id, json!({"queued": true}))
    }
}

fn apply_runtime_settings(
    store: &RuntimeSetupStore,
    input: native_ai::NativeAiSaveRuntimeSettingsInput,
) -> Result<(), NativeError> {
    let runtime_id = input.runtime_id.0.clone();
    let mut state = store
        .load_runtime(&runtime_id)
        .map_err(|error| runtime_setup_native_error(error.to_string()))?;
    state.binary_path = normalize_optional_text(input.settings.binary_path);
    state.auth_method = normalize_optional_text(input.settings.auth_method);
    state.auth_invalidated_at_ms = input.settings.auth_invalidated_at_ms;
    state.gateway_base_url = normalize_optional_text(input.settings.gateway_base_url);
    state.bedrock_gateway_base_url =
        normalize_optional_text(input.settings.bedrock_gateway_base_url);
    state.non_secret_env = input
        .settings
        .non_secret_env
        .into_iter()
        .filter_map(|(key, value)| {
            let value = value.trim();
            (!value.is_empty()).then(|| (key, value.to_string()))
        })
        .collect();

    let mut secret_snapshots = HashMap::<String, Option<String>>::new();
    let patch_result = apply_secret_patches(
        store,
        &runtime_id,
        input.secret_patches,
        &mut state,
        &mut secret_snapshots,
    );
    if let Err(error) = patch_result {
        rollback_secret_changes(store, &runtime_id, &secret_snapshots);
        return Err(error);
    }

    if let Err(error) = store.save_runtime(&runtime_id, state) {
        rollback_secret_changes(store, &runtime_id, &secret_snapshots);
        return Err(runtime_setup_native_error(error.to_string()));
    }
    Ok(())
}

fn apply_secret_patches(
    store: &RuntimeSetupStore,
    runtime_id: &str,
    patches: Vec<native_ai::NativeAiSecretPatch>,
    state: &mut RuntimeSetupState,
    snapshots: &mut HashMap<String, Option<String>>,
) -> Result<(), NativeError> {
    for patch in patches {
        match patch.action {
            native_ai::NativeSecretPatchAction::Set => {
                let value = patch.value.unwrap_or_default();
                let value = value.trim();
                if value.is_empty() {
                    snapshot_secret(store, runtime_id, &patch.env_key, snapshots)?;
                    store
                        .secrets()
                        .delete_secret(runtime_id, &patch.env_key)
                        .map_err(|error| runtime_setup_native_error(error.to_string()))?;
                    state.secret_env_keys.remove(&patch.env_key);
                } else {
                    snapshot_secret(store, runtime_id, &patch.env_key, snapshots)?;
                    store
                        .secrets()
                        .set_secret(runtime_id, &patch.env_key, value)
                        .map_err(|error| runtime_setup_native_error(error.to_string()))?;
                    state.secret_env_keys.insert(patch.env_key.clone());
                    if let Some(opposite) =
                        mutually_exclusive_secret_key(runtime_id, &patch.env_key)
                    {
                        snapshot_secret(store, runtime_id, opposite, snapshots)?;
                        store
                            .secrets()
                            .delete_secret(runtime_id, opposite)
                            .map_err(|error| runtime_setup_native_error(error.to_string()))?;
                        state.secret_env_keys.remove(opposite);
                    }
                }
            }
            native_ai::NativeSecretPatchAction::Delete => {
                snapshot_secret(store, runtime_id, &patch.env_key, snapshots)?;
                store
                    .secrets()
                    .delete_secret(runtime_id, &patch.env_key)
                    .map_err(|error| runtime_setup_native_error(error.to_string()))?;
                state.secret_env_keys.remove(&patch.env_key);
            }
        }
    }
    Ok(())
}

fn mutually_exclusive_secret_key(runtime_id: &str, env_key: &str) -> Option<&'static str> {
    match (runtime_id, env_key) {
        ("codex", "CODEX_API_KEY") => Some("OPENAI_API_KEY"),
        ("codex", "OPENAI_API_KEY") => Some("CODEX_API_KEY"),
        _ => None,
    }
}

fn snapshot_secret(
    store: &RuntimeSetupStore,
    runtime_id: &str,
    env_key: &str,
    snapshots: &mut HashMap<String, Option<String>>,
) -> Result<(), NativeError> {
    if snapshots.contains_key(env_key) {
        return Ok(());
    }
    let previous = store
        .secrets()
        .get_secret(runtime_id, env_key)
        .map_err(|error| runtime_setup_native_error(error.to_string()))?;
    snapshots.insert(env_key.to_string(), previous);
    Ok(())
}

fn rollback_secret_changes(
    store: &RuntimeSetupStore,
    runtime_id: &str,
    snapshots: &HashMap<String, Option<String>>,
) {
    for (env_key, previous) in snapshots {
        let _ = match previous {
            Some(value) => store.secrets().set_secret(runtime_id, env_key, value),
            None => store.secrets().delete_secret(runtime_id, env_key),
        };
    }
}

fn disconnect_runtime_auth(store: &RuntimeSetupStore, runtime_id: &str) -> Result<(), NativeError> {
    let mut state = store
        .load_runtime(runtime_id)
        .map_err(|error| runtime_setup_native_error(error.to_string()))?;
    for env_key in secret_env_keys_for_runtime(runtime_id) {
        store
            .secrets()
            .delete_secret(runtime_id, env_key)
            .map_err(|error| runtime_setup_native_error(error.to_string()))?;
    }
    if matches!(
        state.auth_method.as_deref(),
        Some(
            "claude-login"
                | "claude-ai-login"
                | "console-login"
                | "opencode-login"
                | "grok-login"
                | "kilo-login"
        )
    ) {
        state.auth_invalidated_at_ms = Some(now_ms());
    }
    state.auth_method = None;
    state.secret_env_keys.clear();
    store
        .save_runtime(runtime_id, state)
        .map_err(|error| runtime_setup_native_error(error.to_string()))
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn runtime_status_response(
    id: RequestId,
    status: native_ai::NativeAiRuntimeStatus,
) -> CommandResult {
    CommandResult {
        outputs: vec![
            response_ok(
                id,
                serde_json::to_value(&status).expect("runtime status serializes"),
            ),
            event(
                AI_RUNTIME_STATUS_EVENT,
                serde_json::to_value(status).expect("runtime status event serializes"),
            ),
        ],
        should_shutdown: false,
    }
}

fn runtime_setup_native_error(message: String) -> NativeError {
    let code = if message.starts_with("Invalid") {
        NativeErrorCode::InvalidArgs
    } else {
        NativeErrorCode::InternalError
    };
    NativeError::new(code, message)
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

fn fs_error(error: FsError) -> NativeError {
    error.to_native_error()
}

fn git_error(error: comando_git::GitError) -> NativeError {
    error.to_native_error()
}

fn git_response<T: Serialize>(
    id: RequestId,
    result: Result<T, comando_git::GitError>,
    serialize_message: &'static str,
) -> CommandResult {
    match result {
        Ok(output) => response_only(id, serde_json::to_value(output).expect(serialize_message)),
        Err(error) => error_only(id, git_error(error)),
    }
}

fn terminal_runtime_event_output(event_payload: TerminalRuntimeEvent) -> RpcOutput {
    match event_payload {
        TerminalRuntimeEvent::Created(payload) => event(
            "terminal://created",
            serde_json::to_value(payload).expect("terminal created event serializes"),
        ),
        TerminalRuntimeEvent::Data(payload) => event(
            "terminal://data",
            serde_json::to_value(payload).expect("terminal data event serializes"),
        ),
        TerminalRuntimeEvent::Exit(payload) => event(
            "terminal://exit",
            serde_json::to_value(payload).expect("terminal exit event serializes"),
        ),
        TerminalRuntimeEvent::Closed(payload) => event(
            "terminal://closed",
            serde_json::to_value(payload).expect("terminal closed event serializes"),
        ),
        TerminalRuntimeEvent::Error(payload) => event(
            "terminal://error",
            serde_json::to_value(payload).expect("terminal error event serializes"),
        ),
    }
}

fn auth_terminal_runtime_outputs(
    sessions: &Arc<Mutex<HashMap<String, AuthTerminalSession>>>,
    runtime_setup_store: &Arc<Mutex<Option<RuntimeSetupStore>>>,
    ai_engine: &AiEngine,
    event_payload: &TerminalRuntimeEvent,
) -> Vec<RpcOutput> {
    match event_payload {
        TerminalRuntimeEvent::Exit(payload) => {
            let Some(auth_session) = remove_auth_terminal_session(sessions, &payload.session_id.0)
            else {
                return Vec::new();
            };
            if payload.exit_code == Some(0) {
                clear_auth_terminal_invalidation(runtime_setup_store, &auth_session);
            }
            let mut outputs = vec![event(
                "ai://auth-terminal-exited",
                json!({
                    "runtimeId": &auth_session.runtime_id,
                    "methodId": &auth_session.method_id,
                    "terminalSessionId": &payload.session_id.0,
                    "exitCode": payload.exit_code,
                    "signalCode": &payload.signal_code,
                }),
            )];
            if let Some(status_event) = runtime_status_event(ai_engine, &auth_session.runtime_id) {
                outputs.push(status_event);
            }
            outputs
        }
        TerminalRuntimeEvent::Error(payload) => {
            let Some(session_id) = payload
                .session_id
                .as_ref()
                .map(|session_id| session_id.0.clone())
            else {
                return Vec::new();
            };
            let Some(auth_session) = remove_auth_terminal_session(sessions, &session_id) else {
                return Vec::new();
            };
            let mut outputs = vec![event(
                "ai://auth-terminal-error",
                json!({
                    "runtimeId": &auth_session.runtime_id,
                    "methodId": &auth_session.method_id,
                    "terminalSessionId": &session_id,
                    "message": &payload.message,
                    "retryable": payload.retryable,
                }),
            )];
            if let Some(status_event) = runtime_status_event(ai_engine, &auth_session.runtime_id) {
                outputs.push(status_event);
            }
            outputs
        }
        TerminalRuntimeEvent::Closed(payload) => {
            let Some(auth_session) = remove_auth_terminal_session(sessions, &payload.session_id.0)
            else {
                return Vec::new();
            };
            vec![event(
                "ai://auth-terminal-closed",
                json!({
                    "runtimeId": &auth_session.runtime_id,
                    "methodId": &auth_session.method_id,
                    "terminalSessionId": &payload.session_id.0,
                    "reason": payload.reason,
                }),
            )]
        }
        TerminalRuntimeEvent::Created(_) | TerminalRuntimeEvent::Data(_) => Vec::new(),
    }
}

fn remove_auth_terminal_session(
    sessions: &Arc<Mutex<HashMap<String, AuthTerminalSession>>>,
    session_id: &str,
) -> Option<AuthTerminalSession> {
    sessions
        .lock()
        .ok()
        .and_then(|mut sessions| sessions.remove(session_id))
}

fn clear_auth_terminal_invalidation(
    runtime_setup_store: &Arc<Mutex<Option<RuntimeSetupStore>>>,
    auth_session: &AuthTerminalSession,
) {
    let Some(store) = runtime_setup_store
        .lock()
        .ok()
        .and_then(|store| store.clone())
    else {
        return;
    };
    let _ = store.update_runtime(&auth_session.runtime_id, |state| {
        if state.auth_method.as_deref() == Some(auth_session.method_id.as_str()) {
            state.auth_invalidated_at_ms = None;
        }
    });
}

fn runtime_status_event(ai_engine: &AiEngine, runtime_id: &str) -> Option<RpcOutput> {
    let status = ai_engine
        .get_runtime_status(native_ai::NativeAiGetRuntimeStatusInput {
            runtime_id: RuntimeId(runtime_id.to_string()),
            launch: None,
        })
        .ok()?;
    Some(event(
        AI_RUNTIME_STATUS_EVENT,
        serde_json::to_value(status).expect("ai runtime status event serializes"),
    ))
}

fn ai_error_runtime_outputs(
    runtime_setup_store: &Arc<Mutex<Option<RuntimeSetupStore>>>,
    ai_engine: &AiEngine,
    ai_event: &AiRuntimeEvent,
) -> Vec<RpcOutput> {
    if ai_event.event_name != AI_ERROR_EVENT {
        return Vec::new();
    }
    let runtime_id = ai_event
        .payload
        .get("runtimeId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if runtime_id != "grok" {
        return Vec::new();
    }
    let message = ai_event
        .payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(store) = runtime_setup_store
        .lock()
        .ok()
        .and_then(|store| store.clone())
    else {
        return Vec::new();
    };
    match invalidate_grok_auth_on_error(&store, message) {
        Ok(true) => runtime_status_event(ai_engine, runtime_id)
            .into_iter()
            .collect(),
        Ok(false) | Err(_) => Vec::new(),
    }
}

fn ai_runtime_event_output(event_payload: AiRuntimeEvent) -> RpcOutput {
    event(event_payload.event_name, event_payload.payload)
}

fn disabled_git_operation(request: RpcRequest) -> CommandResult {
    error_only(
        request.id,
        NativeError::new(
            NativeErrorCode::PermissionDenied,
            "Native Git operation is disabled by guardrails.",
        )
        .with_details(json!({ "gitCode": "operation_disabled" })),
    )
}

fn disabled_git_network_operation(request: RpcRequest) -> CommandResult {
    error_only(
        request.id,
        NativeError::new(
            NativeErrorCode::PermissionDenied,
            "Native Git network operation is disabled by guardrails.",
        )
        .with_details(json!({ "gitCode": "network_disabled" })),
    )
}

fn native_git_mutations_enabled() -> bool {
    native_git_write_mode_enabled()
        && env::var("COMANDO_NATIVE_GIT_MUTATIONS").ok().as_deref() == Some("1")
}

fn native_git_network_enabled() -> bool {
    native_git_mutations_enabled()
        && env::var("COMANDO_NATIVE_GIT_NETWORK").ok().as_deref() == Some("1")
}

fn native_git_write_mode_enabled() -> bool {
    env::var("COMANDO_NATIVE_GIT").ok().as_deref() == Some("1")
        && env::var("COMANDO_NATIVE_GIT_MODE").ok().as_deref() == Some("write")
}

fn parse_args<T: DeserializeOwned>(request: &RpcRequest) -> Result<T, NativeError> {
    serde_json::from_value::<T>(request.args.clone()).map_err(|error| {
        NativeError::new(
            NativeErrorCode::InvalidArgs,
            format!("Invalid {} args: {error}", request.command),
        )
    })
}

fn mutation_response(
    id: RequestId,
    result: native_fs::NativeFsEntryMutationResult,
) -> CommandResult {
    CommandResult {
        outputs: mutation_outputs(id, &result),
        should_shutdown: false,
    }
}

fn mutation_outputs(
    id: RequestId,
    result: &native_fs::NativeFsEntryMutationResult,
) -> Vec<RpcOutput> {
    vec![response_ok(
        id,
        serde_json::to_value(result).expect("mutation result serializes"),
    )]
}

fn mutation_list_response(
    id: RequestId,
    project_id: comando_types::ids::ProjectId,
    worktree_id: Option<comando_types::ids::WorktreeId>,
    result: native_fs::NativeFsEntryMutationListResult,
) -> CommandResult {
    let relative_paths = result
        .entries
        .iter()
        .map(|entry| entry.relative_path.clone())
        .collect::<Vec<_>>();
    CommandResult {
        outputs: vec![
            response_ok(
                id,
                serde_json::to_value(result).expect("mutation list serializes"),
            ),
            tree_invalidation_event(project_id, worktree_id, relative_paths),
        ],
        should_shutdown: false,
    }
}

fn tree_invalidation_event(
    project_id: comando_types::ids::ProjectId,
    worktree_id: Option<comando_types::ids::WorktreeId>,
    relative_paths: Vec<comando_types::ids::RelativePath>,
) -> RpcOutput {
    event(
        "project://tree-invalidated",
        serde_json::to_value(native_fs::NativeProjectTreeInvalidation {
            project_id,
            worktree_id,
            relative_paths: Some(relative_paths),
            occurred_at: comando_persistence::store::now_rfc3339(),
        })
        .expect("tree invalidation serializes"),
    )
}

fn index_event_outputs(events: Vec<IndexEvent>) -> Vec<RpcOutput> {
    events
        .into_iter()
        .map(|index_event| {
            event(
                index_event.event_name,
                serde_json::to_value(native_index_status(index_event.snapshot))
                    .expect("index event serializes"),
            )
        })
        .collect()
}

fn native_index_update(
    kind: native_index::NativeIndexUpdateKind,
    relative_paths: Option<Vec<comando_types::ids::RelativePath>>,
) -> IndexUpdate {
    let paths = relative_paths.map(|paths| paths.into_iter().map(|path| path.0).collect());
    match paths {
        Some(paths) => IndexUpdate::paths(native_index_update_kind(kind), paths),
        None => IndexUpdate::invalidated(),
    }
}

fn native_index_policy(policy: &native_index::NativeIndexPolicy) -> IndexBuildOptions {
    let mut index_policy = IndexPolicy::default()
        .with_max_entries(policy.max_entries as usize)
        .with_max_depth(policy.max_depth.map(|depth| depth as usize))
        .with_follow_symlinks(policy.follow_symlinks);
    index_policy.include_dotfiles = policy.include_dotfiles;
    index_policy.include_hidden = policy.include_hidden;

    IndexBuildOptions {
        policy: index_policy,
    }
}

fn native_index_update_kind(kind: native_index::NativeIndexUpdateKind) -> IndexUpdateKind {
    match kind {
        native_index::NativeIndexUpdateKind::Created => IndexUpdateKind::Created,
        native_index::NativeIndexUpdateKind::Updated => IndexUpdateKind::Updated,
        native_index::NativeIndexUpdateKind::Deleted => IndexUpdateKind::Deleted,
        native_index::NativeIndexUpdateKind::Renamed => IndexUpdateKind::Renamed,
        native_index::NativeIndexUpdateKind::Invalidated => IndexUpdateKind::Invalidated,
    }
}

fn native_index_status(
    snapshot: comando_index::IndexStatusSnapshot,
) -> native_index::NativeIndexStatusResult {
    native_index::NativeIndexStatusResult {
        project_id: snapshot.project_id.into(),
        worktree_id: snapshot.worktree_id.map(Into::into),
        generation: snapshot.generation,
        status: native_index_status_kind(snapshot.status),
        stats: native_index_stats(snapshot.stats),
        operation_id: snapshot.operation_id.map(Into::into),
        occurred_at: snapshot.occurred_at,
    }
}

fn native_index_status_kind(status: comando_index::IndexStatus) -> native_index::NativeIndexStatus {
    match status {
        comando_index::IndexStatus::Idle => native_index::NativeIndexStatus::Idle,
        comando_index::IndexStatus::Building => native_index::NativeIndexStatus::Building,
        comando_index::IndexStatus::Ready => native_index::NativeIndexStatus::Ready,
        comando_index::IndexStatus::Stale => native_index::NativeIndexStatus::Stale,
        comando_index::IndexStatus::Error => native_index::NativeIndexStatus::Error,
    }
}

fn native_index_stats(stats: comando_index::IndexBuildStats) -> native_index::NativeIndexStats {
    native_index::NativeIndexStats {
        entry_count: saturating_u32(stats.entry_count),
        indexed_file_count: saturating_u32(stats.indexed_file_count),
        indexed_directory_count: saturating_u32(stats.indexed_directory_count),
        skipped_count: saturating_u32(stats.skipped_count),
        duration_ms: stats.duration_ms,
        truncated: stats.truncated,
        reason: stats.reason,
    }
}

fn indexed_project_entry(
    entry: comando_index::IndexedProjectEntry,
) -> native_index::NativeIndexedProjectEntry {
    entry.to_project_tree_entry().into()
}

fn path_search_matches(matches: Vec<SearchMatch>) -> Vec<native_index::NativePathSearchMatch> {
    matches
        .into_iter()
        .map(|search_match| native_index::NativePathSearchMatch {
            entry: indexed_project_entry(search_match.entry),
            score: search_match.score,
        })
        .collect()
}

fn saturating_u32(value: usize) -> u32 {
    value.try_into().unwrap_or(u32::MAX)
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
    use std::sync::Arc;

    use comando_settings::{InMemoryRuntimeSecretStore, RuntimeSecretStore, SecretStoreError};
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

    #[test]
    fn native_secret_commands_do_not_persist_plaintext() {
        let (temp_dir, mut backend) = backend_with_memory_runtime_setup();
        let result = backend.handle_request(request(
            "secret_set",
            json!({
                "runtimeId": "codex",
                "envKey": "OPENAI_API_KEY",
                "value": "sk-native-secret",
            }),
        ));
        let response = only_response(&result);
        assert!(response.ok);
        assert_eq!(response.result.as_ref().unwrap()["present"], true);

        let setup_path = temp_dir.path().join("ai").join("runtime-setup.json");
        let encoded = fs::read_to_string(setup_path).expect("runtime setup");
        assert!(encoded.contains("OPENAI_API_KEY"));
        assert!(!encoded.contains("sk-native-secret"));
    }

    #[test]
    fn ai_save_runtime_settings_returns_native_status() {
        let (temp_dir, mut backend) = backend_with_memory_runtime_setup();
        let executable = std::env::current_exe().expect("current exe");
        let result = backend.handle_request(request(
            "ai_save_runtime_settings",
            json!({
                "runtimeId": "codex",
                "settings": {
                    "authMethod": "openai-api-key",
                    "binaryPath": executable,
                },
                "secretPatches": [{
                    "envKey": "OPENAI_API_KEY",
                    "action": "set",
                    "value": "sk-native-status-secret",
                }],
            }),
        ));

        let response = only_response(&result);
        assert!(response.ok);
        assert_eq!(response.result.as_ref().unwrap()["runtimeId"], "codex");
        assert_eq!(
            response.result.as_ref().unwrap()["authMethod"],
            "openai-api-key"
        );
        assert_eq!(response.result.as_ref().unwrap()["authReady"], true);
        assert!(result.outputs.iter().any(|output| {
            matches!(output, RpcOutput::Event(event) if event.event_name == AI_RUNTIME_STATUS_EVENT)
        }));

        let encoded = fs::read_to_string(temp_dir.path().join("ai").join("runtime-setup.json"))
            .expect("runtime setup");
        assert!(!encoded.contains("sk-native-status-secret"));
    }

    #[test]
    fn ai_save_runtime_settings_rolls_back_secret_patch_failure() {
        let temp_dir = TempDir::new().expect("temp dir");
        let secrets = Arc::new(FailingSetSecretStore::new("CODEX_API_KEY"));
        secrets.seed("codex", "OPENAI_API_KEY", "old-openai");
        let secret_store: Arc<dyn RuntimeSecretStore> = secrets.clone();
        let store = RuntimeSetupStore::with_secret_store(
            temp_dir.path().join("runtime-setup.json"),
            secret_store,
        );

        let result = apply_runtime_settings(
            &store,
            native_ai::NativeAiSaveRuntimeSettingsInput {
                runtime_id: RuntimeId("codex".to_string()),
                settings: native_ai::NativeAiRuntimeSettingsPatch {
                    auth_method: Some("codex-api-key".to_string()),
                    ..native_ai::NativeAiRuntimeSettingsPatch::default()
                },
                secret_patches: vec![
                    native_ai::NativeAiSecretPatch {
                        env_key: "OPENAI_API_KEY".to_string(),
                        action: native_ai::NativeSecretPatchAction::Set,
                        value: Some("new-openai".to_string()),
                    },
                    native_ai::NativeAiSecretPatch {
                        env_key: "CODEX_API_KEY".to_string(),
                        action: native_ai::NativeSecretPatchAction::Set,
                        value: Some("new-codex".to_string()),
                    },
                ],
            },
        );

        assert!(result.is_err());
        assert_eq!(
            secrets
                .get_secret("codex", "OPENAI_API_KEY")
                .expect("secret")
                .as_deref(),
            Some("old-openai")
        );
        assert_eq!(
            secrets
                .get_secret("codex", "CODEX_API_KEY")
                .expect("secret"),
            None
        );
        assert!(!temp_dir.path().join("runtime-setup.json").exists());
    }

    #[test]
    fn handles_native_tree_read_and_write_commands() {
        let (temp_dir, mut backend, project_id) = backend_with_registered_project();
        let project_path = temp_dir.path().join("project-native");
        fs::create_dir_all(project_path.join("src")).expect("src");
        fs::write(project_path.join("src/main.rs"), "fn main() {}\n").expect("file");

        let tree_result = backend.handle_request(request(
            "project_list_tree_children",
            json!({
                "projectId": project_id,
                "worktreeId": null,
                "parentRelativePath": null,
            }),
        ));
        let tree_response = only_response(&tree_result);
        assert!(tree_response.ok);
        let tree_entries = tree_response.result.as_ref().unwrap()["entries"]
            .as_array()
            .unwrap();
        assert_eq!(tree_entries[0]["name"], "src");
        assert_eq!(tree_entries[0]["hasChildren"], true);

        let read_result = backend.handle_request(request(
            "fs_read_file",
            json!({
                "projectId": project_id,
                "worktreeId": null,
                "relativePath": "src/main.rs",
            }),
        ));
        let read_response = only_response(&read_result);
        assert!(read_response.ok);
        assert_eq!(
            read_response.result.as_ref().unwrap()["content"],
            "fn main() {}\n"
        );
        let content_hash = read_response.result.as_ref().unwrap()["contentHash"]
            .as_str()
            .unwrap()
            .to_string();

        let write_result = backend.handle_request(request(
            "fs_write_file",
            json!({
                "projectId": project_id,
                "worktreeId": null,
                "relativePath": "src/main.rs",
                "content": "fn main() { println!(\"hi\"); }\n",
                "expectedContentHash": content_hash,
                "origin": "user",
            }),
        ));
        let write_response = only_response(&write_result);
        assert!(write_response.ok);
        assert_eq!(
            write_response.result.as_ref().unwrap()["file"]["content"],
            "fn main() { println!(\"hi\"); }\n"
        );
        assert!(write_result.outputs.iter().any(|output| {
            matches!(output, RpcOutput::Event(event) if event.event_name == "project://tree-invalidated")
        }));
    }

    #[test]
    fn handles_native_create_rename_delete_commands() {
        let (temp_dir, mut backend, project_id) = backend_with_registered_project();
        let project_path = temp_dir.path().join("project-native");
        fs::create_dir_all(project_path.join("src")).expect("src");

        let create_result = backend.handle_request(request(
            "fs_create_file",
            json!({
                "projectId": project_id,
                "worktreeId": null,
                "parentRelativePath": "src",
                "name": "new.ts",
                "kind": "file",
                "origin": "user",
            }),
        ));
        let create_response = only_response(&create_result);
        assert!(create_response.ok);
        assert_eq!(
            create_response.result.as_ref().unwrap()["relativePath"],
            "src/new.ts"
        );
        assert!(project_path.join("src/new.ts").exists());

        let rename_result = backend.handle_request(request(
            "fs_rename_entry",
            json!({
                "projectId": project_id,
                "worktreeId": null,
                "relativePath": "src/new.ts",
                "nextName": "renamed.ts",
                "origin": "user",
            }),
        ));
        let rename_response = only_response(&rename_result);
        assert!(rename_response.ok);
        assert_eq!(
            rename_response.result.as_ref().unwrap()["relativePath"],
            "src/renamed.ts"
        );

        let delete_result = backend.handle_request(request(
            "fs_delete_entry",
            json!({
                "projectId": project_id,
                "worktreeId": null,
                "relativePath": "src/renamed.ts",
                "origin": "user",
            }),
        ));
        assert!(only_response(&delete_result).ok);
        assert!(!project_path.join("src/renamed.ts").exists());
    }

    #[test]
    fn handles_native_index_list_search_and_status_commands() {
        let (temp_dir, mut backend, project_id) = backend_with_registered_project();
        let project_path = temp_dir.path().join("project-native");
        fs::create_dir_all(project_path.join("src")).expect("src");
        fs::write(project_path.join("src/main.ts"), "console.log('hi');\n").expect("main");
        fs::write(project_path.join(".env"), "APP=1\n").expect("env");

        let list_result = backend.handle_request(request(
            "project_list_entries",
            json!({
                "projectId": project_id,
                "worktreeId": null,
            }),
        ));
        let list_response = only_response(&list_result);
        assert!(list_response.ok);
        let entries = list_response.result.as_ref().unwrap()["entries"]
            .as_array()
            .unwrap();
        assert!(entries.iter().any(|entry| entry["relativePath"] == ".env"));
        assert!(list_result.outputs.iter().any(|output| {
            matches!(output, RpcOutput::Event(event) if event.event_name == "index://ready")
        }));

        let search_result = backend.handle_request(request(
            "project_search_entries",
            json!({
                "projectId": project_id,
                "worktreeId": null,
                "query": "main",
                "includeAncestorDirectories": true,
                "limit": 10,
            }),
        ));
        let search_response = only_response(&search_result);
        assert!(search_response.ok);
        assert_eq!(
            search_response.result.as_ref().unwrap()["entries"][0]["relativePath"],
            "src"
        );
        assert_eq!(
            search_response.result.as_ref().unwrap()["matches"][0]["entry"]["relativePath"],
            "src/main.ts"
        );

        let status_result = backend.handle_request(request(
            "index_get_status",
            json!({
                "projectId": project_id,
                "worktreeId": null,
            }),
        ));
        let status_response = only_response(&status_result);
        assert!(status_response.ok);
        assert_eq!(status_response.result.as_ref().unwrap()["status"], "ready");
    }

    #[test]
    fn background_search_empty_query_does_not_build_index() {
        let (temp_dir, mut backend, project_id) = backend_with_registered_project();
        let project_path = temp_dir.path().join("project-native");
        fs::write(project_path.join("main.ts"), "console.log('hi');\n").expect("main");
        let (sender, receiver) = mpsc::sync_channel(16);

        let search_result = backend.handle_request_background(
            request(
                "project_search_entries",
                json!({
                    "projectId": project_id,
                    "worktreeId": null,
                    "query": "",
                    "includeAncestorDirectories": true,
                    "limit": 10,
                    "contextKey": "test-empty",
                }),
            ),
            sender,
        );
        let search_response = only_response(&search_result);

        assert!(search_response.ok);
        assert_eq!(
            search_response.result.as_ref().unwrap()["entries"],
            json!([])
        );
        assert_eq!(
            search_response.result.as_ref().unwrap()["matches"],
            json!([])
        );
        assert_eq!(search_response.result.as_ref().unwrap()["status"], "idle");
        assert!(search_result.outputs.iter().all(|output| {
            !matches!(
                output,
                RpcOutput::Event(event)
                    if matches!(event.event_name.as_str(), "index://building" | "index://ready")
            )
        }));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn handles_native_index_update_drop_content_and_cancel_commands() {
        let (temp_dir, mut backend, project_id) = backend_with_registered_project();
        let project_path = temp_dir.path().join("project-native");
        fs::write(project_path.join("old.ts"), "old").expect("old");
        assert!(
            only_response(&backend.handle_request(request(
                "project_list_entries",
                json!({
                    "projectId": project_id,
                    "worktreeId": null,
                }),
            )))
            .ok
        );

        fs::write(project_path.join("new.ts"), "new").expect("new");
        let update_result = backend.handle_request(request(
            "index_update_entries",
            json!({
                "projectId": project_id,
                "worktreeId": null,
                "kind": "created",
                "relativePaths": ["new.ts"],
            }),
        ));
        assert!(only_response(&update_result).ok);
        assert!(update_result.outputs.iter().any(|output| {
            matches!(output, RpcOutput::Event(event) if event.event_name == "index://updated")
        }));

        let content_result = backend.handle_request(request(
            "search_project_content",
            json!({
                "projectId": project_id,
                "worktreeId": null,
                "query": "new",
                "limit": 10,
            }),
        ));
        let content_response = only_response(&content_result);
        assert!(!content_response.ok);
        assert_eq!(
            content_response
                .error
                .as_ref()
                .map(|error| error.code.as_str()),
            Some("not_supported")
        );

        let cancel_result = backend.handle_request(request(
            "search_cancel",
            json!({
                "operationId": "operation_missing",
            }),
        ));
        let cancel_response = only_response(&cancel_result);
        assert!(cancel_response.ok);
        assert_eq!(cancel_response.result.as_ref().unwrap()["cancelled"], false);

        let drop_result = backend.handle_request(request(
            "index_drop_project",
            json!({
                "projectId": project_id,
                "worktreeId": null,
            }),
        ));
        let drop_response = only_response(&drop_result);
        assert!(drop_response.ok);
        assert_eq!(drop_response.result.as_ref().unwrap()["dropped"], true);
    }

    #[test]
    fn index_rebuild_honors_custom_policy_limits() {
        let (temp_dir, mut backend, project_id) = backend_with_registered_project();
        let project_path = temp_dir.path().join("project-native");
        fs::write(project_path.join("a.ts"), "a").expect("a");
        fs::write(project_path.join("b.ts"), "b").expect("b");

        let rebuild_result = backend.handle_request(request(
            "index_rebuild_project",
            json!({
                "projectId": project_id,
                "worktreeId": null,
                "policy": {
                    "includeDotfiles": true,
                    "includeHidden": true,
                    "followSymlinks": false,
                    "maxEntries": 1,
                    "maxDepth": null,
                },
            }),
        ));
        let rebuild_response = only_response(&rebuild_result);

        assert!(rebuild_response.ok);
        assert_eq!(
            rebuild_response.result.as_ref().unwrap()["status"]["status"],
            "stale"
        );
        assert!(rebuild_result.outputs.iter().any(|output| {
            matches!(output, RpcOutput::Event(event) if event.event_name == "index://stale")
        }));
    }

    fn only_response(result: &CommandResult) -> &comando_types::protocol::NativeRpcResponse {
        let Some(RpcOutput::Response(response)) = result.outputs.first() else {
            panic!("expected first output to be a response");
        };
        response
    }

    fn backend_with_registered_project() -> (TempDir, NativeBackend, String) {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("comando.sqlite3");
        let project_path = temp_dir.path().join("project-native");
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
        assert!(only_response(&open_result).ok);

        let add_result = backend.handle_request(request(
            "project_add",
            json!({
                "projectPaths": [project_path],
                "ownerWindowId": null,
            }),
        ));
        let add_response = only_response(&add_result);
        assert!(add_response.ok);
        let project_id = add_response.result.as_ref().unwrap()["projectIdsToOpen"][0]
            .as_str()
            .unwrap()
            .to_string();

        (temp_dir, backend, project_id)
    }

    fn backend_with_memory_runtime_setup() -> (TempDir, NativeBackend) {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("comando.sqlite3");
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

        let setup_store = RuntimeSetupStore::in_memory_for_tests(
            temp_dir.path().join("ai").join("runtime-setup.json"),
        );
        backend
            .ai_engine
            .set_runtime_setup_store(Some(setup_store.clone()))
            .expect("runtime setup store");
        backend.runtime_setup_store = Some(setup_store);
        (temp_dir, backend)
    }

    struct FailingSetSecretStore {
        inner: InMemoryRuntimeSecretStore,
        fail_env_key: String,
    }

    impl FailingSetSecretStore {
        fn new(fail_env_key: &str) -> Self {
            Self {
                inner: InMemoryRuntimeSecretStore::default(),
                fail_env_key: fail_env_key.to_string(),
            }
        }

        fn seed(&self, runtime_id: &str, env_key: &str, value: &str) {
            self.inner
                .set_secret(runtime_id, env_key, value)
                .expect("seed secret");
        }
    }

    impl RuntimeSecretStore for FailingSetSecretStore {
        fn get_secret(
            &self,
            runtime_id: &str,
            env_key: &str,
        ) -> Result<Option<String>, SecretStoreError> {
            self.inner.get_secret(runtime_id, env_key)
        }

        fn set_secret(
            &self,
            runtime_id: &str,
            env_key: &str,
            value: &str,
        ) -> Result<(), SecretStoreError> {
            if env_key == self.fail_env_key {
                return Err(SecretStoreError::WriteFailed("forced failure".to_string()));
            }
            self.inner.set_secret(runtime_id, env_key, value)
        }

        fn delete_secret(&self, runtime_id: &str, env_key: &str) -> Result<(), SecretStoreError> {
            self.inner.delete_secret(runtime_id, env_key)
        }

        fn status(&self) -> native_ai::NativeSecretStorageStatus {
            self.inner.status()
        }
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
