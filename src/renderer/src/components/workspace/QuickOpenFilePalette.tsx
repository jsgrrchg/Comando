import {
    useEffect,
    useId,
    useRef,
    type KeyboardEventHandler,
    type MouseEvent,
} from "react";
import { createPortal } from "react-dom";

import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";

import type { ProjectQuickOpenMatch } from "@renderer/app/projects/quick-open";
import { useModalFocusScope } from "@renderer/components/accessibility/useModalFocusScope";

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
    const id = useId();
    const backdropRef = useRef<HTMLDivElement | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    useModalFocusScope({
        active: open,
        containerRef: dialogRef,
        initialFocusRef: inputRef,
        modalRootRef: backdropRef,
        onDismiss: onClose,
    });

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

    const listboxId = `${id}-listbox`;
    const selectedOptionId = results[selectedIndex]
        ? `${id}-option-${selectedIndex}`
        : undefined;

    return createPortal(
        <div
            className="shell-modal-backdrop app-no-drag fixed inset-0 z-10030 flex items-start justify-center px-5 pt-[min(12vh,88px)]"
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
            ref={backdropRef}
        >
            <div
                aria-label="Quick open file"
                aria-modal="true"
                className="app-no-drag flex w-full max-w-155 flex-col overflow-hidden rounded-xl border"
                ref={dialogRef}
                role="dialog"
                style={{
                    background: "var(--color-bg-elevated)",
                    borderColor:
                        "color-mix(in srgb, var(--color-border) 80%, transparent)",
                    boxShadow:
                        "0 24px 80px rgba(0, 0, 0, 0.22), 0 0 0 1px color-mix(in srgb, var(--color-border) 40%, transparent)",
                }}
                tabIndex={-1}
            >
                <input
                    aria-activedescendant={selectedOptionId}
                    aria-autocomplete="list"
                    aria-controls={listboxId}
                    aria-expanded="true"
                    aria-label="Search project files"
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
                    role="combobox"
                    spellCheck={false}
                    style={{
                        borderColor:
                            "color-mix(in srgb, var(--color-border) 60%, transparent)",
                    }}
                    type="text"
                    value={query}
                />

                <div
                    aria-busy={loading}
                    aria-label="Matching project files"
                    className="shell-scrollbar max-h-[min(56vh,480px)] overflow-y-auto py-1"
                    id={listboxId}
                    ref={listRef}
                    role="listbox"
                >
                    {results.length > 0 ? (
                        results.map((item, index) => {
                            const isSelected = index === selectedIndex;

                            return (
                                <button
                                    aria-selected={isSelected}
                                    className="flex w-full items-center gap-2.5 px-3.5 py-1.25 text-left"
                                    data-quick-open-selected={isSelected}
                                    id={`${id}-option-${index}`}
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
                                    role="option"
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
                    <span aria-live="polite">
                        {loading ? "Searching…" : ""}
                    </span>
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
