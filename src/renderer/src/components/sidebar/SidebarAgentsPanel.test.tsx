import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiHistorySessionSummary } from "@shared/ipc";
import {
    registerClaudeCodeSidebarSession,
    resetClaudeCodeSidebarSessionsForTests,
} from "@renderer/features/terminal/claudeCodeSidebarSession";

import {
    buildSidebarAgentsNewAgentMenuEntries,
    SidebarAgentsPanel,
} from "./SidebarAgentsPanel";
import {
    clearSidebarAgentsHistoryCache,
    writeSidebarAgentsHistoryCache,
} from "./sidebarAgentsHistoryCache";

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

describe("SidebarAgentsPanel history cache", () => {
    beforeEach(() => {
        clearSidebarAgentsHistoryCache();
        resetClaudeCodeSidebarSessionsForTests();
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
        expect(markup).toContain("Agent");
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
        expect(markup).toContain("Terminal");
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

        expect(entries.map((entry) => entry.type === "separator" ? "" : entry.label))
            .toEqual([
                "New Codex thread",
                "New Claude thread",
                "New Gemini thread",
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

        if (claudeEntry?.type === "separator" || !claudeEntry?.action) {
            throw new Error("Expected Claude thread entry.");
        }
        if (
            claudeCodeEntry?.type === "separator" ||
            !claudeCodeEntry?.action
        ) {
            throw new Error("Expected Claude Code terminal entry.");
        }

        claudeEntry.action();
        claudeCodeEntry.action();

        expect(createAgent).toHaveBeenCalledWith("claude");
        expect(createAgent).toHaveBeenCalledTimes(1);
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
