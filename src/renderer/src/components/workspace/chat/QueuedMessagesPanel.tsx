import { useState } from "react";

import type { QueuedPrompt } from "@renderer/app/ai/sessionReviewContracts";

import { composerPartsToPlainText } from "./composerParts";
import {
    getAccentButtonStyle,
    getDangerButtonStyle,
    getNeutralButtonStyle,
} from "../review/reviewStyles";

function Chevron({ expanded }: { readonly expanded: boolean }) {
    return (
        <svg
            fill="none"
            height="10"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            style={{
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 140ms ease",
            }}
            viewBox="0 0 24 24"
            width="10"
        >
            <polyline points="8 6 14 12 8 18" />
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

function getQueueTitle(count: number): string {
    return count === 1 ? "1 Queued Message" : `${count} Queued Messages`;
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
    const effectiveCollapsed = editingItem ? false : collapsed;
    const canClearAll =
        items.length > 0 &&
        items.every((item) => item.status !== "sending");

    if (items.length === 0 && !editingItem) {
        return null;
    }

    return (
        <section
            className="overflow-hidden rounded-xl"
            data-testid="queued-messages-panel"
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-bg-secondary) 84%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-border) 88%, transparent)",
            }}
        >
            {items.length > 0 ? (
                <div
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5"
                    style={{
                        borderBottom: !effectiveCollapsed
                            ? "1px solid color-mix(in srgb, var(--color-border) 80%, transparent)"
                            : "none",
                    }}
                >
                    <div
                        className="text-xs font-medium"
                        style={{ color: "var(--color-text-secondary)" }}
                    >
                        {getQueueTitle(items.length)}
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            aria-expanded={!effectiveCollapsed}
                            aria-label={
                                effectiveCollapsed
                                    ? "Expand queued messages"
                                    : "Collapse queued messages"
                            }
                            className="shrink-0"
                            onClick={() => setCollapsed((value) => !value)}
                            style={{
                                alignItems: "center",
                                background: "transparent",
                                border: "none",
                                color: "var(--color-text-secondary)",
                                cursor: "pointer",
                                display: "inline-flex",
                                fontSize: 12,
                                height: 16,
                                justifyContent: "center",
                                lineHeight: 1,
                                padding: 0,
                                width: 16,
                            }}
                            title={
                                effectiveCollapsed
                                    ? "Expand queued messages"
                                    : "Collapse queued messages"
                            }
                            type="button"
                        >
                            <Chevron expanded={!effectiveCollapsed} />
                        </button>
                        <button
                            className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                            disabled={!canClearAll}
                            onClick={onClearAll}
                            style={{
                                ...getNeutralButtonStyle(),
                                cursor: canClearAll ? "pointer" : "not-allowed",
                                lineHeight: "16px",
                                opacity: canClearAll ? 1 : 0.45,
                            }}
                            type="button"
                        >
                            Clear All
                        </button>
                    </div>
                </div>
            ) : null}

            {!effectiveCollapsed && editingItem ? (
                <div
                    className="flex items-center justify-between gap-2.5 px-2.5 py-2"
                    style={{
                        borderBottom:
                            items.length > 0
                                ? "1px solid color-mix(in srgb, var(--color-border) 75%, transparent)"
                                : "none",
                    }}
                >
                    <div className="min-w-0">
                        <div
                            className="text-[11px] font-semibold uppercase"
                            style={{
                                color: "var(--color-accent)",
                                letterSpacing: "0.12em",
                            }}
                        >
                            Editing queued message
                        </div>
                        <div
                            className="mt-1 truncate text-sm"
                            style={{ color: "var(--color-text-primary)" }}
                            title={summarizeQueuedPrompt(editingItem)}
                        >
                            {summarizeQueuedPrompt(editingItem)}
                        </div>
                    </div>
                    <button
                        className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                        onClick={onCancelEdit}
                        style={{
                            ...getNeutralButtonStyle(),
                            lineHeight: "16px",
                        }}
                        type="button"
                    >
                        Cancel Edit
                    </button>
                </div>
            ) : null}

            {!effectiveCollapsed ? (
                <div
                    className="flex flex-col"
                    data-testid="queued-messages-list"
                >
                    {items.map((item, index) => {
                        const sending = item.status === "sending";
                        const summary = summarizeQueuedPrompt(item);
                        const sendNowAccent =
                            item.status === "failed"
                                ? "#ef4444"
                                : "var(--color-accent)";

                        return (
                            <div
                                className="flex items-center gap-2.5 px-2.5 py-1.5"
                                key={item.id}
                                style={{
                                    borderTop:
                                        index === 0 && !editingItem
                                            ? "none"
                                            : "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)",
                                }}
                            >
                                <span
                                    aria-hidden="true"
                                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{
                                        backgroundColor: getStatusColor(
                                            item.status,
                                        ),
                                        opacity: sending ? 1 : 0.9,
                                    }}
                                    title={item.status}
                                />
                                <div className="min-w-0 flex-1">
                                    <div
                                        className="truncate text-sm"
                                        style={{
                                            color: "var(--color-text-primary)",
                                        }}
                                        title={summary}
                                    >
                                        {summary}
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        aria-label={`Delete ${summary}`}
                                        className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                                        disabled={sending}
                                        onClick={() => onDelete(item.id)}
                                        style={{
                                            ...getDangerButtonStyle(sending),
                                            lineHeight: "16px",
                                        }}
                                        type="button"
                                    >
                                        Delete
                                    </button>
                                    {!sending ? (
                                        <button
                                            aria-label={`Edit ${summary}`}
                                            className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                                            onClick={() => onEdit(item.id)}
                                            style={{
                                                ...getAccentButtonStyle(),
                                                lineHeight: "16px",
                                            }}
                                            type="button"
                                        >
                                            Edit
                                        </button>
                                    ) : null}
                                    <button
                                        className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                                        disabled={sending}
                                        onClick={() => onSendNow(item.id)}
                                        style={{
                                            ...getAccentButtonStyle(
                                                sendNowAccent,
                                            ),
                                            cursor: sending
                                                ? "not-allowed"
                                                : "pointer",
                                            lineHeight: "16px",
                                            opacity: sending ? 0.45 : 1,
                                        }}
                                        type="button"
                                    >
                                        Send Now
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </section>
    );
}
