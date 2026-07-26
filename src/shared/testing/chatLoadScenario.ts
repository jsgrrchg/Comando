/**
 * Versioned scalar contract shared by Vitest and browser harnesses.
 * Native tests use the same units when adapting scenarios to storage inputs.
 */
export const CHAT_LOAD_SCENARIO_CONTRACT_VERSION = 1;

export interface ChatLoadScenario {
    readonly activeTools: number;
    readonly aggregateDiffBytes: number;
    readonly deltaBytes: number;
    readonly diffCount: number;
    readonly historyMessages: number;
    readonly seed: number;
    readonly sessionCount: number;
    readonly streamingDeltas: number;
    readonly terminalOutputBytes: number;
}

export interface NormalizedChatLoadScenario extends ChatLoadScenario {
    readonly seed: number;
    readonly sessionCount: number;
}

export interface ChatLoadDiagnosticSummary {
    readonly contractVersion: typeof CHAT_LOAD_SCENARIO_CONTRACT_VERSION;
    readonly generated: {
        readonly aggregateDiffBytes: number;
        readonly historyMessages: number;
        readonly sessions: number;
        readonly streamingBytes: number;
        readonly streamingDeltas: number;
        readonly terminalOutputBytes: number;
        readonly tools: number;
    };
    readonly scenario: NormalizedChatLoadScenario;
}

const MAX_SAFE_SCENARIO_COUNT = 1_000_000;
const MAX_SAFE_SCENARIO_BYTES = 512 * 1024 * 1024;

export function normalizeChatLoadScenario(
    scenario: ChatLoadScenario,
): NormalizedChatLoadScenario {
    const activeTools = normalizeCount(
        scenario.activeTools,
        MAX_SAFE_SCENARIO_COUNT,
    );
    const diffCount =
        activeTools === 0
            ? 0
            : normalizeCount(scenario.diffCount, MAX_SAFE_SCENARIO_COUNT);
    const streamingDeltas = normalizeCount(
        scenario.streamingDeltas,
        MAX_SAFE_SCENARIO_COUNT,
    );
    return {
        activeTools,
        aggregateDiffBytes:
            diffCount === 0
                ? 0
                : normalizeCount(
                      scenario.aggregateDiffBytes,
                      MAX_SAFE_SCENARIO_BYTES,
                  ),
        deltaBytes:
            streamingDeltas === 0
                ? 0
                : normalizeCount(
                      scenario.deltaBytes,
                      Math.floor(
                          MAX_SAFE_SCENARIO_BYTES / streamingDeltas,
                      ),
                  ),
        diffCount,
        historyMessages: normalizeCount(
            scenario.historyMessages,
            MAX_SAFE_SCENARIO_COUNT,
        ),
        seed: normalizeSeed(scenario.seed),
        sessionCount: Math.max(
            1,
            normalizeCount(scenario.sessionCount, MAX_SAFE_SCENARIO_COUNT),
        ),
        streamingDeltas,
        terminalOutputBytes:
            activeTools === 0
                ? 0
                : normalizeCount(
                      scenario.terminalOutputBytes,
                      MAX_SAFE_SCENARIO_BYTES,
                  ),
    };
}

export function createChatLoadDiagnosticSummary(
    scenario: ChatLoadScenario,
): ChatLoadDiagnosticSummary {
    const normalized = normalizeChatLoadScenario(scenario);
    return {
        contractVersion: CHAT_LOAD_SCENARIO_CONTRACT_VERSION,
        generated: {
            aggregateDiffBytes: normalized.aggregateDiffBytes,
            historyMessages: normalized.historyMessages,
            sessions: normalized.sessionCount,
            streamingBytes:
                normalized.streamingDeltas * normalized.deltaBytes,
            streamingDeltas: normalized.streamingDeltas,
            terminalOutputBytes: normalized.terminalOutputBytes,
            tools: normalized.activeTools,
        },
        scenario: normalized,
    };
}

export function stringifyChatLoadDiagnostic(
    scenario: ChatLoadScenario,
): string {
    return JSON.stringify(createChatLoadDiagnosticSummary(scenario), null, 2);
}

export interface SeededChatLoadRandom {
    readonly next: () => number;
    readonly nextInt: (maximumExclusive: number) => number;
}

export function createSeededChatLoadRandom(seed: number): SeededChatLoadRandom {
    let state = normalizeSeed(seed) || 0x6d2b79f5;
    const next = () => {
        // Mulberry32 is compact, deterministic and sufficient for fixture data.
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };

    return {
        next,
        nextInt(maximumExclusive) {
            if (!Number.isFinite(maximumExclusive) || maximumExclusive <= 0) {
                return 0;
            }
            return Math.floor(next() * Math.floor(maximumExclusive));
        },
    };
}

function normalizeCount(value: number, maximum: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function normalizeSeed(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.floor(value) >>> 0;
}
