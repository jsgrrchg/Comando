import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { AiAvailableCommand } from "@shared/ipc";

import {
    CHAT_COMPOSER_PICKER_MAX_HEIGHT,
    CHAT_COMPOSER_PICKER_MAX_WIDTH,
    CHAT_COMPOSER_PICKER_MIN_WIDTH,
    getViewportSafeMenuPosition,
} from "@renderer/app/utils/menu-position";

interface AIChatCommandPickerProps {
    readonly anchorRef: RefObject<HTMLElement | null>;
    readonly open: boolean;
    readonly x: number;
    readonly y: number;
    readonly selectedIndex: number;
    readonly items: readonly AiAvailableCommand[];
    readonly onHoverIndex: (index: number) => void;
    readonly onSelect: (item: AiAvailableCommand) => void;
    readonly onClose: () => void;
}

interface PickerPosition {
    readonly maxHeight: number;
    readonly x: number;
    readonly y: number;
}

export function getCommandSuggestions(
    query: string,
    commands: readonly AiAvailableCommand[],
): AiAvailableCommand[] {
    const q = query.toLowerCase().trim();
    if (!q) return [...commands];
    return commands.filter(
        (cmd) =>
            cmd.id.toLowerCase().includes(q) ||
            cmd.label.toLowerCase().includes(q) ||
            cmd.description.toLowerCase().includes(q),
    );
}

export function AIChatCommandPicker({
    anchorRef,
    open,
    x,
    y,
    selectedIndex,
    items,
    onHoverIndex,
    onSelect,
    onClose,
}: AIChatCommandPickerProps) {
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
            items.length * 52 + 12,
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
            {items.map((cmd, i) => {
                const isActive = i === selectedIndex;
                return (
                    <button
                        key={cmd.id}
                        data-selected={isActive}
                        onMouseDown={(e) => {
                            e.preventDefault();
                            onSelect(cmd);
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
                            background: isActive
                                ? "var(--color-bg-tertiary)"
                                : "transparent",
                            border: "none",
                            borderRadius: 8,
                            color: "var(--color-text-primary)",
                            cursor: "pointer",
                            display: "flex",
                            flexDirection: "column",
                            fontSize: "0.9em",
                            gap: 4,
                            padding: "8px 12px",
                            textAlign: "left",
                            transition: "background-color 100ms ease",
                            width: "100%",
                        }}
                        type="button"
                    >
                        <span style={{ fontWeight: 500 }}>{cmd.label}</span>
                        <span
                            style={{
                                color: "var(--color-text-secondary)",
                                fontSize: "0.9em",
                            }}
                        >
                            {cmd.description}
                        </span>
                    </button>
                );
            })}
        </div>,
        document.body,
    );
}
