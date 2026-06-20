use std::env;
use std::sync::mpsc;
use std::thread;

use comando_ai::AiEngine;
use comando_ai::events::{
    AI_RUNTIME_STATUS_EVENT, AI_SESSION_CLOSED_EVENT, AI_SESSION_CREATED_EVENT,
    AI_SESSION_UPDATED_EVENT, AiRuntimeEvent, session_closed, session_created, session_updated,
};
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
use comando_terminal::{TerminalRuntimeEvent, TerminalService};
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
use comando_types::projects::{NativeProjectAddInput, NativeProjectState};
use comando_types::{
    ai as native_ai, fs as native_fs, git as native_git, index as native_index,
    projects as native_projects, terminal as native_terminal,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::protocol::{RpcOutput, RpcRequest, error_response, event, response_ok};

#[derive(Debug, Clone, PartialEq)]
pub struct CommandResult {
    pub outputs: Vec<RpcOutput>,
    pub should_shutdown: bool,
}

#[derive(Default)]
pub struct NativeBackend {
    ai_engine: AiEngine,
    ai_event_bridge_started: bool,
    fs_service: ProjectFsService,
    git_runner: GitRunner,
    index_service: IndexService,
    persistence_store: Option<SqlitePersistenceStore>,
    terminal_service: Option<TerminalService>,
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
            | "ai_prepare_session"
            | "ai_send_prompt"
            | "ai_cancel_session"
            | "ai_close_session"
            | "ai_respond_permission"
            | "ai_respond_user_input"
            | "ai_set_session_model"
            | "ai_set_session_mode"
            | "ai_set_session_config_option" => {
                if let Err(error) = self.ensure_ai_event_bridge(background_sender) {
                    return error_only(request.id, error);
                }
                self.handle_ai_request(request)
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
            | "ai_prepare_session"
            | "ai_send_prompt"
            | "ai_cancel_session"
            | "ai_close_session"
            | "ai_respond_permission"
            | "ai_respond_user_input"
            | "ai_set_session_model"
            | "ai_set_session_mode"
            | "ai_set_session_config_option" => self.handle_ai_request(request),
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

    fn ensure_terminal_service(
        &mut self,
        background_sender: mpsc::SyncSender<Vec<RpcOutput>>,
    ) -> &TerminalService {
        self.terminal_service.get_or_insert_with(|| {
            let (event_sender, event_receiver) =
                mpsc::sync_channel::<TerminalRuntimeEvent>(Self::TERMINAL_EVENT_CHANNEL_CAPACITY);
            thread::spawn(move || {
                for event in event_receiver {
                    let output = terminal_runtime_event_output(event);
                    if background_sender.send(vec![output]).is_err() {
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
        thread::spawn(move || {
            for event in event_receiver {
                let output = ai_runtime_event_output(event);
                if background_sender.send(vec![output]).is_err() {
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
