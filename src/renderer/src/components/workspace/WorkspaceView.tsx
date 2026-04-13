import Editor from "@monaco-editor/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
    useEffect,
    useEffectEvent,
    useRef,
    useState,
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
    type RuntimeWorkspaceChatTab,
    type RuntimeWorkspaceFileTab,
    type RuntimeWorkspaceTerminalTab,
} from "@renderer/app/workspace/tree";

interface WorkspaceViewProps {
    readonly defaultProjectId: string | null;
}

type SplitDragState = {
    readonly handleIndex: number;
    readonly startCoordinate: number;
    readonly startSizes: readonly number[];
} | null;

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
    const closePane = useWorkspaceStore((state) => state.closePane);
    const closeTab = useWorkspaceStore((state) => state.closeTab);
    const createChatTab = useWorkspaceStore((state) => state.createChatTab);
    const createTerminalTab = useWorkspaceStore(
        (state) => state.createTerminalTab,
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

    return (
        <section
            className={[
                "flex h-full min-h-0 flex-col border bg-bg-primary",
                isActivePane ? "border-border-strong" : "border-transparent",
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
                        onClick={() => void createTerminalTab(defaultProjectId)}
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

function ChatTabView({
    onDraftChange,
    tab,
}: {
    readonly onDraftChange: (draft: string) => void;
    readonly tab: RuntimeWorkspaceChatTab;
}) {
    return (
        <div className="flex h-full min-h-0 flex-col justify-between">
            <div className="flex flex-1 items-center justify-center px-6 text-center">
                <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">
                        Chat Session
                    </p>
                    <h3 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-text-primary">
                        {tab.title}
                    </h3>
                    <p className="mt-3 max-w-xl text-sm leading-6 text-text-secondary">
                        This pane is ready for an ACP session. Files, chats and
                        terminals now share the same split-pane workspace model.
                    </p>
                </div>
            </div>

            <div className="border-t border-border bg-bg-panel px-4 py-4">
                <textarea
                    className="ide-input app-no-drag min-h-24 resize-none"
                    onChange={(event) => onDraftChange(event.target.value)}
                    placeholder="Type the first message for this ACP session..."
                    value={tab.draft}
                />
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
