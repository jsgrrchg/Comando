import { FileTypeIcon } from "@renderer/components/icons/FileTypeIcon";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
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

import type {
    AiFileContextAttachment,
    GitFileDiff,
    ProjectFileDocument,
    WorkspaceNode,
    WorkspacePaneNode,
    WorkspaceSplitNode,
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
    applyMonacoThemeFromDom,
    getMonacoThemeFromDom,
    type ComandoMonacoTheme,
} from "@renderer/app/editor/monaco";
import { useResolvedEditorSettings } from "@renderer/app/hooks/use-resolved-editor-settings";
import {
    loadAppEditorSettings,
    loadProjectEditorSettings,
    saveAppEditorSettings,
    saveProjectEditorSettings,
} from "@renderer/app/settings/client";
import { buildEditorFontFamily } from "@renderer/app/settings/theme";
import { useAiStore } from "@renderer/app/store/ai-store";
import { useGitStore } from "@renderer/app/store/git-store";
import {
    getBestMatchingChatTabId,
    useWorkspaceStore,
} from "@renderer/app/store/workspace-store";
import {
    collectPaneNodes,
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
import { ChatTabView } from "@renderer/components/workspace/ChatTabView";
import { GitCommitTabView } from "@renderer/components/workspace/GitCommitTabView";
import { GitTabView } from "@renderer/components/workspace/GitTabView";
import { ReviewTabView } from "@renderer/components/workspace/ReviewTabView";
import {
    computeGitGutterMarkers,
    type GitGutterMarker,
} from "@renderer/components/workspace/gitGutter";
import { buildInlineReviewDiffEditorOptions } from "@renderer/components/workspace/inlineReviewDiffEditorOptions";
import { canResolveFileHunks } from "@renderer/components/workspace/review/editedFilesPresentationModel";
import { createDiffFromTrackedFile } from "@renderer/components/workspace/review/reviewDiff";
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
    const rootNode = useWorkspaceStore((state) => state.rootNode);
    const tabsById = useWorkspaceStore((state) => state.tabsById);
    const aiSessions = useAiStore((state) => state.sessions);
    const dropTabToSplit = useWorkspaceStore((state) => state.dropTabToSplit);
    const moveTabToPane = useWorkspaceStore((state) => state.moveTabToPane);
    const reorderTab = useWorkspaceStore((state) => state.reorderTab);
    const autoClosingReviewTabIdsRef = useRef<Set<string>>(new Set());
    const tabDrag = useWorkspaceTabDrag({
        onDropToSplit: dropTabToSplit,
        onMoveToPane: moveTabToPane,
        onReorder: reorderTab,
        resolveExternalDropTarget: (_draggedTab, pointer) =>
            isPointOverComposerDropZone(pointer.x, pointer.y)
                ? { type: "composer" }
                : null,
    });

    useEffect(() => {
        const knownTabIds = new Set(Object.keys(tabsById));
        for (const tabId of autoClosingReviewTabIdsRef.current) {
            if (!knownTabIds.has(tabId)) {
                autoClosingReviewTabIdsRef.current.delete(tabId);
            }
        }

        const reviewTabsToClose = Object.values(tabsById).filter((tab) => {
            if (tab.kind !== "review") {
                return false;
            }

            const sessionState = aiSessions[tab.sessionId];
            if (!sessionState?.hydrated || sessionState.isHydrating) {
                return false;
            }

            if (sessionState.localError || sessionState.snapshot?.lastError) {
                return false;
            }

            const hasPendingTrackedFiles =
                sessionState.snapshot?.trackedFiles.some(
                    (trackedFile) => trackedFile.reviewState === "pending",
                ) ?? false;

            return !hasPendingTrackedFiles;
        });

        for (const tab of reviewTabsToClose) {
            if (autoClosingReviewTabIdsRef.current.has(tab.id)) {
                continue;
            }

            autoClosingReviewTabIdsRef.current.add(tab.id);
            void closeTab(tab.id).finally(() => {
                autoClosingReviewTabIdsRef.current.delete(tab.id);
            });
        }
    }, [aiSessions, closeTab, tabsById]);

    return (
        <div className="h-full min-h-0 bg-bg-primary">
            <WorkspaceNodeView
                defaultProjectId={defaultProjectId}
                defaultWorktreeId={defaultWorktreeId}
                node={rootNode}
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
    node,
    onRequestCreateFile,
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly node: WorkspaceNode;
    readonly onRequestCreateFile: () => void;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    if (node.type === "pane") {
        return (
            <WorkspacePaneView
                defaultProjectId={defaultProjectId}
                defaultWorktreeId={defaultWorktreeId}
                node={node}
                onRequestCreateFile={onRequestCreateFile}
                tabDrag={tabDrag}
            />
        );
    }

    return (
        <WorkspaceSplitView
            defaultProjectId={defaultProjectId}
            defaultWorktreeId={defaultWorktreeId}
            node={node}
            onRequestCreateFile={onRequestCreateFile}
            tabDrag={tabDrag}
        />
    );
}

function WorkspaceSplitView({
    defaultProjectId,
    defaultWorktreeId,
    node,
    onRequestCreateFile,
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly node: WorkspaceSplitNode;
    readonly onRequestCreateFile: () => void;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    const resizeSplit = useWorkspaceStore((state) => state.resizeSplit);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [dragState, setDragState] = useState<SplitDragState>(null);

    const handlePointerMove = useEffectEvent((event: PointerEvent) => {
        if (!dragState || !containerRef.current) {
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

        void resizeSplit(node.id, nextSizes);
    });

    const stopDragging = useEffectEvent(() => {
        setDragState(null);
    });

    useEffect(() => {
        if (!dragState) {
            return;
        }

        const previousCursor = document.body.style.cursor;
        const nextCursor =
            node.axis === "horizontal" ? "col-resize" : "row-resize";
        document.body.style.cursor = nextCursor;

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", stopDragging);

        return () => {
            document.body.style.cursor = previousCursor;
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", stopDragging);
        };
    }, [dragState, node.axis]);

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
                    node={child}
                    onRequestCreateFile={onRequestCreateFile}
                    onPointerDown={(event) =>
                        setDragState({
                            handleIndex: index,
                            startCoordinate:
                                node.axis === "horizontal"
                                    ? event.clientX
                                    : event.clientY,
                            startSizes: node.sizes,
                        })
                    }
                    size={node.sizes[index] ?? 1 / node.children.length}
                    tabDrag={tabDrag}
                />
            ))}
        </div>
    );
}

