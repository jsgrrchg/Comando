import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";
import type { editor as MonacoEditor } from "monaco-editor";
import {
    useCallback,
    createContext,
    useEffect,
    useEffectEvent,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useContext,
    type DragEvent as ReactDragEvent,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    type PointerEvent as ReactPointerEvent,
    type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import type {
    AiFileContextAttachment,
    AiImageAttachment,
    AiRuntimeId,
    AiTrackedFile,
    GitChangeEntry,
    GitFileDiff,
    GitOriginalFile,
    ProjectFileDocument,
} from "@shared/ipc";
import {
    ACTIVE_AI_RUNTIME_IDS,
    getAiRuntimeDisplayName,
    isActiveAiRuntimeId,
    type ActiveAiRuntimeId,
} from "@shared/ai-runtimes";
import {
    resolveEditorLanguage,
    shouldWrapEditorLanguage,
} from "@shared/editor-language";
import {
    buildGitHubRepositoryUrl,
    createGitHubIssueComposerDragItem,
    createGitHubPullRequestComposerDragItem,
    emitWorkspaceTabComposerDrag,
    isPointOverComposerDropZone,
    type ComposerProjectEntryDragData,
    type WorkspaceTabComposerDragItem,
} from "@renderer/app/drag-and-drop";
import {
    clampRoundedInt,
    DEFAULT_EDITOR_FONT_SIZE,
    EDITOR_FONT_SIZE_MAX,
    EDITOR_FONT_SIZE_MIN,
} from "@shared/typography";
import {
    CHAT_TITLE_TAB_MAX_CHARS,
    truncateChatTitle,
} from "@shared/chatTitle";
import {
    createReviewFileMutationInput,
    createReviewHunkMutationInput,
} from "@renderer/app/ai/reviewMutationTarget";
import {
    hasPrimaryPointerButton,
    isPrimaryPointerButton,
} from "@renderer/app/pointerGuards";

import {
    computeMinimalTextEdit,
    continueMarkdownList,
    indentMarkdownListItems,
    outdentMarkdownListItems,
} from "@renderer/app/editor/markdownLists";
import { getGitContextKey } from "@renderer/app/git/context-key";
import { createComandoEditorFeatureOptions } from "@renderer/app/editor/monacoEditorFeatures";
import { resolveMonacoLanguageId } from "@renderer/app/editor/monacoLanguage";
import {
    MONACO_MAX_TOKENIZATION_LINE_LENGTH,
    resolveLargeFileMonacoLanguageId,
    shouldDisableTextMateForDocumentSize,
} from "@renderer/app/editor/monacoPerformance";
import { enableMonacoVimMode } from "@renderer/app/editor/monacoVimMode";
import { useResolvedEditorSettings } from "@renderer/app/hooks/use-resolved-editor-settings";
import {
    loadAppEditorSettings,
    saveAppEditorSettings,
} from "@renderer/app/settings/client";
import { buildEditorFontFamily } from "@renderer/app/settings/theme";
import {
    recordProbeLifecycleEvent,
    useLifecycleProbe,
    useRenderProbe,
} from "@renderer/app/debug/renderProbe";
import { useAiStore } from "@renderer/app/store/ai-store";
import { useGitStore } from "@renderer/app/store/git-store";
import {
    getGitHubRepoKey,
    useGitHubStore,
} from "@renderer/app/store/github-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import {
    getBestMatchingChatTabId,
    useWorkspaceStore,
} from "@renderer/app/store/workspace-store";
import {
    collectPaneNodes,
    findWorkspaceNodeById,
    type RuntimeWorkspaceChatTab,
    type RuntimeWorkspaceFileOpenLocation,
    type RuntimeWorkspaceFileReviewContext,
    type RuntimeWorkspaceFileTab,
    type MarkdownFileViewMode,
    type RuntimeWorkspaceReviewTab,
    type RuntimeWorkspaceTab,
} from "@renderer/app/workspace/tree";
import {
    collectPendingTrackedFilesFromSessions,
    findBestPendingTrackedFile,
    hasUnresolvedReviewFilesForSession,
    isInlineReviewSupported,
} from "@renderer/app/workspace/pending-review";
import { ChatHistoryTabView } from "@renderer/components/workspace/ChatHistoryTabView";
import { ChatTabView } from "@renderer/components/workspace/ChatTabView";
import { GitHubIssuesTabView } from "@renderer/components/workspace/GitHubIssuesTabView";
import { GitHubIssueTabView } from "@renderer/components/workspace/GitHubIssueTabView";
import { GitHubPullRequestsTabView } from "@renderer/components/workspace/GitHubPullRequestsTabView";
import { GitHubPullRequestTabView } from "@renderer/components/workspace/GitHubPullRequestTabView";
import { GitCommitTabView } from "@renderer/components/workspace/GitCommitTabView";
import { GitWorktreeDiffTabView } from "@renderer/components/workspace/GitWorktreeDiffTabView";
import { GitTabView } from "@renderer/components/workspace/GitTabView";
import { ProviderIcon } from "@renderer/components/workspace/ProviderIcon";
import { ReviewTabView } from "@renderer/components/workspace/ReviewTabView";
import {
    getIndexedWorkspaceHasChat,
    getIndexedWorkspaceNode,
    getIndexedWorkspacePaneCount,
} from "@renderer/components/workspace/workspaceViewIndex";
import {
    WorkspacePaneEmptyState,
    type WorkspacePaneRecentProject,
} from "@renderer/components/workspace/WorkspacePaneEmptyState";
import { MarkdownFilePreview } from "@renderer/components/workspace/MarkdownFilePreview";
import { persistChatDraftForTab } from "@renderer/components/workspace/chatDraftPersistence";
import { resolveHotChatTabIds } from "@renderer/components/workspace/chatViewResourceBudget";
import {
    GIT_GUTTER_LINE_DECORATIONS_WIDTH,
    GitGutterDecorator,
    getEditorLineNumbersMinChars,
    hasRenderableGitGutterChange,
} from "@renderer/components/workspace/gitGutter";
import { buildLiveGitGutterDiff } from "@renderer/components/workspace/gitGutterLiveDiff";
import { buildInlineReviewDecorations } from "@renderer/components/workspace/inlineReviewDecorations";
import { buildInlineReviewDiffEditorOptions } from "@renderer/components/workspace/inlineReviewDiffEditorOptions";
import {
    resolveInlineReviewRestoreCandidate,
    resolvePendingEditorInlineReviewRestoreState,
} from "@renderer/components/workspace/inlineReviewRestorePriority";
import {
    acquireWorkspaceFileModel,
    buildWorkspaceEditorModelPath,
    buildWorkspaceFileEditorModelPath,
    getOrCreateWorkspaceFileModel,
    type WorkspaceFileModelLease,
} from "@renderer/components/workspace/editorModelPath";
import { appendSelectionMentionToRegisteredComposer } from "@renderer/components/workspace/chat/composerSelectionBridge";
import { requestStopAgentSession } from "@renderer/components/workspace/chat/aiSessionLifecycle";
import { isActiveChatTurnStatus } from "@renderer/components/workspace/chat/chatTurnStatus";
import { canResolveFileHunks } from "@renderer/components/workspace/review/editedFilesPresentationModel";
import { createDiffFromTrackedFile } from "@renderer/components/workspace/review/reviewDiff";
import { closeWorkspaceTabsWithConfirmation } from "@renderer/components/workspace/workspaceCloseGuard";
import { resolveWorkspaceChatTabActivityIndicator } from "@renderer/components/workspace/workspaceTabActivity";
import { useActiveWorkspaceTabStripReveal } from "@renderer/components/workspace/workspaceTabStrip";
import { WorkspaceTerminalView } from "@renderer/features/terminal/WorkspaceTerminalView";
import {
    getReviewHunkVisualEndLine,
    getSelectedReviewLine,
} from "@renderer/components/workspace/review/fileReviewBarPresentation";
import {
    useWorkspaceTabDrag,
    type WorkspaceTabDropTarget,
} from "@renderer/components/workspace/useWorkspaceTabDrag";
import {
    isWorkspacePaneDropTarget,
    type WorkspacePaneDropTarget,
} from "@renderer/components/workspace/workspaceDropTargets";
import {
    createWorkspaceDropTargetPreviewScheduler,
    getNextProjectFileOpenTarget,
    getWorkspacePaneFileDropEntries,
    resolveWorkspacePaneFileDragOverIntent,
    workspacePaneDropTargetToOpenTarget,
} from "@renderer/components/workspace/workspaceExternalDrop";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "@renderer/components/context-menu/ContextMenu";
import {
    getViewportSafeMenuPosition,
    getViewportSafeSubmenuPosition,
    type MenuAnchorRect,
} from "@renderer/app/utils/menu-position";
import type { WorkspaceQuickCreateAction } from "@renderer/app/store/workspace-store";
import {
    SIDEBAR_AGENT_DRAG_EVENT,
    type SidebarAgentDragDetail,
} from "@renderer/components/sidebar/sidebarAgentDragEvents";
import {
    SIDEBAR_GITHUB_DRAG_EVENT,
    type SidebarGitHubDragDetail,
} from "@renderer/components/sidebar/sidebarGitHubDragEvents";
import {
    checkClaudeCodeInstalled,
    launchClaudeCodeTerminal,
} from "@renderer/features/terminal/claudeCodeTerminal";

interface WorkspaceViewProps {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly recentProjects: readonly WorkspacePaneRecentProject[];
    readonly onOpenProject: (projectId: string) => void;
    readonly onOpenProjects: () => void;
    readonly onRequestCreateFile: () => void;
}

type SplitDragState = {
    readonly handleIndex: number;
    readonly startCoordinate: number;
    readonly startSizes: readonly number[];
} | null;

type TabContextMenuPayload = {
    readonly tabId: string;
};

type QuickCreateMenuState = {
    readonly x: number;
    readonly y: number;
} | null;

type QuickCreateMenuItem = {
    readonly action?: () => void;
    readonly children?: readonly QuickCreateMenuEntry[];
    readonly disabled?: boolean;
    readonly label: string;
    readonly title?: string;
    readonly type?: "item";
};

type QuickCreateMenuSeparator = {
    readonly type: "separator";
};

type QuickCreateMenuEntry = QuickCreateMenuItem | QuickCreateMenuSeparator;
const CLAUDE_CODE_TERMINAL_DESCRIPTION =
    "Open the claude CLI in a workspace terminal.";
const CLAUDE_CODE_NOT_FOUND_MESSAGE =
    "The claude command was not found in Comando's PATH. Your shell may still resolve it.";
const GIT_GUTTER_LIVE_DIFF_DEBOUNCE_MS = 200;
const MAX_RETAINED_CHAT_TAB_VIEWS = 4;
const EMPTY_HOT_CHAT_TAB_IDS: ReadonlySet<string> = new Set();
const ChatViewResourceBudgetContext = createContext<ReadonlySet<string>>(
    EMPTY_HOT_CHAT_TAB_IDS,
);

type GitGutterLiveDiffState =
    | {
          readonly diff: GitFileDiff;
          readonly key: string;
          readonly status: "ready";
      }
    | {
          readonly key: string;
          readonly status: "unavailable";
      };

type QuickCreateSubmenuState = {
    readonly anchorRect: MenuAnchorRect;
    readonly entries: readonly QuickCreateMenuEntry[];
} | null;

type WorkspaceReviewTabHandle = {
    readonly id: string;
    readonly sessionId: string;
};

type ReviewTabAutoCloseCandidate = {
    readonly hasError: boolean;
    readonly hasIncomingSnapshot: boolean;
    readonly hasUnresolvedReviewFiles: boolean;
    readonly reviewTabId: string;
    readonly sessionId: string;
};

type MonacoSurfaceRuntime = {
    readonly DiffEditor: typeof import("@monaco-editor/react").DiffEditor;
    readonly Editor: typeof import("@monaco-editor/react").default;
    readonly applyMonacoThemeFromDom: typeof import("@renderer/app/editor/monaco").applyMonacoThemeFromDom;
    readonly applyProjectTypeScriptConfigForPath: typeof import("@renderer/app/editor/monaco").applyProjectTypeScriptConfigForPath;
    readonly ensureMonacoTextMateForLanguage: typeof import("@renderer/app/editor/monaco").ensureMonacoTextMateForLanguage;
    readonly installMonacoTokenDebugAction: typeof import("@renderer/app/editor/monaco").installMonacoTokenDebugAction;
};

type ComandoMonacoTheme = "comando-dark" | "comando-light";
type SemanticHighlightingEditorOptions = {
    readonly "semanticHighlighting.enabled": true | false | "configuredByTheme";
};
type MonacoNamespace = typeof import("monaco-editor");

const EMPTY_TAB_IDS: readonly string[] = [];
const semanticHighlightingEditorOptions: SemanticHighlightingEditorOptions = {
    "semanticHighlighting.enabled": true,
};

function scheduleEffectStateUpdate(update: () => void): () => void {
    let cancelled = false;
    queueMicrotask(() => {
        if (!cancelled) {
            update();
        }
    });

    return () => {
        cancelled = true;
    };
}

function createReviewTabHandleKey(reviewTab: WorkspaceReviewTabHandle): string {
    return JSON.stringify([reviewTab.id, reviewTab.sessionId]);
}

function parseReviewTabHandleKey(
    key: string,
): WorkspaceReviewTabHandle | null {
    try {
        const parsed: unknown = JSON.parse(key);
        if (
            Array.isArray(parsed) &&
            typeof parsed[0] === "string" &&
            typeof parsed[1] === "string"
        ) {
            return { id: parsed[0], sessionId: parsed[1] };
        }
    } catch {
        // Corrupted persisted key; drop the review tab silently rather than
        // crashing the workspace render.
    }
    return null;
}

function selectWorkspaceReviewTabHandleKeys(
    state: ReturnType<typeof useWorkspaceStore.getState>,
): readonly string[] {
    return Object.values(state.tabsById)
        .filter(
            (tab): tab is RuntimeWorkspaceReviewTab => tab.kind === "review",
        )
        .map((tab) =>
            createReviewTabHandleKey({
                id: tab.id,
                sessionId: tab.sessionId,
            }),
        );
}

function createReviewTabAutoCloseCandidateKey(
    candidate: ReviewTabAutoCloseCandidate,
): string {
    return JSON.stringify([
        candidate.reviewTabId,
        candidate.sessionId,
        candidate.hasIncomingSnapshot,
        candidate.hasError,
        candidate.hasUnresolvedReviewFiles,
    ]);
}

function parseReviewTabAutoCloseCandidateKey(
    key: string,
): ReviewTabAutoCloseCandidate {
    const [
        reviewTabId,
        sessionId,
        hasIncomingSnapshot,
        hasError,
        hasUnresolvedReviewFiles,
    ] = JSON.parse(key) as [string, string, boolean, boolean, boolean];
    return {
        hasError,
        hasIncomingSnapshot,
        hasUnresolvedReviewFiles,
        reviewTabId,
        sessionId,
    };
}

function buildReviewTabAutoCloseCandidateKeys(
    reviewTabs: readonly WorkspaceReviewTabHandle[],
    sessions: ReturnType<typeof useAiStore.getState>["sessions"],
): readonly string[] {
    return reviewTabs.map((reviewTab) => {
        const sessionState = sessions[reviewTab.sessionId];
        return createReviewTabAutoCloseCandidateKey({
            hasError: Boolean(
                sessionState?.localError || sessionState?.snapshot?.lastError,
            ),
            hasIncomingSnapshot: Boolean(
                sessionState?.lastIncomingSnapshotUpdatedAt,
            ),
            // Review action log is canonical when present; the trackedFiles
            // mirror can be stale after resolved work is intentionally hidden.
            hasUnresolvedReviewFiles:
                hasUnresolvedReviewFilesForSession(sessionState),
            reviewTabId: reviewTab.id,
            sessionId: reviewTab.sessionId,
        });
    });
}

function getTrackedFileSignature(file: AiTrackedFile | null): string | null {
    if (!file) {
        return null;
    }

    return JSON.stringify([
        file.identityKey,
        file.kind,
        file.path,
        file.previousPath,
        file.reviewState,
        file.sessionId,
        file.updatedAt,
        file.version,
    ]);
}

function getInlineReviewSignature(file: AiTrackedFile | null): string | null {
    if (!file) {
        return null;
    }

    return JSON.stringify([
        getTrackedFileSignature(file),
        file.oldText?.length ?? null,
        file.newText?.length ?? null,
        file.hunks.map((hunk) => [
            hunk.id,
            hunk.oldStart,
            hunk.oldCount,
            hunk.newStart,
            hunk.newCount,
            hunk.visualStartLine ?? null,
            hunk.visualEndLine ?? null,
            hunk.lines.length,
        ]),
    ]);
}

function getInlineReviewModelRevision(file: AiTrackedFile | null): string | null {
    if (!file) {
        return null;
    }

    return JSON.stringify([
        file.identityKey,
        file.version ?? 1,
        file.updatedAt,
    ]);
}

function captureDiffEditorScrollState(
    editor: MonacoEditor.IStandaloneDiffEditor | null,
): {
    readonly modifiedScrollLeft: number;
    readonly modifiedScrollTop: number;
    readonly originalScrollLeft: number;
    readonly originalScrollTop: number;
} {
    const originalEditor = editor?.getOriginalEditor() ?? null;
    const modifiedEditor = editor?.getModifiedEditor() ?? null;

    return {
        modifiedScrollLeft: modifiedEditor?.getScrollLeft() ?? 0,
        modifiedScrollTop: modifiedEditor?.getScrollTop() ?? 0,
        originalScrollLeft: originalEditor?.getScrollLeft() ?? 0,
        originalScrollTop: originalEditor?.getScrollTop() ?? 0,
    };
}

type PortableEditorRestoreState = {
    readonly column: number;
    readonly lineNumber: number;
    readonly scrollLeft: number;
    readonly scrollTop: number;
};

function capturePortableEditorRestoreState(
    editor: MonacoEditor.ICodeEditor | null,
): PortableEditorRestoreState | null {
    if (!editor) {
        return null;
    }

    const position = editor.getPosition();
    if (!position) {
        return null;
    }

    return {
        column: position.column,
        lineNumber: position.lineNumber,
        scrollLeft: editor.getScrollLeft(),
        scrollTop: editor.getScrollTop(),
    };
}

function applyEditorOpenLocation(
    editor: MonacoEditor.IStandaloneCodeEditor,
    location: RuntimeWorkspaceFileOpenLocation,
): boolean {
    const model = editor.getModel();
    if (!model) {
        return false;
    }

    const startLine = Math.min(
        Math.max(location.startLine, 1),
        model.getLineCount(),
    );
    const endLine =
        location.endLine === null || location.endLine === undefined
            ? startLine
            : Math.min(
                  Math.max(location.endLine, startLine),
                  model.getLineCount(),
              );

    editor.layout();

    if (endLine > startLine) {
        const selection = {
            endColumn: model.getLineMaxColumn(endLine),
            endLineNumber: endLine,
            selectionStartColumn: 1,
            selectionStartLineNumber: startLine,
            startColumn: 1,
            startLineNumber: startLine,
        };
        editor.setSelection(selection);
        editor.revealRangeInCenter(selection);
        return true;
    }

    editor.setPosition({ column: 1, lineNumber: startLine });
    editor.revealLineInCenter(startLine);
    return true;
}

function applyInlineReviewOpenLocation(
    diffEditor: MonacoEditor.IStandaloneDiffEditor,
    location: RuntimeWorkspaceFileOpenLocation,
): boolean {
    const modifiedEditor = diffEditor.getModifiedEditor();
    if (!applyEditorOpenLocation(modifiedEditor, location)) {
        return false;
    }

    const originalEditor = diffEditor.getOriginalEditor();
    originalEditor.setScrollLeft(modifiedEditor.getScrollLeft());
    originalEditor.setScrollTop(modifiedEditor.getScrollTop());
    return true;
}

function isMonacoCancellationError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("Canceled");
}

function isMonacoDisposedError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    return (
        error.message.includes("has been disposed") ||
        error.message.includes("got disposed before DiffEditorWidget model got reset")
    );
}

type InlineReviewModelState = {
    readonly modified: MonacoEditor.ITextModel | null;
    readonly original: MonacoEditor.ITextModel | null;
    readonly revision: string | null;
};

function disposeInlineReviewModels(models: {
    readonly modified: MonacoEditor.ITextModel | null;
    readonly original: MonacoEditor.ITextModel | null;
}): void {
    const disposedModels = new Set<MonacoEditor.ITextModel>();

    for (const model of [models.original, models.modified]) {
        if (!model || disposedModels.has(model) || model.isDisposed()) {
            continue;
        }

        disposedModels.add(model);
        model.dispose();
    }
}

function getOrCreateMonacoTextModel(input: {
    readonly language: string;
    readonly modelPath: string;
    readonly monaco: MonacoNamespace;
    readonly value: string;
}): MonacoEditor.ITextModel {
    const uri = input.monaco.Uri.parse(input.modelPath);
    const existingModel = input.monaco.editor.getModel(uri);

    if (existingModel) {
        if (existingModel.getValue() !== input.value) {
            existingModel.setValue(input.value);
        }
        input.monaco.editor.setModelLanguage(existingModel, input.language);
        return existingModel;
    }

    return input.monaco.editor.createModel(
        input.value,
        input.language,
        uri,
    );
}

function isQuickCreateMenuSeparator(
    entry: QuickCreateMenuEntry,
): entry is QuickCreateMenuSeparator {
    return entry.type === "separator";
}

export function buildWorkspaceAgentsQuickCreateEntries({
    claudeCodeAvailable,
    defaultProjectId,
    defaultWorktreeId,
    onCreateChatTab,
    onOpenClaudeCodeTerminal,
}: {
    readonly claudeCodeAvailable: boolean | null;
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly onCreateChatTab: (
        projectId: string | null,
        worktreeId: string | null,
        runtimeId: ActiveAiRuntimeId,
    ) => void;
    readonly onOpenClaudeCodeTerminal: () => void;
}): readonly QuickCreateMenuEntry[] {
    const createRuntimeEntry = (
        runtimeId: ActiveAiRuntimeId,
    ): QuickCreateMenuEntry => ({
        action: () =>
            onCreateChatTab(defaultProjectId, defaultWorktreeId, runtimeId),
        label: getAiRuntimeDisplayName(runtimeId),
    });

    return [
        ...ACTIVE_AI_RUNTIME_IDS.slice(0, 2).map(createRuntimeEntry),
        {
            action: onOpenClaudeCodeTerminal,
            label: "Claude Code",
            title:
                claudeCodeAvailable === false
                    ? CLAUDE_CODE_NOT_FOUND_MESSAGE
                    : CLAUDE_CODE_TERMINAL_DESCRIPTION,
        },
        ...ACTIVE_AI_RUNTIME_IDS.slice(2).map(createRuntimeEntry),
    ];
}

function resolveActiveRuntimeId(runtimeId: AiRuntimeId): ActiveAiRuntimeId {
    return isActiveAiRuntimeId(runtimeId) ? runtimeId : "codex";
}

