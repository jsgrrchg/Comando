import { useMemo } from "react";

import type {
    AiSessionSnapshot,
    AiSessionStatus,
    AiToolActivity,
} from "@shared/ipc";

import { PlanMessage } from "../chat/PlanMessage";
import {
    deriveReviewItems,
    deriveReviewSummary,
    type ReviewFileItem,
} from "../review/editedFilesPresentationModel";
import { DiffStatBar } from "../review/ReviewFileRow";
import {
    computeDiffStats,
    formatDiffStat,
    getCompactPath,
    getFileNameFromPath,
} from "../review/reviewDiff";

interface HistorySessionArtifactsProps {
    readonly snapshot: AiSessionSnapshot;
}

export function HistorySessionArtifacts({
    snapshot,
}: HistorySessionArtifactsProps) {
    const trackedItems = useMemo(
        () => deriveReviewItems(snapshot.trackedFiles),
        [snapshot.trackedFiles],
    );
    const trackedSummary = useMemo(
        () => deriveReviewSummary(trackedItems),
        [trackedItems],
    );

    if (
        !snapshot.plan &&
        snapshot.toolActivity.length === 0 &&
        trackedItems.length === 0
    ) {
        return null;
    }

    return (
        <div className="space-y-3">
            {snapshot.plan ? <PlanMessage plan={snapshot.plan} /> : null}
            {snapshot.toolActivity.length > 0 ? (
                <HistoryToolActivitySection activities={snapshot.toolActivity} />
            ) : null}
            {trackedItems.length > 0 ? (
                <HistoryTrackedFilesSection
                    items={trackedItems}
                    status={snapshot.status}
                    summary={trackedSummary}
                />
            ) : null}
        </div>
    );
}

function HistoryToolActivitySection({
    activities,
}: {
    readonly activities: readonly AiToolActivity[];
}) {
    return (
        <section className="rounded-xl border border-border bg-bg-panel/80 px-4 py-3">
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h4 className="text-sm font-medium text-text-primary">
                        Tool Activity
                    </h4>
                    <p className="mt-1 text-[11px] text-text-secondary">
                        Persisted execution context attached to this session.
                    </p>
                </div>
                <span className="text-[11px] text-text-secondary">
                    {activities.length === 1
                        ? "1 item"
                        : `${activities.length} items`}
                </span>
            </div>

            <div className="space-y-3">
                {activities.map((activity) => {
                    const diffStats = computeDiffStats(activity.diffs);
                    const previewText =
                        activity.summary ??
                        summarizePayload(activity.terminalOutput) ??
                        summarizePayload(activity.rawOutputJson) ??
                        summarizePayload(activity.rawInputJson) ??
                        null;

                    return (
                        <article
                            className="rounded-lg border border-border bg-bg-primary/80 px-3 py-3"
                            key={activity.id}
                        >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span
                                            className="rounded-full border px-2 py-0.5 text-[11px] font-medium"
                                            style={getToolActivityStatusStyle(
                                                activity.status,
                                            )}
                                        >
                                            {formatToolActivityStatus(
                                                activity.status,
                                            )}
                                        </span>
                                        <span className="truncate text-[13px] font-medium text-text-primary">
                                            {activity.title}
                                        </span>
                                    </div>
                                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
                                        <span>{activity.kind}</span>
                                        <span>{formatToolActivityTime(activity)}</span>
                                        {activity.locations.length > 0 ? (
                                            <span>
                                                {activity.locations.length === 1
                                                    ? "1 location"
                                                    : `${activity.locations.length} locations`}
                                            </span>
                                        ) : null}
                                    </div>
                                </div>

                                {(diffStats.additions > 0 ||
                                    diffStats.deletions > 0) && (
                                    <div className="flex shrink-0 items-center gap-2 text-[11px]">
                                        {diffStats.additions > 0 ? (
                                            <span className="font-medium text-[var(--diff-add)]">
                                                +
                                                {formatDiffStat(
                                                    diffStats.additions,
                                                    diffStats.approximate,
                                                )}
                                            </span>
                                        ) : null}
                                        {diffStats.deletions > 0 ? (
                                            <span className="font-medium text-[var(--diff-remove)]">
                                                -
                                                {formatDiffStat(
                                                    diffStats.deletions,
                                                    diffStats.approximate,
                                                )}
                                            </span>
                                        ) : null}
                                        <DiffStatBar
                                            additions={diffStats.additions}
                                            deletions={diffStats.deletions}
                                        />
                                    </div>
                                )}
                            </div>

                            {previewText ? (
                                <p className="mt-3 text-[12px] leading-5 text-text-secondary">
                                    {previewText}
                                </p>
                            ) : null}

                            {activity.locations.length > 0 ? (
                                <div className="mt-3 flex flex-wrap gap-2">
                                    {activity.locations.map((location) => (
                                        <span
                                            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary"
                                            key={location}
                                            title={location}
                                        >
                                            {getCompactPath(location)}
                                        </span>
                                    ))}
                                </div>
                            ) : null}

                            <div className="mt-3 space-y-2">
                                {activity.terminalOutput ? (
                                    <HistoryPayloadDetails
                                        content={activity.terminalOutput}
                                        label="Terminal Output"
                                    />
                                ) : null}
                                {activity.rawInputJson ? (
                                    <HistoryPayloadDetails
                                        content={formatJsonPayload(
                                            activity.rawInputJson,
                                        )}
                                        label="Input Payload"
                                    />
                                ) : null}
                                {activity.rawOutputJson ? (
                                    <HistoryPayloadDetails
                                        content={formatJsonPayload(
                                            activity.rawOutputJson,
                                        )}
                                        label="Output Payload"
                                    />
                                ) : null}
                            </div>
                        </article>
                    );
                })}
            </div>
        </section>
    );
}

