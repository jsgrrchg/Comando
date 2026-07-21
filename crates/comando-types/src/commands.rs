pub const BACKEND_PING: &str = "backend_ping";
pub const BACKEND_HANDSHAKE: &str = "backend_handshake";
pub const BACKEND_CAPABILITIES: &str = "backend_capabilities";
pub const BACKEND_SHUTDOWN: &str = "backend_shutdown";
pub const BACKEND_EMIT_TEST_EVENT: &str = "backend_emit_test_event";
pub const PERSISTENCE_OPEN_STORE: &str = "persistence_open_store";
pub const PERSISTENCE_GET_STORAGE_HEALTH: &str = "persistence_get_storage_health";
pub const PERSISTENCE_GET_SNAPSHOT: &str = "persistence_get_snapshot";
pub const APP_DATA_GET_JSON: &str = "app_data_get_json";
pub const APP_DATA_SET_JSON: &str = "app_data_set_json";
pub const APP_SECRET_GET: &str = "app_secret_get";
pub const APP_SECRET_SET: &str = "app_secret_set";
pub const APP_SECRET_DELETE: &str = "app_secret_delete";
pub const SETTINGS_GET_SNAPSHOT: &str = "settings_get_snapshot";
pub const SETTINGS_SAVE_SNAPSHOT: &str = "settings_save_snapshot";
pub const SETTINGS_GET_PROJECT: &str = "settings_get_project";
pub const SETTINGS_SAVE_PROJECT: &str = "settings_save_project";
pub const PROJECT_LIST: &str = "project_list";
pub const PROJECT_ADD: &str = "project_add";
pub const PROJECT_SYNC_WORKTREES: &str = "project_sync_worktrees";
pub const PROJECT_REMOVE: &str = "project_remove";
pub const PROJECT_TOUCH: &str = "project_touch";
pub const PROJECT_RELOCATE: &str = "project_relocate";
pub const PROJECT_GET_APP_DATA_SUMMARY: &str = "project_get_app_data_summary";
pub const PROJECT_CLEAR_APP_DATA: &str = "project_clear_app_data";

pub const BACKEND_COMMANDS: &[&str] = &[
    BACKEND_PING,
    BACKEND_HANDSHAKE,
    BACKEND_CAPABILITIES,
    BACKEND_SHUTDOWN,
    BACKEND_EMIT_TEST_EVENT,
];

pub const PERSISTENCE_COMMANDS: &[&str] = &[
    PERSISTENCE_OPEN_STORE,
    PERSISTENCE_GET_STORAGE_HEALTH,
    PERSISTENCE_GET_SNAPSHOT,
    APP_DATA_GET_JSON,
    APP_DATA_SET_JSON,
    APP_SECRET_GET,
    APP_SECRET_SET,
    APP_SECRET_DELETE,
];

pub const PROJECT_COMMANDS: &[&str] = &[
    PROJECT_LIST,
    PROJECT_ADD,
    PROJECT_SYNC_WORKTREES,
    PROJECT_REMOVE,
    PROJECT_TOUCH,
    PROJECT_RELOCATE,
    PROJECT_GET_APP_DATA_SUMMARY,
    PROJECT_CLEAR_APP_DATA,
    "project_open",
    "project_refresh",
    "project_list_tree_children",
    "project_list_entries",
    "project_search_entries",
];

pub const FS_COMMANDS: &[&str] = &[
    "fs_read_file",
    "fs_write_file",
    "fs_create_file",
    "fs_create_directory",
    "fs_rename_entry",
    "fs_delete_entry",
    "fs_copy_entries",
    "fs_copy_external_entries",
    "fs_record_external_mutation",
    "fs_reveal_entry_info",
    "fs_watch_start",
    "fs_watch_stop",
    "fs_watch_sync_registry",
];

pub const INDEX_COMMANDS: &[&str] = &[
    "index_rebuild_project",
    "index_update_entries",
    "index_get_status",
    "index_drop_project",
    "search_project_entries",
    "search_project_content",
    "search_cancel",
];

pub const GIT_COMMANDS: &[&str] = &[
    "git_resolve_repository",
    "git_get_repository_snapshot",
    "git_get_status",
    "git_get_diff",
    "git_get_file_diff",
    "git_get_original_file",
    "git_get_history",
    "git_get_commit_detail",
    "git_list_branches",
    "git_list_worktrees",
    "git_list_remotes",
    "git_get_diff_stats",
    "git_list_worktree_diff",
    "git_init_repository",
    "git_clone_repository",
    "git_stage_paths",
    "git_unstage_paths",
    "git_discard_paths",
    "git_commit",
    "git_checkout_branch",
    "git_create_branch",
    "git_delete_local_branch",
    "git_create_worktree",
    "git_remove_worktree",
    "git_fetch",
    "git_pull",
    "git_push",
    "git_delete_remote_branch",
];

pub const TERMINAL_COMMANDS: &[&str] = &[
    "terminal_create",
    "terminal_write",
    "terminal_resize",
    "terminal_kill",
    "terminal_close",
    "terminal_close_window",
    "terminal_list",
];

pub const SETTINGS_COMMANDS: &[&str] = &[
    SETTINGS_GET_SNAPSHOT,
    SETTINGS_SAVE_SNAPSHOT,
    SETTINGS_GET_PROJECT,
    SETTINGS_SAVE_PROJECT,
    "secret_set",
    "secret_delete",
    "secret_status",
];

pub const AI_COMMANDS: &[&str] = &[
    "ai_list_runtimes",
    "ai_get_runtime_status",
    "ai_save_runtime_settings",
    "ai_launch_runtime_auth",
    "ai_disconnect_runtime_auth",
    "ai_logout_runtime_auth",
    "ai_prepare_session",
    "ai_send_prompt",
    "ai_cancel_session",
    "ai_close_session",
    "ai_respond_permission",
    "ai_respond_user_input",
    "ai_set_session_model",
    "ai_set_session_mode",
    "ai_set_session_config_option",
    "ai_rename_session",
    "ai_list_session_history",
    "ai_load_session_transcript_page",
    "ai_append_transcript_entries",
    "ai_checkpoint_open_transcript_tail",
    "ai_load_open_transcript_tail",
    "ai_seal_transcript_turn",
    "ai_load_transcript_block_metadata",
    "ai_load_transcript_block",
    "ai_load_transcript_payload",
    "ai_load_transcript_payloads",
    "ai_get_transcript_storage_state",
    "ai_load_session_snapshot",
    "ai_list_session_runtime_mappings",
    "ai_set_session_pinned",
    "ai_delete_session",
    "ai_migrate_session_history",
    "ai_get_history_storage_health",
    "ai_capture_review_baseline",
    "ai_reject_tracked_file",
    "ai_reject_tracked_file_hunks",
    "ai_reject_all_tracked_files",
    "ai_notify_file_buffer",
];

pub const REVIEW_COMMANDS: &[&str] = &[];

pub fn all_commands() -> Vec<&'static str> {
    [
        BACKEND_COMMANDS,
        PERSISTENCE_COMMANDS,
        PROJECT_COMMANDS,
        FS_COMMANDS,
        INDEX_COMMANDS,
        GIT_COMMANDS,
        TERMINAL_COMMANDS,
        SETTINGS_COMMANDS,
        AI_COMMANDS,
        REVIEW_COMMANDS,
    ]
    .concat()
}
