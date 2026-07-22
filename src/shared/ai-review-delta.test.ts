import { describe, expect, it } from "vitest";

import {
    attachNativeReviewDeltaToTrackedFile,
    toNativeReviewDeltaReference,
} from "./ai-review-delta";
import type { AiReviewDeltaSummary, AiTrackedFile } from "./ipc";

const delta: AiReviewDeltaSummary = {
    deltaId: "delta-1",
    files: [
        {
            path: "src/example.ts",
            state: "ready",
        },
    ],
    inputRevision: 3,
    revision: 4,
    sessionId: "session-1",
    state: "ready",
    toolCallId: "tool-1",
    updatedAt: "2026-07-21T00:00:00.000Z",
    workCycleId: "cycle-1",
};

const file: AiTrackedFile = {
    hunks: [],
    identityKey: "file-1",
    isText: true,
    kind: "update",
    newText: "next",
    oldText: "previous",
    path: "src/example.ts",
    previousPath: null,
    reversible: true,
    reviewState: "pending",
    sessionId: "session-1",
    toolCallId: null,
    updatedAt: delta.updatedAt,
};

describe("AI review delta helpers", () => {
    it("builds the native reference from the shared delta contract", () => {
        expect(toNativeReviewDeltaReference(delta)).toEqual({
            deltaId: "delta-1",
            expectedRevision: 4,
            inputRevision: 3,
            observedHashes: delta.files,
            sessionId: "session-1",
            toolCallId: "tool-1",
            workCycleId: "cycle-1",
        });
    });

    it("attaches the delta metadata without changing file content", () => {
        expect(attachNativeReviewDeltaToTrackedFile(file, delta)).toEqual({
            ...file,
            nativeReviewDeltaId: "delta-1",
            nativeReviewInputRevision: 3,
            nativeReviewState: "ready",
            nativeReviewWorkCycleId: "cycle-1",
            toolCallId: "tool-1",
            version: 4,
        });
    });
});