export function WorkspaceView({
    defaultProjectId,
    defaultWorktreeId,
    recentProjects,
    onOpenProject,
    onOpenProjects,
    onRequestCreateFile,
}: WorkspaceViewProps) {
    const closeTab = useWorkspaceStore((state) => state.closeTab);
    const chatViewBudgetWorkspaceState = useWorkspaceStore(
        useShallow((state) => ({
            activePaneId: state.activePaneId,
            deferredPaneIds: state.deferredPaneIds,
            recentActiveTabIds: state.recentActiveTabIds,
            rootNode: state.rootNode,
        })),
    );
    const dropTabToSplit = useWorkspaceStore((state) => state.dropTabToSplit);
    const moveTabToPane = useWorkspaceStore((state) => state.moveTabToPane);
    const openChatSessionTabAtTarget = useWorkspaceStore(
        (state) => state.openChatSessionTabAtTarget,
    );
    const openFileTabAtTarget = useWorkspaceStore(
        (state) => state.openFileTabAtTarget,
    );
    const openGitHubIssueTabAtTarget = useWorkspaceStore(
        (state) => state.openGitHubIssueTabAtTarget,
    );
    const openGitHubPullRequestTabAtTarget = useWorkspaceStore(
        (state) => state.openGitHubPullRequestTabAtTarget,
    );
    const defaultDropRootPath = useWorkspaceProjectRootPath(
        defaultProjectId,
        defaultWorktreeId,
    );
    const reorderTab = useWorkspaceStore((state) => state.reorderTab);
    const rootNodeId = useWorkspaceStore((state) => state.rootNode.id);
    const hotChatTabIds = useMemo(() => {
        const tabsById = useWorkspaceStore.getState().tabsById;
        const workspacePanes = collectPaneNodes(
            chatViewBudgetWorkspaceState.rootNode,
        );
        const panes = workspacePanes.map((pane) => ({
            activeTabId: pane.activeTabId,
            id: pane.id,
            visible: !chatViewBudgetWorkspaceState.deferredPaneIds.has(
                pane.id,
            ),
        }));
        const chatTabIds = new Set<string>();

        for (const pane of workspacePanes) {
            for (const tabId of pane.tabIds) {
                if (tabsById[tabId]?.kind === "chat") {
                    chatTabIds.add(tabId);
                }
            }
        }

        return resolveHotChatTabIds({
            chatTabIds,
            focusedPaneId: chatViewBudgetWorkspaceState.activePaneId,
            panes,
            recentActiveTabIds:
                chatViewBudgetWorkspaceState.recentActiveTabIds,
        });
    }, [chatViewBudgetWorkspaceState]);
    const [externalDropTarget, setExternalDropTarget] =
        useState<WorkspacePaneDropTarget | null>(null);
    const workspaceRootRef = useRef<HTMLDivElement | null>(null);
    const reviewTabKeys = useWorkspaceStore(
        useShallow(selectWorkspaceReviewTabHandleKeys),
    );
    const autoClosingReviewTabIdsRef = useRef<Set<string>>(new Set());
    const reviewTabs = useMemo(
        () =>
            reviewTabKeys
                .map((key) => parseReviewTabHandleKey(key))
                .filter(
                    (handle): handle is WorkspaceReviewTabHandle =>
                        handle !== null,
                ),
        [reviewTabKeys],
    );
    const reviewTabAutoCloseCandidateKeys = useAiStore(
        useShallow(
            useCallback(
                (state: ReturnType<typeof useAiStore.getState>) =>
                    buildReviewTabAutoCloseCandidateKeys(
                        reviewTabs,
                        state.sessions,
                    ),
                [reviewTabs],
            ),
        ),
    );
    const reviewTabAutoCloseCandidates = useMemo(
        () =>
            reviewTabAutoCloseCandidateKeys.map((key) =>
                parseReviewTabAutoCloseCandidateKey(key),
            ),
        [reviewTabAutoCloseCandidateKeys],
    );
    const tabDrag = useWorkspaceTabDrag({
        onDropToSplit: dropTabToSplit,
        onMoveToPane: moveTabToPane,
        onReorder: reorderTab,
        resolveExternalDropTarget: (_draggedTab, pointer) =>
            isPointOverComposerDropZone(pointer.x, pointer.y)
                ? { type: "composer" }
                : null,
    });

    const resolveExternalPaneDropTarget = useCallback(
        (x: number, y: number): WorkspacePaneDropTarget | null => {
            if (isPointOverComposerDropZone(x, y)) {
                return null;
            }

            const target = tabDrag.resolveDropTarget(
                { x, y },
                { skipExternal: true },
            );
            return isWorkspacePaneDropTarget(target) ? target : null;
        },
        [tabDrag],
    );

    const isPointInsideWorkspaceRoot = useCallback((x: number, y: number) => {
        const root = workspaceRootRef.current;
        if (!root) {
            return false;
        }

        const rect = root.getBoundingClientRect();
        return (
            x >= rect.left &&
            x <= rect.right &&
            y >= rect.top &&
            y <= rect.bottom
        );
    }, []);

    const applyExternalDropTarget = useCallback(
        (target: WorkspacePaneDropTarget | null) => {
            setExternalDropTarget((current) =>
                areWorkspacePaneDropTargetsEqual(current, target)
                    ? current
                    : target,
            );
        },
        [],
    );

    const externalDropTargetScheduler = useMemo(
        () =>
            createWorkspaceDropTargetPreviewScheduler<WorkspacePaneDropTarget>({
                applyTarget: applyExternalDropTarget,
                cancelFrame: (frameId) => {
                    window.cancelAnimationFrame(frameId);
                },
                requestFrame: (callback) =>
                    window.requestAnimationFrame(callback),
            }),
        [applyExternalDropTarget],
    );

    const scheduleExternalDropTarget = useCallback(
        (target: WorkspacePaneDropTarget | null) => {
            externalDropTargetScheduler.schedule(target);
        },
        [externalDropTargetScheduler],
    );

    const clearExternalDropTarget = useCallback(() => {
        externalDropTargetScheduler.clear();
    }, [externalDropTargetScheduler]);

    useEffect(() => {
        return () => {
            externalDropTargetScheduler.dispose();
        };
    }, [externalDropTargetScheduler]);

    const handleWorkspaceDragOver = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            if (!defaultProjectId) {
                scheduleExternalDropTarget(null);
                return;
            }

            if (isPointOverComposerDropZone(event.clientX, event.clientY)) {
                scheduleExternalDropTarget(null);
                return;
            }

            const target = resolveExternalPaneDropTarget(
                event.clientX,
                event.clientY,
            );
            if (!target) {
                scheduleExternalDropTarget(null);
                return;
            }

            const dragIntent = resolveWorkspacePaneFileDragOverIntent({
                dataTransfer: event.dataTransfer,
                projectRootPath: defaultDropRootPath,
                target,
            });
            scheduleExternalDropTarget(dragIntent.previewTarget);
            if (!dragIntent.acceptsDrop) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "copy";
        },
        [
            defaultDropRootPath,
            defaultProjectId,
            resolveExternalPaneDropTarget,
            scheduleExternalDropTarget,
        ],
    );

    const handleWorkspaceDragLeave = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            if (
                event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
                return;
            }

            clearExternalDropTarget();
        },
        [clearExternalDropTarget],
    );

    const handleWorkspaceDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            if (!defaultProjectId) {
                clearExternalDropTarget();
                return;
            }

            const target = resolveExternalPaneDropTarget(
                event.clientX,
                event.clientY,
            );
            const fileEntries = getWorkspacePaneFileDropEntries({
                dataTransfer: event.dataTransfer,
                projectRootPath: defaultDropRootPath,
            });
            clearExternalDropTarget();
            if (!target || fileEntries.length === 0) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            void openProjectFileEntriesAtTarget({
                entries: fileEntries,
                openFileTabAtTarget,
                projectId: defaultProjectId,
                target,
                worktreeId: defaultWorktreeId ?? null,
            });
        },
        [
            defaultDropRootPath,
            defaultProjectId,
            defaultWorktreeId,
            openFileTabAtTarget,
            clearExternalDropTarget,
            resolveExternalPaneDropTarget,
        ],
    );

    const handleSidebarAgentDrag = useEffectEvent((event: Event) => {
        const detail = (event as CustomEvent<SidebarAgentDragDetail>).detail;

        if (detail.phase === "cancel") {
            clearExternalDropTarget();
            return;
        }

        const target = resolveExternalPaneDropTarget(detail.x, detail.y);
        if (!target) {
            if (detail.phase === "end") {
                clearExternalDropTarget();
                return;
            }

            if (
                isPointOverComposerDropZone(detail.x, detail.y) ||
                !isPointInsideWorkspaceRoot(detail.x, detail.y)
            ) {
                scheduleExternalDropTarget(null);
            }
            return;
        }

        if (detail.phase === "end") {
            clearExternalDropTarget();
            void openChatSessionTabAtTarget({
                projectId: detail.projectId,
                runtimeId: detail.runtimeId,
                sessionId: detail.sessionId,
                target: workspacePaneDropTargetToOpenTarget(target),
                title: detail.title,
                worktreeId: detail.worktreeId,
            });
            return;
        }

        scheduleExternalDropTarget(target);
    });

    const handleSidebarGitHubDrag = useEffectEvent((event: Event) => {
        const detail = (event as CustomEvent<SidebarGitHubDragDetail>).detail;
        const dragItems = getSidebarGitHubComposerDragItems(detail);
        emitWorkspaceTabComposerDrag({
            item: dragItems[0] ?? null,
            items: dragItems,
            phase: detail.phase,
            x: detail.x,
            y: detail.y,
        });

        if (detail.phase === "cancel") {
            clearExternalDropTarget();
            return;
        }

        const target = resolveExternalPaneDropTarget(detail.x, detail.y);
        if (!target) {
            if (detail.phase === "end") {
                clearExternalDropTarget();
                return;
            }

            if (
                isPointOverComposerDropZone(detail.x, detail.y) ||
                !isPointInsideWorkspaceRoot(detail.x, detail.y)
            ) {
                scheduleExternalDropTarget(null);
            }
            return;
        }

        if (detail.phase === "end") {
            clearExternalDropTarget();
            void openSidebarGitHubDragItemsAtTarget({
                detail,
                openGitHubIssueTabAtTarget,
                openGitHubPullRequestTabAtTarget,
                target,
            });
            return;
        }

        scheduleExternalDropTarget(target);
    });

    useEffect(() => {
        window.addEventListener(SIDEBAR_AGENT_DRAG_EVENT, handleSidebarAgentDrag);
        window.addEventListener(
            SIDEBAR_GITHUB_DRAG_EVENT,
            handleSidebarGitHubDrag,
        );
        return () => {
            externalDropTargetScheduler.dispose();
            window.removeEventListener(
                SIDEBAR_AGENT_DRAG_EVENT,
                handleSidebarAgentDrag,
            );
            window.removeEventListener(
                SIDEBAR_GITHUB_DRAG_EVENT,
                handleSidebarGitHubDrag,
            );
        };
    }, [externalDropTargetScheduler]);

    useEffect(() => {
        const knownReviewTabIds = new Set(reviewTabs.map((tab) => tab.id));

        for (const tabId of autoClosingReviewTabIdsRef.current) {
            if (!knownReviewTabIds.has(tabId)) {
                autoClosingReviewTabIdsRef.current.delete(tabId);
            }
        }

        for (const candidate of reviewTabAutoCloseCandidates) {
            if (
                !candidate.hasIncomingSnapshot ||
                candidate.hasError ||
                candidate.hasUnresolvedReviewFiles ||
                autoClosingReviewTabIdsRef.current.has(candidate.reviewTabId)
            ) {
                continue;
            }

            autoClosingReviewTabIdsRef.current.add(candidate.reviewTabId);
            void closeTab(candidate.reviewTabId).finally(() => {
                autoClosingReviewTabIdsRef.current.delete(
                    candidate.reviewTabId,
                );
            });
        }
    }, [closeTab, reviewTabAutoCloseCandidates, reviewTabs]);

    useRenderProbe("WorkspaceView", {});

    return (
        <div
            className="h-full min-h-0 bg-bg-primary"
            onDragEndCapture={clearExternalDropTarget}
            onDragLeaveCapture={handleWorkspaceDragLeave}
            onDragOverCapture={handleWorkspaceDragOver}
            onDropCapture={handleWorkspaceDrop}
            ref={workspaceRootRef}
        >
            <ChatViewResourceBudgetContext.Provider value={hotChatTabIds}>
                <WorkspaceNodeView
                    defaultProjectId={defaultProjectId}
                    defaultWorktreeId={defaultWorktreeId}
                    recentProjects={recentProjects}
                    nodeId={rootNodeId}
                    onOpenProject={onOpenProject}
                    onOpenProjects={onOpenProjects}
                    onRequestCreateFile={onRequestCreateFile}
                    tabDrag={tabDrag}
                />
            </ChatViewResourceBudgetContext.Provider>
            {!tabDrag.isDragging ? (
                <WorkspaceDropTargetOverlay
                    target={externalDropTarget}
                    visible={externalDropTarget !== null}
                />
            ) : null}
            <WorkspaceTabDragOverlay
                draggedTab={tabDrag.draggedTab}
                pointerCurrent={tabDrag.pointerCurrent}
                pointerOffset={tabDrag.pointerOffset}
                target={tabDrag.activeDropTarget}
                visible={tabDrag.isDragging}
            />
        </div>
    );
}

function WorkspaceNodeView({
    defaultProjectId,
    defaultWorktreeId,
    recentProjects,
    nodeId,
    onOpenProject,
    onOpenProjects,
    onRequestCreateFile,
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly recentProjects: readonly WorkspacePaneRecentProject[];
    readonly nodeId: string;
    readonly onOpenProject: (projectId: string) => void;
    readonly onOpenProjects: () => void;
    readonly onRequestCreateFile: () => void;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    const node = useWorkspaceStore(
        useCallback(
            (state: ReturnType<typeof useWorkspaceStore.getState>) =>
                getIndexedWorkspaceNode(state.rootNode, nodeId),
            [nodeId],
        ),
    );
    if (!node) {
        return null;
    }

    if (node.type === "pane") {
        return (
            <WorkspacePaneView
                defaultProjectId={defaultProjectId}
                defaultWorktreeId={defaultWorktreeId}
                recentProjects={recentProjects}
                paneId={node.id}
                onOpenProject={onOpenProject}
                onOpenProjects={onOpenProjects}
                onRequestCreateFile={onRequestCreateFile}
                tabDrag={tabDrag}
            />
        );
    }

    return (
        <WorkspaceSplitView
            defaultProjectId={defaultProjectId}
            defaultWorktreeId={defaultWorktreeId}
            recentProjects={recentProjects}
            splitId={node.id}
            onOpenProject={onOpenProject}
            onOpenProjects={onOpenProjects}
            onRequestCreateFile={onRequestCreateFile}
            tabDrag={tabDrag}
        />
    );
}

function useWorkspaceProjectRootPath(
    projectId: string | null,
    worktreeId: string | null,
): string | null {
    const projectRootPath = useProjectsStore(
        useCallback(
            (state) =>
                projectId
                    ? (state.projects.find((project) => project.id === projectId)
                          ?.rootPath ?? null)
                    : null,
            [projectId],
        ),
    );
    const worktreeRootPath = useGitStore(
        useCallback(
            (state) => {
                if (!projectId || !worktreeId) {
                    return null;
                }

                const snapshot =
                    state.snapshots[
                        getWorkspaceGitContextKey(projectId, worktreeId)
                    ] ??
                    state.snapshots[getWorkspaceGitContextKey(projectId, null)] ??
                    null;
                return (
                    snapshot?.worktrees.find(
                        (worktree) => worktree.id === worktreeId,
                    )?.rootPath ?? null
                );
            },
            [projectId, worktreeId],
        ),
    );

    return worktreeRootPath ?? projectRootPath;
}

function areWorkspacePaneDropTargetsEqual(
    left: WorkspacePaneDropTarget | null,
    right: WorkspacePaneDropTarget | null,
): boolean {
    return (
        getWorkspacePaneDropTargetKey(left) ===
        getWorkspacePaneDropTargetKey(right)
    );
}

function getWorkspacePaneDropTargetKey(
    target: WorkspacePaneDropTarget | null,
): string {
    if (!target) {
        return "none";
    }

    if (target.type === "strip") {
        return `${target.type}:${target.paneId}:${target.index}`;
    }

    if (target.type === "split") {
        return `${target.type}:${target.paneId}:${target.direction}`;
    }

    return `${target.type}:${target.paneId}`;
}

function getWorkspaceGitContextKey(
    projectId: string,
    worktreeId: string | null,
): string {
    return getGitContextKey(projectId, worktreeId);
}

function getGitGutterDiffRequestKey(options: {
    readonly projectId: string;
    readonly relativePath: string;
    readonly worktreeId: string | null;
}): string {
    return [
        options.projectId,
        options.worktreeId ?? "primary",
        options.relativePath,
    ].join("\u0000");
}

function getGitGutterChangeSignature(
    change: GitChangeEntry | null,
): string | null {
    if (!change) {
        return null;
    }

    return JSON.stringify([
        change.path,
        change.previousPath,
        change.kind,
        change.scope,
        change.isBinary,
        change.isConflicted,
        change.isRenamed,
        change.additions,
        change.deletions,
    ]);
}

function mapGitOriginalFileKindToDiffKind(
    kind: GitOriginalFile["kind"],
): GitFileDiff["kind"] {
    switch (kind) {
        case "added":
        case "untracked":
            return "create";
        case "deleted":
            return "delete";
        case "renamed":
            return "move";
        default:
            return "update";
    }
}

async function openProjectFileEntriesAtTarget(input: {
    readonly entries: readonly ComposerProjectEntryDragData[];
    readonly openFileTabAtTarget: ReturnType<
        typeof useWorkspaceStore.getState
    >["openFileTabAtTarget"];
    readonly projectId: string;
    readonly target: WorkspacePaneDropTarget;
    readonly worktreeId: string | null;
}): Promise<void> {
    let openTarget = workspacePaneDropTargetToOpenTarget(input.target);

    for (const entry of input.entries) {
        const paneId = await input.openFileTabAtTarget({
            projectId: input.projectId,
            relativePath: entry.relativePath,
            target: openTarget,
            worktreeId: input.worktreeId,
        });
        if (!paneId) {
            continue;
        }

        openTarget = getNextProjectFileOpenTarget(openTarget, paneId);
    }
}

async function openSidebarGitHubDragItemsAtTarget(input: {
    readonly detail: SidebarGitHubDragDetail;
    readonly openGitHubIssueTabAtTarget: ReturnType<
        typeof useWorkspaceStore.getState
    >["openGitHubIssueTabAtTarget"];
    readonly openGitHubPullRequestTabAtTarget: ReturnType<
        typeof useWorkspaceStore.getState
    >["openGitHubPullRequestTabAtTarget"];
    readonly target: WorkspacePaneDropTarget;
}): Promise<void> {
    let openTarget = workspacePaneDropTargetToOpenTarget(input.target);
    const dragItems =
        input.detail.items.length > 0
            ? input.detail.items
            : [{ number: input.detail.number, title: input.detail.title }];

    for (const item of dragItems) {
        const tabId =
            input.detail.itemKind === "issue"
                ? await input.openGitHubIssueTabAtTarget({
                      issueNumber: item.number,
                      projectId: input.detail.projectId,
                      ref: input.detail.ref,
                      target: openTarget,
                      worktreeId: input.detail.worktreeId,
                  })
                : await input.openGitHubPullRequestTabAtTarget({
                      projectId: input.detail.projectId,
                      pullRequestNumber: item.number,
                      ref: input.detail.ref,
                      target: openTarget,
                      worktreeId: input.detail.worktreeId,
                  });
        const paneId = tabId
            ? findPaneIdForWorkspaceTab(useWorkspaceStore.getState(), tabId)
            : null;
        if (!paneId) {
            continue;
        }

        openTarget = getNextProjectFileOpenTarget(openTarget, paneId);
    }
}

function findPaneIdForWorkspaceTab(
    state: ReturnType<typeof useWorkspaceStore.getState>,
    tabId: string,
): string | null {
    return (
        collectPaneNodes(state.rootNode).find((pane) =>
            pane.tabIds.includes(tabId),
        )?.id ?? null
    );
}

function WorkspaceSplitView({
    defaultProjectId,
    defaultWorktreeId,
    recentProjects,
    splitId,
    onOpenProject,
    onOpenProjects,
    onRequestCreateFile,
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly recentProjects: readonly WorkspacePaneRecentProject[];
    readonly splitId: string;
    readonly onOpenProject: (projectId: string) => void;
    readonly onOpenProjects: () => void;
    readonly onRequestCreateFile: () => void;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    const node = useWorkspaceStore(
        useCallback(
            (state: ReturnType<typeof useWorkspaceStore.getState>) => {
                const match = getIndexedWorkspaceNode(
                    state.rootNode,
                    splitId,
                );
                return match?.type === "split" ? match : null;
            },
            [splitId],
        ),
    );
    const resizeSplit = useWorkspaceStore((state) => state.resizeSplit);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [dragState, setDragState] = useState<SplitDragState>(null);
    const [previewSizes, setPreviewSizes] = useState<readonly number[] | null>(
        null,
    );

    const stopDragging = useEffectEvent(() => {
        if (
            node &&
            dragState &&
            previewSizes &&
            previewSizes.length > 0 &&
            !areSplitSizesEqual(previewSizes, dragState.startSizes)
        ) {
            void resizeSplit(node.id, previewSizes);
        }

        setPreviewSizes(null);
        setDragState(null);
    });

    const handlePointerMove = useEffectEvent((event: PointerEvent) => {
        if (!node || !dragState || !containerRef.current) {
            return;
        }
        if (!hasPrimaryPointerButton(event.buttons)) {
            stopDragging();
            return;
        }

        const rect = containerRef.current.getBoundingClientRect();
        const totalSize = node.axis === "horizontal" ? rect.width : rect.height;

        if (totalSize <= 0) {
            return;
        }

        const currentCoordinate =
            node.axis === "horizontal" ? event.clientX : event.clientY;
        const deltaRatio =
            (currentCoordinate - dragState.startCoordinate) / totalSize;
        const nextSizes = [...dragState.startSizes];
        nextSizes[dragState.handleIndex] += deltaRatio;
        nextSizes[dragState.handleIndex + 1] -= deltaRatio;

        if (
            nextSizes[dragState.handleIndex] < 0.12 ||
            nextSizes[dragState.handleIndex + 1] < 0.12
        ) {
            return;
        }

        setPreviewSizes(nextSizes);
    });

    useEffect(() => {
        if (!node || !dragState) {
            return;
        }

        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;
        const nextCursor =
            node.axis === "horizontal" ? "col-resize" : "row-resize";
        document.body.style.cursor = nextCursor;
        document.body.style.userSelect = "none";
        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                stopDragging();
            }
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointercancel", stopDragging);
        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("blur", stopDragging);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointercancel", stopDragging);
            window.removeEventListener("pointerup", stopDragging);
            window.removeEventListener("blur", stopDragging);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
        };
    }, [dragState, node]);

    if (!node) {
        return null;
    }

    const sizes = previewSizes ?? node.sizes;

    return (
        <div
            className={[
                "flex h-full min-h-0 w-full",
                node.axis === "horizontal" ? "flex-row" : "flex-col",
            ].join(" ")}
            ref={containerRef}
        >
            {node.children.map((child, index) => (
                <FragmentPane
                    axis={node.axis}
                    defaultProjectId={defaultProjectId}
                    defaultWorktreeId={defaultWorktreeId}
                    recentProjects={recentProjects}
                    handleIndex={index}
                    isLast={index === node.children.length - 1}
                    key={child.id}
                    nodeId={child.id}
                    onOpenProject={onOpenProject}
                    onOpenProjects={onOpenProjects}
                    onRequestCreateFile={onRequestCreateFile}
                    onPointerDown={(event) => {
                        if (!isPrimaryPointerButton(event.button)) {
                            return;
                        }

                        event.preventDefault();
                        event.stopPropagation();
                        setDragState({
                            handleIndex: index,
                            startCoordinate:
                                node.axis === "horizontal"
                                    ? event.clientX
                                    : event.clientY,
                            startSizes: node.sizes,
                        });
                    }}
                    size={sizes[index] ?? 1 / node.children.length}
                    tabDrag={tabDrag}
                />
            ))}
        </div>
    );
}

function areSplitSizesEqual(
    left: readonly number[],
    right: readonly number[],
): boolean {
    return (
        left.length === right.length &&
        left.every((size, index) => size === right[index])
    );
}

