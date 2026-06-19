import type { AiRuntimeId } from "./ipc";

export type ActiveAiRuntimeId = Exclude<AiRuntimeId, "gemini">;

export const ACTIVE_AI_RUNTIME_IDS = [
    "claude",
    "codex",
    "grok",
    "kilo",
    "opencode",
] as const satisfies readonly ActiveAiRuntimeId[];

export const LEGACY_AI_RUNTIME_IDS = [
    ...ACTIVE_AI_RUNTIME_IDS,
    "gemini",
] as const satisfies readonly AiRuntimeId[];

const ACTIVE_AI_RUNTIME_ID_SET = new Set<AiRuntimeId>(
    ACTIVE_AI_RUNTIME_IDS,
);
const LEGACY_AI_RUNTIME_ID_SET = new Set<AiRuntimeId>(
    LEGACY_AI_RUNTIME_IDS,
);

export function isActiveAiRuntimeId(value: unknown): value is ActiveAiRuntimeId {
    return (
        typeof value === "string" &&
        ACTIVE_AI_RUNTIME_ID_SET.has(value as AiRuntimeId)
    );
}

export function isKnownAiRuntimeId(value: unknown): value is AiRuntimeId {
    return (
        typeof value === "string" &&
        LEGACY_AI_RUNTIME_ID_SET.has(value as AiRuntimeId)
    );
}

export function getAiRuntimeDisplayName(runtimeId: AiRuntimeId): string {
    switch (runtimeId) {
        case "claude":
            return "Claude";
        case "gemini":
            return "Gemini";
        case "grok":
            return "Grok";
        case "kilo":
            return "Kilo";
        case "opencode":
            return "OpenCode";
        case "codex":
        default:
            return "Codex";
    }
}
