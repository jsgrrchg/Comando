import { useState } from "react";

import type { QueuedPrompt } from "@renderer/app/ai/sessionReviewContracts";

import { composerPartsToPlainText } from "./composerParts";

function summarizeQueuedPrompt(item: QueuedPrompt): string {
    const promptSummary = item.prompt.trim();
    if (promptSummary) {
        return promptSummary;
    }

    const composerSummary = composerPartsToPlainText(
        item.composerPartsSnapshot,
    ).trim();
    if (composerSummary) {
        return composerSummary;
    }

    if (item.attachments.length > 0) {
        return item.attachments.length === 1
            ? "1 attachment"
            : `${item.attachments.length} attachments`;
    }

    if (item.fileContextsSnapshot.length > 0) {
        return item.fileContextsSnapshot.length === 1
            ? "1 context reference"
            : `${item.fileContextsSnapshot.length} context references`;
    }

    return "Untitled message";
}

function getStatusLabel(status: QueuedPrompt["status"]): string {
    if (status === "sending") {
        return "sending\u2026";
    }

    if (status === "failed") {
        return "failed!";
    }

    return "queued";
}

function getStatusColor(status: QueuedPrompt["status"]): string {
    if (status === "failed") {
        return "#ef4444";
    }

    if (status === "sending") {
        return "var(--color-accent)";
    }

    return "#8b5cf6";
}

export interface QueuedMessagesPanelProps {
    readonly defaultCollapsed?: boolean;
    readonly editingItem?: QueuedPrompt | null;
    readonly items: readonly QueuedPrompt[];
    readonly onCancelEdit: () => void;
    readonly onClearAll: () => void;
    readonly onDelete: (messageId: string) => void;
    readonly onEdit: (messageId: string) => void;
    readonly onSendNow: (messageId: string) => void;
}

