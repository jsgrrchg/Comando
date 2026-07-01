import { describe, expect, it } from "vitest";

import { resolveInlineReviewRestoreCandidate } from "./inlineReviewRestorePriority";

describe("resolveInlineReviewRestoreCandidate", () => {
    const scrollState = { scrollTop: 10 };
    const viewState = { cursor: "persisted" };
    const currentInlineState = { lineNumber: 20, source: "current-inline" };
    const portableEditorState = { lineNumber: 30, source: "editor" };

    it("prioritizes explicit open location navigation", () => {
        expect(
            resolveInlineReviewRestoreCandidate({
                currentInlineReviewRestoreState: currentInlineState,
                didConsumePendingOpenLocation: true,
                pendingEditorInlineReviewRestoreState: portableEditorState,
                persistedInlineReviewViewState: viewState,
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
                persistedInlineReviewViewState: viewState,
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
                persistedInlineReviewViewState: viewState,
                scrollState,
            }),
        ).toEqual({
            kind: "portableEditorState",
            state: portableEditorState,
        });
    });

    it("falls back to persisted view state before diff scroll state", () => {
        expect(
            resolveInlineReviewRestoreCandidate({
                currentInlineReviewRestoreState: null,
                didConsumePendingOpenLocation: false,
                pendingEditorInlineReviewRestoreState: null,
                persistedInlineReviewViewState: viewState,
                scrollState,
            }),
        ).toEqual({
            kind: "viewState",
            state: viewState,
        });
    });

    it("uses previous diff scroll state as the final fallback", () => {
        expect(
            resolveInlineReviewRestoreCandidate({
                currentInlineReviewRestoreState: null,
                didConsumePendingOpenLocation: false,
                pendingEditorInlineReviewRestoreState: null,
                persistedInlineReviewViewState: null,
                scrollState,
            }),
        ).toEqual({
            kind: "diffScrollState",
            state: scrollState,
        });
    });
});