function FragmentPane({
    axis,
    defaultProjectId,
    defaultWorktreeId,
    recentProjects,
    handleIndex,
    isLast,
    nodeId,
    onOpenProject,
    onOpenProjects,
    onRequestCreateFile,
    onPointerDown,
    size,
    tabDrag,
}: {
    readonly axis: "horizontal" | "vertical";
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly recentProjects: readonly WorkspacePaneRecentProject[];
    readonly handleIndex: number;
    readonly isLast: boolean;
    readonly nodeId: string;
    readonly onOpenProject: (projectId: string) => void;
    readonly onOpenProjects: () => void;
    readonly onRequestCreateFile: () => void;
    readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    readonly size: number;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    return (
        <>
            <div
                className="min-h-0 min-w-0"
                style={{
                    flexBasis: `${size * 100}%`,
                    flexGrow: size,
                    flexShrink: 1,
                }}
            >
                <WorkspaceNodeView
                    defaultProjectId={defaultProjectId}
                    defaultWorktreeId={defaultWorktreeId}
                    recentProjects={recentProjects}
                    nodeId={nodeId}
                    onOpenProject={onOpenProject}
                    onOpenProjects={onOpenProjects}
                    onRequestCreateFile={onRequestCreateFile}
                    tabDrag={tabDrag}
                />
            </div>

            {!isLast ? (
                <div
                    aria-label={`Resize split handle ${handleIndex + 1}`}
                    aria-orientation={
                        axis === "horizontal" ? "vertical" : "horizontal"
                    }
                    className={[
                        "group relative z-2 flex items-center justify-center bg-transparent",
                        axis === "horizontal"
                            ? "cursor-col-resize"
                            : "cursor-row-resize",
                    ].join(" ")}
                    onPointerDown={onPointerDown}
                    role="separator"
                    style={
                        axis === "horizontal"
                            ? { marginLeft: -3, marginRight: -3, width: 7 }
                            : { height: 7, marginBottom: -3, marginTop: -3 }
                    }
                >
                    <div
                        className={[
                            "workspace-divider bg-border transition-colors duration-100 group-hover:bg-accent",
                            axis === "horizontal"
                                ? "h-full w-px"
                                : "h-px w-full",
                        ].join(" ")}
                    />
                </div>
            ) : null}
        </>
    );
}

function WorkspacePaneView({
    defaultProjectId,
    defaultWorktreeId,
    recentProjects,
    paneId,
    onOpenProject,
    onOpenProjects,
    onRequestCreateFile,
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly recentProjects: readonly WorkspacePaneRecentProject[];
    readonly paneId: string;
    readonly onOpenProject: (projectId: string) => void;
    readonly onOpenProjects: () => void;
    readonly onRequestCreateFile: () => void;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    const hotChatTabIds = useContext(ChatViewResourceBudgetContext);
    const addDraftFileContext = useAiStore((s) => s.addDraftFileContext);
    const attachSelectionMention = useAiStore((s) => s.attachSelectionMention);
    const {
        activePaneId,
        closeOtherTabs,
        closePane,
        closeTab,
        closeTabsToRight,
        createChatTab,
        createTerminalTab,
        hasAnyChatTab,
        lastFocusedRuntimeId,
        lastQuickCreateAction,
        moveTab,
        node,
        openChatHistoryTab,
        openChatImageTab,
        openFileTab,
        openGitTab,
        openGitWorktreeDiffTab,
        openReviewTab,
        paneCount,
        recentActiveTabIds,
        reloadFileTab,
        saveFileTab,
        selectAdjacentTab,
        selectTab,
        setActivePane,
        shouldRenderPaneContent,
        togglePaneTabPinned,
        updateChatDraft,
        updateFileDraft,
    } = useWorkspaceStore(
        useShallow(
            useCallback(
                (state: ReturnType<typeof useWorkspaceStore.getState>) => {
                    const candidate = getIndexedWorkspaceNode(
                        state.rootNode,
                        paneId,
                    );
                    return {
                        activePaneId: state.activePaneId,
                        closeOtherTabs: state.closeOtherTabs,
                        closePane: state.closePane,
                        closeTab: state.closeTab,
                        closeTabsToRight: state.closeTabsToRight,
                        createChatTab: state.createChatTab,
                        createTerminalTab: state.createTerminalTab,
                        hasAnyChatTab: getIndexedWorkspaceHasChat(
                            state.tabsById,
                        ),
                        lastFocusedRuntimeId: state.lastFocusedRuntimeId,
                        lastQuickCreateAction: state.lastQuickCreateAction,
                        moveTab: state.moveTab,
                        node: candidate?.type === "pane" ? candidate : null,
                        openChatHistoryTab: state.openChatHistoryTab,
                        openChatImageTab: state.openChatImageTab,
                        openFileTab: state.openFileTab,
                        openGitTab: state.openGitTab,
                        openGitWorktreeDiffTab: state.openGitWorktreeDiffTab,
                        openReviewTab: state.openReviewTab,
                        paneCount: getIndexedWorkspacePaneCount(state.rootNode),
                        recentActiveTabIds: state.recentActiveTabIds,
                        reloadFileTab: state.reloadFileTab,
                        saveFileTab: state.saveFileTab,
                        selectAdjacentTab: state.selectAdjacentTab,
                        selectTab: state.selectTab,
                        setActivePane: state.setActivePane,
                        shouldRenderPaneContent:
                            state.activePaneId === paneId ||
                            !state.deferredPaneIds.has(paneId),
                        togglePaneTabPinned: state.togglePaneTabPinned,
                        updateChatDraft: state.updateChatDraft,
                        updateFileDraft: state.updateFileDraft,
                    };
                },
                [paneId],
            ),
        ),
    );
    const confirmBeforeClose = useCallback(
        async (
            tabIdsToClose: readonly string[],
            closeAction: () => Promise<void>,
        ) => closeWorkspaceTabsWithConfirmation(tabIdsToClose, closeAction),
        [],
    );
    const collectPaneTabIds = useCallback(
        (tabId: string): readonly string[] => {
            const { rootNode } = useWorkspaceStore.getState();
            const pane = collectPaneNodes(rootNode).find((candidate) =>
                candidate.tabIds.includes(tabId),
            );
            return pane?.tabIds ?? [];
        },
        [],
    );
    const requestCloseTab = useCallback(
        (tabId: string) =>
            confirmBeforeClose([tabId], () => closeTab(tabId)),
        [closeTab, confirmBeforeClose],
    );
    const requestCloseOtherTabs = useCallback(
        (tabId: string) => {
            const siblingIds = collectPaneTabIds(tabId).filter(
                (candidate) => candidate !== tabId,
            );
            return confirmBeforeClose(siblingIds, () => closeOtherTabs(tabId));
        },
        [closeOtherTabs, collectPaneTabIds, confirmBeforeClose],
    );
    const requestCloseTabsToRight = useCallback(
        (tabId: string) => {
            const paneTabIdsForClose = collectPaneTabIds(tabId);
            const tabIndexInPane = paneTabIdsForClose.indexOf(tabId);
            const rightIds =
                tabIndexInPane >= 0
                    ? paneTabIdsForClose.slice(tabIndexInPane + 1)
                    : [];
            return confirmBeforeClose(rightIds, () =>
                closeTabsToRight(tabId),
            );
        },
        [closeTabsToRight, collectPaneTabIds, confirmBeforeClose],
    );
    const paneNodeId = node?.id ?? paneId;
    const paneTabIds = node?.tabIds ?? EMPTY_TAB_IDS;
    const panePinnedTabIds = node?.pinnedTabIds ?? EMPTY_TAB_IDS;
    const panePinnedTabIdSet = useMemo(
        () => new Set(panePinnedTabIds),
        [panePinnedTabIds],
    );
    const paneActiveTabId = node?.activeTabId ?? null;
    const paneTabs = useWorkspaceStore(
        useShallow(
            useCallback(
                (state: ReturnType<typeof useWorkspaceStore.getState>) =>
                    paneTabIds
                        .map((tabId) => state.tabsById[tabId] ?? null)
                        .filter(
                            (tab): tab is RuntimeWorkspaceTab => tab !== null,
                        ),
                [paneTabIds],
            ),
        ),
    );
    const tabStripRef = useRef<HTMLDivElement | null>(null);
    const [tabContextMenu, setTabContextMenu] =
        useState<ContextMenuState<TabContextMenuPayload> | null>(null);
    const [quickCreateMenu, setQuickCreateMenu] =
        useState<QuickCreateMenuState>(null);
    const [claudeCodeAvailable, setClaudeCodeAvailable] = useState<
        boolean | null
    >(null);
    const contextTabId = tabContextMenu?.payload.tabId ?? null;
    const contextTab = useWorkspaceStore(
        useCallback(
            (state) =>
                contextTabId ? (state.tabsById[contextTabId] ?? null) : null,
            [contextTabId],
        ),
    );
    const activeTab = paneActiveTabId
        ? (paneTabs.find((tab) => tab.id === paneActiveTabId) ?? null)
        : null;
    const activeChatTab = activeTab?.kind === "chat" ? activeTab : null;
    const [retainedChatTabIds, setRetainedChatTabIds] = useState<
        readonly string[]
    >(() => (activeChatTab ? [activeChatTab.id] : []));
    const retainChatTab = useCallback((tabId: string) => {
        const tab = useWorkspaceStore.getState().tabsById[tabId];
        if (tab?.kind !== "chat") {
            return;
        }

        setRetainedChatTabIds((currentIds) => {
            if (currentIds.at(-1) === tabId) {
                return currentIds;
            }

            // Keep recently visited chats warm without retaining an unbounded
            // number of full transcript trees in a pane.
            return [
                ...currentIds.filter((currentTabId) => currentTabId !== tabId),
                tabId,
            ].slice(-MAX_RETAINED_CHAT_TAB_VIEWS);
        });
    }, []);
    const activeFileTab = activeTab?.kind === "file" ? activeTab : null;
    const paneFileTabs = useMemo(
        () =>
            paneTabs.filter(
                (tab): tab is RuntimeWorkspaceFileTab => tab.kind === "file",
            ),
        [paneTabs],
    );
    const isActivePane = activePaneId === paneNodeId;

    useEffect(() => {
        const activeChatTabId = activeChatTab?.id;
        if (!activeChatTabId) {
            return;
        }

        let cancelled = false;
        queueMicrotask(() => {
            if (!cancelled) {
                retainChatTab(activeChatTabId);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [activeChatTab?.id, retainChatTab]);

    const retainedChatTabs = useMemo(
        () =>
            paneTabs.filter(
                (tab): tab is RuntimeWorkspaceChatTab =>
                    tab.kind === "chat" &&
                    (retainedChatTabIds.includes(tab.id) ||
                        tab.id === activeChatTab?.id) &&
                    hotChatTabIds.has(tab.id),
            ),
        [activeChatTab?.id, hotChatTabIds, paneTabs, retainedChatTabIds],
    );
    const handleSelectTab = useCallback(
        (tabId: string) => {
            retainChatTab(tabId);
            void selectTab(paneNodeId, tabId);
        },
        [paneNodeId, retainChatTab, selectTab],
    );
    const handleSelectAdjacentTab = useCallback(
        async (direction: "next" | "previous") => {
            await selectAdjacentTab(paneNodeId, direction);
            const nextPane = findWorkspaceNodeById(
                useWorkspaceStore.getState().rootNode,
                paneNodeId,
            );
            if (nextPane?.type === "pane" && nextPane.activeTabId) {
                retainChatTab(nextPane.activeTabId);
            }
        },
        [paneNodeId, retainChatTab, selectAdjacentTab],
    );
    const activeTabWorktreeId = activeTab?.worktreeId ?? null;
    const activeChatSessionId = activeChatTab?.sessionId ?? null;
    const activeChatFallbackTitle = activeChatTab?.title ?? "Chat";
    const activeChatSessionLifecycle = useAiStore(
        useShallow(
            useCallback(
                (state) => {
                    if (!activeChatSessionId) {
                        return {
                            status: null,
                            title: activeChatFallbackTitle,
                        };
                    }

                    const snapshot =
                        state.sessions[activeChatSessionId]?.snapshot ?? null;

                    return {
                        status: snapshot?.status ?? null,
                        title:
                            snapshot?.title ||
                            activeChatFallbackTitle ||
                            "Chat",
                    };
                },
                [activeChatFallbackTitle, activeChatSessionId],
            ),
        ),
    );

    useRenderProbe("WorkspacePaneView", {
        activeTabId: activeTab?.id ?? null,
        contentReady: shouldRenderPaneContent,
        paneId: node?.id ?? paneId,
        tabCount: node?.tabIds.length ?? 0,
    });

    const handleTabStripWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
        const container = tabStripRef.current;
        if (!container) {
            return;
        }

        const hasHorizontalOverflow =
            container.scrollWidth > container.clientWidth;
        const shouldTranslateVerticalScroll =
            Math.abs(event.deltaY) > Math.abs(event.deltaX);

        if (!hasHorizontalOverflow || !shouldTranslateVerticalScroll) {
            return;
        }

        event.preventDefault();
        container.scrollLeft += event.deltaY;
    };
    const paneTabOrderKey = paneTabIds.join("|");
    useActiveWorkspaceTabStripReveal({
        activeTabId: paneActiveTabId,
        draggingTabId: tabDrag.draggedTab?.tabId ?? null,
        stripRef: tabStripRef,
        tabIdAttribute: "data-workspace-tab-id",
        tabOrderKey: paneTabOrderKey,
    });

    const tabContextMenuEntries: ContextMenuEntry[] = (() => {
        if (!tabContextMenu) {
            return [];
        }

        const tabIndex = paneTabIds.indexOf(tabContextMenu.payload.tabId);
        if (tabIndex === -1) {
            return [];
        }
        const isPinned = panePinnedTabIdSet.has(tabContextMenu.payload.tabId);

        const entries: ContextMenuEntry[] = [
            {
                label: isPinned ? "Unpin Tab" : "Pin Tab",
                action: () =>
                    void togglePaneTabPinned(
                        paneNodeId,
                        tabContextMenu.payload.tabId,
                    ),
            },
            {
                label: "Close",
                action: () =>
                    void requestCloseTab(tabContextMenu.payload.tabId),
            },
            {
                label: "Close Others",
                action: () =>
                    void requestCloseOtherTabs(
                        tabContextMenu.payload.tabId,
                    ),
                disabled: paneTabIds.length <= 1,
            },
            {
                label: "Close Tabs to the Right",
                action: () =>
                    void requestCloseTabsToRight(
                        tabContextMenu.payload.tabId,
                    ),
                disabled: tabIndex === paneTabIds.length - 1,
            },
            { type: "separator" },
            {
                label: "Move to Previous Pane",
                action: () =>
                    void moveTab(tabContextMenu.payload.tabId, "previous"),
                disabled: paneCount < 2,
            },
            {
                label: "Move to Next Pane",
                action: () =>
                    void moveTab(tabContextMenu.payload.tabId, "next"),
                disabled: paneCount < 2,
            },
        ];

        if (contextTab?.kind === "file") {
            const ext = contextTab.relativePath.split(".").pop() ?? null;
            entries.push(
                { type: "separator" },
                {
                    label: "Add to Chat",
                    action: () => {
                        const workspaceState = useWorkspaceStore.getState();
                        const targetChatTabId = getBestMatchingChatTabId(
                            workspaceState,
                            {
                                currentPaneId: paneNodeId,
                                lastFocusedChatTabId:
                                    workspaceState.lastFocusedChatTabId,
                                projectId: contextTab.projectId,
                                recentFocusedChatTabIds:
                                    workspaceState.recentFocusedChatTabIds,
                                worktreeId: contextTab.worktreeId ?? null,
                            },
                        );
                        const targetChatTab = targetChatTabId
                            ? workspaceState.tabsById[targetChatTabId]
                            : null;
                        if (targetChatTab?.kind !== "chat") {
                            return;
                        }

                        addDraftFileContext(targetChatTab.sessionId, {
                            id: `file-ctx:${crypto.randomUUID()}`,
                            projectId: contextTab.projectId,
                            relativePath: contextTab.relativePath,
                            name: contextTab.title,
                            extension: ext,
                            languageId: resolveEditorLanguage({
                                filePath: contextTab.relativePath,
                            }).id,
                        });
                    },
                    disabled: !hasAnyChatTab,
                },
            );
        }

        return entries;
    })();

    function handleTabContextMenu(
        event: ReactMouseEvent<HTMLButtonElement>,
        tabId: string,
    ) {
        event.preventDefault();
        event.stopPropagation();
        void setActivePane(paneNodeId);
        handleSelectTab(tabId);
        setTabContextMenu({
            x: event.clientX,
            y: event.clientY,
            payload: { tabId },
        });
    }

    const handleCreateFile = useCallback(() => {
        if (!defaultProjectId) {
            return;
        }

        onRequestCreateFile();
    }, [defaultProjectId, onRequestCreateFile]);
    const handleOpenClaudeCodeTerminal = useCallback(() => {
        void launchClaudeCodeTerminal({
            paneId: paneNodeId,
            projectId: defaultProjectId,
            worktreeId: defaultWorktreeId ?? null,
        });
    }, [defaultProjectId, defaultWorktreeId, paneNodeId]);

    useEffect(() => {
        let cancelled = false;
        void checkClaudeCodeInstalled().then((available) => {
            if (!cancelled) {
                setClaudeCodeAvailable(available);
            }
        });

        return () => {
            cancelled = true;
        };
    }, []);

    const handleOpenWorkspaceFile = useCallback(
        async (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
            openLocation?: RuntimeWorkspaceFileOpenLocation | null,
        ) => {
            await openFileTab(
                projectId,
                relativePath,
                worktreeId ?? activeTabWorktreeId,
                reviewContext,
                paneNodeId,
                undefined,
                openLocation,
            );
        },
        [activeTabWorktreeId, openFileTab, paneNodeId],
    );

    const handleChatDraftChange = useCallback(
        (tabId: string, draft: string) => {
            persistChatDraftForTab(updateChatDraft, tabId, draft);
        },
        [updateChatDraft],
    );

    const handleOpenChatReview = useCallback((tab: RuntimeWorkspaceChatTab) => {
        return openReviewTab({
            projectId: tab.projectId,
            runtimeId: tab.runtimeId,
            sessionId: tab.sessionId,
            title: tab.title,
            worktreeId: tab.worktreeId ?? null,
        });
    }, [openReviewTab]);

    const handleOpenChatImage = useCallback(
        async (attachment: AiImageAttachment) => {
            await openChatImageTab({
                attachment,
                targetPaneId: paneNodeId,
            });
        },
        [openChatImageTab, paneNodeId],
    );

    const handleCreateAgentFromFocusedProvider = useCallback(() => {
        void createChatTab(
            defaultProjectId,
            defaultWorktreeId ?? null,
            resolveActiveRuntimeId(lastFocusedRuntimeId),
        );
    }, [
        createChatTab,
        defaultProjectId,
        defaultWorktreeId,
        lastFocusedRuntimeId,
    ]);

    const handleAttachLineFragment = useCallback(
        async ({
            context,
            worktreeId,
        }: {
            readonly context: AiFileContextAttachment;
            readonly worktreeId: string | null;
        }) => {
            // Read fresh state to avoid stale closure from Monaco onMount
            const currentState = useWorkspaceStore.getState();

            const findPaneIdByTabId = (tabId: string) =>
                collectPaneNodes(currentState.rootNode).find((pane) =>
                    pane.tabIds.includes(tabId),
                )?.id ?? null;
            const candidateTabId = getBestMatchingChatTabId(
                {
                    rootNode: currentState.rootNode,
                    tabsById: currentState.tabsById,
                },
                {
                    currentPaneId: paneNodeId,
                    lastFocusedChatTabId: currentState.lastFocusedChatTabId,
                    projectId: context.projectId,
                    recentFocusedChatTabIds:
                        currentState.recentFocusedChatTabIds,
                    worktreeId,
                },
            );

            if (candidateTabId) {
                const paneId = findPaneIdByTabId(candidateTabId) ?? paneNodeId;

                await setActivePane(paneId);
                if (paneId === paneNodeId) {
                    retainChatTab(candidateTabId);
                }
                await selectTab(paneId, candidateTabId);

                const targetTab =
                    useWorkspaceStore.getState().tabsById[candidateTabId];
                if (targetTab?.kind === "chat") {
                    const selection = {
                        endLine: context.endLine ?? context.startLine ?? 1,
                        path: context.relativePath,
                        selectedText: context.selectedText ?? "",
                        startLine: context.startLine ?? 1,
                    };
                    const appendedLocally =
                        await appendSelectionMentionToComposer({
                            ...selection,
                            sessionId: targetTab.sessionId,
                        });

                    if (!appendedLocally) {
                        attachSelectionMention(targetTab.sessionId, selection);
                    }
                }
                return;
            }

            const existingTabIds = new Set(Object.keys(currentState.tabsById));
            await createChatTab(
                context.projectId,
                worktreeId,
                resolveActiveRuntimeId(currentState.lastFocusedRuntimeId),
            );

            const createdChatTab = Object.values(
                useWorkspaceStore.getState().tabsById,
            ).find(
                (tab) =>
                    tab.kind === "chat" &&
                    !existingTabIds.has(tab.id) &&
                    tab.projectId === context.projectId &&
                    (tab.worktreeId ?? null) === worktreeId,
            );

            if (createdChatTab?.kind === "chat") {
                const selection = {
                    endLine: context.endLine ?? context.startLine ?? 1,
                    path: context.relativePath,
                    selectedText: context.selectedText ?? "",
                    startLine: context.startLine ?? 1,
                };
                const appendedLocally = await appendSelectionMentionToComposer({
                    ...selection,
                    sessionId: createdChatTab.sessionId,
                });

                if (!appendedLocally) {
                    attachSelectionMention(createdChatTab.sessionId, selection);
                }
            }
        },
        [
            attachSelectionMention,
            createChatTab,
            paneNodeId,
            retainChatTab,
            selectTab,
            setActivePane,
        ],
    );

    function handleOpenLastQuickCreateAction() {
        switch (lastQuickCreateAction) {
            case "claude":
                void createChatTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                    "claude",
                );
                return;
            case "grok":
                void createChatTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                    "grok",
                );
                return;
            case "kilo":
                void createChatTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                    "kilo",
                );
                return;
            case "opencode":
                void createChatTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                    "opencode",
                );
                return;
            case "terminal":
                void createTerminalTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                );
                return;
            case "git":
                if (defaultProjectId) {
                    void openGitTab(
                        defaultProjectId,
                        defaultWorktreeId ?? null,
                    );
                    return;
                }
                void createChatTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                    "codex",
                );
                return;
            case "history":
                if (defaultProjectId) {
                    void openChatHistoryTab(
                        defaultProjectId,
                        defaultWorktreeId ?? null,
                    );
                    return;
                }
                void createChatTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                    "codex",
                );
                return;
            case "file":
                if (defaultProjectId) {
                    void handleCreateFile();
                    return;
                }
                void createChatTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                    "codex",
                );
                return;
            case "codex":
            default:
                void createChatTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                    "codex",
                );
        }
    }

    const quickCreateMenuEntries = useMemo<readonly QuickCreateMenuEntry[]>(
        () => [
            {
                label: "Agents",
                children: buildWorkspaceAgentsQuickCreateEntries({
                    claudeCodeAvailable,
                    defaultProjectId,
                    defaultWorktreeId,
                    onCreateChatTab: (projectId, worktreeId, runtimeId) => {
                        void createChatTab(projectId, worktreeId, runtimeId);
                    },
                    onOpenClaudeCodeTerminal: handleOpenClaudeCodeTerminal,
                }),
            },
            { type: "separator" },
            {
                action: () =>
                    defaultProjectId
                        ? void openChatHistoryTab(
                              defaultProjectId,
                              defaultWorktreeId ?? null,
                          )
                        : undefined,
                disabled: !defaultProjectId,
                label: "History",
            },
            {
                action: () =>
                    defaultProjectId
                        ? void openGitTab(
                              defaultProjectId,
                              defaultWorktreeId ?? null,
                          )
                        : undefined,
                disabled: !defaultProjectId,
                label: "Git",
            },
            {
                action: () =>
                    void createTerminalTab(
                        defaultProjectId,
                        defaultWorktreeId ?? null,
                    ),
                label: "New Terminal",
            },
            {
                action: () => void handleCreateFile(),
                disabled: !defaultProjectId,
                label: "New File",
            },
        ],
        [
            createChatTab,
            createTerminalTab,
            claudeCodeAvailable,
            defaultProjectId,
            defaultWorktreeId,
            handleCreateFile,
            handleOpenClaudeCodeTerminal,
            openChatHistoryTab,
            openGitTab,
        ],
    );

    const lastQuickCreateTitle = getQuickCreateButtonTitle(
        lastQuickCreateAction,
        Boolean(defaultProjectId),
    );

    // Keep the latest handler references in a ref so the keydown listener can
    // be registered a single time per active pane, instead of being torn down
    // and re-attached on every render where any of these callbacks change.
    const paneActiveAgentStopRef = useRef({
        sessionId: activeChatSessionId,
        status: activeChatSessionLifecycle.status,
        title: activeChatSessionLifecycle.title,
    });
    useEffect(() => {
        paneActiveAgentStopRef.current = {
            sessionId: activeChatSessionId,
            status: activeChatSessionLifecycle.status,
            title: activeChatSessionLifecycle.title,
        };
    }, [
        activeChatSessionId,
        activeChatSessionLifecycle.status,
        activeChatSessionLifecycle.title,
    ]);

    const paneShortcutHandlersRef = useRef({
        createTerminalTab,
        defaultProjectId,
        defaultWorktreeId,
        handleCreateAgentFromFocusedProvider,
        handleCreateFile,
        openChatHistoryTab,
        openGitTab,
        openGitWorktreeDiffTab,
        paneNodeId,
        selectAdjacentTab: handleSelectAdjacentTab,
    });
    useEffect(() => {
        paneShortcutHandlersRef.current = {
            createTerminalTab,
            defaultProjectId,
            defaultWorktreeId,
            handleCreateAgentFromFocusedProvider,
            handleCreateFile,
            openChatHistoryTab,
            openGitTab,
            openGitWorktreeDiffTab,
            paneNodeId,
            selectAdjacentTab: handleSelectAdjacentTab,
        };
    }, [
        createTerminalTab,
        defaultProjectId,
        defaultWorktreeId,
        handleCreateAgentFromFocusedProvider,
        handleCreateFile,
        openChatHistoryTab,
        openGitTab,
        openGitWorktreeDiffTab,
        paneNodeId,
        handleSelectAdjacentTab,
    ]);

    useEffect(() => {
        if (!isActivePane) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.key !== "Escape") {
                return;
            }

            if (
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
            ) {
                return;
            }

            const { sessionId, status, title } =
                paneActiveAgentStopRef.current;
            if (!sessionId || !status || !isActiveChatTurnStatus(status)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            requestStopAgentSession({
                sessionId,
                title,
            });
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isActivePane]);

    useEffect(() => {
        if (!isActivePane) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            const handlers = paneShortcutHandlersRef.current;
            if (
                event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                event.key === "Tab"
            ) {
                event.preventDefault();
                event.stopPropagation();
                void handlers.selectAdjacentTab(
                    event.shiftKey ? "previous" : "next",
                );
                return;
            }

            if (!(event.metaKey || event.ctrlKey) || event.altKey) {
                return;
            }

            const key = event.key.toLowerCase();

            if (key === "n") {
                event.preventDefault();
                event.stopPropagation();

                if (event.shiftKey) {
                    handlers.handleCreateAgentFromFocusedProvider();
                    return;
                }

                void handlers.handleCreateFile();
                return;
            }

            if (event.shiftKey && key === "h") {
                if (!handlers.defaultProjectId) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                void handlers.openChatHistoryTab(
                    handlers.defaultProjectId,
                    handlers.defaultWorktreeId ?? null,
                );
                return;
            }

            if (event.shiftKey && key === "g") {
                if (!handlers.defaultProjectId) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                void handlers.openGitTab(
                    handlers.defaultProjectId,
                    handlers.defaultWorktreeId ?? null,
                );
                return;
            }

            if (event.shiftKey && key === "m") {
                if (!handlers.defaultProjectId) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                void handlers.openGitWorktreeDiffTab(
                    handlers.defaultProjectId,
                    handlers.defaultWorktreeId ?? null,
                );
                return;
            }

            if (key === "r" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                void handlers.createTerminalTab(
                    handlers.defaultProjectId,
                    handlers.defaultWorktreeId ?? null,
                );
            }
        };

        window.addEventListener("keydown", handleKeyDown, {
            capture: true,
        });
        return () => {
            window.removeEventListener("keydown", handleKeyDown, {
                capture: true,
            });
        };
    }, [isActivePane]);

    if (!node) {
        return null;
    }

    return (
        <>
            <section
                className={[
                    "relative flex h-full min-h-0 flex-col border bg-bg-primary",
                    isActivePane
                        ? "border-border-strong"
                        : "border-transparent",
                ].join(" ")}
                onMouseDown={() => void setActivePane(paneNodeId)}
                ref={(element) => {
                    tabDrag.setPaneElement(paneNodeId, element);
                }}
            >
                <div className="app-drag flex items-center justify-between border-b border-border bg-bg-chrome px-0">
                    <div
                        className="workspace-tab-strip flex min-w-0 items-end overflow-x-auto overflow-y-hidden"
                        data-workspace-pane-id={paneNodeId}
                        onWheel={handleTabStripWheel}
                        ref={(element) => {
                            tabStripRef.current = element;
                            tabDrag.setTabStripElement(paneNodeId, element);
                        }}
                    >
                        {paneTabIds.length === 0 ? (
                            // Match the tab button height so the strip keeps the
                            // same height whether or not the pane has tabs.
                            <span className="flex h-7.75 items-center px-2.5 text-[11px] text-text-secondary">
                                Empty pane
                            </span>
                        ) : (
                            paneTabs.map((tab, tabIndex) => {
                                const isActive = tab.id === paneActiveTabId;
                                const isPinned = panePinnedTabIdSet.has(tab.id);
                                const tabDisplayTitle =
                                    getWorkspaceTabDisplayTitle(tab);

                                return (
                                    <button
                                        className={[
                                            "group app-no-drag relative flex h-7.75 items-center gap-1.5 border-r border-border-subtle text-[12px] transition",
                                            isPinned
                                                ? "w-8 justify-center px-0"
                                                : "px-3",
                                            tabDrag.draggedTab?.tabId ===
                                                tab.id && tabDrag.isDragging
                                                ? "opacity-35"
                                                : "",
                                            isActive
                                                ? "z-10 bg-bg-primary font-medium text-text-primary shadow-[inset_0_-1px_0_0_var(--color-accent)] duration-0"
                                                : "z-0 bg-bg-chrome text-text-secondary hover:bg-bg-tertiary hover:text-text-primary",
                                        ].join(" ")}
                                        data-workspace-tab-id={tab.id}
                                        data-workspace-tab-pinned={
                                            isPinned ? "true" : undefined
                                        }
                                        key={tab.id}
                                        aria-label={tabDisplayTitle}
                                        onClick={(event) => {
                                            if (tabDrag.handleTabClick(event)) {
                                                return;
                                            }

                                            handleSelectTab(tab.id);
                                        }}
                                        onContextMenu={(event) =>
                                            handleTabContextMenu(event, tab.id)
                                        }
                                        onPointerDown={(event) =>
                                            tabDrag.beginTabPointerDown(
                                                {
                                                    isDirty:
                                                        "isDirty" in tab
                                                            ? tab.isDirty
                                                            : false,
                                                    kind: tab.kind,
                                                    paneId: paneNodeId,
                                                    composerDragItem:
                                                        getWorkspaceTabComposerDragItem(
                                                            tab,
                                                        ),
                                                    sourceIndex: tabIndex,
                                                    tabId: tab.id,
                                                    title: tabDisplayTitle,
                                                },
                                                event,
                                            )
                                        }
                                        title={
                                            isPinned
                                                ? tabDisplayTitle
                                                : undefined
                                        }
                                        type="button"
                                    >
                                        <TabIcon
                                            kind={tab.kind}
                                            runtimeId={
                                                tab.kind === "chat" ||
                                                tab.kind === "review"
                                                    ? tab.runtimeId
                                                    : undefined
                                            }
                                            title={tabDisplayTitle}
                                        />
                                        {isPinned ? null : (
                                            <span
                                                className="truncate"
                                                title={
                                                    "title" in tab
                                                        ? tab.title
                                                        : tabDisplayTitle
                                                }
                                            >
                                                {tabDisplayTitle}
                                            </span>
                                        )}
                                        <WorkspaceTabActivityIndicator
                                            tab={tab}
                                        />
                                        {"hasExternalChange" in tab &&
                                        tab.hasExternalChange ? (
                                            <span
                                                className="text-[10px] font-semibold text-rose-500"
                                                title="File changed on disk"
                                            >
                                                !
                                            </span>
                                        ) : null}
                                        {isPinned ? null : (
                                            <span
                                                className={[
                                                    "-mr-1.5 ml-3 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[14px] leading-none transition-all duration-75 hover:bg-text-secondary/15 hover:text-text-primary active:scale-90 active:bg-text-secondary/25",
                                                    isActive
                                                        ? "text-text-secondary opacity-70"
                                                        : "text-text-secondary opacity-0 group-hover:opacity-70",
                                                ].join(" ")}
                                                data-workspace-tab-close="true"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    void requestCloseTab(
                                                        tab.id,
                                                    );
                                                }}
                                                role="button"
                                                tabIndex={-1}
                                            >
                                                ×
                                            </span>
                                        )}
                                    </button>
                                );
                            })
                        )}
                    </div>

                    <div className="flex shrink-0 items-center">
                        <PaneActionButton
                            label="+"
                            onClick={handleOpenLastQuickCreateAction}
                            onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setQuickCreateMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                });
                            }}
                            title={lastQuickCreateTitle}
                        />
                        <span className="mx-1 h-3 w-px bg-border" />
                        <PaneActionButton
                            label="×"
                            onClick={() => void closePane(paneNodeId)}
                            title="Close pane"
                        />
                    </div>
                </div>

                <div
                    className="relative min-h-0 flex-1 overflow-hidden bg-editor"
                    data-workspace-pane-content-ready={shouldRenderPaneContent}
                >
                    {shouldRenderPaneContent ? (
                        <>
                            {activeTab?.kind === "terminal" ? (
                                <WorkspaceTerminalView
                                    active
                                    activePane={isActivePane}
                                    tab={activeTab}
                                />
                            ) : null}
                            <WorkspaceFileEditorHost
                                activeFileTab={activeFileTab}
                                fileTabs={paneFileTabs}
                                isActivePane={isActivePane}
                                onAttachLineFragment={handleAttachLineFragment}
                                onDraftChange={updateFileDraft}
                                onReload={reloadFileTab}
                                onSave={saveFileTab}
                                recentActiveTabIds={recentActiveTabIds}
                            />
                            {retainedChatTabs.map((tab) => {
                                const isActiveChat = tab.id === activeTab?.id;

                                return (
                                    <div
                                        aria-hidden={!isActiveChat}
                                        className={
                                            isActiveChat
                                                ? "relative z-1 h-full"
                                                : "pointer-events-none invisible absolute inset-0"
                                        }
                                        inert={!isActiveChat}
                                        key={tab.id}
                                    >
                                        <ChatTabView
                                            active={isActiveChat}
                                            onDraftChange={handleChatDraftChange}
                                            onOpenFile={handleOpenWorkspaceFile}
                                            onOpenImage={handleOpenChatImage}
                                            onOpenReview={() =>
                                                handleOpenChatReview(tab)
                                            }
                                            tab={tab}
                                        />
                                    </div>
                                );
                            })}
                            {activeTab ? (
                                activeTab.kind === "file" ? (
                                    null
                                ) : activeTab.kind === "git" ? (
                                    <GitTabView tab={activeTab} />
                                ) : activeTab.kind === "git_worktree_diff" ? (
                                    <GitWorktreeDiffTabView tab={activeTab} />
                                ) : activeTab.kind === "chat_history" ? (
                                    <ChatHistoryTabView tab={activeTab} />
                                ) : activeTab.kind === "git_commit" ? (
                                    <GitCommitTabView tab={activeTab} />
                                ) : activeTab.kind === "review" ? (
                                    <ReviewTabView
                                        onOpenFile={handleOpenWorkspaceFile}
                                        tab={activeTab}
                                    />
                                ) : activeTab.kind === "github_issues" ? (
                                    <GitHubIssuesTabView tab={activeTab} />
                                ) : activeTab.kind === "github_issue" ? (
                                    <GitHubIssueTabView tab={activeTab} />
                                ) : activeTab.kind ===
                                  "github_pull_requests" ? (
                                    <GitHubPullRequestsTabView tab={activeTab} />
                                ) : activeTab.kind === "github_pull_request" ? (
                                    <GitHubPullRequestTabView tab={activeTab} />
                                ) : null
                            ) : (
                                <WorkspacePaneEmptyState
                                    onOpenProject={onOpenProject}
                                    onOpenProjects={onOpenProjects}
                                    recentProjects={recentProjects}
                                />
                            )}
                        </>
                    ) : null}
                </div>
            </section>

            {tabContextMenu ? (
                <ContextMenu
                    entries={tabContextMenuEntries}
                    menu={tabContextMenu}
                    minWidth={190}
                    onClose={() => setTabContextMenu(null)}
                />
            ) : null}

            {quickCreateMenu ? (
                <QuickCreateMenu
                    entries={quickCreateMenuEntries}
                    menu={quickCreateMenu}
                    onClose={() => setQuickCreateMenu(null)}
                />
            ) : null}
        </>
    );
}

