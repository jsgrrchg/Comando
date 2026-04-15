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
                className="app-no-drag flex w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border"
                style={{
                    background:
                        "color-mix(in srgb, var(--color-bg-elevated) 96%, var(--color-bg-primary))",
                    borderColor:
                        "color-mix(in srgb, var(--color-border) 82%, var(--color-accent) 18%)",
                    boxShadow:
                        "0 24px 80px rgba(0, 0, 0, 0.18), 0 0 0 1px color-mix(in srgb, var(--color-accent) 8%, transparent)",
                }}
            >
                <div
                    className="border-b px-4 pb-3 pt-3"
                    style={{
                        borderColor:
                            "color-mix(in srgb, var(--color-border) 76%, transparent)",
                    }}
                >
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="truncate text-[11px] font-medium uppercase tracking-[0.18em] text-text-secondary">
                                Quick Open
                            </p>
                            <p className="truncate text-[12px] text-text-secondary">
                                {projectName ?? "Open a project to search files"}
                            </p>
                        </div>
                        {loading ? (
                            <span
                                className="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-text-secondary"
                                style={{
                                    borderColor:
                                        "color-mix(in srgb, var(--color-accent) 26%, var(--color-border))",
                                    background:
                                        "color-mix(in srgb, var(--color-accent) 9%, transparent)",
                                }}
                            >
                                Indexing
                            </span>
                        ) : null}
                    </div>

                    <div
                        className="flex items-center gap-3 rounded-xl border px-3 py-2.5"
                        style={{
                            borderColor:
                                "color-mix(in srgb, var(--color-accent) 16%, var(--color-border))",
                            background:
                                "color-mix(in srgb, var(--color-bg-primary) 72%, var(--color-bg-elevated))",
                        }}
                    >
                        <svg
                            aria-hidden="true"
                            className="shrink-0 text-text-secondary"
                            fill="none"
                            height="15"
                            viewBox="0 0 16 16"
                            width="15"
                        >
                            <circle
                                cx="7"
                                cy="7"
                                r="4.5"
                                stroke="currentColor"
                                strokeWidth="1.3"
                            />
                            <path
                                d="M10.5 10.5L14 14"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeWidth="1.3"
                            />
                        </svg>
                        <input
                            autoCapitalize="off"
                            autoComplete="off"
                            autoCorrect="off"
                            className="min-w-0 flex-1 bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-secondary/80"
                            onChange={(event) => onChangeQuery(event.target.value)}
                            onKeyDown={onInputKeyDown}
                            placeholder="Search files by name or path..."
                            ref={inputRef}
                            spellCheck={false}
                            type="text"
                            value={query}
                        />
                    </div>
                </div>

                <div
                    className="shell-scrollbar max-h-[min(56vh,520px)] overflow-y-auto p-2"
                    ref={listRef}
                >
                    {results.length > 0 ? (
                        results.map((item, index) => {
                            const isSelected = index === selectedIndex;

                            return (
                                <button
                                    className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition"
                                    data-quick-open-selected={isSelected}
                                    key={item.relativePath}
                                    onClick={() => onSelect(item)}
                                    onMouseEnter={() => onHoverIndex(index)}
                                    onMouseMove={(event) =>
                                        syncHoverSelection(event, isSelected, () =>
                                            onHoverIndex(index),
                                        )
                                    }
                                    style={{
                                        background: isSelected
                                            ? "color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-primary))"
                                            : "transparent",
                                        borderColor: isSelected
                                            ? "color-mix(in srgb, var(--color-accent) 24%, var(--color-border))"
                                            : "transparent",
                                    }}
                                    type="button"
                                >
                                    <div className="mt-0.5 shrink-0">
                                        <FileTypeIcon
                                            fileName={item.name}
                                            opacity={isSelected ? 0.92 : 0.72}
                                            size={15}
                                        />
                                    </div>

                                    <div className="min-w-0 flex-1">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span className="truncate text-[13px] font-medium text-text-primary">
                                                {item.name}
                                            </span>
                                            {item.extension ? (
                                                <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-text-secondary">
                                                    {item.extension}
                                                </span>
                                            ) : null}
                                        </div>
                                        <p className="truncate font-mono text-[11px] text-text-secondary">
                                            {getDirectoryLabel(item.relativePath)}
                                        </p>
                                    </div>

                                    <span className="shrink-0 text-[11px] text-text-secondary">
                                        {isSelected ? "Open" : ""}
                                    </span>
                                </button>
                            );
                        })
                    ) : (
                        <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 px-6 text-center">
                            <p className="text-[13px] font-medium text-text-primary">
                                {query.trim()
                                    ? "No matching files"
                                    : "Start typing to browse project files"}
                            </p>
                            <p className="max-w-[420px] text-[11px] text-text-secondary">
                                {projectName
                                    ? loading
                                        ? "The project tree is still being indexed, so more results may appear in a moment."
                                        : "Match by filename, folders or a compact fuzzy query like wsv for WorkspaceView."
                                    : "Add or select a project first to use quick file search."}
                            </p>
                        </div>
                    )}
                </div>

                <div
                    className="flex items-center justify-between gap-3 border-t px-4 py-2 text-[11px] text-text-secondary"
                    style={{
                        borderColor:
                            "color-mix(in srgb, var(--color-border) 76%, transparent)",
                    }}
                >
                    <span className="truncate">
                        {results.length > 0
                            ? `${results.length} result${results.length === 1 ? "" : "s"}`
                            : "No results"}
                    </span>
                    <span className="shrink-0">↑↓ Navigate · Enter Open · Esc Close</span>
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
