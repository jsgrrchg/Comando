import type { AiSessionSnapshot } from "@shared/ipc";
import { getCustomRuntimeChangeConfirmationMessage } from "@shared/ai-session-errors";

import { useAiStore } from "@renderer/app/store/ai-store";

type LifecycleSessionEntry = {
    readonly meta?: {
        readonly title: string;
    } | null;
    readonly snapshot: Pick<
        AiSessionSnapshot,
        "parentSessionId" | "sessionId" | "status" | "title"
    > | null;
};

export function getStopAgentConfirmationMessage({
    sessionId,
    sessions,
    title,
}: {
    readonly sessionId: string;
    readonly sessions: Record<string, LifecycleSessionEntry | undefined>;
    readonly title: string;
}): string | null {
    const entries = Object.values(sessions).filter(
        (entry): entry is LifecycleSessionEntry => Boolean(entry?.snapshot),
    );
    const childrenByParentSessionId = new Map<string, LifecycleSessionEntry[]>();
    for (const entry of entries) {
        const parentSessionId = entry.snapshot?.parentSessionId ?? null;
        if (!parentSessionId || entry.snapshot?.sessionId === parentSessionId) {
            continue;
        }
        const children = childrenByParentSessionId.get(parentSessionId) ?? [];
        children.push(entry);
        childrenByParentSessionId.set(parentSessionId, children);
    }

    const activeDescendants: LifecycleSessionEntry[] = [];
    const pendingSessionIds = [sessionId];
    const visitedSessionIds = new Set([sessionId]);
    while (pendingSessionIds.length > 0) {
        const parentSessionId = pendingSessionIds.shift();
        if (!parentSessionId) {
            continue;
        }
        for (const entry of childrenByParentSessionId.get(parentSessionId) ?? []) {
            const snapshot = entry.snapshot;
            if (!snapshot || visitedSessionIds.has(snapshot.sessionId)) {
                continue;
            }
            visitedSessionIds.add(snapshot.sessionId);
            pendingSessionIds.push(snapshot.sessionId);
            if (isBusyAiSessionSnapshot(snapshot)) {
                activeDescendants.push(entry);
            }
        }
    }

    if (activeDescendants.length === 0) {
        return null;
    }

    const descendantNames = activeDescendants
        .map((entry) => entry.snapshot?.title ?? entry.meta?.title ?? null)
        .filter((name): name is string => Boolean(name?.trim()))
        .slice(0, 3);
    const descendantSummary =
        descendantNames.length > 0
            ? ` (${descendantNames.join(", ")}${activeDescendants.length > descendantNames.length ? ", ..." : ""})`
            : "";
    const descendantLabel =
        activeDescendants.length === 1
            ? "descendant agent"
            : "descendant agents";

    return `Stop "${title}"? ${activeDescendants.length} active ${descendantLabel}${descendantSummary} will keep running. This only stops the selected thread.`;
}

export function requestStopAgentSession({
    sessionId,
    title,
}: {
    readonly sessionId: string;
    readonly title: string;
}): void {
    const { cancelSession, sessions } = useAiStore.getState();
    const message = getStopAgentConfirmationMessage({
        sessionId,
        sessions,
        title,
    });

    if (message && !window.confirm(message)) {
        return;
    }

    void cancelSession(sessionId);
}

export function requestCustomRuntimeChangeConfirmation(
    error: unknown,
): boolean | null {
    const message = getCustomRuntimeChangeConfirmationMessage(error);
    if (!message) {
        return null;
    }

    return window.confirm(message);
}

function isBusyAiSessionSnapshot(
    snapshot: Pick<AiSessionSnapshot, "status">,
): boolean {
    return (
        snapshot.status === "starting" ||
        snapshot.status === "streaming" ||
        snapshot.status === "waiting_permission" ||
        snapshot.status === "waiting_user_input"
    );
}
