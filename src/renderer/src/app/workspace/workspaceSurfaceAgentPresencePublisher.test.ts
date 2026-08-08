import { describe, expect, it, vi } from "vitest";

import type {
    AiSessionSnapshot,
    WorkspaceSurfaceAgentPresenceState,
    WorkspaceChatTab,
} from "@shared/ipc";

import { createWorkspaceSurfaceAgentPresencePublisher } from "./workspaceSurfaceAgentPresencePublisher";

describe("workspaceSurfaceAgentPresencePublisher", () => {
    it("throttles updatedAt-only bursts and publishes the latest revision", async () => {
        let now = 0;
        let sessions = { "session-1": sessionState() };
        const aiListeners = new Set<() => void>();
        const timers: Array<() => void> = [];
        const published: WorkspaceSurfaceAgentPresenceState[] = [];
        const publisher = createWorkspaceSurfaceAgentPresencePublisher({
            getAiSessions: () => sessions,
            getWorkspaceProjection: workspaceProjection,
            now: () => now,
            publish: (state) => {
                published.push(state);
                return Promise.resolve({ delivered: true });
            },
            setTimer: (callback) => {
                timers.push(callback);
                return timers.length;
            },
            clearTimer: () => undefined,
            subscribeAiSessions: (listener) => subscribe(aiListeners, listener),
            subscribeWorkspace: () => () => undefined,
        });
        publisher.updateContext(publisherContext());
        await settle();

        for (let index = 1; index <= 10_000; index += 1) {
            sessions = {
                "session-1": sessionState({
                    updatedAt: new Date(index).toISOString(),
                }),
            };
            for (const listener of aiListeners) listener();
        }
        await settle();

        expect(published).toHaveLength(1);
        expect(timers).toHaveLength(1);
        now = 1_000;
        timers[0]?.();
        await settle();
        expect(published).toHaveLength(2);
        expect(published[1]?.sessions[0]?.updatedAt).toBe(
            new Date(10_000).toISOString(),
        );
        publisher.dispose();
    });

    it("publishes semantic changes immediately inside the temporal window", async () => {
        let sessions = { "session-1": sessionState() };
        const listeners = new Set<() => void>();
        const published: WorkspaceSurfaceAgentPresenceState[] = [];
        const publish = vi.fn((state: WorkspaceSurfaceAgentPresenceState) => {
            published.push(state);
            return Promise.resolve({ delivered: true });
        });
        const publisher = createWorkspaceSurfaceAgentPresencePublisher({
            getAiSessions: () => sessions,
            getWorkspaceProjection: workspaceProjection,
            now: () => 0,
            publish,
            subscribeAiSessions: (listener) => subscribe(listeners, listener),
            subscribeWorkspace: () => () => undefined,
        });
        publisher.updateContext(publisherContext());
        await settle();

        sessions = {
            "session-1": sessionState({
                status: "streaming",
                title: "New title",
            }),
        };
        for (const listener of listeners) listener();
        await settle();

        expect(publish).toHaveBeenCalledTimes(2);
        expect(published[1]?.sessions[0]).toMatchObject({
            status: "streaming",
            title: "New title",
        });
        publisher.dispose();
    });

    it("keeps one publication in flight and sends only the latest pending state", async () => {
        let sessions = { "session-1": sessionState() };
        const listeners = new Set<() => void>();
        const published: WorkspaceSurfaceAgentPresenceState[] = [];
        const resolvers: Array<() => void> = [];
        const publisher = createWorkspaceSurfaceAgentPresencePublisher({
            getAiSessions: () => sessions,
            getWorkspaceProjection: workspaceProjection,
            publish: (state) => {
                published.push(state);
                return new Promise((resolve) => {
                    resolvers.push(() => resolve({ delivered: true }));
                });
            },
            subscribeAiSessions: (listener) => subscribe(listeners, listener),
            subscribeWorkspace: () => () => undefined,
        });
        publisher.updateContext(publisherContext());

        for (const title of ["Second", "Third", "Latest"]) {
            sessions = { "session-1": sessionState({ title }) };
            for (const listener of listeners) listener();
        }
        expect(published).toHaveLength(1);
        resolvers[0]?.();
        await settle();

        expect(published).toHaveLength(2);
        expect(published[1]?.sessions[0]?.title).toBe("Latest");
        resolvers[1]?.();
        await settle();
        publisher.dispose();
    });
});

function publisherContext() {
    return {
        contextKey: "project-1:worktree-1",
        lifecycle: "visible" as const,
        projectId: "project-1",
        terminalSessions: [],
        worktreeId: "worktree-1",
    };
}

function workspaceProjection() {
    const tab: WorkspaceChatTab = {
        createdAt: "2026-01-01T00:00:00.000Z",
        draft: "",
        id: "tab-1",
        kind: "chat",
        projectId: "project-1",
        runtimeId: "codex",
        sessionId: "session-1",
        title: "Session",
        worktreeId: "worktree-1",
    };
    return {
        activeTab: tab,
        tabsById: { [tab.id]: tab },
    };
}

function sessionState(overrides: Partial<AiSessionSnapshot> = {}) {
    return {
        isDispatching: false,
        snapshot: {
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
            runtimeId: "codex" as const,
            runtimeSessionId: "runtime-session-1",
            sessionId: "session-1",
            status: "idle" as const,
            title: "Session",
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: "2026-01-01T00:00:00.000Z",
            worktreeId: "worktree-1",
            ...overrides,
        },
    };
}

function subscribe(listeners: Set<() => void>, listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
