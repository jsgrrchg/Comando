import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppTerminalSettings } from "@shared/terminal-settings";
import { DEFAULT_APP_TERMINAL_SETTINGS } from "@shared/terminal-settings";
import { useAiStore } from "@renderer/app/store/ai-store";
import { useSettingsStore } from "@renderer/app/store/settings-store";
import {
    resetWorkspacePersistenceForTests,
    useWorkspaceStore,
} from "@renderer/app/store/workspace-store";
import { createDefaultWorkspaceState } from "@renderer/app/workspace/tree";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
    type WorkspaceTerminalRuntime,
} from "./terminalRuntimeStore";
import {
    buildShellCommand,
    checkClaudeCodeInstalled,
    getClaudeCodeTerminalSidebarItemsForTests,
    getNextClaudeCodeTerminalTitle,
    getSafeClaudeCodeModel,
    launchClaudeCodeTerminal,
    resetClaudeCodeTerminalStateForTests,
} from "./claudeCodeTerminal";

const checkCommandAvailabilityMock = vi.fn();
const saveWorkspaceSnapshotMock = vi.fn(async () => {});
const writeTerminalInputMock = vi.fn(async () => {});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("checkClaudeCodeInstalled", () => {
    beforeEach(() => {
        resetClaudeCodeTerminalStateForTests();
        checkCommandAvailabilityMock.mockReset();
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    checkCommandAvailability: checkCommandAvailabilityMock,
                },
            },
            writable: true,
        });
    });

    it("checks Claude Code availability through IPC and caches the result", async () => {
        checkCommandAvailabilityMock
            .mockResolvedValueOnce({ found: true, path: "/usr/local/bin/claude" })
            .mockResolvedValueOnce({ found: false, path: null });

        await expect(checkClaudeCodeInstalled()).resolves.toBe(true);
        await expect(checkClaudeCodeInstalled()).resolves.toBe(true);

        expect(checkCommandAvailabilityMock).toHaveBeenCalledTimes(1);
        expect(checkCommandAvailabilityMock).toHaveBeenCalledWith({
            name: "claude",
        });
    });

    it("caches false when the bridge check fails", async () => {
        checkCommandAvailabilityMock.mockRejectedValueOnce(new Error("boom"));

        await expect(checkClaudeCodeInstalled()).resolves.toBe(false);
        await expect(checkClaudeCodeInstalled()).resolves.toBe(false);

        expect(checkCommandAvailabilityMock).toHaveBeenCalledTimes(1);
    });
});

