import { useEffect, useRef } from "react";

import type { AiAvailableCommand } from "@shared/ipc";

interface AIChatCommandPickerProps {
    readonly open: boolean;
    readonly x: number;
    readonly y: number;
    readonly selectedIndex: number;
    readonly items: readonly AiAvailableCommand[];
    readonly onHoverIndex: (index: number) => void;
    readonly onSelect: (item: AiAvailableCommand) => void;
    readonly onClose: () => void;
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
                        onMouseEnter={() => onHoverIndex(i)}
                        style={{
                            background: isActive
                                ? "var(--color-bg-tertiary)"
                                : "transparent",
                            border: "none",
                            borderRadius: 6,
                            color: "var(--color-text-primary)",
                            cursor: "pointer",
                            display: "flex",
                            flexDirection: "column",
                            fontSize: "0.82em",
                            gap: 2,
                            padding: "6px 10px",
                            textAlign: "left",
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
        </div>
    );
}
