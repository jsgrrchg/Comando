import { useCallback, useEffect, useMemo } from "react";

import { getGitContextKey } from "@renderer/app/git/context-key";
import {
    buildGitBranchDiffSections,
    buildGitWorktreeDiffSections,
    parseGitDiffFileId,
} from "@renderer/app/git/presentation";
import {
    serializeBranchDiffToPatch,
    serializeWorktreeDiffToPatch,
} from "@renderer/app/git/worktree-diff-patch";
import { useResolvedEditorSettings } from "@renderer/app/hooks/use-resolved-editor-settings";
import { buildEditorFontFamily } from "@renderer/app/settings/theme";
import { useGitStore } from "@renderer/app/store/git-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitWorktreeDiffTab } from "@renderer/app/workspace/tree";
import type {
    GitBranchDiffFile,
    GitWorktreeDiffFile,
    GitWorktreeDiffResult,
} from "@shared/ipc";
import { GitDiffsView, GitEmptyState } from "@renderer/components/git";
import { PierreDiffWorkerPoolProvider } from "@renderer/components/git/PierreDiffWorkerPoolProvider";
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
    const mode = useGitStore(
        (state) => state.activeDiffModesByContext[contextKey] ?? "worktree",
    );
    const { handleScrollTop: handleDiffScrollTop, scrollRef: diffScrollRef } =
        usePersistedWorkspaceScroll<HTMLDivElement>({
            projectId,
            surface: tab.kind,
            worktreeId,
        });
    const editorSettings = useResolvedEditorSettings();
    const project = useProjectsStore((state) =>
        state.projects.find((candidate) => candidate.id === projectId),
    );
    const snapshot = useGitStore(
        (state) => state.snapshots[contextKey] ?? null,
    );
    const worktreeResult = useGitStore(
        (state) => state.worktreeDiffsByContext[contextKey] ?? null,
    );
    const branchResult = useGitStore(
        (state) => state.branchDiffsByContext[contextKey] ?? null,
    );
    const worktreeError = useGitStore(
        (state) => state.errors[contextKey] ?? null,
    );
    const branchError = useGitStore(
        (state) => state.branchDiffErrorsByContext[contextKey] ?? null,
    );
    const isWorktreeLoading = useGitStore(
        (state) => state.loadingWorktreeDiffContexts[contextKey] === true,
    );
    const isBranchLoading = useGitStore(
        (state) => state.loadingBranchDiffContexts[contextKey] === true,
    );
    const isWorktreeStale = useGitStore(
        (state) => state.staleWorktreeDiffContexts[contextKey] === true,
    );
    const isBranchStale = useGitStore(
        (state) => state.staleBranchDiffContexts[contextKey] === true,
    );
    const worktreeActiveFileId = useGitStore(
        (state) => state.selectedWorktreeDiffFileIds[contextKey] ?? null,
    );
    const branchActiveFileId = useGitStore(
        (state) => state.selectedBranchDiffFileIds[contextKey] ?? null,
    );
    const worktreeCollapsedFileIds = useGitStore(
        (state) =>
            state.collapsedWorktreeDiffFileIds[contextKey] ??
            EMPTY_COLLAPSED_FILE_IDS,
    );
    const branchCollapsedFileIds = useGitStore(
        (state) =>
            state.collapsedBranchDiffFileIds[contextKey] ??
            EMPTY_COLLAPSED_FILE_IDS,
    );
    const ensureWorktreeDiff = useGitStore((state) => state.ensureWorktreeDiff);
    const ensureBranchDiff = useGitStore((state) => state.ensureBranchDiff);
    const refreshProject = useGitStore((state) => state.refreshProject);
    const refreshWorktreeDiff = useGitStore((state) => state.refreshWorktreeDiff);
    const refreshBranchDiff = useGitStore((state) => state.refreshBranchDiff);
    const selectWorktreeDiffFile = useGitStore(
        (state) => state.selectWorktreeDiffFile,
    );
    const selectBranchDiffFile = useGitStore(
        (state) => state.selectBranchDiffFile,
    );
    const setActiveDiffMode = useGitStore((state) => state.setActiveDiffMode);
    const setWorktreeDiffCollapsedFileIds = useGitStore(
        (state) => state.setWorktreeDiffCollapsedFileIds,
    );
    const setBranchDiffCollapsedFileIds = useGitStore(
        (state) => state.setBranchDiffCollapsedFileIds,
    );
    const toggleWorktreeDiffFileCollapse = useGitStore(
        (state) => state.toggleWorktreeDiffFileCollapse,
    );
    const toggleBranchDiffFileCollapse = useGitStore(
        (state) => state.toggleBranchDiffFileCollapse,
    );
    const isBranchMode = mode === "branch";
    const result = isBranchMode ? branchResult : worktreeResult;
    const error = isBranchMode ? branchError : worktreeError;
    const isLoading = isBranchMode ? isBranchLoading : isWorktreeLoading;
    const isStale = isBranchMode ? isBranchStale : isWorktreeStale;
    const activeFileId = isBranchMode
        ? branchActiveFileId
        : worktreeActiveFileId;
    const collapsedFileIds = isBranchMode
        ? branchCollapsedFileIds
        : worktreeCollapsedFileIds;
    const stagePaths = useGitStore((state) => state.stagePaths);
    const unstagePaths = useGitStore((state) => state.unstagePaths);
    const discardPaths = useGitStore((state) => state.discardPaths);
    const openFileTab = useWorkspaceStore((state) => state.openFileTab);

    const codeFontFamily = buildEditorFontFamily(editorSettings.fontFamily);
    const codeFontSize = editorSettings.fontSize;
    const codeLineHeight = editorSettings.lineHeight;

    const handleOpenFile = useCallback(
        (file: GitWorktreeDiffFile | GitBranchDiffFile) => {
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
            isBranchMode
                ? buildGitBranchDiffSections(branchResult, {
                      onOpenFile: handleOpenFile,
                  })
                : buildGitWorktreeDiffSections(worktreeResult, {
                      onDiscardFile: handleDiscardFile,
                      onOpenFile: handleOpenFile,
                      onStageFile: handleStageFile,
                      onUnstageFile: handleUnstageFile,
                  }),
        [
            branchResult,
            handleDiscardFile,
            handleOpenFile,
            handleStageFile,
            handleUnstageFile,
            isBranchMode,
            worktreeResult,
        ],
    );
    const visibleSections = useMemo(
        () => sections.filter((section) => section.files.length > 0),
        [sections],
    );
    const allFiles = useMemo(
        () => visibleSections.flatMap((section) => section.files),
        [visibleSections],
    );
    const codeViewFiles = useMemo(
        () =>
            visibleSections.flatMap((section) =>
                section.files.map((file, index) =>
                    index === 0 && visibleSections.length > 1
                        ? { ...file, sectionLabel: section.title }
                        : file,
                ),
            ),
        [visibleSections],
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
        // Refresh metadata first so it cannot invalidate a freshly loaded full diff.
        void refreshProject(projectId, worktreeId).finally(() => {
            if (isBranchMode) {
                void refreshBranchDiff(projectId, worktreeId);
            } else {
                void refreshWorktreeDiff(projectId, worktreeId);
            }
        });
    }, [
        isBranchMode,
        projectId,
        refreshBranchDiff,
        refreshProject,
        refreshWorktreeDiff,
        worktreeId,
    ]);

    const handleDownloadAll = useCallback(() => {
        const patch = isBranchMode
            ? serializeBranchDiffToPatch(branchResult)
            : serializeWorktreeDiffToPatch(worktreeResult);
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
        anchor.download = `${safeName}-${isBranchMode ? "branch-changes" : "uncommitted"}.patch`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }, [branchResult, isBranchMode, project?.name, worktreeResult]);

    const handleStageAll = useCallback(() => {
        const paths = collectActionPaths(worktreeResult, [
            "unstaged",
            "untracked",
        ]);
        if (paths.length > 0) {
            void stagePaths(projectId, paths, worktreeId);
        }
    }, [projectId, stagePaths, worktreeId, worktreeResult]);

    const handleUnstageAll = useCallback(() => {
        const paths = collectActionPaths(worktreeResult, ["staged"]);
        if (paths.length > 0) {
            void unstagePaths(projectId, paths, worktreeId);
        }
    }, [projectId, unstagePaths, worktreeId, worktreeResult]);

    const handleDiscardAll = useCallback(() => {
        const paths = collectActionPaths(worktreeResult, [
            "staged",
            "unstaged",
            "untracked",
        ]);
        if (paths.length === 0) {
            return;
        }

        const confirmed = window.confirm(
            `Discard all ${paths.length} change${paths.length === 1 ? "" : "s"}?\n\nThis cannot be undone.`,
        );
        if (!confirmed) {
            return;
        }

        void discardPaths(projectId, paths, worktreeId);
    }, [discardPaths, projectId, worktreeId, worktreeResult]);

    const handleToggleAll = useCallback(() => {
        const setCollapsed = isBranchMode
            ? setBranchDiffCollapsedFileIds
            : setWorktreeDiffCollapsedFileIds;
        setCollapsed(projectId, allCollapsed ? [] : allFileIds, worktreeId);
    }, [
        allCollapsed,
        allFileIds,
        isBranchMode,
        projectId,
        setBranchDiffCollapsedFileIds,
        setWorktreeDiffCollapsedFileIds,
        worktreeId,
    ]);

    const handleToggleFileCollapse = useCallback(
        (fileId: string) => {
            const toggleCollapse = isBranchMode
                ? toggleBranchDiffFileCollapse
                : toggleWorktreeDiffFileCollapse;
            toggleCollapse(projectId, fileId, worktreeId);
        },
        [
            isBranchMode,
            projectId,
            toggleBranchDiffFileCollapse,
            toggleWorktreeDiffFileCollapse,
            worktreeId,
        ],
    );

    const handleSelectFile = useCallback(
        (file: { readonly id: string }) => {
            const selectFile = isBranchMode
                ? selectBranchDiffFile
                : selectWorktreeDiffFile;
            selectFile(projectId, file.id, worktreeId);
        },
        [
            isBranchMode,
            projectId,
            selectBranchDiffFile,
            selectWorktreeDiffFile,
            worktreeId,
        ],
    );
    useEffect(() => {
        if (!snapshot) {
            void refreshProject(projectId, worktreeId);
            return;
        }

        if (!isLoading) {
            if (isBranchMode) {
                void ensureBranchDiff(projectId, worktreeId);
            } else {
                void ensureWorktreeDiff(projectId, worktreeId);
            }
        }
        // A follow-up invalidation can arrive while a diff request is in flight.
        // Watching both values schedules one catch-up only while this tab is active.
    }, [
        ensureBranchDiff,
        ensureWorktreeDiff,
        isBranchMode,
        isLoading,
        isStale,
        projectId,
        refreshProject,
        snapshot,
        worktreeId,
    ]);

    return (
        <div className="flex h-full min-h-0 select-none flex-col bg-bg-primary">
            <header className="border-b border-border px-5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-3">
                        {/* Project and worktree are already implied by the tab context. */}
                        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-secondary">
                            {isBranchMode
                                ? "Branch Changes"
                                : "Uncommitted Changes"}
                        </p>
                        <div
                            aria-label="Diff source"
                            className="flex overflow-hidden rounded border border-border"
                            role="tablist"
                        >
                            {(
                                [
                                    ["worktree", "Uncommitted Changes"],
                                    ["branch", "Branch Changes"],
                                ] as const
                            ).map(([value, label]) => (
                                <button
                                    aria-selected={mode === value}
                                    className={`h-6 px-2 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                                        mode === value
                                            ? "bg-bg-tertiary text-text-primary"
                                            : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
                                    }`}
                                    key={value}
                                    onClick={() =>
                                        setActiveDiffMode(
                                            projectId,
                                            value,
                                            worktreeId,
                                        )
                                    }
                                    onKeyDown={(event) => {
                                        if (
                                            event.key !== "ArrowLeft" &&
                                            event.key !== "ArrowRight" &&
                                            event.key !== "Home" &&
                                            event.key !== "End"
                                        ) {
                                            return;
                                        }
                                        event.preventDefault();
                                        setActiveDiffMode(
                                            projectId,
                                            event.key === "Home"
                                                ? "worktree"
                                                : event.key === "End"
                                                  ? "branch"
                                                  : value === "worktree"
                                                    ? "branch"
                                                    : "worktree",
                                            worktreeId,
                                        );
                                    }}
                                    role="tab"
                                    type="button"
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
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
                        {!isBranchMode ? (
                            <>
                                <IdeActionButton
                                    disabled={
                                        collectActionPaths(worktreeResult, [
                                            "unstaged",
                                            "untracked",
                                        ]).length === 0
                                    }
                                    onClick={handleStageAll}
                                    title="Stage all visible changes"
                                >
                                    stage all
                                </IdeActionButton>
                                <IdeActionButton
                                    disabled={
                                        collectActionPaths(worktreeResult, [
                                            "staged",
                                        ]).length === 0
                                    }
                                    onClick={handleUnstageAll}
                                    title="Unstage all staged changes"
                                >
                                    unstage all
                                </IdeActionButton>
                                <IdeActionButton
                                    disabled={changedFileCount === 0}
                                    onClick={handleDiscardAll}
                                    title="Discard all changes (cannot be undone)"
                                >
                                    discard all
                                </IdeActionButton>
                            </>
                        ) : null}
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

                <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[11px] text-text-secondary">
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

            <main className="flex min-h-0 flex-1 flex-col">
                {!result && !isLoading && error ? (
                    <div className="flex h-full items-center justify-center px-6">
                        <GitEmptyState>{error}</GitEmptyState>
                    </div>
                ) : isLoading && !result ? (
                    <div className="flex h-full items-center justify-center text-[13px] text-text-secondary">
                        {isBranchMode
                            ? "Loading branch changes..."
                            : "Loading project diff..."}
                    </div>
                ) : changedFileCount === 0 ? (
                    // Borderless, centered label reads cleaner than a boxed empty state.
                    <div className="flex h-full items-center justify-center text-[13px] text-text-secondary">
                        {isBranchMode
                            ? (branchResult?.unavailableReason ??
                              "No branch changes against the resolved base.")
                            : "No uncommitted changes in this worktree."}
                    </div>
                ) : (
                    <PierreDiffWorkerPoolProvider>
                        <GitDiffsView
                            activeFileId={activeFileId}
                            className="px-3 py-3"
                            codeFontFamily={codeFontFamily}
                            codeFontSize={codeFontSize}
                            codeLineHeight={codeLineHeight}
                            collapsedFileIds={collapsedFileIds}
                            displayMode="stack"
                            files={codeViewFiles}
                            lineWrapping={false}
                            onScrollTop={handleDiffScrollTop}
                            onSelectFile={handleSelectFile}
                            onToggleFileCollapse={handleToggleFileCollapse}
                            scrollRef={diffScrollRef}
                            showFileSelector={false}
                            surfaceVariant="flat"
                        />
                    </PierreDiffWorkerPoolProvider>
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
