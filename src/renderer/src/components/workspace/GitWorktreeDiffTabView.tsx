import { useCallback, useEffect, useMemo, type ReactNode } from "react";

import { getGitContextKey } from "@renderer/app/git/context-key";
import {
    buildGitBranchDiffSections,
    buildGitWorktreeDiffSections,
    parseGitDiffFileId,
} from "@renderer/app/git/presentation";
import { useResolvedEditorSettings } from "@renderer/app/hooks/use-resolved-editor-settings";
import { buildEditorFontFamily } from "@renderer/app/settings/theme";
import { useGitStore } from "@renderer/app/store/git-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitWorktreeDiffTab } from "@renderer/app/workspace/tree";
import type {
    GitBranchDiffFile,
    GitWorktreeDiffFile,
    GitWorktreeDiffResult,
} from "@shared/ipc";
import {
    GitDiffStyleControl,
    GitDiffsView,
    GitEmptyState,
    usePersistedGitDiffStyle,
} from "@renderer/components/git";
import { PierreDiffWorkerPoolProvider } from "@renderer/components/git/PierreDiffWorkerPoolProvider";
import { usePersistedWorkspaceScroll } from "@renderer/components/workspace/usePersistedWorkspaceScroll";
import { IdeIconButton } from "./ide-bar";

const EMPTY_COLLAPSED_FILE_IDS: readonly string[] = [];

function getContextKey(projectId: string, worktreeId: string | null): string {
    return getGitContextKey(projectId, worktreeId);
}

function DiffHeaderIcon({
    children,
    size = 13,
}: {
    readonly children: ReactNode;
    readonly size?: number;
}) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height={size}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.75"
            viewBox="0 0 24 24"
            width={size}
        >
            {children}
        </svg>
    );
}

function RefreshDiffIcon() {
    return (
        <DiffHeaderIcon>
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
        </DiffHeaderIcon>
    );
}

function DiscardAllIcon() {
    return (
        <DiffHeaderIcon>
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <line x1="10" x2="10" y1="11" y2="17" />
            <line x1="14" x2="14" y1="11" y2="17" />
        </DiffHeaderIcon>
    );
}

function ExpandAllIcon() {
    return (
        <DiffHeaderIcon>
            <path d="M7 15l5 5 5-5" />
            <path d="M7 9l5-5 5 5" />
        </DiffHeaderIcon>
    );
}

function CollapseAllIcon() {
    return (
        <DiffHeaderIcon>
            <path d="M7 4l5 5 5-5" />
            <path d="M7 20l5-5 5 5" />
        </DiffHeaderIcon>
    );
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
    const [diffStyle, setDiffStyle] = usePersistedGitDiffStyle();
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
    const tabTitle = isBranchMode
        ? "Branch Changes"
        : "Uncommitted Changes";
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
    const updateGitWorktreeDiffTabTitle = useWorkspaceStore(
        (state) => state.updateGitWorktreeDiffTabTitle,
    );

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

    // Bulk stage/unstage live in the left Git sidebar; keep only destructive discard here.
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
        // Keep the persisted tab label aligned with the diff source shown in its view.
        void updateGitWorktreeDiffTabTitle(tab.id, tabTitle);
    }, [tab.id, tabTitle, updateGitWorktreeDiffTabTitle]);

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
                            {tabTitle}
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

                    <div className="flex flex-wrap items-center justify-end gap-1">
                        <GitDiffStyleControl
                            onChange={setDiffStyle}
                            value={diffStyle}
                        />
                        <IdeIconButton
                            aria-label={isLoading ? "Refreshing diff" : "Refresh diff"}
                            onClick={handleRefresh}
                            title={isLoading ? "Refreshing…" : "Refresh"}
                        >
                            <RefreshDiffIcon />
                        </IdeIconButton>
                        {!isBranchMode ? (
                            <IdeIconButton
                                aria-label="Discard all changes"
                                disabled={changedFileCount === 0}
                                onClick={handleDiscardAll}
                                title="Discard all changes (cannot be undone)"
                            >
                                <DiscardAllIcon />
                            </IdeIconButton>
                        ) : null}
                        {allFileIds.length > 0 ? (
                            <IdeIconButton
                                aria-label={
                                    allCollapsed
                                        ? "Expand all files"
                                        : "Collapse all files"
                                }
                                onClick={handleToggleAll}
                                title={
                                    allCollapsed
                                        ? "Expand all files"
                                        : "Collapse all files"
                                }
                            >
                                {allCollapsed ? (
                                    <ExpandAllIcon />
                                ) : (
                                    <CollapseAllIcon />
                                )}
                            </IdeIconButton>
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
                            diffStyle={diffStyle}
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
