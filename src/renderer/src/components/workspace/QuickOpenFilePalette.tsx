import {
    useEffect,
    useRef,
    type KeyboardEventHandler,
    type MouseEvent,
} from "react";
import { createPortal } from "react-dom";

import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";

import type { ProjectQuickOpenMatch } from "@renderer/app/projects/quick-open";

interface QuickOpenFilePaletteProps {
    readonly loading: boolean;
    readonly onChangeQuery: (value: string) => void;
    readonly onClose: () => void;
    readonly onHoverIndex: (index: number) => void;
    readonly onInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
    readonly onSelect: (item: ProjectQuickOpenMatch) => void;
    readonly open: boolean;
    readonly projectName: string | null;
    readonly query: string;
    readonly results: readonly ProjectQuickOpenMatch[];
    readonly selectedIndex: number;
}

export function QuickOpenFilePalette({
    loading,
    onChangeQuery,
    onClose,
    onHoverIndex,
    onInputKeyDown,
    onSelect,
    open,
    projectName,
    query,
    results,
    selectedIndex,
}: QuickOpenFilePaletteProps) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }

        const frameId = window.requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
        });

        return () => window.cancelAnimationFrame(frameId);
    }, [open]);

    useEffect(() => {
        if (!open) {
            return;
        }

        const selectedElement = listRef.current?.querySelector<HTMLElement>(
            "[data-quick-open-selected='true']",
        );
        selectedElement?.scrollIntoView({ block: "nearest" });
    }, [open, selectedIndex]);

    if (!open) {
        return null;
    }

    return createPortal(
        <div
            className="app-no-drag fixed inset-0 z-[10030] flex items-start justify-center px-5 pt-[min(12vh,88px)]"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
            style={{
                background:
                    "color-mix(in srgb, var(--color-bg-primary) 72%, transparent)",
                backdropFilter: "blur(10px)",
            }}
        >
            <div
                className="app-no-drag flex w-full max-w-[620px] flex-col overflow-hidden rounded-xl border"
                style={{
                    background: "var(--color-bg-elevated)",
                    borderColor:
                        "color-mix(in srgb, var(--color-border) 80%, transparent)",
                    boxShadow:
                        "0 24px 80px rgba(0, 0, 0, 0.22), 0 0 0 1px color-mix(in srgb, var(--color-border) 40%, transparent)",
                }}
            >
                <input
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    className="w-full border-b bg-transparent px-3.5 py-2.5 text-[14px] text-text-primary outline-none placeholder:text-text-secondary/60"
                    onChange={(event) => onChangeQuery(event.target.value)}
                    onKeyDown={onInputKeyDown}
                    placeholder={
                        projectName
                            ? `Search files in ${projectName}…`
                            : "Search files by name or path…"
                    }
                    ref={inputRef}
                    spellCheck={false}
                    style={{
                        borderColor:
                            "color-mix(in srgb, var(--color-border) 60%, transparent)",
                    }}
                    type="text"
                    value={query}
                />

                <div
                    className="shell-scrollbar max-h-[min(56vh,480px)] overflow-y-auto py-1"
                    ref={listRef}
                >
                    {results.length > 0 ? (
                        results.map((item, index) => {
                            const isSelected = index === selectedIndex;

                            return (
                                <button
                                    className="flex w-full items-center gap-2.5 px-3.5 py-[5px] text-left"
                                    data-quick-open-selected={isSelected}
                                    key={item.relativePath}
                                    onClick={() => onSelect(item)}
                                    onMouseEnter={() => onHoverIndex(index)}
                                    onMouseMove={(event) =>
                                        syncHoverSelection(
                                            event,
                                            isSelected,
                                            () => onHoverIndex(index),
                                        )
                                    }
                                    style={{
                                        background: isSelected
                                            ? "color-mix(in srgb, var(--color-accent) 14%, var(--color-bg-primary))"
                                            : "transparent",
                                    }}
                                    type="button"
                                >
                                    <FileTypeIcon
                                        fileName={item.name}
                                        opacity={isSelected ? 0.92 : 0.62}
                                        size={15}
                                    />

                                    <span className="truncate text-[13px] font-medium text-text-primary">
                                        {item.name}
                                    </span>

                                    <span className="min-w-0 truncate font-mono text-[11px] text-text-secondary/70">
                                        {getDirectoryLabel(item.relativePath)}
                                    </span>
                                </button>
                            );
                        })
                    ) : (
                        <div className="px-3.5 py-6 text-center text-[12px] text-text-secondary">
                            {query.trim()
                                ? "No matching files"
                                : projectName
                                  ? "Type to search project files"
                                  : "Open a project to search files"}
                        </div>
                    )}
                </div>

                <div
                    className="flex items-center justify-between border-t px-3.5 py-1.5 text-[11px] text-text-secondary/70"
                    style={{
                        borderColor:
                            "color-mix(in srgb, var(--color-border) 50%, transparent)",
                    }}
                >
                    <span>{loading ? "Indexing…" : ""}</span>
                    <span>↑↓ Navigate · Enter Open · Esc Close</span>
                </div>
            </div>
        </div>,
        document.body,
    );
}

function getDirectoryLabel(relativePath: string): string {
    const lastSlashIndex = relativePath.lastIndexOf("/");

    if (lastSlashIndex < 0) {
        return "Project root";
    }

    return relativePath.slice(0, lastSlashIndex);
}

function syncHoverSelection(
    event: MouseEvent<HTMLButtonElement>,
    isSelected: boolean,
    onChange: () => void,
) {
    if (isSelected || event.movementX === 0 || event.movementY === 0) {
        return;
    }

    onChange();
}
