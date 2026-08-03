import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    resetWorkspacePersistenceForTests,
    useWorkspaceStore,
} from "@renderer/app/store/workspace-store";
import {
    collectPaneNodes,
    createDefaultWorkspaceState,
} from "@renderer/app/workspace/tree";
import { resetTerminalRuntimeStoreForTests } from "./terminalRuntimeStore";
import {
    closeClaudeCodeSidebarSession,
    focusClaudeCodeSidebarSession,
    getClaudeCodeSidebarSessions,
    reconcileClaudeCodeSidebarSessions,
    refreshClaudeCodeSidebarSessionTranscript,
    registerClaudeCodeSidebarSession,
    renameClaudeCodeSidebarSession,
    resetClaudeCodeSidebarSessionsForTests,
} from "./claudeCodeSidebarSession";

const closeTerminalSessionMock = vi.fn(async () => {});
const readClaudeCodeTranscriptMock = vi.fn();

beforeEach(() => {
    resetClaudeCodeSidebarSessionsForTests();
    resetTerminalRuntimeStoreForTests();
    resetWorkspacePersistenceForTests();
    closeTerminalSessionMock.mockClear();
    readClaudeCodeTranscriptMock.mockReset();
    useWorkspaceStore.setState((state) => ({
        ...state,
        ...createDefaultWorkspaceState(),
        error: null,
        hydrated: true,
        lastFocusedChatTabId: null,
        lastFocusedRuntimeId: "codex",
        lastQuickCreateAction: "codex",
        recentActiveTabIds: [],
        recentClosedTabs: [],
        recentFocusedChatTabIds: [],
    }), true);
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            comando: {
                closeTerminalSession: closeTerminalSessionMock,
                readClaudeCodeTranscript: readClaudeCodeTranscriptMock,
            },
        },
        writable: true,
    });
});

describe("Claude Code sidebar session registry", () => {
    it("registers a terminal agent once per terminal id", () => {
        registerClaudeCodeSidebarSession(createRegistryInput());
        registerClaudeCodeSidebarSession(
            createRegistryInput({ title: "Claude Code 2" }),
        );

        expect(getClaudeCodeSidebarSessions()).toMatchObject([
            {
                isTerminalAgent: true,
                runtimeId: "claude-code-terminal",
                sessionId: "claude-code-terminal:terminal-1",
                terminalId: "terminal-1",
                title: "Claude Code 1",
            },
        ]);
    });

    it("focuses the matching terminal tab", async () => {
        const firstTabId = await createTerminalTab("Claude Code 1");
        await createTerminalTab("Terminal 1");
        const session = registerClaudeCodeSidebarSession(
            createRegistryInput({ terminalTabId: firstTabId }),
        );

        await focusClaudeCodeSidebarSession(session);

        expect(getActiveTabId()).toBe(firstTabId);
    });

    it("closes the matching terminal tab and removes the item", async () => {
        const terminalTabId = await createTerminalTab("Claude Code 1");
        const session = registerClaudeCodeSidebarSession(
            createRegistryInput({ terminalTabId }),
        );

        await closeClaudeCodeSidebarSession(session);

        expect(useWorkspaceStore.getState().tabsById[terminalTabId]).toBeUndefined();
        expect(getClaudeCodeSidebarSessions()).toEqual([]);
    });

    it("reconciles away sessions whose terminal tab disappeared", () => {
        registerClaudeCodeSidebarSession(createRegistryInput());

        reconcileClaudeCodeSidebarSessions([]);

        expect(getClaudeCodeSidebarSessions()).toEqual([]);
    });

    it("hydrates title, preview, updatedAt, and automatic tab title from transcript", async () => {
        const terminalTabId = await createTerminalTab("Claude Code 1");
        const session = registerClaudeCodeSidebarSession(
            createRegistryInput({ terminalTabId }),
        );
        readClaudeCodeTranscriptMock.mockResolvedValue({
            changed: true,
            found: true,
            mtimeMs: 123,
            preview: "Here is the implementation plan.",
            title: "Build the launcher",
        });

        await refreshClaudeCodeSidebarSessionTranscript(session);

        expect(getClaudeCodeSidebarSessions()).toMatchObject([
            {
                preview: "Here is the implementation plan.",
                title: "Build the launcher",
                transcriptMtimeMs: 123,
            },
        ]);
        expect(useWorkspaceStore.getState().tabsById[terminalTabId]?.title).toBe(
            "Build the launcher",
        );
    });

    it("keeps manual sidebar and tab titles when transcript refreshes later", async () => {
        const terminalTabId = await createTerminalTab("Claude Code 1");
        const session = registerClaudeCodeSidebarSession(
            createRegistryInput({ terminalTabId }),
        );
        await renameClaudeCodeSidebarSession(session, "Manual title");
        readClaudeCodeTranscriptMock.mockResolvedValue({
            changed: true,
            found: true,
            mtimeMs: 456,
            preview: "Fresh preview",
            title: "Transcript title",
        });

        await refreshClaudeCodeSidebarSessionTranscript(session);

        expect(getClaudeCodeSidebarSessions()).toMatchObject([
            {
                preview: "Fresh preview",
                title: "Manual title",
                transcriptMtimeMs: 456,
            },
        ]);
        expect(useWorkspaceStore.getState().tabsById[terminalTabId]?.title).toBe(
            "Manual title",
        );
    });
});

function createRegistryInput(
    overrides: Partial<Parameters<typeof registerClaudeCodeSidebarSession>[0]> = {},
): Parameters<typeof registerClaudeCodeSidebarSession>[0] {
    return {
        cwd: "/workspace",
        projectId: "project-1",
        terminalId: "terminal-1",
        terminalTabId: "terminal-tab-1",
        title: "Claude Code 1",
        transcriptSessionId: "11111111-1111-4111-8111-111111111111",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

async function createTerminalTab(title: string): Promise<string> {
    const tabId = await useWorkspaceStore.getState().createTerminalTab(
        "project-1",
        "worktree-1",
        { title },
    );
    if (!tabId) {
        throw new Error("Expected terminal tab id.");
    }
    return tabId;
}

function getActiveTabId(): string | null {
    const state = useWorkspaceStore.getState();
    const activePane = collectPaneNodes(state.rootNode).find(
        (pane) => pane.id === state.activePaneId,
    );
    return activePane?.activeTabId ?? null;
}
