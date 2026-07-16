const CHAT_PERFORMANCE_PROBE_STORAGE_KEY = "comando:chat-performance-probe";
const MAX_CHAT_PERFORMANCE_EVENTS = 500;

export type ChatPerformanceMetric =
    | "ack_lag_ms"
    | "apply_event_ms"
    | "delta_buffer_wait_ms"
    | "markdown_parse_ms"
    | "react_commit_ms"
    | "review_index_ms"
    | "timeline_reconcile_ms"
    | "transcript_patch_ms"
    | "virtual_range";

export interface ChatPerformanceMetricInput {
    readonly durationMs?: number;
    readonly sessionId?: string;
    readonly values?: Readonly<Record<string, number | null | undefined>>;
}

export interface ChatPerformanceProbeEvent {
    readonly durationMs: number | null;
    readonly metric: ChatPerformanceMetric;
    readonly sessionKey: string | null;
    readonly timestamp: number;
    readonly values: Readonly<Record<string, number>>;
}

interface ChatPerformanceProbeStore {
    readonly events: ChatPerformanceProbeEvent[];
}

type ChatPerformanceProbeRoot = typeof globalThis & {
    __COMANDO_CHAT_PERFORMANCE_PROBE__?: ChatPerformanceProbeStore;
    __comandoChatPerformanceProbeDump?: () => readonly ChatPerformanceProbeEvent[];
    __comandoChatPerformanceProbeReset?: () => void;
};

let enabledForTests: boolean | null = null;
let cachedEnabled: boolean | null = null;

export function isChatPerformanceProbeEnabled(): boolean {
    if (enabledForTests !== null) {
        return enabledForTests;
    }
    if (cachedEnabled !== null) {
        return cachedEnabled;
    }
    if (typeof window === "undefined") {
        return false;
    }

    try {
        const storage = window.localStorage;
        if (!storage || typeof storage.getItem !== "function") {
            cachedEnabled = false;
            return cachedEnabled;
        }
        const value = storage
            .getItem(CHAT_PERFORMANCE_PROBE_STORAGE_KEY)
            ?.trim()
            .toLowerCase();
        cachedEnabled = value === "1" || value === "true" || value === "on";
        return cachedEnabled;
    } catch {
        cachedEnabled = false;
        return cachedEnabled;
    }
}

function getChatPerformanceProbeStore(): ChatPerformanceProbeStore {
    const root = globalThis as ChatPerformanceProbeRoot;
    if (!root.__COMANDO_CHAT_PERFORMANCE_PROBE__) {
        root.__COMANDO_CHAT_PERFORMANCE_PROBE__ = { events: [] };
        root.__comandoChatPerformanceProbeDump = () => [
            ...(root.__COMANDO_CHAT_PERFORMANCE_PROBE__?.events ?? []),
        ];
        root.__comandoChatPerformanceProbeReset = () => {
            root.__COMANDO_CHAT_PERFORMANCE_PROBE__?.events.splice(0);
        };
    }

    return root.__COMANDO_CHAT_PERFORMANCE_PROBE__;
}

function getSessionKey(sessionId: string | undefined): string | null {
    if (!sessionId) {
        return null;
    }

    let hash = 2166136261;
    for (let index = 0; index < sessionId.length; index += 1) {
        hash ^= sessionId.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `s-${(hash >>> 0).toString(36)}`;
}

function sanitizeValues(
    values: ChatPerformanceMetricInput["values"],
): Readonly<Record<string, number>> {
    if (!values) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(values).flatMap(([key, value]) =>
            typeof value === "number" && Number.isFinite(value)
                ? [[key, Number(value.toFixed(2))]]
                : [],
        ),
    );
}

export function recordChatPerformanceMetric(
    metric: ChatPerformanceMetric,
    input: ChatPerformanceMetricInput = {},
): void {
    if (!isChatPerformanceProbeEnabled()) {
        return;
    }

    const store = getChatPerformanceProbeStore();
    store.events.push({
        durationMs:
            typeof input.durationMs === "number" &&
            Number.isFinite(input.durationMs)
                ? Number(input.durationMs.toFixed(2))
                : null,
        metric,
        sessionKey: getSessionKey(input.sessionId),
        timestamp: Date.now(),
        values: sanitizeValues(input.values),
    });
    if (store.events.length > MAX_CHAT_PERFORMANCE_EVENTS) {
        store.events.splice(0, store.events.length - MAX_CHAT_PERFORMANCE_EVENTS);
    }
}

export function getChatPerformanceTimestamp(): number | null {
    return isChatPerformanceProbeEnabled() ? performance.now() : null;
}

export function measureChatPerformance<T>(
    metric: ChatPerformanceMetric,
    input: Omit<ChatPerformanceMetricInput, "durationMs">,
    operation: () => T,
): T {
    if (!isChatPerformanceProbeEnabled()) {
        return operation();
    }

    const start = performance.now();
    const markName = `comando:${metric}:${start}`;
    performance.mark?.(`${markName}:start`);
    try {
        return operation();
    } finally {
        const durationMs = performance.now() - start;
        performance.mark?.(`${markName}:end`);
        performance.measure?.(markName, `${markName}:start`, `${markName}:end`);
        performance.clearMarks?.(`${markName}:start`);
        performance.clearMarks?.(`${markName}:end`);
        performance.clearMeasures?.(markName);
        recordChatPerformanceMetric(metric, { ...input, durationMs });
    }
}

export function setChatPerformanceProbeEnabledForTests(
    enabled: boolean | null,
): void {
    enabledForTests = enabled;
    cachedEnabled = null;
}

export function resetChatPerformanceProbeForTests(): void {
    const root = globalThis as ChatPerformanceProbeRoot;
    delete root.__COMANDO_CHAT_PERFORMANCE_PROBE__;
    delete root.__comandoChatPerformanceProbeDump;
    delete root.__comandoChatPerformanceProbeReset;
    enabledForTests = null;
    cachedEnabled = null;
}
