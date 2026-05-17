import { describe, expect, it } from "vitest";

import { shouldCancelWorkspaceTabDragOnMove } from "./useWorkspaceTabDrag";

describe("useWorkspaceTabDrag guards", () => {
    it("cancels drag move when primary pointer is no longer pressed", () => {
        expect(shouldCancelWorkspaceTabDragOnMove(0)).toBe(true);
        expect(shouldCancelWorkspaceTabDragOnMove(2)).toBe(true);
    });

    it("keeps drag move active when primary pointer remains pressed", () => {
        expect(shouldCancelWorkspaceTabDragOnMove(1)).toBe(false);
        expect(shouldCancelWorkspaceTabDragOnMove(3)).toBe(false);
    });
});
