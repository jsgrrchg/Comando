import type { AiSessionSnapshot } from "@shared/ipc";

import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";
import { useAiStore } from "@renderer/app/store/ai-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";

import { resolveWorkspaceChatTabActivityIndicator } from "./workspaceTabActivity";

type CloseGuardSessionState = {
    readonly localError: string | null;
    readonly snapshot: Pick<AiSessionSnapshot, "status"> | null;
};

export function getWorkspaceTabCloseConfirmationMessage(input: {
    readonly tabIds: readonly string[];
    readonly tabsById: Record<string, RuntimeWorkspaceTab | undefined>;
    readonly sessions: Record<string, CloseGuardSessionState | undefined>;
}): string | null {
    let workingCount = 0;

    for (const tabId of input.tabIds) {
        const candidateTab = input.tabsById[tabId];
        if (candidateTab?.kind !== "chat") {
            continue;
        }

        const session = input.sessions[candidateTab.sessionId];
        if (!session) {
            continue;
        }

        const indicator = resolveWorkspaceChatTabActivityIndicator({
            localError: session.localError,
            snapshot: session.snapshot,
        });
        if (indicator?.tone === "working") {
            workingCount += 1;
        }
    }

    if (workingCount === 0) {
        return null;
    }

    return workingCount === 1
        ? "This thread is working. Stop the agent and close anyway?"
        : `${workingCount} threads are working. Stop the agents and close anyway?`;
}

export async function closeWorkspaceTabsWithConfirmation(
    tabIds: readonly string[],
    closeAction: () => Promise<void>,
): Promise<void> {
    const message = getWorkspaceTabCloseConfirmationMessage({
        sessions: useAiStore.getState().sessions,
        tabIds,
        tabsById: useWorkspaceStore.getState().tabsById,
    });

    if (message && !window.confirm(message)) {
        return;
    }

    await closeAction();
}
