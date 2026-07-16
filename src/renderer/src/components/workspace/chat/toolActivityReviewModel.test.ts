import { afterEach, describe, expect, it } from "vitest";

import type {
    AiToolActivity,
    AiTrackedFile,
    AppBootstrapSnapshot,
} from "@shared/ipc";

import { useAppStore } from "@renderer/app/store/app-store";
import {
    createToolActivityReviewIndex,
    deriveChangeReviewItems,
    deriveChangeReviewSummary,
    deriveToolActivityReviewEntriesFromIndex,
    deriveToolActivityReviewEntries,
    deriveToolActivityReviewEntry,
    deriveTrackedFilesForToolActivityFromIndex,
    deriveTrackedFilesForToolActivity,
} from "./toolActivityReviewModel";

afterEach(() => {
    useAppStore.setState({
        bootstrap: null,
        error: null,
        status: "idle",
    });
});

function setRendererPlatform(platform: string): void {
    useAppStore.setState({
        bootstrap: { platform } as AppBootstrapSnapshot,
        error: null,
        status: "ready",
    });
}

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
    it("indexes explicit tool calls and reuses the index for stable tracked files", () => {
        const activity = createActivity();
        const trackedFiles = [
            createTrackedFile(),
            createTrackedFile({
                identityKey: "tracked-2",
                toolCallId: "tool-2",
            }),
        ];
        const index = createToolActivityReviewIndex(trackedFiles);

        expect(createToolActivityReviewIndex(trackedFiles)).toBe(index);
        expect(index.trackedFilesBySessionId.get("session-1")).toEqual(
            trackedFiles,
        );
        expect(
            deriveTrackedFilesForToolActivityFromIndex(activity, index),
        ).toEqual(deriveTrackedFilesForToolActivity(activity, trackedFiles));
        expect(deriveToolActivityReviewEntry(activity, index)).toBe(
            deriveToolActivityReviewEntry(activity, index),
        );
    });

    it("matches renamed diff paths through indexed fallback candidates", () => {
        const activity = createActivity({
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "move",
                    newText: "next",
                    oldText: "prev",
                    path: "src/new-name.ts",
                    previousPath: "src/old-name.ts",
                    reversible: true,
                },
            ],
            id: "tool-without-link",
        });
        const trackedFile = createTrackedFile({
            path: "src/new-name.ts",
            previousPath: "src/old-name.ts",
            toolCallId: null,
        });

        expect(
            deriveTrackedFilesForToolActivityFromIndex(
                activity,
                createToolActivityReviewIndex([trackedFile]),
            ),
        ).toEqual([trackedFile]);
    });

    it("preserves entries for tools unrelated to a tracked-file update", () => {
        const firstActivity = createActivity({ id: "tool-1" });
        const secondActivity = createActivity({ id: "tool-2" });
        const firstTrackedFile = createTrackedFile({ toolCallId: "tool-1" });
        const secondTrackedFile = createTrackedFile({
            identityKey: "tracked-2",
            path: "src/second.ts",
            toolCallId: "tool-2",
        });
        const activities = [firstActivity, secondActivity];
        const previousEntries = deriveToolActivityReviewEntriesFromIndex(
            activities,
            createToolActivityReviewIndex([
                firstTrackedFile,
                secondTrackedFile,
            ]),
        );
        const nextEntries = deriveToolActivityReviewEntriesFromIndex(
            activities,
            createToolActivityReviewIndex([
                {
                    ...firstTrackedFile,
                    reviewState: "kept",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                },
                secondTrackedFile,
            ]),
            previousEntries,
        );

        expect(nextEntries[0]).not.toBe(previousEntries[0]);
        expect(nextEntries[1]).toBe(previousEntries[1]);
    });

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

    it("scopes explicit tool-call matches to the activity session", () => {
        const activity = createActivity();
        const trackedFiles = [
            createTrackedFile({ identityKey: "current-session" }),
            createTrackedFile({
                identityKey: "other-session",
                sessionId: "session-2",
            }),
        ];

        expect(
            deriveTrackedFilesForToolActivity(activity, trackedFiles).map(
                (trackedFile) => trackedFile.identityKey,
            ),
        ).toEqual(["current-session"]);
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

    it("uses structured raw input when native locations are missing", () => {
        const activity = createActivity({
            id: "tool-without-link",
            kind: "read",
            locations: [],
            rawInputJson: JSON.stringify({ file_path: "src/app.ts" }),
        });
        const trackedFile = createTrackedFile({ toolCallId: null });

        expect(
            deriveTrackedFilesForToolActivity(activity, [trackedFile]).map(
                (candidate) => candidate.identityKey,
            ),
        ).toEqual(["tracked-1"]);
    });

    it("scopes raw-input path fallback to the activity session", () => {
        const activity = createActivity({
            id: "tool-without-link",
            kind: "read",
            rawInputJson: JSON.stringify({ file_path: "src/app.ts" }),
        });
        const trackedFiles = [
            createTrackedFile({
                identityKey: "current-session",
                toolCallId: null,
            }),
            createTrackedFile({
                identityKey: "other-session",
                sessionId: "session-2",
                toolCallId: null,
            }),
        ];

        expect(
            deriveTrackedFilesForToolActivity(activity, trackedFiles).map(
                (trackedFile) => trackedFile.identityKey,
            ),
        ).toEqual(["current-session"]);
    });

    it("uses normalized path fallback for Windows separator aliases", () => {
        const activity = createActivity({
            id: "tool-without-link",
            locations: [
                {
                    endLine: null,
                    line: null,
                    path: "src/app.ts",
                },
            ],
        });
        const trackedFile = createTrackedFile({
            path: "src\\app.ts",
            toolCallId: null,
        });

        expect(
            deriveTrackedFilesForToolActivity(activity, [trackedFile]).map(
                (candidate) => candidate.identityKey,
            ),
        ).toEqual(["tracked-1"]);
    });

    it("matches absolute activity paths to relative native review paths", () => {
        const activity = createActivity({
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "next",
                    oldText: "prev",
                    path: "/Users/example/project/cuento.md",
                    previousPath: null,
                    reversible: true,
                },
            ],
            id: "tool-without-link",
        });
        const trackedFile = createTrackedFile({
            path: "cuento.md",
            toolCallId: null,
        });

        expect(
            deriveTrackedFilesForToolActivity(activity, [trackedFile]).map(
                (candidate) => candidate.identityKey,
            ),
        ).toEqual(["tracked-1"]);

        const items = deriveChangeReviewItems(activity, [trackedFile]);
        expect(items).toHaveLength(1);
        expect(items[0]?.file?.identityKey).toBe("tracked-1");
    });

    it("matches Windows absolute activity paths to relative native review paths", () => {
        setRendererPlatform("win32");

        const activity = createActivity({
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "next",
                    oldText: "prev",
                    path: "C:\\Users\\example\\project\\src\\App.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            id: "tool-without-link",
        });
        const trackedFile = createTrackedFile({
            path: "src/app.ts",
            toolCallId: null,
        });

        const items = deriveChangeReviewItems(activity, [trackedFile]);

        expect(items).toHaveLength(1);
        expect(items[0]?.file?.identityKey).toBe("tracked-1");
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
            locations: [
                {
                    endLine: null,
                    line: null,
                    path: "src/app.ts",
                },
            ],
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

    it("matches diffs to tracked files with Windows casing aliases", () => {
        const activity = createActivity({
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "next",
                    oldText: "prev",
                    path: "c:\\repo\\src\\app.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
        });
        const trackedFile = createTrackedFile({
            path: "C:\\Repo\\src\\App.ts",
        });

        const [item] = deriveChangeReviewItems(activity, [trackedFile]);

        expect(item?.file?.identityKey).toBe("tracked-1");
    });

    it("matches relative forward-slash diffs with Windows casing aliases", () => {
        setRendererPlatform("win32");

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
        const trackedFile = createTrackedFile({
            path: "src/App.ts",
        });

        const [item] = deriveChangeReviewItems(activity, [trackedFile]);

        expect(item?.file?.identityKey).toBe("tracked-1");
    });

    it("renders the tracked-file diff when a tracked file is matched", () => {
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
        expect(item?.diff.hunks[0]?.id).toBe("full-file-hunk");
        expect(item?.diff.hunks[0]?.oldStart).toBe(1502);
        expect(item?.diff.hunks[0]?.newStart).toBe(1502);
        expect(activity.diffs[0]?.hunks[0]?.id).toBe("snippet-hunk");
    });

    it("does not show accepted cumulative activity hunks after the action log rebases pending text", () => {
        const activity = createActivity({
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "A\nZ\n",
                    oldText: "A\nfirst accepted\nsecond pending\nZ\n",
                    path: "cuento.md",
                    previousPath: null,
                    reversible: true,
                },
            ],
            id: "tool-next-turn",
        });
        const trackedFile = createTrackedFile({
            currentText: "A\nZ\n",
            diffBase: "A\nsecond pending\nZ\n",
            newText: "A\nZ\n",
            oldText: "A\nsecond pending\nZ\n",
            path: "cuento.md",
            toolCallId: "tool-next-turn",
        });

        const [item] = deriveChangeReviewItems(activity, [trackedFile]);

        expect(item?.diff.oldText).toBe("A\nsecond pending\nZ\n");
        expect(item?.diff.newText).toBe("A\nZ\n");
        expect(item?.stats.deletions).toBe(1);
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