export function WorkspaceFileEditorHost({
    activeFileTab,
    fileTabs,
    isActivePane,
    onAttachLineFragment,
    onDraftChange,
    onReload,
    onSave,
    recentActiveTabIds,
}: {
    readonly activeFileTab: RuntimeWorkspaceFileTab | null;
    readonly fileTabs: readonly RuntimeWorkspaceFileTab[];
    readonly isActivePane: boolean;
    readonly onAttachLineFragment: (input: {
        readonly context: AiFileContextAttachment;
        readonly worktreeId: string | null;
    }) => Promise<void>;
    readonly onDraftChange: (tabId: string, draft: string) => void;
    readonly onReload: (tabId: string) => Promise<void>;
    readonly onSave: (
        tabId: string,
        options?: {
            readonly force?: boolean;
        },
    ) => Promise<void>;
    readonly recentActiveTabIds: readonly string[];
}) {
    const hostedTab = useMemo(() => {
        if (activeFileTab) {
            return activeFileTab;
        }

        for (const tabId of recentActiveTabIds) {
            const recentFileTab = fileTabs.find((tab) => tab.id === tabId);
            if (recentFileTab) {
                return recentFileTab;
            }
        }

        return fileTabs[0] ?? null;
    }, [activeFileTab, fileTabs, recentActiveTabIds]);
    const isVisible = activeFileTab !== null;

    useRenderProbe("WorkspaceFileEditorHost", {
        hostedTabId: hostedTab?.id ?? null,
        visible: isVisible,
    });

    if (!hostedTab) {
        return null;
    }

    return (
        <div
            aria-hidden={!isVisible}
            className={isVisible ? "h-full" : "hidden"}
        >
            <FileTabView
                isActivePane={isActivePane && isVisible}
                isVisible={isVisible}
                onAttachLineFragment={onAttachLineFragment}
                onDraftChange={onDraftChange}
                onReload={onReload}
                onSave={onSave}
                tab={hostedTab}
            />
        </div>
    );
}

function WorkspaceDropTargetOverlay({
    target,
    visible,
}: {
    readonly target: WorkspaceTabDropTarget | null;
    readonly visible: boolean;
}) {
    if (!visible || !target || typeof document === "undefined") {
        return null;
    }

    return createPortal(
        <>
            {target.type === "strip" ? (
                <div
                    className="pointer-events-none fixed rounded-full bg-accent shadow-[0_0_0_1px_var(--color-accent)]"
                    style={{
                        height: target.lineRect.height,
                        left: target.lineRect.left,
                        top: target.lineRect.top,
                        width: target.lineRect.width,
                        zIndex: 10030,
                    }}
                />
            ) : null}

            {target.type === "pane-center" ? (
                <div
                    className="pointer-events-none fixed rounded-xl border-2 border-accent/90 bg-accent/8 shadow-[inset_0_0_0_1px_var(--color-accent)]"
                    style={{
                        height: target.rect.height,
                        left: target.rect.left,
                        top: target.rect.top,
                        width: target.rect.width,
                        zIndex: 10029,
                    }}
                />
            ) : null}

            {target.type === "split" ? (
                <div
                    className="pointer-events-none fixed rounded-xl border border-accent/90 bg-accent/12 shadow-[inset_0_0_0_1px_var(--color-accent)]"
                    style={{
                        height: target.rect.height,
                        left: target.rect.left,
                        top: target.rect.top,
                        width: target.rect.width,
                        zIndex: 10029,
                    }}
                />
            ) : null}
        </>,
        document.body,
    );
}

function WorkspaceTabDragOverlay({
    draggedTab,
    pointerCurrent,
    pointerOffset,
    target,
    visible,
}: {
    readonly draggedTab: ReturnType<typeof useWorkspaceTabDrag>["draggedTab"];
    readonly pointerCurrent: ReturnType<
        typeof useWorkspaceTabDrag
    >["pointerCurrent"];
    readonly pointerOffset: ReturnType<
        typeof useWorkspaceTabDrag
    >["pointerOffset"];
    readonly target: WorkspaceTabDropTarget | null;
    readonly visible: boolean;
}) {
    if (
        !visible ||
        !draggedTab ||
        !pointerCurrent ||
        !pointerOffset ||
        typeof document === "undefined"
    ) {
        return null;
    }

    const ghostLeft = pointerCurrent.x - pointerOffset.x;
    const ghostTop = pointerCurrent.y - pointerOffset.y;

    return createPortal(
        <>
            <WorkspaceDropTargetOverlay target={target} visible={true} />
            <div
                className="pointer-events-none fixed"
                style={{
                    left: ghostLeft,
                    top: ghostTop,
                    zIndex: 10031,
                }}
            >
                <div className="flex h-7.75 max-w-72 items-center gap-1.5 rounded-md border border-border-strong bg-bg-panel/96 px-3 text-[12px] text-text-primary shadow-[0_10px_30px_rgba(15,23,42,0.22)] backdrop-blur-sm">
                    <TabIcon kind={draggedTab.kind} title={draggedTab.title} />
                    <span className="truncate">{draggedTab.title}</span>
                    {draggedTab.isDirty ? (
                        <span className="text-[9px] text-(--diff-warn)">●</span>
                    ) : null}
                </div>
            </div>
        </>,
        document.body,
    );
}

function isWorkspaceGitHubTabKind(
    kind: RuntimeWorkspaceTab["kind"],
): kind is
    | "github_issue"
    | "github_issues"
    | "github_pull_request"
    | "github_pull_requests" {
    return (
        kind === "github_issues" ||
        kind === "github_issue" ||
        kind === "github_pull_requests" ||
        kind === "github_pull_request"
    );
}

function getWorkspaceTabComposerDragItem(
    tab: RuntimeWorkspaceTab,
): WorkspaceTabComposerDragItem | null {
    if (tab.kind === "file") {
        return {
            kind: "file_mention",
            label: tab.title,
            relativePath: tab.relativePath,
        };
    }

    if (tab.kind === "git_commit") {
        return {
            commitSha: tab.commitSha,
            kind: "git_commit_mention",
            label: tab.title,
        };
    }

    if (tab.kind === "github_issue") {
        const title = getCachedGitHubIssueTitle(tab);
        return {
            host: tab.ref.host,
            kind: "github_issue_mention",
            label: `#${tab.issueNumber}`,
            number: tab.issueNumber,
            owner: tab.ref.owner,
            repo: tab.ref.repo,
            title,
            url: buildGitHubRepositoryUrl(tab.ref, `/issues/${tab.issueNumber}`),
        };
    }

    if (tab.kind === "github_pull_request") {
        const title = getCachedGitHubPullRequestTitle(tab);
        return {
            host: tab.ref.host,
            kind: "github_pull_request_mention",
            label: `PR #${tab.pullRequestNumber}`,
            number: tab.pullRequestNumber,
            owner: tab.ref.owner,
            repo: tab.ref.repo,
            title,
            url: buildGitHubRepositoryUrl(
                tab.ref,
                `/pull/${tab.pullRequestNumber}`,
            ),
        };
    }

    return null;
}

function getSidebarGitHubComposerDragItems(
    detail: SidebarGitHubDragDetail,
): readonly WorkspaceTabComposerDragItem[] {
    const sidebarItems =
        detail.items.length > 0
            ? detail.items
            : [{ number: detail.number, title: detail.title }];

    if (detail.itemKind === "issue") {
        return sidebarItems.map((item) =>
            createGitHubIssueComposerDragItem(detail.ref, {
                number: item.number,
                title: item.title,
                url: buildGitHubRepositoryUrl(detail.ref, `/issues/${item.number}`),
            }),
        );
    }

    return sidebarItems.map((item) =>
        createGitHubPullRequestComposerDragItem(detail.ref, {
            number: item.number,
            title: item.title,
            url: buildGitHubRepositoryUrl(detail.ref, `/pull/${item.number}`),
        }),
    );
}

function getCachedGitHubIssueTitle(
    tab: Extract<RuntimeWorkspaceTab, { readonly kind: "github_issue" }>,
): string {
    const repoKey = getGitHubRepoKey(tab.ref);
    const state = useGitHubStore.getState();

    return (
        state.issueDetailsByRepo[repoKey]?.[tab.issueNumber]?.title ??
        state.issuesByRepo[repoKey]?.find(
            (issue) => issue.number === tab.issueNumber,
        )?.title ??
        tab.title
    );
}

function getCachedGitHubPullRequestTitle(
    tab: Extract<RuntimeWorkspaceTab, { readonly kind: "github_pull_request" }>,
): string {
    const repoKey = getGitHubRepoKey(tab.ref);
    const state = useGitHubStore.getState();

    return (
        state.pullRequestDetailsByRepo[repoKey]?.[tab.pullRequestNumber]
            ?.title ??
        state.pullRequestsByRepo[repoKey]?.find(
            (pullRequest) =>
                pullRequest.number === tab.pullRequestNumber,
        )?.title ??
        tab.title
    );
}

function PaneActionButton({
    label,
    onClick,
    onContextMenu,
    title,
}: {
    readonly label: string;
    readonly onClick: () => void;
    readonly onContextMenu?: (
        event: ReactMouseEvent<HTMLButtonElement>,
    ) => void;
    readonly title: string;
}) {
    return (
        <button
            className="app-no-drag rounded px-1.5 py-0.5 text-[11px] text-text-secondary transition hover:bg-bg-tertiary hover:text-text-primary"
            onClick={onClick}
            onContextMenu={onContextMenu}
            title={title}
            type="button"
        >
            {label}
        </button>
    );
}

function QuickCreateMenu({
    entries,
    menu,
    onClose,
}: {
    readonly entries: readonly QuickCreateMenuEntry[];
    readonly menu: Exclude<QuickCreateMenuState, null>;
    readonly onClose: () => void;
}) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const submenuRef = useRef<HTMLDivElement | null>(null);
    const [rootPosition, setRootPosition] = useState({ x: menu.x, y: menu.y });
    const [submenu, setSubmenu] = useState<QuickCreateSubmenuState>(null);
    const [submenuPosition, setSubmenuPosition] = useState<{
        readonly x: number;
        readonly y: number;
    } | null>(null);

    useLayoutEffect(() => {
        const element = rootRef.current;
        if (!element) {
            return;
        }

        const rect = element.getBoundingClientRect();
        setRootPosition(
            getViewportSafeMenuPosition(
                menu.x,
                menu.y,
                rect.width,
                rect.height,
            ),
        );
    }, [entries.length, menu.x, menu.y]);

    useLayoutEffect(() => {
        if (!submenu || !submenuRef.current) {
            return;
        }

        const rect = submenuRef.current.getBoundingClientRect();
        setSubmenuPosition(
            getViewportSafeSubmenuPosition(
                submenu.anchorRect,
                rect.width,
                rect.height,
            ),
        );
    }, [submenu]);

    useEffect(() => {
        const handleMouseDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (
                rootRef.current?.contains(target) ||
                submenuRef.current?.contains(target)
            ) {
                return;
            }

            onClose();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };

        document.addEventListener("mousedown", handleMouseDown);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("mousedown", handleMouseDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [onClose]);

    const closeAndRunAction = (action?: () => void) => {
        onClose();
        if (!action) {
            return;
        }

        queueMicrotask(action);
    };

    const openSubmenu = (
        event: ReactMouseEvent<HTMLButtonElement>,
        children: readonly QuickCreateMenuEntry[],
    ) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setSubmenu({
            anchorRect: {
                left: rect.left,
                right: rect.right,
                top: rect.top,
            },
            entries: children,
        });
    };

    const renderEntries = (
        list: readonly QuickCreateMenuEntry[],
        isRoot: boolean,
    ) =>
        list.map((entry, index) => {
            if (isQuickCreateMenuSeparator(entry)) {
                return (
                    <div
                        className="my-1 border-t border-border"
                        key={`separator-${index}`}
                    />
                );
            }

            const hasChildren = Boolean(entry.children?.length);

            return (
                <button
                    className={[
                        "flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-xs transition",
                        entry.disabled
                            ? "cursor-not-allowed text-text-secondary/50"
                            : "text-text-primary hover:bg-bg-tertiary",
                    ].join(" ")}
                    disabled={entry.disabled}
                    key={`${entry.label}-${index}`}
                    onClick={() => {
                        if (hasChildren) {
                            return;
                        }

                        closeAndRunAction(entry.action);
                    }}
                    onMouseEnter={(event) => {
                        if (hasChildren && entry.children) {
                            openSubmenu(event, entry.children);
                            return;
                        }

                        if (isRoot) {
                            setSubmenu(null);
                            setSubmenuPosition(null);
                        }
                    }}
                    title={entry.title}
                    type="button"
                >
                    <span>{entry.label}</span>
                    {hasChildren ? (
                        <span className="text-[10px] text-text-secondary">
                            ▸
                        </span>
                    ) : null}
                </button>
            );
        });

    return createPortal(
        <>
            <div
                className="fixed rounded-lg border border-border bg-bg-panel p-1 shadow-[0_10px_30px_rgba(15,23,42,0.18)]"
                ref={rootRef}
                style={{
                    left: rootPosition.x,
                    minWidth: 196,
                    top: rootPosition.y,
                    zIndex: 10020,
                }}
            >
                {renderEntries(entries, true)}
            </div>

            {submenu && submenuPosition ? (
                <div
                    className="fixed rounded-lg border border-border bg-bg-panel p-1 shadow-[0_10px_30px_rgba(15,23,42,0.18)]"
                    ref={submenuRef}
                    style={{
                        left: submenuPosition.x,
                        minWidth: 176,
                        top: submenuPosition.y,
                        zIndex: 10021,
                    }}
                >
                    {renderEntries(submenu.entries, false)}
                </div>
            ) : submenu ? (
                <div
                    className="fixed rounded-lg border border-border bg-bg-panel p-1 opacity-0 pointer-events-none"
                    ref={submenuRef}
                    style={{
                        left: submenu.anchorRect.right + 4,
                        minWidth: 176,
                        top: submenu.anchorRect.top,
                        zIndex: 10021,
                    }}
                >
                    {renderEntries(submenu.entries, false)}
                </div>
            ) : null}
        </>,
        document.body,
    );
}

export function getQuickCreateButtonTitle(
    action: WorkspaceQuickCreateAction,
    hasProject: boolean,
) {
    switch (action) {
        case "claude":
            return "Open last item: Claude chat";
        case "grok":
            return "Open last item: Grok chat";
        case "kilo":
            return "Open last item: Kilo chat";
        case "opencode":
            return "Open last item: OpenCode chat";
        case "terminal":
            return "Open last item: terminal";
        case "git":
            return hasProject
                ? "Open last item: Git"
                : "Open last item: Codex chat";
        case "history":
            return hasProject
                ? "Open last item: History"
                : "Open last item: Codex chat";
        case "file":
            return hasProject
                ? "Open last item: new file"
                : "Open last item: Codex chat";
        case "codex":
        default:
            return "Open last item: Codex chat";
    }
}

function waitForNextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
        window.requestAnimationFrame(() => resolve());
    });
}

async function appendSelectionMentionToComposer(input: {
    readonly endLine: number;
    readonly path: string;
    readonly selectedText: string;
    readonly sessionId: string;
    readonly startLine: number;
}): Promise<boolean> {
    if (
        appendSelectionMentionToRegisteredComposer(input.sessionId, {
            endLine: input.endLine,
            path: input.path,
            selectedText: input.selectedText,
            startLine: input.startLine,
        })
    ) {
        return true;
    }

    await waitForNextAnimationFrame();

    return appendSelectionMentionToRegisteredComposer(input.sessionId, {
        endLine: input.endLine,
        path: input.path,
        selectedText: input.selectedText,
        startLine: input.startLine,
    });
}

function tryAttachEditorSelectionToComposer(input: {
    readonly documentLanguageId: string;
    readonly projectId: string;
    readonly relativePath: string;
    readonly tabTitle: string;
    readonly worktreeId: string | null;
    readonly editor: MonacoEditor.IStandaloneCodeEditor;
    readonly onAttachLineFragment: (input: {
        readonly context: AiFileContextAttachment;
        readonly worktreeId: string | null;
    }) => Promise<void>;
}): boolean {
    const model = input.editor.getModel();
    const selection = input.editor.getSelection();

    if (!model || !selection || selection.isEmpty()) {
        return false;
    }

    const selectedText = model.getValueInRange(selection);
    if (!selectedText.trim()) {
        return false;
    }

    const startOffset = model.getOffsetAt(selection.getStartPosition());
    const endOffset = model.getOffsetAt(selection.getEndPosition());
    const effectiveEndOffset = Math.max(startOffset, endOffset - 1);
    const startLine = model.getPositionAt(startOffset).lineNumber;
    const endLine = model.getPositionAt(effectiveEndOffset).lineNumber;

    void input.onAttachLineFragment({
        context: {
            endLine,
            extension: input.relativePath.includes(".")
                ? (input.relativePath.split(".").pop() ?? null)
                : null,
            id: `file-ctx:${crypto.randomUUID()}`,
            languageId: input.documentLanguageId,
            name: input.tabTitle,
            projectId: input.projectId,
            relativePath: input.relativePath,
            selectedText,
            startLine,
        },
        worktreeId: input.worktreeId,
    });

    return true;
}

interface AttachSelectionShortcutInput {
    readonly documentLanguageId: string;
    readonly onAttachLineFragment: (input: {
        readonly context: AiFileContextAttachment;
        readonly worktreeId: string | null;
    }) => Promise<void>;
    readonly projectId: string;
    readonly relativePath: string;
    readonly tabTitle: string;
    readonly worktreeId: string | null;
}

function isAttachSelectionShortcutEvent(event: KeyboardEvent): boolean {
    return (
        event.key.toLowerCase() === "l" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
    );
}

function stopHandledAttachSelectionShortcut(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function tryAttachEditorSelectionWithShortcutInput(
    input: AttachSelectionShortcutInput & {
        readonly editor: MonacoEditor.IStandaloneCodeEditor;
    },
): boolean {
    return tryAttachEditorSelectionToComposer({
        documentLanguageId: input.documentLanguageId,
        editor: input.editor,
        onAttachLineFragment: input.onAttachLineFragment,
        projectId: input.projectId,
        relativePath: input.relativePath,
        tabTitle: input.tabTitle,
        worktreeId: input.worktreeId,
    });
}

function bindAttachSelectionShortcutWithInputRef(input: {
    readonly editor: MonacoEditor.IStandaloneCodeEditor;
    readonly inputRef: {
        readonly current: AttachSelectionShortcutInput | null;
    };
}): (() => void) | null {
    const editorDomNode = input.editor.getDomNode();
    const ownerDocument =
        editorDomNode?.ownerDocument ??
        (typeof document === "undefined" ? null : document);
    if (!editorDomNode && !ownerDocument) {
        return null;
    }

    const handleEditorKeyDown = (event: KeyboardEvent) => {
        if (!isAttachSelectionShortcutEvent(event)) {
            return;
        }

        const isEditorDomListener = event.currentTarget === editorDomNode;
        if (
            !isEditorDomListener &&
            !input.editor.hasTextFocus() &&
            !input.editor.hasWidgetFocus()
        ) {
            return;
        }

        const shortcutInput = input.inputRef.current;
        if (!shortcutInput) {
            return;
        }

        const attached = tryAttachEditorSelectionWithShortcutInput({
            ...shortcutInput,
            editor: input.editor,
        });

        if (!attached) {
            return;
        }

        stopHandledAttachSelectionShortcut(event);
    };

    // Monaco can keep an editor instance alive while its model or DOM subtree
    // changes. The document-level capture listener keeps Cmd+L stable across
    // those transitions, while the focus guard prevents inactive editors from
    // handling global shortcuts.
    editorDomNode?.addEventListener("keydown", handleEditorKeyDown, true);
    ownerDocument?.addEventListener("keydown", handleEditorKeyDown, true);

    return () => {
        editorDomNode?.removeEventListener(
            "keydown",
            handleEditorKeyDown,
            true,
        );
        ownerDocument?.removeEventListener(
            "keydown",
            handleEditorKeyDown,
            true,
        );
    };
}

function getAttachSelectionDiffEditorCandidates(
    event: KeyboardEvent,
    editors: readonly MonacoEditor.IStandaloneCodeEditor[],
): MonacoEditor.IStandaloneCodeEditor[] {
    const eventTarget = event.target instanceof Node ? event.target : null;
    const targetEditors = eventTarget
        ? editors.filter((editor) => editor.getDomNode()?.contains(eventTarget))
        : [];
    const focusedEditors = editors.filter(
        (editor) => editor.hasTextFocus() || editor.hasWidgetFocus(),
    );
    const targetedCandidates = [...targetEditors, ...focusedEditors].filter(
        (editor, index, candidates) => candidates.indexOf(editor) === index,
    );

    if (targetedCandidates.length > 0) {
        return targetedCandidates;
    }

    return [...editors];
}

function bindInlineReviewAttachSelectionShortcut(input: {
    readonly diffEditor: MonacoEditor.IStandaloneDiffEditor;
    readonly inputRef: {
        readonly current: AttachSelectionShortcutInput | null;
    };
}): (() => void) {
    const containerDomNode = input.diffEditor.getContainerDomNode();

    const handleDiffEditorKeyDown = (event: KeyboardEvent) => {
        if (!isAttachSelectionShortcutEvent(event)) {
            return;
        }

        const shortcutInput = input.inputRef.current;
        if (!shortcutInput) {
            return;
        }

        const candidates = getAttachSelectionDiffEditorCandidates(event, [
            input.diffEditor.getModifiedEditor(),
            input.diffEditor.getOriginalEditor(),
        ]);

        if (
            !candidates.some((editor) =>
                tryAttachEditorSelectionWithShortcutInput({
                    ...shortcutInput,
                    editor,
                }),
            )
        ) {
            return;
        }

        stopHandledAttachSelectionShortcut(event);
    };

    containerDomNode.addEventListener("keydown", handleDiffEditorKeyDown, true);

    return () => {
        containerDomNode.removeEventListener(
            "keydown",
            handleDiffEditorKeyDown,
            true,
        );
    };
}

function bindCloseFindWidgetOnEscape(
    editor: MonacoEditor.IStandaloneCodeEditor,
): (() => void) | null {
    const editorDomNode = editor.getDomNode();
    if (!editorDomNode) {
        return null;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") {
            return;
        }

        const findController = editor.getContribution(
            "editor.contrib.findController",
        ) as {
            closeFindWidget?: () => void;
            getState?: () => { isRevealed?: boolean };
        } | null;

        if (
            !findController?.closeFindWidget ||
            !findController.getState?.().isRevealed
        ) {
            return;
        }

        findController.closeFindWidget();
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    };

    editorDomNode.addEventListener("keydown", handleKeyDown, true);

    return () => {
        editorDomNode.removeEventListener("keydown", handleKeyDown, true);
    };
}

