import { useState } from "react";

import type { QueuedPrompt } from "@renderer/app/ai/sessionReviewContracts";
import { FIXED_PENDING_REVIEW_CARD_TEXT_ZOOM } from "@renderer/app/ai/sessionReviewContracts";

import { ReviewRejectIcon } from "../review/ReviewFileRow";
import { composerPartsToPlainText } from "./composerParts";

const BASE_TEXT_SIZE_PX = 16;

function toEm(value: number): string {
    return `${value / BASE_TEXT_SIZE_PX}em`;
}

function QueueEditIcon({ size = 13 }: { readonly size?: number }) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height={size}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width={size}
        >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
    );
}

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

function getStatusLabel(status: QueuedPrompt["status"]): string | null {
    if (status === "sending") {
        return "sending\u2026";
    }

    if (status === "failed") {
        return "failed!";
    }

    return null;
}

function getStatusColor(status: QueuedPrompt["status"]): string {
    if (status === "failed") {
        return "#ef4444";
    }

    return "var(--color-accent)";
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
    const effectiveCollapsed = editingItem ? false : collapsed;
    const canClearAll =
        items.length > 0 && items.every((item) => item.status !== "sending");

    if (items.length === 0 && !editingItem) {
        return null;
    }

    return (
        <div
            className="flex flex-col gap-1"
            data-testid="queued-messages-panel"
            style={{
                fontFamily: "var(--font-mono)",
                fontSize: `${FIXED_PENDING_REVIEW_CARD_TEXT_ZOOM}em`,
            }}
        >
            {items.length > 0 ? (
                <div className="flex items-center justify-between px-1">
                    <button
                        className="flex items-center gap-1.5"
                        onClick={() => setCollapsed((v) => !v)}
                        style={{
                            background: "none",
                            border: "none",
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: toEm(10),
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
                                fontSize: toEm(10),
                                transform: effectiveCollapsed
                                    ? "rotate(0deg)"
                                    : "rotate(90deg)",
                                transition: "transform 140ms ease",
                            }}
                        >
                            ▸
                        </span>
                        queue ({items.length})
                    </button>
                    <button
                        aria-label="Clear queue"
                        className="review-text-btn"
                        disabled={!canClearAll}
                        onClick={onClearAll}
                        style={{
                            background: "none",
                            border: "none",
                            color: "var(--color-text-secondary)",
                            cursor: canClearAll ? "pointer" : "not-allowed",
                            fontSize: toEm(10),
                            fontWeight: 500,
                            opacity: canClearAll ? 0.6 : 0.25,
                            padding: 0,
                        }}
                        title="Clear queue"
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
                                fontSize: toEm(10),
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
                                fontSize: toEm(11),
                            }}
                            title={summarizeQueuedPrompt(editingItem)}
                        >
                            {`"${summarizeQueuedPrompt(editingItem)}"`}
                        </span>
                    </div>
                    <button
                        aria-label="Cancel edit"
                        className="review-action-btn review-text-btn shrink-0"
                        onClick={onCancelEdit}
                        style={{
                            background: "transparent",
                            border: "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
                            borderRadius: 3,
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: toEm(10),
                            fontWeight: 500,
                            lineHeight: "16px",
                            padding: "0 5px",
                        }}
                        title="Cancel edit"
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
                    style={{
                        maxHeight: 180,
                        overflowY: "auto",
                    }}
                >
                    {items.map((item, index) => {
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
                                        fontSize: toEm(10),
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
                                        fontSize: toEm(11),
                                    }}
                                    title={summary}
                                >
                                    {summary}
                                </span>
                                {getStatusLabel(item.status) ? (
                                    <span
                                        style={{
                                            color: getStatusColor(item.status),
                                            flexShrink: 0,
                                            fontSize: toEm(10),
                                            fontWeight: 500,
                                            opacity: 0.7,
                                        }}
                                    >
                                        {getStatusLabel(item.status)}
                                    </span>
                                ) : null}
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        aria-label={`Delete ${summary}`}
                                        className="review-icon-btn review-icon-btn--reject"
                                        disabled={sending}
                                        onClick={() => onDelete(item.id)}
                                        title="Delete"
                                        type="button"
                                    >
                                        <ReviewRejectIcon size={13} />
                                    </button>
                                    {!sending ? (
                                        <button
                                            aria-label={`Edit ${summary}`}
                                            className="review-icon-btn"
                                            onClick={() => onEdit(item.id)}
                                            title="Edit"
                                            type="button"
                                        >
                                            <QueueEditIcon size={13} />
                                        </button>
                                    ) : null}
                                    <button
                                        aria-label="Send now"
                                        className="review-action-btn review-text-btn"
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
                                            fontSize: toEm(10),
                                            fontWeight: 500,
                                            lineHeight: "16px",
                                            opacity: sending ? 0.3 : 0.7,
                                            padding: "0 5px",
                                        }}
                                        title="Send now"
                                        type="button"
                                    >
                                        steer
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
