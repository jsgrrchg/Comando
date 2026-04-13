import Editor from "@monaco-editor/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
    useEffect,
    useEffectEvent,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";

import type {
    WorkspaceNode,
    WorkspacePaneNode,
    WorkspaceSplitNode,
} from "@shared/ipc";

import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import {
    collectPaneNodes,
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
    const activePaneId = useWorkspaceStore((state) => state.activePaneId);
    const error = useWorkspaceStore((state) => state.error);
    const rootNode = useWorkspaceStore((state) => state.rootNode);
    const tabsById = useWorkspaceStore((state) => state.tabsById);

    const paneCount = useMemo(
        () => collectPaneNodes(rootNode).length,
        [rootNode],
    );
    const tabCount = Object.keys(tabsById).length;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border bg-bg-secondary px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="rounded border border-border bg-bg-elevated px-2 py-1 text-[11px] font-medium text-text-secondary">
                            Workspace
                        </span>
                        <span className="truncate text-[11px] text-text-secondary">
                            {paneCount} pane{paneCount === 1 ? "" : "s"} ·{" "}
                            {tabCount} tab
                            {tabCount === 1 ? "" : "s"}
                        </span>
                    </div>

                    {error ? (
                        <span className="truncate text-[11px] text-red-600">
                            {error}
                        </span>
                    ) : (
                        <span className="text-[11px] text-text-secondary">
                            Active pane: {activePaneId}
                        </span>
                    )}
                </div>
            </div>

            <div className="min-h-0 flex-1 bg-bg-primary">
                <WorkspaceNodeView
                    defaultProjectId={defaultProjectId}
                    node={rootNode}
                />
            </div>
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
    const moveActiveTab = useWorkspaceStore((state) => state.moveActiveTab);
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

    const activeTab = node.activeTabId ? tabsById[node.activeTabId] : null;
    const isActivePane = activePaneId === node.id;

    return (
        <section
            className={[
                "flex h-full min-h-0 flex-col border bg-bg-primary",
                isActivePane ? "border-accent/45" : "border-transparent",
            ].join(" ")}
            onMouseDown={() => void setActivePane(node.id)}
        >
            <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-panel px-2 py-1.5">
                <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                    {node.tabIds.length === 0 ? (
                        <span className="px-2 text-[11px] text-text-secondary">
                            Empty pane
                        </span>
                    ) : (
                        node.tabIds.map((tabId) => {
                            const tab = tabsById[tabId];
                            if (!tab) {
                                return null;
                            }

                            return (
                                <div
                                    className={[
                                        "group flex items-center gap-1 rounded-md border px-1 py-1 text-xs transition",
                                        tabId === node.activeTabId
                                            ? "border-accent bg-accent-soft text-accent-strong"
                                            : "border-transparent text-text-secondary hover:border-border hover:bg-bg-secondary hover:text-text-primary",
                                    ].join(" ")}
                                    key={tabId}
                                >
                                    <button
                                        className="app-no-drag flex min-w-0 items-center gap-2 rounded px-1.5 py-0.5"
                                        onClick={() =>
                                            void selectTab(node.id, tabId)
                                        }
                                        type="button"
                                    >
                                        <span className="text-[10px] uppercase tracking-[0.12em]">
                                            {getTabLabel(tab.kind)}
                                        </span>
                                        <span className="truncate">
                                            {tab.title}
                                        </span>
                                        {"isDirty" in tab && tab.isDirty ? (
                                            <span className="text-[11px] text-amber-600">
                                                ●
                                            </span>
                                        ) : null}
                                    </button>
                                    <button
                                        className="rounded px-1 text-[10px] text-text-secondary transition hover:bg-bg-tertiary hover:text-text-primary"
                                        onClick={() => void closeTab(tabId)}
                                        type="button"
                                    >
                                        ×
                                    </button>
                                </div>
                            );
                        })
                    )}
                </div>

                <div className="flex items-center gap-1">
                    <PaneActionButton
                        label="Chat"
                        onClick={() => void createChatTab(defaultProjectId)}
                    />
                    <PaneActionButton
                        label="Terminal"
                        onClick={() => void createTerminalTab(defaultProjectId)}
                    />
                    <PaneActionButton
                        label="←"
                        onClick={() => void moveActiveTab(node.id, "previous")}
                    />
                    <PaneActionButton
                        label="→"
                        onClick={() => void moveActiveTab(node.id, "next")}
                    />
                    <PaneActionButton
                        label="◧"
                        onClick={() => void splitPane(node.id, "left")}
                    />
                    <PaneActionButton
                        label="◨"
                        onClick={() => void splitPane(node.id, "right")}
                    />
                    <PaneActionButton
                        label="▤"
                        onClick={() => void splitPane(node.id, "up")}
                    />
                    <PaneActionButton
                        label="▥"
                        onClick={() => void splitPane(node.id, "down")}
                    />
                    <PaneActionButton
                        label="×"
                        onClick={() => void closePane(node.id)}
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
                        <div>
                            <p className="text-sm font-medium text-text-primary">
                                This pane is ready
                            </p>
                            <p className="mt-2 text-sm leading-6 text-text-secondary">
                                Open a file from the project tree, start a chat
                                or launch a terminal here.
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}

function PaneActionButton({
    label,
    onClick,
}: {
    readonly label: string;
    readonly onClick: () => void;
}) {
    return (
        <button
            className="app-no-drag rounded border border-transparent px-2 py-1 text-[11px] text-text-secondary transition hover:border-border hover:bg-bg-secondary hover:text-text-primary"
            onClick={onClick}
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
                <div className="border-b border-border bg-bg-panel px-4 py-2 text-[11px] text-text-secondary">
                    {document.relativePath} · {document.languageHint}
                </div>
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
            <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-panel px-4 py-2 text-[11px] text-text-secondary">
                <div className="min-w-0 truncate">
                    {document.relativePath} · {document.languageHint}
                </div>
                <div className="flex items-center gap-2">
                    {tab.saveError ? (
                        <span className="text-red-600">{tab.saveError}</span>
                    ) : null}
                    <span
                        className={
                            tab.isDirty ? "text-amber-600" : "text-emerald-600"
                        }
                    >
                        {tab.isSaving
                            ? "Saving..."
                            : tab.isDirty
                              ? "Unsaved changes"
                              : "Saved"}
                    </span>
                    <button
                        className="ide-button app-no-drag px-3 py-1.5"
                        disabled={!tab.isDirty || tab.isSaving}
                        onClick={() => void onSave(tab.id)}
                        type="button"
                    >
                        Save
                    </button>
                </div>
            </div>

            <div className="min-h-0 flex-1">
                <Editor
                    language={resolveMonacoLanguage(
                        document.languageHint,
                        document.relativePath,
                    )}
                    onChange={(value) => onDraftChange(tab.id, value ?? "")}
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
                        wordWrap: "off",
                    }}
                    path={document.absolutePath}
                    theme={editorTheme}
                    value={tab.draftContent}
                />
            </div>

            <div className="border-t border-border bg-bg-panel px-4 py-2 text-[11px] text-text-secondary">
                Search is built in. Use{" "}
                {navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+F
                {" · "}
                Save with {navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}
                +S
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

function getTabLabel(kind: "chat" | "file" | "terminal"): string {
    if (kind === "file") {
        return "File";
    }

    if (kind === "terminal") {
        return "Term";
    }

    return "Chat";
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

function resolveMonacoLanguage(
    languageHint: string,
    relativePath: string,
): string {
    const extension = relativePath.split(".").at(-1)?.toLowerCase() ?? "";
    const normalizedHint = languageHint.toLowerCase();

    if (normalizedHint === "ts" || extension === "ts") {
        return "typescript";
    }

    if (normalizedHint === "tsx" || extension === "tsx") {
        return "typescript";
    }

    if (normalizedHint === "js" || extension === "js") {
        return "javascript";
    }

    if (normalizedHint === "jsx" || extension === "jsx") {
        return "javascript";
    }

    if (normalizedHint === "md" || extension === "md") {
        return "markdown";
    }

    if (normalizedHint === "json" || extension === "json") {
        return "json";
    }

    if (normalizedHint === "css" || extension === "css") {
        return "css";
    }

    if (normalizedHint === "html" || extension === "html") {
        return "html";
    }

    if (normalizedHint === "yml" || normalizedHint === "yaml") {
        return "yaml";
    }

    if (normalizedHint === "sh" || extension === "sh") {
        return "shell";
    }

    return normalizedHint || "plaintext";
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