function handleMarkdownListEditingShortcut(
    editor: MonacoEditor.IStandaloneCodeEditor,
    event: KeyboardEvent,
): void {
    if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing
    ) {
        return;
    }

    const model = editor.getModel();
    const selections = editor.getSelections();
    const selection = editor.getSelection();
    if (!model || !selection || (selections?.length ?? 0) > 1) {
        return;
    }

    const text = model.getValue();
    const tabSize = model.getOptions().tabSize;
    const selectionStartOffset = model.getOffsetAt(
        selection.getStartPosition(),
    );
    const selectionEndOffset = model.getOffsetAt(selection.getEndPosition());
    const result =
        event.key === "Enter" && !event.shiftKey && selection.isEmpty()
            ? continueMarkdownList(text, selectionEndOffset)
            : event.key === "Tab" && !event.shiftKey
              ? indentMarkdownListItems(
                    text,
                    selectionStartOffset,
                    selectionEndOffset,
                    tabSize,
                )
              : event.key === "Tab" && event.shiftKey
                ? outdentMarkdownListItems(
                      text,
                      selectionStartOffset,
                      selectionEndOffset,
                      tabSize,
                  )
                : null;
    if (!result) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    // Apply only the minimal changed region. Replacing the full model range
    // (with forceMoveMarkers) drags every tracked decoration — including the
    // git gutter markers — to the end of the document, which is what made the
    // whole gutter flicker on each Enter/Tab in markdown files.
    const minimalEdit = computeMinimalTextEdit(text, result.text);
    const editStart = model.getPositionAt(minimalEdit.rangeStart);
    const editEnd = model.getPositionAt(minimalEdit.rangeEnd);

    editor.pushUndoStop();
    editor.executeEdits("markdown-list-continuation", [
        {
            range: {
                endColumn: editEnd.column,
                endLineNumber: editEnd.lineNumber,
                startColumn: editStart.column,
                startLineNumber: editStart.lineNumber,
            },
            text: minimalEdit.insert,
        },
    ]);

    const nextModel = editor.getModel();
    if (!nextModel) {
        return;
    }

    editor.setSelection({
        endColumn: nextModel.getPositionAt(result.selectionEnd).column,
        endLineNumber: nextModel.getPositionAt(result.selectionEnd).lineNumber,
        startColumn: nextModel.getPositionAt(result.selectionStart).column,
        startLineNumber: nextModel.getPositionAt(result.selectionStart)
            .lineNumber,
    });
    editor.pushUndoStop();
}

function bindMarkdownListEditingShortcutsWithLanguageRef(input: {
    readonly documentLanguageIdRef: {
        readonly current: string;
    };
    readonly editor: MonacoEditor.IStandaloneCodeEditor;
}): (() => void) | null {
    const editorDomNode = input.editor.getDomNode();
    if (!editorDomNode) {
        return null;
    }

    const handleEditorKeyDown = (event: KeyboardEvent) => {
        if (input.documentLanguageIdRef.current !== "markdown") {
            return;
        }

        handleMarkdownListEditingShortcut(input.editor, event);
    };

    editorDomNode.addEventListener("keydown", handleEditorKeyDown, true);

    return () => {
        editorDomNode.removeEventListener("keydown", handleEditorKeyDown, true);
    };
}

function getFindController(editor: MonacoEditor.IStandaloneCodeEditor) {
    return editor.getContribution("editor.contrib.findController") as {
        getState?: () => {
            isRevealed?: boolean;
            onFindReplaceStateChange?: (listener: () => void) => {
                dispose: () => void;
            };
        };
    } | null;
}

function countTextLines(text: string): number {
    return text.split("\n").length;
}

function buildProjectScopedFilePath(input: {
    readonly projectName: string | null;
    readonly relativePath: string;
}): string {
    const normalizedRelativePath = input.relativePath.trim();
    if (!normalizedRelativePath) {
        return input.projectName ?? "";
    }

    if (
        !input.projectName ||
        normalizedRelativePath === input.projectName ||
        normalizedRelativePath.startsWith(`${input.projectName}/`)
    ) {
        return normalizedRelativePath;
    }

    return `${input.projectName}/${normalizedRelativePath}`;
}

