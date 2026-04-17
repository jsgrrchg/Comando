export function persistChatDraftForTab(
    updateChatDraft: (tabId: string, draft: string) => Promise<void>,
    tabId: string,
    draft: string,
) {
    void updateChatDraft(tabId, draft);
}