describe("Claude Code terminal launcher", () => {
    beforeEach(() => {
        resetClaudeCodeTerminalStateForTests();
        resetTerminalRuntimeStoreForTests();
        resetWorkspacePersistenceForTests();
        saveWorkspaceSnapshotMock.mockClear();
        writeTerminalInputMock.mockClear();
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
        useAiStore.setState((state) => ({
            ...state,
            runtimeCatalogById: {},
            runtimeStatusById: {},
            sessions: {},
        }));
        useSettingsStore.setState({
            terminal: DEFAULT_APP_TERMINAL_SETTINGS,
        });
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    saveWorkspaceSnapshot: saveWorkspaceSnapshotMock,
                    writeTerminalInput: writeTerminalInputMock,
                },
            },
            writable: true,
        });
    });

    it("launches Claude Code with a pinned transcript session id by default", async () => {
        mockRandomUuids([
            "terminal-id-1",
            "terminal-tab-1",
            "transcript-session-1",
        ]);

        const launchPromise = launchClaudeCodeTerminal({
            projectId: "project-1",
            timeoutMs: 1000,
            worktreeId: "worktree-1",
        });
        await flushPromises();
        markLatestTerminalRunning("/workspace");

        await expect(launchPromise).resolves.toEqual({
            commandWritten: true,
            terminalId: "terminal-id-1",
            terminalTabId: "terminal-tab-1",
            transcriptSessionId: "transcript-session-1",
        });
        expect(writeTerminalInputMock).toHaveBeenCalledWith({
            data: "claude --session-id transcript-session-1\n",
            sessionId: "pty-terminal-id-1",
        });
        expect(getClaudeCodeTerminalSidebarItemsForTests()).toMatchObject([
            {
                cwd: "/workspace",
                isTerminalAgent: true,
                projectId: "project-1",
                runtimeId: "claude-code-terminal",
                runtimeSessionId: "transcript-session-1",
                sessionId: "claude-code-terminal:terminal-id-1",
                terminalId: "terminal-id-1",
                terminalTabId: "terminal-tab-1",
                title: "Claude Code 1",
                transcriptMtimeMs: null,
                transcriptSessionId: "transcript-session-1",
                worktreeId: "worktree-1",
            },
        ]);
        expect(useAiStore.getState().sessions).toEqual({});
    });

    it("uses --continue without adding a transcript session id", async () => {
        useSettingsStore.setState({
            terminal: createTerminalSettings({
                claudeCodeContinueSession: true,
            }),
        });
        mockRandomUuids(["terminal-id-1", "terminal-tab-1"]);

        const launchPromise = launchClaudeCodeTerminal({
            projectId: "project-1",
            timeoutMs: 1000,
        });
        await flushPromises();
        markLatestTerminalRunning("/workspace");

        await expect(launchPromise).resolves.toMatchObject({
            commandWritten: true,
            terminalId: "terminal-id-1",
            terminalTabId: "terminal-tab-1",
            transcriptSessionId: null,
        });
        expect(writeTerminalInputMock).toHaveBeenCalledWith({
            data: "claude --continue\n",
            sessionId: "pty-terminal-id-1",
        });
        expect(getClaudeCodeTerminalSidebarItemsForTests()).toMatchObject([
            {
                runtimeSessionId: null,
                sessionId: "claude-code-terminal:terminal-id-1",
                transcriptSessionId: null,
                title: "Claude Code 1",
            },
        ]);
    });

    it("adds supported Claude Code flags and ignores interactive-only max turns", async () => {
        useSettingsStore.setState({
            terminal: createTerminalSettings({
                claudeCodeMaxTurns: 12,
                claudeCodeModel: "claude-sonnet-4-6",
                claudeCodeSkipPermissions: true,
            }),
        });
        mockRandomUuids([
            "terminal-id-1",
            "terminal-tab-1",
            "transcript-session-1",
        ]);

        const launchPromise = launchClaudeCodeTerminal({
            projectId: "project-1",
            timeoutMs: 1000,
        });
        await flushPromises();
        markLatestTerminalRunning("/workspace");
        await launchPromise;

        expect(writeTerminalInputMock).toHaveBeenCalledWith({
            data:
                "claude --dangerously-skip-permissions --session-id transcript-session-1 --model claude-sonnet-4-6\n",
            sessionId: "pty-terminal-id-1",
        });
    });

    it("does not write the command when the terminal never reaches running", async () => {
        mockRandomUuids(["terminal-id-1", "terminal-tab-1"]);

        await expect(
            launchClaudeCodeTerminal({
                projectId: "project-1",
                timeoutMs: 0,
            }),
        ).resolves.toEqual({
            commandWritten: false,
            terminalId: "terminal-id-1",
            terminalTabId: "terminal-tab-1",
            transcriptSessionId: null,
        });
        expect(writeTerminalInputMock).not.toHaveBeenCalled();
        expect(getClaudeCodeTerminalSidebarItemsForTests()).toEqual([]);
    });

    it("ignores unsafe models and rejects unsafe shell tokens", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(getSafeClaudeCodeModel("claude-opus-4-7")).toBe(
            "claude-opus-4-7",
        );
        for (const model of ["bad\nmodel", "bad;model", "`bad`", '"bad"']) {
            expect(getSafeClaudeCodeModel(model)).toBeNull();
        }
        expect(() => buildShellCommand(["claude", "hello;world"])).toThrow(
            /Unsafe shell token/,
        );
        expect(buildShellCommand(["claude", "--max-turns", "1"])).toBe(
            "claude --max-turns 1\n",
        );
        expect(warnSpy).toHaveBeenCalledTimes(4);
    });

    it("increments Claude Code titles independently from normal terminals", async () => {
        await useWorkspaceStore.getState().createTerminalTab("project-1", null, {
            title: "Terminal 1",
        });
        await useWorkspaceStore.getState().createTerminalTab("project-1", null, {
            title: "Claude Code 1",
        });

        expect(
            getNextClaudeCodeTerminalTitle(
                Object.values(useWorkspaceStore.getState().tabsById),
            ),
        ).toBe("Claude Code 2");
    });
});

function createTerminalSettings(
    overrides: Partial<AppTerminalSettings>,
): AppTerminalSettings {
    return {
        ...DEFAULT_APP_TERMINAL_SETTINGS,
        ...overrides,
    };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function mockRandomUuids(values: readonly string[]): void {
    let index = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
        const value = values[index];
        index += 1;
        return (value ?? `uuid-${index}`) as ReturnType<
            Crypto["randomUUID"]
        >;
    });
}

function markLatestTerminalRunning(cwd: string): void {
    const terminalTab = Object.values(useWorkspaceStore.getState().tabsById)
        .filter((tab) => tab.kind === "terminal")
        .at(-1);
    if (!terminalTab || terminalTab.kind !== "terminal") {
        throw new Error("Expected a terminal tab.");
    }

    useTerminalRuntimeStore.setState({
        runtimesById: {
            [terminalTab.terminalId]: createRuntime(terminalTab.terminalId, cwd),
        },
    });
}

function createRuntime(
    terminalId: string,
    cwd: string,
): WorkspaceTerminalRuntime {
    return {
        busy: false,
        hasOutput: false,
        launchError: null,
        projectId: "project-1",
        sessionGeneration: 1,
        sessionId: `pty-${terminalId}`,
        snapshot: {
            cols: 120,
            cwd,
            displayName: "Shell",
            errorMessage: null,
            exitCode: null,
            program: "",
            rows: 24,
            sessionId: `pty-${terminalId}`,
            status: "running",
        },
        tabId: `${terminalId}-tab`,
        terminalId,
        worktreeId: "worktree-1",
    };
}
