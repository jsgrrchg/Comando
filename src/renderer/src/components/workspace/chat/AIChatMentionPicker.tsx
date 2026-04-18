import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { ProjectTreeNode } from "@shared/ipc";

import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";
import {
    CHAT_COMPOSER_PICKER_MAX_HEIGHT,
    CHAT_COMPOSER_PICKER_MAX_WIDTH,
    CHAT_COMPOSER_PICKER_MIN_WIDTH,
    getViewportSafeMenuPosition,
} from "@renderer/app/utils/menu-position";

/* ─── Types ─── */

export type MentionSuggestion =
    | { readonly kind: "fetch" }
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
    readonly anchorRef: RefObject<HTMLElement | null>;
    readonly open: boolean;
    readonly x: number;
    readonly y: number;
    readonly selectedIndex: number;
    readonly items: readonly MentionSuggestion[];
    readonly onHoverIndex: (index: number) => void;
    readonly onSelect: (item: MentionSuggestion) => void;
    readonly onClose: () => void;
}

interface PickerPosition {
    readonly maxHeight: number;
    readonly x: number;
    readonly y: number;
}

/* ─── Helpers ─── */

const FETCH_KEYWORDS = ["fetch", "web", "search", "internet"];

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
    anchorRef,
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
    const [position, setPosition] = useState<PickerPosition | null>(null);

    const updatePosition = useCallback(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;

        const anchorRect = anchor.getBoundingClientRect();
        const menuRect = listRef.current?.getBoundingClientRect();
        const width = Math.min(
            CHAT_COMPOSER_PICKER_MAX_WIDTH,
            Math.max(
                CHAT_COMPOSER_PICKER_MIN_WIDTH,
                Math.ceil(menuRect?.width ?? CHAT_COMPOSER_PICKER_MIN_WIDTH),
            ),
        );
        const availableHeightAbove = Math.max(0, anchorRect.top - y - 8);
        const availableHeightBelow = Math.max(
            0,
            window.innerHeight - anchorRect.bottom - y - 8,
        );
        const estimatedHeight = Math.min(
            CHAT_COMPOSER_PICKER_MAX_HEIGHT,
            items.length * 42 + 12,
        );
        const measuredHeight = Math.ceil(menuRect?.height ?? estimatedHeight);
        const openAbove =
            availableHeightAbove >= measuredHeight ||
            availableHeightAbove >= availableHeightBelow;
        const maxHeight = Math.min(
            CHAT_COMPOSER_PICKER_MAX_HEIGHT,
            openAbove ? availableHeightAbove : availableHeightBelow,
        );
        const height = Math.min(maxHeight, measuredHeight);
        const safePosition = getViewportSafeMenuPosition(
            anchorRect.left + x,
            8,
            width,
            0,
        );

        setPosition({
            maxHeight,
            x: safePosition.x,
            y: openAbove
                ? Math.max(8, anchorRect.top - height - y)
                : Math.min(
                      window.innerHeight - height - 8,
                      anchorRect.bottom + y,
                  ),
        });
    }, [anchorRef, items.length, x, y]);

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
        if (!open) return;

        const handleViewportChange = () => {
            updatePosition();
        };

        handleViewportChange();
        window.addEventListener("resize", handleViewportChange);
        window.addEventListener("scroll", handleViewportChange, true);
        return () => {
            window.removeEventListener("resize", handleViewportChange);
            window.removeEventListener("scroll", handleViewportChange, true);
        };
    }, [open, updatePosition]);

    useLayoutEffect(() => {
        if (!open) return;
        updatePosition();
    }, [open, updatePosition]);

    useEffect(() => {
        const el = listRef.current?.querySelector("[data-selected='true']");
        el?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    if (!open || items.length === 0) return null;

    return createPortal(
        <div
            ref={listRef}
            style={{
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                borderRadius: 10,
                boxShadow: "var(--shadow-soft)",
                left: position?.x ?? 8,
                maxHeight:
                    position?.maxHeight ?? CHAT_COMPOSER_PICKER_MAX_HEIGHT,
                maxWidth: CHAT_COMPOSER_PICKER_MAX_WIDTH,
                minWidth: CHAT_COMPOSER_PICKER_MIN_WIDTH,
                overflowY: "auto",
                padding: 6,
                position: "fixed",
                top: position?.y ?? 8,
                zIndex: 10010,
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
                    case "file":
                        icon = (
                            <FileTypeIcon
                                fileName={item.entry.name}
                                opacity={0.58}
                                size={12}
                            />
                        );
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
                        onMouseEnter={(e) => {
                            onHoverIndex(i);
                            if (!isActive) {
                                e.currentTarget.style.background =
                                    "var(--color-bg-secondary)";
                            }
                        }}
                        onMouseLeave={(e) => {
                            if (!isActive) {
                                e.currentTarget.style.background =
                                    "transparent";
                            }
                        }}
                        style={{
                            alignItems: "center",
                            background: isActive
                                ? "var(--color-bg-tertiary)"
                                : "transparent",
                            border: "none",
                            borderRadius: 8,
                            color: "var(--color-text-primary)",
                            cursor: "pointer",
                            display: "flex",
                            fontSize: "0.9em",
                            gap: 10,
                            padding: "8px 12px",
                            textAlign: "left",
                            transition: "background-color 100ms ease",
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
        </div>,
        document.body,
    );
}
