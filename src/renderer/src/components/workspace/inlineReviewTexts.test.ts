import { describe, expect, it } from "vitest";

import type { AiTrackedFile } from "@shared/ipc";

import { buildInlineReviewTexts } from "./inlineReviewTexts";

function makeTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return {
        currentText: "",
        diffBase: "",
        hunks: [],
        identityKey: "file.ts",
        isText: true,
        kind: "update",
        newText: null,
        oldText: null,
        path: "file.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "call-1",
        updatedAt: "2026-04-17T00:00:00.000Z",
        version: 1,
        ...overrides,
    };
}

describe("buildInlineReviewTexts", () => {
    it("splices a snippet replacement into the full file", () => {
        const current = "alpha\nbeta\ngamma\ndelta\n";
        const tracked = makeTrackedFile({
            oldText: "beta\ngamma",
            newText: "BETA\nGAMMA",
        });

        const result = buildInlineReviewTexts(tracked, current);

        expect(result).toEqual({
            modified: "alpha\nBETA\nGAMMA\ndelta\n",
            original: current,
            wasReconstructed: true,
        });
    });

    it("returns the snippets unchanged when old text matches the full file", () => {
        const current = "alpha\nbeta\n";
        const tracked = makeTrackedFile({
            oldText: current,
            newText: "ALPHA\nBETA\n",
        });

        const result = buildInlineReviewTexts(tracked, current);

        expect(result).toEqual({
            modified: "ALPHA\nBETA\n",
            original: current,
            wasReconstructed: false,
        });
    });

    it("returns the snippets unchanged when new text already matches the file", () => {
        const current = "updated\n";
        const tracked = makeTrackedFile({
            oldText: "original\n",
            newText: current,
        });

        const result = buildInlineReviewTexts(tracked, current);

        expect(result).toEqual({
            modified: current,
            original: "original\n",
            wasReconstructed: false,
        });
    });

    it("falls back to null when the snippet appears more than once", () => {
        const current = "x\nx\ny\n";
        const tracked = makeTrackedFile({
            oldText: "x\n",
            newText: "Y\n",
        });

        expect(buildInlineReviewTexts(tracked, current)).toBeNull();
    });

    it("falls back to null when the snippet is absent from the file", () => {
        const current = "alpha\nbeta\n";
        const tracked = makeTrackedFile({
            oldText: "missing\n",
            newText: "replacement\n",
        });

        expect(buildInlineReviewTexts(tracked, current)).toBeNull();
    });

    it("falls back to null when both the snippet and the file content are missing", () => {
        const tracked = makeTrackedFile({ oldText: "", newText: "foo" });
        expect(buildInlineReviewTexts(tracked, null)).toBeNull();
    });

    it("uses the snippets when file content is unavailable", () => {
        const tracked = makeTrackedFile({
            oldText: "a",
            newText: "b",
        });

        expect(buildInlineReviewTexts(tracked, null)).toEqual({
            modified: "b",
            original: "a",
            wasReconstructed: false,
        });
    });
});