function MarkdownViewModeSwitch({
    mode,
    onChange,
}: {
    readonly mode: MarkdownFileViewMode;
    readonly onChange: (mode: MarkdownFileViewMode) => void;
}) {
    const modes: readonly MarkdownFileViewMode[] = ["edit", "preview"];

    return (
        <div
            aria-label="Markdown view mode"
            className="flex h-5 w-[7.75rem] items-center rounded-md border border-border bg-bg-primary/70 p-0.5"
            role="group"
        >
            {modes.map((entry) => {
                const isActive = mode === entry;
                const label = entry === "edit" ? "Edit" : "Preview";

                return (
                    <button
                        aria-pressed={isActive}
                        className={[
                            "h-4 flex-1 rounded-[4px] px-1 text-center text-[10px] font-semibold leading-4 transition-colors",
                            isActive
                                ? "bg-bg-tertiary text-text-primary shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)]"
                                : "text-text-secondary hover:text-text-primary",
                        ].join(" ")}
                        key={entry}
                        onClick={() => onChange(entry)}
                        type="button"
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

function MarkdownPreviewScrollSurface({
    children,
    onScrollTopChange,
    scrollTop,
    tabId,
}: {
    readonly children: ReactNode;
    readonly onScrollTopChange: (tabId: string, scrollTop: number) => void;
    readonly scrollTop: number;
    readonly tabId: string;
}) {
    const nodeRef = useRef<HTMLDivElement | null>(null);
    const mountedTabIdRef = useRef(tabId);
    const restoredTabIdRef = useRef<string | null>(null);
    const scrollPersistFrameRef = useRef<number | null>(null);

    const cancelPendingScrollPersist = useCallback(() => {
        if (scrollPersistFrameRef.current === null) {
            return;
        }

        window.cancelAnimationFrame(scrollPersistFrameRef.current);
        scrollPersistFrameRef.current = null;
    }, []);

    const flushNodeScrollTop = useCallback(
        (node: HTMLDivElement, flushedTabId: string) => {
            onScrollTopChange(flushedTabId, node.scrollTop);
        },
        [onScrollTopChange],
    );

    const attachScrollNode = useCallback(
        (node: HTMLDivElement | null) => {
            const previousNode = nodeRef.current;
            if (previousNode && previousNode !== node) {
                cancelPendingScrollPersist();
                flushNodeScrollTop(previousNode, mountedTabIdRef.current);
            }

            nodeRef.current = node;
            if (!node) {
                return;
            }
        },
        [cancelPendingScrollPersist, flushNodeScrollTop],
    );

    const handleScroll = useCallback(() => {
        const node = nodeRef.current;
        if (!node || scrollPersistFrameRef.current !== null) {
            return;
        }

        const flushedTabId = mountedTabIdRef.current;
        scrollPersistFrameRef.current = window.requestAnimationFrame(() => {
            scrollPersistFrameRef.current = null;
            if (
                nodeRef.current === node &&
                mountedTabIdRef.current === flushedTabId
            ) {
                flushNodeScrollTop(node, flushedTabId);
            }
        });
    }, [flushNodeScrollTop]);

    useLayoutEffect(() => {
        const node = nodeRef.current;
        if (!node) {
            return;
        }

        mountedTabIdRef.current = tabId;
        cancelPendingScrollPersist();

        const shouldRestore = restoredTabIdRef.current !== tabId;
        const nextScrollTop = scrollTop;
        if (shouldRestore) {
            node.scrollTop = nextScrollTop;
            restoredTabIdRef.current = tabId;
        }

        return () => {
            cancelPendingScrollPersist();
            flushNodeScrollTop(node, tabId);
        };
    }, [
        cancelPendingScrollPersist,
        flushNodeScrollTop,
        scrollTop,
        tabId,
    ]);

    return (
        <div
            className="markdown-file-preview-scroll absolute inset-0 overflow-auto"
            onScroll={handleScroll}
            ref={attachScrollNode}
        >
            {children}
        </div>
    );
}

function FileTabView({
    isActivePane,
    isVisible,
    onAttachLineFragment,
    onDraftChange,
    onReload,
    onSave,
    tab,
}: {
    readonly isActivePane: boolean;
    readonly isVisible: boolean;
    readonly onAttachLineFragment: (input: {
        readonly context: AiFileContextAttachment;
        readonly worktreeId: string | null;
    }) => Promise<void>;
    readonly onDraftChange: (tabId: string, draft: string) => void;
    readonly onReload: (tabId: string) => Promise<void>;
    readonly onSave: (
        tabId: string,
        options?: {
            readonly force?: boolean;
        },
    ) => Promise<void>;
    readonly tab: RuntimeWorkspaceFileTab;
}) {
    const document = tab.document;
    useRenderProbe("FileTabView", {
        path: tab.relativePath,
        tabId: tab.id,
    });
    useLifecycleProbe("FileTabView", {
        path: tab.relativePath,
        tabId: tab.id,
    });
    const projectSummary = useProjectsStore((state) =>
        state.projects.find((project) => project.id === tab.projectId) ?? null,
    );
    const documentDisplayPath = document
        ? buildProjectScopedFilePath({
              projectName: projectSummary?.name ?? null,
              relativePath: document.relativePath,
          })
        : null;
    const canEdit = document
        ? !document.isBinary && !document.isTooLarge
        : false;
    const {
        loadError: monacoLoadError,
        retryLoad: retryMonacoLoad,
        runtime,
    } = useMonacoSurfaceRuntime(canEdit);
    const editorTheme = useMonacoTheme(runtime);
    const monacoLanguageId = useMemo(
        () => {
            const resolvedLanguageId = resolveMonacoLanguageId(
                document?.languageId ?? "",
            );

            return shouldDisableTextMateForDocumentSize(document?.sizeBytes)
                ? resolveLargeFileMonacoLanguageId(resolvedLanguageId)
                : resolvedLanguageId;
        },
        [document?.languageId, document?.sizeBytes],
    );
    const documentAbsolutePath = document?.absolutePath ?? null;
    const editorSettings = useResolvedEditorSettings();
    const trackedFile = useAiStore(
        useCallback(
            (state: ReturnType<typeof useAiStore.getState>) =>
                document
                    ? findTrackedFileForDocument(
                          state.sessions,
                          document,
                          tab.reviewContext,
                      )
                    : null,
            [document, tab.reviewContext],
        ),
    );
    const keepTrackedFileHunks = useAiStore(
        (state) => state.keepTrackedFileHunks,
    );
    const keepTrackedFile = useAiStore((state) => state.keepTrackedFile);
    const rejectTrackedFileHunks = useAiStore(
        (state) => state.rejectTrackedFileHunks,
    );
    const rejectTrackedFile = useAiStore((state) => state.rejectTrackedFile);
    const updateFileViewState = useWorkspaceStore(
        (state) => state.updateFileViewState,
    );
    const updateFilePendingOpenLocation = useWorkspaceStore(
        (state) => state.updateFilePendingOpenLocation,
    );
    const updateFileMarkdownViewMode = useWorkspaceStore(
        (state) => state.updateFileMarkdownViewMode,
    );
    const updateFileMarkdownPreviewScrollTop = useWorkspaceStore(
        (state) => state.updateFileMarkdownPreviewScrollTop,
    );
    const diffEditorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(
        null,
    );
    const inlineReviewContainerRef = useRef<HTMLDivElement | null>(null);
    const inlineReviewVimStatusRef = useRef<HTMLDivElement | null>(null);
    const inlineReviewOverlayPinnedRef = useRef(false);
    const inlineReviewHoverHideTimerRef = useRef<number | null>(null);
    const hoveredInlineReviewHunkIdRef = useRef<string | null>(null);
    const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
    const editorVimModeRef = useRef<ReturnType<
        typeof enableMonacoVimMode
    > | null>(null);
    const inlineReviewVimModeRef = useRef<ReturnType<
        typeof enableMonacoVimMode
    > | null>(null);
    const editorVimStatusRef = useRef<HTMLDivElement | null>(null);
    const editorMonacoRef = useRef<MonacoNamespace | null>(null);
    const workspaceFileModelLeaseRef =
        useRef<WorkspaceFileModelLease | null>(null);
    const editorAttachSelectionShortcutInputRef =
        useRef<AttachSelectionShortcutInput | null>(null);
    const inlineReviewAttachSelectionShortcutInputRef =
        useRef<AttachSelectionShortcutInput | null>(null);
    const editorMarkdownLanguageIdRef = useRef(
        document?.languageId ?? "plaintext",
    );
    const inlineReviewMonacoRef = useRef<MonacoNamespace | null>(null);
    const inlineReviewCurrentModelsRef = useRef<InlineReviewModelState>({
        modified: null,
        original: null,
        revision: null,
    });
    const inlineReviewOwnedModelsRef = useRef<{
        readonly modified: MonacoEditor.ITextModel | null;
        readonly original: MonacoEditor.ITextModel | null;
    }>({
        modified: null,
        original: null,
    });
    const inlineReviewScrollRestoreFrameRef = useRef<number | null>(null);
    const inlineReviewScrollStateRef = useRef<
        ReturnType<typeof captureDiffEditorScrollState>
    >(captureDiffEditorScrollState(null));
    const pendingEditorInlineReviewRestoreStateRef = useRef<{
        readonly reviewSignature: string | null;
        readonly state: PortableEditorRestoreState;
        readonly tabId: string;
    } | null>(null);
    const pendingInlineReviewRestoreStateRef = useRef<{
        readonly state: PortableEditorRestoreState;
        readonly tabId: string;
    } | null>(null);
    const fileTabIdRef = useRef(tab.id);
    const inlineReviewActiveRef = useRef(false);
    const inlineReviewSignatureRef = useRef<string | null>(null);
    const latestDraftContentRef = useRef(tab.draftContent);
    const gitGutterDecoratorRef = useRef<GitGutterDecorator | null>(null);
    const inlineReviewDecorationsRef =
        useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
    const pendingEditorViewStateRef =
        useRef<MonacoEditor.ICodeEditorViewState | null>(tab.viewState ?? null);
    const pendingEditorViewStateTabIdRef = useRef(tab.id);
    const viewStatePersistTimerRef = useRef<number | null>(null);
    const scheduledEditorViewStatePersistRef = useRef<{
        readonly tabId: string;
        readonly viewState: MonacoEditor.ICodeEditorViewState | null;
    } | null>(null);
    const viewStateRestoreFrameRef = useRef<number | null>(null);
    const restoredEditorViewStateTabIdRef = useRef<string | null>(null);
    const suppressEditorChangeRef = useRef(false);
    const [editorMountVersion, setEditorMountVersion] = useState(0);
    const [diffEditorMountVersion, setDiffEditorMountVersion] = useState(0);
    const [
        isInlineReviewFindWidgetVisible,
        setIsInlineReviewFindWidgetVisible,
    ] = useState(false);
    const [hoveredInlineReviewHunkState, setHoveredInlineReviewHunkState] =
        useState<{
            readonly hunkId: string;
            readonly top: number;
        } | null>(null);
    const documentKind = document?.kind ?? null;
    const documentLanguageId = document?.languageId ?? "plaintext";
    const isMarkdownFile = documentLanguageId === "markdown";
    const gitSnapshot = useGitStore((state) => {
        const contextKey = getWorkspaceGitContextKey(
            tab.projectId,
            tab.worktreeId ?? null,
        );
        return state.snapshots[contextKey] ?? null;
    });
    const activeGitChange = useMemo(
        () =>
            gitSnapshot?.changes.find(
                (change) => change.path === tab.relativePath,
            ) ?? null,
        [gitSnapshot?.changes, tab.relativePath],
    );
    const activeGitChangeSignature = useMemo(
        () => getGitGutterChangeSignature(activeGitChange),
        [activeGitChange],
    );
    const shouldShowGitGutter = hasRenderableGitGutterChange(activeGitChange);
    const gitGutterDiffRequestKey = useMemo(
        () =>
            getGitGutterDiffRequestKey({
                projectId: tab.projectId,
                relativePath: tab.relativePath,
                worktreeId: tab.worktreeId ?? null,
            }),
        [
            tab.projectId,
            tab.relativePath,
            tab.worktreeId,
        ],
    );
    const [gitGutterDiffState, setGitGutterDiffState] = useState<{
        readonly base: GitOriginalFile | null;
        readonly diff: GitFileDiff | null;
        readonly key: string;
    } | null>(null);
    const [gitGutterLiveDiffState, setGitGutterLiveDiffState] =
        useState<GitGutterLiveDiffState | null>(null);
    const gitGutterSource =
        gitGutterDiffState?.key === gitGutterDiffRequestKey
            ? gitGutterDiffState
            : null;
    const gitGutterLiveState =
        gitGutterLiveDiffState?.key === gitGutterDiffRequestKey
            ? gitGutterLiveDiffState
            : null;
    const gitGutterDiff =
        gitGutterLiveState?.status === "ready"
            ? gitGutterLiveState.diff
            : gitGutterLiveState?.status === "unavailable"
              ? null
              : (gitGutterSource?.diff ?? null);
    const editorLineNumbersMinChars = useMemo(
        () => getEditorLineNumbersMinChars(countTextLines(tab.draftContent)),
        [tab.draftContent],
    );
    const canShowInlineReview = isInlineReviewSupported(trackedFile);
    const showInlineReview = canShowInlineReview;
    const inlineReviewTrackedFile =
        showInlineReview &&
        canShowInlineReview &&
        trackedFile?.oldText !== null &&
        trackedFile?.newText !== null
            ? trackedFile
            : null;
    const isInlineReviewActive = inlineReviewTrackedFile !== null;
    const reviewSignature = useMemo(
        () => getInlineReviewSignature(inlineReviewTrackedFile),
        [inlineReviewTrackedFile],
    );
    const inlineReviewModelRevision = useMemo(
        () => getInlineReviewModelRevision(inlineReviewTrackedFile),
        [inlineReviewTrackedFile],
    );
    const inlineReviewShellModelPaths = useMemo(() => {
        if (!documentAbsolutePath) {
            return null;
        }

        return {
            modified: buildWorkspaceEditorModelPath(
                documentAbsolutePath,
                tab.id,
                "review-modified",
                "shell",
            ),
            original: buildWorkspaceEditorModelPath(
                documentAbsolutePath,
                tab.id,
                "review-original",
                "shell",
            ),
        };
    }, [
        documentAbsolutePath,
        tab.id,
    ]);
    const inlineReviewDiffEditorKey = useMemo(() => {
        if (!inlineReviewShellModelPaths) {
            return `inline-review:${tab.id}`;
        }

        // @monaco-editor/react owns shell models through these path props, while
        // applyInlineReviewModels installs the real review models. Remount when
        // the file identity changes so the wrapper cannot replay stale shells.
        return [
            inlineReviewShellModelPaths.original,
            inlineReviewShellModelPaths.modified,
        ].join("|");
    }, [
        inlineReviewShellModelPaths,
        tab.id,
    ]);
    const reviewDiff = useMemo(
        () =>
            inlineReviewTrackedFile
                ? createDiffFromTrackedFile(inlineReviewTrackedFile)
                : null,
        [inlineReviewTrackedFile],
    );
    const inlineReviewHunkActionsEnabled = Boolean(
        inlineReviewTrackedFile &&
        reviewDiff &&
        canResolveFileHunks(inlineReviewTrackedFile, reviewDiff),
    );
    const areSuggestionsEnabled = areMonacoSuggestionsEnabledForLanguage(
        documentLanguageId,
        editorSettings.suggestionsEnabled,
    );
    const hoveredInlineReviewHunk =
        inlineReviewTrackedFile && hoveredInlineReviewHunkState
            ? (inlineReviewTrackedFile.hunks.find(
                  (hunk) => hunk.id === hoveredInlineReviewHunkState.hunkId,
              ) ?? null)
            : null;
    const adjustEditorFontSize = useCallback(
        async (mode: "decrease" | "increase" | "reset") => {
            const clampFontSize = (value: number) =>
                clampRoundedInt(
                    value,
                    EDITOR_FONT_SIZE_MIN,
                    EDITOR_FONT_SIZE_MAX,
                );
            const nextFontSizeFrom = (currentFontSize: number) => {
                if (mode === "reset") {
                    return DEFAULT_EDITOR_FONT_SIZE;
                }

                return clampFontSize(
                    currentFontSize + (mode === "increase" ? 1 : -1),
                );
            };
            const appEditor = await loadAppEditorSettings();
            await saveAppEditorSettings({
                ...appEditor,
                fontSize: nextFontSizeFrom(appEditor.fontSize),
            });
        },
        [],
    );

    const persistEditorViewState = useCallback(
        (
            nextTabId = pendingEditorViewStateTabIdRef.current,
            nextViewState?: MonacoEditor.ICodeEditorViewState | null,
        ) => {
            const resolvedViewState =
                nextViewState ??
                editorRef.current?.saveViewState() ??
                pendingEditorViewStateRef.current ??
                null;

            pendingEditorViewStateRef.current = resolvedViewState;
            pendingEditorViewStateTabIdRef.current = nextTabId;
            updateFileViewState(nextTabId, resolvedViewState);
        },
        [updateFileViewState],
    );

    const flushScheduledEditorViewStatePersist = useCallback(() => {
        const scheduledPersist = scheduledEditorViewStatePersistRef.current;
        scheduledEditorViewStatePersistRef.current = null;

        if (viewStatePersistTimerRef.current != null) {
            window.clearTimeout(viewStatePersistTimerRef.current);
            viewStatePersistTimerRef.current = null;
        }

        if (scheduledPersist) {
            persistEditorViewState(
                scheduledPersist.tabId,
                scheduledPersist.viewState,
            );
            if (
                scheduledPersist.tabId === pendingEditorViewStateTabIdRef.current
            ) {
                return;
            }
        }

        persistEditorViewState(
            pendingEditorViewStateTabIdRef.current,
            pendingEditorViewStateRef.current,
        );
    }, [persistEditorViewState]);

    const clearScheduledEditorViewStateRestore = useCallback(() => {
        if (viewStateRestoreFrameRef.current != null) {
            window.cancelAnimationFrame(viewStateRestoreFrameRef.current);
            viewStateRestoreFrameRef.current = null;
        }
    }, []);

    const restoreEditorViewState = useCallback(
        (
            editor: MonacoEditor.IStandaloneCodeEditor,
            viewState: MonacoEditor.ICodeEditorViewState,
        ) => {
            clearScheduledEditorViewStateRestore();
            try {
                editor.restoreViewState(viewState);
            } catch (error) {
                if (!isMonacoCancellationError(error)) {
                    throw error;
                }
            }
            editor.layout();

            // Re-apply after the first paint because Monaco can recompute
            // layout/model state right after mount and override the scroll.
            viewStateRestoreFrameRef.current = window.requestAnimationFrame(
                () => {
                    viewStateRestoreFrameRef.current = null;

                    if (editorRef.current !== editor) {
                        return;
                    }

                    try {
                        editor.restoreViewState(viewState);
                    } catch (error) {
                        if (!isMonacoCancellationError(error)) {
                            throw error;
                        }
                    }
                    editor.layout();
                },
            );
        },
        [clearScheduledEditorViewStateRestore],
    );

    const restorePortableEditorState = useCallback(
        (
            editor: MonacoEditor.IStandaloneCodeEditor,
            state: PortableEditorRestoreState,
        ) => {
            const applyState = () => {
                const model = editor.getModel();
                if (!model) {
                    return;
                }

                const lineNumber = Math.min(
                    Math.max(state.lineNumber, 1),
                    model.getLineCount(),
                );
                const column = Math.min(
                    Math.max(state.column, 1),
                    model.getLineMaxColumn(lineNumber),
                );

                editor.layout();
                editor.setPosition({ lineNumber, column });
                editor.setScrollLeft(state.scrollLeft);
                editor.setScrollTop(state.scrollTop);
            };

            clearScheduledEditorViewStateRestore();
            applyState();
            viewStateRestoreFrameRef.current = window.requestAnimationFrame(
                () => {
                    viewStateRestoreFrameRef.current = null;

                    if (editorRef.current !== editor) {
                        return;
                    }

                    applyState();
                },
            );
        },
        [clearScheduledEditorViewStateRestore],
    );

    const runWithoutEditorChangeNotification = useCallback(<T,>(
        action: () => T,
    ): T => {
        suppressEditorChangeRef.current = true;
        try {
            return action();
        } finally {
            suppressEditorChangeRef.current = false;
        }
    }, []);

    const acquireFileEditorModel = useCallback(
        (input: {
            readonly absolutePath: string;
            readonly language: string;
            readonly monaco: MonacoNamespace;
            readonly value: string;
        }): {
            readonly model: MonacoEditor.ITextModel;
            readonly previousLease: WorkspaceFileModelLease | null;
        } => {
            const modelPath = buildWorkspaceFileEditorModelPath(
                input.absolutePath,
            );
            const currentLease = workspaceFileModelLeaseRef.current;

            if (
                currentLease?.modelPath === modelPath &&
                !currentLease.model.isDisposed()
            ) {
                const model = getOrCreateWorkspaceFileModel(input);
                if (model === currentLease.model) {
                    return { model, previousLease: null };
                }
            }

            const nextLease = acquireWorkspaceFileModel(input);
            workspaceFileModelLeaseRef.current = nextLease;

            return {
                model: nextLease.model,
                previousLease: currentLease,
            };
        },
        [],
    );

    const scheduleEditorViewStatePersist = useCallback(
        (editor: MonacoEditor.IStandaloneCodeEditor) => {
            const tabId = fileTabIdRef.current;
            const viewState = editor.saveViewState();
            pendingEditorViewStateRef.current = viewState;
            pendingEditorViewStateTabIdRef.current = tabId;
            scheduledEditorViewStatePersistRef.current = {
                tabId,
                viewState,
            };

            if (viewStatePersistTimerRef.current != null) {
                return;
            }

            viewStatePersistTimerRef.current = window.setTimeout(() => {
                viewStatePersistTimerRef.current = null;
                const scheduledPersist =
                    scheduledEditorViewStatePersistRef.current;
                scheduledEditorViewStatePersistRef.current = null;

                if (!scheduledPersist) {
                    return;
                }

                persistEditorViewState(
                    scheduledPersist.tabId,
                    scheduledPersist.viewState,
                );
            }, 120);
        },
        [persistEditorViewState],
    );

    const captureEditorStateForInlineReview = useCallback(
        (editor: MonacoEditor.IStandaloneCodeEditor | null) => {
            // Once inline review is active, the hidden editor may report stale layout scroll.
            if (inlineReviewActiveRef.current) {
                return;
            }

            const state = capturePortableEditorRestoreState(editor);
            if (!state) {
                return;
            }

            pendingEditorInlineReviewRestoreStateRef.current = {
                reviewSignature: inlineReviewSignatureRef.current,
                state,
                tabId: fileTabIdRef.current,
            };
        },
        [],
    );

    const captureInlineReviewModifiedEditorState = useCallback(() => {
        const modifiedEditor =
            diffEditorRef.current?.getModifiedEditor() ?? null;
        const state = capturePortableEditorRestoreState(modifiedEditor);
        if (!state) {
            return;
        }

        pendingInlineReviewRestoreStateRef.current = {
            state,
            tabId: fileTabIdRef.current,
        };

        const viewState = modifiedEditor?.saveViewState() ?? null;
        if (viewState) {
            pendingEditorViewStateRef.current = viewState;
            pendingEditorViewStateTabIdRef.current = fileTabIdRef.current;
        }
    }, []);

    useLayoutEffect(() => {
        inlineReviewActiveRef.current = isInlineReviewActive;
        inlineReviewSignatureRef.current = reviewSignature;
    }, [isInlineReviewActive, reviewSignature]);

    const handleKeepInlineReviewFile = useCallback(() => {
        if (!inlineReviewTrackedFile) {
            return;
        }

        captureInlineReviewModifiedEditorState();
        void keepTrackedFile(
            createReviewFileMutationInput(inlineReviewTrackedFile),
        );
    }, [
        captureInlineReviewModifiedEditorState,
        inlineReviewTrackedFile,
        keepTrackedFile,
    ]);

    const handleRejectInlineReviewFile = useCallback(() => {
        if (!inlineReviewTrackedFile) {
            return;
        }

        captureInlineReviewModifiedEditorState();
        void rejectTrackedFile(
            createReviewFileMutationInput(inlineReviewTrackedFile),
        );
    }, [
        captureInlineReviewModifiedEditorState,
        inlineReviewTrackedFile,
        rejectTrackedFile,
    ]);

    const buildEditorAttachSelectionShortcutInput =
        useCallback((): AttachSelectionShortcutInput | null => {
            if (!isVisible || !document || !canEdit || inlineReviewTrackedFile) {
                return null;
            }

            return {
                documentLanguageId: document.languageId,
                onAttachLineFragment,
                projectId: tab.projectId,
                relativePath: tab.relativePath,
                tabTitle: tab.title,
                worktreeId: tab.worktreeId ?? null,
            };
        }, [
            canEdit,
            document,
            inlineReviewTrackedFile,
            isVisible,
            onAttachLineFragment,
            tab.projectId,
            tab.relativePath,
            tab.title,
            tab.worktreeId,
        ]);

    const buildInlineReviewAttachSelectionShortcutInput =
        useCallback((): AttachSelectionShortcutInput | null => {
            if (!isVisible || !document || !canEdit || !inlineReviewTrackedFile) {
                return null;
            }

            return {
                documentLanguageId: document.languageId,
                onAttachLineFragment,
                projectId: tab.projectId,
                relativePath: tab.relativePath,
                tabTitle: tab.title,
                worktreeId: tab.worktreeId ?? null,
            };
        }, [
            canEdit,
            document,
            inlineReviewTrackedFile,
            isVisible,
            onAttachLineFragment,
            tab.projectId,
            tab.relativePath,
            tab.title,
            tab.worktreeId,
        ]);

    useLayoutEffect(() => {
        editorMarkdownLanguageIdRef.current = documentLanguageId;
        editorAttachSelectionShortcutInputRef.current =
            buildEditorAttachSelectionShortcutInput();
        inlineReviewAttachSelectionShortcutInputRef.current =
            buildInlineReviewAttachSelectionShortcutInput();
    }, [
        buildEditorAttachSelectionShortcutInput,
        buildInlineReviewAttachSelectionShortcutInput,
        documentLanguageId,
    ]);

    useLayoutEffect(() => {
        const previousTabId = fileTabIdRef.current;
        if (previousTabId === tab.id) {
            return;
        }

        if (editorRef.current) {
            const previousViewState = editorRef.current.saveViewState();
            pendingEditorViewStateRef.current = previousViewState;
            pendingEditorViewStateTabIdRef.current = previousTabId;
            updateFileViewState(previousTabId, previousViewState);
        }

        if (
            scheduledEditorViewStatePersistRef.current?.tabId === previousTabId
        ) {
            scheduledEditorViewStatePersistRef.current = null;
        }
        if (viewStatePersistTimerRef.current != null) {
            window.clearTimeout(viewStatePersistTimerRef.current);
            viewStatePersistTimerRef.current = null;
        }

        if (diffEditorRef.current) {
            captureInlineReviewModifiedEditorState();
            persistEditorViewState(
                previousTabId,
                pendingEditorViewStateRef.current,
            );
        }

        fileTabIdRef.current = tab.id;
        pendingEditorViewStateRef.current = tab.viewState ?? null;
        pendingEditorViewStateTabIdRef.current = tab.id;
        restoredEditorViewStateTabIdRef.current = null;
    }, [
        captureInlineReviewModifiedEditorState,
        persistEditorViewState,
        tab.id,
        tab.viewState,
        updateFileViewState,
    ]);

    useEffect(() => {
        const pendingState = pendingEditorInlineReviewRestoreStateRef.current;
        if (pendingState && pendingState.tabId !== tab.id) {
            pendingEditorInlineReviewRestoreStateRef.current = null;
        }
    }, [tab.id]);

    useEffect(() => {
        const pendingState = pendingInlineReviewRestoreStateRef.current;
        if (pendingState && pendingState.tabId !== tab.id) {
            pendingInlineReviewRestoreStateRef.current = null;
        }
    }, [tab.id]);

    useEffect(() => {
        pendingEditorViewStateRef.current = tab.viewState ?? null;
        pendingEditorViewStateTabIdRef.current = tab.id;
    }, [tab.id, tab.viewState]);

    useLayoutEffect(() => {
        return () => {
            if (isInlineReviewActive) {
                captureInlineReviewModifiedEditorState();
                persistEditorViewState(
                    fileTabIdRef.current,
                    pendingEditorViewStateRef.current,
                );
                return;
            }

            if (editorRef.current) {
                captureEditorStateForInlineReview(editorRef.current);
                persistEditorViewState(
                    fileTabIdRef.current,
                    editorRef.current.saveViewState(),
                );
            }
        };
    }, [
        captureEditorStateForInlineReview,
        captureInlineReviewModifiedEditorState,
        isInlineReviewActive,
        persistEditorViewState,
    ]);

    useLayoutEffect(() => {
        restoredEditorViewStateTabIdRef.current = null;
    }, [isInlineReviewActive]);

    useEffect(() => {
        if (isVisible) {
            return;
        }

        flushScheduledEditorViewStatePersist();
    }, [flushScheduledEditorViewStatePersist, isVisible]);

    const getPendingEditorViewStateForTab = useCallback(
        (
            tabId: string,
            viewState: MonacoEditor.ICodeEditorViewState | null,
        ) =>
            viewState ??
            (pendingEditorViewStateTabIdRef.current === tabId
                ? pendingEditorViewStateRef.current
                : null),
        [],
    );

    const restoreEditorViewStateForTab = useCallback(
        (
            editor: MonacoEditor.IStandaloneCodeEditor,
            tabId: string,
            viewState: MonacoEditor.ICodeEditorViewState | null,
        ) => {
            if (restoredEditorViewStateTabIdRef.current === tabId) {
                return;
            }

            if (viewState) {
                restoreEditorViewState(editor, viewState);
            } else {
                editor.layout();
            }

            restoredEditorViewStateTabIdRef.current = tabId;
        },
        [restoreEditorViewState],
    );

    const consumePendingOpenLocation = useCallback(
        (editor: MonacoEditor.IStandaloneCodeEditor): boolean => {
            const pendingOpenLocation = tab.pendingOpenLocation ?? null;
            if (!pendingOpenLocation) {
                return false;
            }

            if (!applyEditorOpenLocation(editor, pendingOpenLocation)) {
                return false;
            }

            restoredEditorViewStateTabIdRef.current = tab.id;
            pendingEditorViewStateTabIdRef.current = tab.id;
            pendingEditorViewStateRef.current = editor.saveViewState();
            updateFilePendingOpenLocation(tab.id, null);
            return true;
        },
        [tab.id, tab.pendingOpenLocation, updateFilePendingOpenLocation],
    );

    useEffect(() => {
        if (!isVisible) {
            return;
        }

        const frameId = window.requestAnimationFrame(() => {
            editorRef.current?.layout();
            diffEditorRef.current?.layout();
        });

        return () => {
            window.cancelAnimationFrame(frameId);
        };
    }, [isVisible, tab.id]);

    useEffect(() => {
        const editor = editorRef.current;
        if (
            !isVisible ||
            !editor ||
            inlineReviewTrackedFile ||
            restoredEditorViewStateTabIdRef.current === tab.id
        ) {
            return;
        }

        if (consumePendingOpenLocation(editor)) {
            return;
        }

        restoreEditorViewStateForTab(
            editor,
            tab.id,
            getPendingEditorViewStateForTab(tab.id, tab.viewState ?? null),
        );
    }, [
        consumePendingOpenLocation,
        getPendingEditorViewStateForTab,
        inlineReviewTrackedFile,
        isVisible,
        restoreEditorViewStateForTab,
        tab.id,
        tab.viewState,
    ]);

    useEffect(() => {
        return () => {
            if (editorRef.current) {
                captureEditorStateForInlineReview(editorRef.current);
                pendingEditorViewStateRef.current =
                    editorRef.current.saveViewState();
            }

            if (diffEditorRef.current) {
                captureInlineReviewModifiedEditorState();
            }

            clearScheduledEditorViewStateRestore();
            flushScheduledEditorViewStatePersist();
        };
    }, [
        captureEditorStateForInlineReview,
        captureInlineReviewModifiedEditorState,
        clearScheduledEditorViewStateRestore,
        flushScheduledEditorViewStatePersist,
    ]);

    useEffect(() => {
        if (
            !isActivePane ||
            !document ||
            document.isBinary ||
            document.isTooLarge
        ) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey)) {
                return;
            }

            const key = event.key.toLowerCase();

            if (key === "s") {
                event.preventDefault();
                void onSave(tab.id);
                return;
            }

            if (!event.altKey) {
                return;
            }

            if (event.code === "Equal" || event.code === "NumpadAdd") {
                event.preventDefault();
                void adjustEditorFontSize("increase");
                return;
            }

            if (event.code === "Minus" || event.code === "NumpadSubtract") {
                event.preventDefault();
                void adjustEditorFontSize("decrease");
                return;
            }

            if (event.code === "Digit0" || event.code === "Numpad0") {
                event.preventDefault();
                void adjustEditorFontSize("reset");
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [
        adjustEditorFontSize,
        document,
        isActivePane,
        onAttachLineFragment,
        onSave,
        tab.id,
        tab.projectId,
        tab.relativePath,
        tab.title,
    ]);

    const clearInlineReviewHoverHideTimer = useCallback(() => {
        if (inlineReviewHoverHideTimerRef.current == null) {
            return;
        }

        window.clearTimeout(inlineReviewHoverHideTimerRef.current);
        inlineReviewHoverHideTimerRef.current = null;
    }, []);

    const scheduleInlineReviewOverlayHide = useCallback(() => {
        clearInlineReviewHoverHideTimer();
        inlineReviewHoverHideTimerRef.current = window.setTimeout(() => {
            if (!inlineReviewOverlayPinnedRef.current) {
                hoveredInlineReviewHunkIdRef.current = null;
                setHoveredInlineReviewHunkState(null);
            }
        }, 80);
    }, [clearInlineReviewHoverHideTimer]);

    const setHoveredInlineReviewOverlayState = useCallback(
        (
            nextState: {
                readonly hunkId: string;
                readonly top: number;
            } | null,
        ) => {
            hoveredInlineReviewHunkIdRef.current = nextState?.hunkId ?? null;
            setHoveredInlineReviewHunkState((previous) => {
                if (
                    previous?.hunkId === nextState?.hunkId &&
                    previous?.top === nextState?.top
                ) {
                    return previous;
                }

                return nextState;
            });
        },
        [],
    );

    const updateInlineReviewOverlayForHunk = useCallback(
        (hunkId: string | null) => {
            if (isInlineReviewFindWidgetVisible) {
                if (!inlineReviewOverlayPinnedRef.current) {
                    setHoveredInlineReviewOverlayState(null);
                }
                return;
            }

            if (!inlineReviewTrackedFile || !hunkId) {
                if (!inlineReviewOverlayPinnedRef.current) {
                    setHoveredInlineReviewOverlayState(null);
                }
                return;
            }

            const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
            const editorDomNode = modifiedEditor?.getDomNode();
            const containerNode = inlineReviewContainerRef.current;
            const hunk = inlineReviewTrackedFile.hunks.find(
                (candidate) => candidate.id === hunkId,
            );

            if (!modifiedEditor || !editorDomNode || !containerNode || !hunk) {
                return;
            }

            const maxLineNumber =
                modifiedEditor.getModel()?.getLineCount() ?? 1;
            const anchorLine = Math.min(
                getSelectedReviewLine(hunk),
                maxLineNumber,
            );
            const visiblePosition = modifiedEditor.getScrolledVisiblePosition({
                column: 1,
                lineNumber: Math.max(anchorLine, 1),
            });
            const top =
                editorDomNode.offsetTop +
                (visiblePosition?.top ??
                    modifiedEditor.getTopForLineNumber(
                        Math.max(anchorLine, 1),
                        true,
                    ) - modifiedEditor.getScrollTop());

            setHoveredInlineReviewOverlayState({ hunkId, top });
        },
        [
            inlineReviewTrackedFile,
            isInlineReviewFindWidgetVisible,
            setHoveredInlineReviewOverlayState,
        ],
    );

    useEffect(() => {
        if (
            !inlineReviewTrackedFile ||
            !inlineReviewHunkActionsEnabled ||
            isInlineReviewFindWidgetVisible
        ) {
            return;
        }

        const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
        if (!modifiedEditor) {
            return;
        }

        const resolveHoveredLineNumber = (
            event: MonacoEditor.IEditorMouseEvent,
        ): number | null => {
            const fallbackTarget = modifiedEditor.getTargetAtClientPoint(
                event.event.posx,
                event.event.posy,
            );
            const candidates = [event.target, fallbackTarget].filter(
                (target): target is NonNullable<typeof target> =>
                    target != null,
            );

            for (const target of candidates) {
                const lineNumber =
                    target.position?.lineNumber ??
                    target.range?.startLineNumber ??
                    target.range?.endLineNumber ??
                    null;

                if (lineNumber != null) {
                    return lineNumber;
                }
            }

            return null;
        };

        const resolveHoveredHunkId = (lineNumber: number | null) => {
            if (lineNumber == null) {
                return null;
            }

            const hoveredHunk =
                inlineReviewTrackedFile.hunks.find((hunk) => {
                    const startLine = getSelectedReviewLine(hunk);
                    const endLine = getReviewHunkVisualEndLine(hunk);

                    return lineNumber >= startLine && lineNumber <= endLine;
                }) ?? null;

            return hoveredHunk?.id ?? null;
        };

        const syncHoveredOverlay = () => {
            updateInlineReviewOverlayForHunk(
                hoveredInlineReviewHunkIdRef.current,
            );
        };

        const mouseMoveDisposable = modifiedEditor.onMouseMove((event) => {
            clearInlineReviewHoverHideTimer();
            updateInlineReviewOverlayForHunk(
                resolveHoveredHunkId(resolveHoveredLineNumber(event)),
            );
        });
        const mouseLeaveDisposable = modifiedEditor.onMouseLeave(() => {
            scheduleInlineReviewOverlayHide();
        });
        const scrollDisposable = modifiedEditor.onDidScrollChange(() => {
            if (hoveredInlineReviewHunkIdRef.current) {
                syncHoveredOverlay();
            }
        });
        const layoutDisposable = modifiedEditor.onDidLayoutChange(() => {
            if (hoveredInlineReviewHunkIdRef.current) {
                syncHoveredOverlay();
            }
        });

        return () => {
            mouseMoveDisposable.dispose();
            mouseLeaveDisposable.dispose();
            scrollDisposable.dispose();
            layoutDisposable.dispose();
            clearInlineReviewHoverHideTimer();
            inlineReviewOverlayPinnedRef.current = false;
            setHoveredInlineReviewOverlayState(null);
        };
    }, [
        clearInlineReviewHoverHideTimer,
        diffEditorMountVersion,
        inlineReviewHunkActionsEnabled,
        isInlineReviewFindWidgetVisible,
        inlineReviewTrackedFile,
        scheduleInlineReviewOverlayHide,
        updateInlineReviewOverlayForHunk,
        setHoveredInlineReviewOverlayState,
    ]);

    const handleEditorBeforeMount = useCallback(() => {
        runtime?.applyMonacoThemeFromDom();
    }, [runtime]);

    useLayoutEffect(() => {
        latestDraftContentRef.current = tab.draftContent;
    }, [tab.draftContent]);

    useLayoutEffect(() => {
        if (
            !document ||
            document.kind === "image" ||
            !canEdit
        ) {
            return;
        }

        const editor = editorRef.current;
        const monaco = editorMonacoRef.current;
        if (!editor || !monaco) {
            return;
        }

        const { model, previousLease } = runWithoutEditorChangeNotification(() =>
            acquireFileEditorModel({
                absolutePath: document.absolutePath,
                language: monacoLanguageId,
                monaco,
                value: latestDraftContentRef.current,
            }),
        );

        if (editor.getModel() !== model) {
            runWithoutEditorChangeNotification(() => {
                editor.setModel(model);
            });
        }
        previousLease?.release();

        if (!isVisible || inlineReviewTrackedFile) {
            return;
        }

        if (consumePendingOpenLocation(editor)) {
            return;
        }

        restoreEditorViewStateForTab(
            editor,
            tab.id,
            getPendingEditorViewStateForTab(tab.id, tab.viewState ?? null),
        );
    }, [
        canEdit,
        acquireFileEditorModel,
        consumePendingOpenLocation,
        document,
        getPendingEditorViewStateForTab,
        inlineReviewTrackedFile,
        isVisible,
        monacoLanguageId,
        restoreEditorViewStateForTab,
        runWithoutEditorChangeNotification,
        tab.id,
        tab.viewState,
    ]);

    useEffect(() => {
        if (!runtime || !document || document.kind === "image") {
            return;
        }

        void runtime.applyProjectTypeScriptConfigForPath(document.absolutePath);
    }, [
        document,
        runtime,
    ]);

    useEffect(() => {
        if (!runtime || !document || document.kind === "image" || !canEdit) {
            return;
        }

        void runtime.ensureMonacoTextMateForLanguage(monacoLanguageId);
    }, [
        canEdit,
        document,
        monacoLanguageId,
        runtime,
    ]);

    const clearInlineReviewScrollRestore = useCallback(() => {
        if (inlineReviewScrollRestoreFrameRef.current == null) {
            return;
        }

        window.cancelAnimationFrame(inlineReviewScrollRestoreFrameRef.current);
        inlineReviewScrollRestoreFrameRef.current = null;
    }, []);

    const restorePortableInlineReviewState = useCallback(
        (
            diffEditor: MonacoEditor.IStandaloneDiffEditor,
            state: PortableEditorRestoreState,
        ) => {
            const applyState = () => {
                const originalEditor = diffEditor.getOriginalEditor();
                const modifiedEditor = diffEditor.getModifiedEditor();
                const model = modifiedEditor.getModel();
                if (!model) {
                    return;
                }

                const lineNumber = Math.min(
                    Math.max(state.lineNumber, 1),
                    model.getLineCount(),
                );
                const column = Math.min(
                    Math.max(state.column, 1),
                    model.getLineMaxColumn(lineNumber),
                );

                diffEditor.layout();
                originalEditor.setScrollLeft(state.scrollLeft);
                originalEditor.setScrollTop(state.scrollTop);
                modifiedEditor.setPosition({ lineNumber, column });
                modifiedEditor.setScrollLeft(state.scrollLeft);
                modifiedEditor.setScrollTop(state.scrollTop);
                inlineReviewScrollStateRef.current =
                    captureDiffEditorScrollState(diffEditor);
            };

            clearInlineReviewScrollRestore();
            applyState();
            inlineReviewScrollRestoreFrameRef.current =
                window.requestAnimationFrame(() => {
                    inlineReviewScrollRestoreFrameRef.current = null;

                    if (diffEditorRef.current !== diffEditor) {
                        return;
                    }

                    applyState();
                });
        },
        [clearInlineReviewScrollRestore],
    );

    const restoreInlineReviewScrollState = useCallback(
        (
            diffEditor: MonacoEditor.IStandaloneDiffEditor,
            scrollState: ReturnType<typeof captureDiffEditorScrollState>,
        ) => {
            clearInlineReviewScrollRestore();

            const applyScrollState = () => {
                const originalEditor = diffEditor.getOriginalEditor();
                const modifiedEditor = diffEditor.getModifiedEditor();

                diffEditor.layout();
                originalEditor.setScrollLeft(scrollState.originalScrollLeft);
                originalEditor.setScrollTop(scrollState.originalScrollTop);
                modifiedEditor.setScrollLeft(scrollState.modifiedScrollLeft);
                modifiedEditor.setScrollTop(scrollState.modifiedScrollTop);
                inlineReviewScrollStateRef.current =
                    captureDiffEditorScrollState(diffEditor);
            };

            applyScrollState();
            inlineReviewScrollRestoreFrameRef.current =
                window.requestAnimationFrame(() => {
                    inlineReviewScrollRestoreFrameRef.current = null;

                    if (diffEditorRef.current !== diffEditor) {
                        return;
                    }

                    applyScrollState();
                });
        },
        [clearInlineReviewScrollRestore],
    );

    const restoreInlineReviewViewState = useCallback(
        (
            diffEditor: MonacoEditor.IStandaloneDiffEditor,
            viewState: MonacoEditor.ICodeEditorViewState,
        ) => {
            clearInlineReviewScrollRestore();

            const applyViewState = () => {
                const originalEditor = diffEditor.getOriginalEditor();
                const modifiedEditor = diffEditor.getModifiedEditor();

                try {
                    modifiedEditor.restoreViewState(viewState);
                } catch (error) {
                    if (!isMonacoCancellationError(error)) {
                        throw error;
                    }
                }

                diffEditor.layout();

                const restoredState =
                    capturePortableEditorRestoreState(modifiedEditor);
                if (restoredState) {
                    originalEditor.setScrollLeft(restoredState.scrollLeft);
                    originalEditor.setScrollTop(restoredState.scrollTop);
                }

                inlineReviewScrollStateRef.current =
                    captureDiffEditorScrollState(diffEditor);
            };

            applyViewState();
            inlineReviewScrollRestoreFrameRef.current =
                window.requestAnimationFrame(() => {
                    inlineReviewScrollRestoreFrameRef.current = null;

                    if (diffEditorRef.current !== diffEditor) {
                        return;
                    }

                    applyViewState();
                });
        },
        [clearInlineReviewScrollRestore],
    );

    const consumePendingInlineReviewOpenLocation = useCallback(
        (diffEditor: MonacoEditor.IStandaloneDiffEditor): boolean => {
            const pendingOpenLocation = tab.pendingOpenLocation ?? null;
            if (!pendingOpenLocation) {
                return false;
            }

            if (!applyInlineReviewOpenLocation(diffEditor, pendingOpenLocation)) {
                return false;
            }

            pendingEditorViewStateTabIdRef.current = tab.id;
            pendingEditorViewStateRef.current = diffEditor
                .getModifiedEditor()
                .saveViewState();
            inlineReviewScrollStateRef.current =
                captureDiffEditorScrollState(diffEditor);
            updateFilePendingOpenLocation(tab.id, null);
            return true;
        },
        [tab.id, tab.pendingOpenLocation, updateFilePendingOpenLocation],
    );

    const applyInlineReviewModels = useCallback(
        (trackedFile: AiTrackedFile | null) => {
            if (
                !document ||
                !trackedFile ||
                !inlineReviewModelRevision ||
                !diffEditorRef.current ||
                !inlineReviewMonacoRef.current
            ) {
                return;
            }

            const diffEditor = diffEditorRef.current;
            const installedModels = diffEditor.getModel();
            const currentReviewModels = inlineReviewCurrentModelsRef.current;
            if (
                currentReviewModels.revision ===
                    inlineReviewModelRevision &&
                currentReviewModels.original &&
                currentReviewModels.modified &&
                !currentReviewModels.original.isDisposed() &&
                !currentReviewModels.modified.isDisposed() &&
                installedModels?.original === currentReviewModels.original &&
                installedModels?.modified === currentReviewModels.modified
            ) {
                consumePendingInlineReviewOpenLocation(diffEditor);
                return;
            }

            const monaco = inlineReviewMonacoRef.current;
            const previousModels = diffEditor.getModel();
            const currentInlineReviewRestoreState =
                currentReviewModels.revision && previousModels?.modified
                    ? capturePortableEditorRestoreState(
                          diffEditor.getModifiedEditor(),
                      )
                    : null;
            const scrollState = inlineReviewScrollStateRef.current;
            const persistedInlineReviewViewState =
                tab.viewState ?? pendingEditorViewStateRef.current;
            const nextOriginalModel = getOrCreateMonacoTextModel({
                language: monacoLanguageId,
                modelPath: buildWorkspaceEditorModelPath(
                    document.absolutePath,
                    tab.id,
                    "review-original",
                    inlineReviewModelRevision,
                ),
                monaco,
                value: trackedFile.oldText ?? "",
            });
            const nextModifiedModel = getOrCreateMonacoTextModel({
                language: monacoLanguageId,
                modelPath: buildWorkspaceEditorModelPath(
                    document.absolutePath,
                    tab.id,
                    "review-modified",
                    inlineReviewModelRevision,
                ),
                monaco,
                value: trackedFile.newText ?? "",
            });

            const pendingInlineReviewRestoreState =
                pendingEditorInlineReviewRestoreStateRef.current;
            const pendingInlineReviewRestoreResolution =
                resolvePendingEditorInlineReviewRestoreState({
                    pendingState: pendingInlineReviewRestoreState,
                    reviewSignature,
                    tabId: tab.id,
                });
            if (pendingInlineReviewRestoreResolution.shouldClear) {
                pendingEditorInlineReviewRestoreStateRef.current = null;
            }

            try {
                inlineReviewDecorationsRef.current?.clear();
                diffEditor.setModel({
                    modified: nextModifiedModel,
                    original: nextOriginalModel,
                });
                inlineReviewCurrentModelsRef.current = {
                    modified: nextModifiedModel,
                    original: nextOriginalModel,
                    revision: inlineReviewModelRevision,
                };
                inlineReviewOwnedModelsRef.current = {
                    modified: nextModifiedModel,
                    original: nextOriginalModel,
                };
                const restoreCandidate = resolveInlineReviewRestoreCandidate({
                    currentInlineReviewRestoreState,
                    didConsumePendingOpenLocation:
                        consumePendingInlineReviewOpenLocation(diffEditor),
                    pendingEditorInlineReviewRestoreState:
                        pendingInlineReviewRestoreResolution.state,
                    persistedInlineReviewViewState,
                    scrollState,
                });

                switch (restoreCandidate.kind) {
                    case "openLocation":
                        // Explicit file reference navigation wins over review view state.
                        break;
                    case "currentInlineReviewState":
                        restorePortableInlineReviewState(
                            diffEditor,
                            restoreCandidate.state,
                        );
                        break;
                    case "portableEditorState":
                        restorePortableInlineReviewState(
                            diffEditor,
                            restoreCandidate.state,
                        );
                        if (
                            pendingEditorInlineReviewRestoreStateRef.current ===
                            pendingInlineReviewRestoreState
                        ) {
                            pendingEditorInlineReviewRestoreStateRef.current =
                                null;
                        }
                        break;
                    case "viewState":
                        restoreInlineReviewViewState(
                            diffEditor,
                            restoreCandidate.state,
                        );
                        pendingEditorViewStateRef.current =
                            restoreCandidate.state;
                        break;
                    case "diffScrollState":
                        restoreInlineReviewScrollState(
                            diffEditor,
                            restoreCandidate.state,
                        );
                        break;
                }
            } catch (error) {
                if (!isMonacoDisposedError(error)) {
                    throw error;
                }

                return;
            }

            if (
                previousModels?.original &&
                previousModels.original !== nextOriginalModel
            ) {
                previousModels.original.dispose();
            }

            if (
                previousModels?.modified &&
                previousModels.modified !== nextModifiedModel
            ) {
                previousModels.modified.dispose();
            }
        },
        [
            document,
            inlineReviewModelRevision,
            monacoLanguageId,
            consumePendingInlineReviewOpenLocation,
            restoreInlineReviewScrollState,
            restoreInlineReviewViewState,
            restorePortableInlineReviewState,
            reviewSignature,
            tab.id,
            tab.viewState,
        ],
    );

    useEffect(() => {
        if (
            !document ||
            document.kind === "image" ||
            !canEdit ||
            !shouldShowGitGutter
        ) {
            return scheduleEffectStateUpdate(() => {
                setGitGutterDiffState({
                    base: null,
                    diff: null,
                    key: gitGutterDiffRequestKey,
                });
            });
        }

        const controller = new AbortController();

        const loadGitDiff = async () => {
            try {
                const comandoApi = window.comando;
                if (!comandoApi) {
                    throw new Error("The desktop bridge is not available yet.");
                }

                const diffInput = {
                    path: tab.relativePath,
                    projectId: tab.projectId,
                    worktreeId: tab.worktreeId ?? null,
                };
                const [diff, base] = await Promise.all([
                    comandoApi.getGitDiff(diffInput),
                    comandoApi.getGitOriginalFile(diffInput),
                ]);

                if (!controller.signal.aborted) {
                    setGitGutterDiffState({
                        base,
                        diff,
                        key: gitGutterDiffRequestKey,
                    });
                }
            } catch {
                if (!controller.signal.aborted) {
                    setGitGutterDiffState({
                        base: null,
                        diff: null,
                        key: gitGutterDiffRequestKey,
                    });
                }
            }
        };

        void loadGitDiff();

        return () => {
            controller.abort();
        };
    }, [
        activeGitChangeSignature,
        canEdit,
        document,
        gitGutterDiffRequestKey,
        shouldShowGitGutter,
        tab.projectId,
        tab.relativePath,
        tab.worktreeId,
    ]);

    useEffect(() => {
        const base = gitGutterSource?.base ?? null;
        if (!base?.isText || base.baseText === null) {
            return scheduleEffectStateUpdate(() => {
                setGitGutterLiveDiffState(null);
            });
        }

        const baseText = base.baseText;
        const diffKind =
            gitGutterSource?.diff?.kind ??
            mapGitOriginalFileKindToDiffKind(base.kind);

        const timeout = window.setTimeout(() => {
            const diff = buildLiveGitGutterDiff({
                baseText,
                currentText: tab.draftContent,
                kind: diffKind,
                path: base.path,
                previousPath: base.previousPath,
            });

            if (diff) {
                setGitGutterLiveDiffState({
                    diff,
                    key: gitGutterDiffRequestKey,
                    status: "ready",
                });
                return;
            }

            setGitGutterLiveDiffState({
                key: gitGutterDiffRequestKey,
                status: "unavailable",
            });
        }, GIT_GUTTER_LIVE_DIFF_DEBOUNCE_MS);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [
        gitGutterDiffRequestKey,
        gitGutterSource?.base,
        gitGutterSource?.diff?.kind,
        tab.draftContent,
    ]);

    useLayoutEffect(() => {
        const editor = editorRef.current;
        gitGutterDecoratorRef.current?.dispose();
        gitGutterDecoratorRef.current = null;

        if (!editor) {
            return;
        }

        const decorator = new GitGutterDecorator(editor);
        gitGutterDecoratorRef.current = decorator;

        return () => {
            if (gitGutterDecoratorRef.current === decorator) {
                gitGutterDecoratorRef.current = null;
            }
            decorator.dispose();
        };
    }, [editorMountVersion]);

    useLayoutEffect(() => {
        gitGutterDecoratorRef.current?.setDiff(gitGutterDiff);
    }, [
        documentAbsolutePath,
        editorMountVersion,
        gitGutterDiff,
        tab.id,
    ]);

    useEffect(() => {
        if (
            !document ||
            document.kind === "image" ||
            !canEdit ||
            !tab.isDirty ||
            tab.isSaving ||
            tab.hasExternalChange ||
            tab.saveError !== null
        ) {
            return;
        }

        const timeout = window.setTimeout(() => {
            void onSave(tab.id);
        }, editorSettings.autoSaveDelayMs);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [
        canEdit,
        document,
        editorSettings.autoSaveDelayMs,
        onSave,
        tab.draftContent,
        tab.hasExternalChange,
        tab.id,
        tab.isDirty,
        tab.isSaving,
        tab.saveError,
    ]);

    const editorFontFamily = buildEditorFontFamily(editorSettings.fontFamily);
    const editorLineHeightPx = Math.round(
        editorSettings.fontSize * editorSettings.lineHeight,
    );
    const editorLineNumbers: MonacoEditor.LineNumbersType =
        editorSettings.relativeLineNumbersEnabled ? "relative" : "on";
    const inlineReviewWordWrap =
        document && shouldEnableDocumentWrapping(document) ? "on" : "off";
    const inlineReviewDiffEditorOptions = useMemo(
        () =>
            buildInlineReviewDiffEditorOptions({
                fontFamily: editorFontFamily,
                fontSize: editorSettings.fontSize,
                lineHeight: editorLineHeightPx,
                lineNumbers: editorLineNumbers,
                minimapEnabled: editorSettings.minimapEnabled,
                modifiedLineCount: countTextLines(
                    inlineReviewTrackedFile?.newText ?? "",
                ),
                originalLineCount: countTextLines(
                    inlineReviewTrackedFile?.oldText ?? "",
                ),
                wordWrap: inlineReviewWordWrap,
            }),
        [
            editorFontFamily,
            editorLineHeightPx,
            editorLineNumbers,
            editorSettings.fontSize,
            editorSettings.minimapEnabled,
            inlineReviewTrackedFile?.newText,
            inlineReviewTrackedFile?.oldText,
            inlineReviewWordWrap,
        ],
    );

    useEffect(() => {
        editorVimModeRef.current?.dispose();
        editorVimModeRef.current = null;

        if (
            !editorSettings.vimModeEnabled ||
            isInlineReviewActive ||
            !documentKind ||
            documentKind === "image" ||
            !canEdit
        ) {
            return;
        }

        const editor = editorRef.current;
        if (!editor) {
            return;
        }

        const vimMode = enableMonacoVimMode({
            editor,
            statusNode: editorVimStatusRef.current,
        });
        editorVimModeRef.current = vimMode;

        return () => {
            if (editorVimModeRef.current === vimMode) {
                editorVimModeRef.current = null;
            }
            vimMode.dispose();
        };
    }, [
        canEdit,
        documentKind,
        editorMountVersion,
        editorSettings.vimModeEnabled,
        isInlineReviewActive,
    ]);

    useEffect(() => {
        inlineReviewVimModeRef.current?.dispose();
        inlineReviewVimModeRef.current = null;

        if (
            !editorSettings.vimModeEnabled ||
            !isInlineReviewActive ||
            !canEdit
        ) {
            return;
        }

        const modifiedEditor =
            diffEditorRef.current?.getModifiedEditor() ?? null;
        if (!modifiedEditor) {
            return;
        }

        const vimMode = enableMonacoVimMode({
            editor: modifiedEditor,
            statusNode: inlineReviewVimStatusRef.current,
        });
        inlineReviewVimModeRef.current = vimMode;

        return () => {
            if (inlineReviewVimModeRef.current === vimMode) {
                inlineReviewVimModeRef.current = null;
            }
            vimMode.dispose();
        };
    }, [
        canEdit,
        diffEditorMountVersion,
        editorSettings.vimModeEnabled,
        isInlineReviewActive,
    ]);

    useEffect(() => {
        const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
        if (!modifiedEditor) {
            inlineReviewDecorationsRef.current?.clear();
            inlineReviewDecorationsRef.current = null;
            return;
        }

        const model = modifiedEditor.getModel();
        if (!model || !inlineReviewTrackedFile) {
            inlineReviewDecorationsRef.current?.clear();
            return;
        }

        const collection =
            inlineReviewDecorationsRef.current ??
            modifiedEditor.createDecorationsCollection();
        collection.set(
            buildInlineReviewDecorations(
                inlineReviewTrackedFile.hunks,
                model.getLineCount(),
            ),
        );
        inlineReviewDecorationsRef.current = collection;

        return () => {
            collection.clear();
            if (inlineReviewDecorationsRef.current === collection) {
                inlineReviewDecorationsRef.current = null;
            }
        };
    }, [diffEditorMountVersion, inlineReviewTrackedFile, reviewSignature]);

    useEffect(() => {
        if (!document || document.kind === "image" || !canEdit) {
            return;
        }

        const editor = editorRef.current;
        if (!editor) {
            return;
        }

        editor.updateOptions({
            fontFamily: editorFontFamily,
            fontSize: editorSettings.fontSize,
            lineHeight: editorLineHeightPx,
            lineDecorationsWidth: GIT_GUTTER_LINE_DECORATIONS_WIDTH,
            lineNumbers: editorLineNumbers,
            lineNumbersMinChars: editorLineNumbersMinChars,
            minimap: {
                enabled: editorSettings.minimapEnabled,
            },
            quickSuggestions: areSuggestionsEnabled,
            snippetSuggestions: areSuggestionsEnabled ? "inline" : "none",
            suggest: {
                showColors: areSuggestionsEnabled,
                showFiles: areSuggestionsEnabled,
                showFolders: areSuggestionsEnabled,
                showKeywords: areSuggestionsEnabled,
                showSnippets: areSuggestionsEnabled,
                showWords: areSuggestionsEnabled,
            },
            suggestOnTriggerCharacters: areSuggestionsEnabled,
            ...semanticHighlightingEditorOptions,
            wordBasedSuggestions: areSuggestionsEnabled
                ? "matchingDocuments"
                : "off",
            wordWrap: shouldEnableDocumentWrapping(document) ? "on" : "off",
        });
        editor.layout();
    }, [
        areSuggestionsEnabled,
        canEdit,
        document,
        editorFontFamily,
        editorLineHeightPx,
        editorLineNumbers,
        editorLineNumbersMinChars,
        editorSettings.fontSize,
        editorSettings.minimapEnabled,
    ]);

    useEffect(() => {
        if (!document || document.kind === "image" || !canEdit) {
            return;
        }

        const diffEditor = diffEditorRef.current;
        if (!diffEditor) {
            return;
        }

        const diffOptions = {
            fontFamily: editorFontFamily,
            fontSize: editorSettings.fontSize,
            lineHeight: editorLineHeightPx,
            lineNumbers: editorLineNumbers,
            minimap: {
                enabled: editorSettings.minimapEnabled,
            },
            ...semanticHighlightingEditorOptions,
        } as const;

        diffEditor.updateOptions(diffOptions);
        diffEditor.getOriginalEditor().updateOptions(diffOptions);
        diffEditor.getModifiedEditor().updateOptions(diffOptions);
        diffEditor.layout();
    }, [
        canEdit,
        document,
        editorFontFamily,
        editorLineHeightPx,
        editorLineNumbers,
        editorSettings.fontSize,
        editorSettings.minimapEnabled,
    ]);

    useLayoutEffect(() => {
        if (!isVisible) {
            return;
        }

        applyInlineReviewModels(inlineReviewTrackedFile);
    }, [
        applyInlineReviewModels,
        diffEditorMountVersion,
        inlineReviewTrackedFile,
        isVisible,
    ]);

    useEffect(() => {
        if (inlineReviewTrackedFile) {
            return;
        }

        clearInlineReviewScrollRestore();
        inlineReviewCurrentModelsRef.current = {
            modified: null,
            original: null,
            revision: null,
        };
    }, [clearInlineReviewScrollRestore, inlineReviewTrackedFile]);

    const fileEditorOptions = useMemo(
        (): MonacoEditor.IStandaloneEditorConstructionOptions => ({
            automaticLayout: true,
            fontFamily: editorFontFamily,
            fontLigatures: true,
            fontSize: editorSettings.fontSize,
            glyphMargin: false,
            lineHeight: editorLineHeightPx,
            lineDecorationsWidth: GIT_GUTTER_LINE_DECORATIONS_WIDTH,
            lineNumbers: editorLineNumbers,
            lineNumbersMinChars: editorLineNumbersMinChars,
            ...createComandoEditorFeatureOptions(),
            largeFileOptimizations: true,
            maxTokenizationLineLength: MONACO_MAX_TOKENIZATION_LINE_LENGTH,
            minimap: {
                enabled: editorSettings.minimapEnabled,
            },
            overviewRulerBorder: false,
            overviewRulerLanes: 0,
            padding: { top: 16, bottom: 16 },
            quickSuggestions: areSuggestionsEnabled,
            scrollBeyondLastLine: false,
            snippetSuggestions: areSuggestionsEnabled ? "inline" : "none",
            smoothScrolling: true,
            suggest: {
                showColors: areSuggestionsEnabled,
                showFiles: areSuggestionsEnabled,
                showFolders: areSuggestionsEnabled,
                showKeywords: areSuggestionsEnabled,
                showSnippets: areSuggestionsEnabled,
                showWords: areSuggestionsEnabled,
            },
            suggestOnTriggerCharacters: areSuggestionsEnabled,
            ...semanticHighlightingEditorOptions,
            wordBasedSuggestions: areSuggestionsEnabled
                ? "matchingDocuments"
                : "off",
            wordWrap:
                document && shouldEnableDocumentWrapping(document)
                    ? "on"
                    : "off",
        }),
        [
            areSuggestionsEnabled,
            document,
            editorFontFamily,
            editorLineHeightPx,
            editorLineNumbers,
            editorLineNumbersMinChars,
            editorSettings.fontSize,
            editorSettings.minimapEnabled,
        ],
    );
    const markdownViewMode: MarkdownFileViewMode =
        isMarkdownFile && tab.markdownViewMode === "preview"
            ? "preview"
            : "edit";
    const isMarkdownPreviewVisible =
        isMarkdownFile &&
        markdownViewMode === "preview" &&
        !inlineReviewTrackedFile;
    const handleMarkdownViewModeChange = useCallback(
        (nextMode: MarkdownFileViewMode) => {
            if (!isMarkdownFile) {
                return;
            }

            if (nextMode === "preview") {
                const currentEditorContent =
                    editorRef.current?.getModel()?.getValue() ?? null;
                if (
                    currentEditorContent !== null &&
                    currentEditorContent !== tab.draftContent
                ) {
                    onDraftChange(tab.id, currentEditorContent);
                }
            }

            updateFileMarkdownViewMode(tab.id, nextMode);
        },
        [
            isMarkdownFile,
            onDraftChange,
            tab.draftContent,
            tab.id,
            updateFileMarkdownViewMode,
        ],
    );

    if (!document) {
        return (
            <div className="flex h-full items-center justify-center px-6 text-center">
                <div>
                    <p className="text-sm font-medium text-text-primary">
                        {tab.title}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                        {tab.isLoading
                            ? "Loading file content..."
                            : (tab.loadError ??
                              "This file could not be restored.")}
                    </p>
                </div>
            </div>
        );
    }

    if (document.kind === "image") {
        return (
            <ImageFileView
                displayPath={documentDisplayPath}
                document={document}
            />
        );
    }

    if (!canEdit) {
        return (
            <div className="flex h-full min-h-0 flex-col">
                <FilePathBar
                    path={documentDisplayPath ?? document.relativePath}
                    titlePath={document.absolutePath}
                />
                <div className="flex h-full items-center justify-center px-6 text-center">
                    <div>
                        <div className="text-sm font-medium text-text-primary">
                            {document.name}
                        </div>
                        <p className="mt-2 max-w-lg text-sm leading-6 text-text-secondary">
                            {document.content}
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    if (!runtime) {
        return (
            <DeferredSurfaceState
                actionLabel={monacoLoadError ? "Retry editor load" : undefined}
                onAction={monacoLoadError ? retryMonacoLoad : undefined}
                path={documentDisplayPath ?? document.relativePath}
                statusLabel={
                    monacoLoadError ? "Editor unavailable" : "Loading editor..."
                }
                titlePath={document.absolutePath}
                title={
                    monacoLoadError
                        ? "Could not load the editor"
                        : "Preparing editor..."
                }
            >
                {monacoLoadError
                    ? monacoLoadError
                    : "Monaco is loading on demand for this tab."}
            </DeferredSurfaceState>
        );
    }

    const DiffEditorComponent = runtime.DiffEditor;
    const EditorComponent = runtime.Editor;
    const inlineReviewFileActions =
        inlineReviewTrackedFile?.reviewState === "pending" ? (
            <>
                <button
                    className="review-action-btn"
                    onClick={handleRejectInlineReviewFile}
                    style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--diff-remove)",
                        cursor: "pointer",
                        fontSize: "11px",
                        fontWeight: 600,
                        opacity: 0.7,
                        padding: "4px 6px",
                    }}
                    type="button"
                >
                    ✕ reject all
                </button>
                <button
                    className="review-action-btn"
                    onClick={handleKeepInlineReviewFile}
                    style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--diff-add)",
                        cursor: "pointer",
                        fontSize: "11px",
                        fontWeight: 600,
                        opacity: 0.7,
                        padding: "4px 6px",
                    }}
                    type="button"
                >
                    ✓ keep all
                </button>
            </>
        ) : null;
    const markdownPreviewActions = isMarkdownFile ? (
        <MarkdownViewModeSwitch
            mode={markdownViewMode}
            onChange={handleMarkdownViewModeChange}
        />
    ) : null;
    const filePathBarActions =
        markdownPreviewActions || inlineReviewFileActions ? (
            <>
                {markdownPreviewActions}
                {inlineReviewFileActions}
            </>
        ) : null;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <FilePathBar
                actions={filePathBarActions}
                path={documentDisplayPath ?? document.relativePath}
                statusLabel={
                    tab.isSaving
                        ? "Saving..."
                        : tab.isDirty
                          ? "Unsaved changes"
                          : "Saved"
                }
                titlePath={document.absolutePath}
            />

            {tab.hasExternalChange ? (
                <FileSyncNotice
                    actions={
                        <>
                            <button
                                className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-text-primary transition hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={tab.isSaving}
                                onClick={() => void onReload(tab.id)}
                                type="button"
                            >
                                Reload from disk
                            </button>
                            <button
                                className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={tab.isSaving}
                                onClick={() =>
                                    void onSave(tab.id, { force: true })
                                }
                                type="button"
                            >
                                Overwrite disk
                            </button>
                        </>
                    }
                    tone="danger"
                >
                    {tab.saveError ??
                        "This file changed on disk while you had unsaved edits."}
                </FileSyncNotice>
            ) : tab.saveError ? (
                <FileSyncNotice
                    actions={
                        <button
                            className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-text-primary transition hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={tab.isSaving}
                            onClick={() => void onSave(tab.id)}
                            type="button"
                        >
                            Retry save
                        </button>
                    }
                    tone="warning"
                >
                    {tab.saveError}
                </FileSyncNotice>
            ) : null}
            <div className="relative min-h-0 flex-1">
                {inlineReviewTrackedFile ? (
                    <div
                        className="inline-review-diff relative h-full"
                        ref={inlineReviewContainerRef}
                    >
                        <DiffEditorComponent
                            beforeMount={handleEditorBeforeMount}
                            key={inlineReviewDiffEditorKey}
                            language={monacoLanguageId}
                            modified=""
                            modifiedModelPath={
                                inlineReviewShellModelPaths?.modified ?? undefined
                            }
                            keepCurrentModifiedModel
                            keepCurrentOriginalModel
                            onMount={(
                                editor: MonacoEditor.IStandaloneDiffEditor,
                                monaco: MonacoNamespace,
                            ) => {
                                recordProbeLifecycleEvent(
                                    "WorkspaceInlineReviewDiffEditor",
                                    "mount",
                                    {
                                        language: monacoLanguageId,
                                        path: tab.relativePath,
                                        tabId: tab.id,
                                    },
                                );
                                diffEditorRef.current = editor;
                                void runtime?.ensureMonacoTextMateForLanguage(
                                    monacoLanguageId,
                                );
                                inlineReviewMonacoRef.current = monaco;
                                inlineReviewOwnedModelsRef.current = {
                                    modified:
                                        editor.getModel()?.modified ?? null,
                                    original:
                                        editor.getModel()?.original ?? null,
                                };
                                const originalEditor =
                                    editor.getOriginalEditor();
                                const modifiedEditor =
                                    editor.getModifiedEditor();
                                const editorFeatureOptions =
                                    createComandoEditorFeatureOptions();
                                originalEditor.updateOptions({
                                    ...editorFeatureOptions,
                                    largeFileOptimizations: true,
                                    maxTokenizationLineLength:
                                        MONACO_MAX_TOKENIZATION_LINE_LENGTH,
                                });
                                modifiedEditor.updateOptions({
                                    ...editorFeatureOptions,
                                    largeFileOptimizations: true,
                                    maxTokenizationLineLength:
                                        MONACO_MAX_TOKENIZATION_LINE_LENGTH,
                                });
                                const cleanupOriginalTokenDebug =
                                    runtime?.installMonacoTokenDebugAction(
                                        originalEditor,
                                    ) ?? null;
                                const cleanupModifiedTokenDebug =
                                    runtime?.installMonacoTokenDebugAction(
                                        modifiedEditor,
                                    ) ?? null;
                                const syncInlineReviewScrollState = () => {
                                    inlineReviewScrollStateRef.current =
                                        captureDiffEditorScrollState(editor);
                                };
                                const persistInlineReviewViewState = () => {
                                    syncInlineReviewScrollState();
                                    captureInlineReviewModifiedEditorState();
                                    scheduleEditorViewStatePersist(
                                        modifiedEditor,
                                    );
                                };
                                const cleanupAttachShortcut =
                                    bindInlineReviewAttachSelectionShortcut({
                                        diffEditor: editor,
                                        inputRef:
                                            inlineReviewAttachSelectionShortcutInputRef,
                                    });
                                const cleanupFindWidgetEscape =
                                    bindCloseFindWidgetOnEscape(modifiedEditor);
                                const findController =
                                    getFindController(modifiedEditor);
                                const syncFindWidgetVisibility = () => {
                                    setIsInlineReviewFindWidgetVisible(
                                        Boolean(
                                            findController?.getState?.()
                                                .isRevealed,
                                        ),
                                    );
                                };
                                const findStateListener =
                                    findController
                                        ?.getState?.()
                                        .onFindReplaceStateChange?.(
                                            syncFindWidgetVisibility,
                                        ) ?? null;
                                const modifiedScrollListener =
                                    modifiedEditor.onDidScrollChange(
                                        persistInlineReviewViewState,
                                    );
                                const originalScrollListener =
                                    originalEditor.onDidScrollChange(
                                        persistInlineReviewViewState,
                                    );
                                const modifiedCursorListener =
                                    modifiedEditor.onDidChangeCursorSelection(
                                        persistInlineReviewViewState,
                                    );
                                const modifiedHiddenAreasListener =
                                    modifiedEditor.onDidChangeHiddenAreas(
                                        persistInlineReviewViewState,
                                    );
                                syncInlineReviewScrollState();
                                syncFindWidgetVisibility();
                                applyInlineReviewModels(inlineReviewTrackedFile);

                                editor.onDidDispose(() => {
                                    try {
                                        captureInlineReviewModifiedEditorState();
                                    } catch (error) {
                                        if (!isMonacoDisposedError(error)) {
                                            throw error;
                                        }
                                    }
                                    recordProbeLifecycleEvent(
                                        "WorkspaceInlineReviewDiffEditor",
                                        "dispose",
                                        {
                                            language: monacoLanguageId,
                                            path: tab.relativePath,
                                            tabId: tab.id,
                                        },
                                    );
                                    const ownedModels =
                                        inlineReviewOwnedModelsRef.current;
                                    cleanupOriginalTokenDebug?.dispose();
                                    cleanupModifiedTokenDebug?.dispose();
                                    cleanupAttachShortcut?.();
                                    cleanupFindWidgetEscape?.();
                                    findStateListener?.dispose();
                                    modifiedScrollListener.dispose();
                                    originalScrollListener.dispose();
                                    modifiedCursorListener.dispose();
                                    modifiedHiddenAreasListener.dispose();
                                    clearInlineReviewScrollRestore();
                                    diffEditorRef.current = null;
                                    inlineReviewMonacoRef.current = null;
                                    inlineReviewDecorationsRef.current = null;
                                    inlineReviewCurrentModelsRef.current = {
                                        modified: null,
                                        original: null,
                                        revision: null,
                                    };
                                    inlineReviewOwnedModelsRef.current = {
                                        modified: null,
                                        original: null,
                                    };
                                    setIsInlineReviewFindWidgetVisible(false);
                                    disposeInlineReviewModels(ownedModels);
                                });
                                setDiffEditorMountVersion(
                                    (previous) => previous + 1,
                                );
                            }}
                            options={inlineReviewDiffEditorOptions}
                            original=""
                            originalModelPath={
                                inlineReviewShellModelPaths?.original ?? undefined
                            }
                            theme={editorTheme}
                        />
                        {editorSettings.vimModeEnabled ? (
                            <div
                                aria-live="polite"
                                className="comando-vim-status"
                                ref={inlineReviewVimStatusRef}
                            />
                        ) : null}
                        {inlineReviewHunkActionsEnabled &&
                        !isInlineReviewFindWidgetVisible &&
                        hoveredInlineReviewHunk &&
                        hoveredInlineReviewHunkState ? (
                            <InlineReviewHunkZone
                                onAccept={() => {
                                    captureInlineReviewModifiedEditorState();
                                    void keepTrackedFileHunks(
                                        createReviewHunkMutationInput(
                                            inlineReviewTrackedFile,
                                            [hoveredInlineReviewHunk.id],
                                        ),
                                    );
                                }}
                                onMouseEnter={() => {
                                    clearInlineReviewHoverHideTimer();
                                    inlineReviewOverlayPinnedRef.current = true;
                                }}
                                onMouseLeave={() => {
                                    inlineReviewOverlayPinnedRef.current = false;
                                    scheduleInlineReviewOverlayHide();
                                }}
                                onReject={() => {
                                    captureInlineReviewModifiedEditorState();
                                    void rejectTrackedFileHunks(
                                        createReviewHunkMutationInput(
                                            inlineReviewTrackedFile,
                                            [hoveredInlineReviewHunk.id],
                                        ),
                                    );
                                }}
                                top={hoveredInlineReviewHunkState.top}
                            />
                        ) : null}
                    </div>
                ) : null}
                {isMarkdownPreviewVisible ? (
                    <MarkdownPreviewScrollSurface
                        onScrollTopChange={updateFileMarkdownPreviewScrollTop}
                        scrollTop={tab.markdownPreviewScrollTop ?? 0}
                        tabId={tab.id}
                    >
                        <MarkdownFilePreview
                            content={tab.draftContent}
                            filePath={document.relativePath}
                            fontFamily={editorFontFamily}
                            fontSize={editorSettings.fontSize}
                        />
                    </MarkdownPreviewScrollSurface>
                ) : null}
                <div
                    aria-hidden={isMarkdownPreviewVisible}
                    className={
                        inlineReviewTrackedFile || isMarkdownPreviewVisible
                            ? "hidden"
                            : "relative h-full"
                    }
                >
                    <EditorComponent
                        beforeMount={handleEditorBeforeMount}
                        defaultValue={tab.draftContent}
                        language={monacoLanguageId}
                        onChange={(value: string | undefined) => {
                            if (
                                suppressEditorChangeRef.current ||
                                inlineReviewTrackedFile
                            ) {
                                return;
                            }

                            onDraftChange(tab.id, value ?? "");
                        }}
                        onMount={(
                            editor: MonacoEditor.IStandaloneCodeEditor,
                            monaco: MonacoNamespace,
                        ) => {
                            recordProbeLifecycleEvent(
                                "WorkspaceMonacoEditor",
                                "mount",
                                {
                                    language: monacoLanguageId,
                                    path: tab.relativePath,
                                    tabId: tab.id,
                                },
                            );
                            editorRef.current = editor;
                            editorMonacoRef.current = monaco;
                            const { model, previousLease } =
                                runWithoutEditorChangeNotification(
                                    () =>
                                        acquireFileEditorModel({
                                            absolutePath: document.absolutePath,
                                            language: monacoLanguageId,
                                            monaco,
                                            value: tab.draftContent,
                                        }),
                                );
                            if (editor.getModel() !== model) {
                                runWithoutEditorChangeNotification(() => {
                                    editor.setModel(model);
                                });
                            }
                            previousLease?.release();
                            void runtime?.ensureMonacoTextMateForLanguage(
                                monacoLanguageId,
                            );
                            editorAttachSelectionShortcutInputRef.current =
                                buildEditorAttachSelectionShortcutInput();
                            const cleanupTokenDebug =
                                runtime?.installMonacoTokenDebugAction(editor) ??
                                null;
                            const pendingInlineReviewRestoreState =
                                pendingInlineReviewRestoreStateRef.current
                                    ?.tabId === tab.id
                                    ? pendingInlineReviewRestoreStateRef.current
                                          .state
                                    : null;
                            if (pendingInlineReviewRestoreState) {
                                restorePortableEditorState(
                                    editor,
                                    pendingInlineReviewRestoreState,
                                );
                                pendingInlineReviewRestoreStateRef.current =
                                    null;
                            } else if (
                                !inlineReviewTrackedFile &&
                                consumePendingOpenLocation(editor)
                            ) {
                                // The explicit location intent wins over saved view state.
                            } else {
                                const persistedViewState =
                                    getPendingEditorViewStateForTab(
                                        tab.id,
                                        tab.viewState ?? null,
                                    );
                                if (persistedViewState) {
                                    restoreEditorViewStateForTab(
                                        editor,
                                        tab.id,
                                        persistedViewState,
                                    );
                                    pendingEditorViewStateRef.current =
                                        persistedViewState;
                                }
                            }
                            const cleanupAttachShortcut =
                                bindAttachSelectionShortcutWithInputRef({
                                    editor,
                                    inputRef:
                                        editorAttachSelectionShortcutInputRef,
                                });
                            const cleanupMarkdownListShortcut =
                                bindMarkdownListEditingShortcutsWithLanguageRef({
                                    documentLanguageIdRef:
                                        editorMarkdownLanguageIdRef,
                                    editor,
                                });
                            const scrollListener = editor.onDidScrollChange(
                                () => {
                                    captureEditorStateForInlineReview(editor);
                                    scheduleEditorViewStatePersist(editor);
                                },
                            );
                            const cursorListener =
                                editor.onDidChangeCursorSelection(() => {
                                    captureEditorStateForInlineReview(editor);
                                    scheduleEditorViewStatePersist(editor);
                                });
                            const hiddenAreasListener =
                                editor.onDidChangeHiddenAreas(() => {
                                    captureEditorStateForInlineReview(editor);
                                    scheduleEditorViewStatePersist(editor);
                                });
                            setEditorMountVersion((previous) => previous + 1);

                            editor.onDidDispose(() => {
                                recordProbeLifecycleEvent(
                                    "WorkspaceMonacoEditor",
                                    "dispose",
                                    {
                                        language: monacoLanguageId,
                                        path: tab.relativePath,
                                        tabId: tab.id,
                                    },
                                );
                                clearScheduledEditorViewStateRestore();
                                const workspaceFileModelLease =
                                    workspaceFileModelLeaseRef.current;
                                workspaceFileModelLeaseRef.current = null;
                                // Do not call editor.saveViewState() here. The
                                // editor can already be tearing down, so keep
                                // the valid state captured during cleanup.
                                flushScheduledEditorViewStatePersist();
                                editorRef.current = null;
                                editorMonacoRef.current = null;
                                gitGutterDecoratorRef.current?.dispose();
                                gitGutterDecoratorRef.current = null;
                                cleanupTokenDebug?.dispose();
                                scrollListener.dispose();
                                cursorListener.dispose();
                                hiddenAreasListener.dispose();
                                cleanupAttachShortcut?.();
                                cleanupMarkdownListShortcut?.();
                                workspaceFileModelLease?.release();
                                setEditorMountVersion(
                                    (previous) => previous + 1,
                                );
                            });
                        }}
                        keepCurrentModel
                        options={fileEditorOptions}
                        saveViewState
                        path={buildWorkspaceFileEditorModelPath(
                            document.absolutePath,
                        )}
                        theme={editorTheme}
                    />
                    {editorSettings.vimModeEnabled ? (
                        <div
                            aria-live="polite"
                            className="comando-vim-status"
                            ref={editorVimStatusRef}
                        />
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function useMonacoSurfaceRuntime(enabled: boolean): {
    readonly loadError: string | null;
    readonly retryLoad: () => void;
    readonly runtime: MonacoSurfaceRuntime | null;
} {
    const [runtime, setRuntime] = useState<MonacoSurfaceRuntime | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loadVersion, setLoadVersion] = useState(0);

    useEffect(() => {
        if (!enabled || runtime) {
            return;
        }

        let cancelled = false;
        queueMicrotask(() => {
            if (!cancelled) {
                setLoadError(null);
            }
        });

        void Promise.all([
            import("@monaco-editor/react"),
            import("@renderer/app/editor/monaco"),
        ])
            .then(([monacoReact, monacoTheme]) => {
                if (cancelled) {
                    return;
                }

                setRuntime({
                    DiffEditor: monacoReact.DiffEditor,
                    Editor: monacoReact.default,
                    applyMonacoThemeFromDom:
                        monacoTheme.applyMonacoThemeFromDom,
                    applyProjectTypeScriptConfigForPath:
                        monacoTheme.applyProjectTypeScriptConfigForPath,
                    ensureMonacoTextMateForLanguage:
                        monacoTheme.ensureMonacoTextMateForLanguage,
                    installMonacoTokenDebugAction:
                        monacoTheme.installMonacoTokenDebugAction,
                });
            })
            .catch((error) => {
                console.error(error);
                if (cancelled) {
                    return;
                }

                setLoadError(
                    error instanceof Error
                        ? error.message
                        : "The editor bundle could not be loaded.",
                );
            });

        return () => {
            cancelled = true;
        };
    }, [enabled, loadVersion, runtime]);

    const retryLoad = useCallback(() => {
        setRuntime(null);
        setLoadError(null);
        setLoadVersion((current) => current + 1);
    }, []);

    return {
        loadError,
        retryLoad,
        runtime,
    };
}

function DeferredSurfaceState({
    actionLabel,
    children,
    onAction,
    path,
    statusLabel,
    titlePath,
    title,
}: {
    readonly actionLabel?: string;
    readonly children: ReactNode;
    readonly onAction?: () => void;
    readonly path?: string;
    readonly statusLabel?: string;
    readonly titlePath?: string;
    readonly title: string;
}) {
    return (
        <div className="flex h-full min-h-0 flex-col">
            {path ? (
                <FilePathBar
                    path={path}
                    statusLabel={statusLabel}
                    titlePath={titlePath}
                />
            ) : null}
            <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="max-w-lg">
                    <div className="text-sm font-medium text-text-primary">
                        {title}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                        {children}
                    </p>
                    {actionLabel && onAction ? (
                        <button
                            className="mt-4 rounded-md border border-border px-3 py-1.5 text-[11px] font-medium text-text-primary transition hover:bg-bg-secondary"
                            onClick={onAction}
                            type="button"
                        >
                            {actionLabel}
                        </button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function FilePathBar({
    actions,
    path,
    statusLabel,
    titlePath,
}: {
    readonly actions?: ReactNode;
    readonly path: string;
    readonly statusLabel?: string;
    readonly titlePath?: string;
}) {
    return (
        <div
            className="flex h-6 items-center justify-between gap-3 px-3 text-[10.5px] leading-none text-text-secondary"
            style={{
                backgroundColor: "var(--color-bg-secondary)",
                borderBottom:
                    "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                fontFamily: "var(--font-mono)",
            }}
        >
            <div className="min-w-0 truncate" title={titlePath ?? path}>
                {path}
            </div>
            {actions || statusLabel ? (
                <div className="ml-auto flex shrink-0 items-center gap-3">
                    {actions ? (
                        <div className="flex items-center gap-1.5">
                            {actions}
                        </div>
                    ) : null}
                    {statusLabel ? (
                        <div
                            className="shrink-0"
                            style={{
                                fontSize: "10px",
                                fontWeight: 600,
                                letterSpacing: "0.06em",
                                textTransform: "uppercase",
                            }}
                        >
                            {statusLabel}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function FileSyncNotice({
    actions,
    children,
    tone,
}: {
    readonly actions?: ReactNode;
    readonly children: ReactNode;
    readonly tone: "danger" | "warning";
}) {
    const toneClassName =
        tone === "danger"
            ? "border-[color-mix(in_srgb,var(--diff-remove)_30%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_10%,transparent)] text-[var(--diff-remove)]"
            : "border-[color-mix(in_srgb,var(--diff-warn)_30%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-warn)_10%,transparent)] text-[var(--diff-warn)]";

    return (
        <div
            className={[
                "flex items-center justify-between gap-3 border-b px-3 py-2",
                toneClassName,
            ].join(" ")}
        >
            <p className="text-[11px] leading-5">{children}</p>
            {actions ? (
                <div className="flex shrink-0 gap-2">{actions}</div>
            ) : null}
        </div>
    );
}

const IMAGE_ZOOM_MIN = 0.1;
const IMAGE_ZOOM_MAX = 10;
const IMAGE_ZOOM_SENSITIVITY = 0.005;

function ImageFileView({
    displayPath,
    document,
}: {
    readonly displayPath: string | null;
    readonly document: ProjectFileDocument;
}) {
    const imageSrc = buildImageDataUrl(document);
    const [scale, setScale] = useState(1);
    const [translate, setTranslate] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const isDraggingRef = useRef(false);
    const lastPointer = useRef({ x: 0, y: 0 });
    const containerRef = useRef<HTMLDivElement>(null);

    const isZoomed = scale !== 1;

    const resetView = useCallback(() => {
        setScale(1);
        setTranslate({ x: 0, y: 0 });
    }, []);

    // Reset view when document changes
    useEffect(() => {
        return scheduleEffectStateUpdate(resetView);
    }, [document.absolutePath, resetView]);

    // Attach a non-passive wheel listener so preventDefault() works.
    // React's onWheel is passive and cannot cancel the native zoom.
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const onWheel = (event: WheelEvent) => {
            // Pinch-to-zoom on trackpad fires wheel events with ctrlKey.
            // Ctrl+mouse-wheel also sets ctrlKey. Handle both the same way.
            if (!event.ctrlKey) return;

            event.preventDefault();
            event.stopPropagation();

            const rect = container.getBoundingClientRect();
            // Cursor position relative to the container center
            const cursorX = event.clientX - rect.left - rect.width / 2;
            const cursorY = event.clientY - rect.top - rect.height / 2;

            setScale((prev) => {
                const delta = -event.deltaY * IMAGE_ZOOM_SENSITIVITY;
                const next = Math.min(
                    IMAGE_ZOOM_MAX,
                    Math.max(IMAGE_ZOOM_MIN, prev * (1 + delta)),
                );
                // Adjust translation so the zoom is anchored to the cursor
                const ratio = next / prev;
                setTranslate((t) => ({
                    x: cursorX - ratio * (cursorX - t.x),
                    y: cursorY - ratio * (cursorY - t.y),
                }));
                return next;
            });
        };

        container.addEventListener("wheel", onWheel, { passive: false });
        return () => container.removeEventListener("wheel", onWheel);
    }, []);

    const handlePointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!isZoomed) return;
            isDraggingRef.current = true;
            setIsDragging(true);
            lastPointer.current = { x: event.clientX, y: event.clientY };
            (event.currentTarget as HTMLElement).setPointerCapture(
                event.pointerId,
            );
        },
        [isZoomed],
    );

    const handlePointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!isDraggingRef.current) return;
            const dx = event.clientX - lastPointer.current.x;
            const dy = event.clientY - lastPointer.current.y;
            lastPointer.current = { x: event.clientX, y: event.clientY };
            setTranslate((t) => ({ x: t.x + dx, y: t.y + dy }));
        },
        [],
    );

    const handlePointerUp = useCallback(() => {
        isDraggingRef.current = false;
        setIsDragging(false);
    }, []);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <FilePathBar
                path={displayPath ?? document.relativePath}
                titlePath={document.absolutePath}
            />
            <div
                ref={containerRef}
                className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-bg-primary px-6 py-6"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                style={{ cursor: isZoomed ? "grab" : undefined }}
            >
                {imageSrc ? (
                    <img
                        alt={document.name}
                        className="rounded-xl border border-border bg-white/40 object-contain shadow-[0_12px_40px_rgba(15,23,42,0.12)]"
                        draggable={false}
                        onDoubleClick={resetView}
                        src={imageSrc}
                        style={{
                            maxHeight: scale === 1 ? "100%" : undefined,
                            maxWidth: scale === 1 ? "100%" : undefined,
                            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
                            transformOrigin: "center center",
                            transition: isDragging
                                ? undefined
                                : "transform 0.1s ease-out",
                        }}
                    />
                ) : (
                    <div className="max-w-lg text-center">
                        <div className="text-sm font-medium text-text-primary">
                            {document.name}
                        </div>
                        <p className="mt-2 text-sm leading-6 text-text-secondary">
                            {document.content}
                        </p>
                    </div>
                )}
                {isZoomed && (
                    <div
                        className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md px-2 py-0.5 text-[10px] font-medium tabular-nums text-text-secondary"
                        style={{
                            backdropFilter: "blur(6px)",
                            backgroundColor:
                                "color-mix(in srgb, var(--color-bg-primary) 72%, transparent)",
                            border: "1px solid var(--color-border)",
                            pointerEvents: "none",
                        }}
                    >
                        {Math.round(scale * 100)}% — double-click to reset
                    </div>
                )}
            </div>
        </div>
    );
}

function InlineReviewHunkZone({
    onAccept,
    onMouseEnter,
    onMouseLeave,
    onReject,
    top,
}: {
    readonly onAccept: () => void;
    readonly onMouseEnter: () => void;
    readonly onMouseLeave: () => void;
    readonly onReject: () => void;
    readonly top: number;
}) {
    return (
        <div
            className="pointer-events-none absolute right-4 z-3 flex justify-end"
            style={{
                top: Math.max(top, 4),
            }}
        >
            <div
                className="inline-flex items-center gap-1 rounded"
                onMouseEnter={onMouseEnter}
                onMouseLeave={onMouseLeave}
                style={{
                    backdropFilter: "blur(8px)",
                    backgroundColor:
                        "color-mix(in srgb, var(--color-bg-primary) 78%, var(--color-bg-secondary))",
                    border: "1px solid color-mix(in srgb, var(--color-border) 82%, transparent)",
                    borderRadius: 6,
                    boxShadow: "0 6px 16px rgb(0 0 0 / 0.12)",
                    fontFamily: "var(--font-mono)",
                    padding: 3,
                    pointerEvents: "auto",
                }}
            >
                <button
                    className="review-action-btn"
                    onClick={(event) => {
                        event.stopPropagation();
                        onReject();
                    }}
                    style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--diff-remove)",
                        cursor: "pointer",
                        fontSize: "10px",
                        fontWeight: 600,
                        opacity: 0.7,
                        padding: "2px 6px",
                    }}
                    type="button"
                >
                    ✕ reject
                </button>
                <button
                    className="review-action-btn"
                    onClick={(event) => {
                        event.stopPropagation();
                        onAccept();
                    }}
                    style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--diff-add)",
                        cursor: "pointer",
                        fontSize: "10px",
                        fontWeight: 600,
                        opacity: 0.7,
                        padding: "2px 6px",
                    }}
                    type="button"
                >
                    ✓ keep
                </button>
            </div>
        </div>
    );
}

function TabIcon({
    kind,
    runtimeId,
    title,
}: {
    readonly kind:
        | "chat"
        | "chat_history"
        | "file"
        | "git"
        | "git_commit"
        | "git_worktree_diff"
        | "github_issue"
        | "github_issues"
        | "github_pull_request"
        | "github_pull_requests"
        | "review"
        | "terminal";
    readonly runtimeId?: AiRuntimeId;
    readonly title?: string;
}) {
    if ((kind === "chat" || kind === "review") && runtimeId) {
        return <ProviderIcon runtimeId={runtimeId} size={12} />;
    }

    if (kind === "terminal") {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="none"
                height={12}
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 16 16"
                width={12}
            >
                <path d="M4.5 5.5 7 8l-2.5 2.5" strokeWidth="1.2" />
                <path d="M8.5 10.5h3" strokeWidth="1.2" />
            </svg>
        );
    }

    if (kind === "git" || kind === "git_worktree_diff") {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="none"
                height={12}
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 16 16"
                width={12}
            >
                <path
                    d="M5.1 2.9 2.9 5.1a1 1 0 0 0 0 1.4l5.6 5.6a1 1 0 0 0 1.4 0l2.2-2.2a1 1 0 0 0 0-1.4L6.5 2.9a1 1 0 0 0-1.4 0Z"
                    strokeWidth="1.1"
                />
                <circle
                    cx="5"
                    cy="5"
                    r="0.85"
                    fill="currentColor"
                    stroke="none"
                />
                <path d="M7.2 7.2 10.6 10.6" strokeWidth="1" />
                <path d="M8.8 5.6 10.4 7.2" strokeWidth="1" />
            </svg>
        );
    }

    if (kind === "chat_history") {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="none"
                height={12}
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 16 16"
                width={12}
            >
                <path d="M8 3.1v4.1l2.7 1.6" strokeWidth="1.2" />
                <circle cx="8" cy="8" r="4.9" strokeWidth="1.1" />
            </svg>
        );
    }

    if (kind === "git_commit") {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="none"
                height={12}
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 16 16"
                width={12}
            >
                <circle cx="4" cy="4" r="1.2" strokeWidth="1.1" />
                <circle cx="12" cy="4" r="1.2" strokeWidth="1.1" />
                <circle cx="8" cy="12" r="1.2" strokeWidth="1.1" />
                <path d="M5.2 4h5.6" strokeWidth="1.1" />
                <path d="M4.9 5.1 7.1 10.9" strokeWidth="1.1" />
                <path d="M11.1 5.1 8.9 10.9" strokeWidth="1.1" />
            </svg>
        );
    }

    if (isWorkspaceGitHubTabKind(kind)) {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="none"
                height={12}
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 16 16"
                width={12}
            >
                <circle cx="8" cy="8" r="5.1" strokeWidth="1.1" />
                <path d="M5.5 10.7c.7.5 1.5.8 2.5.8s1.8-.3 2.5-.8" strokeWidth="1" />
                <path d="M5.8 6.6h.01M10.2 6.6h.01" strokeWidth="1.7" />
            </svg>
        );
    }

    if (kind === "chat") {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="none"
                height={12}
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 16 16"
                width={12}
            >
                <path
                    d="M3 3.5h10a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H5l-2.5 2V4a.5.5 0 0 1 .5-.5Z"
                    strokeWidth="1.2"
                />
            </svg>
        );
    }

    if (kind === "review") {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="none"
                height={12}
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 16 16"
                width={12}
            >
                <path
                    d="M5 2.5h6a1 1 0 0 1 1 1V13l-4-2-4 2V3.5a1 1 0 0 1 1-1Z"
                    strokeWidth="1.1"
                />
                <path d="M6.25 5.5h3.5M6.25 7.5h3.5" strokeWidth="1" />
            </svg>
        );
    }

    if (title) {
        return (
            <FileTypeIcon
                className="shrink-0"
                fileName={title}
                opacity={0.55}
                size={12}
            />
        );
    }

    return (
        <svg
            className="shrink-0 opacity-55"
            fill="none"
            height={12}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 16 16"
            width={12}
        >
            <path
                d="M4 2.5h5.5l3 3V13a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z"
                strokeWidth="1"
            />
            <path d="M9.5 2.5V5a.5.5 0 0 0 .5.5h2.5" strokeWidth="0.8" />
            <path d="M6 8.5h4M6 10.5h2.5" strokeWidth="0.8" />
        </svg>
    );
}

