/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiHistorySessionSummary,
    AiSessionSnapshot,
    ComandoApi,
} from "@shared/ipc";
import {
    registerClaudeCodeSidebarSession,
    resetClaudeCodeSidebarSessionsForTests,
} from "@renderer/features/terminal/claudeCodeSidebarSession";
import {
    resetAiStoreRuntimeBuffersForTests,
    useAiStore,
} from "@renderer/app/store/ai-store";

import {
    buildSidebarAgentsNewAgentMenuEntries,
    SidebarAgentsPanel,
} from "./SidebarAgentsPanel";
import {
    clearSidebarAgentsHistoryCache,
    writeSidebarAgentsHistoryCache,
} from "./sidebarAgentsHistoryCache";
import {
    persistSidebarAgentsFolderState,
    readSidebarAgentsFolderState,
    type SidebarAgentsFolderState,
} from "./sidebarAgentsFolderState";
import {
    SIDEBAR_AGENT_DRAG_EVENT,
    type SidebarAgentDragDetail,
} from "./sidebarAgentDragEvents";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLDivElement[] = [];

class MemoryStorage implements Storage {
    private readonly values = new Map<string, string>();

    get length() {
        return this.values.size;
    }

    clear() {
        this.values.clear();
    }

    getItem(key: string) {
        return this.values.get(key) ?? null;
    }

    key(index: number) {
        return [...this.values.keys()][index] ?? null;
    }

    removeItem(key: string) {
        this.values.delete(key);
    }

    setItem(key: string, value: string) {
        this.values.set(key, value);
    }
}

afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
        act(() => {
            root.unmount();
        });
    }

    for (const container of mountedContainers.splice(0)) {
        container.remove();
    }
});

function createSummary(
    overrides: Partial<AiHistorySessionSummary> = {},
): AiHistorySessionSummary {
    return {
        createdAt: "2026-04-19T09:00:00.000Z",
        messageCount: 1,
        preview: "Assistant returns a concise answer.",
        projectId: "project-1",
        runtimeId: "codex",
        sessionId: "session-1",
        title: "Cached Session",
        updatedAt: "2026-04-19T10:00:00.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
    return {
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: "project-1",
        runtimeId: "codex",
        runtimeSessionId: "runtime-session-1",
        sessionId: "session-1",
        status: "idle",
        title: "Session",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-19T10:00:00.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

async function mountSidebarAgentsPanel(
    sessions: readonly AiHistorySessionSummary[],
    options: {
        readonly onRequestWorkspaceAction?: Parameters<
            typeof SidebarAgentsPanel
        >[0]["onRequestWorkspaceAction"];
        readonly workspaceContextKey?: string;
    } = {},
): Promise<HTMLDivElement> {
    writeSidebarAgentsHistoryCache(
        "project-1",
        "worktree-1",
        sessions,
        100,
    );
    Object.defineProperty(window, "comando", {
        configurable: true,
        value: {
            checkCommandAvailability: vi.fn().mockResolvedValue({
                found: true,
                path: "/usr/local/bin/claude",
            }),
            listAiSessionHistory: vi.fn().mockResolvedValue(sessions),
            onAiSessionSnapshot: vi.fn(() => () => undefined),
        } satisfies Partial<ComandoApi>,
        writable: true,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountedContainers.push(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    await act(async () => {
        root.render(
            <SidebarAgentsPanel
                onRequestWorkspaceAction={options.onRequestWorkspaceAction}
                projectId="project-1"
                workspaceContextKey={options.workspaceContextKey}
                worktreeId="worktree-1"
            />,
        );
        await Promise.resolve();
    });

    return container;
}

describe("SidebarAgentsPanel workspace surface actions", () => {
    it("requests chat session opening in the active surface", async () => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
        });
        const onRequestWorkspaceAction = vi.fn();
        const session = createSummary();
        const container = await mountSidebarAgentsPanel([session], {
            onRequestWorkspaceAction,
            workspaceContextKey: "project-1::worktree-1",
        });
        const row = container.querySelector<HTMLElement>(
            '.sidebar-agents-row[title="Cached Session"]',
        );

        expect(row).not.toBeNull();
        await act(async () => {
            row?.click();
            await Promise.resolve();
        });

        expect(onRequestWorkspaceAction).toHaveBeenCalledWith({
            contextKey: "project-1::worktree-1",
            kind: "chat-session",
            projectId: "project-1",
            runtimeId: session.runtimeId,
            sessionId: session.sessionId,
            sessionProjectId: session.projectId,
            sessionWorktreeId: session.worktreeId,
            title: session.title,
            worktreeId: "worktree-1",
        });
    });
});

function persistFolderState(
    sessionFolderIds: Readonly<Record<string, string>> = {},
): SidebarAgentsFolderState {
    return persistSidebarAgentsFolderState("project-1", "worktree-1", {
        collapsedFolderIds: [],
        folderOrder: ["research"],
        folders: {
            research: {
                createdAt: 1,
                id: "research",
                name: "Research",
            },
        },
        sessionFolderIds,
    });
}

function getButtonByLabel(label: string): HTMLButtonElement {
    const button = document.body.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
    );
    if (!button) {
        throw new Error(`Expected button labeled "${label}".`);
    }
    return button;
}

function getFolderNameInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Folder name"]',
    );
    if (!input) {
        throw new Error("Expected folder name input.");
    }
    return input;
}

