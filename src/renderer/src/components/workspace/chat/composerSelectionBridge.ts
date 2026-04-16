export interface ComposerSelectionMentionInput {
    readonly endLine: number;
    readonly path: string;
    readonly selectedText: string;
    readonly startLine: number;
}

type ComposerSelectionMentionHandler = (
    selection: ComposerSelectionMentionInput,
) => void;

const composerSelectionHandlers = new Map<
    string,
    ComposerSelectionMentionHandler
>();

export function registerComposerSelectionMentionHandler(
    sessionId: string,
    handler: ComposerSelectionMentionHandler,
): () => void {
    composerSelectionHandlers.set(sessionId, handler);

    return () => {
        if (composerSelectionHandlers.get(sessionId) === handler) {
            composerSelectionHandlers.delete(sessionId);
        }
    };
}

export function appendSelectionMentionToRegisteredComposer(
    sessionId: string,
    selection: ComposerSelectionMentionInput,
): boolean {
    const handler = composerSelectionHandlers.get(sessionId);
    if (!handler) {
        return false;
    }

    handler(selection);
    return true;
}
