import { useState } from "react";

import type { AiPlan, AiPlanEntry } from "@shared/ipc";

/* ─── Status helpers ─── */

const DONE_COLOR = "#84cc16";

function getStatusDotColor(status: AiPlanEntry["status"]): string {
    switch (status) {
        case "completed":
            return DONE_COLOR;
        case "in_progress":
            return "var(--color-accent)";
        case "pending":
            return "var(--color-text-secondary)";
    }
}

type PlanTone = "done" | "active" | "planned";

function getPlanTone(entries: readonly AiPlanEntry[]): PlanTone {
    const completed = entries.filter((e) => e.status === "completed").length;
    const total = entries.length;
    if (total > 0 && completed === total) return "done";
    if (completed > 0) return "active";
    if (entries.some((e) => e.status === "in_progress")) return "active";
    return "planned";
}

const PLAN_TONE_LABEL: Record<PlanTone, string> = {
    done: "All Done",
    active: "In Progress",
    planned: "Planned",
};

const PLAN_TONE_COLOR: Record<PlanTone, string> = {
    done: DONE_COLOR,
    active: "var(--color-accent)",
    planned: "var(--color-text-secondary)",
};

/* ─── Component ─── */

export function PlanMessage({
    expanded: controlledExpanded,
    onDismiss,
    onExpandedChange,
    plan,
}: {
    readonly expanded?: boolean;
    readonly onDismiss?: () => void;
    readonly onExpandedChange?: (expanded: boolean) => void;
    readonly plan: AiPlan;
}) {
    const [uncontrolledExpanded, setUncontrolledExpanded] = useState(true);
    const expanded = controlledExpanded ?? uncontrolledExpanded;
    const canExpand = plan.entries.length > 0;

    const completedCount = plan.entries.filter(
        (e) => e.status === "completed",
    ).length;
    const totalCount = plan.entries.length;
    const tone = getPlanTone(plan.entries);
    const toneColor = PLAN_TONE_COLOR[tone];
    const title = plan.title ?? "Plan";
    const currentEntry =
        plan.entries.find((entry) => entry.status === "in_progress") ??
        plan.entries.find((entry) => entry.status === "pending");
    const collapsedTitle = currentEntry
        ? `${title} - ${currentEntry.content}`
        : title;

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-xl"
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-bg-tertiary) 78%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-border) 76%, transparent)",
            }}
        >
            {/* Header */}
            <div className="flex items-center gap-1.5 px-2.5 py-2">
                <button
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => {
                        if (canExpand) {
                            if (onExpandedChange) {
                                onExpandedChange(!expanded);
                            } else {
                                setUncontrolledExpanded(!expanded);
                            }
                        }
                    }}
                    style={{
                        background: "none",
                        border: "none",
                        cursor: canExpand ? "pointer" : "default",
                        padding: 0,
                    }}
                    type="button"
                >
                    <span
                        className="inline-grid shrink-0 place-items-center"
                        style={{ height: 16, width: 16 }}
                    >
                        {canExpand ? (
                            <svg
                                aria-hidden="true"
                                fill="none"
                                height="10"
                                style={{
                                    color: "var(--color-text-secondary)",
                                    opacity: 0.75,
                                    transform: expanded
                                        ? "rotate(0deg)"
                                        : "rotate(-90deg)",
                                    transition: "transform 160ms ease",
                                }}
                                viewBox="0 0 16 16"
                                width="10"
                            >
                                <path
                                    d="M4.5 6.5 8 10l3.5-3.5"
                                    stroke="currentColor"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="1.6"
                                />
                            </svg>
                        ) : (
                            <span
                                style={{
                                    background: "var(--color-text-secondary)",
                                    borderRadius: "50%",
                                    display: "block",
                                    height: 4,
                                    opacity: 0.6,
                                    width: 4,
                                }}
                            />
                        )}
                    </span>
                    <span
                        className="min-w-0 flex-1 truncate"
                        style={{
                            color: "var(--color-text-primary)",
                            fontSize: "0.8125rem",
                            fontWeight: 600,
                        }}
                    >
                        {expanded ? title : collapsedTitle}
                    </span>
                    {expanded ? (
                        <span
                            className="shrink-0 rounded-full"
                            style={{
                                background: `color-mix(in srgb, ${toneColor} 16%, transparent)`,
                                color: toneColor,
                                fontSize: "0.7em",
                                fontWeight: 500,
                                padding: "2px 8px",
                            }}
                        >
                            {PLAN_TONE_LABEL[tone]}
                        </span>
                    ) : null}
                </button>
                {onDismiss ? (
                    <button
                        aria-label="Dismiss plan banner"
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
                        onClick={onDismiss}
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: 13,
                            lineHeight: 1,
                            opacity: 0.6,
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
                <div className="flex flex-col gap-1 px-2.5 pb-2">
                    {plan.entries.map((entry, i) => (
                        <div
                            className="flex min-w-0 items-start gap-2.5 py-0.5"
                            key={`${entry.content}-${i}`}
                        >
                            <span
                                className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{
                                    backgroundColor: getStatusDotColor(
                                        entry.status,
                                    ),
                                    opacity:
                                        entry.status === "completed"
                                            ? 0.85
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
                                    fontSize: "12px",
                                    lineHeight: 1.45,
                                    opacity:
                                        entry.status === "completed" ? 0.7 : 1,
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
                    <div className="mt-1 flex justify-end">
                        <span
                            style={{
                                color: "var(--color-text-secondary)",
                                fontSize: "0.7em",
                                fontVariantNumeric: "tabular-nums",
                                opacity: 0.6,
                            }}
                        >
                            {completedCount}/{totalCount}
                        </span>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
