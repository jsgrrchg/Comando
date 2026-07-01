export type InlineReviewRestoreCandidate<
    TPortableState,
    TViewState,
    TScrollState,
> =
    | { readonly kind: "openLocation" }
    | {
          readonly kind: "currentInlineReviewState";
          readonly state: TPortableState;
      }
    | {
          readonly kind: "portableEditorState";
          readonly state: TPortableState;
      }
    | {
          readonly kind: "viewState";
          readonly state: TViewState;
      }
    | {
          readonly kind: "diffScrollState";
          readonly state: TScrollState;
      };

export function resolveInlineReviewRestoreCandidate<
    TPortableState,
    TViewState,
    TScrollState,
>(input: {
    readonly currentInlineReviewRestoreState: TPortableState | null;
    readonly didConsumePendingOpenLocation: boolean;
    readonly pendingEditorInlineReviewRestoreState: TPortableState | null;
    readonly persistedInlineReviewViewState: TViewState | null;
    readonly scrollState: TScrollState;
}): InlineReviewRestoreCandidate<TPortableState, TViewState, TScrollState> {
    if (input.didConsumePendingOpenLocation) {
        return { kind: "openLocation" };
    }

    if (input.currentInlineReviewRestoreState) {
        return {
            kind: "currentInlineReviewState",
            state: input.currentInlineReviewRestoreState,
        };
    }

    if (input.pendingEditorInlineReviewRestoreState) {
        return {
            kind: "portableEditorState",
            state: input.pendingEditorInlineReviewRestoreState,
        };
    }

    if (input.persistedInlineReviewViewState) {
        return {
            kind: "viewState",
            state: input.persistedInlineReviewViewState,
        };
    }

    return {
        kind: "diffScrollState",
        state: input.scrollState,
    };
}
