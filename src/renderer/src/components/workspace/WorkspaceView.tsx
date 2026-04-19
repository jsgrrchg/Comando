import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";
import type { editor as MonacoEditor } from "monaco-editor";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
    useCallback,
    useEffect,
    useEffectEvent,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
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
    GitFileDiff,
    ProjectFileDocument,
} from "@shared/ipc";
import {
    resolveEditorLanguage,
    shouldWrapEditorLanguage,
} from "@shared/editor-language";
import {
    COMPOSER_PROJECT_ENTRY_MIME,
    isPointOverComposerDropZone,
    parseComposerProjectEntryDragData,
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
    continueMarkdownList,
    indentMarkdownListItems,
    outdentMarkdownListItems,
} from "@renderer/app/editor/markdownLists";
import { resolveMonacoLanguageId } from "@renderer/app/editor/monacoLanguage";
import { useResolvedEditorSettings } from "@renderer/app/hooks/use-resolved-editor-settings";
import {
    loadAppEditorSettings,
    saveAppEditorSettings,
} from "@renderer/app/settings/client";
import { buildEditorFontFamily } from "@renderer/app/settings/theme";
import { useRenderProbe } from "@renderer/app/debug/renderProbe";
import { useAiStore } from "@renderer/app/store/ai-store";
import { useGitStore } from "@renderer/app/store/git-store";
import {
    getBestMatchingChatTabId,
    useWorkspaceStore,
} from "@renderer/app/store/workspace-store";
import {
    collectPaneNodes,
    findWorkspaceNodeById,
    type RuntimeWorkspaceFileReviewContext,
    type RuntimeWorkspaceFileTab,
    type RuntimeWorkspaceTab,
    type RuntimeWorkspaceTerminalTab,
} from "@renderer/app/workspace/tree";
import {
    collectPendingTrackedFilesFromSessions,
    findBestPendingTrackedFile,
    isInlineReviewSupported,
} from "@renderer/app/workspace/pending-review";
import { ChatHistoryTabView } from "@renderer/components/workspace/ChatHistoryTabView";
import { ChatTabView } from "@renderer/components/workspace/ChatTabView";
import { GitCommitTabView } from "@renderer/components/workspace/GitCommitTabView";
import { GitTabView } from "@renderer/components/workspace/GitTabView";
import { ReviewTabView } from "@renderer/components/workspace/ReviewTabView";
import { persistChatDraftForTab } from "@renderer/components/workspace/chatDraftPersistence";
import {
    buildGitGutterDecorations,
    computeGitGutterMarkers,
    getGitGutterLineNumbersMinChars,
    hasRenderableGitGutterChange,
} from "@renderer/components/workspace/gitGutter";
import { buildInlineReviewDecorations } from "@renderer/components/workspace/inlineReviewDecorations";
import { buildInlineReviewDiffEditorOptions } from "@renderer/components/workspace/inlineReviewDiffEditorOptions";
import { buildWorkspaceEditorModelPath } from "@renderer/components/workspace/editorModelPath";
import { appendSelectionMentionToRegisteredComposer } from "@renderer/components/workspace/chat/composerSelectionBridge";
import { canResolveFileHunks } from "@renderer/components/workspace/review/editedFilesPresentationModel";
import { createDiffFromTrackedFile } from "@renderer/components/workspace/review/reviewDiff";
import { closeWorkspaceTabsWithConfirmation } from "@renderer/components/workspace/workspaceCloseGuard";
import { resolveWorkspaceChatTabActivityIndicator } from "@renderer/components/workspace/workspaceTabActivity";
import {
    createTerminalSurfaceOptions,
    syncTerminalViewport,
} from "@renderer/components/workspace/terminalSurface";
import {
    getReviewHunkVisualEndLine,
    getSelectedReviewLine,
} from "@renderer/components/workspace/review/fileReviewBarPresentation";
import {
    useWorkspaceTabDrag,
    type WorkspaceTabDropTarget,
} from "@renderer/components/workspace/useWorkspaceTabDrag";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "@renderer/components/context-menu/ContextMenu";
import { getViewportSafeMenuPosition } from "@renderer/app/utils/menu-position";
import type { WorkspaceQuickCreateAction } from "@renderer/app/store/workspace-store";

interface WorkspaceViewProps {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
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
    readonly type?: "item";
};

type QuickCreateMenuSeparator = {
    readonly type: "separator";
};

type QuickCreateMenuEntry = QuickCreateMenuItem | QuickCreateMenuSeparator;

type QuickCreateSubmenuState = {
    readonly entries: readonly QuickCreateMenuEntry[];
    readonly x: number;
    readonly y: number;
} | null;

type WorkspaceReviewTabHandle = {
    readonly id: string;
    readonly sessionId: string;
};

type ReviewTabAutoCloseCandidate = {
    readonly hasError: boolean;
    readonly hasPendingTrackedFiles: boolean;
    readonly hydrated: boolean;
    readonly isHydrating: boolean;
    readonly reviewTabId: string;
    readonly sessionId: string;
};

type MonacoSurfaceRuntime = {
    readonly DiffEditor: typeof import("@monaco-editor/react").DiffEditor;
    readonly Editor: typeof import("@monaco-editor/react").default;
    readonly applyMonacoThemeFromDom: typeof import("@renderer/app/editor/monaco").applyMonacoThemeFromDom;
};

type XtermSurfaceRuntime = {
    readonly FitAddon: typeof import("@xterm/addon-fit").FitAddon;
    readonly Terminal: typeof import("@xterm/xterm").Terminal;
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
        .filter((tab) => tab.kind === "review")
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
        candidate.hydrated,
        candidate.isHydrating,
        candidate.hasError,
        candidate.hasPendingTrackedFiles,
    ]);
}

