import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";

export function getWorkspaceTabCloseConfirmationMessage(input: {
    readonly tabIds: readonly string[];
    readonly tabsById: Record<string, RuntimeWorkspaceTab | undefined>;
    readonly sessions: Record<string, unknown>;
}): string | null {
    void input;
    return null;
}

export async function closeWorkspaceTabsWithConfirmation(
    tabIds: readonly string[],
    closeAction: () => Promise<void>,
): Promise<void> {
    void tabIds;
    await closeAction();
}
