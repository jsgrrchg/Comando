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

    it("shows an activity dot only for working child agents", () => {
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

        expect(
            container.querySelectorAll(".sidebar-agents-activity-dot"),
        ).toHaveLength(1);
        expect(
            finishedItem?.querySelector(".sidebar-agents-activity-dot"),
        ).toBeNull();
        expect(
            runningItem?.querySelector(".sidebar-agents-activity-dot"),
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
