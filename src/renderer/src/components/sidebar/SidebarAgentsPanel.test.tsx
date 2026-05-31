import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import type { AiHistorySessionSummary } from "@shared/ipc";

import { SidebarAgentsPanel } from "./SidebarAgentsPanel";
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
});
