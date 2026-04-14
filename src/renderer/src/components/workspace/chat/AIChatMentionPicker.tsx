import { useEffect, useRef } from "react";

import type { ProjectTreeNode } from "@shared/ipc";

/* ─── Types ─── */

export type MentionSuggestion =
    | { readonly kind: "fetch" }
    | { readonly kind: "plan" }
    | {
          readonly kind: "file";
          readonly entry: ProjectTreeNode;
          readonly label: string;
      }
    | {
          readonly kind: "folder";
          readonly entry: ProjectTreeNode;
          readonly label: string;
      };

interface AIChatMentionPickerProps {
    readonly open: boolean;
    readonly x: number;
    readonly y: number;
    readonly selectedIndex: number;
    readonly items: readonly MentionSuggestion[];
    readonly onHoverIndex: (index: number) => void;
    readonly onSelect: (item: MentionSuggestion) => void;
    readonly onClose: () => void;
}

/* ─── Helpers ─── */

const FETCH_KEYWORDS = ["fetch", "web", "search", "buscar", "internet"];

export function getMentionSuggestions(
    query: string,
    entries: readonly ProjectTreeNode[],
    limit = 10,
): MentionSuggestion[] {
    const q = query.toLowerCase().trim();
    const results: MentionSuggestion[] = [];

    if (!q || FETCH_KEYWORDS.some((kw) => kw.startsWith(q))) {
        results.push({ kind: "fetch" });
    }

    if (!q || "plan".startsWith(q)) {
        results.push({ kind: "plan" });
    }

    for (const entry of entries) {
        if (results.length >= limit) break;
        const name = entry.name.toLowerCase();
        const path = entry.relativePath.toLowerCase();
        if (!q || name.includes(q) || path.includes(q)) {
            results.push({
                kind: entry.kind === "directory" ? "folder" : "file",
                entry,
                label: entry.name,
            });
        }
    }

    return results.slice(0, limit);
}

/* ─── Icon components ─── */

function FetchIcon() {
    return (
        <svg
            fill="none"
            height="12"
            stroke="#10b981"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="12"
        >
            <circle cx="12" cy="12" r="10" />
            <line x1="2" x2="22" y1="12" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
    );
}

function PlanIcon() {
    return (
        <svg
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="12"
        >
            <line x1="8" x2="21" y1="6" y2="6" />
            <line x1="8" x2="21" y1="12" y2="12" />
            <line x1="8" x2="21" y1="18" y2="18" />
            <line x1="3" x2="3.01" y1="6" y2="6" />
            <line x1="3" x2="3.01" y1="12" y2="12" />
            <line x1="3" x2="3.01" y1="18" y2="18" />
        </svg>
    );
}

function FileIcon() {
    return (
        <svg
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="12"
        >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
        </svg>
    );
}

function FolderIcon() {
    return (
        <svg
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="12"
        >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    );
}

/* ─── Component ─── */

export function AIChatMentionPicker({
    open,
    x,
    y,
    selectedIndex,
    items,
    onHoverIndex,
    onSelect,
    onClose,
}: AIChatMentionPickerProps) {
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onMouseDown = (e: MouseEvent) => {
            if (
                listRef.current &&
                !listRef.current.contains(e.target as Node)
            ) {
                onClose();
            }
        };
        document.addEventListener("mousedown", onMouseDown);
        return () => document.removeEventListener("mousedown", onMouseDown);
    }, [open, onClose]);

    useEffect(() => {
        const el = listRef.current?.querySelector("[data-selected='true']");
        el?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    if (!open || items.length === 0) return null;

    return (
        <div
            ref={listRef}
            style={{
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                borderRadius: 10,
                bottom: y,
                boxShadow: "var(--shadow-soft)",
                left: x,
                maxHeight: 280,
                maxWidth: 340,
                minWidth: 220,
                overflowY: "auto",
                padding: 4,
                position: "absolute",
                zIndex: 50,
            }}
        >
            {items.map((item, i) => {
                const isActive = i === selectedIndex;

                let icon: React.ReactNode;
                let label: string;
                let color: string;

                switch (item.kind) {
                    case "fetch":
                        icon = <FetchIcon />;
                        label = "@fetch";
                        color = "#10b981";
                        break;
                    case "plan":
                        icon = <PlanIcon />;
                        label = "/plan";
                        color = "var(--color-accent)";
                        break;
                    case "file":
                        icon = <FileIcon />;
                        label = item.label;
                        color = "var(--color-accent)";
                        break;
                    case "folder":
                        icon = <FolderIcon />;
                        label = item.label;
                        color = "var(--color-text-secondary)";
                        break;
                }

                return (
                    <button
                        key={`${item.kind}-${label}-${i}`}
                        data-selected={isActive}
                        onMouseDown={(e) => {
                            e.preventDefault();
                            onSelect(item);
                        }}
                        onMouseEnter={() => onHoverIndex(i)}
                        style={{
                            alignItems: "center",
                            background: isActive
                                ? "var(--color-bg-tertiary)"
                                : "transparent",
                            border: "none",
                            borderRadius: 6,
                            color: "var(--color-text-primary)",
                            cursor: "pointer",
                            display: "flex",
                            fontSize: "0.82em",
                            gap: 8,
                            padding: "6px 10px",
                            textAlign: "left",
                            width: "100%",
                        }}
                        type="button"
                    >
                        <span style={{ color, flexShrink: 0 }}>{icon}</span>
                        <span
                            style={{
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {label}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
