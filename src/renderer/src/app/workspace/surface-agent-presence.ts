import type {
    AiSessionSnapshot,
    WorkspaceSurfaceAiAgentPresence,
} from "@shared/ipc";
import { getAiSessionDisplayTitle } from "@shared/ai-session-title";

import { areGitWorktreeIdsEquivalent } from "@renderer/app/git/context-key";
import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";

export interface WorkspaceSurfaceAiSessionState {
    readonly isDispatching: boolean;
    readonly snapshot: AiSessionSnapshot | null;
}

export function collectWorkspaceSurfaceAiAgentPresence({
    aiSessions,
    projectId,
    tabsById,
    worktreeId,
}: {
    readonly aiSessions: Readonly<
        Record<string, WorkspaceSurfaceAiSessionState>
    >;
    readonly projectId: string;
    readonly tabsById: Readonly<Record<string, RuntimeWorkspaceTab>>;
    readonly worktreeId: string | null;
}): readonly WorkspaceSurfaceAiAgentPresence[] {
    const presenceBySessionId = new Map<
        string,
        WorkspaceSurfaceAiAgentPresence
    >();

    for (const tab of Object.values(tabsById)) {
        if (tab.kind !== "chat" && tab.kind !== "review") {
            continue;
        }
        const snapshot = aiSessions[tab.sessionId]?.snapshot ?? null;
        presenceBySessionId.set(tab.sessionId, {
            createdAt: tab.createdAt,
            kind: "ai",
            parentSessionId: snapshot?.parentSessionId ?? null,
            runtimeId: snapshot?.runtimeId ?? tab.runtimeId,
            runtimeSessionId: snapshot?.runtimeSessionId ?? null,
            sessionId: tab.sessionId,
            status: snapshot?.status ?? null,
            title: snapshot
                ? getAiSessionDisplayTitle(snapshot)
                : tab.title,
            updatedAt: snapshot?.updatedAt ?? tab.createdAt,
        });
    }

    for (const [sessionId, session] of Object.entries(aiSessions)) {
        const snapshot = session.snapshot;
        if (
            !snapshot ||
            presenceBySessionId.has(sessionId) ||
            !isWorkspaceSurfaceAiSessionActive(session) ||
            !isSnapshotInWorkspaceScope(snapshot, projectId, worktreeId)
        ) {
            continue;
        }

        // Closing a tab does not stop its runtime, so keep active work visible.
        presenceBySessionId.set(sessionId, {
            createdAt: snapshot.updatedAt,
            kind: "ai",
            parentSessionId: snapshot.parentSessionId ?? null,
            runtimeId: snapshot.runtimeId,
            runtimeSessionId: snapshot.runtimeSessionId,
            sessionId,
            status: snapshot.status,
            title: getAiSessionDisplayTitle(snapshot),
            updatedAt: snapshot.updatedAt,
        });
    }

    return [...presenceBySessionId.values()];
}

function isWorkspaceSurfaceAiSessionActive(
    session: WorkspaceSurfaceAiSessionState,
): boolean {
    const status = session.snapshot?.status;
    return (
        session.isDispatching ||
        status === "starting" ||
        status === "streaming" ||
        status === "waiting_permission" ||
        status === "waiting_user_input"
    );
}

function isSnapshotInWorkspaceScope(
    snapshot: AiSessionSnapshot,
    projectId: string,
    worktreeId: string | null,
): boolean {
    return (
        snapshot.projectId === projectId &&
        areGitWorktreeIdsEquivalent(
            projectId,
            snapshot.worktreeId ?? null,
            worktreeId,
        )
    );
}
