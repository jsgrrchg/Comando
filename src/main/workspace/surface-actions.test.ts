import { describe, expect, it } from "vitest";

import type {
    PersistedWorkspaceContext,
    WorkspaceSurfaceActionRequest,
    WorkspaceSurfaceActiveFileState,
    WorkspaceSurfaceAgentPresenceState,
    WorkspaceSurfaceFileRevealRequest,
} from "@shared/ipc";
import {
    doesWorkspaceSurfaceActionMatchContext,
    isWorkspaceSurfaceActiveFileState,
    isWorkspaceSurfaceAgentPresenceState,
    isWorkspaceSurfaceFileRevealRequest,
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

    it("accepts only a bounded, scoped surface file reveal", () => {
        const request: WorkspaceSurfaceFileRevealRequest = {
            ...context,
            relativePath: "src/index.ts",
        };
        expect(isWorkspaceSurfaceFileRevealRequest(request)).toBe(true);
        expect(
            isWorkspaceSurfaceFileRevealRequest({ ...request, relativePath: "" }),
        ).toBe(false);
        expect(
            isWorkspaceSurfaceFileRevealRequest({
                projectId: context.projectId,
                relativePath: request.relativePath,
                worktreeId: null,
            }),
        ).toBe(false);
    });

    it("accepts compact, scoped agent presence without transcript data", () => {
        const presence: WorkspaceSurfaceAgentPresenceState = {
            ...context,
            activeSessionId: "session-1",
            sessions: [
                {
                    createdAt: "2026-08-04T12:00:00.000Z",
                    parentSessionId: null,
                    runtimeId: "codex",
                    runtimeSessionId: "runtime-1",
                    sessionId: "session-1",
                    status: "streaming",
                    title: "Live session",
                    updatedAt: "2026-08-04T12:00:01.000Z",
                },
            ],
        };

        expect(isWorkspaceSurfaceAgentPresenceState(presence)).toBe(true);
        expect(
            isWorkspaceSurfaceAgentPresenceState({
                ...presence,
                sessions: [{ ...presence.sessions[0], title: "" }],
            }),
        ).toBe(false);
        expect(
            isWorkspaceSurfaceAgentPresenceState({
                ...presence,
                sessions: Array.from({ length: 101 }, () => presence.sessions[0]),
            }),
        ).toBe(false);
    });

    it("accepts active file updates and an explicit clear", () => {
        const state: WorkspaceSurfaceActiveFileState = {
            ...context,
            relativePath: "src/index.ts",
        };

        expect(isWorkspaceSurfaceActiveFileState(state)).toBe(true);
        expect(
            isWorkspaceSurfaceActiveFileState({
                ...state,
                relativePath: null,
            }),
        ).toBe(true);
        expect(
            isWorkspaceSurfaceActiveFileState({
                ...state,
                relativePath: "",
            }),
        ).toBe(false);
        expect(
            isWorkspaceSurfaceActiveFileState({
                projectId: context.projectId,
                relativePath: state.relativePath,
                worktreeId: null,
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
