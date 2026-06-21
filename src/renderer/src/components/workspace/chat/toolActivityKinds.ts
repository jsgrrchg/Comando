import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";

/**
 * Single source of truth for classifying an AiToolActivity into the card shape
 * it renders as: terminal, file, or turn-started divider.
 *
 * Both the renderer (ToolActivityItem, which picks the component to paint) and
 * the virtual-list height estimator (chatTimelineVirtualization, which predicts
 * a row's height from the branch it expects the renderer to take) MUST agree on
 * this classification. When they disagree, the estimator sizes a row against the
 * wrong branch and the scroll jumps as the real card scrolls into view. Keeping
 * the taxonomy here — rather than copied into each consumer — makes that drift
 * impossible by construction.
 *
 * Note this only unifies the CLASSIFICATION. The estimator's per-branch pixel
 * heights stay in chatTimelineVirtualization, where they belong.
 */

// Tool kinds that render as a terminal card (command + captured output).
export const TERMINAL_TOOL_KINDS = new Set(["bash", "shell", "execute"]);

// Tool kinds that touch files and render as a file card.
export const FILE_TOOL_KINDS = new Set([
    "create",
    "delete",
    "edit",
    "move",
    "read",
    "read_file",
    "remove",
    "rename",
    "search",
    "update",
    "write",
]);

// Activity-id prefixes the agents use to mark the start of a turn, which renders
// as a divider rather than a tool card.
const TURN_STARTED_ACTIVITY_ID_PREFIXES = [
    "codex-acp:status:turn:",
    "comando:status:turn:",
];

export function isTurnStartedActivity(activity: AiToolActivity): boolean {
    return TURN_STARTED_ACTIVITY_ID_PREFIXES.some((prefix) =>
        activity.id.startsWith(prefix),
    );
}

export function isTerminalToolActivity(activity: AiToolActivity): boolean {
    return TERMINAL_TOOL_KINDS.has(activity.kind.toLowerCase());
}

export function isFileToolActivity(
    activity: AiToolActivity,
    trackedFiles: readonly AiTrackedFile[],
): boolean {
    return (
        trackedFiles.length > 0 ||
        FILE_TOOL_KINDS.has(activity.kind.toLowerCase()) ||
        activity.locations.length > 0 ||
        activity.diffs.length > 0
    );
}
