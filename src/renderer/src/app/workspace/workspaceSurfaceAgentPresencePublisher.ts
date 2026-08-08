import type {
    WorkspaceSurfaceAgentPresenceState,
    WorkspaceSurfaceLifecycleState,
    WorkspaceSurfaceTerminalAgentPresence,
} from "@shared/ipc";

import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";

import {
    collectWorkspaceSurfaceAiAgentPresence,
    type WorkspaceSurfaceAiSessionState,
    workspaceSurfaceAgentPresenceSemanticSignature,
    workspaceSurfaceAgentPresenceSignature,
} from "./surface-agent-presence";

export const WORKSPACE_AGENT_PRESENCE_TEMPORAL_INTERVAL_MS = 1_000;

export interface WorkspaceSurfaceAgentPresencePublisherContext {
    readonly contextKey: string;
    readonly lifecycle: WorkspaceSurfaceLifecycleState;
    readonly projectId: string;
    readonly terminalSessions: readonly WorkspaceSurfaceTerminalAgentPresence[];
    readonly worktreeId: string | null;
}

interface WorkspaceSurfaceAgentPresencePublisherDependencies {
    readonly clearTimer?: (timer: number) => void;
    readonly getAiSessions: () => Readonly<
        Record<string, WorkspaceSurfaceAiSessionState>
    >;
    readonly getWorkspaceProjection: () => {
        readonly activeTab: RuntimeWorkspaceTab | null;
        readonly tabsById: Readonly<Record<string, RuntimeWorkspaceTab>>;
    };
    readonly now?: () => number;
    readonly publish: (
        state: WorkspaceSurfaceAgentPresenceState,
    ) => Promise<{ readonly delivered: boolean }>;
    readonly setTimer?: (
        callback: () => void,
        delayMs: number,
    ) => number;
    readonly subscribeAiSessions: (listener: () => void) => () => void;
    readonly subscribeWorkspace: (listener: () => void) => () => void;
}

export interface WorkspaceSurfaceAgentPresencePublisher {
    readonly dispose: () => void;
    readonly updateContext: (
        context: WorkspaceSurfaceAgentPresencePublisherContext | null,
    ) => void;
}

export function createWorkspaceSurfaceAgentPresencePublisher(
    dependencies: WorkspaceSurfaceAgentPresencePublisherDependencies,
): WorkspaceSurfaceAgentPresencePublisher {
    const now = dependencies.now ?? Date.now;
    const setTimer =
        dependencies.setTimer ??
        ((callback: () => void, delayMs: number) =>
            globalThis.setTimeout(callback, delayMs) as unknown as number);
    const clearTimer =
        dependencies.clearTimer ??
        ((timer: number) =>
            globalThis.clearTimeout(
                timer as unknown as ReturnType<typeof setTimeout>,
            ));
    let context: WorkspaceSurfaceAgentPresencePublisherContext | null = null;
    let disposed = false;
    let inFlight = false;
    let lastPublishedAt = Number.NEGATIVE_INFINITY;
    let publishedFullSignature = "";
    let publishedSemanticSignature = "";
    let pendingState: WorkspaceSurfaceAgentPresenceState | null = null;
    let temporalTimer: number | null = null;

    const clearTemporalTimer = () => {
        if (temporalTimer === null) return;
        clearTimer(temporalTimer);
        temporalTimer = null;
    };

    const scheduleTemporalPublish = () => {
        if (temporalTimer !== null || !context || context.lifecycle !== "visible") {
            return;
        }
        const delayMs = Math.max(
            0,
            WORKSPACE_AGENT_PRESENCE_TEMPORAL_INTERVAL_MS -
                (now() - lastPublishedAt),
        );
        temporalTimer = setTimer(() => {
            temporalTimer = null;
            void publishPending();
        }, delayMs);
    };

    const publishPending = async (): Promise<void> => {
        if (disposed || inFlight || !pendingState) return;
        const state = pendingState;
        const fullSignature = workspaceSurfaceAgentPresenceSignature(state);
        const semanticSignature =
            workspaceSurfaceAgentPresenceSemanticSignature(state);
        if (fullSignature === publishedFullSignature) {
            pendingState = null;
            return;
        }
        const semanticChange = semanticSignature !== publishedSemanticSignature;
        if (
            !semanticChange &&
            (context?.lifecycle !== "visible" ||
                now() - lastPublishedAt <
                    WORKSPACE_AGENT_PRESENCE_TEMPORAL_INTERVAL_MS)
        ) {
            scheduleTemporalPublish();
            return;
        }

        pendingState = null;
        clearTemporalTimer();
        inFlight = true;
        try {
            const result = await dependencies.publish(state);
            if (!disposed && result.delivered) {
                publishedFullSignature = fullSignature;
                publishedSemanticSignature = semanticSignature;
                lastPublishedAt = now();
            }
        } catch {
            // A later store revision or lifecycle resync retries the latest state.
        } finally {
            inFlight = false;
            if (!disposed && pendingState) void publishPending();
        }
    };

    const refresh = () => {
        if (disposed || !context) return;
        const workspace = dependencies.getWorkspaceProjection();
        const activeTab = workspace.activeTab;
        const activeSessionId =
            activeTab?.kind === "chat" || activeTab?.kind === "review"
                ? activeTab.sessionId
                : activeTab?.kind === "terminal"
                  ? (context.terminalSessions.find(
                        (session) =>
                            session.terminalId === activeTab.terminalId,
                    )?.sessionId ?? null)
                  : null;
        pendingState = {
            activeSessionId,
            contextKey: context.contextKey,
            projectId: context.projectId,
            sessions: [
                ...collectWorkspaceSurfaceAiAgentPresence({
                    aiSessions: dependencies.getAiSessions(),
                    projectId: context.projectId,
                    tabsById: workspace.tabsById,
                    worktreeId: context.worktreeId,
                }),
                ...context.terminalSessions,
            ],
            worktreeId: context.worktreeId,
        };
        void publishPending();
    };

    const unsubscribeAiSessions = dependencies.subscribeAiSessions(refresh);
    const unsubscribeWorkspace = dependencies.subscribeWorkspace(refresh);

    return {
        dispose() {
            disposed = true;
            pendingState = null;
            clearTemporalTimer();
            unsubscribeAiSessions();
            unsubscribeWorkspace();
        },
        updateContext(nextContext) {
            context = nextContext;
            if (!context) {
                pendingState = null;
                clearTemporalTimer();
                return;
            }
            refresh();
        },
    };
}
