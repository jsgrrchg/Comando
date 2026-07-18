export type ChatPerformanceCounter =
    | "activity_items_mounted"
    | "stable_history_entries_visited"
    | "timeline_blocks_built"
    | "timeline_full_rebuilds"
    | "transcript_blocks_evicted"
    | "transcript_blocks_loaded";

export type ChatPerformanceCounterSnapshot = Readonly<
    Record<ChatPerformanceCounter, number>
>;

const EMPTY_COUNTERS: ChatPerformanceCounterSnapshot = {
    activity_items_mounted: 0,
    stable_history_entries_visited: 0,
    timeline_blocks_built: 0,
    timeline_full_rebuilds: 0,
    transcript_blocks_evicted: 0,
    transcript_blocks_loaded: 0,
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
