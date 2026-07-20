export function isScrollViewportNearBottom(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    threshold: number,
): boolean {
    return scrollHeight - scrollTop - clientHeight < threshold;
}

export function shouldHoldChatScrollFollowIntent({
    composerExpanded,
    programmaticFollowSettling,
    shouldAutoFollow,
}: {
    readonly composerExpanded: boolean;
    readonly programmaticFollowSettling: boolean;
    readonly shouldAutoFollow: boolean;
}): boolean {
    return (
        shouldAutoFollow &&
        (programmaticFollowSettling || composerExpanded)
    );
}

export function resolveChatScrollPersistenceState({
    currentScrollTop,
    pendingIsNearBottom,
    pendingScrollTop,
    restoreScrollTop,
    shouldAutoFollow,
}: {
    readonly currentScrollTop: number | null | undefined;
    readonly pendingIsNearBottom: boolean | null;
    readonly pendingScrollTop: number | null;
    readonly restoreScrollTop: number;
    readonly shouldAutoFollow: boolean;
}): { readonly isNearBottom: boolean; readonly scrollTop: number } {
    return {
        isNearBottom: pendingIsNearBottom ?? shouldAutoFollow,
        scrollTop: pendingScrollTop ?? currentScrollTop ?? restoreScrollTop,
    };
}