export function QueuedMessagesPanel({
    defaultCollapsed = false,
    editingItem = null,
    items,
    onCancelEdit,
    onClearAll,
    onDelete,
    onEdit,
    onSendNow,
}: QueuedMessagesPanelProps) {
    const [collapsed, setCollapsed] = useState(defaultCollapsed);
    const visibleItems = items.filter((item) => item.status !== "sending");
    const effectiveCollapsed = editingItem ? false : collapsed;
    const canClearAll =
        visibleItems.length > 0 &&
        items.every((item) => item.status !== "sending");

    if (visibleItems.length === 0 && !editingItem) {
        return null;
    }

    return (
        <div
            className="flex flex-col gap-1"
            data-testid="queued-messages-panel"
            style={{ fontFamily: "var(--font-mono)" }}
        >
            {visibleItems.length > 0 ? (
                <div className="flex items-center justify-between px-1">
                    <button
                        className="flex items-center gap-1.5"
                        onClick={() => setCollapsed((v) => !v)}
                        style={{
                            background: "none",
                            border: "none",
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: "10px",
                            fontWeight: 600,
                            letterSpacing: "0.06em",
                            padding: 0,
                            textTransform: "uppercase",
                        }}
                        type="button"
                    >
                        <span
                            style={{
                                display: "inline-flex",
                                fontSize: "10px",
                                transform: effectiveCollapsed
                                    ? "rotate(0deg)"
                                    : "rotate(90deg)",
                                transition: "transform 140ms ease",
                            }}
                        >
                            ▸
                        </span>
                        queue ({visibleItems.length})
                    </button>
                    <button
                        disabled={!canClearAll}
                        onClick={onClearAll}
                        style={{
                            background: "none",
                            border: "none",
                            color: "var(--color-text-secondary)",
                            cursor: canClearAll ? "pointer" : "not-allowed",
                            fontSize: "10px",
                            fontWeight: 500,
                            opacity: canClearAll ? 0.6 : 0.25,
                            padding: 0,
                        }}
                        type="button"
                    >
                        [clear]
                    </button>
                </div>
            ) : null}

            {!effectiveCollapsed && editingItem ? (
                <div
                    className="flex items-center justify-between gap-2 rounded px-3 py-1.5"
                    style={{
                        backgroundColor:
                            "color-mix(in srgb, var(--color-accent) 6%, var(--color-bg-secondary))",
                        border: "1px solid color-mix(in srgb, var(--color-accent) 18%, var(--color-border))",
                    }}
                >
                    <div className="flex min-w-0 items-center gap-2">
                        <span
                            style={{
                                color: "var(--color-accent)",
                                fontSize: "10px",
                                fontWeight: 600,
                                opacity: 0.8,
                            }}
                        >
                            ▹ editing:
                        </span>
                        <span
                            className="truncate"
                            style={{
                                color: "var(--color-text-primary)",
                                fontSize: "11px",
                            }}
                            title={summarizeQueuedPrompt(editingItem)}
                        >
                            {`"${summarizeQueuedPrompt(editingItem)}"`}
                        </span>
                    </div>
                    <button
                        className="review-action-btn shrink-0"
                        onClick={onCancelEdit}
                        style={{
                            background: "transparent",
                            border: "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
                            borderRadius: 3,
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: "10px",
                            fontWeight: 500,
                            lineHeight: "16px",
                            padding: "0 5px",
                        }}
                        type="button"
                    >
                        cancel
                    </button>
                </div>
            ) : null}

            {!effectiveCollapsed ? (
                <div
                    className="flex flex-col"
                    data-testid="queued-messages-list"
                >
                    {visibleItems.map((item, index) => {
                        const sending = item.status === "sending";
                        const summary = summarizeQueuedPrompt(item);

                        return (
                            <div
                                className="group flex items-center gap-2 rounded px-2.5 py-1"
                                key={item.id}
                                style={{
                                    transition: "background-color 100ms ease",
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.backgroundColor =
                                        "color-mix(in srgb, var(--color-bg-secondary) 60%, transparent)";
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor =
                                        "transparent";
                                }}
                            >
                                <span
                                    style={{
                                        color: "var(--color-text-secondary)",
                                        flexShrink: 0,
                                        fontSize: "10px",
                                        fontWeight: 500,
                                        opacity: 0.5,
                                        textAlign: "right",
                                        width: 18,
                                    }}
                                >
                                    #{index + 1}
                                </span>
                                <span
                                    className="min-w-0 flex-1 truncate"
                                    style={{
                                        color: "var(--color-text-primary)",
                                        fontSize: "11px",
                                    }}
                                    title={summary}
                                >
                                    {summary}
                                </span>
                                <span
                                    style={{
                                        color: getStatusColor(item.status),
                                        flexShrink: 0,
                                        fontSize: "10px",
                                        fontWeight: 500,
                                        opacity: 0.7,
                                    }}
                                >
                                    {getStatusLabel(item.status)}
                                </span>
                                <div className="flex shrink-0 items-center gap-0.5">
                                    <button
                                        aria-label={`Delete ${summary}`}
                                        className="review-action-btn"
                                        disabled={sending}
                                        onClick={() => onDelete(item.id)}
                                        style={{
                                            background: "transparent",
                                            border: "none",
                                            color: "var(--diff-remove)",
                                            cursor: sending
                                                ? "not-allowed"
                                                : "pointer",
                                            fontSize: "11px",
                                            opacity: sending ? 0.2 : 0.5,
                                            padding: "2px 3px",
                                        }}
                                        type="button"
                                    >
                                        ✕
                                    </button>
                                    {!sending ? (
                                        <button
                                            aria-label={`Edit ${summary}`}
                                            className="review-action-btn"
                                            onClick={() => onEdit(item.id)}
                                            style={{
                                                background: "transparent",
                                                border: "none",
                                                color: "var(--color-text-secondary)",
                                                cursor: "pointer",
                                                fontSize: "11px",
                                                opacity: 0.5,
                                                padding: "2px 3px",
                                            }}
                                            type="button"
                                        >
                                            ✎
                                        </button>
                                    ) : null}
                                    <button
                                        className="review-action-btn"
                                        disabled={sending}
                                        onClick={() => onSendNow(item.id)}
                                        style={{
                                            background: "transparent",
                                            border: "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
                                            borderRadius: 3,
                                            color: sending
                                                ? "var(--color-text-secondary)"
                                                : item.status === "failed"
                                                  ? "#ef4444"
                                                  : "var(--color-accent)",
                                            cursor: sending
                                                ? "not-allowed"
                                                : "pointer",
                                            fontSize: "10px",
                                            fontWeight: 500,
                                            lineHeight: "16px",
                                            opacity: sending ? 0.3 : 0.7,
                                            padding: "0 5px",
                                        }}
                                        type="button"
                                    >
                                        send
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
}
