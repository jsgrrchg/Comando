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
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    type PointerEvent as ReactPointerEvent,
    type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";

import type {
    AiFileContextAttachment,
    AiTrackedFile,
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
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import {
    collectPaneNodes,
    type RuntimeWorkspaceFileTab,
    type RuntimeWorkspaceFileReviewContext,
    type RuntimeWorkspaceTerminalTab,
} from "@renderer/app/workspace/tree";
import { ChatTabView } from "@renderer/components/workspace/ChatTabView";
import { ReviewTabView } from "@renderer/components/workspace/ReviewTabView";
import {
    canResolveFileHunks,
    computeFileStats,
    getFileSummary,
    getFileTone,
} from "@renderer/components/workspace/review/editedFilesPresentationModel";
import {
    createDiffFromTrackedFile,
    formatDiffStat,
} from "@renderer/components/workspace/review/reviewDiff";
import {
    getAccentButtonStyle,
    getDangerButtonStyle,
    getNeutralButtonStyle,
    getStatChipStyle,
    getToneBorderStyle,
} from "@renderer/components/workspace/review/reviewStyles";
import {
    computeReviewHunkStats,
    formatReviewHunkFocusSummary,
    getReviewKindLabel,
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
}: WorkspaceViewProps) {
    const rootNode = useWorkspaceStore((state) => state.rootNode);
    const dropTabToSplit = useWorkspaceStore((state) => state.dropTabToSplit);
    const moveTabToPane = useWorkspaceStore((state) => state.moveTabToPane);
    const reorderTab = useWorkspaceStore((state) => state.reorderTab);
    const tabDrag = useWorkspaceTabDrag({
        onDropToSplit: dropTabToSplit,
        onMoveToPane: moveTabToPane,
        onReorder: reorderTab,
    });

    return (
        <div className="h-full min-h-0 bg-bg-primary">
            <WorkspaceNodeView
                defaultProjectId={defaultProjectId}
                defaultWorktreeId={defaultWorktreeId}
                node={rootNode}
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
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly node: WorkspaceNode;
    readonly tabDrag: ReturnType<typeof useWorkspaceTabDrag>;
}) {
    if (node.type === "pane") {
        return (
            <WorkspacePaneView
                defaultProjectId={defaultProjectId}
                defaultWorktreeId={defaultWorktreeId}
                node={node}
                tabDrag={tabDrag}
            />
        );
    }

    return (
        <WorkspaceSplitView
            defaultProjectId={defaultProjectId}
            defaultWorktreeId={defaultWorktreeId}
            node={node}
            tabDrag={tabDrag}
        />
    );
}

