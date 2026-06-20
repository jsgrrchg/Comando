pub const BACKEND_READY: &str = "backend://ready";
pub const BACKEND_TEST_EVENT: &str = "backend://test-event";
pub const BACKEND_ERROR: &str = "backend://error";
pub const BACKEND_PERFORMANCE_SAMPLE: &str = "backend://performance-sample";

pub const BACKEND_EVENTS: &[&str] = &[
    BACKEND_READY,
    BACKEND_TEST_EVENT,
    BACKEND_ERROR,
    BACKEND_PERFORMANCE_SAMPLE,
];

pub const PROJECT_FS_INDEX_EVENTS: &[&str] = &[
    "project://updated",
    "project://registry-parity-mismatch",
    "project://error",
    "project://tree-invalidated",
    "fs://entry-created",
    "fs://entry-updated",
    "fs://entry-deleted",
    "fs://entry-renamed",
    "fs://watch-error",
    "index://ready",
    "index://updated",
    "index://error",
];

pub const GIT_EVENTS: &[&str] = &[
    "git://repository-invalidated",
    "git://snapshot-updated",
    "git://worktrees-updated",
    "git://operation-error",
];

pub const TERMINAL_EVENTS: &[&str] = &[
    "terminal://created",
    "terminal://data",
    "terminal://exit",
    "terminal://closed",
    "terminal://error",
];

pub const AI_EVENTS: &[&str] = &[
    "ai://runtime-status",
    "ai://session-created",
    "ai://session-updated",
    "ai://session-closed",
    "ai://message-started",
    "ai://message-delta",
    "ai://message-completed",
    "ai://thinking-started",
    "ai://thinking-delta",
    "ai://thinking-completed",
    "ai://tool-activity",
    "ai://status-event",
    "ai://plan-updated",
    "ai://permission-request",
    "ai://user-input-request",
    "ai://token-usage",
    "ai://review-updated",
    "ai://tracked-file-updated",
    "ai://runtime-connection",
    "ai://error",
];

pub const PERSISTENCE_SETTINGS_EVENTS: &[&str] = &[
    "persistence://storage-opened",
    "persistence://storage-health",
    "persistence://snapshot-updated",
    "settings://updated",
    "settings://project-updated",
    "secret://status-updated",
];

pub fn all_events() -> Vec<&'static str> {
    [
        BACKEND_EVENTS,
        PROJECT_FS_INDEX_EVENTS,
        GIT_EVENTS,
        TERMINAL_EVENTS,
        AI_EVENTS,
        PERSISTENCE_SETTINGS_EVENTS,
    ]
    .concat()
}