function updateTextInput(input: HTMLInputElement, value: string): void {
    Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

function dispatchPointerEvent(
    target: Element,
    type: "pointerdown" | "pointermove" | "pointerup",
    options: {
        readonly buttons: number;
        readonly clientX: number;
        readonly clientY: number;
        readonly pointerId?: number;
    },
): void {
    const event = new MouseEvent(type, {
        bubbles: true,
        button: type === "pointerdown" ? 0 : -1,
        buttons: options.buttons,
        cancelable: true,
        clientX: options.clientX,
        clientY: options.clientY,
    });
    Object.defineProperty(event, "pointerId", {
        configurable: true,
        value: options.pointerId ?? 1,
    });
    target.dispatchEvent(event);
}

describe("SidebarAgentsPanel history cache", () => {
    beforeEach(() => {
        clearSidebarAgentsHistoryCache();
        resetClaudeCodeSidebarSessionsForTests();
        resetAiStoreRuntimeBuffersForTests();
        useAiStore.setState((state) => ({
            ...state,
            runtimeCatalogById: {},
            runtimeStatusById: {},
            sessions: {},
        }));
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
    });

    it("renders cached sessions immediately for the active scope", () => {
        writeSidebarAgentsHistoryCache(
            "project-1",
            "worktree-1",
            [createSummary()],
            100,
        );

        const markup = renderToStaticMarkup(
            <SidebarAgentsPanel
                projectId="project-1"
                worktreeId="worktree-1"
            />,
        );

        expect(markup).toContain("Cached Session");
        expect(markup).toContain("1 thread");
        expect(markup).not.toContain("Loading...");
    });

    it("renders title-only rows with provider icons", () => {
        const fullTitle =
            "Investigate the model selector behavior without shortening this title";
        writeSidebarAgentsHistoryCache(
            "project-1",
            "worktree-1",
            [createSummary({ title: fullTitle })],
            100,
        );
        const markup = renderToStaticMarkup(
            <SidebarAgentsPanel
                projectId="project-1"
                worktreeId="worktree-1"
            />,
        );

        expect(markup).not.toContain("Use compact thread rows");
        expect(markup).not.toContain("Show thread details");
        expect(markup).toContain('data-provider-icon="codex"');
        expect(markup).toContain("sidebar-agents-provider-slot");
        expect(markup).toContain(fullTitle);
        expect(markup).not.toContain("Assistant returns a concise answer.");
        expect(markup).toContain("sidebar-agents-compact-relative-time");
        expect(markup).not.toContain("1 message");
    });

    it("does not render cached sessions from another worktree scope", () => {
        writeSidebarAgentsHistoryCache(
            "project-1",
            "worktree-a",
            [
                createSummary({
                    sessionId: "session-a",
                    title: "Wrong Worktree Session",
                    worktreeId: "worktree-a",
                }),
            ],
            100,
        );

        const markup = renderToStaticMarkup(
            <SidebarAgentsPanel
                projectId="project-1"
                worktreeId="worktree-b"
            />,
        );

        expect(markup).toContain("Loading...");
        expect(markup).not.toContain("Wrong Worktree Session");
    });

    it("renders cached child agents under a parent referenced by runtime session id", () => {
        writeSidebarAgentsHistoryCache(
            "project-1",
            "worktree-1",
            [
                createSummary({
                    runtimeSessionId: "runtime-parent",
                    sessionId: "parent-session",
                    title: "Parent Thread",
                }),
                createSummary({
                    parentSessionId: "runtime-parent",
                    runtimeSessionId: "runtime-child",
                    sessionId: "child-session",
                    title: "Galileo",
                }),
            ],
            100,
        );

        const markup = renderToStaticMarkup(
            <SidebarAgentsPanel
                projectId="project-1"
                worktreeId="worktree-1"
            />,
        );

        expect(markup.indexOf("Parent Thread")).toBeLessThan(
            markup.indexOf("Galileo"),
        );
        expect(markup).toContain('data-subagent="true"');
        expect(markup).toContain('data-provider-icon="codex"');
    });

    it("renders activity labels at the end of active child agent rows", () => {
        const sessions = [
            createSummary({
                runtimeSessionId: "runtime-parent",
                sessionId: "parent-session",
                title: "Parent Thread",
            }),
            createSummary({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child-finished",
                sessionId: "child-finished",
                title: "Finished Child",
            }),
            createSummary({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child-running",
                sessionId: "child-running",
                title: "Running Child",
            }),
            createSummary({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child-error",
                sessionId: "child-error",
                title: "Errored Child",
            }),
            createSummary({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child-permission",
                sessionId: "child-permission",
                title: "Permission Child",
            }),
            createSummary({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child-input",
                sessionId: "child-input",
                title: "Input Child",
            }),
        ];
        writeSidebarAgentsHistoryCache(
            "project-1",
            "worktree-1",
            sessions,
            100,
        );
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child-finished",
                sessionId: "child-finished",
                status: "idle",
                title: "Finished Child",
            }),
        );
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child-running",
                sessionId: "child-running",
                status: "streaming",
                title: "Running Child",
            }),
        );
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child-error",
                sessionId: "child-error",
                status: "error",
                title: "Errored Child",
            }),
        );
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child-permission",
                sessionId: "child-permission",
                status: "waiting_permission",
                title: "Permission Child",
            }),
        );
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child-input",
                sessionId: "child-input",
                status: "waiting_user_input",
                title: "Input Child",
            }),
        );
        Object.defineProperty(window, "comando", {
            configurable: true,
            value: {
                checkCommandAvailability: vi.fn().mockResolvedValue({
                    found: true,
                    path: "/usr/local/bin/claude",
                }),
                listAiSessionHistory: vi.fn().mockResolvedValue(sessions),
                onAiSessionSnapshot: vi.fn(() => () => undefined),
            } satisfies Partial<ComandoApi>,
            writable: true,
        });

        const container = document.createElement("div");
        document.body.appendChild(container);
        mountedContainers.push(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        act(() => {
            root.render(
                <SidebarAgentsPanel
                    projectId="project-1"
                    worktreeId="worktree-1"
                />,
            );
        });

        const items = Array.from(container.querySelectorAll("li"));
        const finishedItem = items.find((item) =>
            item.textContent?.includes("Finished Child"),
        );
        const runningItem = items.find((item) =>
            item.textContent?.includes("Running Child"),
        );
        const erroredItem = items.find((item) =>
            item.textContent?.includes("Errored Child"),
        );
        const permissionItem = items.find((item) =>
            item.textContent?.includes("Permission Child"),
        );
        const inputItem = items.find((item) =>
            item.textContent?.includes("Input Child"),
        );

        expect(
            container.querySelectorAll(".sidebar-agents-activity-label"),
        ).toHaveLength(4);
        expect(
            container.querySelector(".sidebar-agents-activity-dot"),
        ).toBeNull();
        expect(
            finishedItem?.querySelector(".sidebar-agents-activity-label"),
        ).toBeNull();
        expect(
            runningItem?.querySelector(".sidebar-agents-activity-label")
                ?.textContent,
        ).toBe("Working…");
        expect(
            runningItem?.querySelector(
                ".sidebar-agents-provider-slot .sidebar-agents-activity-label",
            ),
        ).toBeNull();
        expect(
            erroredItem?.querySelector(".sidebar-agents-activity-label")
                ?.textContent,
        ).toBe("Error");
        expect(
            permissionItem?.querySelector(".sidebar-agents-activity-label")
                ?.textContent,
        ).toBe("Waiting permission…");
        expect(
            inputItem?.querySelector(".sidebar-agents-activity-label")
                ?.textContent,
        ).toBe("Waiting input…");
        expect(
            runningItem?.querySelector(".sidebar-agents-main-line")
                ?.lastElementChild?.classList.contains(
                    "sidebar-agents-activity-label",
                ),
        ).toBe(true);
        expect(
            runningItem?.querySelector(
                ".sidebar-agents-compact-relative-time",
            ),
        ).toBeNull();
        expect(
            finishedItem?.querySelector(
                ".sidebar-agents-compact-relative-time",
            ),
        ).not.toBeNull();
    });

    it("renders live Claude Code terminal agents alongside real history", () => {
        writeSidebarAgentsHistoryCache(
            "project-1",
            "worktree-1",
            [
                createSummary({
                    runtimeId: "claude",
                    sessionId: "claude-thread",
                    title: "Claude Thread",
                }),
            ],
            100,
        );
        registerClaudeCodeSidebarSession({
            cwd: "/workspace",
            projectId: "project-1",
            terminalId: "terminal-1",
            terminalTabId: "terminal-tab-1",
            title: "Claude Code 1",
            transcriptSessionId: null,
            worktreeId: "worktree-1",
        });

        const markup = renderToStaticMarkup(
            <SidebarAgentsPanel
                projectId="project-1"
                worktreeId="worktree-1"
            />,
        );

        expect(markup).toContain("Claude Thread");
        expect(markup).toContain("Claude Code 1");
        expect(markup).toContain("Claude Code");
        expect(markup).toContain('data-provider-icon="claude"');
    });
});

