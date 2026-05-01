import { describe, expect, it } from "vitest";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";

import {
    deriveChangeReviewItems,
    deriveChangeReviewSummary,
    deriveToolActivityReviewEntries,
    deriveTrackedFilesForToolActivity,
} from "./toolActivityReviewModel";

function createActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "edit",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "completed",
        summary: null,
        terminalOutput: null,
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
    it("prefers explicit match by toolCallId", () => {
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

    it("uses path fallback only when match is unique", () => {
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

    it("does not use path fallback for tracked files owned by another tool call", () => {
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
            id: "tool-old",
        });
        const trackedFile = createTrackedFile({
            toolCallId: "tool-new",
        });

        expect(
            deriveTrackedFilesForToolActivity(activity, [trackedFile]),
        ).toEqual([]);
    });

    it("omits ambiguous path fallback", () => {
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

    it("derives pending tracked files by activity", () => {
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

    it("matches diffs to tracked files and adds fallback for unlisted edits", () => {
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
        });
        const secondaryTrackedFile = createTrackedFile({
            identityKey: "tracked-2",
            path: "src/secondary.ts",
            toolCallId: "tool-1",
            updatedAt: "2026-04-14T00:00:01.000Z",
        });

        const items = deriveChangeReviewItems(activity, [
            createTrackedFile(),
            secondaryTrackedFile,
        ]);

        expect(items).toHaveLength(2);
        expect(items[0]?.file?.identityKey).toBe("tracked-1");
        expect(items[1]?.file?.identityKey).toBe("tracked-2");
        expect(items[1]?.diff.path).toBe("src/secondary.ts");
    });

    it("prefers the matched tracked file diff for chat review rendering", () => {
        const activity = createActivity({
            diffs: [
                {
                    hunks: [
                        {
                            id: "snippet-hunk",
                            lines: [
                                {
                                    id: "snippet-remove",
                                    text: "old snippet",
                                    type: "remove",
                                },
                                {
                                    id: "snippet-add",
                                    text: "new snippet",
                                    type: "add",
                                },
                            ],
                            newCount: 1,
                            newStart: 4,
                            oldCount: 1,
                            oldStart: 4,
                            visualEndLine: 4,
                            visualStartLine: 4,
                        },
                    ],
                    isText: true,
                    kind: "update",
                    newText: "new snippet",
                    oldText: "old snippet",
                    path: "src/app.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
        });
        const trackedFile = createTrackedFile({
            hunks: [
                {
                    id: "full-file-hunk",
                    lines: [
                        {
                            id: "full-remove",
                            text: "old snippet",
                            type: "remove",
                        },
                        {
                            id: "full-add",
                            text: "new snippet",
                            type: "add",
                        },
                    ],
                    newCount: 1,
                    newStart: 1502,
                    oldCount: 1,
                    oldStart: 1502,
                    visualEndLine: 1502,
                    visualStartLine: 1502,
                },
            ],
            newText: "full file after",
            oldText: "full file before",
        });

        const [item] = deriveChangeReviewItems(activity, [trackedFile]);

        expect(item).toBeDefined();
        expect(item?.file?.identityKey).toBe("tracked-1");
        expect(item?.diff.hunks[0]?.oldStart).toBe(1502);
        expect(item?.diff.hunks[0]?.newStart).toBe(1502);
    });

    it("marks preview-only when only activity diff exists", () => {
        const activity = createActivity({
            diffs: [
                {
                    hunks: [],
                    isText: false,
                    kind: "create",
                    newText: null,
                    oldText: null,
                    path: "/tmp/generated.bin",
                    previousPath: null,
                    reversible: false,
                },
            ],
        });

        const [item] = deriveChangeReviewItems(activity, []);
        expect(item).toBeDefined();
        if (!item) {
            throw new Error("Expected a change review item.");
        }
        const summary = deriveChangeReviewSummary([item]);

        expect(item.file).toBeNull();
        expect(item.tone.badge).toBe("Partial");
        expect(item.canKeep).toBe(false);
        expect(summary.partialCount).toBe(1);
    });
});
