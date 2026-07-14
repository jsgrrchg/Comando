import {
    useCallback,
    useMemo,
    useState,
    type ReactNode,
    type RefObject,
} from "react";

import type { GitRevisionFileDiff } from "@shared/ipc";
import { convertRevisionFilesToDiffFiles } from "@renderer/app/git/history-presentation";
import { useResolvedEditorSettings } from "@renderer/app/hooks/use-resolved-editor-settings";
import { buildEditorFontFamily } from "@renderer/app/settings/theme";
import { GitDiffsView } from "@renderer/components/git";

import { IdeActionButton } from "./ide-bar";

export function GitRevisionDiffView({
    additions,
    deletions,
    files,
    leadingContent,
    scrollContainerRef,
    totalFileCount,
}: {
    readonly additions: number;
    readonly deletions: number;
    readonly files: readonly GitRevisionFileDiff[];
    readonly leadingContent?: ReactNode;
    readonly scrollContainerRef?: RefObject<HTMLElement | null>;
    readonly totalFileCount: number;
}) {
    const settings = useResolvedEditorSettings();
    const diffFiles = useMemo(
        () => convertRevisionFilesToDiffFiles(files),
        [files],
    );
    const [collapsedFileIds, setCollapsedFileIds] = useState<readonly string[]>(
        [],
    );
    const collapsedFileIdSet = useMemo(
        () => new Set(collapsedFileIds),
        [collapsedFileIds],
    );
    const allCollapsed =
        diffFiles.length > 0 &&
        diffFiles.every((file) => collapsedFileIdSet.has(file.id));
    const toggleFile = useCallback((fileId: string) => {
        setCollapsedFileIds((current) =>
            current.includes(fileId)
                ? current.filter((id) => id !== fileId)
                : [...current, fileId],
        );
    }, []);
    const toggleAll = useCallback(() => {
        setCollapsedFileIds(
            allCollapsed ? [] : diffFiles.map((file) => file.id),
        );
    }, [allCollapsed, diffFiles]);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div
                className="flex flex-wrap items-center gap-3 border-y border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-5 py-1.5 font-mono text-[10.5px] text-text-secondary"
            >
                {leadingContent}
                {diffFiles.length > 0 ? (
                    <IdeActionButton
                        onClick={toggleAll}
                        title={allCollapsed ? "Expand all files" : "Collapse all files"}
                    >
                        {allCollapsed ? "expand all" : "collapse all"}
                    </IdeActionButton>
                ) : null}
                <span className="ml-auto shrink-0">
                    {totalFileCount} {totalFileCount === 1 ? "file" : "files"}
                </span>
                {additions > 0 ? (
                    <span className="shrink-0" style={{ color: "var(--diff-add)" }}>
                        +{additions}
                    </span>
                ) : null}
                {deletions > 0 ? (
                    <span className="shrink-0" style={{ color: "var(--diff-remove)" }}>
                        -{deletions}
                    </span>
                ) : null}
            </div>
            <GitDiffsView
                codeFontFamily={buildEditorFontFamily(settings.fontFamily)}
                codeFontSize={settings.fontSize}
                codeLineHeight={settings.lineHeight}
                collapsedFileIds={collapsedFileIds}
                displayMode="stack"
                emptyState="This pull request has no file changes."
                files={diffFiles}
                lineWrapping={false}
                onToggleFileCollapse={toggleFile}
                scrollContainerRef={scrollContainerRef}
                showFileSelector={false}
                surfaceVariant="flat"
            />
        </div>
    );
}
