import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";

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
