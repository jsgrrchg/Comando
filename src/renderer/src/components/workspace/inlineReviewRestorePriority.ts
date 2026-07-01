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

export type PendingEditorInlineReviewRestoreState<TPortableState> = {
    readonly reviewSignature: string | null;
    readonly state: TPortableState;
    readonly tabId: string;
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

export function resolvePendingEditorInlineReviewRestoreState<TPortableState>(
    input: {
        readonly pendingState: PendingEditorInlineReviewRestoreState<TPortableState> | null;
        readonly reviewSignature: string | null;
        readonly tabId: string;
    },
): {
    readonly shouldClear: boolean;
    readonly state: TPortableState | null;
} {
    if (!input.pendingState || input.pendingState.tabId !== input.tabId) {
        return {
            shouldClear: false,
            state: null,
        };
    }

    if (
        input.pendingState.reviewSignature !== null &&
        input.pendingState.reviewSignature !== input.reviewSignature
    ) {
        return {
            shouldClear: true,
            state: null,
        };
    }

    return {
        shouldClear: false,
        state: input.pendingState.state,
    };
}
