import { describe, expect, it } from "vitest";

import type { AiFileDiff, AiToolActivity } from "@shared/ipc";

import type { ToolActivitySegmentEntry } from "./chatTimelineModel";
import { deriveActivitySegmentChangeStats } from "./activitySegmentChangeStats";

function createEntry(
    id: string,
    diff: AiFileDiff | null,
    changeStats: AiToolActivity["changeStats"] = null,
): ToolActivitySegmentEntry {
    const activity: AiToolActivity = {
        action: null,
        changeStats,
        createdAt: `2026-07-10T00:00:0${id}.000Z`,
        diffs: diff ? [diff] : [],
        exitCode: null,
        id: `edit-${id}`,
        kind: "edit",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "completed",
        summary: null,
        terminalOutput: null,
        title: "Edit src/app.ts",
        updatedAt: `2026-07-10T00:00:0${id}.000Z`,
    };

    return {
        policy: "standalone-change",
        reviewEntry: {
            activity,
            hasPendingTrackedFiles: false,
            pendingTrackedFiles: [],
            trackedFiles: [],
        },
    };
}

function updateDiff(oldText: string, newText: string): AiFileDiff {
    return {
        hunks: [],
        isText: true,
        kind: "update",
        newText,
        oldText,
        path: "src/app.ts",
        previousPath: null,
        reversible: true,
    };
}

describe("deriveActivitySegmentChangeStats", () => {
    it("calculates the net diff when the same file is reported repeatedly", () => {
        const stats = deriveActivitySegmentChangeStats([
            createEntry("1", updateDiff("base", "first")),
            createEntry("2", updateDiff("base", "first\nsecond")),
        ]);

        expect(stats).toEqual({
            additions: 2,
            approximate: false,
            deletions: 1,
        });
    });

    it("returns zero when later activity restores the initial file", () => {
        const stats = deriveActivitySegmentChangeStats([
            createEntry("1", updateDiff("base", "changed")),
            createEntry("2", updateDiff("base", "base")),
        ]);

        expect(stats).toEqual({
            additions: 0,
            approximate: false,
            deletions: 0,
        });
    });

    it("keeps independent files in the macro total", () => {
        const stats = deriveActivitySegmentChangeStats([
            createEntry("1", updateDiff("base", "changed")),
            createEntry("2", {
                ...updateDiff("old", "new"),
                path: "src/other.ts",
            }),
        ]);

        expect(stats).toEqual({
            additions: 2,
            approximate: false,
            deletions: 2,
        });
    });

    it("uses persisted header stats while compact diffs are still unloaded", () => {
        const stats = deriveActivitySegmentChangeStats([
            createEntry(
                "1",
                null,
                {
                    additions: 14,
                    approximate: false,
                    deletions: 3,
                    fileCount: 1,
                },
            ),
        ]);

        expect(stats).toEqual({
            additions: 14,
            approximate: false,
            deletions: 3,
        });
    });
});
