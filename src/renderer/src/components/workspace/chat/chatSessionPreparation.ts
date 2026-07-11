import type { RuntimeWorkspaceChatTab } from "@renderer/app/workspace/tree";

type ChatSessionPreparationInput = Pick<
    RuntimeWorkspaceChatTab,
    | "createdAt"
    | "id"
    | "kind"
    | "projectId"
    | "runtimeId"
    | "sessionId"
    | "sessionOpenMode"
    | "title"
    | "worktreeId"
>;

export function getChatSessionPreparationKey(
    tab: ChatSessionPreparationInput,
): string {
    return JSON.stringify([
        tab.createdAt,
        tab.id,
        tab.kind,
        tab.projectId,
        tab.runtimeId,
        tab.sessionOpenMode,
        tab.sessionId,
        tab.worktreeId ?? null,
    ]);
}
