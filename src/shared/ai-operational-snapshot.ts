import type {
    AiSessionSnapshot,
    AiTranscriptBlockMetadata,
    AiTranscriptEntryEnvelope,
} from "./ipc";

export interface AiSessionOperationalTranscript {
    readonly blockMetadata: readonly AiTranscriptBlockMetadata[];
    readonly capabilityVersion: number;
    readonly liveTail: readonly AiTranscriptEntryEnvelope[];
}

export type AiSessionOperationalSnapshot = Omit<
    AiSessionSnapshot,
    "messages" | "toolActivity"
> & {
    readonly transcript: AiSessionOperationalTranscript;
};

export function toAiSessionOperationalSnapshot(
    snapshot: AiSessionSnapshot,
    transcript: AiSessionOperationalTranscript,
): AiSessionOperationalSnapshot {
    const { messages: _messages, toolActivity: _toolActivity, ...operational } =
        snapshot;
    void _messages;
    void _toolActivity;
    return { ...operational, transcript };
}
