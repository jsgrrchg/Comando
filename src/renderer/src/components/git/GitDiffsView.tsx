import {
    memo,
    useCallback,
    useMemo,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";

import { DiffLineView } from "@renderer/components/workspace/review/DiffLineView";

import { GitBadge, GitEmptyState } from "./GitUi";
import type {
    GitDiffFile,
    GitDiffHunk,
    GitDiffLine,
    GitDiffsViewProps,
} from "./types";

// Baseline thresholds for the upcoming diff virtualization pass.
export const GIT_DIFF_FILE_VIRTUALIZATION_THRESHOLD = 60;
export const GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD = 2_000;

export function GitDiffsView({
    activeFileId = null,
    className,
    codeFontFamily = null,
    codeFontSize = null,
    codeLineHeight = null,
    collapsedFileIds: controlledCollapsedFileIds,
    displayMode = "single",
    emptyState,
    files,
    lineWrapping = true,
    onScroll,
    onSelectFile,
    onToggleFileCollapse,
    showFileSelector = true,
    surfaceVariant = "panel",
}: GitDiffsViewProps) {
    const isControlled = controlledCollapsedFileIds !== undefined;
    const [localCollapsedFileIds, setLocalCollapsedFileIds] = useState<
        readonly string[]
    >([]);
    const collapsedFileIds = isControlled
        ? controlledCollapsedFileIds
        : localCollapsedFileIds;
    const fileIdSet = useMemo(
        () => new Set(files.map((file) => file.id)),
        [files],
    );

    const collapsedFileIdSet = useMemo(
        () =>
            new Set(collapsedFileIds.filter((fileId) => fileIdSet.has(fileId))),
        [collapsedFileIds, fileIdSet],
    );

    const toggleFileCollapse = useCallback(
        (fileId: string) => {
            if (onToggleFileCollapse) {
                onToggleFileCollapse(fileId);
                return;
            }
            setLocalCollapsedFileIds((currentIds) =>
                currentIds.includes(fileId)
                    ? currentIds.filter((id) => id !== fileId)
                    : [...currentIds, fileId],
            );
        },
        [onToggleFileCollapse],
    );
    const activeFile =
        files.find((file) => file.id === activeFileId) ?? files[0] ?? null;

    if (files.length === 0) {
        return (
            <GitEmptyState className={className}>
                {emptyState ?? "Pick a change to inspect its diff."}
            </GitEmptyState>
        );
    }

    if (!activeFile) {
        return (
            <GitEmptyState className={className}>
                {emptyState ?? "No diff selected."}
            </GitEmptyState>
        );
    }

    return (
        <div
            className={[
                "shell-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
            onScroll={onScroll}
        >
            {showFileSelector ? (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    {files.map((file) => (
                        <FileSelectorButton
                            file={file}
                            isActive={file.id === activeFile.id}
                            key={file.id}
                            onSelect={onSelectFile}
                        />
                    ))}
                </div>
            ) : null}

            {displayMode === "stack" ? (
                <div className="space-y-3">
                    {files.map((file) => (
                        <DiffFileSurface
                            codeFontFamily={codeFontFamily}
                            codeFontSize={codeFontSize}
                            codeLineHeight={codeLineHeight}
                            collapsed={collapsedFileIdSet.has(file.id)}
                            file={file}
                            fileId={file.id}
                            key={file.id}
                            lineWrapping={lineWrapping}
                            onToggleCollapse={toggleFileCollapse}
                            surfaceVariant={surfaceVariant}
                        />
                    ))}
                </div>
            ) : (
                <DiffFileSurface
                    codeFontFamily={codeFontFamily}
                    codeFontSize={codeFontSize}
                    codeLineHeight={codeLineHeight}
                    file={activeFile}
                    lineWrapping={lineWrapping}
                    surfaceVariant={surfaceVariant}
                />
            )}
        </div>
    );
}

const FileSelectorButton = memo(function FileSelectorButton({
    file,
    isActive,
    onSelect,
}: {
    readonly file: GitDiffFile;
    readonly isActive: boolean;
    readonly onSelect?: ((file: GitDiffFile) => void) | undefined;
}) {
    const handleClick = useCallback(() => {
        onSelect?.(file);
    }, [file, onSelect]);
    return (
        <button
            aria-pressed={isActive}
            className={[
                "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-left text-[11px] transition-colors",
                isActive
                    ? "border-[color-mix(in_srgb,var(--color-accent)_34%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-bg-secondary))] text-text-primary"
                    : "border-border bg-bg-secondary text-text-secondary hover:text-text-primary",
            ].join(" ")}
            onClick={handleClick}
            type="button"
        >
            <span
                className="truncate font-mono"
                style={{ color: diffKindColor(file.kind) }}
                title={file.statusLabel ?? file.kind}
            >
                {file.path}
            </span>
        </button>
    );
});

const DiffFileSurface = memo(function DiffFileSurface({
    codeFontFamily = null,
    codeFontSize = null,
    codeLineHeight = null,
    collapsed = false,
    file,
    fileId,
    lineWrapping = true,
    onToggleCollapse,
    surfaceVariant,
}: {
    readonly codeFontFamily?: string | null;
    readonly codeFontSize?: number | null;
    readonly codeLineHeight?: number | null;
    readonly collapsed?: boolean;
    readonly file: GitDiffFile;
    readonly fileId?: string;
    readonly lineWrapping?: boolean;
    readonly onToggleCollapse?: ((fileId: string) => void) | undefined;
    readonly surfaceVariant: "flat" | "panel";
}) {
    const isCollapsible = typeof onToggleCollapse === "function";
    const handleToggle = useCallback(() => {
        if (onToggleCollapse && fileId !== undefined) {
            onToggleCollapse(fileId);
        }
    }, [onToggleCollapse, fileId]);
    const headerContent = (
        <>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    {isCollapsible ? (
                        <CollapseChevron collapsed={collapsed} />
                    ) : null}
                    <span
                        className="truncate font-mono text-[14px] font-medium"
                        title={file.statusLabel ?? file.kind}
                    >
                        <span className="text-text-secondary">
                            {file.path.substring(
                                0,
                                file.path.lastIndexOf("/") + 1,
                            )}
                        </span>
                        <span style={{ color: diffKindColor(file.kind) }}>
                            {file.path.substring(
                                file.path.lastIndexOf("/") + 1,
                            )}
                        </span>
                    </span>
                    {file.reversible ? (
                        <GitBadge tone="neutral">reversible</GitBadge>
                    ) : null}
                </div>
                {file.previousPath ? (
                    <p className="mt-1 truncate text-[11px] text-text-secondary">
                        Previous path: {file.previousPath}
                    </p>
                ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-2">
                {file.summary ? (
                    <p className="flex items-center gap-1.5 text-[13px]">
                        <DiffSummaryColored summary={file.summary} />
                    </p>
                ) : null}
            </div>
        </>
    );
    const actionButtons =
        file.actions && file.actions.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1.5">
                {file.actions.map((action) => (
                    <DiffFileActionButton action={action} key={action.id} />
                ))}
            </div>
        ) : null;

    return (
        <section
            className={[
                "overflow-hidden",
                surfaceVariant === "panel"
                    ? "rounded-xl border border-border bg-bg-secondary"
                    : "bg-bg-primary",
            ].join(" ")}
        >
            {isCollapsible ? (
                <div
                    className={[
                        "flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-secondary/55",
                        surfaceVariant === "panel" && !collapsed
                            ? "border-b border-border"
                            : "",
                    ].join(" ")}
                >
                    <button
                        aria-expanded={!collapsed}
                        className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 text-left"
                        onClick={handleToggle}
                        type="button"
                    >
                        {headerContent}
                    </button>
                    {actionButtons}
                </div>
            ) : (
                <div
                    className={[
                        "flex flex-wrap items-center justify-between gap-2 px-3 py-2",
                        surfaceVariant === "panel"
                            ? "border-b border-border"
                            : "",
                    ].join(" ")}
                >
                    {headerContent}
                    {actionButtons}
                </div>
            )}

            {collapsed ? null : !file.isText ? (
                <div className="p-3">
                    <GitEmptyState>
                        This file is binary, so Comando can show metadata but
                        not a textual diff.
                    </GitEmptyState>
                </div>
            ) : file.hunks.length > 0 ? (
                <div className="space-y-3 p-3">
                    {file.hunks.map((hunk) => (
                        <section
                            className="overflow-hidden rounded-lg border border-border bg-bg-primary"
                            key={hunk.id}
                        >
                            <div className="border-b border-border px-3 py-1.5 font-mono text-[10px] text-text-secondary/50">
                                {formatHunkHeader(hunk)}
                            </div>
                            <div className="select-text overflow-x-auto">
                                <div
                                    className={
                                        lineWrapping
                                            ? "min-w-160"
                                            : "min-w-full w-max"
                                    }
                                >
                                    {hunk.lines.map((line) => (
                                        <DiffLineRow
                                            codeFontFamily={codeFontFamily}
                                            codeFontSize={codeFontSize}
                                            codeLineHeight={codeLineHeight}
                                            filePath={file.path}
                                            key={line.id}
                                            line={line}
                                            lineWrapping={lineWrapping}
                                        />
                                    ))}
                                </div>
                            </div>
                        </section>
                    ))}
                </div>
            ) : (
                <div className="p-3">
                    <GitEmptyState>
                        {file.emptyState ??
                            "No hunks were produced for this file."}
                    </GitEmptyState>
                </div>
            )}
        </section>
    );
});

function DiffFileActionButton({
    action,
}: {
    readonly action: NonNullable<GitDiffFile["actions"]>[number];
}) {
    const handleClick = useCallback(
        (event: ReactMouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            action.onClick();
        },
        [action],
    );

    return (
        <button
            aria-label={action.ariaLabel}
            className={[
                "review-text-btn rounded border px-2 py-1 text-[10px] font-medium",
                action.tone === "danger"
                    ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
                    : "border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary",
                action.disabled ? "cursor-not-allowed opacity-50" : "",
            ].join(" ")}
            disabled={action.disabled || action.busy}
            onClick={handleClick}
            title={action.ariaLabel ?? action.label}
            type="button"
        >
            {action.busy ? "..." : action.label}
        </button>
    );
}

function CollapseChevron({ collapsed }: { readonly collapsed: boolean }) {
    return (
        <svg
            aria-hidden="true"
            className={[
                "shrink-0 text-text-secondary transition-transform",
                collapsed ? "" : "rotate-90",
            ].join(" ")}
            fill="none"
            height="12"
            viewBox="0 0 16 16"
            width="12"
        >
            <path
                d="M6 4.5 9.5 8 6 11.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.4"
            />
        </svg>
    );
}

function formatHunkHeader(hunk: GitDiffHunk): string {
    const oldEnd = hunk.oldStart + hunk.oldCount - 1;
    const newEnd = hunk.newStart + hunk.newCount - 1;
    const oldRange =
        hunk.oldCount === 1 ? `${hunk.oldStart}` : `${hunk.oldStart}–${oldEnd}`;
    const newRange =
        hunk.newCount === 1 ? `${hunk.newStart}` : `${hunk.newStart}–${newEnd}`;
    return `${oldRange} → ${newRange}`;
}

function DiffSummaryColored({ summary }: { readonly summary: string }) {
    const parts = summary.split(/\s+/);
    return (
        <>
            {parts.map((part, i) => {
                if (part.startsWith("+")) {
                    return (
                        <span key={i} style={{ color: "var(--diff-add)" }}>
                            {part}
                        </span>
                    );
                }
                if (part.startsWith("-")) {
                    return (
                        <span key={i} style={{ color: "var(--diff-remove)" }}>
                            {part}
                        </span>
                    );
                }
                return (
                    <span key={i} className="text-text-secondary">
                        {part}
                    </span>
                );
            })}
        </>
    );
}

const DiffLineRow = memo(function DiffLineRow({
    codeFontFamily,
    codeFontSize,
    codeLineHeight,
    filePath,
    line,
    lineWrapping = true,
}: {
    readonly codeFontFamily?: string | null;
    readonly codeFontSize?: number | null;
    readonly codeLineHeight?: number | null;
    readonly filePath: string;
    readonly line: GitDiffLine;
    readonly lineWrapping?: boolean;
}) {
    const viewLine = useMemo(
        () => ({
            exact: true as const,
            newLineNumber: line.newLineNumber,
            oldLineNumber: line.oldLineNumber,
            prefix:
                line.kind === "add"
                    ? "+ "
                    : line.kind === "remove"
                      ? "- "
                      : "  ",
            text: line.text,
            type:
                line.kind === "add"
                    ? ("add" as const)
                    : line.kind === "remove"
                      ? ("remove" as const)
                      : ("context" as const),
        }),
        [line],
    );
    return (
        <DiffLineView
            compactLineNumbers
            filePath={filePath}
            fontFamily={codeFontFamily}
            fontSize={codeFontSize}
            lineHeight={codeLineHeight}
            line={viewLine}
            lineWrapping={lineWrapping}
        />
    );
});

function diffKindColor(kind: GitDiffFile["kind"]): string {
    switch (kind) {
        case "create":
            return "var(--diff-add)";
        case "delete":
            return "var(--diff-remove)";
        case "move":
            return "var(--color-accent)";
        case "update":
        default:
            return "var(--diff-warn)";
    }
}