function parseReviewTabAutoCloseCandidateKey(
    key: string,
): ReviewTabAutoCloseCandidate {
    const [
        reviewTabId,
        sessionId,
        hydrated,
        isHydrating,
        hasError,
        hasPendingTrackedFiles,
    ] = JSON.parse(key) as [string, string, boolean, boolean, boolean, boolean];
    return {
        hasError,
        hasPendingTrackedFiles,
        hydrated,
        isHydrating,
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
        const trackedFiles = sessionState?.snapshot?.trackedFiles ?? [];
        const hasPendingTrackedFiles = trackedFiles.some(
            (trackedFile) => trackedFile.reviewState === "pending",
        );

        return createReviewTabAutoCloseCandidateKey({
            hasError: Boolean(
                sessionState?.localError || sessionState?.snapshot?.lastError,
            ),
            hasPendingTrackedFiles,
            hydrated: Boolean(sessionState?.hydrated),
            isHydrating: sessionState?.isHydrating ?? false,
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

export function WorkspaceView({
    defaultProjectId,
    defaultWorktreeId,
    onRequestCreateFile,
}: WorkspaceViewProps) {
    const closeTab = useWorkspaceStore((state) => state.closeTab);
    const dropTabToSplit = useWorkspaceStore((state) => state.dropTabToSplit);
    const moveTabToPane = useWorkspaceStore((state) => state.moveTabToPane);
    const reorderTab = useWorkspaceStore((state) => state.reorderTab);
    const rootNodeId = useWorkspaceStore((state) => state.rootNode.id);
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

    useRenderProbe("WorkspaceView", {});

    useEffect(() => {
        const knownReviewTabIds = new Set(reviewTabs.map((tab) => tab.id));

        for (const tabId of autoClosingReviewTabIdsRef.current) {
            if (!knownReviewTabIds.has(tabId)) {
                autoClosingReviewTabIdsRef.current.delete(tabId);
            }
        }

        for (const candidate of reviewTabAutoCloseCandidates) {
            if (
                !candidate.hydrated ||
                candidate.isHydrating ||
                candidate.hasError ||
                candidate.hasPendingTrackedFiles ||
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

    return (
        <div className="h-full min-h-0 bg-bg-primary">
            <WorkspaceNodeView
                defaultProjectId={defaultProjectId}
                defaultWorktreeId={defaultWorktreeId}
                nodeId={rootNodeId}
                onRequestCreateFile={onRequestCreateFile}
                tabDrag={tabDrag}
            />
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
    nodeId,
    onRequestCreateFile,
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly nodeId: string;
    readonly onRequestCreateFile: () => void;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    const node = useWorkspaceStore(
        useCallback(
            (state: ReturnType<typeof useWorkspaceStore.getState>) =>
                findWorkspaceNodeById(state.rootNode, nodeId),
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
                paneId={node.id}
                onRequestCreateFile={onRequestCreateFile}
                tabDrag={tabDrag}
            />
        );
    }

    return (
        <WorkspaceSplitView
            defaultProjectId={defaultProjectId}
            defaultWorktreeId={defaultWorktreeId}
            splitId={node.id}
            onRequestCreateFile={onRequestCreateFile}
            tabDrag={tabDrag}
        />
    );
}

function WorkspaceSplitView({
    defaultProjectId,
    defaultWorktreeId,
    splitId,
    onRequestCreateFile,
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly splitId: string;
    readonly onRequestCreateFile: () => void;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    const node = useWorkspaceStore(
        useCallback(
            (state: ReturnType<typeof useWorkspaceStore.getState>) => {
                const match = findWorkspaceNodeById(state.rootNode, splitId);
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

    const handlePointerMove = useEffectEvent((event: PointerEvent) => {
        if (!node || !dragState || !containerRef.current) {
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

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointercancel", stopDragging);
        window.addEventListener("pointerup", stopDragging);

        return () => {
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointercancel", stopDragging);
            window.removeEventListener("pointerup", stopDragging);
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
                    handleIndex={index}
                    isLast={index === node.children.length - 1}
                    key={child.id}
                    nodeId={child.id}
                    onRequestCreateFile={onRequestCreateFile}
                    onPointerDown={(event) => {
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
    handleIndex,
    isLast,
    nodeId,
    onRequestCreateFile,
    onPointerDown,
    size,
    tabDrag,
}: {
    readonly axis: "horizontal" | "vertical";
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly handleIndex: number;
    readonly isLast: boolean;
    readonly nodeId: string;
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
                    nodeId={nodeId}
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
    paneId,
    onRequestCreateFile,
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly paneId: string;
    readonly onRequestCreateFile: () => void;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    const node = useWorkspaceStore(
        useCallback(
            (state: ReturnType<typeof useWorkspaceStore.getState>) => {
                const match = findWorkspaceNodeById(state.rootNode, paneId);
                return match?.type === "pane" ? match : null;
            },
            [paneId],
        ),
    );
    const addDraftFileContext = useAiStore((s) => s.addDraftFileContext);
    const attachSelectionMention = useAiStore((s) => s.attachSelectionMention);
    const activePaneId = useWorkspaceStore((state) => state.activePaneId);
    const closeOtherTabs = useWorkspaceStore((state) => state.closeOtherTabs);
    const closePane = useWorkspaceStore((state) => state.closePane);
    const closeTab = useWorkspaceStore((state) => state.closeTab);
    const closeTabsToRight = useWorkspaceStore(
        (state) => state.closeTabsToRight,
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
    const createChatTab = useWorkspaceStore((state) => state.createChatTab);
    const createTerminalTab = useWorkspaceStore(
        (state) => state.createTerminalTab,
    );
    const openChatHistoryTab = useWorkspaceStore(
        (state) => state.openChatHistoryTab,
    );
    const openGitTab = useWorkspaceStore((state) => state.openGitTab);
    const lastQuickCreateAction = useWorkspaceStore(
        (state) => state.lastQuickCreateAction,
    );
    const lastFocusedRuntimeId = useWorkspaceStore(
        (state) => state.lastFocusedRuntimeId,
    );
    const moveTab = useWorkspaceStore((state) => state.moveTab);
    const openFileTab: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        targetPaneId?: string | null,
    ) => Promise<void> = useWorkspaceStore((state) => state.openFileTab);
    const openChatImageTab = useWorkspaceStore((state) => state.openChatImageTab);
    const openReviewTab = useWorkspaceStore((state) => state.openReviewTab);
    const paneCount = useWorkspaceStore(
        (state) => collectPaneNodes(state.rootNode).length,
    );
    const paneNodeId = node?.id ?? paneId;
    const paneTabIds = node?.tabIds ?? EMPTY_TAB_IDS;
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
    const selectTab = useWorkspaceStore((state) => state.selectTab);
    const setActivePane = useWorkspaceStore((state) => state.setActivePane);
    const hasAnyChatTab = useWorkspaceStore((state) =>
        Object.values(state.tabsById).some((tab) => tab.kind === "chat"),
    );
    const updateChatDraft = useWorkspaceStore((state) => state.updateChatDraft);
    const updateFileDraft = useWorkspaceStore((state) => state.updateFileDraft);
    const reloadFileTab = useWorkspaceStore((state) => state.reloadFileTab);
    const saveFileTab = useWorkspaceStore((state) => state.saveFileTab);
    const selectAdjacentTab = useWorkspaceStore(
        (state) => state.selectAdjacentTab,
    );
    const sendTerminalInput = useWorkspaceStore(
        (state) => state.sendTerminalInput,
    );
    const updateTerminalSize = useWorkspaceStore(
        (state) => state.updateTerminalSize,
    );
    const tabStripRef = useRef<HTMLDivElement | null>(null);
    const paneDragCounterRef = useRef(0);
    const [tabContextMenu, setTabContextMenu] =
        useState<ContextMenuState<TabContextMenuPayload> | null>(null);
    const [quickCreateMenu, setQuickCreateMenu] =
        useState<QuickCreateMenuState>(null);
    const [isProjectFileDragOverPane, setIsProjectFileDragOverPane] =
        useState(false);
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
    const isActivePane = activePaneId === paneNodeId;
    const activeTabWorktreeId = activeTab?.worktreeId ?? null;

    useRenderProbe("WorkspacePaneView", {
        activeTabId: activeTab?.id ?? null,
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

    const tabContextMenuEntries: ContextMenuEntry[] = (() => {
        if (!tabContextMenu) {
            return [];
        }

        const tabIndex = paneTabIds.indexOf(tabContextMenu.payload.tabId);
        if (tabIndex === -1) {
            return [];
        }

        const entries: ContextMenuEntry[] = [
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
        void selectTab(paneNodeId, tabId);
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

    const handleOpenWorkspaceFile = useCallback(
        async (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        ) => {
            await openFileTab(
                projectId,
                relativePath,
                worktreeId ?? activeTabWorktreeId,
                reviewContext,
                paneNodeId,
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

    const handleOpenActiveChatReview = useCallback(() => {
        if (!activeChatTab) {
            return Promise.resolve();
        }

        return openReviewTab({
            projectId: activeChatTab.projectId,
            runtimeId: activeChatTab.runtimeId,
            sessionId: activeChatTab.sessionId,
            title: activeChatTab.title,
            worktreeId: activeChatTab.worktreeId ?? null,
        });
    }, [activeChatTab, openReviewTab]);

    const handleOpenChatImage = useCallback(
        async (attachment: AiImageAttachment) => {
            await openChatImageTab({
                attachment,
                targetPaneId: paneNodeId,
            });
        },
        [openChatImageTab, paneNodeId],
    );

    const canAcceptPaneProjectFileDrag = useCallback(
        (event: ReactDragEvent<HTMLElement>) => {
            if (!defaultProjectId) {
                return false;
            }

            if (isPointOverComposerDropZone(event.clientX, event.clientY)) {
                return false;
            }

            return Array.from(event.dataTransfer.types).includes(
                COMPOSER_PROJECT_ENTRY_MIME,
            );
        },
        [defaultProjectId],
    );

    const resetPaneProjectFileDrag = useCallback(() => {
        paneDragCounterRef.current = 0;
        setIsProjectFileDragOverPane(false);
    }, []);

    const handlePaneDragEnter = useCallback(
        (event: ReactDragEvent<HTMLElement>) => {
            if (!canAcceptPaneProjectFileDrag(event)) {
                return;
            }

            event.preventDefault();
            paneDragCounterRef.current += 1;
            if (paneDragCounterRef.current === 1) {
                setIsProjectFileDragOverPane(true);
            }
        },
        [canAcceptPaneProjectFileDrag],
    );

    const handlePaneDragOver = useCallback(
        (event: ReactDragEvent<HTMLElement>) => {
            if (!canAcceptPaneProjectFileDrag(event)) {
                if (isProjectFileDragOverPane) {
                    setIsProjectFileDragOverPane(false);
                }
                return;
            }

            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            if (!isProjectFileDragOverPane) {
                setIsProjectFileDragOverPane(true);
            }
        },
        [canAcceptPaneProjectFileDrag, isProjectFileDragOverPane],
    );

    const handlePaneDragLeave = useCallback(
        (event: ReactDragEvent<HTMLElement>) => {
            if (
                event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
                return;
            }

            resetPaneProjectFileDrag();
        },
        [resetPaneProjectFileDrag],
    );

    const handlePaneDrop = useCallback(
        (event: ReactDragEvent<HTMLElement>) => {
            const isComposerTarget = isPointOverComposerDropZone(
                event.clientX,
                event.clientY,
            );
            resetPaneProjectFileDrag();

            if (isComposerTarget || !defaultProjectId) {
                return;
            }

            const dragData = parseComposerProjectEntryDragData(
                event.dataTransfer.getData(COMPOSER_PROJECT_ENTRY_MIME),
            );
            if (!dragData || dragData.kind !== "file") {
                return;
            }

            event.preventDefault();
            void openFileTab(
                defaultProjectId,
                dragData.relativePath,
                defaultWorktreeId ?? null,
                undefined,
                paneNodeId,
            );
        },
        [
            defaultProjectId,
            defaultWorktreeId,
            openFileTab,
            paneNodeId,
            resetPaneProjectFileDrag,
        ],
    );

    const handleCreateAgentFromFocusedProvider = useCallback(() => {
        void createChatTab(
            defaultProjectId,
            defaultWorktreeId ?? null,
            lastFocusedRuntimeId,
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
                currentState.lastFocusedRuntimeId,
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
            case "gemini":
                void createChatTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                    "gemini",
                );
                return;
            case "kilo":
                void createChatTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
                    "kilo",
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
                children: [
                    {
                        action: () =>
                            void createChatTab(
                                defaultProjectId,
                                defaultWorktreeId ?? null,
                                "codex",
                            ),
                        label: "Codex",
                    },
                    {
                        action: () =>
                            void createChatTab(
                                defaultProjectId,
                                defaultWorktreeId ?? null,
                                "claude",
                            ),
                        label: "Claude",
                    },
                    {
                        action: () =>
                            void createChatTab(
                                defaultProjectId,
                                defaultWorktreeId ?? null,
                                "gemini",
                            ),
                        label: "Gemini",
                    },
                    {
                        action: () =>
                            void createChatTab(
                                defaultProjectId,
                                defaultWorktreeId ?? null,
                                "kilo",
                            ),
                        label: "Kilo",
                    },
                ],
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
            defaultProjectId,
            defaultWorktreeId,
            handleCreateFile,
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
    const paneShortcutHandlersRef = useRef({
        createTerminalTab,
        defaultProjectId,
        defaultWorktreeId,
        handleCreateAgentFromFocusedProvider,
        handleCreateFile,
        openChatHistoryTab,
        openGitTab,
        paneNodeId,
        selectAdjacentTab,
    });
    paneShortcutHandlersRef.current = {
        createTerminalTab,
        defaultProjectId,
        defaultWorktreeId,
        handleCreateAgentFromFocusedProvider,
        handleCreateFile,
        openChatHistoryTab,
        openGitTab,
        paneNodeId,
        selectAdjacentTab,
    };

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
                    handlers.paneNodeId,
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
                onDragEnter={handlePaneDragEnter}
                onDragLeave={handlePaneDragLeave}
                onDragOver={handlePaneDragOver}
                onDrop={handlePaneDrop}
                onMouseDown={() => void setActivePane(paneNodeId)}
                ref={(element) => {
                    tabDrag.setPaneElement(paneNodeId, element);
                }}
            >
                {isProjectFileDragOverPane ? (
                    <div className="pointer-events-none absolute inset-0 z-20 bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]" />
                ) : null}
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
                            <span className="px-2.5 py-1.5 text-[11px] text-text-secondary">
                                Empty pane
                            </span>
                        ) : (
                            paneTabs.map((tab, tabIndex) => {
                                const isActive = tab.id === paneActiveTabId;
                                const tabDisplayTitle =
                                    getWorkspaceTabDisplayTitle(tab);

                                return (
                                    <button
                                        className={[
                                            "group app-no-drag relative flex h-7.75 items-center gap-1.5 border-r border-border-subtle px-3 text-[12px] transition",
                                            tabDrag.draggedTab?.tabId ===
                                                tab.id && tabDrag.isDragging
                                                ? "opacity-35"
                                                : "",
                                            isActive
                                                ? "z-10 bg-bg-primary text-text-primary shadow-[inset_0_-2px_0_0_var(--color-accent)]"
                                                : "z-0 bg-bg-chrome text-text-secondary hover:bg-bg-tertiary hover:text-text-primary",
                                        ].join(" ")}
                                        data-workspace-tab-id={tab.id}
                                        key={tab.id}
                                        onClick={(event) => {
                                            if (tabDrag.handleTabClick(event)) {
                                                return;
                                            }

                                            void selectTab(paneNodeId, tab.id);
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
                                                        tab.kind === "file"
                                                            ? {
                                                                  kind: "file_mention",
                                                                  label: tab.title,
                                                                  relativePath:
                                                                      tab.relativePath,
                                                              }
                                                            : tab.kind ===
                                                                  "git_commit"
                                                              ? {
                                                                    commitSha:
                                                                        tab.commitSha,
                                                                    kind: "git_commit_mention",
                                                                    label: tab.title,
                                                                }
                                                            : null,
                                                    sourceIndex: tabIndex,
                                                    tabId: tab.id,
                                                    title: tabDisplayTitle,
                                                },
                                                event,
                                            )
                                        }
                                        type="button"
                                    >
                                        <TabIcon
                                            kind={tab.kind}
                                            runtimeId={
                                                tab.kind === "chat"
                                                    ? tab.runtimeId
                                                    : undefined
                                            }
                                            title={tabDisplayTitle}
                                        />
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
                                        <span
                                            className={[
                                                "ml-0.5 rounded px-1 text-[13px] transition hover:bg-text-secondary/10 hover:text-text-primary",
                                                isActive
                                                    ? "text-text-secondary opacity-70"
                                                    : "text-text-secondary opacity-0 group-hover:opacity-70",
                                            ].join(" ")}
                                            data-workspace-tab-close="true"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void requestCloseTab(tab.id);
                                            }}
                                            role="button"
                                            tabIndex={-1}
                                        >
                                            ×
                                        </span>
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

                <div className="min-h-0 flex-1 bg-editor">
                    {paneTabs
                        .filter(
                            (tab): tab is RuntimeWorkspaceTerminalTab =>
                                tab.kind === "terminal",
                        )
                        .map((tab) => (
                            <div
                                key={tab.id}
                                className={
                                    tab.id === paneActiveTabId
                                        ? "h-full"
                                        : "hidden"
                                }
                            >
                                <TerminalTabView
                                    onResize={updateTerminalSize}
                                    onSendInput={sendTerminalInput}
                                    tab={tab}
                                />
                            </div>
                        ))}
                    {activeTab ? (
                        activeTab.kind === "file" ? (
                            <FileTabView
                                key={activeTab.id}
                                isActivePane={isActivePane}
                                onAttachLineFragment={handleAttachLineFragment}
                                onDraftChange={updateFileDraft}
                                onReload={reloadFileTab}
                                onSave={saveFileTab}
                                tab={activeTab}
                            />
                        ) : activeTab.kind === "git" ? (
                            <GitTabView tab={activeTab} />
                        ) : activeTab.kind === "chat_history" ? (
                            <ChatHistoryTabView tab={activeTab} />
                        ) : activeTab.kind === "git_commit" ? (
                            <GitCommitTabView tab={activeTab} />
                        ) : activeTab.kind === "review" ? (
                            <ReviewTabView
                                onOpenFile={handleOpenWorkspaceFile}
                                tab={activeTab}
                            />
                        ) : activeTab.kind === "terminal" ? null : (
                            <ChatTabView
                                key={activeTab.id}
                                onDraftChange={handleChatDraftChange}
                                onOpenFile={handleOpenWorkspaceFile}
                                onOpenImage={handleOpenChatImage}
                                onOpenReview={handleOpenActiveChatReview}
                                tab={activeTab}
                            />
                        )
                    ) : (
                        <div className="flex h-full items-center justify-center px-6 text-center">
                            <p className="text-[12px] text-text-secondary">
                                Open a file, start a chat or launch a terminal.
                            </p>
                        </div>
                    )}
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
            {target?.type === "strip" ? (
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

            {target?.type === "pane-center" ? (
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

            {target?.type === "split" ? (
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
            getViewportSafeMenuPosition(
                submenu.x,
                submenu.y,
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
            entries: children,
            x: rect.right + 4,
            y: rect.top,
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
                        left: submenu.x,
                        minWidth: 176,
                        top: submenu.y,
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

function getQuickCreateButtonTitle(
    action: WorkspaceQuickCreateAction,
    hasProject: boolean,
) {
    switch (action) {
        case "claude":
            return "Open last item: Claude chat";
        case "gemini":
            return "Open last item: Gemini chat";
        case "kilo":
            return "Open last item: Kilo chat";
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

function bindAttachSelectionShortcut(input: {
    readonly documentLanguageId: string;
    readonly editor: MonacoEditor.IStandaloneCodeEditor;
    readonly onAttachLineFragment: (input: {
        readonly context: AiFileContextAttachment;
        readonly worktreeId: string | null;
    }) => Promise<void>;
    readonly projectId: string;
    readonly relativePath: string;
    readonly tabTitle: string;
    readonly worktreeId: string | null;
}): (() => void) | null {
    const editorDomNode = input.editor.getDomNode();
    if (!editorDomNode) {
        return null;
    }

    const handleEditorKeyDown = (event: KeyboardEvent) => {
        if (
            event.key.toLowerCase() !== "l" ||
            !(event.metaKey || event.ctrlKey) ||
            event.altKey ||
            event.shiftKey
        ) {
            return;
        }

        // Intercept in capture so Monaco doesn't expand line selection
        // before we can attach the current selection.
        const attached = tryAttachEditorSelectionToComposer({
            documentLanguageId: input.documentLanguageId,
            editor: input.editor,
            onAttachLineFragment: input.onAttachLineFragment,
            projectId: input.projectId,
            relativePath: input.relativePath,
            tabTitle: input.tabTitle,
            worktreeId: input.worktreeId,
        });

        if (!attached) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    };

    editorDomNode.addEventListener("keydown", handleEditorKeyDown, true);

    return () => {
        editorDomNode.removeEventListener("keydown", handleEditorKeyDown, true);
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

function bindMarkdownListEditingShortcuts(input: {
    readonly documentLanguageId: string;
    readonly editor: MonacoEditor.IStandaloneCodeEditor;
}): (() => void) | null {
    if (input.documentLanguageId !== "markdown") {
        return null;
    }

    const editorDomNode = input.editor.getDomNode();
    if (!editorDomNode) {
        return null;
    }

    const handleEditorKeyDown = (event: KeyboardEvent) => {
        if (
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.isComposing
        ) {
            return;
        }

        const model = input.editor.getModel();
        const selections = input.editor.getSelections();
        const selection = input.editor.getSelection();
        if (!model || !selection || (selections?.length ?? 0) > 1) {
            return;
        }

        const text = model.getValue();
        const tabSize = model.getOptions().tabSize;
        const selectionStartOffset = model.getOffsetAt(
            selection.getStartPosition(),
        );
        const selectionEndOffset = model.getOffsetAt(
            selection.getEndPosition(),
        );
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

        input.editor.pushUndoStop();
        input.editor.executeEdits("markdown-list-continuation", [
            {
                forceMoveMarkers: true,
                range: model.getFullModelRange(),
                text: result.text,
            },
        ]);

        const nextModel = input.editor.getModel();
        if (!nextModel) {
            return;
        }

        input.editor.setSelection({
            endColumn: nextModel.getPositionAt(result.selectionEnd).column,
            endLineNumber: nextModel.getPositionAt(result.selectionEnd)
                .lineNumber,
            startColumn: nextModel.getPositionAt(result.selectionStart).column,
            startLineNumber: nextModel.getPositionAt(result.selectionStart)
                .lineNumber,
        });
        input.editor.pushUndoStop();
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

function FileTabView({
    isActivePane,
    onAttachLineFragment,
    onDraftChange,
    onReload,
    onSave,
    tab,
}: {
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
    readonly tab: RuntimeWorkspaceFileTab;
}) {
    const document = tab.document;
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
        () => resolveMonacoLanguageId(document?.languageId ?? ""),
        [document?.languageId],
    );
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
    const rejectTrackedFileHunks = useAiStore(
        (state) => state.rejectTrackedFileHunks,
    );
    const updateFileViewState = useWorkspaceStore(
        (state) => state.updateFileViewState,
    );
    const diffEditorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(
        null,
    );
    const inlineReviewContainerRef = useRef<HTMLDivElement | null>(null);
    const inlineReviewOverlayPinnedRef = useRef(false);
    const inlineReviewHoverHideTimerRef = useRef<number | null>(null);
    const hoveredInlineReviewHunkIdRef = useRef<string | null>(null);
    const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
    const inlineReviewMonacoRef = useRef<MonacoNamespace | null>(null);
    const inlineReviewCurrentModelsRef = useRef<{
        readonly modified: MonacoEditor.ITextModel | null;
        readonly original: MonacoEditor.ITextModel | null;
        readonly revision: string | null;
    }>({
        modified: null,
        original: null,
        revision: null,
    });
    const inlineReviewScrollRestoreFrameRef = useRef<number | null>(null);
    const inlineReviewScrollStateRef = useRef<
        ReturnType<typeof captureDiffEditorScrollState>
    >(captureDiffEditorScrollState(null));
    const fileTabIdRef = useRef(tab.id);
    const gitGutterDecorationsRef =
        useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
    const inlineReviewDecorationsRef =
        useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
    const pendingEditorViewStateRef =
        useRef<MonacoEditor.ICodeEditorViewState | null>(tab.viewState ?? null);
    const pendingEditorViewStateTabIdRef = useRef(tab.id);
    const viewStatePersistTimerRef = useRef<number | null>(null);
    const viewStateRestoreFrameRef = useRef<number | null>(null);
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
    const documentLanguageId = document?.languageId ?? "plaintext";
    const gitSnapshot = useGitStore((state) => {
        const contextKey = `${tab.projectId}::${tab.worktreeId ?? "primary"}`;
        return state.snapshots[contextKey] ?? null;
    });
    const activeGitChange = useMemo(
        () =>
            gitSnapshot?.changes.find(
                (change) => change.path === tab.relativePath,
            ) ?? null,
        [gitSnapshot?.changes, tab.relativePath],
    );
    const [gitGutterDiff, setGitGutterDiff] = useState<GitFileDiff | null>(
        null,
    );
    const shouldShowGitGutter = hasRenderableGitGutterChange(activeGitChange);
    const gitGutterLineNumbersMinChars = useMemo(
        () => getGitGutterLineNumbersMinChars(countTextLines(tab.draftContent)),
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
    const reviewSignature = useMemo(
        () => getInlineReviewSignature(inlineReviewTrackedFile),
        [inlineReviewTrackedFile],
    );
    const inlineReviewModelRevision = useMemo(
        () => getInlineReviewModelRevision(inlineReviewTrackedFile),
        [inlineReviewTrackedFile],
    );
    const inlineReviewShellModelPaths = useMemo(() => {
        if (!document) {
            return null;
        }

        return {
            modified: buildWorkspaceEditorModelPath(
                document.absolutePath,
                tab.id,
                "review-modified",
                "shell",
            ),
            original: buildWorkspaceEditorModelPath(
                document.absolutePath,
                tab.id,
                "review-original",
                "shell",
            ),
        };
    }, [
        document?.absolutePath,
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
        if (viewStatePersistTimerRef.current != null) {
            window.clearTimeout(viewStatePersistTimerRef.current);
            viewStatePersistTimerRef.current = null;
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
            editor.restoreViewState(viewState);
            editor.layout();

            // Re-apply after the first paint because Monaco can recompute
            // layout/model state right after mount and override the scroll.
            viewStateRestoreFrameRef.current = window.requestAnimationFrame(
                () => {
                    viewStateRestoreFrameRef.current = null;

                    if (editorRef.current !== editor) {
                        return;
                    }

                    editor.restoreViewState(viewState);
                    editor.layout();
                },
            );
        },
        [clearScheduledEditorViewStateRestore],
    );

    const scheduleEditorViewStatePersist = useCallback(
        (editor: MonacoEditor.IStandaloneCodeEditor) => {
            const tabId = fileTabIdRef.current;
            pendingEditorViewStateRef.current = editor.saveViewState();
            pendingEditorViewStateTabIdRef.current = tabId;
            if (viewStatePersistTimerRef.current != null) {
                return;
            }

            viewStatePersistTimerRef.current = window.setTimeout(() => {
                viewStatePersistTimerRef.current = null;
                persistEditorViewState(
                    tabId,
                    pendingEditorViewStateRef.current,
                );
            }, 120);
        },
        [persistEditorViewState],
    );

    useEffect(() => {
        fileTabIdRef.current = tab.id;
    }, [tab.id]);

    useEffect(() => {
        pendingEditorViewStateRef.current = tab.viewState ?? null;
        pendingEditorViewStateTabIdRef.current = tab.id;
    }, [tab.id, tab.viewState]);

    useEffect(() => {
        return () => {
            if (editorRef.current) {
                pendingEditorViewStateRef.current =
                    editorRef.current.saveViewState();
            }

            clearScheduledEditorViewStateRestore();
            flushScheduledEditorViewStatePersist();
        };
    }, [
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

    const clearInlineReviewScrollRestore = useCallback(() => {
        if (inlineReviewScrollRestoreFrameRef.current == null) {
            return;
        }

        window.cancelAnimationFrame(inlineReviewScrollRestoreFrameRef.current);
        inlineReviewScrollRestoreFrameRef.current = null;
    }, []);

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

            if (
                inlineReviewCurrentModelsRef.current.revision ===
                inlineReviewModelRevision
            ) {
                return;
            }

            const diffEditor = diffEditorRef.current;
            const monaco = inlineReviewMonacoRef.current;
            const previousModels = diffEditor.getModel();
            const scrollState = inlineReviewScrollStateRef.current;
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
            restoreInlineReviewScrollState(diffEditor, scrollState);

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
            restoreInlineReviewScrollState,
            tab.id,
        ],
    );

    useEffect(() => {
        if (
            !document ||
            document.kind === "image" ||
            !canEdit ||
            !shouldShowGitGutter
        ) {
            setGitGutterDiff(null);
            return;
        }

        const controller = new AbortController();

        const loadGitDiff = async () => {
            try {
                const comandoApi = window.comando;
                if (!comandoApi) {
                    throw new Error("The desktop bridge is not available yet.");
                }

                const diff = await comandoApi.getGitDiff({
                    path: tab.relativePath,
                    projectId: tab.projectId,
                    worktreeId: tab.worktreeId ?? null,
                });

                if (!controller.signal.aborted) {
                    setGitGutterDiff(diff);
                }
            } catch {
                if (!controller.signal.aborted) {
                    setGitGutterDiff(null);
                }
            }
        };

        void loadGitDiff();

        return () => {
            controller.abort();
        };
    }, [
        activeGitChange,
        canEdit,
        document,
        shouldShowGitGutter,
        tab.projectId,
        tab.relativePath,
        tab.worktreeId,
    ]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) {
            gitGutterDecorationsRef.current?.clear();
            gitGutterDecorationsRef.current = null;
            return;
        }

        const model = editor.getModel();
        if (!model) {
            gitGutterDecorationsRef.current?.clear();
            gitGutterDecorationsRef.current = null;
            return;
        }

        const collection =
            gitGutterDecorationsRef.current ??
            editor.createDecorationsCollection();

        collection.set(
            gitGutterDiff
                ? buildGitGutterDecorations(
                      computeGitGutterMarkers(
                          gitGutterDiff,
                          model.getLineCount(),
                      ),
                  )
                : [],
        );
        gitGutterDecorationsRef.current = collection;
    }, [editorMountVersion, gitGutterDiff]);

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
    const inlineReviewWordWrap =
        document && shouldEnableDocumentWrapping(document) ? "on" : "off";
    const inlineReviewDiffEditorOptions = useMemo(
        () =>
            buildInlineReviewDiffEditorOptions({
                fontFamily: editorFontFamily,
                fontSize: editorSettings.fontSize,
                lineHeight: editorLineHeightPx,
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
            editorSettings.fontSize,
            editorSettings.minimapEnabled,
            inlineReviewTrackedFile?.newText,
            inlineReviewTrackedFile?.oldText,
            inlineReviewWordWrap,
        ],
    );

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
        });
        editor.layout();
    }, [
        areSuggestionsEnabled,
        canEdit,
        document,
        editorFontFamily,
        editorLineHeightPx,
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
        editorSettings.fontSize,
        editorSettings.minimapEnabled,
    ]);

    useLayoutEffect(() => {
        applyInlineReviewModels(inlineReviewTrackedFile);
    }, [applyInlineReviewModels, inlineReviewTrackedFile]);

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
        return <ImageFileView document={document} />;
    }

    if (!canEdit) {
        return (
            <div className="flex h-full min-h-0 flex-col">
                <FilePathBar path={document.absolutePath} />
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
                path={document.absolutePath}
                statusLabel={
                    monacoLoadError ? "Editor unavailable" : "Loading editor..."
                }
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

    return (
        <div className="flex h-full min-h-0 flex-col">
            <FilePathBar
                path={document.absolutePath}
                statusLabel={
                    tab.isSaving
                        ? "Saving..."
                        : tab.isDirty
                          ? "Unsaved changes"
                          : "Saved"
                }
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
            <div className="min-h-0 flex-1">
                {inlineReviewTrackedFile ? (
                    <div
                        className="inline-review-diff relative h-full"
                        ref={inlineReviewContainerRef}
                    >
                        <DiffEditorComponent
                            beforeMount={handleEditorBeforeMount}
                            language={monacoLanguageId}
                            modified=""
                            modifiedModelPath={
                                inlineReviewShellModelPaths?.modified ?? undefined
                            }
                            onMount={(editor, monaco) => {
                                diffEditorRef.current = editor;
                                inlineReviewMonacoRef.current = monaco;
                                const originalEditor =
                                    editor.getOriginalEditor();
                                const modifiedEditor =
                                    editor.getModifiedEditor();
                                const syncInlineReviewScrollState = () => {
                                    inlineReviewScrollStateRef.current =
                                        captureDiffEditorScrollState(editor);
                                };
                                const cleanupAttachShortcut =
                                    bindAttachSelectionShortcut({
                                        documentLanguageId: document.languageId,
                                        editor: modifiedEditor,
                                        onAttachLineFragment,
                                        projectId: tab.projectId,
                                        relativePath: tab.relativePath,
                                        tabTitle: tab.title,
                                        worktreeId: tab.worktreeId ?? null,
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
                                        syncInlineReviewScrollState,
                                    );
                                const originalScrollListener =
                                    originalEditor.onDidScrollChange(
                                        syncInlineReviewScrollState,
                                    );

                                syncInlineReviewScrollState();
                                syncFindWidgetVisibility();
                                applyInlineReviewModels(inlineReviewTrackedFile);

                                editor.onDidDispose(() => {
                                    cleanupAttachShortcut?.();
                                    cleanupFindWidgetEscape?.();
                                    findStateListener?.dispose();
                                    modifiedScrollListener.dispose();
                                    originalScrollListener.dispose();
                                    clearInlineReviewScrollRestore();
                                    diffEditorRef.current = null;
                                    inlineReviewMonacoRef.current = null;
                                    inlineReviewDecorationsRef.current = null;
                                    inlineReviewCurrentModelsRef.current = {
                                        modified: null,
                                        original: null,
                                        revision: null,
                                    };
                                    setIsInlineReviewFindWidgetVisible(false);
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
                        {inlineReviewHunkActionsEnabled &&
                        !isInlineReviewFindWidgetVisible &&
                        hoveredInlineReviewHunk &&
                        hoveredInlineReviewHunkState ? (
                            <InlineReviewHunkZone
                                onAccept={() => {
                                    void keepTrackedFileHunks({
                                        hunkIds: [hoveredInlineReviewHunk.id],
                                        path: inlineReviewTrackedFile.path,
                                        sessionId:
                                            inlineReviewTrackedFile.sessionId,
                                    });
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
                                    void rejectTrackedFileHunks({
                                        hunkIds: [hoveredInlineReviewHunk.id],
                                        path: inlineReviewTrackedFile.path,
                                        sessionId:
                                            inlineReviewTrackedFile.sessionId,
                                    });
                                }}
                                top={hoveredInlineReviewHunkState.top}
                            />
                        ) : null}
                    </div>
                ) : (
                    <EditorComponent
                        beforeMount={handleEditorBeforeMount}
                        language={monacoLanguageId}
                        onChange={(value: string | undefined) =>
                            onDraftChange(tab.id, value ?? "")
                        }
                        onMount={(editor) => {
                            editorRef.current = editor;
                            const persistedViewState =
                                tab.viewState ??
                                pendingEditorViewStateRef.current;
                            if (persistedViewState) {
                                restoreEditorViewState(
                                    editor,
                                    persistedViewState,
                                );
                                pendingEditorViewStateRef.current =
                                    persistedViewState;
                            }
                            const cleanupAttachShortcut =
                                bindAttachSelectionShortcut({
                                    documentLanguageId: document.languageId,
                                    editor,
                                    onAttachLineFragment,
                                    projectId: tab.projectId,
                                    relativePath: tab.relativePath,
                                    tabTitle: tab.title,
                                    worktreeId: tab.worktreeId ?? null,
                                });
                            const cleanupMarkdownListShortcut =
                                bindMarkdownListEditingShortcuts({
                                    documentLanguageId: document.languageId,
                                    editor,
                                });
                            const scrollListener = editor.onDidScrollChange(
                                () => {
                                    scheduleEditorViewStatePersist(editor);
                                },
                            );
                            const cursorListener =
                                editor.onDidChangeCursorSelection(() => {
                                    scheduleEditorViewStatePersist(editor);
                                });
                            const hiddenAreasListener =
                                editor.onDidChangeHiddenAreas(() => {
                                    scheduleEditorViewStatePersist(editor);
                                });
                            setEditorMountVersion((previous) => previous + 1);

                            editor.onDidDispose(() => {
                                clearScheduledEditorViewStateRestore();
                                // Do not call editor.saveViewState() here.
                                // @monaco-editor/react disposes the model
                                // before disposing the editor, so saveViewState
                                // would return null and overwrite the valid
                                // view state captured during unmount cleanup.
                                flushScheduledEditorViewStatePersist();
                                editorRef.current = null;
                                gitGutterDecorationsRef.current = null;
                                scrollListener.dispose();
                                cursorListener.dispose();
                                hiddenAreasListener.dispose();
                                cleanupAttachShortcut?.();
                                cleanupMarkdownListShortcut?.();
                                setEditorMountVersion(
                                    (previous) => previous + 1,
                                );
                            });
                        }}
                        options={{
                            automaticLayout: true,
                            fontFamily: editorFontFamily,
                            fontLigatures: true,
                            fontSize: editorSettings.fontSize,
                            glyphMargin: false,
                            lineHeight: editorLineHeightPx,
                            lineDecorationsWidth: 0,
                            lineNumbersMinChars: shouldShowGitGutter
                                ? gitGutterLineNumbersMinChars
                                : 3,
                            minimap: {
                                enabled: editorSettings.minimapEnabled,
                            },
                            overviewRulerBorder: false,
                            overviewRulerLanes: 0,
                            padding: { top: 16, bottom: 16 },
                            quickSuggestions: areSuggestionsEnabled,
                            scrollBeyondLastLine: false,
                            snippetSuggestions: areSuggestionsEnabled
                                ? "inline"
                                : "none",
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
                            wordWrap: shouldEnableDocumentWrapping(document)
                                ? "on"
                                : "off",
                        }}
                        saveViewState
                        path={buildWorkspaceEditorModelPath(
                            document.absolutePath,
                            tab.id,
                            "editor",
                        )}
                        theme={editorTheme}
                        value={tab.draftContent}
                    />
                )}
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
        setLoadError(null);

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

function useXtermSurfaceRuntime(): {
    readonly loadError: string | null;
    readonly retryLoad: () => void;
    readonly runtime: XtermSurfaceRuntime | null;
} {
    const [runtime, setRuntime] = useState<XtermSurfaceRuntime | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loadVersion, setLoadVersion] = useState(0);

    useEffect(() => {
        if (runtime) {
            return;
        }

        let cancelled = false;
        setLoadError(null);

        void Promise.all([
            import("@xterm/xterm/css/xterm.css"),
            import("@xterm/xterm"),
            import("@xterm/addon-fit"),
        ])
            .then(([, xtermModule, fitAddonModule]) => {
                if (cancelled) {
                    return;
                }

                setRuntime({
                    FitAddon: fitAddonModule.FitAddon,
                    Terminal: xtermModule.Terminal,
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
                        : "The terminal bundle could not be loaded.",
                );
            });

        return () => {
            cancelled = true;
        };
    }, [loadVersion, runtime]);

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
    title,
}: {
    readonly actionLabel?: string;
    readonly children: ReactNode;
    readonly onAction?: () => void;
    readonly path?: string;
    readonly statusLabel?: string;
    readonly title: string;
}) {
    return (
        <div className="flex h-full min-h-0 flex-col">
            {path ? (
                <FilePathBar path={path} statusLabel={statusLabel} />
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
    path,
    statusLabel,
}: {
    readonly path: string;
    readonly statusLabel?: string;
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
            <div className="min-w-0 truncate" title={path}>
                {path}
            </div>
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
    document,
}: {
    readonly document: ProjectFileDocument;
}) {
    const imageSrc = buildImageDataUrl(document);
    const [scale, setScale] = useState(1);
    const [translate, setTranslate] = useState({ x: 0, y: 0 });
    const isDragging = useRef(false);
    const lastPointer = useRef({ x: 0, y: 0 });
    const containerRef = useRef<HTMLDivElement>(null);

    const isZoomed = scale !== 1;

    const resetView = useCallback(() => {
        setScale(1);
        setTranslate({ x: 0, y: 0 });
    }, []);

    // Reset view when document changes
    useEffect(() => {
        resetView();
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
            isDragging.current = true;
            lastPointer.current = { x: event.clientX, y: event.clientY };
            (event.currentTarget as HTMLElement).setPointerCapture(
                event.pointerId,
            );
        },
        [isZoomed],
    );

    const handlePointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!isDragging.current) return;
            const dx = event.clientX - lastPointer.current.x;
            const dy = event.clientY - lastPointer.current.y;
            lastPointer.current = { x: event.clientX, y: event.clientY };
            setTranslate((t) => ({ x: t.x + dx, y: t.y + dy }));
        },
        [],
    );

    const handlePointerUp = useCallback(() => {
        isDragging.current = false;
    }, []);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <FilePathBar path={document.absolutePath} />
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
                            transition: isDragging.current
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

function TerminalTabView({
    onResize,
    onSendInput,
    tab,
}: {
    readonly onResize: (
        sessionId: string,
        cols: number,
        rows: number,
    ) => Promise<void>;
    readonly onSendInput: (sessionId: string, data: string) => Promise<void>;
    readonly tab: RuntimeWorkspaceTerminalTab;
}) {
    const { loadError, retryLoad, runtime } = useXtermSurfaceRuntime();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const writtenLengthRef = useRef(0);
    const queuedLengthRef = useRef(0);
    const lastViewportSizeRef = useRef<{ cols: number; rows: number } | null>(
        null,
    );
    const pendingViewportSyncFrameRef = useRef<number | null>(null);
    const writeChainRef = useRef<Promise<void>>(Promise.resolve());

    const cancelScheduledViewportSync = useEffectEvent(() => {
        if (pendingViewportSyncFrameRef.current === null) {
            return;
        }

        globalThis.cancelAnimationFrame(pendingViewportSyncFrameRef.current);
        pendingViewportSyncFrameRef.current = null;
    });

    const syncViewport = useEffectEvent(() => {
        const fitAddon = fitAddonRef.current;
        const result = syncTerminalViewport({
            container: containerRef.current,
            fit: fitAddon ? () => fitAddon.fit() : null,
            previousSize: lastViewportSizeRef.current,
            terminal: terminalRef.current,
        });

        if (!result.didSync || !result.nextSize) {
            return;
        }

        lastViewportSizeRef.current = result.nextSize;
        if (result.sizeChanged) {
            void onResize(tab.sessionId, result.nextSize.cols, result.nextSize.rows);
        }
    });

    const scheduleViewportSync = useEffectEvent((deferFrames = 0) => {
        cancelScheduledViewportSync();

        const runAfterFrames = (remainingFrames: number) => {
            pendingViewportSyncFrameRef.current =
                globalThis.requestAnimationFrame(() => {
                    if (remainingFrames > 0) {
                        runAfterFrames(remainingFrames - 1);
                        return;
                    }

                    pendingViewportSyncFrameRef.current = null;
                    syncViewport();
                });
        };

        runAfterFrames(deferFrames);
    });

    useEffect(() => {
        if (!runtime || !containerRef.current) {
            return;
        }

        const terminal = new runtime.Terminal(
            createTerminalSurfaceOptions(getTerminalTheme()),
        );
        const fitAddon = new runtime.FitAddon();
        terminal.loadAddon(fitAddon);
        const container = containerRef.current;
        terminal.open(container);

        terminal.onData((data) => {
            void onSendInput(tab.sessionId, data);
        });

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        scheduleViewportSync(1);

        const handleViewportChange = () => {
            scheduleViewportSync();
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState !== "visible") {
                return;
            }

            scheduleViewportSync(1);
        };
        const resizeObserver =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(handleViewportChange);
        resizeObserver?.observe(container);
        globalThis.addEventListener("focus", handleViewportChange);
        globalThis.addEventListener("resize", handleViewportChange);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
            globalThis.removeEventListener("resize", handleViewportChange);
            globalThis.removeEventListener("focus", handleViewportChange);
            resizeObserver?.disconnect();
            cancelScheduledViewportSync();
            terminal.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
            lastViewportSizeRef.current = null;
            queuedLengthRef.current = 0;
            writtenLengthRef.current = 0;
            writeChainRef.current = Promise.resolve();
        };
    }, [onResize, onSendInput, runtime, tab.sessionId]);

    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) {
            return;
        }

        if (tab.output.length < queuedLengthRef.current) {
            terminal.reset();
            queuedLengthRef.current = 0;
            writtenLengthRef.current = 0;
            writeChainRef.current = Promise.resolve();
            scheduleViewportSync(1);
        }

        const nextChunk = tab.output.slice(queuedLengthRef.current);
        if (!nextChunk) {
            return;
        }

        const targetLength = tab.output.length;
        queuedLengthRef.current = targetLength;

        let cancelled = false;
        writeChainRef.current = writeChainRef.current
            .catch(() => undefined)
            .then(
                () =>
                    new Promise<void>((resolve) => {
                        const activeTerminal = terminalRef.current;
                        if (!activeTerminal || cancelled) {
                            resolve();
                            return;
                        }

                        activeTerminal.write(nextChunk, () => {
                            if (!cancelled) {
                                writtenLengthRef.current = Math.max(
                                    writtenLengthRef.current,
                                    targetLength,
                                );
                                scheduleViewportSync();
                            }
                            resolve();
                        });
                    }),
            );

        return () => {
            cancelled = true;
        };
    }, [tab.output]);

    if (!runtime) {
        return (
            <DeferredSurfaceState
                actionLabel={loadError ? "Retry terminal load" : undefined}
                onAction={loadError ? retryLoad : undefined}
                statusLabel={
                    loadError ? "Terminal unavailable" : "Loading terminal..."
                }
                title={
                    loadError
                        ? "Could not load the terminal"
                        : "Preparing terminal..."
                }
            >
                {loadError
                    ? loadError
                    : "xterm is loading on demand for this tab."}
            </DeferredSurfaceState>
        );
    }

    return (
        <div className="terminal-surface h-full min-h-0">
            <div className="h-full w-full px-3 py-2" ref={containerRef} />
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
        | "review"
        | "terminal";
    readonly runtimeId?: AiRuntimeId;
    readonly title?: string;
}) {
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

    if (kind === "git") {
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

    if (kind === "chat") {
        if (runtimeId) {
            return <ChatProviderIcon runtimeId={runtimeId} />;
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

function ChatProviderIcon({ runtimeId }: { readonly runtimeId: AiRuntimeId }) {
    if (runtimeId === "claude") {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="none"
                height={12}
                stroke="currentColor"
                strokeLinecap="round"
                viewBox="0 0 16 16"
                width={12}
            >
                <line strokeWidth="1.35" x1="8" x2="8" y1="2" y2="14" />
                <line strokeWidth="1.35" x1="2" x2="14" y1="8" y2="8" />
                <line strokeWidth="1.35" x1="3.75" x2="12.25" y1="3.75" y2="12.25" />
                <line strokeWidth="1.35" x1="12.25" x2="3.75" y1="3.75" y2="12.25" />
            </svg>
        );
    }

    if (runtimeId === "codex") {
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
                <polygon
                    points="8,2.3 13.4,5.4 13.4,10.6 8,13.7 2.6,10.6 2.6,5.4"
                    strokeWidth="1.1"
                />
                <line strokeWidth="1" x1="8" x2="8" y1="2.3" y2="13.7" />
                <line strokeWidth="1" x1="2.6" x2="13.4" y1="5.4" y2="10.6" />
                <line strokeWidth="1" x1="13.4" x2="2.6" y1="5.4" y2="10.6" />
            </svg>
        );
    }

    if (runtimeId === "gemini") {
        return (
            <svg
                className="shrink-0 opacity-55"
                fill="currentColor"
                height={12}
                viewBox="0 0 16 16"
                width={12}
            >
                <path d="M8 1.2c.25 3.55 1.6 5.35 6.8 6.8-5.2 1.45-6.55 3.25-6.8 6.8-.25-3.55-1.6-5.35-6.8-6.8C6.4 6.55 7.75 4.75 8 1.2Z" />
            </svg>
        );
    }

    // kilo
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
            <line strokeWidth="1.5" x1="4.75" x2="4.75" y1="2.75" y2="13.25" />
            <line strokeWidth="1.5" x1="4.75" x2="11.25" y1="8" y2="2.75" />
            <line strokeWidth="1.5" x1="4.75" x2="11.25" y1="8" y2="13.25" />
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

function getTerminalTheme() {
    const style = getComputedStyle(document.documentElement);
    const v = (name: string) => style.getPropertyValue(name).trim();

    return {
        background: v("--color-editor") || v("--color-bg-primary"),
        cursor: v("--color-accent"),
        foreground: v("--color-editor-text") || v("--color-text-primary"),
        selectionBackground: v("--color-selection"),
    };
}
