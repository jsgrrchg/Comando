import {
    isEditedFileToolActivity,
    isStatusToolActivity,
    isTerminalToolActivity,
    isTurnStartedActivity,
} from "./toolActivityKinds";
import type { ToolActivityReviewEntry } from "./toolActivityReviewModel";

const GROUPABLE_OBSERVATION_TOOL_KINDS = new Set([
    "fetch",
    "find",
    "glob",
    "grep",
    "list",
    "read",
    "read_file",
    "search",
]);

export type ToolActivityPresentationPolicy =
    | "groupable"
    | "standalone-change"
    | "standalone-attention"
    | "standalone-unknown"
    | "structural";

export interface ToolActivityPresentationContext {
    readonly attentionToolCallIds: ReadonlySet<string>;
}

function isStructuralActivity(entry: ToolActivityReviewEntry): boolean {
    const { activity } = entry;
    return isTurnStartedActivity(activity) || isStatusToolActivity(activity);
}

function requiresAttention(
    entry: ToolActivityReviewEntry,
    context: ToolActivityPresentationContext,
): boolean {
    const { activity } = entry;
    return (
        activity.status === "failed" ||
        (activity.exitCode !== null && activity.exitCode !== 0) ||
        activity.action != null ||
        context.attentionToolCallIds.has(activity.id)
    );
}

function isKnownGroupableActivity(entry: ToolActivityReviewEntry): boolean {
    const { activity } = entry;
    const kind = activity.kind.toLowerCase();

    if (GROUPABLE_OBSERVATION_TOOL_KINDS.has(kind)) {
        return true;
    }

    if (!isTerminalToolActivity(activity)) {
        return false;
    }

    return (
        activity.status === "pending" ||
        activity.status === "in_progress" ||
        (activity.status === "completed" && activity.exitCode === 0)
    );
}

export function getToolActivityPresentationPolicy(
    entry: ToolActivityReviewEntry,
    context: ToolActivityPresentationContext,
): ToolActivityPresentationPolicy {
    if (isStructuralActivity(entry)) {
        return "structural";
    }

    if (
        entry.hasPendingTrackedFiles ||
        isEditedFileToolActivity(entry.activity, entry.trackedFiles)
    ) {
        return "standalone-change";
    }

    if (requiresAttention(entry, context)) {
        return "standalone-attention";
    }

    if (isKnownGroupableActivity(entry)) {
        return "groupable";
    }

    return "standalone-unknown";
}