describe("SidebarAgentsPanel folders", () => {
    beforeEach(() => {
        clearSidebarAgentsHistoryCache();
        resetClaudeCodeSidebarSessionsForTests();
        resetAiStoreRuntimeBuffersForTests();
        useAiStore.setState((state) => ({
            ...state,
            runtimeCatalogById: {},
            runtimeStatusById: {},
            sessions: {},
        }));
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: new MemoryStorage(),
            writable: true,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        globalThis.localStorage.clear();
    });

    it("creates a folder from the toolbar and renames it from its menu", async () => {
        const container = await mountSidebarAgentsPanel([createSummary()]);

        await act(async () => {
            getButtonByLabel("New folder").click();
            await Promise.resolve();
        });

        let input = getFolderNameInput(container);
        expect(input.value).toBe("New Folder");
        act(() => {
            updateTextInput(input, "  Research   plans  ");
        });
        act(() => {
            input.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "Enter",
                }),
            );
        });

        let folderHeader = container.querySelector<HTMLElement>(
            "[data-agent-folder-header]",
        );
        expect(folderHeader?.textContent).toContain("Research plans");

        await act(async () => {
            folderHeader?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    clientX: 20,
                    clientY: 20,
                }),
            );
            await Promise.resolve();
        });
        await act(async () => {
            getButtonByLabel("Rename Folder").click();
            await Promise.resolve();
        });

        input = getFolderNameInput(container);
        act(() => {
            updateTextInput(input, "Planning");
        });
        act(() => {
            input.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "Enter",
                }),
            );
        });

        folderHeader = container.querySelector<HTMLElement>(
            "[data-agent-folder-header]",
        );
        expect(folderHeader?.textContent).toContain("Planning");
        const persisted = readSidebarAgentsFolderState(
            "project-1",
            "worktree-1",
        );
        expect(persisted.folderOrder).toHaveLength(1);
        expect(
            persisted.folders[persisted.folderOrder[0] ?? ""]?.name,
        ).toBe("Planning");
    });

    it("moves a root session and its hierarchy from the context submenu", async () => {
        persistFolderState();
        const sessions = [
            createSummary({
                runtimeSessionId: "runtime-parent",
                sessionId: "parent-session",
                title: "Parent Thread",
            }),
            createSummary({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child",
                sessionId: "child-session",
                title: "Child Agent",
            }),
        ];
        const container = await mountSidebarAgentsPanel(sessions);
        const parentRow = container.querySelector<HTMLElement>(
            '.sidebar-agents-row[title="Parent Thread"]',
        );
        expect(parentRow).not.toBeNull();

        await act(async () => {
            parentRow?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    clientX: 20,
                    clientY: 20,
                }),
            );
            await Promise.resolve();
        });
        act(() => {
            getButtonByLabel("Move to Folder").click();
        });
        await act(async () => {
            getButtonByLabel("Research").click();
            await Promise.resolve();
        });

        expect(
            readSidebarAgentsFolderState("project-1", "worktree-1")
                .sessionFolderIds,
        ).toEqual({ "parent-session": "research" });
        const folder = container.querySelector<HTMLElement>(
            '[data-agent-folder-id="research"]',
        );
        expect(folder?.textContent).toContain("Parent Thread");
        expect(folder?.textContent).toContain("Child Agent");
    });

    it("collapses a folder and deleting it returns its session to All", async () => {
        persistFolderState({ "session-1": "research" });
        const container = await mountSidebarAgentsPanel([createSummary()]);
        const folderHeader = container.querySelector<HTMLElement>(
            '[data-agent-folder-header="research"]',
        );
        expect(folderHeader?.getAttribute("aria-expanded")).toBe("true");

        act(() => {
            folderHeader?.click();
        });
        expect(folderHeader?.getAttribute("aria-expanded")).toBe("false");
        expect(
            container.querySelector(
                '[data-agent-folder-id="research"] .sidebar-agents-row',
            ),
        ).toBeNull();

        await act(async () => {
            folderHeader?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    clientX: 20,
                    clientY: 20,
                }),
            );
            await Promise.resolve();
        });
        await act(async () => {
            getButtonByLabel("Delete Folder").click();
            await Promise.resolve();
        });

        expect(
            container.querySelector('[data-agent-folder-id="research"]'),
        ).toBeNull();
        const allSection = container.querySelector<HTMLElement>(
            "[data-agent-unfiled-drop-zone]",
        );
        expect(allSection?.textContent).toContain("Cached Session");
        expect(
            readSidebarAgentsFolderState("project-1", "worktree-1")
                .sessionFolderIds,
        ).toEqual({});
    });

    it("consumes an internal folder drop and emits drag cancel", async () => {
        persistFolderState();
        const container = await mountSidebarAgentsPanel([createSummary()]);
        const folder = container.querySelector<HTMLElement>(
            '[data-agent-folder-id="research"]',
        );
        const row = container.querySelector<HTMLElement>(
            '.sidebar-agents-row[title="Cached Session"]',
        );
        if (!folder || !row) {
            throw new Error("Expected folder and session row.");
        }

        const ownElementFromPointDescriptor = Object.getOwnPropertyDescriptor(
            document,
            "elementFromPoint",
        );
        Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: () => folder,
        });
        const phases: string[] = [];
        const handleDrag = (event: Event) => {
            phases.push(
                (event as CustomEvent<SidebarAgentDragDetail>).detail.phase,
            );
        };
        window.addEventListener(SIDEBAR_AGENT_DRAG_EVENT, handleDrag);

        try {
            act(() => {
                dispatchPointerEvent(row, "pointerdown", {
                    buttons: 1,
                    clientX: 0,
                    clientY: 0,
                });
            });
            act(() => {
                dispatchPointerEvent(row, "pointermove", {
                    buttons: 1,
                    clientX: 10,
                    clientY: 0,
                });
            });
            await act(async () => {
                dispatchPointerEvent(row, "pointerup", {
                    buttons: 0,
                    clientX: 10,
                    clientY: 0,
                });
                await Promise.resolve();
            });
        } finally {
            window.removeEventListener(SIDEBAR_AGENT_DRAG_EVENT, handleDrag);
            if (ownElementFromPointDescriptor) {
                Object.defineProperty(
                    document,
                    "elementFromPoint",
                    ownElementFromPointDescriptor,
                );
            } else {
                Reflect.deleteProperty(document, "elementFromPoint");
            }
        }

        expect(phases).toEqual(["start", "cancel"]);
        expect(
            container.querySelector(
                '[data-agent-folder-id="research"] .sidebar-agents-row[title="Cached Session"]',
            ),
        ).not.toBeNull();
        expect(
            readSidebarAgentsFolderState("project-1", "worktree-1")
                .sessionFolderIds,
        ).toEqual({ "session-1": "research" });
    });
});