function WorkspaceTabActivityIndicator({
    tab,
}: {
    readonly tab: RuntimeWorkspaceTab;
}) {
    const sessionId = tab.kind === "chat" ? tab.sessionId : null;
    const localError = useAiStore((state) =>
        sessionId ? (state.sessions[sessionId]?.localError ?? null) : null,
    );
    const status = useAiStore((state) =>
        sessionId
            ? (state.sessions[sessionId]?.snapshot?.status ?? null)
            : null,
    );
    const activityIndicator = useMemo(
        () =>
            resolveWorkspaceChatTabActivityIndicator({
                localError,
                snapshot: status ? { status } : null,
            }),
        [localError, status],
    );

    if (activityIndicator) {
        return (
            <span
                className={[
                    "text-[9px]",
                    activityIndicator.tone === "danger"
                        ? "text-rose-500"
                        : "text-(--diff-warn)",
                ].join(" ")}
                title={activityIndicator.title}
            >
                ●
            </span>
        );
    }

    if ("isDirty" in tab && tab.isDirty) {
        return <span className="text-[9px] text-(--diff-warn)">●</span>;
    }

    return null;
}

function getWorkspaceTabDisplayTitle(tab: RuntimeWorkspaceTab): string {
    if (tab.kind === "git_commit") {
        return tab.commitSha.slice(0, 7);
    }

    if (tab.kind === "chat" || tab.kind === "review") {
        return truncateChatTitle(tab.title, CHAT_TITLE_TAB_MAX_CHARS);
    }

    return tab.title;
}

