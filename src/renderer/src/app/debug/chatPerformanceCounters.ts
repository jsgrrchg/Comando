import { isChatPerformanceProbeEnabled } from "./chatPerformanceProbe";

export type ChatPerformanceCounter =
    | "ai_frame_payloads_coalesced"
    | "ai_frame_peak_pending_per_session"
    | "activity_segments_rebuilt"
    | "activity_items_mounted"
    | "code_highlight_chars_reparsed"
    | "diff_prepares"
    | "markdown_cache_hits"
    | "markdown_chars_reparsed"
    | "markdown_full_parses"
    | "markdown_suffix_parses"
    | "presentation_items_visited"
    | "stable_history_entries_visited"
    | "timeline_blocks_built"
    | "timeline_full_rebuilds"
    | "timeline_rows_reconciled"
    | "timeline_tail_patches"
    | "tool_activity_events_received"
    | "tool_activity_store_applies"
    | "transcript_blocks_evicted"
    | "transcript_blocks_loaded"
    | "transcript_blocks_projected"
    | "transcript_entries_visited"
    | "transcript_payload_bytes"
    | "transcript_payload_ipc_count"
    | "tool_payload_bytes_loaded"
    | "tool_payloads_requested"
    | "workspace_presence_publishes";

export type ChatPerformanceCounterSnapshot = Readonly<
    Record<ChatPerformanceCounter, number>
>;

const EMPTY_COUNTERS: ChatPerformanceCounterSnapshot = {
    ai_frame_payloads_coalesced: 0,
    ai_frame_peak_pending_per_session: 0,
    activity_segments_rebuilt: 0,
    activity_items_mounted: 0,
    code_highlight_chars_reparsed: 0,
    diff_prepares: 0,
    markdown_cache_hits: 0,
    markdown_chars_reparsed: 0,
    markdown_full_parses: 0,
    markdown_suffix_parses: 0,
    presentation_items_visited: 0,
    stable_history_entries_visited: 0,
    timeline_blocks_built: 0,
    timeline_full_rebuilds: 0,
    timeline_rows_reconciled: 0,
    timeline_tail_patches: 0,
    tool_activity_events_received: 0,
    tool_activity_store_applies: 0,
    transcript_blocks_evicted: 0,
    transcript_blocks_loaded: 0,
    transcript_blocks_projected: 0,
    transcript_entries_visited: 0,
    transcript_payload_bytes: 0,
    transcript_payload_ipc_count: 0,
    tool_payload_bytes_loaded: 0,
    tool_payloads_requested: 0,
    workspace_presence_publishes: 0,
};

let counters: Record<ChatPerformanceCounter, number> = { ...EMPTY_COUNTERS };
let enabledForTests: boolean | null = null;

export function incrementChatPerformanceCounter(
    counter: ChatPerformanceCounter,
    amount = 1,
): void {
    if (!isChatPerformanceCounterEnabled()) return;
    counters[counter] += amount;
}

export function recordChatPerformanceCounterPeak(
    counter: ChatPerformanceCounter,
    value: number,
): void {
    if (!isChatPerformanceCounterEnabled()) return;
    counters[counter] = Math.max(counters[counter], value);
}

export function readChatPerformanceCounters(): ChatPerformanceCounterSnapshot {
    return { ...counters };
}

export function resetChatPerformanceCounters(): void {
    counters = { ...EMPTY_COUNTERS };
}

export function setChatPerformanceCountersEnabledForTests(
    enabled: boolean | null,
): void {
    enabledForTests = enabled;
}

function isChatPerformanceCounterEnabled(): boolean {
    return (
        enabledForTests ??
        Boolean(
            import.meta.env.DEV ||
                import.meta.env.TEST ||
                isChatPerformanceProbeEnabled(),
        )
    );
}
