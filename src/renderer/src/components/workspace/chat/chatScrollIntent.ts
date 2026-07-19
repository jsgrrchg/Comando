export type ChatScrollIntent =
    | { readonly mode: "reader"; readonly navigationGeneration: number }
    | { readonly mode: "new-turn-anchor"; readonly navigationGeneration: number }
    | { readonly mode: "follow-end"; readonly navigationGeneration: number };

export function createChatScrollIntent(): ChatScrollIntent {
    return { mode: "follow-end", navigationGeneration: 0 };
}

export function isFollowingChatScrollEnd(intent: ChatScrollIntent): boolean {
    return intent.mode === "follow-end";
}

export function isAnchoringNewChatTurn(intent: ChatScrollIntent): boolean {
    return intent.mode === "new-turn-anchor";
}

export function anchorNewChatTurn(intent: ChatScrollIntent): ChatScrollIntent {
    // A new turn must invalidate frames queued for the previous tail.
    return {
        mode: "new-turn-anchor",
        navigationGeneration: intent.navigationGeneration + 1,
    };
}

export function followChatScrollEnd(intent: ChatScrollIntent): ChatScrollIntent {
    if (intent.mode === "follow-end") {
        return intent;
    }

    // Returning to the end invalidates callbacks scheduled while reading.
    return {
        mode: "follow-end",
        navigationGeneration: intent.navigationGeneration + 1,
    };
}

export function readChatScroll(intent: ChatScrollIntent): ChatScrollIntent {
    // User navigation must win over any pending programmatic scroll.
    return {
        mode: "reader",
        navigationGeneration: intent.navigationGeneration + 1,
    };
}

export function canApplyChatScrollOperation(
    intent: ChatScrollIntent,
    generation: number,
): boolean {
    return (
        intent.mode === "follow-end" &&
        intent.navigationGeneration === generation
    );
}