function WorkspaceSplitView({
    defaultProjectId,
    defaultWorktreeId,
    node,
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly node: WorkspaceSplitNode;
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
    tabDrag,
}: {
    readonly defaultProjectId: string | null;
    readonly defaultWorktreeId: string | null;
    readonly node: WorkspacePaneNode;
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
    const lastQuickCreateAction = useWorkspaceStore(
        (state) => state.lastQuickCreateAction,
    );
    const lastFocusedRuntimeId = useWorkspaceStore(
        (state) => state.lastFocusedRuntimeId,
    );
    const lastFocusedChatTabId = useWorkspaceStore(
        (state) => state.lastFocusedChatTabId,
    );
    const moveTab = useWorkspaceStore((state) => state.moveTab);
    const openFileTab = useWorkspaceStore((state) => state.openFileTab);
    const openReviewTab = useWorkspaceStore((state) => state.openReviewTab);
    const setLastQuickCreateAction = useWorkspaceStore(
        (state) => state.setLastQuickCreateAction,
    );
    const paneCount = useWorkspaceStore(
        (state) => collectPaneNodes(state.rootNode).length,
    );
    const rootNode = useWorkspaceStore((state) => state.rootNode);
    const createEntry = useProjectsStore((state) => state.createEntry);
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
    const [tabContextMenu, setTabContextMenu] =
        useState<ContextMenuState<TabContextMenuPayload> | null>(null);
    const [quickCreateMenu, setQuickCreateMenu] =
        useState<QuickCreateMenuState>(null);

    const activeTab = node.activeTabId ? tabsById[node.activeTabId] : null;
    const isActivePane = activePaneId === node.id;

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

    const handleCreateFile = useCallback(async () => {
        if (!defaultProjectId) {
            return;
        }

        const name = window.prompt("New file name", "untitled.txt");
        if (name === null) {
            return;
        }

        const trimmedName = name.trim();
        if (!trimmedName) {
            return;
        }

        const entry = await createEntry(
            defaultProjectId,
            null,
            trimmedName,
            "file",
            defaultWorktreeId ?? null,
        );
        setLastQuickCreateAction("file");
        await openFileTab(
            defaultProjectId,
            entry.relativePath,
            defaultWorktreeId ?? null,
        );
    }, [
        createEntry,
        defaultProjectId,
        defaultWorktreeId,
        openFileTab,
        setLastQuickCreateAction,
    ]);

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
        async (context: AiFileContextAttachment) => {
            const findPaneIdByTabId = (tabId: string) =>
                collectPaneNodes(rootNode).find((pane) =>
                    pane.tabIds.includes(tabId),
                )?.id ?? null;
            const isMatchingChatScope = (tabId: string) => {
                const tab = tabsById[tabId];
                return (
                    tab?.kind === "chat" &&
                    tab.projectId === context.projectId &&
                    (tab.worktreeId ?? null) === (defaultWorktreeId ?? null)
                );
            };

            const preferredPaneId =
                lastFocusedChatTabId &&
                tabsById[lastFocusedChatTabId]?.kind === "chat"
                    ? findPaneIdByTabId(lastFocusedChatTabId)
                    : null;
            const currentPaneMatch = node.tabIds.find(isMatchingChatScope);
            const candidateTabId =
                (preferredPaneId ? lastFocusedChatTabId : null) ??
                currentPaneMatch ??
                collectPaneNodes(rootNode)
                    .flatMap((pane) => pane.tabIds)
                    .find(isMatchingChatScope) ??
                null;

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

            const existingTabIds = new Set(Object.keys(tabsById));
            await createChatTab(
                context.projectId,
                defaultWorktreeId ?? null,
                lastFocusedRuntimeId,
            );

            const createdChatTab = Object.values(
                useWorkspaceStore.getState().tabsById,
            ).find(
                (tab) =>
                    tab.kind === "chat" &&
                    !existingTabIds.has(tab.id) &&
                    tab.projectId === context.projectId &&
                    (tab.worktreeId ?? null) === (defaultWorktreeId ?? null),
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
            defaultWorktreeId,
            lastFocusedChatTabId,
            lastFocusedRuntimeId,
            node.id,
            node.tabIds,
            rootNode,
            selectTab,
            setActivePane,
            tabsById,
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
                    "flex h-full min-h-0 flex-col border bg-bg-primary",
                    isActivePane
                        ? "border-border-strong"
                        : "border-transparent",
                ].join(" ")}
                onMouseDown={() => void setActivePane(node.id)}
                ref={(element) => {
                    tabDrag.setPaneElement(node.id, element);
                }}
            >
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
                                                    sourceIndex:
                                                        node.tabIds.indexOf(
                                                            tabId,
                                                        ),
                                                    tabId,
                                                    title: tab.title,
                                                },
                                                event,
                                            )
                                        }
                                        type="button"
                                    >
                                        <TabIcon kind={tab.kind} />
                                        <span className="truncate">
                                            {tab.title}
                                        </span>
                                        {"isDirty" in tab && tab.isDirty ? (
                                            <span className="text-[9px] text-amber-500">
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
                                                "ml-0.5 rounded px-0.5 text-[10px] transition hover:bg-text-secondary/10 hover:text-text-primary",
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
                        ) : activeTab.kind === "review" ? (
                            <ReviewTabView
                                onOpenFile={(
                                    projectId,
                                    relativePath,
                                    worktreeId,
                                    reviewContext,
                                ) =>
                                    openFileTab(
                                        projectId,
                                        relativePath,
                                        worktreeId ??
                                            activeTab.worktreeId ??
                                            null,
                                        reviewContext ?? null,
                                    )
                                }
                                tab={activeTab}
                            />
                        ) : (
                            <ChatTabView
                                onDraftChange={(draft) =>
                                    void updateChatDraft(activeTab.id, draft)
                                }
                                onOpenFile={(
                                    projectId,
                                    relativePath,
                                    worktreeId,
                                    reviewContext,
                                ) =>
                                    openFileTab(
                                        projectId,
                                        relativePath,
                                        worktreeId ??
                                            activeTab.worktreeId ??
                                            null,
                                        reviewContext ?? null,
                                    )
                                }
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
                    <TabIcon kind={draggedTab.kind} />
                    <span className="truncate">{draggedTab.title}</span>
                    {draggedTab.isDirty ? (
                        <span className="text-[9px] text-amber-500">●</span>
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
    readonly editor: MonacoEditor.IStandaloneCodeEditor;
    readonly onAttachLineFragment: (
        context: AiFileContextAttachment,
    ) => Promise<void>;
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
    });

    return true;
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
    readonly onAttachLineFragment: (
        context: AiFileContextAttachment,
    ) => Promise<void>;
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
    const keepTrackedFile = useAiStore((state) => state.keepTrackedFile);
    const keepTrackedFileHunks = useAiStore(
        (state) => state.keepTrackedFileHunks,
    );
    const rejectTrackedFile = useAiStore((state) => state.rejectTrackedFile);
    const rejectTrackedFileHunks = useAiStore(
        (state) => state.rejectTrackedFileHunks,
    );
    const document = tab.document;
    const diffEditorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(
        null,
    );
    const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
    const [reviewModeState, setReviewModeState] = useState<{
        readonly key: string | null;
        readonly value: "editor" | "inline" | null;
    }>({
        key: null,
        value: null,
    });
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
    const canShowInlineReview = isInlineReviewSupported(trackedFile);
    const reviewSignature = trackedFile
        ? `${trackedFile.identityKey}:${trackedFile.hunks.map((hunk) => hunk.id).join(",")}`
        : null;
    const reviewMode =
        reviewModeState.key === reviewSignature ? reviewModeState.value : null;
    const selectedHunkId =
        selectedHunkState.key === reviewSignature
            ? selectedHunkState.hunkId
            : null;
    const showInlineReview =
        canShowInlineReview &&
        (reviewMode === "inline" ||
            (reviewMode !== "editor" && Boolean(tab.reviewContext)));
    const selectedHunk =
        trackedFile?.hunks.find((hunk) => hunk.id === selectedHunkId) ??
        trackedFile?.hunks[0] ??
        null;
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
                projectEditor.lineHeight !== null;

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

        const lineNumber = getSelectedReviewLine(selectedHunk);
        diffEditorRef.current
            ?.getModifiedEditor()
            .revealLineInCenter(lineNumber);
    }, [selectedHunk, showInlineReview]);

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

    const inlineReviewTrackedFile =
        showInlineReview &&
        canShowInlineReview &&
        trackedFile?.oldText !== null &&
        trackedFile?.newText !== null
            ? trackedFile
            : null;
    const editorFontFamily = buildEditorFontFamily(editorSettings.fontFamily);
    const editorLineHeightPx = Math.round(
        editorSettings.fontSize * editorSettings.lineHeight,
    );
    const reviewBar = trackedFile
        ? (() => {
              const activeTrackedFile = trackedFile;
              const activeReviewKey =
                  reviewSignature ?? activeTrackedFile.identityKey;

              return (
                  <FileReviewBar
                      canShowInlineReview={canShowInlineReview}
                      isInlineReviewVisible={showInlineReview}
                      onKeepFile={() =>
                          void keepTrackedFile({
                              path: activeTrackedFile.path,
                              sessionId: activeTrackedFile.sessionId,
                          })
                      }
                      onKeepHunk={() => {
                          if (!selectedHunk) {
                              return;
                          }

                          void keepTrackedFileHunks({
                              hunkIds: [selectedHunk.id],
                              path: activeTrackedFile.path,
                              sessionId: activeTrackedFile.sessionId,
                          });
                      }}
                      onRejectFile={() =>
                          void rejectTrackedFile({
                              path: activeTrackedFile.path,
                              sessionId: activeTrackedFile.sessionId,
                          })
                      }
                      onRejectHunk={() => {
                          if (!selectedHunk) {
                              return;
                          }

                          void rejectTrackedFileHunks({
                              hunkIds: [selectedHunk.id],
                              path: activeTrackedFile.path,
                              sessionId: activeTrackedFile.sessionId,
                          });
                      }}
                      onSelectHunk={(hunkId) =>
                          setSelectedHunkState({
                              hunkId,
                              key: activeReviewKey,
                          })
                      }
                      onShowEditor={() =>
                          setReviewModeState({
                              key: activeReviewKey,
                              value: "editor",
                          })
                      }
                      onShowInlineReview={() =>
                          setReviewModeState({
                              key: activeReviewKey,
                              value: "inline",
                          })
                      }
                      selectedHunkId={selectedHunk?.id ?? null}
                      trackedFile={activeTrackedFile}
                  />
              );
          })()
        : null;

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

            {reviewBar}

            <div className="min-h-0 flex-1">
                {inlineReviewTrackedFile ? (
                    <DiffEditor
                        beforeMount={handleEditorBeforeMount}
                        language={document.languageId}
                        modified={inlineReviewTrackedFile.newText ?? ""}
                        modifiedModelPath={`${document.absolutePath}::review::modified`}
                        onMount={(editor) => {
                            diffEditorRef.current = editor;
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
                            minimap: { enabled: false },
                            originalEditable: false,
                            padding: { top: 16, bottom: 16 },
                            readOnly: true,
                            renderSideBySide: false,
                            scrollBeyondLastLine: false,
                            smoothScrolling: true,
                            wordWrap: shouldEnableDocumentWrapping(document)
                                ? "on"
                                : "off",
                        }}
                        original={inlineReviewTrackedFile.oldText ?? ""}
                        originalModelPath={`${document.absolutePath}::review::original`}
                        theme={editorTheme}
                    />
                ) : (
                    <Editor
                        beforeMount={handleEditorBeforeMount}
                        language={document.languageId}
                        onChange={(value: string | undefined) =>
                            onDraftChange(tab.id, value ?? "")
                        }
                        onMount={(editor) => {
                            editorRef.current = editor;
                            const editorDomNode = editor.getDomNode();
                            if (!editorDomNode) {
                                return;
                            }

                            const handleEditorKeyDown = (
                                event: KeyboardEvent,
                            ) => {
                                if (
                                    event.key.toLowerCase() !== "l" ||
                                    !(event.metaKey || event.ctrlKey) ||
                                    event.altKey ||
                                    event.shiftKey
                                ) {
                                    return;
                                }

                                // Intercept in capture so Monaco doesn't expand line
                                // selection before we can attach the current selection.
                                const attached =
                                    tryAttachEditorSelectionToComposer({
                                        documentLanguageId: document.languageId,
                                        editor,
                                        onAttachLineFragment,
                                        projectId: tab.projectId,
                                        relativePath: tab.relativePath,
                                        tabTitle: tab.title,
                                    });

                                if (!attached) {
                                    return;
                                }

                                event.preventDefault();
                                event.stopPropagation();
                                event.stopImmediatePropagation();
                            };

                            editorDomNode.addEventListener(
                                "keydown",
                                handleEditorKeyDown,
                                true,
                            );

                            editor.onDidDispose(() => {
                                editorDomNode.removeEventListener(
                                    "keydown",
                                    handleEditorKeyDown,
                                    true,
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
                            minimap: { enabled: false },
                            padding: { top: 16, bottom: 16 },
                            scrollBeyondLastLine: false,
                            smoothScrolling: true,
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
            ? "border-rose-500/30 bg-rose-500/10 text-rose-100"
            : "border-amber-500/30 bg-amber-500/10 text-amber-100";

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

function FileReviewBar({
    canShowInlineReview,
    isInlineReviewVisible,
    onKeepFile,
    onKeepHunk,
    onRejectFile,
    onRejectHunk,
    onSelectHunk,
    onShowEditor,
    onShowInlineReview,
    selectedHunkId,
    trackedFile,
}: {
    readonly canShowInlineReview: boolean;
    readonly isInlineReviewVisible: boolean;
    readonly onKeepFile: () => void;
    readonly onKeepHunk: () => void;
    readonly onRejectFile: () => void;
    readonly onRejectHunk: () => void;
    readonly onSelectHunk: (hunkId: string) => void;
    readonly onShowEditor: () => void;
    readonly onShowInlineReview: () => void;
    readonly selectedHunkId: string | null;
    readonly trackedFile: AiTrackedFile;
}) {
    const diff = useMemo(
        () => createDiffFromTrackedFile(trackedFile),
        [trackedFile],
    );
    const stats = useMemo(() => computeFileStats(diff), [diff]);
    const tone = useMemo(() => getFileTone(trackedFile), [trackedFile]);
    const summary = useMemo(() => getFileSummary(trackedFile), [trackedFile]);
    const selectedHunk = useMemo(
        () =>
            trackedFile.hunks.find((hunk) => hunk.id === selectedHunkId) ??
            trackedFile.hunks[0] ??
            null,
        [selectedHunkId, trackedFile.hunks],
    );
    const canResolveHunks = useMemo(
        () => canResolveFileHunks(trackedFile, diff),
        [diff, trackedFile],
    );
    const canRejectFile = trackedFile.reversible !== false;
    const hunkActionDisabled = !selectedHunk || !canResolveHunks;
    const pillButtonBaseStyle = {
        borderRadius: 999,
        fontSize: "11px",
        fontWeight: 600,
        lineHeight: "16px",
        padding: "6px 12px",
        transition:
            "background-color 140ms ease, border-color 140ms ease, color 140ms ease, opacity 140ms ease, transform 140ms ease",
    };
    const selectedToggleStyle = {
        ...getAccentButtonStyle(),
        ...pillButtonBaseStyle,
        backgroundColor:
            "color-mix(in srgb, var(--color-accent) 14%, var(--color-bg-secondary))",
        transform: "translateY(-1px)",
    };
    const unselectedToggleStyle = {
        ...getNeutralButtonStyle(),
        ...pillButtonBaseStyle,
    };
    const keepButtonStyle = {
        ...getAccentButtonStyle(),
        ...pillButtonBaseStyle,
        backgroundColor:
            "color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-secondary))",
    };
    const rejectButtonStyle = {
        ...getDangerButtonStyle(!canRejectFile),
        ...pillButtonBaseStyle,
    };
    const kindLabel = getReviewKindLabel(trackedFile.kind);
    const kindAccent =
        trackedFile.kind === "create"
            ? "var(--diff-add)"
            : trackedFile.kind === "delete"
              ? "var(--diff-remove)"
              : trackedFile.kind === "move"
                ? "var(--diff-move)"
                : "var(--color-accent)";
    const kindBadgeStyle = {
        alignItems: "center",
        backgroundColor: `color-mix(in srgb, ${kindAccent} 10%, var(--color-bg-secondary))`,
        border: `1px solid color-mix(in srgb, ${kindAccent} 28%, var(--color-border))`,
        borderRadius: 999,
        color: kindAccent,
        display: "inline-flex",
        fontSize: "10px",
        fontWeight: 700,
        letterSpacing: "0.12em",
        padding: "2px 10px",
        textTransform: "uppercase" as const,
    };

    return (
        <div
            className="border-b border-border px-3 py-3"
            style={{
                ...getToneBorderStyle(tone.accent),
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 3%, var(--color-bg-panel))",
            }}
        >
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span
                            className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-text-secondary"
                            style={{ fontWeight: 700 }}
                        >
                            <span
                                aria-hidden="true"
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: tone.accent }}
                            />
                            Pending Review
                        </span>
                        <span style={kindBadgeStyle}>{kindLabel}</span>
                        {tone.badge ? (
                            <span
                                className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                                style={{
                                    backgroundColor:
                                        "color-mix(in srgb, var(--diff-warn) 10%, var(--color-bg-secondary))",
                                    border: "1px solid color-mix(in srgb, var(--diff-warn) 24%, var(--color-border))",
                                    color: "var(--diff-warn)",
                                }}
                            >
                                {tone.badge}
                            </span>
                        ) : null}
                        {trackedFile.previousPath ? (
                            <span
                                className="truncate text-[11px] text-text-secondary"
                                title={trackedFile.previousPath}
                            >
                                from {trackedFile.previousPath}
                            </span>
                        ) : null}
                    </div>
                    <div
                        className="mt-1.5 truncate text-sm font-medium text-text-primary"
                        title={trackedFile.path}
                    >
                        {trackedFile.path}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span style={getStatChipStyle("var(--diff-add)")}>
                            +
                            {formatDiffStat(stats.additions, stats.approximate)}
                        </span>
                        <span style={getStatChipStyle("var(--diff-remove)")}>
                            -
                            {formatDiffStat(stats.deletions, stats.approximate)}
                        </span>
                        <span style={getStatChipStyle(tone.accent)}>
                            {trackedFile.hunks.length} pending hunk
                            {trackedFile.hunks.length === 1 ? "" : "s"}
                        </span>
                        <span
                            className="text-[12px] text-text-secondary"
                            title={summary}
                        >
                            {summary}
                        </span>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {canShowInlineReview ? (
                        <div
                            className="flex items-center gap-1 rounded-full border p-1"
                            style={{
                                backgroundColor:
                                    "color-mix(in srgb, var(--color-bg-secondary) 82%, transparent)",
                                borderColor:
                                    "color-mix(in srgb, var(--color-border) 88%, transparent)",
                            }}
                        >
                            <button
                                className="app-no-drag"
                                onClick={onShowEditor}
                                style={
                                    isInlineReviewVisible
                                        ? unselectedToggleStyle
                                        : selectedToggleStyle
                                }
                                type="button"
                            >
                                Editor
                            </button>
                            <button
                                className="app-no-drag"
                                onClick={onShowInlineReview}
                                style={
                                    isInlineReviewVisible
                                        ? selectedToggleStyle
                                        : unselectedToggleStyle
                                }
                                type="button"
                            >
                                Inline Review
                            </button>
                        </div>
                    ) : (
                        <span
                            className="text-[11px] text-text-secondary"
                            style={{ maxWidth: 220 }}
                        >
                            Inline review is available for text updates only.
                        </span>
                    )}
                    <button
                        className="app-no-drag"
                        onClick={onKeepFile}
                        style={keepButtonStyle}
                        type="button"
                    >
                        Keep File
                    </button>
                    <button
                        className="app-no-drag"
                        disabled={!canRejectFile}
                        onClick={onRejectFile}
                        style={rejectButtonStyle}
                        type="button"
                    >
                        Reject File
                    </button>
                </div>
            </div>

            {trackedFile.hunks.length > 0 ? (
                <div
                    className="mt-3 border-t pt-3"
                    style={{
                        borderTopColor:
                            "color-mix(in srgb, var(--color-border) 76%, transparent)",
                    }}
                >
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
                        <div className="min-w-0 flex-1 overflow-x-auto pb-1">
                            <div className="flex min-w-max items-stretch gap-2">
                                {trackedFile.hunks.map((hunk, index) => {
                                    const isSelected =
                                        hunk.id === selectedHunk?.id;
                                    const hunkStats =
                                        computeReviewHunkStats(hunk);

                                    return (
                                        <button
                                            className="app-no-drag"
                                            key={hunk.id}
                                            onClick={() =>
                                                onSelectHunk(hunk.id)
                                            }
                                            style={{
                                                alignItems: "flex-start",
                                                backgroundColor: isSelected
                                                    ? `color-mix(in srgb, ${tone.accent} 13%, var(--color-bg-secondary))`
                                                    : "color-mix(in srgb, var(--color-bg-secondary) 88%, transparent)",
                                                border: `1px solid ${
                                                    isSelected
                                                        ? `color-mix(in srgb, ${tone.accent} 48%, var(--color-border))`
                                                        : "color-mix(in srgb, var(--color-border) 88%, transparent)"
                                                }`,
                                                borderRadius: 14,
                                                boxShadow: isSelected
                                                    ? `0 0 0 1px color-mix(in srgb, ${tone.accent} 16%, transparent)`
                                                    : "none",
                                                color: isSelected
                                                    ? "var(--color-text-primary)"
                                                    : "var(--color-text-secondary)",
                                                cursor: "pointer",
                                                display: "flex",
                                                flexDirection: "column",
                                                gap: 4,
                                                minWidth: 128,
                                                padding: "8px 10px",
                                                textAlign: "left",
                                                transform: isSelected
                                                    ? "translateY(-1px)"
                                                    : "translateY(0)",
                                                transition:
                                                    "background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease, transform 140ms ease",
                                            }}
                                            title={`Focus ${formatReviewHunkFocusSummary(hunk)}`}
                                            type="button"
                                        >
                                            <div className="flex items-center gap-2">
                                                <span className="text-[11px] font-semibold">
                                                    Hunk {index + 1}
                                                </span>
                                                <span
                                                    className="text-[10px]"
                                                    style={{
                                                        color: isSelected
                                                            ? tone.accent
                                                            : "var(--color-text-secondary)",
                                                    }}
                                                >
                                                    L
                                                    {getSelectedReviewLine(
                                                        hunk,
                                                    )}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 text-[10px]">
                                                {hunkStats.additions > 0 ? (
                                                    <span
                                                        style={{
                                                            color: "var(--diff-add)",
                                                        }}
                                                    >
                                                        +
                                                        {formatDiffStat(
                                                            hunkStats.additions,
                                                        )}
                                                    </span>
                                                ) : null}
                                                {hunkStats.deletions > 0 ? (
                                                    <span
                                                        style={{
                                                            color: "var(--diff-remove)",
                                                        }}
                                                    >
                                                        -
                                                        {formatDiffStat(
                                                            hunkStats.deletions,
                                                        )}
                                                    </span>
                                                ) : null}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                className="app-no-drag"
                                disabled={hunkActionDisabled}
                                onClick={onKeepHunk}
                                style={{
                                    ...keepButtonStyle,
                                    cursor: hunkActionDisabled
                                        ? "not-allowed"
                                        : "pointer",
                                    opacity: hunkActionDisabled ? 0.45 : 1,
                                }}
                                type="button"
                            >
                                Keep Hunk
                            </button>
                            <button
                                className="app-no-drag"
                                disabled={hunkActionDisabled}
                                onClick={onRejectHunk}
                                style={{
                                    ...getDangerButtonStyle(hunkActionDisabled),
                                    ...pillButtonBaseStyle,
                                }}
                                type="button"
                            >
                                Reject Hunk
                            </button>
                        </div>
                    </div>

                    {selectedHunk ? (
                        <div className="mt-2 text-[11px] text-text-secondary">
                            {formatReviewHunkFocusSummary(selectedHunk)}
                        </div>
                    ) : null}

                    {!canResolveHunks ? (
                        <div className="mt-2 text-[11px] text-text-secondary">
                            Hunk-level actions are available for reversible text
                            updates.
                        </div>
                    ) : null}
                </div>
            ) : null}
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
}: {
    readonly kind: "chat" | "file" | "review" | "terminal";
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

function findTrackedFileForDocument(
    sessions: ReturnType<typeof useAiStore.getState>["sessions"],
    document: ProjectFileDocument,
    reviewContext: RuntimeWorkspaceFileReviewContext | null,
): AiTrackedFile | null {
    const pendingTrackedFiles = Object.values(sessions)
        .flatMap((session) => session.snapshot?.trackedFiles ?? [])
        .filter((trackedFile) => trackedFile.reviewState === "pending");

    const contextMatch =
        reviewContext &&
        pendingTrackedFiles.find(
            (trackedFile) =>
                trackedFile.sessionId === reviewContext.sessionId &&
                trackedFile.path === reviewContext.path,
        );

    if (contextMatch) {
        return contextMatch;
    }

    return (
        pendingTrackedFiles
            .filter((trackedFile) =>
                matchesTrackedFileDocument(trackedFile, document),
            )
            .sort((left, right) =>
                right.updatedAt.localeCompare(left.updatedAt),
            )[0] ?? null
    );
}

function matchesTrackedFileDocument(
    trackedFile: AiTrackedFile,
    document: ProjectFileDocument,
): boolean {
    return (
        trackedFile.path === document.relativePath ||
        trackedFile.path === document.absolutePath ||
        trackedFile.previousPath === document.relativePath ||
        trackedFile.previousPath === document.absolutePath
    );
}

function isInlineReviewSupported(trackedFile: AiTrackedFile | null): boolean {
    return Boolean(
        trackedFile &&
        trackedFile.isText &&
        trackedFile.kind === "update" &&
        trackedFile.oldText !== null &&
        trackedFile.newText !== null,
    );
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
