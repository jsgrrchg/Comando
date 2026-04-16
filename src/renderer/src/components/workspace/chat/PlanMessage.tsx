import { useState } from "react";

import type { AiPlan, AiPlanEntry } from "@shared/ipc";

/* ─── Status helpers ─── */

function getStatusDotColor(status: AiPlanEntry["status"]): string {
    switch (status) {
        case "completed":
            return "#84cc16";
        case "in_progress":
            return "var(--color-accent)";
        case "pending":
            return "var(--color-text-secondary)";
    }
}

function getPlanStatusLabel(entries: readonly AiPlanEntry[]): string {
    const completed = entries.filter((e) => e.status === "completed").length;
    const total = entries.length;
    if (completed === total) return "All Done";
    if (completed > 0) return "In Progress";
    const hasInProgress = entries.some((e) => e.status === "in_progress");
    if (hasInProgress) return "In Progress";
    return "Planned";
}

/* ─── Component ─── */

export function PlanMessage({
    onDismiss,
    plan,
}: {
    readonly onDismiss?: () => void;
    readonly plan: AiPlan;
}) {
    const [expanded, setExpanded] = useState(true);
    const canExpand = plan.entries.length > 0;

    const completedCount = plan.entries.filter(
        (e) => e.status === "completed",
    ).length;
    const totalCount = plan.entries.length;
    const statusLabel = getPlanStatusLabel(plan.entries);

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-xl"
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-bg-tertiary) 84%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-border) 88%, transparent)",
            }}
        >
            {/* Header */}
            <div className="flex items-center gap-1 px-1 py-1">
                <button
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-0.5 text-left"
                    onClick={() => {
                        if (canExpand) {
                            setExpanded((current) => !current);
                        }
                    }}
                    style={{
                        background: "none",
                        border: "none",
                        cursor: canExpand ? "pointer" : "default",
                    }}
                    type="button"
                >
                    <span
                        className="inline-flex shrink-0 items-center justify-center rounded-md px-1.5 py-0.5 text-xs"
                        style={{
                            backgroundColor:
                                "color-mix(in srgb, var(--color-bg-secondary) 74%, transparent)",
                            border: "1px solid color-mix(in srgb, var(--color-border) 82%, transparent)",
                            color: "var(--color-text-secondary)",
                            fontWeight: 500,
                        }}
                    >
                        {canExpand ? (expanded ? "▾" : "▸") : "•"}
                    </span>
                    <span
                        className="min-w-0 flex-1 font-medium"
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: "0.875rem",
                        }}
                    >
                        Plan
                    </span>
                    <span
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: "0.76em",
                        }}
                    >
                        {statusLabel}
                    </span>
                </button>
                {onDismiss ? (
                    <button
                        aria-label="Dismiss plan banner"
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                        onClick={onDismiss}
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: 14,
                            lineHeight: 1,
                            opacity: 0.72,
                            transition:
                                "opacity 140ms ease, background-color 140ms ease",
                        }}
                        title="Dismiss plan banner"
                        type="button"
                    >
                        <span aria-hidden="true">×</span>
                    </button>
                ) : null}
            </div>

            {/* Entries */}
            {expanded ? (
                <div
                    style={{
                        borderTop:
                            "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)",
                    }}
                >
                    {plan.entries.map((entry, i) => (
                        <div
                            className="flex min-w-0 items-start gap-2.5 px-2.5 py-1.5"
                            key={`${entry.content}-${i}`}
                            style={{
                                borderBottom:
                                    i < plan.entries.length - 1
                                        ? "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)"
                                        : undefined,
                            }}
                        >
                            <span
                                className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{
                                    backgroundColor: getStatusDotColor(
                                        entry.status,
                                    ),
                                    opacity:
                                        entry.status === "completed"
                                            ? 0.9
                                            : 0.8,
                                }}
                            />
                            <span
                                className="min-w-0 flex-1"
                                style={{
                                    color:
                                        entry.status === "completed"
                                            ? "var(--color-text-secondary)"
                                            : "var(--color-text-primary)",
                                    fontSize: "0.875rem",
                                    lineHeight: 1.45,
                                    opacity:
                                        entry.status === "completed" ? 0.74 : 1,
                                    textDecoration:
                                        entry.status === "completed"
                                            ? "line-through"
                                            : undefined,
                                    wordBreak: "break-word",
                                }}
                            >
                                {entry.content}
                            </span>
                        </div>
                    ))}

                    {/* Progress footer */}
                    <div
                        className="px-2.5 pb-1.5 pt-0.5"
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: "0.74em",
                            opacity: 0.68,
                        }}
                    >
                        {completedCount}/{totalCount}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
