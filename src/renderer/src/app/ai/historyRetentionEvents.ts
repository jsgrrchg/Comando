import { clearSidebarAgentsHistoryCache } from "@renderer/components/sidebar/sidebarAgentsHistoryCache";
import { releaseCachedChatTimeline } from "@renderer/components/workspace/chat/chatTimelineCache";
import { releaseScopedToolUiStateStore } from "@renderer/components/workspace/chat/toolExpansionStore";
import { useAiStore } from "@renderer/app/store/ai-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";

export function subscribeToAiHistoryPruned(): () => void {
    const api = window.comando;
    if (!api?.onAiHistoryPruned) {
        return () => undefined;
    }

    return api.onAiHistoryPruned((event) => {
        const deletedSessionIds = new Set(event.deletedSessionIds);
        clearSidebarAgentsHistoryCache();
        useAiStore.setState((state) => {
            const sessions = { ...state.sessions };
            for (const sessionId of deletedSessionIds) {
                delete sessions[sessionId];
                releaseCachedChatTimeline(sessionId);
                releaseScopedToolUiStateStore(sessionId);
            }
            return { sessions };
        });

        const workspace = useWorkspaceStore.getState();
        const matchingTabIds = Object.values(workspace.tabsById)
            .filter(
                (tab) =>
                    (tab.kind === "chat" || tab.kind === "review") &&
                    deletedSessionIds.has(tab.sessionId),
            )
            .map((tab) => tab.id);
        void (async () => {
            // Sequential closes preserve pane selection while each mutation persists layout.
            for (const tabId of matchingTabIds) {
                await workspace.closeTab(tabId);
            }
        })().catch((error: unknown) => {
            console.warn("Could not close a pruned chat history tab.", error);
        });
    });
}