describe("SidebarAgentsPanel new agent menu", () => {
    it("includes a Claude Code terminal entry without replacing Claude threads", () => {
        const createAgent = vi.fn();
        const openClaudeCodeTerminal = vi.fn();

        const entries = buildSidebarAgentsNewAgentMenuEntries({
            claudeCodeAvailable: true,
            onCreateNewAgentTab: createAgent,
            onOpenClaudeCodeTerminal: openClaudeCodeTerminal,
        });

        const labels = entries.map((entry) =>
            entry.type === "separator" ? "" : entry.label,
        );
        expect(labels).toEqual([
            "New Codex thread",
            "New Claude thread",
            "New Grok thread",
            "New Kilo thread",
            "New OpenCode thread",
            "New Claude Code Terminal",
        ]);

        const claudeEntry = entries.find(
            (entry) =>
                entry.type !== "separator" &&
                entry.label === "New Claude thread",
        );
        const claudeCodeEntry = entries.find(
            (entry) =>
                entry.type !== "separator" &&
                entry.label === "New Claude Code Terminal",
        );
        const grokEntry = entries.find(
            (entry) =>
                entry.type !== "separator" &&
                entry.label === "New Grok thread",
        );

        if (claudeEntry?.type === "separator" || !claudeEntry?.action) {
            throw new Error("Expected Claude thread entry.");
        }
        if (
            claudeCodeEntry?.type === "separator" ||
            !claudeCodeEntry?.action
        ) {
            throw new Error("Expected Claude Code terminal entry.");
        }
        if (grokEntry?.type === "separator" || !grokEntry?.action) {
            throw new Error("Expected Grok thread entry.");
        }

        claudeEntry.action();
        claudeCodeEntry.action();
        grokEntry.action();

        expect(createAgent).toHaveBeenCalledWith("claude");
        expect(createAgent).toHaveBeenCalledWith("grok");
        expect(createAgent).toHaveBeenCalledTimes(2);
        expect(openClaudeCodeTerminal).toHaveBeenCalledTimes(1);
    });

    it("surfaces the non-blocking missing CLI state", () => {
        const entries = buildSidebarAgentsNewAgentMenuEntries({
            claudeCodeAvailable: false,
            onCreateNewAgentTab: vi.fn(),
            onOpenClaudeCodeTerminal: vi.fn(),
        });

        const claudeCodeEntry = entries.find(
            (entry) =>
                entry.type !== "separator" &&
                entry.label === "New Claude Code Terminal",
        );

        expect(claudeCodeEntry).not.toHaveProperty("disabled");
        expect(claudeCodeEntry).toMatchObject({
            title:
                "The claude command was not found in Comando's PATH. Your shell may still resolve it.",
        });
    });
});
