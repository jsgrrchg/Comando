import {
    memo,
    useCallback,
    useMemo,
    useState,
} from "react";

import { GitEmptyState } from "./GitUi";
import { PierreGitCodeView } from "./PierreGitCodeView";
import { PierreGitDiffErrorBoundary } from "./PierreGitDiffErrorBoundary";
import { createPierreGitCodeViewItems } from "./PierreGitDiffModel";
import type {
    GitDiffFile,
    GitDiffsViewProps,
} from "./types";

export const GIT_DIFF_FILE_VIRTUALIZATION_THRESHOLD = 25;
export const GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD = 1_000;

export function GitDiffsView({
    activeFileId = null,
    className,
    codeFontFamily = null,
    codeFontSize = null,
    codeLineHeight = null,
    collapsedFileIds: controlledCollapsedFileIds,
    displayMode = "single",
    diffStyle = "unified",
    emptyState,
    files,
    lineWrapping = true,
    onScrollTop,
    onSelectFile,
    onToggleFileCollapse,
    scrollRef,
    showFileSelector = true,
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
    const pierreFiles = useMemo(
        () => (displayMode === "stack" ? files : activeFile ? [activeFile] : []),
        [activeFile, displayMode, files],
    );
    const pierreItems = useMemo(
        () => createPierreGitCodeViewItems(pierreFiles),
        [pierreFiles],
    );

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
        <div className="flex min-h-0 flex-1 flex-col">
            {showFileSelector ? (
                <div className="mb-3 flex flex-wrap items-center gap-2 px-2 pt-2">
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
            <PierreGitDiffErrorBoundary
                fallback={
                    <GitEmptyState className={className}>
                        This diff could not be rendered.
                    </GitEmptyState>
                }
                fileId={pierreFiles.map((file) => file.id).join("|")}
            >
                <PierreGitCodeView
                    activeFileId={activeFileId}
                    className={className}
                    codeFontFamily={codeFontFamily}
                    codeFontSize={codeFontSize}
                    codeLineHeight={codeLineHeight}
                    collapsedFileIds={collapsedFileIdSet}
                    diffStyle={diffStyle}
                    files={pierreFiles}
                    items={pierreItems}
                    lineWrapping={lineWrapping}
                    onScrollTop={onScrollTop}
                    onToggleFileCollapse={toggleFileCollapse}
                    scrollRef={scrollRef}
                />
            </PierreGitDiffErrorBoundary>
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
