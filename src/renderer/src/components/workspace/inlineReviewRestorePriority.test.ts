import { describe, expect, it } from "vitest";

import {
    resolveInlineReviewRestoreCandidate,
    resolvePendingEditorInlineReviewRestoreState,
} from "./inlineReviewRestorePriority";

describe("resolveInlineReviewRestoreCandidate", () => {
    const scrollState = { scrollTop: 10 };
    const currentInlineState = { lineNumber: 20, source: "current-inline" };
    const portableEditorState = { lineNumber: 30, source: "editor" };

    it("prioritizes explicit open location navigation", () => {
        expect(
            resolveInlineReviewRestoreCandidate({
                currentInlineReviewRestoreState: currentInlineState,
                didConsumePendingOpenLocation: true,
                pendingEditorInlineReviewRestoreState: portableEditorState,
                scrollState,
            }),
        ).toEqual({ kind: "openLocation" });
    });

    it("keeps the current inline review position across model refreshes", () => {
        expect(
            resolveInlineReviewRestoreCandidate({
                currentInlineReviewRestoreState: currentInlineState,
                didConsumePendingOpenLocation: false,
                pendingEditorInlineReviewRestoreState: portableEditorState,
                scrollState,
            }),
        ).toEqual({
            kind: "currentInlineReviewState",
            state: currentInlineState,
        });
    });

    it("uses the portable editor state before persisted view state", () => {
        expect(
            resolveInlineReviewRestoreCandidate({
                currentInlineReviewRestoreState: null,
                didConsumePendingOpenLocation: false,
                pendingEditorInlineReviewRestoreState: portableEditorState,
                scrollState,
            }),
        ).toEqual({
            kind: "portableEditorState",
            state: portableEditorState,
        });
    });

    it("uses previous diff scroll state as the final fallback", () => {
        expect(
            resolveInlineReviewRestoreCandidate({
                currentInlineReviewRestoreState: null,
                didConsumePendingOpenLocation: false,
                pendingEditorInlineReviewRestoreState: null,
                scrollState,
            }),
        ).toEqual({
            kind: "diffScrollState",
            state: scrollState,
        });
    });
});

describe("resolvePendingEditorInlineReviewRestoreState", () => {
    const portableEditorState = { lineNumber: 30, source: "editor" };

    it("ignores stale portable state from a different review signature", () => {
        expect(
            resolvePendingEditorInlineReviewRestoreState({
                pendingState: {
                    reviewSignature: "review:v1",
                    state: portableEditorState,
                    tabId: "file-1",
                },
                reviewSignature: "review:v2",
                tabId: "file-1",
            }),
        ).toEqual({
            shouldClear: true,
            state: null,
        });
    });
});
