import { describe, expect, it } from "vitest";

import type { AiTrackedFile } from "./ipc";

import { computeDiffHunks, syncTrackedFile } from "./ai-tracked-file";

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    const path = overrides.path ?? "notes/example.md";
    const oldText = overrides.oldText ?? "alpha\nbeta\ngamma";
    const newText = overrides.newText ?? "alpha\nBETA\ngamma";

    return {
        currentText: newText,
        diffBase: oldText,
        hunks:
            overrides.hunks ??
            computeDiffHunks(oldText, newText, path),
        identityKey: path,
        isText: true,
        kind: "update",
        newText,
        oldText,
        path,
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-16T00:00:00.000Z",
        version: 1,
        ...overrides,
    };
}

describe("syncTrackedFile", () => {
    it("recomputes stale hunks from persisted text snapshots", () => {
        const oldText = "alpha\nbeta\ngamma";
        const newText = "alpha\nBETA\ngamma";
        const trackedFile = createTrackedFile({
            currentText: newText,
            diffBase: oldText,
            hunks: [
                {
                    id: "stale-hunk",
                    lines: [
                        { id: "line-1", text: "alpha", type: "remove" },
                        { id: "line-2", text: "beta", type: "remove" },
                        { id: "line-3", text: "gamma", type: "remove" },
                        { id: "line-4", text: "alpha", type: "add" },
                        { id: "line-5", text: "BETA", type: "add" },
                        { id: "line-6", text: "gamma", type: "add" },
                    ],
                    newCount: 3,
                    newStart: 1,
                    oldCount: 3,
                    oldStart: 1,
                    visualEndLine: 3,
                    visualStartLine: 1,
                },
            ],
            newText,
            oldText,
            path: "notes/example.md",
        });

        expect(syncTrackedFile(trackedFile).hunks).toEqual(
            computeDiffHunks(oldText, newText, trackedFile.path),
        );
    });
});
