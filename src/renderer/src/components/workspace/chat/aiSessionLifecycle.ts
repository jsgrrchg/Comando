import type { AiSessionSnapshot } from "@shared/ipc";

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
    const activeChildren = Object.values(sessions).filter(
        (entry): entry is LifecycleSessionEntry => {
            if (!entry) {
                return false;
            }

            const snapshot = entry.snapshot ?? null;
            return (
                snapshot !== null &&
                snapshot.sessionId !== sessionId &&
                snapshot.parentSessionId === sessionId &&
                isBusyAiSessionSnapshot(snapshot)
            );
        },
    );

    if (activeChildren.length === 0) {
        return null;
    }

    const childNames = activeChildren
        .map((entry) => entry.snapshot?.title ?? entry.meta?.title ?? null)
        .filter((name): name is string => Boolean(name?.trim()))
        .slice(0, 3);
    const childSummary =
        childNames.length > 0
            ? ` (${childNames.join(", ")}${activeChildren.length > childNames.length ? ", ..." : ""})`
            : "";
    const childLabel =
        activeChildren.length === 1 ? "child agent" : "child agents";

    return `Stop "${title}"? ${activeChildren.length} active ${childLabel}${childSummary} will keep running. This only stops the selected thread.`;
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