function FragmentPane({
    axis,
    defaultProjectId,
    defaultWorktreeId,
    handleIndex,
    isLast,
    node,
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
    readonly node: WorkspaceNode;
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
                    node={node}
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
    node,
    onRequestCreateFile,
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly node: WorkspacePaneNode;
    readonly onRequestCreateFile: () => void;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    const addDraftFileContext = useAiStore((s) => s.addDraftFileContext);
    const attachSelectionMention = useAiStore((s) => s.attachSelectionMention);
    const activePaneId = useWorkspaceStore((state) => state.activePaneId);
    const closeOtherTabs = useWorkspaceStore((state) => state.closeOtherTabs);
    const closePane = useWorkspaceStore((state) => state.closePane);
    const closeTab = useWorkspaceStore((state) => state.closeTab);
    const closeTabsToRight = useWorkspaceStore(
        (state) => state.closeTabsToRight,
    );
    const createChatTab = useWorkspaceStore((state) => state.createChatTab);
    const createTerminalTab = useWorkspaceStore(
        (state) => state.createTerminalTab,
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
    const openReviewTab = useWorkspaceStore((state) => state.openReviewTab);
    const paneCount = useWorkspaceStore(
        (state) => collectPaneNodes(state.rootNode).length,
    );
    const selectTab = useWorkspaceStore((state) => state.selectTab);
    const setActivePane = useWorkspaceStore((state) => state.setActivePane);
    const tabsById = useWorkspaceStore((state) => state.tabsById);
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

    const activeTab = node.activeTabId ? tabsById[node.activeTabId] : null;
    const isActivePane = activePaneId === node.id;
    const activeTabWorktreeId = activeTab?.worktreeId ?? null;

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

        const tabIndex = node.tabIds.indexOf(tabContextMenu.payload.tabId);
        if (tabIndex === -1) {
            return [];
        }

        const contextTab = tabsById[tabContextMenu.payload.tabId];
        const activeChatTab = Object.values(tabsById).find(
            (t) => t.kind === "chat",
        );

        const entries: ContextMenuEntry[] = [
            {
                label: "Close",
                action: () => void closeTab(tabContextMenu.payload.tabId),
            },
            {
                label: "Close Others",
                action: () => void closeOtherTabs(tabContextMenu.payload.tabId),
                disabled: node.tabIds.length <= 1,
            },
            {
                label: "Close Tabs to the Right",
                action: () =>
                    void closeTabsToRight(tabContextMenu.payload.tabId),
                disabled: tabIndex === node.tabIds.length - 1,
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

        if (contextTab?.kind === "file" && activeChatTab?.kind === "chat") {
            const ext = contextTab.relativePath.split(".").pop() ?? null;
            entries.push(
                { type: "separator" },
                {
                    label: "Add to Chat",
                    action: () => {
                        addDraftFileContext(activeChatTab.sessionId, {
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
        void setActivePane(node.id);
        void selectTab(node.id, tabId);
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
                node.id,
            );
        },
        [activeTabWorktreeId, node.id, openFileTab],
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
                node.id,
            );
        },
        [
            defaultProjectId,
            defaultWorktreeId,
            node.id,
            openFileTab,
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
                    currentPaneId: node.id,
                    lastFocusedChatTabId: currentState.lastFocusedChatTabId,
                    projectId: context.projectId,
                    recentFocusedChatTabIds:
                        currentState.recentFocusedChatTabIds,
                    worktreeId,
                },
            );

            if (candidateTabId) {
                const paneId = findPaneIdByTabId(candidateTabId) ?? node.id;

                await setActivePane(paneId);
                await selectTab(paneId, candidateTabId);

                const targetTab =
                    useWorkspaceStore.getState().tabsById[candidateTabId];
                if (targetTab?.kind === "chat") {
                    attachSelectionMention(targetTab.sessionId, {
                        endLine: context.endLine ?? context.startLine ?? 1,
                        path: context.relativePath,
                        selectedText: context.selectedText ?? "",
                        startLine: context.startLine ?? 1,
                    });
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
                attachSelectionMention(createdChatTab.sessionId, {
                    endLine: context.endLine ?? context.startLine ?? 1,
                    path: context.relativePath,
                    selectedText: context.selectedText ?? "",
                    startLine: context.startLine ?? 1,
                });
            }
        },
        [
            attachSelectionMention,
            createChatTab,
            node.id,
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
            openGitTab,
        ],
    );

    const lastQuickCreateTitle = getQuickCreateButtonTitle(
        lastQuickCreateAction,
        Boolean(defaultProjectId),
    );

    useEffect(() => {
        if (!isActivePane) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                event.key === "Tab"
            ) {
                event.preventDefault();
                event.stopPropagation();
                void selectAdjacentTab(
                    node.id,
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
                    handleCreateAgentFromFocusedProvider();
                    return;
                }

                void handleCreateFile();
                return;
            }

            if (key === "r" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                void createTerminalTab(
                    defaultProjectId,
                    defaultWorktreeId ?? null,
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
    }, [
        createTerminalTab,
        defaultProjectId,
        defaultWorktreeId,
        handleCreateAgentFromFocusedProvider,
        handleCreateFile,
        isActivePane,
        node.id,
        selectAdjacentTab,
    ]);

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
                onMouseDown={() => void setActivePane(node.id)}
                ref={(element) => {
                    tabDrag.setPaneElement(node.id, element);
                }}
            >
                {isProjectFileDragOverPane ? (
                    <div className="pointer-events-none absolute inset-0 z-20 bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]" />
                ) : null}
                <div className="app-drag flex items-center justify-between border-b border-border bg-bg-chrome px-0">
                    <div
                        className="workspace-tab-strip flex min-w-0 items-end overflow-x-auto overflow-y-hidden"
                        data-workspace-pane-id={node.id}
                        onWheel={handleTabStripWheel}
                        ref={(element) => {
                            tabStripRef.current = element;
                            tabDrag.setTabStripElement(node.id, element);
                        }}
                    >
                        {node.tabIds.length === 0 ? (
                            <span className="px-2.5 py-1.5 text-[11px] text-text-secondary">
                                Empty pane
                            </span>
                        ) : (
                            node.tabIds.map((tabId) => {
                                const tab = tabsById[tabId];
                                if (!tab) {
                                    return null;
                                }

                                const isActive = tabId === node.activeTabId;
                                const tabDisplayTitle =
                                    getWorkspaceTabDisplayTitle(tab);

                                return (
                                    <button
                                        className={[
                                            "group app-no-drag relative flex h-7.75 items-center gap-1.5 border-r border-border-subtle px-3 text-[12px] transition",
                                            tabDrag.draggedTab?.tabId ===
                                                tabId && tabDrag.isDragging
                                                ? "opacity-35"
                                                : "",
                                            isActive
                                                ? "z-10 bg-bg-primary text-text-primary shadow-[inset_0_-2px_0_0_var(--color-accent)]"
                                                : "z-0 bg-bg-chrome text-text-secondary hover:bg-bg-tertiary hover:text-text-primary",
                                        ].join(" ")}
                                        data-workspace-tab-id={tabId}
                                        key={tabId}
                                        onClick={(event) => {
                                            if (tabDrag.handleTabClick(event)) {
                                                return;
                                            }

                                            void selectTab(node.id, tabId);
                                        }}
                                        onContextMenu={(event) =>
                                            handleTabContextMenu(event, tabId)
                                        }
                                        onPointerDown={(event) =>
                                            tabDrag.beginTabPointerDown(
                                                {
                                                    isDirty:
                                                        "isDirty" in tab
                                                            ? tab.isDirty
                                                            : false,
                                                    kind: tab.kind,
                                                    paneId: node.id,
                                                    composerDragItem:
                                                        tab.kind === "file"
                                                            ? {
                                                                  kind: "file_mention",
                                                                  label: tab.title,
                                                                  relativePath:
                                                                      tab.relativePath,
                                                              }
                                                            : null,
                                                    sourceIndex:
                                                        node.tabIds.indexOf(
                                                            tabId,
                                                        ),
                                                    tabId,
                                                    title: tabDisplayTitle,
                                                },
                                                event,
                                            )
                                        }
                                        type="button"
                                    >
                                        <TabIcon
                                            kind={tab.kind}
                                            title={tabDisplayTitle}
                                        />
                                        <span className="truncate">
                                            {tabDisplayTitle}
                                        </span>
                                        {"isDirty" in tab && tab.isDirty ? (
                                            <span className="text-[9px] text-[var(--diff-warn)]">
                                                ●
                                            </span>
                                        ) : null}
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
                                                void closeTab(tabId);
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
                            onClick={() => void closePane(node.id)}
                            title="Close pane"
                        />
                    </div>
                </div>

                <div className="min-h-0 flex-1 bg-editor">
                    {activeTab ? (
                        activeTab.kind === "file" ? (
                            <FileTabView
                                isActivePane={isActivePane}
                                onAttachLineFragment={handleAttachLineFragment}
                                onDraftChange={updateFileDraft}
                                onReload={reloadFileTab}
                                onSave={saveFileTab}
                                tab={activeTab}
                            />
                        ) : activeTab.kind === "terminal" ? (
                            <TerminalTabView
                                onResize={updateTerminalSize}
                                onSendInput={sendTerminalInput}
                                tab={activeTab}
                            />
                        ) : activeTab.kind === "git" ? (
                            <GitTabView tab={activeTab} />
                        ) : activeTab.kind === "git_commit" ? (
                            <GitCommitTabView tab={activeTab} />
                        ) : activeTab.kind === "review" ? (
                            <ReviewTabView
                                onOpenFile={handleOpenWorkspaceFile}
                                tab={activeTab}
                            />
                        ) : (
                            <ChatTabView
                                onDraftChange={(draft) =>
                                    void updateChatDraft(activeTab.id, draft)
                                }
                                onOpenFile={handleOpenWorkspaceFile}
                                onOpenReview={() =>
                                    openReviewTab({
                                        projectId: activeTab.projectId,
                                        runtimeId: activeTab.runtimeId,
                                        sessionId: activeTab.sessionId,
                                        title: activeTab.title,
                                        worktreeId:
                                            activeTab.worktreeId ?? null,
                                    })
                                }
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
                        <span className="text-[9px] text-[var(--diff-warn)]">
                            ●
                        </span>
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
                            : "text-text-primary hover:bg-bg-secondary",
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
        case "file":
            return hasProject
                ? "Open last item: new file"
                : "Open last item: Codex chat";
        case "codex":
        default:
            return "Open last item: Codex chat";
    }
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
    const editorTheme = useMonacoTheme();
    const editorSettings = useResolvedEditorSettings(tab.projectId);
    const aiSessions = useAiStore((state) => state.sessions);
    const keepTrackedFileHunks = useAiStore(
        (state) => state.keepTrackedFileHunks,
    );
    const rejectTrackedFileHunks = useAiStore(
        (state) => state.rejectTrackedFileHunks,
    );
    const updateFileViewState = useWorkspaceStore(
        (state) => state.updateFileViewState,
    );
    const document = tab.document;
    const diffEditorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(
        null,
    );
    const inlineReviewContainerRef = useRef<HTMLDivElement | null>(null);
    const inlineReviewOverlayPinnedRef = useRef(false);
    const inlineReviewHoverHideTimerRef = useRef<number | null>(null);
    const hoveredInlineReviewHunkIdRef = useRef<string | null>(null);
    const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
    const fileTabIdRef = useRef(tab.id);
    const gitGutterDecorationsRef =
        useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
    const pendingEditorViewStateRef =
        useRef<MonacoEditor.ICodeEditorViewState | null>(tab.viewState ?? null);
    const pendingEditorViewStateTabIdRef = useRef(tab.id);
    const viewStatePersistTimerRef = useRef<number | null>(null);
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
    const [selectedHunkState, setSelectedHunkState] = useState<{
        readonly hunkId: string | null;
        readonly key: string | null;
    }>({
        hunkId: null,
        key: null,
    });

    const trackedFile = useMemo(
        () =>
            document
                ? findTrackedFileForDocument(
                      aiSessions,
                      document,
                      tab.reviewContext,
                  )
                : null,
        [aiSessions, document, tab.reviewContext],
    );
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
    const canShowInlineReview = isInlineReviewSupported(trackedFile);
    const reviewSignature = trackedFile
        ? `${trackedFile.identityKey}:${trackedFile.hunks.map((hunk) => hunk.id).join(",")}`
        : null;
    const selectedHunkId =
        selectedHunkState.key === reviewSignature
            ? selectedHunkState.hunkId
            : null;
    const showInlineReview = canShowInlineReview;
    const selectedHunk =
        trackedFile?.hunks.find((hunk) => hunk.id === selectedHunkId) ??
        trackedFile?.hunks[0] ??
        null;
    const inlineReviewTrackedFile =
        showInlineReview &&
        canShowInlineReview &&
        trackedFile?.oldText !== null &&
        trackedFile?.newText !== null
            ? trackedFile
            : null;
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
            const projectEditor = await loadProjectEditorSettings(
                tab.projectId,
            );
            const hasProjectOverride =
                projectEditor.fontFamily !== null ||
                projectEditor.fontSize !== null ||
                projectEditor.lineHeight !== null ||
                projectEditor.minimapEnabled !== null ||
                projectEditor.suggestionsEnabled !== null;

            if (hasProjectOverride) {
                await saveProjectEditorSettings(tab.projectId, {
                    ...projectEditor,
                    fontSize: nextFontSizeFrom(
                        projectEditor.fontSize ?? editorSettings.fontSize,
                    ),
                });
                return;
            }

            const appEditor = await loadAppEditorSettings();
            await saveAppEditorSettings({
                ...appEditor,
                fontSize: nextFontSizeFrom(appEditor.fontSize),
            });
        },
        [editorSettings.fontSize, tab.projectId],
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

            flushScheduledEditorViewStatePersist();
        };
    }, [flushScheduledEditorViewStatePersist]);

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

    useEffect(() => {
        if (!showInlineReview || !selectedHunk) {
            return;
        }

        const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
        const maxLineNumber = modifiedEditor?.getModel()?.getLineCount() ?? 1;
        const lineNumber = Math.min(
            getSelectedReviewLine(selectedHunk),
            maxLineNumber,
        );
        modifiedEditor?.revealLineInCenter(Math.max(lineNumber, 1));
    }, [selectedHunk, showInlineReview]);

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
        applyMonacoThemeFromDom();
    }, []);

    const canEdit = document
        ? !document.isBinary && !document.isTooLarge
        : false;

    useEffect(() => {
        if (
            !document ||
            document.kind === "image" ||
            !canEdit ||
            !activeGitChange ||
            activeGitChange.isBinary
        ) {
            setGitGutterDiff(null);
            return;
        }

        let isDisposed = false;
        setGitGutterDiff(null);

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

                if (!isDisposed) {
                    setGitGutterDiff(diff);
                }
            } catch {
                if (!isDisposed) {
                    setGitGutterDiff(null);
                }
            }
        };

        void loadGitDiff();

        return () => {
            isDisposed = true;
        };
    }, [
        activeGitChange,
        canEdit,
        document,
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
        if (!model || !gitGutterDiff) {
            gitGutterDecorationsRef.current?.clear();
            return;
        }

        const markers = computeGitGutterMarkers(
            gitGutterDiff,
            model.getLineCount(),
        );
        const decorations = buildGitGutterDecorations(markers);
        const collection =
            gitGutterDecorationsRef.current ??
            editor.createDecorationsCollection();

        collection.set(decorations);
        gitGutterDecorationsRef.current = collection;

        return () => {
            collection.clear();
            if (gitGutterDecorationsRef.current === collection) {
                gitGutterDecorationsRef.current = null;
            }
        };
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
        }, 900);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [
        canEdit,
        document,
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
                        <DiffEditor
                            beforeMount={handleEditorBeforeMount}
                            language={document.languageId}
                            modified={inlineReviewTrackedFile.newText ?? ""}
                            modifiedModelPath={`${document.absolutePath}::review::modified`}
                            onMount={(editor) => {
                                diffEditorRef.current = editor;
                                const modifiedEditor =
                                    editor.getModifiedEditor();
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

                                syncFindWidgetVisibility();

                                editor.onDidDispose(() => {
                                    cleanupAttachShortcut?.();
                                    cleanupFindWidgetEscape?.();
                                    findStateListener?.dispose();
                                    setIsInlineReviewFindWidgetVisible(false);
                                });
                                setDiffEditorMountVersion(
                                    (previous) => previous + 1,
                                );
                            }}
                            options={inlineReviewDiffEditorOptions}
                            original={inlineReviewTrackedFile.oldText ?? ""}
                            originalModelPath={`${document.absolutePath}::review::original`}
                            theme={editorTheme}
                        />
                        {inlineReviewHunkActionsEnabled &&
                        !isInlineReviewFindWidgetVisible &&
                        hoveredInlineReviewHunk &&
                        hoveredInlineReviewHunkState ? (
                            <InlineReviewHunkZone
                                onAccept={() => {
                                    setSelectedHunkState({
                                        hunkId: hoveredInlineReviewHunk.id,
                                        key:
                                            reviewSignature ??
                                            inlineReviewTrackedFile.identityKey,
                                    });
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
                                    setSelectedHunkState({
                                        hunkId: hoveredInlineReviewHunk.id,
                                        key:
                                            reviewSignature ??
                                            inlineReviewTrackedFile.identityKey,
                                    });
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
                    <Editor
                        beforeMount={handleEditorBeforeMount}
                        language={document.languageId}
                        onChange={(value: string | undefined) =>
                            onDraftChange(tab.id, value ?? "")
                        }
                        onMount={(editor) => {
                            editorRef.current = editor;
                            const persistedViewState =
                                tab.viewState ??
                                pendingEditorViewStateRef.current;
                            if (persistedViewState) {
                                editor.restoreViewState(persistedViewState);
                                pendingEditorViewStateRef.current =
                                    persistedViewState;
                                editor.layout();
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
                                pendingEditorViewStateRef.current =
                                    editor.saveViewState();
                                flushScheduledEditorViewStatePersist();
                                editorRef.current = null;
                                gitGutterDecorationsRef.current = null;
                                scrollListener.dispose();
                                cursorListener.dispose();
                                hiddenAreasListener.dispose();
                                cleanupAttachShortcut?.();
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
                            lineNumbersMinChars: 3,
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
                            wordBasedSuggestions: areSuggestionsEnabled
                                ? "matchingDocuments"
                                : "off",
                            wordWrap: shouldEnableDocumentWrapping(document)
                                ? "on"
                                : "off",
                        }}
                        path={document.absolutePath}
                        theme={editorTheme}
                        value={tab.draftContent}
                    />
                )}
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
        <div className="flex h-6 items-center justify-between gap-3 border-b border-border bg-bg-secondary px-3 text-[10px] leading-none text-text-secondary">
            <div className="min-w-0 truncate" title={path}>
                {path}
            </div>
            {statusLabel ? <div className="shrink-0">{statusLabel}</div> : null}
        </div>
    );
}

function buildGitGutterDecorations(
    markers: readonly GitGutterMarker[],
): MonacoEditor.IModelDeltaDecoration[] {
    return markers.map((marker) => ({
        options: {
            isWholeLine: true,
            lineNumberClassName: `git-gutter-line-number git-gutter-line-number--${marker.tone}`,
        },
        range: {
            endColumn: 1,
            endLineNumber: marker.lineNumber,
            startColumn: 1,
            startLineNumber: marker.lineNumber,
        },
    }));
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

function ImageFileView({
    document,
}: {
    readonly document: ProjectFileDocument;
}) {
    const imageSrc = buildImageDataUrl(document);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <FilePathBar path={document.absolutePath} />
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-bg-primary px-6 py-6">
                {imageSrc ? (
                    <img
                        alt={document.name}
                        className="max-h-full max-w-full rounded-xl border border-border bg-white/40 object-contain shadow-[0_12px_40px_rgba(15,23,42,0.12)]"
                        src={imageSrc}
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
            className="pointer-events-none absolute right-4 z-[3] flex justify-end"
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
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const writtenLengthRef = useRef(0);

    useEffect(() => {
        if (!containerRef.current) {
            return;
        }

        const terminal = new Terminal({
            allowTransparency: false,
            convertEol: true,
            cursorBlink: true,
            fontFamily:
                '"SF Mono", "JetBrains Mono", "Cascadia Code", monospace',
            fontSize: 12.5,
            lineHeight: 1.35,
            scrollback: 5000,
            theme: getTerminalTheme(),
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(containerRef.current);
        fitAddon.fit();

        terminal.onData((data) => {
            void onSendInput(tab.sessionId, data);
        });

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        const resizeObserver = new ResizeObserver(() => {
            fitAddon.fit();
            void onResize(tab.sessionId, terminal.cols, terminal.rows);
        });
        resizeObserver.observe(containerRef.current);
        void onResize(tab.sessionId, terminal.cols, terminal.rows);

        return () => {
            resizeObserver.disconnect();
            terminal.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
            writtenLengthRef.current = 0;
        };
    }, [onResize, onSendInput, tab.sessionId]);

    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) {
            return;
        }

        if (tab.output.length < writtenLengthRef.current) {
            terminal.reset();
            writtenLengthRef.current = 0;
        }

        const nextChunk = tab.output.slice(writtenLengthRef.current);
        if (!nextChunk) {
            return;
        }

        terminal.write(nextChunk);
        writtenLengthRef.current = tab.output.length;
    }, [tab.output]);

    return (
        <div className="terminal-surface h-full min-h-0">
            <div className="h-full w-full px-3 py-2" ref={containerRef} />
        </div>
    );
}

function TabIcon({
    kind,
    title,
}: {
    readonly kind:
        | "chat"
        | "file"
        | "git"
        | "git_commit"
        | "review"
        | "terminal";
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

function getWorkspaceTabDisplayTitle(tab: RuntimeWorkspaceTab): string {
    if (tab.kind === "git_commit") {
        return tab.commitSha.slice(0, 7);
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

function useMonacoTheme(): ComandoMonacoTheme {
    const [theme, setTheme] = useState<ComandoMonacoTheme>(() =>
        getMonacoThemeFromDom(),
    );

    useEffect(() => {
        let frameHandle = 0;

        const updateTheme = () => {
            frameHandle = 0;
            setTheme(applyMonacoThemeFromDom());
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
    }, []);

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
