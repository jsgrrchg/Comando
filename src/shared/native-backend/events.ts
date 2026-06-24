export const NATIVE_BACKEND_EVENTS = [
    "backend://ready",
    "backend://test-event",
    "backend://error",
    "backend://performance-sample",
] as const;

export const NATIVE_PROJECT_FS_INDEX_EVENTS = [
    "project://updated",
    "project://registry-parity-mismatch",
    "project://error",
    "project://tree-invalidated",
    "fs://entry-created",
    "fs://entry-updated",
    "fs://entry-deleted",
    "fs://entry-renamed",
    "fs://watch-error",
    "fs://watch-started",
    "fs://watch-stopped",
    "fs://operation-error",
    "fs://origin-tracked",
    "index://building",
    "index://ready",
    "index://updated",
    "index://stale",
    "index://error",
    "index://cancelled",
    "index://progress",
] as const;

export const NATIVE_GIT_EVENTS = [
    "git://repository-invalidated",
    // Reserved protocol events; repository-invalidated is the active producer today.
    "git://snapshot-updated",
    "git://worktrees-updated",
    "git://operation-error",
] as const;

export const NATIVE_TERMINAL_EVENTS = [
    "terminal://created",
    "terminal://data",
    "terminal://exit",
    "terminal://closed",
    "terminal://error",
] as const;

export const NATIVE_AI_EVENTS = [
    "ai://runtime-status",
    "ai://session-created",
    "ai://session-updated",
    "ai://session-closed",
    "ai://session-catalog-updated",
    "ai://subagent-created",
    "ai://subagent-breadcrumb",
    "ai://message-started",
    "ai://message-delta",
    "ai://message-completed",
    "ai://thinking-started",
    "ai://thinking-delta",
    "ai://thinking-completed",
    "ai://image-generation",
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
] as const;

export const NATIVE_PERSISTENCE_SETTINGS_EVENTS = [
    "persistence://storage-opened",
    "persistence://storage-health",
    "persistence://snapshot-updated",
    "settings://updated",
    "settings://project-updated",
    "secret://status-updated",
] as const;

export const NATIVE_EVENTS = [
    ...NATIVE_BACKEND_EVENTS,
    ...NATIVE_PROJECT_FS_INDEX_EVENTS,
    ...NATIVE_GIT_EVENTS,
    ...NATIVE_TERMINAL_EVENTS,
    ...NATIVE_AI_EVENTS,
    ...NATIVE_PERSISTENCE_SETTINGS_EVENTS,
] as const;

export type NativeKnownEventName = (typeof NATIVE_EVENTS)[number];
