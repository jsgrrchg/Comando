import { useCallback, useEffect, useMemo, useRef } from "react";

import { getGitContextKey } from "@renderer/app/git/context-key";
import {
    buildGitWorktreeDiffSections,
    parseGitDiffFileId,
} from "@renderer/app/git/presentation";
import { serializeWorktreeDiffToPatch } from "@renderer/app/git/worktree-diff-patch";
import { useResolvedEditorSettings } from "@renderer/app/hooks/use-resolved-editor-settings";
import { buildEditorFontFamily } from "@renderer/app/settings/theme";
import { useGitStore } from "@renderer/app/store/git-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitWorktreeDiffTab } from "@renderer/app/workspace/tree";
import type { GitWorktreeDiffFile, GitWorktreeDiffResult } from "@shared/ipc";
import { GitDiffsView, GitEmptyState } from "@renderer/components/git";
import { usePersistedWorkspaceScroll } from "@renderer/components/workspace/usePersistedWorkspaceScroll";
import { IdeActionButton } from "./ide-bar";

const EMPTY_COLLAPSED_FILE_IDS: readonly string[] = [];

function getContextKey(projectId: string, worktreeId: string | null): string {
    return getGitContextKey(projectId, worktreeId);
}

export function GitWorktreeDiffTabView({
    tab,
}: {
    readonly tab: RuntimeWorkspaceGitWorktreeDiffTab;
}) {
    const projectId = tab.projectId;
    const worktreeId = tab.worktreeId ?? null;
    const contextKey = getContextKey(projectId, worktreeId);
    const { handleScroll: handleDiffScroll, scrollRef: diffScrollRef } =
        usePersistedWorkspaceScroll<HTMLDivElement>({
            projectId,
            surface: tab.kind,
            worktreeId,
        });
    const diffScrollContainerRef = useRef<HTMLDivElement | null>(null);
    const editorSettings = useResolvedEditorSettings();
    const project = useProjectsStore((state) =>
        state.projects.find((candidate) => candidate.id === projectId),
    );
    const snapshot = useGitStore(
        (state) => state.snapshots[contextKey] ?? null,
    );
    const result = useGitStore(
        (state) => state.worktreeDiffsByContext[contextKey] ?? null,
    );
    const error = useGitStore((state) => state.errors[contextKey] ?? null);
    const isLoading = useGitStore(
        (state) => state.loadingWorktreeDiffContexts[contextKey] === true,
    );
    const activeFileId = useGitStore(
        (state) => state.selectedWorktreeDiffFileIds[contextKey] ?? null,
    );
    const collapsedFileIds = useGitStore(
        (state) =>
            state.collapsedWorktreeDiffFileIds[contextKey] ??
            EMPTY_COLLAPSED_FILE_IDS,
    );
    const ensureWorktreeDiff = useGitStore(
        (state) => state.ensureWorktreeDiff,
    );
    const refreshProject = useGitStore((state) => state.refreshProject);
    const refreshWorktreeDiff = useGitStore(
        (state) => state.refreshWorktreeDiff,
    );
    const selectWorktreeDiffFile = useGitStore(
        (state) => state.selectWorktreeDiffFile,
    );
    const setWorktreeDiffCollapsedFileIds = useGitStore(
        (state) => state.setWorktreeDiffCollapsedFileIds,
    );
    const toggleWorktreeDiffFileCollapse = useGitStore(
        (state) => state.toggleWorktreeDiffFileCollapse,
    );
    const stagePaths = useGitStore((state) => state.stagePaths);
    const unstagePaths = useGitStore((state) => state.unstagePaths);
    const discardPaths = useGitStore((state) => state.discardPaths);
    const openFileTab = useWorkspaceStore((state) => state.openFileTab);

    const codeFontFamily = buildEditorFontFamily(editorSettings.fontFamily);
    const codeFontSize = editorSettings.fontSize;
    const codeLineHeight = editorSettings.lineHeight;

    const handleOpenFile = useCallback(
        (file: GitWorktreeDiffFile) => {
            void openFileTab(projectId, file.path, worktreeId);
        },
        [openFileTab, projectId, worktreeId],
    );

    const handleStageFile = useCallback(
        (file: GitWorktreeDiffFile) => {
            void stagePaths(projectId, [file.path], worktreeId);
        },
        [projectId, stagePaths, worktreeId],
    );

    const handleUnstageFile = useCallback(
        (file: GitWorktreeDiffFile) => {
            void unstagePaths(projectId, [file.path], worktreeId);
        },
        [projectId, unstagePaths, worktreeId],
    );

    const handleDiscardFile = useCallback(
        (file: GitWorktreeDiffFile) => {
            const confirmed = window.confirm(
                file.scope === "untracked"
                    ? `Delete untracked file "${file.path}"?\n\nThis cannot be undone.`
                    : `Discard changes to "${file.path}"?\n\nThis cannot be undone.`,
            );
            if (!confirmed) {
                return;
            }

            void discardPaths(projectId, [file.path], worktreeId);
        },
        [discardPaths, projectId, worktreeId],
    );

    const sections = useMemo(
        () =>
            buildGitWorktreeDiffSections(result, {
                onDiscardFile: handleDiscardFile,
                onOpenFile: handleOpenFile,
                onStageFile: handleStageFile,
                onUnstageFile: handleUnstageFile,
            }),
        [
            handleDiscardFile,
            handleOpenFile,
            handleStageFile,
            handleUnstageFile,
            result,
        ],
    );
    const allFiles = useMemo(
        () => sections.flatMap((section) => section.files),
        [sections],
    );
    const changedFileCount = allFiles.length;
    const totals = useMemo(
        () =>
            sections.reduce(
                (current, section) => ({
                    additions: current.additions + section.additions,
                    deletions: current.deletions + section.deletions,
                }),
                { additions: 0, deletions: 0 },
            ),
        [sections],
    );
    const activeSelection = activeFileId
        ? parseGitDiffFileId(activeFileId)
        : null;
    const allFileIds = useMemo(
        () => allFiles.map((file) => file.id),
        [allFiles],
    );
    const allCollapsed =
        allFileIds.length > 0 &&
        allFileIds.every((fileId) => collapsedFileIds.includes(fileId));

    const handleRefresh = useCallback(() => {
        void refreshProject(projectId, worktreeId);
        void refreshWorktreeDiff(projectId, worktreeId);
    }, [projectId, refreshProject, refreshWorktreeDiff, worktreeId]);

    const handleDownloadAll = useCallback(() => {
        const patch = serializeWorktreeDiffToPatch(result);
        if (!patch) {
            return;
        }

        const safeName = (project?.name ?? "repository").replace(
            /[^\w.-]+/g,
            "-",
        );
        const blob = new Blob([patch], { type: "text/x-patch" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${safeName}-uncommitted.patch`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }, [project?.name, result]);

    const handleStageAll = useCallback(() => {
        const paths = collectActionPaths(result, ["unstaged", "untracked"]);
        if (paths.length > 0) {
            void stagePaths(projectId, paths, worktreeId);
        }
    }, [projectId, result, stagePaths, worktreeId]);

    const handleUnstageAll = useCallback(() => {
        const paths = collectActionPaths(result, ["staged"]);
        if (paths.length > 0) {
            void unstagePaths(projectId, paths, worktreeId);
        }
    }, [projectId, result, unstagePaths, worktreeId]);

    const handleToggleAll = useCallback(() => {
        setWorktreeDiffCollapsedFileIds(
            projectId,
            allCollapsed ? [] : allFileIds,
            worktreeId,
        );
    }, [
        allCollapsed,
        allFileIds,
        projectId,
        setWorktreeDiffCollapsedFileIds,
        worktreeId,
    ]);

    const handleToggleFileCollapse = useCallback(
        (fileId: string) =>
            toggleWorktreeDiffFileCollapse(projectId, fileId, worktreeId),
        [projectId, toggleWorktreeDiffFileCollapse, worktreeId],
    );

    const handleSelectFile = useCallback(
        (file: { readonly id: string }) =>
            selectWorktreeDiffFile(projectId, file.id, worktreeId),
        [projectId, selectWorktreeDiffFile, worktreeId],
    );
    const setDiffScrollContainer = useCallback(
        (node: HTMLDivElement | null) => {
            diffScrollContainerRef.current = node;
            diffScrollRef(node);
        },
        [diffScrollRef],
    );

    useEffect(() => {
        if (!snapshot) {
            void refreshProject(projectId, worktreeId);
        }

        void ensureWorktreeDiff(projectId, worktreeId);
    }, [ensureWorktreeDiff, projectId, refreshProject, snapshot, worktreeId]);

    if (!result && !isLoading && error) {
        return (
            <div className="flex h-full items-center justify-center px-6">
                <GitEmptyState>{error}</GitEmptyState>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 select-none flex-col bg-bg-primary">
            <header className="border-b border-border px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-secondary">
                            Uncommitted Changes
                        </p>
                        <h2 className="mt-1 truncate text-[18px] font-semibold text-text-primary">
                            {project?.name ?? "Repository"}
                        </h2>
                        <p className="mt-1 truncate text-[12px] text-text-secondary">
                            {snapshot?.branch?.name ?? "Working tree"}
                            {snapshot?.branch?.isDetached ? " (detached)" : ""}
                            {snapshot?.currentWorktreeId ? (
                                <> · {snapshot.currentWorktreeId}</>
                            ) : null}
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <IdeActionButton onClick={handleRefresh} title="Refresh diff">
                            {isLoading ? "refreshing" : "refresh"}
                        </IdeActionButton>
                        <IdeActionButton
                            disabled={changedFileCount === 0}
                            onClick={handleDownloadAll}
                            title="Download all changes as a .patch file"
                        >
                            download all
                        </IdeActionButton>
                        <IdeActionButton
                            disabled={collectActionPaths(result, [
                                "unstaged",
                                "untracked",
                            ]).length === 0}
                            onClick={handleStageAll}
                            title="Stage all visible changes"
                        >
                            stage all
                        </IdeActionButton>
                        <IdeActionButton
                            disabled={collectActionPaths(result, ["staged"]).length === 0}
                            onClick={handleUnstageAll}
                            title="Unstage all staged changes"
                        >
                            unstage all
                        </IdeActionButton>
                        {allFileIds.length > 0 ? (
                            <IdeActionButton
                                onClick={handleToggleAll}
                                title={
                                    allCollapsed
                                        ? "Expand all files"
                                        : "Collapse all files"
                                }
                            >
                                {allCollapsed ? "expand all" : "collapse all"}
                            </IdeActionButton>
                        ) : null}
                    </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-[11px] text-text-secondary">
                    <span>
                        {changedFileCount}{" "}
                        {changedFileCount === 1 ? "file" : "files"}
                    </span>
                    {totals.additions > 0 ? (
                        <span style={{ color: "var(--diff-add)" }}>
                            +{totals.additions}
                        </span>
                    ) : null}
                    {totals.deletions > 0 ? (
                        <span style={{ color: "var(--diff-remove)" }}>
                            -{totals.deletions}
                        </span>
                    ) : null}
                    {activeSelection ? (
                        <span className="truncate text-text-secondary/70">
                            Focus: {activeSelection.scope} ·{" "}
                            {activeSelection.path}
                        </span>
                    ) : null}
                </div>
            </header>

            <main
                className="shell-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3"
                onScroll={handleDiffScroll}
                ref={setDiffScrollContainer}
            >
                {isLoading && !result ? (
                    <GitEmptyState>Loading project diff...</GitEmptyState>
                ) : changedFileCount === 0 ? (
                    <GitEmptyState>
                        No uncommitted changes in this worktree.
                    </GitEmptyState>
                ) : (
                    <div className="space-y-5">
                        {sections
                            .filter((section) => section.files.length > 0)
                            .map((section) => (
                                <section key={section.id}>
                                    <div className="mb-2 flex items-center gap-2 px-2">
                                        <h3 className="text-[12px] font-semibold text-text-primary">
                                            {section.title}
                                        </h3>
                                        <span className="text-[11px] text-text-secondary">
                                            {section.files.length}{" "}
                                            {section.files.length === 1
                                                ? "file"
                                                : "files"}
                                        </span>
                                        <span className="font-mono text-[10px]">
                                            {section.additions > 0 ? (
                                                <span
                                                    style={{
                                                        color: "var(--diff-add)",
                                                    }}
                                                >
                                                    +{section.additions}
                                                </span>
                                            ) : null}{" "}
                                            {section.deletions > 0 ? (
                                                <span
                                                    style={{
                                                        color: "var(--diff-remove)",
                                                    }}
                                                >
                                                    -{section.deletions}
                                                </span>
                                            ) : null}
                                        </span>
                                    </div>
                                    <GitDiffsView
                                        activeFileId={activeFileId}
                                        codeFontFamily={codeFontFamily}
                                        codeFontSize={codeFontSize}
                                        codeLineHeight={codeLineHeight}
                                        collapsedFileIds={collapsedFileIds}
                                        displayMode="stack"
                                        files={section.files}
                                        lineWrapping={false}
                                        onSelectFile={handleSelectFile}
                                        onToggleFileCollapse={
                                            handleToggleFileCollapse
                                        }
                                        scrollContainerRef={
                                            diffScrollContainerRef
                                        }
                                        showFileSelector={false}
                                        surfaceVariant="flat"
                                    />
                                </section>
                            ))}
                    </div>
                )}
            </main>
        </div>
    );
}

function collectActionPaths(
    result: GitWorktreeDiffResult | null,
    scopes: readonly GitWorktreeDiffFile["scope"][],
): readonly string[] {
    if (!result) {
        return [];
    }

    const scopeSet = new Set(scopes);
    return Array.from(
        new Set(
            result.sections.flatMap((section) =>
                section.files
                    .filter(
                        (file) =>
                            scopeSet.has(file.scope) && !file.isConflicted,
                    )
                    .map((file) => file.path),
            ),
        ),
    );
}
