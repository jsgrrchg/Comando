import { describe, expect, it } from "vitest";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";

import {
    deriveToolActivityReviewEntries,
    deriveTrackedFilesForToolActivity,
} from "./toolActivityReviewModel";

function createActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        diffs: [],
        id: "tool-1",
        kind: "edit",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "completed",
        summary: null,
        title: "Edit file",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...overrides,
    };
}

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return {
        hunks: [],
        identityKey: "tracked-1",
        isText: true,
        kind: "update",
        newText: "next",
        oldText: "prev",
        path: "src/app.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...overrides,
    };
}

describe("toolActivityReviewModel", () => {
    it("prefiere el match explicito por toolCallId", () => {
        const activity = createActivity();
        const trackedFiles = [
            createTrackedFile(),
            createTrackedFile({
                identityKey: "tracked-2",
                path: "src/other.ts",
                toolCallId: "tool-1",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        ];

        expect(
            deriveTrackedFilesForToolActivity(activity, trackedFiles).map(
                (trackedFile) => trackedFile.identityKey,
            ),
        ).toEqual(["tracked-2", "tracked-1"]);
    });

    it("usa fallback por path solo cuando el match es univoco", () => {
        const activity = createActivity({
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "next",
                    oldText: "prev",
                    path: "src/app.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            id: "tool-without-link",
        });
        const trackedFile = createTrackedFile({
            toolCallId: null,
        });

        expect(
            deriveTrackedFilesForToolActivity(activity, [trackedFile]).map(
                (candidate) => candidate.identityKey,
            ),
        ).toEqual(["tracked-1"]);
    });

    it("omite fallback ambiguo por path", () => {
        const activity = createActivity({
            id: "tool-without-link",
            locations: ["src/app.ts"],
        });
        const trackedFiles = [
            createTrackedFile({
                identityKey: "tracked-1",
                toolCallId: null,
            }),
            createTrackedFile({
                identityKey: "tracked-2",
                path: "src/app.ts",
                toolCallId: null,
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        ];

        expect(
            deriveTrackedFilesForToolActivity(activity, trackedFiles),
        ).toEqual([]);
    });

    it("deriva pending tracked files por activity", () => {
        const entries = deriveToolActivityReviewEntries(
            [
                createActivity(),
                createActivity({
                    id: "tool-2",
                    title: "Second tool",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                }),
            ],
            [
                createTrackedFile(),
                createTrackedFile({
                    identityKey: "tracked-2",
                    reviewState: "kept",
                    toolCallId: "tool-2",
                }),
            ],
        );

        expect(entries[0]?.hasPendingTrackedFiles).toBe(true);
        expect(entries[0]?.pendingTrackedFiles).toHaveLength(1);
        expect(entries[1]?.hasPendingTrackedFiles).toBe(false);
        expect(entries[1]?.trackedFiles).toHaveLength(1);
    });
});
