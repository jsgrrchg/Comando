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
    CHAT_COMPOSER_PICKER_MIN_WIDTH,
    getComposerAnchoredPickerWidth,
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
    readonly width: number;
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

function getParentDirectoryLabel(relativePath: string): string {
    const lastSlashIndex = relativePath.lastIndexOf("/");
    if (lastSlashIndex < 0) return "";
    return relativePath.slice(0, lastSlashIndex);
}

/* ─── Icon components ─── */

function FetchIcon() {
    return (
        <svg
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="14"
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
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="14"
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
        const width = getComposerAnchoredPickerWidth(
            anchorRect.width ||
                menuRect?.width ||
                CHAT_COMPOSER_PICKER_MIN_WIDTH,
            window.innerWidth,
        );
        const availableHeightAbove = Math.max(0, anchorRect.top - y - 8);
        const availableHeightBelow = Math.max(
            0,
            window.innerHeight - anchorRect.bottom - y - 8,
        );
        const estimatedHeight = Math.min(
            CHAT_COMPOSER_PICKER_MAX_HEIGHT,
            items.length * 26 + 8,
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
            width,
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
            className="shell-scrollbar overflow-y-auto border py-1"
            style={{
                background: "var(--color-bg-elevated)",
                borderColor:
                    "color-mix(in srgb, var(--color-border) 80%, transparent)",
                borderRadius: 8,
                boxShadow:
                    "0 12px 32px rgba(0, 0, 0, 0.18), 0 0 0 1px color-mix(in srgb, var(--color-border) 40%, transparent)",
                left: position?.x ?? 8,
                maxHeight:
                    position?.maxHeight ?? CHAT_COMPOSER_PICKER_MAX_HEIGHT,
                position: "fixed",
                top: position?.y ?? 8,
                width: position?.width ?? CHAT_COMPOSER_PICKER_MIN_WIDTH,
                zIndex: 10010,
            }}
        >
            {items.map((item, i) => {
                const isActive = i === selectedIndex;

                let icon: React.ReactNode;
                let label: string;
                let secondary = "";

                switch (item.kind) {
                    case "fetch":
                        icon = <FetchIcon />;
                        label = "@fetch";
                        secondary = "Fetch URL";
                        break;
                    case "file":
                        icon = (
                            <FileTypeIcon
                                fileName={item.entry.name}
                                opacity={isActive ? 0.92 : 0.6}
                                size={14}
                            />
                        );
                        label = item.label;
                        secondary = getParentDirectoryLabel(
                            item.entry.relativePath,
                        );
                        break;
                    case "folder":
                        icon = <FolderIcon />;
                        label = item.label;
                        secondary = getParentDirectoryLabel(
                            item.entry.relativePath,
                        );
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
                        className="flex w-full items-center gap-2 px-3 py-1 text-left"
                        style={{
                            background: isActive
                                ? "color-mix(in srgb, var(--color-accent) 14%, var(--color-bg-primary))"
                                : "transparent",
                            border: "none",
                            cursor: "pointer",
                        }}
                        type="button"
                    >
                        <span
                            className="flex shrink-0 items-center justify-center"
                            style={{
                                color: isActive
                                    ? "var(--color-text-primary)"
                                    : "var(--color-text-secondary)",
                                height: 14,
                                width: 14,
                            }}
                        >
                            {icon}
                        </span>
                        <span
                            className="truncate text-[13px]"
                            style={{ color: "var(--color-text-primary)" }}
                        >
                            {label}
                        </span>
                        {secondary ? (
                            <span
                                className="min-w-0 truncate font-mono text-[11px]"
                                style={{
                                    color: "color-mix(in srgb, var(--color-text-secondary) 75%, transparent)",
                                }}
                            >
                                {secondary}
                            </span>
                        ) : null}
                    </button>
                );
            })}
        </div>,
        document.body,
    );
}
