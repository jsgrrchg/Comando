import Editor from "@monaco-editor/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
    useEffect,
    useEffectEvent,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type WheelEvent as ReactWheelEvent,
} from "react";

import type {
    WorkspaceNode,
    WorkspacePaneNode,
    WorkspaceSplitNode,
} from "@shared/ipc";
import { shouldWrapEditorLanguage } from "@shared/editor-language";

import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import {
    collectPaneNodes,
    type RuntimeWorkspaceChatTab,
    type RuntimeWorkspaceFileTab,
    type RuntimeWorkspaceTerminalTab,
} from "@renderer/app/workspace/tree";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "@renderer/components/context-menu/ContextMenu";

interface WorkspaceViewProps {
    readonly defaultProjectId: string | null;
}

type SplitDragState = {
    readonly handleIndex: number;
    readonly startCoordinate: number;
    readonly startSizes: readonly number[];
} | null;

type TabContextMenuPayload = {
    readonly tabId: string;
};

export function WorkspaceView({ defaultProjectId }: WorkspaceViewProps) {
    const rootNode = useWorkspaceStore((state) => state.rootNode);

    return (
        <div className="h-full min-h-0 bg-bg-primary">
            <WorkspaceNodeView
                defaultProjectId={defaultProjectId}
                node={rootNode}
            />
        </div>
    );
}

function WorkspaceNodeView({
    defaultProjectId,
    node,
}: {
    readonly defaultProjectId: string | null;
    readonly node: WorkspaceNode;
}) {
    if (node.type === "pane") {
        return (
            <WorkspacePaneView
                defaultProjectId={defaultProjectId}
                node={node}
            />
        );
    }

    return (
        <WorkspaceSplitView defaultProjectId={defaultProjectId} node={node} />
    );
}

function WorkspaceSplitView({
    defaultProjectId,
    node,
}: {
    readonly defaultProjectId: string | null;
    readonly node: WorkspaceSplitNode;
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
                />
            ))}
        </div>
    );
}

