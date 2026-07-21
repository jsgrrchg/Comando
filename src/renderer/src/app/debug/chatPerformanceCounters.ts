export type ChatPerformanceCounter =
    | "activity_items_mounted"
    | "code_highlight_chars_reparsed"
    | "diff_prepares"
    | "markdown_cache_hits"
    | "markdown_chars_reparsed"
    | "presentation_items_visited"
    | "stable_history_entries_visited"
    | "timeline_blocks_built"
    | "timeline_full_rebuilds"
    | "transcript_blocks_evicted"
    | "transcript_blocks_loaded"
    | "transcript_payload_bytes"
    | "transcript_payload_ipc_count";

export type ChatPerformanceCounterSnapshot = Readonly<
    Record<ChatPerformanceCounter, number>
>;

const EMPTY_COUNTERS: ChatPerformanceCounterSnapshot = {
    activity_items_mounted: 0,
    code_highlight_chars_reparsed: 0,
    diff_prepares: 0,
    markdown_cache_hits: 0,
    markdown_chars_reparsed: 0,
    presentation_items_visited: 0,
    stable_history_entries_visited: 0,
    timeline_blocks_built: 0,
    timeline_full_rebuilds: 0,
    transcript_blocks_evicted: 0,
    transcript_blocks_loaded: 0,
    transcript_payload_bytes: 0,
    transcript_payload_ipc_count: 0,
};

let counters: Record<ChatPerformanceCounter, number> = { ...EMPTY_COUNTERS };

export function incrementChatPerformanceCounter(
    counter: ChatPerformanceCounter,
    amount = 1,
): void {
    if (!import.meta.env.DEV && !import.meta.env.TEST) return;
    counters[counter] += amount;
}

export function readChatPerformanceCounters(): ChatPerformanceCounterSnapshot {
    return { ...counters };
}

export function resetChatPerformanceCounters(): void {
    counters = { ...EMPTY_COUNTERS };
}