function findTrackedFileForDocument(
    sessions: ReturnType<typeof useAiStore.getState>["sessions"],
    document: ProjectFileDocument,
    reviewContext: RuntimeWorkspaceFileReviewContext | null,
) {
    return findBestPendingTrackedFile({
        paths: [document.relativePath, document.absolutePath],
        preferInlineReview: true,
        reviewContext,
        trackedFiles: collectPendingTrackedFilesFromSessions(sessions),
    });
}

function areMonacoSuggestionsEnabledForLanguage(
    languageId: string,
    suggestionsEnabled: boolean,
): boolean {
    if (languageId === "markdown") {
        return false;
    }

    return suggestionsEnabled;
}

function getMonacoThemeFromDocument(): ComandoMonacoTheme {
    if (typeof document === "undefined") {
        return "comando-light";
    }

    return document.documentElement.classList.contains("dark")
        ? "comando-dark"
        : "comando-light";
}

function useMonacoTheme(
    runtime: Pick<MonacoSurfaceRuntime, "applyMonacoThemeFromDom"> | null,
): ComandoMonacoTheme {
    const [theme, setTheme] = useState<ComandoMonacoTheme>(() =>
        getMonacoThemeFromDocument(),
    );

    useEffect(() => {
        let frameHandle = 0;

        const updateTheme = () => {
            frameHandle = 0;
            setTheme(
                runtime
                    ? runtime.applyMonacoThemeFromDom()
                    : getMonacoThemeFromDocument(),
            );
        };

        const scheduleThemeUpdate = () => {
            if (frameHandle !== 0) {
                return;
            }

            frameHandle = window.requestAnimationFrame(updateTheme);
        };

        scheduleThemeUpdate();

        const observer = new MutationObserver(scheduleThemeUpdate);
        observer.observe(document.documentElement, {
            attributeFilter: ["class", "style"],
            attributes: true,
        });

        return () => {
            observer.disconnect();
            if (frameHandle !== 0) {
                window.cancelAnimationFrame(frameHandle);
            }
        };
    }, [runtime]);

    return theme;
}

function shouldEnableDocumentWrapping(document: {
    readonly languageId: string;
}): boolean {
    return shouldWrapEditorLanguage(document.languageId);
}

function buildImageDataUrl(document: ProjectFileDocument): string | null {
    if (
        document.kind !== "image" ||
        !document.mimeType ||
        !document.imageDataBase64
    ) {
        return null;
    }

    return `data:${document.mimeType};base64,${document.imageDataBase64}`;
}
