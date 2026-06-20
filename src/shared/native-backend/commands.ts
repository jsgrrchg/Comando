export const NATIVE_BACKEND_COMMANDS = [
    "backend_ping",
    "backend_handshake",
    "backend_capabilities",
    "backend_shutdown",
    "backend_emit_test_event",
] as const;

export const NATIVE_PERSISTENCE_COMMANDS = [
    "persistence_open_store",
    "persistence_get_storage_health",
    "persistence_get_snapshot",
    "persistence_save_workspace",
    "persistence_load_workspace",
    "persistence_list_projects",
] as const;

export const NATIVE_PROJECT_COMMANDS = [
    "project_list",
    "project_add",
    "project_remove",
    "project_open",
    "project_refresh",
    "project_list_entries",
    "project_search_entries",
] as const;

export const NATIVE_FS_COMMANDS = [
    "fs_read_file",
    "fs_write_file",
    "fs_create_file",
    "fs_create_directory",
    "fs_rename_entry",
    "fs_delete_entry",
    "fs_reveal_entry_info",
    "fs_watch_start",
    "fs_watch_stop",
] as const;

export const NATIVE_INDEX_COMMANDS = [
    "index_rebuild_project",
    "index_update_entries",
    "search_project_entries",
    "search_project_content",
    "search_cancel",
] as const;

export const NATIVE_GIT_COMMANDS = [
    "git_get_status",
    "git_get_diff",
    "git_get_file_diff",
    "git_get_history",
    "git_list_branches",
    "git_checkout_branch",
    "git_create_branch",
    "git_list_worktrees",
    "git_create_worktree",
    "git_remove_worktree",
    "git_stage_paths",
    "git_unstage_paths",
] as const;

export const NATIVE_TERMINAL_COMMANDS = [
    "terminal_create",
    "terminal_write",
    "terminal_resize",
    "terminal_kill",
    "terminal_close",
    "terminal_list",
] as const;

export const NATIVE_SETTINGS_COMMANDS = [
    "settings_get_snapshot",
    "settings_save_snapshot",
    "settings_get_project",
    "settings_save_project",
    "secret_get",
    "secret_set",
    "secret_delete",
    "secret_status",
] as const;

export const NATIVE_AI_COMMANDS = [
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
    "ai_keep_tracked_file",
    "ai_reject_tracked_file",
    "ai_keep_tracked_file_hunks",
    "ai_reject_tracked_file_hunks",
    "ai_keep_all_tracked_files",
    "ai_reject_all_tracked_files",
    "ai_notify_file_buffer",
    "ai_refresh_project_scopes",
] as const;

export const NATIVE_REVIEW_COMMANDS = [
    "review_get_state",
    "review_keep_file",
    "review_reject_file",
    "review_keep_hunks",
    "review_reject_hunks",
    "review_keep_all",
    "review_reject_all",
] as const;

export const NATIVE_COMMANDS = [
    ...NATIVE_BACKEND_COMMANDS,
    ...NATIVE_PERSISTENCE_COMMANDS,
    ...NATIVE_PROJECT_COMMANDS,
    ...NATIVE_FS_COMMANDS,
    ...NATIVE_INDEX_COMMANDS,
    ...NATIVE_GIT_COMMANDS,
    ...NATIVE_TERMINAL_COMMANDS,
    ...NATIVE_SETTINGS_COMMANDS,
    ...NATIVE_AI_COMMANDS,
    ...NATIVE_REVIEW_COMMANDS,
] as const;

export type NativeKnownCommandName = (typeof NATIVE_COMMANDS)[number];
