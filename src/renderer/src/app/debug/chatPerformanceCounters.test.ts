import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    incrementChatPerformanceCounter,
    readChatPerformanceCounters,
    resetChatPerformanceCounters,
    setChatPerformanceCountersEnabledForTests,
} from "./chatPerformanceCounters";

describe("chatPerformanceCounters", () => {
    beforeEach(resetChatPerformanceCounters);
    afterEach(() => {
        setChatPerformanceCountersEnabledForTests(null);
    });

    it("records only bounded numeric diagnostics", () => {
        incrementChatPerformanceCounter("timeline_blocks_built", 2);
        incrementChatPerformanceCounter("timeline_full_rebuilds");
        incrementChatPerformanceCounter("transcript_entries_visited", 256);

        expect(readChatPerformanceCounters()).toMatchObject({
            timeline_blocks_built: 2,
            timeline_full_rebuilds: 1,
            transcript_entries_visited: 256,
        });
    });

    it("can disable counters without allocating diagnostic payloads", () => {
        setChatPerformanceCountersEnabledForTests(false);
        incrementChatPerformanceCounter("transcript_entries_visited", 1_024);
        incrementChatPerformanceCounter("tool_payloads_requested");

        expect(readChatPerformanceCounters()).toMatchObject({
            transcript_entries_visited: 0,
            tool_payloads_requested: 0,
        });
    });

    it("resets the complete numeric snapshot between scenario phases", () => {
        incrementChatPerformanceCounter("markdown_full_parses");
        incrementChatPerformanceCounter("tool_payload_bytes_loaded", 4_096);

        resetChatPerformanceCounters();

        expect(readChatPerformanceCounters()).toEqual({
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
            transcript_blocks_evicted: 0,
            transcript_blocks_loaded: 0,
            transcript_blocks_projected: 0,
            transcript_entries_visited: 0,
            transcript_payload_bytes: 0,
            transcript_payload_ipc_count: 0,
            tool_payload_bytes_loaded: 0,
            tool_payloads_requested: 0,
        });
    });
});
