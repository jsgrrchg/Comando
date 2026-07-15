/**
 * A workspace may have an arbitrary number of panes, so per-pane retention is
 * not sufficient to bound the number of mounted chat presentation trees.
 */
// Warm tabs retain only serializable state and cached geometry. Keeping an
// additional transcript tree mounted turns every inactive tab into background
// layout and observer work, which defeats the workspace-wide resource budget.
export const MAX_ADDITIONAL_HOT_CHAT_TAB_VIEWS = 0;

// Timeline and measurement caches share this cap so a cooled view can resume
// quickly without allowing cached presentation artifacts to grow with panes.
export const MAX_CACHED_CHAT_VIEW_ARTIFACTS = 12;

export interface ChatViewResourceBudgetPane {
    readonly activeTabId: string | null;
    readonly chatTabIds: readonly string[];
    readonly id: string;
    readonly visible: boolean;
}

export interface ChatViewResourceBudgetInput {
    readonly focusedPaneId: string;
    readonly panes: readonly ChatViewResourceBudgetPane[];
    /** Most recent first. */
    readonly recentActiveTabIds: readonly string[];
}

/**
 * Resolves the chat views that are allowed to keep a mounted presentation.
 * Visible panes are always protected; the remaining capacity is shared across
 * all panes and assigned by global recency.
 */
export function resolveHotChatTabIds({
    focusedPaneId,
    panes,
    recentActiveTabIds,
}: ChatViewResourceBudgetInput): ReadonlySet<string> {
    const hotTabIds = new Set<string>();
    const renderableChatTabIds = new Set(
        panes.flatMap((pane) => (pane.visible ? pane.chatTabIds : [])),
    );

    const retainVisibleActiveChat = (pane: ChatViewResourceBudgetPane) => {
        if (
            pane.visible &&
            pane.activeTabId !== null &&
            renderableChatTabIds.has(pane.activeTabId)
        ) {
            hotTabIds.add(pane.activeTabId);
        }
    };

    const focusedPane = panes.find((pane) => pane.id === focusedPaneId);
    if (focusedPane) {
        retainVisibleActiveChat(focusedPane);
    }

    for (const pane of panes) {
        if (pane.id !== focusedPaneId) {
            retainVisibleActiveChat(pane);
        }
    }

    let additionalViews = 0;
    for (const tabId of recentActiveTabIds) {
        if (
            additionalViews >= MAX_ADDITIONAL_HOT_CHAT_TAB_VIEWS ||
            hotTabIds.has(tabId) ||
            !renderableChatTabIds.has(tabId)
        ) {
            continue;
        }

        hotTabIds.add(tabId);
        additionalViews += 1;
    }

    return hotTabIds;
}
