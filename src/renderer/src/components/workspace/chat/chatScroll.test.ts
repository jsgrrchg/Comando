import { describe, expect, it } from "vitest";

import {
    isScrollViewportNearBottom,
    resolveChatScrollPersistenceState,
} from "./chatScroll";

describe("isScrollViewportNearBottom", () => {
    it("returns true when the viewport is inside the threshold", () => {
        expect(isScrollViewportNearBottom(840, 1000, 120, 80)).toBe(true);
    });

    it("returns false when the viewport is outside the threshold", () => {
        expect(isScrollViewportNearBottom(760, 1000, 120, 80)).toBe(false);
    });

    it("treats the exact threshold boundary as not near bottom", () => {
        expect(isScrollViewportNearBottom(800, 1000, 120, 80)).toBe(false);
    });
});

describe("resolveChatScrollPersistenceState", () => {
    it("keeps a pending bottom intent ahead of a stale auto-follow ref", () => {
        expect(
            resolveChatScrollPersistenceState({
                currentScrollTop: 120,
                pendingIsNearBottom: true,
                pendingScrollTop: 980,
                restoreScrollTop: 80,
                shouldAutoFollow: false,
            }),
        ).toEqual({
            isNearBottom: true,
            scrollTop: 980,
        });
    });

    it("falls back to the current scroll position and auto-follow state", () => {
        expect(
            resolveChatScrollPersistenceState({
                currentScrollTop: 320,
                pendingIsNearBottom: null,
                pendingScrollTop: null,
                restoreScrollTop: 80,
                shouldAutoFollow: false,
            }),
        ).toEqual({
            isNearBottom: false,
            scrollTop: 320,
        });
    });
});