function FragmentPane({
    axis,
    defaultProjectId,
    handleIndex,
    isLast,
    node,
    onPointerDown,
    size,
}: {
    readonly axis: "horizontal" | "vertical";
    readonly defaultProjectId: string | null;
    readonly handleIndex: number;
    readonly isLast: boolean;
    readonly node: WorkspaceNode;
    readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    readonly size: number;
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
                    node={node}
                />
            </div>

            {!isLast ? (
                <div
                    aria-label={`Resize split handle ${handleIndex + 1}`}
                    aria-orientation={
                        axis === "horizontal" ? "vertical" : "horizontal"
                    }
                    className={[
                        "group flex items-center justify-center bg-transparent",
                        axis === "horizontal"
                            ? "w-2 cursor-col-resize"
                            : "h-2 cursor-row-resize",
                    ].join(" ")}
                    onPointerDown={onPointerDown}
                    role="separator"
                >
                    <div
                        className={[
                            "workspace-divider rounded-full bg-border transition-colors group-hover:bg-accent",
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
    node,
}: {
    readonly defaultProjectId: string | null;
    readonly node: WorkspacePaneNode;
}) {
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
    const moveTab = useWorkspaceStore((state) => state.moveTab);
    const paneCount = useWorkspaceStore(
        (state) => collectPaneNodes(state.rootNode).length,
    );
    const selectTab = useWorkspaceStore((state) => state.selectTab);
    const setActivePane = useWorkspaceStore((state) => state.setActivePane);
    const splitPane = useWorkspaceStore((state) => state.splitPane);
    const tabsById = useWorkspaceStore((state) => state.tabsById);
    const updateChatDraft = useWorkspaceStore((state) => state.updateChatDraft);
    const updateFileDraft = useWorkspaceStore((state) => state.updateFileDraft);
    const saveFileTab = useWorkspaceStore((state) => state.saveFileTab);
    const sendTerminalInput = useWorkspaceStore(
        (state) => state.sendTerminalInput,
    );
    const updateTerminalSize = useWorkspaceStore(
        (state) => state.updateTerminalSize,
    );
    const restartTerminalTab = useWorkspaceStore(
        (state) => state.restartTerminalTab,
    );
    const tabStripRef = useRef<HTMLDivElement | null>(null);
    const [tabContextMenu, setTabContextMenu] =
        useState<ContextMenuState<TabContextMenuPayload> | null>(null);

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

        return [
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
            >
                <div className="app-drag flex items-center justify-between border-b border-border bg-[#dfe3ea] px-0">
                    <div
                        className="workspace-tab-strip flex min-w-0 items-end overflow-x-auto overflow-y-hidden"
                        onWheel={handleTabStripWheel}
                        ref={tabStripRef}
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
                                            "group app-no-drag relative flex h-7.75 items-center gap-1.5 border-r border-[#cfd4dd] px-3 text-[12px] transition",
                                            isActive
                                                ? "z-10 bg-white text-[#2d3440] shadow-[inset_0_-2px_0_0_#4b5563]"
                                                : "z-0 bg-[#d7dce4] text-[#6f7784] hover:bg-[#d1d7e0] hover:text-[#4d5562]",
                                        ].join(" ")}
                                        key={tabId}
                                        onClick={() =>
                                            void selectTab(node.id, tabId)
                                        }
                                        onContextMenu={(event) =>
                                            handleTabContextMenu(event, tabId)
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
                                        <span
                                            className={[
                                                "ml-0.5 rounded px-0.5 text-[10px] transition hover:bg-black/5 hover:text-text-primary",
                                                isActive
                                                    ? "text-[#6f7784] opacity-70"
                                                    : "text-[#7b8390] opacity-0 group-hover:opacity-70",
                                            ].join(" ")}
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
                            onClick={() => void createChatTab(defaultProjectId)}
                            title="New chat"
                        />
                        <PaneActionButton
                            label="▸"
                            onClick={() =>
                                void createTerminalTab(defaultProjectId)
                            }
                            title="New terminal"
                        />
                        <span className="mx-1 h-3 w-px bg-border" />
                        <PaneActionButton
                            label="◧"
                            onClick={() => void splitPane(node.id, "left")}
                            title="Split left"
                        />
                        <PaneActionButton
                            label="◨"
                            onClick={() => void splitPane(node.id, "right")}
                            title="Split right"
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
                                onDraftChange={updateFileDraft}
                                onSave={saveFileTab}
                                tab={activeTab}
                            />
                        ) : activeTab.kind === "terminal" ? (
                            <TerminalTabView
                                onResize={updateTerminalSize}
                                onRestart={restartTerminalTab}
                                onSendInput={sendTerminalInput}
                                tab={activeTab}
                            />
                        ) : (
                            <ChatTabView
                                onDraftChange={(draft) =>
                                    void updateChatDraft(activeTab.id, draft)
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
        </>
    );
}

function PaneActionButton({
    label,
    onClick,
    title,
}: {
    readonly label: string;
    readonly onClick: () => void;
    readonly title: string;
}) {
    return (
        <button
            className="app-no-drag rounded px-1.5 py-0.5 text-[11px] text-text-secondary transition hover:bg-bg-tertiary hover:text-text-primary"
            onClick={onClick}
            title={title}
            type="button"
        >
            {label}
        </button>
    );
}

function FileTabView({
    isActivePane,
    onDraftChange,
    onSave,
    tab,
}: {
    readonly isActivePane: boolean;
    readonly onDraftChange: (tabId: string, draft: string) => void;
    readonly onSave: (tabId: string) => Promise<void>;
    readonly tab: RuntimeWorkspaceFileTab;
}) {
    const editorTheme = useMonacoTheme();
    const document = tab.document;

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
            if (
                !(event.metaKey || event.ctrlKey) ||
                event.key.toLowerCase() !== "s"
            ) {
                return;
            }

            event.preventDefault();
            void onSave(tab.id);
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [document, isActivePane, onSave, tab.id]);

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

    const canEdit = !document.isBinary && !document.isTooLarge;

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
            <FilePathBar path={document.absolutePath} />

            <div className="min-h-0 flex-1">
                <Editor
                    language={document.languageId}
                    onChange={(value: string | undefined) =>
                        onDraftChange(tab.id, value ?? "")
                    }
                    options={{
                        automaticLayout: true,
                        fontFamily:
                            '"SF Mono", "JetBrains Mono", "Cascadia Code", monospace',
                        fontLigatures: true,
                        fontSize: 13,
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
            </div>
        </div>
    );
}

function FilePathBar({ path }: { readonly path: string }) {
    return (
        <div className="flex h-6 items-center border-b border-border bg-bg-secondary px-3 text-[10px] leading-none text-text-secondary">
            <div className="min-w-0 truncate" title={path}>
                {path}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
//  Chat mock data & visual components (visual only, no functionality)
// ---------------------------------------------------------------------------

type MockMessage =
    | { id: string; role: "user"; kind: "text"; content: string }
    | { id: string; role: "assistant"; kind: "text"; content: string }
    | {
          id: string;
          role: "assistant";
          kind: "reasoning";
          content: string;
      }
    | {
          id: string;
          role: "assistant";
          kind: "tool";
          label: string;
          target?: string;
          toolKind: string;
          status: "completed" | "in_progress";
      };

const MOCK_MESSAGES: MockMessage[] = [
    {
        id: "1",
        role: "user",
        kind: "text",
        content:
            "Add a /api/projects endpoint that returns all projects for the authenticated user, with pagination support.",
    },
    {
        id: "2",
        role: "assistant",
        kind: "reasoning",
        content:
            "Looking at existing route structure and auth middleware to follow the same patterns.",
    },
    {
        id: "3",
        role: "assistant",
        kind: "tool",
        label: "src/routes/index.ts",
        target: "/project/src/routes/index.ts",
        toolKind: "read",
        status: "completed",
    },
    {
        id: "4",
        role: "assistant",
        kind: "tool",
        label: "src/middleware/auth.ts",
        target: "/project/src/middleware/auth.ts",
        toolKind: "read",
        status: "completed",
    },
    {
        id: "5",
        role: "assistant",
        kind: "reasoning",
        content:
            "Found the route pattern and PaginatedResponse type. Creating the projects endpoint with requireAuth middleware.",
    },
    {
        id: "6",
        role: "assistant",
        kind: "tool",
        label: "src/routes/projects.ts",
        target: "/project/src/routes/projects.ts",
        toolKind: "edit",
        status: "completed",
    },
    {
        id: "7",
        role: "assistant",
        kind: "tool",
        label: "src/routes/index.ts",
        target: "/project/src/routes/index.ts",
        toolKind: "edit",
        status: "completed",
    },
    {
        id: "8",
        role: "assistant",
        kind: "text",
        content:
            "Done. The new endpoint is available at `GET /api/projects` and supports:\n\n- **Authentication** via the existing `requireAuth` middleware\n- **Pagination** with `?page=1&limit=20` query params (defaults to page 1, limit 20)\n- **Response format** includes `items`, `total`, `page`, and `limit`\n\nRunning the existing test suite to make sure nothing broke.",
    },
    {
        id: "9",
        role: "assistant",
        kind: "tool",
        label: "npm test",
        toolKind: "execute",
        status: "completed",
    },
    {
        id: "10",
        role: "assistant",
        kind: "text",
        content: "All 24 tests passing. The endpoint is ready to use.",
    },
    {
        id: "11",
        role: "user",
        kind: "text",
        content:
            "Nice, can you also add filtering by project status? I need active, archived, and all.",
    },
    {
        id: "12",
        role: "assistant",
        kind: "reasoning",
        content:
            "Adding a ?status= query param. Valid values: active, archived, or omit for all.",
    },
    {
        id: "13",
        role: "assistant",
        kind: "tool",
        label: "src/routes/projects.ts",
        target: "/project/src/routes/projects.ts",
        toolKind: "edit",
        status: "in_progress",
    },
];

function ChatUserMessage({ content }: { readonly content: string }) {
    return (
        <div
            className="min-w-0 max-w-full whitespace-pre-wrap rounded-lg px-3 py-2"
            style={{
                color: "var(--color-text-primary)",
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
            }}
        >
            {content}
        </div>
    );
}

function ChatAssistantMessage({ content }: { readonly content: string }) {
    return (
        <div
            className="chat-assistant-content min-w-0 max-w-full"
            style={{
                color: "var(--color-text-primary)",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
                lineHeight: 1.55,
            }}
        >
            {content.split("\n\n").map((paragraph, i) => {
                if (paragraph.startsWith("- **")) {
                    const items = paragraph.split("\n");
                    return (
                        <ul
                            key={i}
                            className="my-1.5 ml-4 list-disc space-y-0.5"
                        >
                            {items.map((item, j) => {
                                const match = item.match(
                                    /^- \*\*(.+?)\*\*(.*)$/,
                                );
                                if (match) {
                                    return (
                                        <li key={j}>
                                            <strong>{match[1]}</strong>
                                            {match[2]}
                                        </li>
                                    );
                                }
                                return (
                                    <li key={j}>{item.replace(/^- /, "")}</li>
                                );
                            })}
                        </ul>
                    );
                }

                const parts: Array<string | React.ReactElement> = [];
                const regex = /`([^`]+)`|\*\*(.+?)\*\*/g;
                let lastIndex = 0;
                let match: RegExpExecArray | null;
                let key = 0;
                while ((match = regex.exec(paragraph)) !== null) {
                    if (match.index > lastIndex) {
                        parts.push(paragraph.slice(lastIndex, match.index));
                    }
                    if (match[1] !== undefined) {
                        parts.push(
                            <code
                                key={key++}
                                className="rounded px-1 py-0.5"
                                style={{
                                    backgroundColor: "var(--color-bg-tertiary)",
                                    fontSize: "0.88em",
                                }}
                            >
                                {match[1]}
                            </code>,
                        );
                    } else if (match[2] !== undefined) {
                        parts.push(<strong key={key++}>{match[2]}</strong>);
                    }
                    lastIndex = match.index + match[0].length;
                }
                if (lastIndex < paragraph.length) {
                    parts.push(paragraph.slice(lastIndex));
                }
                return (
                    <p key={i} className={i > 0 ? "mt-2.5" : ""}>
                        {parts}
                    </p>
                );
            })}
        </div>
    );
}

function ChatReasoningMessage({ content }: { readonly content: string }) {
    return (
        <div className="min-w-0 max-w-full">
            <div
                className="flex items-start gap-1.5 py-0.5"
                style={{
                    color: "var(--color-text-secondary)",
                    fontSize: "0.82em",
                    lineHeight: 1.45,
                    opacity: 0.72,
                }}
            >
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="mt-0.5 shrink-0"
                    style={{ opacity: 0.6 }}
                >
                    <circle cx="6" cy="6" r="4.5" />
                    <path d="M6 4v2.5l1.5 1" />
                </svg>
                <span
                    style={{
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                    }}
                >
                    {content}
                </span>
            </div>
        </div>
    );
}

function ChatToolMessage({
    label,
    target,
    toolKind,
    status,
}: {
    readonly label: string;
    readonly target?: string;
    readonly toolKind: string;
    readonly status: "completed" | "in_progress";
}) {
    const accent = toolKind === "delete" ? "#ef4444" : "#6b7280";
    const isCompleted = status === "completed";
    const isRead = toolKind === "read" || toolKind === "search";

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                border: `1px solid color-mix(in srgb, ${accent} 25%, var(--color-border))`,
                backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--color-bg-secondary))`,
                opacity: isCompleted ? 0.65 : 1,
                transition: "opacity 0.2s ease",
            }}
        >
            <div className="flex items-center gap-2 px-3 py-1.5">
                {isRead ? (
                    <svg
                        width="13"
                        height="13"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke={accent}
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                    >
                        <circle cx="6" cy="6" r="3.5" />
                        <path d="M8.5 8.5L12 12" />
                    </svg>
                ) : (
                    <svg
                        width="13"
                        height="13"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke={accent}
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                    >
                        <path d="M8 1.5H3.5a1 1 0 00-1 1v9a1 1 0 001 1h7a1 1 0 001-1V5L8 1.5z" />
                        <path d="M8 1.5V5h3.5" />
                        <path d="M5 8.5l1.5 1.5L9 7" />
                    </svg>
                )}
                <span
                    className="min-w-0 flex-1 truncate"
                    title={target}
                    style={{
                        color: target
                            ? "var(--color-accent)"
                            : "var(--color-text-primary)",
                        fontSize: "0.83em",
                        fontWeight: 500,
                    }}
                >
                    {label}
                </span>
                {status === "in_progress" ? (
                    <span
                        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
                        style={{ backgroundColor: accent }}
                    />
                ) : (
                    <span
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: "0.72em",
                            opacity: 0.7,
                        }}
                    >
                        done
                    </span>
                )}
            </div>
        </div>
    );
}

function ChatStreamingIndicator() {
    return (
        <div
            className="inline-flex items-center gap-2 py-1"
            style={{
                color: "var(--color-text-secondary)",
                fontSize: "0.74em",
                lineHeight: 1.2,
                opacity: 0.78,
            }}
        >
            <span className="inline-flex items-baseline gap-0.75">
                {[0, 1, 2].map((i) => (
                    <span
                        key={i}
                        className="inline-block rounded-full"
                        style={{
                            width: 5,
                            height: 5,
                            backgroundColor: "var(--color-accent)",
                            opacity: 0.6,
                            animation: `ai-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
                        }}
                    />
                ))}
            </span>
            <span>12s</span>
        </div>
    );
}

function ChatMessageItem({ message }: { readonly message: MockMessage }) {
    if (message.kind === "text" && message.role === "user") {
        return <ChatUserMessage content={message.content} />;
    }
    if (message.kind === "reasoning") {
        return <ChatReasoningMessage content={message.content} />;
    }
    if (message.kind === "tool") {
        return (
            <ChatToolMessage
                label={message.label}
                target={message.target}
                toolKind={message.toolKind}
                status={message.status}
            />
        );
    }
    return <ChatAssistantMessage content={message.content} />;
}

function ChatTabView({
    onDraftChange,
    tab,
}: {
    readonly onDraftChange: (draft: string) => void;
    readonly tab: RuntimeWorkspaceChatTab;
}) {
    return (
        <div
            className="relative flex h-full min-h-0 flex-col"
            style={{ backgroundColor: "var(--color-bg-secondary)" }}
        >
            {/* Message list */}
            <div className="chat-scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3">
                <div className="min-w-0 space-y-2" style={{ fontSize: 14 }}>
                    {MOCK_MESSAGES.map((msg) => (
                        <div key={msg.id} data-chat-row="true">
                            <ChatMessageItem message={msg} />
                        </div>
                    ))}
                    <ChatStreamingIndicator />
                </div>
            </div>

            {/* Composer */}
            <div className="px-3 pb-3 pt-2">
                <div
                    className="relative flex flex-col"
                    style={{
                        border: "1px solid var(--color-border)",
                        borderRadius: 12,
                        backgroundColor: "var(--color-bg-tertiary)",
                    }}
                >
                    <textarea
                        className="app-no-drag w-full resize-none whitespace-pre-wrap break-words"
                        onChange={(event) => onDraftChange(event.target.value)}
                        placeholder="Message Codex — @ to include context, / for commands"
                        value={tab.draft}
                        rows={2}
                        style={{
                            color: "var(--color-text-primary)",
                            backgroundColor: "transparent",
                            border: "none",
                            outline: "none",
                            minHeight: 64,
                            maxHeight: 200,
                            padding: "10px 14px 4px 14px",
                            lineHeight: 1.5,
                            fontSize: 14,
                        }}
                    />
                    <div className="mt-auto flex items-center justify-end gap-2 px-2 pb-1.5">
                        <button
                            type="button"
                            className="flex shrink-0 items-center justify-center rounded-full"
                            style={{
                                width: 28,
                                height: 28,
                                color: tab.draft.trim()
                                    ? "#fff"
                                    : "var(--color-text-secondary)",
                                backgroundColor: tab.draft.trim()
                                    ? "var(--color-accent)"
                                    : "transparent",
                                border: "none",
                                opacity: tab.draft.trim() ? 1 : 0.4,
                                transition: "all 0.15s ease",
                            }}
                            aria-label="Send"
                            title="Send"
                        >
                            <svg
                                width="16"
                                height="16"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M8 12V4M4 7l4-3 4 3" />
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function TerminalTabView({
    onResize,
    onRestart,
    onSendInput,
    tab,
}: {
    readonly onResize: (
        sessionId: string,
        cols: number,
        rows: number,
    ) => Promise<void>;
    readonly onRestart: (tabId: string) => Promise<void>;
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
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-panel px-4 py-2 text-[11px] text-text-secondary">
                <div className="min-w-0 truncate">
                    {tab.session?.cwd ?? "Starting terminal..."}
                </div>
                <div className="flex items-center gap-2">
                    {tab.launchError ? (
                        <span className="text-red-600">{tab.launchError}</span>
                    ) : tab.isReady ? (
                        <span className="text-emerald-600">Running</span>
                    ) : (
                        <span className="text-text-secondary">Idle</span>
                    )}
                    <button
                        className="ide-button app-no-drag px-3 py-1.5"
                        onClick={() => void onRestart(tab.id)}
                        type="button"
                    >
                        Restart
                    </button>
                </div>
            </div>

            <div className="terminal-surface min-h-0 flex-1">
                <div className="h-full w-full px-3 py-2" ref={containerRef} />
            </div>
        </div>
    );
}

function TabIcon({ kind }: { readonly kind: "chat" | "file" | "terminal" }) {
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

function useMonacoTheme(): "vs" | "vs-dark" {
    const [theme, setTheme] = useState<"vs" | "vs-dark">(() =>
        document.documentElement.classList.contains("dark") ? "vs-dark" : "vs",
    );

    useEffect(() => {
        const updateTheme = () => {
            setTheme(
                document.documentElement.classList.contains("dark")
                    ? "vs-dark"
                    : "vs",
            );
        };

        updateTheme();

        const observer = new MutationObserver(updateTheme);
        observer.observe(document.documentElement, {
            attributeFilter: ["class"],
            attributes: true,
        });

        return () => {
            observer.disconnect();
        };
    }, []);

    return theme;
}

function shouldEnableDocumentWrapping(document: {
    readonly languageId: string;
}): boolean {
    return shouldWrapEditorLanguage(document.languageId);
}

function getTerminalTheme() {
    const isDark = document.documentElement.classList.contains("dark");

    return isDark
        ? {
              background: "#1e1f22",
              cursor: "#5b9cf6",
              foreground: "#d4d5d8",
              selectionBackground: "rgba(91, 156, 246, 0.18)",
          }
        : {
              background: "#ffffff",
              cursor: "#3b82f6",
              foreground: "#1f2430",
              selectionBackground: "rgba(59, 130, 246, 0.16)",
          };
}
