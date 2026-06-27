import { describe, expect, it } from "vitest";

import type { AiTrackedFile } from "@shared/ipc";

import {
    createReviewFileMutationInput,
    createReviewHunkMutationInput,
} from "./reviewMutationTarget";

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return {
        hunks: [],
        identityKey: "review:session-1:src/app.ts",
        isText: true,
        kind: "update",
        newText: "after\n",
        oldText: "before\n",
        path: "src/app.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-06-26T00:00:00.000Z",
        version: 3,
        ...overrides,
    };
}

describe("reviewMutationTarget", () => {
    it("builds file mutation targets with identity and version", () => {
        expect(createReviewFileMutationInput(createTrackedFile())).toEqual({
            expectedVersion: 3,
            path: "src/app.ts",
            sessionId: "session-1",
            trackedFileId: "review:session-1:src/app.ts",
        });
    });

    it("builds hunk mutation targets with identity and version", () => {
        expect(
            createReviewHunkMutationInput(createTrackedFile(), ["hunk-1"]),
        ).toEqual({
            expectedVersion: 3,
            hunkIds: ["hunk-1"],
            path: "src/app.ts",
            sessionId: "session-1",
            trackedFileId: "review:session-1:src/app.ts",
        });
    });

    it("defaults missing versions to version one", () => {
        expect(
            createReviewFileMutationInput(
                createTrackedFile({ version: undefined }),
            ),
        ).toMatchObject({
            expectedVersion: 1,
        });
    });
});
