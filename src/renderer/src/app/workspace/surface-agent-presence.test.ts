import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";
import type { RuntimeWorkspaceChatTab } from "@renderer/app/workspace/tree";

import {
    collectWorkspaceSurfaceAiAgentPresence,
} from "./surface-agent-presence";

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
        updatedAt: "2026-08-04T12:00:00.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

describe("collectWorkspaceSurfaceAiAgentPresence", () => {
    it("keeps active sessions visible after their tabs close", () => {
        const result = collectWorkspaceSurfaceAiAgentPresence({
            aiSessions: {
                "closed-idle": {
                    isDispatching: false,
                    snapshot: createSnapshot({
                        sessionId: "closed-idle",
                        status: "idle",
                    }),
                },
                "closed-streaming": {
                    isDispatching: false,
                    snapshot: createSnapshot({
                        sessionId: "closed-streaming",
                        status: "streaming",
                        title: "Background task",
                    }),
                },
                "other-project": {
                    isDispatching: false,
                    snapshot: createSnapshot({
                        projectId: "project-2",
                        sessionId: "other-project",
                        status: "streaming",
                    }),
                },
            },
            projectId: "project-1",
            tabsById: {},
            worktreeId: "worktree-1",
        });

        expect(result).toEqual([
            expect.objectContaining({
                sessionId: "closed-streaming",
                status: "streaming",
                title: "Background task",
            }),
        ]);
    });

    it("keeps idle sessions visible while their chat tabs remain open", () => {
        const chatTab: RuntimeWorkspaceChatTab = {
            createdAt: "2026-08-04T11:00:00.000Z",
            draft: "",
            id: "chat-tab-1",
            kind: "chat",
            projectId: "project-1",
            runtimeId: "codex",
            sessionId: "open-idle",
            title: "Open idle session",
            worktreeId: "worktree-1",
        };
        const result = collectWorkspaceSurfaceAiAgentPresence({
            aiSessions: {
                "open-idle": {
                    isDispatching: false,
                    snapshot: createSnapshot({
                        sessionId: "open-idle",
                        title: "Live idle session",
                    }),
                },
            },
            projectId: "project-1",
            tabsById: { [chatTab.id]: chatTab },
            worktreeId: "worktree-1",
        });

        expect(result).toEqual([
            expect.objectContaining({
                sessionId: "open-idle",
                status: "idle",
                title: "Live idle session",
            }),
        ]);
    });
});
