import {
    isEditedFileToolActivity,
    isStatusToolActivity,
    isTurnStartedActivity,
} from "./toolActivityKinds";
import type { ToolActivityReviewEntry } from "./toolActivityReviewModel";

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

    // ACP runtimes can introduce successful tool kinds without a renderer
    // release. Unknown routine work belongs in the collapsed activity rail;
    // only changes, failures, and user-facing actions need their own card.
    return "groupable";
}
