import { describe, expect, it } from "vitest";

import {
    shouldCancelSidebarDragOnMove,
    shouldEmitSidebarDragCancel,
} from "./sidebarDragGuards";

describe("sidebarDragGuards", () => {
    it("cancels sidebar drag when primary pointer is not pressed", () => {
        expect(shouldCancelSidebarDragOnMove(0)).toBe(true);
        expect(shouldCancelSidebarDragOnMove(2)).toBe(true);
    });

    it("keeps sidebar drag while primary pointer is pressed", () => {
        expect(shouldCancelSidebarDragOnMove(1)).toBe(false);
        expect(shouldCancelSidebarDragOnMove(3)).toBe(false);
    });

    it("emits cancel only for active drags", () => {
        expect(shouldEmitSidebarDragCancel(false)).toBe(false);
        expect(shouldEmitSidebarDragCancel(true)).toBe(true);
    });
});
