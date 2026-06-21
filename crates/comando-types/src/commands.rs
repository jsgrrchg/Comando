pub const BACKEND_PING: &str = "backend_ping";
pub const BACKEND_HANDSHAKE: &str = "backend_handshake";
pub const BACKEND_CAPABILITIES: &str = "backend_capabilities";
pub const BACKEND_SHUTDOWN: &str = "backend_shutdown";
pub const BACKEND_EMIT_TEST_EVENT: &str = "backend_emit_test_event";
pub const PERSISTENCE_OPEN_STORE: &str = "persistence_open_store";
pub const PERSISTENCE_GET_STORAGE_HEALTH: &str = "persistence_get_storage_health";
pub const PERSISTENCE_GET_SNAPSHOT: &str = "persistence_get_snapshot";
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
    "persistence_save_workspace",
    "persistence_load_workspace",
    "persistence_list_projects",
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
    "settings_get_snapshot",
    "settings_save_snapshot",
    "settings_get_project",
    "settings_save_project",
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
    "ai_freeze_session",
    "ai_respond_permission",
    "ai_respond_user_input",
    "ai_set_session_model",
    "ai_set_session_mode",
    "ai_set_session_config_option",
    "ai_rename_session",
    "ai_list_session_history",
    "ai_load_session_transcript_page",
    "ai_load_session_snapshot",
    "ai_list_session_runtime_mappings",
    "ai_set_session_pinned",
    "ai_delete_session",
    "ai_migrate_session_history",
    "ai_get_history_storage_health",
    "ai_capture_review_baseline",
    "ai_reconcile_tracked_files",
    "ai_list_tracked_files",
    "ai_load_review_state",
    "ai_keep_tracked_file",
    "ai_reject_tracked_file",
    "ai_keep_tracked_file_hunks",
    "ai_reject_tracked_file_hunks",
    "ai_keep_all_tracked_files",
    "ai_reject_all_tracked_files",
    "ai_notify_file_buffer",
    "ai_refresh_project_scopes",
];

pub const REVIEW_COMMANDS: &[&str] = &[
    "review_get_state",
    "review_keep_file",
    "review_reject_file",
    "review_keep_hunks",
    "review_reject_hunks",
    "review_keep_all",
    "review_reject_all",
];

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