function HistoryTrackedFilesSection({
    items,
    status,
    summary,
}: {
    readonly items: readonly ReviewFileItem[];
    readonly status: AiSessionStatus;
    readonly summary: ReturnType<typeof deriveReviewSummary>;
}) {
    return (
        <section className="rounded-xl border border-border bg-bg-panel/80 px-4 py-3">
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h4 className="text-sm font-medium text-text-primary">
                        Edited Files
                    </h4>
                    <p className="mt-1 text-[11px] text-text-secondary">
                        Read-only summary of tracked file changes kept with this
                        session.
                    </p>
                </div>
                <div className="text-right text-[11px] text-text-secondary">
                    <div>{formatSessionStatus(status)}</div>
                    <div>
                        {summary.fileCount === 1
                            ? "1 file"
                            : `${summary.fileCount} files`}
                    </div>
                </div>
            </div>

            {(summary.additions > 0 || summary.deletions > 0) && (
                <div className="mb-3 flex items-center gap-2 text-[11px]">
                    {summary.additions > 0 ? (
                        <span className="font-medium text-[var(--diff-add)]">
                            +
                            {formatDiffStat(
                                summary.additions,
                                summary.approximate,
                            )}
                        </span>
                    ) : null}
                    {summary.deletions > 0 ? (
                        <span className="font-medium text-[var(--diff-remove)]">
                            -
                            {formatDiffStat(
                                summary.deletions,
                                summary.approximate,
                            )}
                        </span>
                    ) : null}
                    <DiffStatBar
                        additions={summary.additions}
                        deletions={summary.deletions}
                    />
                </div>
            )}

            <div className="space-y-2">
                {items.map((item) => (
                    <div
                        className="rounded-lg border border-border bg-bg-primary/80 px-3 py-2.5"
                        key={item.file.identityKey}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate text-[13px] font-medium text-text-primary">
                                        {getFileNameFromPath(item.file.path)}
                                    </span>
                                    <span
                                        className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                                        style={{
                                            backgroundColor:
                                                "color-mix(in srgb, var(--color-bg-tertiary) 82%, transparent)",
                                            color: item.tone.accent,
                                        }}
                                    >
                                        {item.tone.badge ??
                                            formatTrackedFileKind(
                                                item.file.kind,
                                            )}
                                    </span>
                                </div>
                                <div
                                    className="mt-1 text-[11px] text-text-secondary"
                                    title={item.file.path}
                                >
                                    {getCompactPath(item.file.path, 4)}
                                </div>
                                <p className="mt-2 text-[12px] leading-5 text-text-secondary">
                                    {item.summary}
                                </p>
                            </div>

                            <div className="flex shrink-0 items-center gap-2 text-[11px]">
                                {item.stats.additions > 0 ? (
                                    <span className="font-medium text-[var(--diff-add)]">
                                        +
                                        {formatDiffStat(
                                            item.stats.additions,
                                            item.stats.approximate,
                                        )}
                                    </span>
                                ) : null}
                                {item.stats.deletions > 0 ? (
                                    <span className="font-medium text-[var(--diff-remove)]">
                                        -
                                        {formatDiffStat(
                                            item.stats.deletions,
                                            item.stats.approximate,
                                        )}
                                    </span>
                                ) : null}
                                <DiffStatBar
                                    additions={item.stats.additions}
                                    deletions={item.stats.deletions}
                                />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}

function HistoryPayloadDetails({
    content,
    label,
}: {
    readonly content: string;
    readonly label: string;
}) {
    return (
        <details className="rounded-md border border-border bg-bg-panel/70">
            <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-medium text-text-secondary">
                {label}
            </summary>
            <pre className="max-h-64 overflow-auto border-t border-border px-3 py-3 text-[11px] leading-5 text-text-secondary whitespace-pre-wrap break-words">
                {content}
            </pre>
        </details>
    );
}

function summarizePayload(value: string | null): string | null {
    if (!value) {
        return null;
    }

    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) {
        return null;
    }

    return normalized.length > 280
        ? `${normalized.slice(0, 277)}...`
        : normalized;
}

function formatJsonPayload(value: string): string {
    try {
        return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
        return value;
    }
}

function formatToolActivityStatus(status: AiToolActivity["status"]): string {
    switch (status) {
        case "in_progress":
            return "In Progress";
        case "failed":
            return "Failed";
        case "pending":
            return "Pending";
        case "completed":
        default:
            return "Completed";
    }
}

function getToolActivityStatusStyle(
    status: AiToolActivity["status"],
): Record<string, string> {
    switch (status) {
        case "failed":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--color-status-error) 14%, transparent)",
                borderColor: "var(--color-status-error)",
                color: "var(--color-status-error)",
            };
        case "in_progress":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                borderColor:
                    "color-mix(in srgb, var(--color-accent) 26%, transparent)",
                color: "var(--color-accent)",
            };
        case "pending":
            return {
                backgroundColor: "var(--color-bg-tertiary)",
                borderColor: "var(--color-border-strong)",
                color: "var(--color-text-secondary)",
            };
        case "completed":
        default:
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--diff-add) 14%, transparent)",
                borderColor:
                    "color-mix(in srgb, var(--diff-add) 26%, transparent)",
                color: "var(--diff-add)",
            };
    }
}

function formatToolActivityTime(activity: AiToolActivity): string {
    return activity.updatedAt === activity.createdAt
        ? `Updated ${new Date(activity.updatedAt).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
          })}`
        : `Ran ${new Date(activity.createdAt).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
          })}`;
}

function formatSessionStatus(status: AiSessionStatus): string {
    switch (status) {
        case "waiting_permission":
            return "Waiting Permission";
        case "waiting_user_input":
            return "Waiting Input";
        case "starting":
            return "Starting";
        case "streaming":
            return "Streaming";
        case "error":
            return "Error";
        case "idle":
        default:
            return "Idle";
    }
}

function formatTrackedFileKind(
    kind: ReviewFileItem["file"]["kind"],
): string {
    switch (kind) {
        case "create":
            return "New";
        case "delete":
            return "Deleted";
        case "move":
            return "Moved";
        case "update":
        default:
            return "Modified";
    }
}
