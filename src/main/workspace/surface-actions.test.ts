import { describe, expect, it } from "vitest";

import type {
    PersistedWorkspaceContext,
    WorkspaceSurfaceActionRequest,
} from "@shared/ipc";
import {
    doesWorkspaceSurfaceActionMatchContext,
    isWorkspaceSurfaceActionRequest,
} from "./surface-actions";

const context = {
    contextKey: "project-1::__primary__",
    projectId: "project-1",
    worktreeId: null,
} as const;

const ref = {
    host: "github.com",
    owner: "openai",
    repo: "codex",
} as const;

describe("workspace surface actions", () => {
    it("accepts every supported discriminant", () => {
        const requests: WorkspaceSurfaceActionRequest[] = [
            {
                ...context,
                kind: "file",
                origin: "tree",
                relativePath: "src/index.ts",
            },
            { ...context, kind: "git-history" },
            { ...context, kind: "git-worktree-diff" },
            {
                ...context,
                kind: "chat-session",
                runtimeId: "codex",
                sessionId: "session-1",
                sessionProjectId: "project-1",
                sessionWorktreeId: null,
                title: "Session",
            },
            { ...context, kind: "chat-history" },
            { ...context, kind: "new-chat", runtimeId: "claude" },
            { ...context, kind: "focus-terminal", terminalId: "terminal-1" },
            { ...context, kind: "new-claude-terminal" },
            {
                ...context,
                kind: "github-list",
                listKind: "issues",
                ref,
            },
            {
                ...context,
                itemKind: "pull_request",
                itemNumber: 42,
                kind: "github-item",
                ref,
            },
            {
                ...context,
                files: [{ name: "index.ts", relativePath: "src/index.ts" }],
                forceNewChat: false,
                kind: "add-files-to-chat",
            },
            {
                ...context,
                forceNewChat: true,
                itemKind: "issue",
                items: [
                    {
                        number: 42,
                        title: "Fix routing",
                        url: "https://github.com/openai/codex/issues/42",
                    },
                ],
                kind: "add-github-items-to-chat",
                ref,
            },
        ];

        for (const request of requests) {
            expect(isWorkspaceSurfaceActionRequest(request)).toBe(true);
        }
    });

    it("rejects malformed and unbounded payloads", () => {
        expect(isWorkspaceSurfaceActionRequest(null)).toBe(false);
        expect(
            isWorkspaceSurfaceActionRequest({
                ...context,
                kind: "file",
                origin: "tree",
                relativePath: "",
            }),
        ).toBe(false);
        expect(
            isWorkspaceSurfaceActionRequest({
                ...context,
                kind: "new-chat",
                runtimeId: "unknown",
            }),
        ).toBe(false);
        expect(
            isWorkspaceSurfaceActionRequest({
                ...context,
                files: [],
                forceNewChat: false,
                kind: "add-files-to-chat",
            }),
        ).toBe(false);
        expect(
            isWorkspaceSurfaceActionRequest({
                ...context,
                forceNewChat: false,
                itemKind: "issue",
                items: Array.from({ length: 101 }, (_, index) => ({
                    number: index + 1,
                    title: `Issue ${index + 1}`,
                    url: `https://github.com/openai/codex/issues/${index + 1}`,
                })),
                kind: "add-github-items-to-chat",
                ref,
            }),
        ).toBe(false);
    });

    it("matches only the requested project context", () => {
        const persistedContext: PersistedWorkspaceContext = {
            key: context.contextKey,
            lastActivatedAt: "2026-07-19T00:00:00.000Z",
            projectId: context.projectId,
            workspace: {
                activePaneId: "pane-1",
                rootNode: {
                    activeTabId: null,
                    id: "pane-1",
                    tabIds: [],
                    type: "pane",
                },
                tabs: [],
            },
            worktreeId: null,
        };
        const request: WorkspaceSurfaceActionRequest = {
            ...context,
            kind: "chat-history",
        };

        expect(
            doesWorkspaceSurfaceActionMatchContext(request, persistedContext),
        ).toBe(true);
        expect(
            doesWorkspaceSurfaceActionMatchContext(
                { ...request, worktreeId: "project-1:primary" },
                persistedContext,
            ),
        ).toBe(true);
        expect(
            doesWorkspaceSurfaceActionMatchContext(
                { ...request, contextKey: "project-2::__primary__" },
                persistedContext,
            ),
        ).toBe(false);
        expect(
            doesWorkspaceSurfaceActionMatchContext(
                { ...request, projectId: "project-2" },
                persistedContext,
            ),
        ).toBe(false);
        expect(
            doesWorkspaceSurfaceActionMatchContext(
                { ...request, worktreeId: "worktree-2" },
                persistedContext,
            ),
        ).toBe(false);
    });
});
