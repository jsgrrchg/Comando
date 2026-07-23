import { afterEach, describe, expect, it } from "vitest";

import {
    getFileSyncTraceSnapshot,
    recordFileSyncTrace,
    resetFileSyncTraceForTests,
    setFileSyncTraceEnabledForTests,
} from "./fileSyncProbe";

describe("fileSyncProbe", () => {
    afterEach(() => {
        resetFileSyncTraceForTests();
    });

    it("stays silent until explicitly enabled", () => {
        recordFileSyncTrace({
            content: "secret source text",
            event: "draft_changed",
            path: "src\\app.ts",
        });

        expect(getFileSyncTraceSnapshot()).toEqual([]);
    });

    it("records metadata without retaining source content", () => {
        setFileSyncTraceEnabledForTests(true);

        recordFileSyncTrace({
            content: "const token = 'sensitive';",
            contentRevision: 4,
            event: "reload_accepted",
            flags: {
                hasExternalChange: false,
                isDirty: false,
                isLoading: false,
                isSaving: false,
            },
            origin: "watcher",
            path: "./src\\app.ts",
            requestId: 7,
            tabId: "file-1",
        });

        const [event] = getFileSyncTraceSnapshot();
        expect(event?.contentHash).toMatch(/^[a-f0-9]{8}$/);
        expect(event).toMatchObject({
            contentLength: 26,
            contentRevision: 4,
            event: "reload_accepted",
            origin: "watcher",
            path: "src/app.ts",
            requestId: 7,
            tabId: "file-1",
        });
        expect(JSON.stringify(getFileSyncTraceSnapshot())).not.toContain(
            "sensitive",
        );
    });

    it("keeps only the most recent circular-buffer entries", () => {
        setFileSyncTraceEnabledForTests(true);

        for (let index = 0; index < 514; index += 1) {
            recordFileSyncTrace({
                event: "read_started",
                requestId: index,
            });
        }

        const events = getFileSyncTraceSnapshot();
        expect(events).toHaveLength(512);
        expect(events[0]?.requestId).toBe(2);
        expect(events.at(-1)?.requestId).toBe(513);
    });
});
