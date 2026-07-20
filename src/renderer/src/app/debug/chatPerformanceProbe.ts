const CHAT_PERFORMANCE_PROBE_STORAGE_KEY = "comando:chat-performance-probe";
const MAX_CHAT_PERFORMANCE_EVENTS = 10_000;

export type ChatPerformanceMetric =
    | "ack_lag_ms"
    | "apply_event_ms"
    | "block_projection_ms"
    | "chat_frame"
    | "code_highlight_ms"
    | "delta_buffer_wait_ms"
    | "diff_prepare_ms"
    | "long_task"
    | "markdown_commit"
    | "markdown_parse_ms"
    | "presentation_build_ms"
    | "react_commit_ms"
    | "review_index_ms"
    | "scroll_write"
    | "timeline_reconcile_ms"
    | "transcript_payload_batch_ms"
    | "transcript_payload_load_ms"
    | "transcript_patch_ms"
    | "virtual_measure"
    | "virtual_range";

export type ChatScrollWriteReason =
    | "follow-end"
    | "measure-anchor"
    | "new-turn"
    | "restore"
    | "scroll-to-index"
    | "settle";

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
let longTaskObserver: PerformanceObserver | null = null;
let longTaskObserverAttempted = false;
let activeChatPerformanceFrameTime = 0;

const CHAT_SCROLL_REASON_CODE: Readonly<Record<ChatScrollWriteReason, number>> = {
    "follow-end": 1,
    "measure-anchor": 2,
    "new-turn": 3,
    restore: 4,
    "scroll-to-index": 5,
    settle: 6,
};

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

    ensureChatLongTaskObserver();
    appendChatPerformanceEvent(metric, input);
}

function appendChatPerformanceEvent(
    metric: ChatPerformanceMetric,
    input: ChatPerformanceMetricInput,
): void {
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

function ensureChatLongTaskObserver(): void {
    if (
        longTaskObserverAttempted ||
        typeof PerformanceObserver === "undefined"
    ) {
        return;
    }

    longTaskObserverAttempted = true;
    try {
        longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                appendChatPerformanceEvent("long_task", {
                    durationMs: entry.duration,
                    values: { startTime: entry.startTime },
                });
            }
        });
        longTaskObserver.observe({ entryTypes: ["longtask"] });
    } catch {
        longTaskObserver = null;
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

export async function measureChatPerformanceAsync<T>(
    metric: ChatPerformanceMetric,
    input: Omit<ChatPerformanceMetricInput, "durationMs">,
    operation: () => Promise<T>,
): Promise<T> {
    if (!isChatPerformanceProbeEnabled()) {
        return operation();
    }

    const start = performance.now();
    try {
        return await operation();
    } finally {
        recordChatPerformanceMetric(metric, {
            ...input,
            durationMs: performance.now() - start,
        });
    }
}

export function recordChatScrollWrite(input: {
    readonly after: number;
    readonly before: number;
    readonly clientHeight: number;
    readonly navigationGeneration?: number;
    readonly reason: ChatScrollWriteReason;
    readonly scrollHeight: number;
    readonly sessionId?: string;
}): void {
    recordChatPerformanceMetric("scroll_write", {
        sessionId: input.sessionId,
        values: {
            after: input.after,
            before: input.before,
            clientHeight: input.clientHeight,
            frameTime: activeChatPerformanceFrameTime,
            navigationGeneration: input.navigationGeneration,
            reasonCode: CHAT_SCROLL_REASON_CODE[input.reason],
            scrollHeight: input.scrollHeight,
        },
    });
}

export function markChatPerformanceFrame(frameAt: number): void {
    if (!isChatPerformanceProbeEnabled() || !Number.isFinite(frameAt)) {
        return;
    }
    activeChatPerformanceFrameTime = Number(frameAt.toFixed(2));
}

export function hashChatPerformanceLabel(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
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
    longTaskObserver?.disconnect();
    longTaskObserver = null;
    longTaskObserverAttempted = false;
    activeChatPerformanceFrameTime = 0;
    enabledForTests = null;
    cachedEnabled = null;
}
