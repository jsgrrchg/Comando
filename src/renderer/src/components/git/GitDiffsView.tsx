import { useMemo, useState } from "react";

import { DiffLineView } from "@renderer/components/workspace/review/DiffLineView";

import { GitBadge, GitEmptyState } from "./GitUi";
import type {
    GitDiffFile,
    GitDiffHunk,
    GitDiffLine,
    GitDiffsViewProps,
} from "./types";

export function GitDiffsView({
    activeFileId = null,
    className,
    codeFontFamily = null,
    codeFontSize = null,
    codeLineHeight = null,
    displayMode = "single",
    emptyState,
    files,
    onScroll,
    onSelectFile,
    showFileSelector = true,
    surfaceVariant = "panel",
}: GitDiffsViewProps) {
    const [collapsedFileIds, setCollapsedFileIds] = useState<readonly string[]>(
        [],
    );
    const fileIdSet = useMemo(
        () => new Set(files.map((file) => file.id)),
        [files],
    );

    const collapsedFileIdSet = useMemo(
        () =>
            new Set(collapsedFileIds.filter((fileId) => fileIdSet.has(fileId))),
        [collapsedFileIds, fileIdSet],
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
                        <button
                            aria-pressed={file.id === activeFile.id}
                            className={[
                                "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-left text-[11px] transition-colors",
                                file.id === activeFile.id
                                    ? "border-[color-mix(in_srgb,var(--color-accent)_34%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-bg-secondary))] text-text-primary"
                                    : "border-border bg-bg-secondary text-text-secondary hover:text-text-primary",
                            ].join(" ")}
                            key={file.id}
                            onClick={() => onSelectFile?.(file)}
                            type="button"
                        >
                            <GitBadge tone={diffTone(file.kind)}>
                                {file.statusLabel ?? file.kind}
                            </GitBadge>
                            <span className="truncate font-mono">
                                {file.path}
                            </span>
                        </button>
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
                            key={file.id}
                            onToggleCollapse={() =>
                                setCollapsedFileIds((currentIds) =>
                                    currentIds.includes(file.id)
                                        ? currentIds.filter(
                                              (fileId) => fileId !== file.id,
                                          )
                                        : [...currentIds, file.id],
                                )
                            }
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
                    surfaceVariant={surfaceVariant}
                />
            )}
        </div>
    );
}

function DiffFileSurface({
    codeFontFamily = null,
    codeFontSize = null,
    codeLineHeight = null,
    collapsed = false,
    file,
    onToggleCollapse,
    surfaceVariant,
}: {
    readonly codeFontFamily?: string | null;
    readonly codeFontSize?: number | null;
    readonly codeLineHeight?: number | null;
    readonly collapsed?: boolean;
    readonly file: GitDiffFile;
    readonly onToggleCollapse?: (() => void) | undefined;
    readonly surfaceVariant: "flat" | "panel";
}) {
    const isCollapsible = typeof onToggleCollapse === "function";
    const headerContent = (
        <>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    {isCollapsible ? (
                        <CollapseChevron collapsed={collapsed} />
                    ) : null}
                    <span className="truncate font-mono text-[14px] font-medium">
                        <span className="text-text-secondary">
                            {file.path.substring(
                                0,
                                file.path.lastIndexOf("/") + 1,
                            )}
                        </span>
                        <span className="text-text-primary">
                            {file.path.substring(
                                file.path.lastIndexOf("/") + 1,
                            )}
                        </span>
                    </span>
                    <GitBadge tone={diffTone(file.kind)}>
                        {file.statusLabel ?? file.kind}
                    </GitBadge>
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
                {collapsed ? (
                    <span className="text-[11px] text-text-secondary">
                        {describeCollapsedFile(file)}
                    </span>
                ) : null}
                {file.summary ? (
                    <p className="flex items-center gap-1.5 text-[13px]">
                        <DiffSummaryColored summary={file.summary} />
                    </p>
                ) : null}
            </div>
        </>
    );

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
                <button
                    aria-expanded={!collapsed}
                    className={[
                        "flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-secondary/55",
                        surfaceVariant === "panel" && !collapsed
                            ? "border-b border-border"
                            : "",
                    ].join(" ")}
                    onClick={() => onToggleCollapse?.()}
                    type="button"
                >
                    {headerContent}
                </button>
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
                            <div className="overflow-x-auto">
                                <div className="min-w-[640px]">
                                    {hunk.lines.map((line) => (
                                        <DiffLineRow
                                            codeFontFamily={codeFontFamily}
                                            codeFontSize={codeFontSize}
                                            codeLineHeight={codeLineHeight}
                                            filePath={file.path}
                                            key={line.id}
                                            line={line}
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
                        No hunks were produced for this file.
                    </GitEmptyState>
                </div>
            )}
        </section>
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

function describeCollapsedFile(file: GitDiffFile): string {
    if (!file.isText) {
        return "binary";
    }

    if (file.hunks.length === 0) {
        return "no hunks";
    }

    return `${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"}`;
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

function DiffLineRow({
    codeFontFamily,
    codeFontSize,
    codeLineHeight,
    filePath,
    line,
}: {
    readonly codeFontFamily?: string | null;
    readonly codeFontSize?: number | null;
    readonly codeLineHeight?: number | null;
    readonly filePath: string;
    readonly line: GitDiffLine;
}) {
    return (
        <DiffLineView
            filePath={filePath}
            fontFamily={codeFontFamily}
            fontSize={codeFontSize}
            lineHeight={codeLineHeight}
            line={{
                exact: true,
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
                        ? "add"
                        : line.kind === "remove"
                          ? "remove"
                          : "context",
            }}
        />
    );
}

function diffTone(kind: GitDiffFile["kind"]) {
    switch (kind) {
        case "create":
            return "success";
        case "delete":
            return "danger";
        case "move":
            return "accent";
        case "update":
        default:
            return "warning";
    }
}
