import type { AiSessionSnapshot } from "@shared/ipc";
import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";
import { areGitWorktreeIdsEquivalent } from "@renderer/app/git/context-key";

type WorkspaceCloseSession = {
    readonly meta: {
        readonly projectId: string | null;
        readonly title: string;
        readonly worktreeId: string | null;
    } | null;
    readonly snapshot: Pick<
        AiSessionSnapshot,
        "projectId" | "sessionId" | "status" | "title" | "worktreeId"
    > | null;
};

export type WorkspaceCloseSummary = {
    readonly activeAgentCount: number;
    readonly dirtyFileCount: number;
};

export function getWorkspaceTabCloseConfirmationMessage(input: {
    readonly tabIds: readonly string[];
    readonly tabsById: Record<string, RuntimeWorkspaceTab | undefined>;
    readonly sessions: Record<string, unknown>;
}): string | null {
    const dirtyFileCount = input.tabIds.reduce((count, tabId) => {
        const tab = input.tabsById[tabId];
        return count + (tab?.kind === "file" && tab.isDirty ? 1 : 0);
    }, 0);

    if (dirtyFileCount === 0) {
        return null;
    }

    return dirtyFileCount === 1
        ? "This workspace contains an unsaved file. Close it and discard the changes?"
        : `This workspace contains ${dirtyFileCount} unsaved files. Close it and discard the changes?`;
}

export function getWorkspaceCloseSummary(input: {
    readonly projectId: string;
    readonly sessions: Record<string, WorkspaceCloseSession | undefined>;
    readonly tabsById: Record<string, RuntimeWorkspaceTab | undefined>;
    readonly worktreeId: string | null;
}): WorkspaceCloseSummary {
    const tabSessionIds = new Set(
        Object.values(input.tabsById).flatMap((tab) =>
            tab?.kind === "chat" || tab?.kind === "review" ? [tab.sessionId] : [],
        ),
    );
    const activeAgents = Object.values(input.sessions).filter(
        (session): session is WorkspaceCloseSession => {
            if (!session?.snapshot || !isBusyAiSession(session.snapshot)) {
                return false;
            }

            if (tabSessionIds.has(session.snapshot.sessionId)) {
                return true;
            }

            const scope = session.snapshot?.projectId
                ? session.snapshot
                : session.meta;
            return (
                scope?.projectId === input.projectId &&
                areGitWorktreeIdsEquivalent(
                    input.projectId,
                    scope.worktreeId ?? null,
                    input.worktreeId,
                )
            );
        },
    );
    const dirtyFileCount = Object.values(input.tabsById).reduce(
        (count, tab) => count + (tab?.kind === "file" && tab.isDirty ? 1 : 0),
        0,
    );

    return {
        activeAgentCount: activeAgents.length,
        dirtyFileCount,
    };
}

export async function closeWorkspaceContextWithConfirmation(
    input: {
        readonly projectId: string;
        readonly sessions: Record<string, WorkspaceCloseSession | undefined>;
        readonly tabsById: Record<string, RuntimeWorkspaceTab | undefined>;
        readonly worktreeId: string | null;
    },
    closeAction: () => Promise<void>,
    options: {
        readonly confirm: (summary: WorkspaceCloseSummary) => Promise<boolean>;
    },
): Promise<void> {
    const summary = getWorkspaceCloseSummary(input);
    if (
        (summary.activeAgentCount > 0 || summary.dirtyFileCount > 0) &&
        !(await options.confirm(summary))
    ) {
        return;
    }

    await closeAction();
}

export async function closeWorkspaceTabsWithConfirmation(
    tabIds: readonly string[],
    closeAction: () => Promise<void>,
    options: {
        readonly confirm?: (message: string) => boolean;
        readonly sessions?: Record<string, unknown>;
        readonly tabsById?: Record<string, RuntimeWorkspaceTab | undefined>;
    } = {},
): Promise<void> {
    if (options.tabsById) {
        const message = getWorkspaceTabCloseConfirmationMessage({
            sessions: options.sessions ?? {},
            tabIds,
            tabsById: options.tabsById,
        });
        const confirm = options.confirm ?? globalThis.window?.confirm;
        if (message && (!confirm || !confirm(message))) {
            return;
        }
    }

    await closeAction();
}

function isBusyAiSession(
    snapshot: Pick<AiSessionSnapshot, "status">,
): boolean {
    return (
        snapshot.status === "starting" ||
        snapshot.status === "streaming" ||
        snapshot.status === "waiting_permission" ||
        snapshot.status === "waiting_user_input"
    );
}
