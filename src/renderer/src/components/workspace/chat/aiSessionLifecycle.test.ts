import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot } from "@shared/ipc";

import { getStopAgentConfirmationMessage } from "./aiSessionLifecycle";

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
        runtimeSessionId: null,
        sessionId: "parent",
        status: "idle",
        title: "Parent",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-20T10:00:00.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

describe("getStopAgentConfirmationMessage", () => {
    it("asks for confirmation when stopping a parent with active children", () => {
        const message = getStopAgentConfirmationMessage({
            sessionId: "parent",
            sessions: {
                child: {
                    snapshot: createSnapshot({
                        parentSessionId: "parent",
                        sessionId: "child",
                        status: "streaming",
                        title: "Galileo",
                    }),
                },
                parent: {
                    snapshot: createSnapshot({
                        sessionId: "parent",
                        status: "streaming",
                        title: "Parent",
                    }),
                },
            },
            title: "Parent",
        });

        expect(message).toBe(
            'Stop "Parent"? 1 active child agent (Galileo) will keep running. This only stops the selected thread.',
        );
    });

    it("does not confirm when children are idle", () => {
        expect(
            getStopAgentConfirmationMessage({
                sessionId: "parent",
                sessions: {
                    child: {
                        snapshot: createSnapshot({
                            parentSessionId: "parent",
                            sessionId: "child",
                            status: "idle",
                            title: "Galileo",
                        }),
                    },
                },
                title: "Parent",
            }),
        ).toBeNull();
    });

    it("does not confirm when stopping a child", () => {
        expect(
            getStopAgentConfirmationMessage({
                sessionId: "child",
                sessions: {
                    child: {
                        snapshot: createSnapshot({
                            parentSessionId: "parent",
                            sessionId: "child",
                            status: "streaming",
                            title: "Galileo",
                        }),
                    },
                },
                title: "Galileo",
            }),
        ).toBeNull();
    });
});
