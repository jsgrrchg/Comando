import { describe, expect, it } from "vitest";

import { resolveProjectContextTabDropTarget } from "./useProjectContextTabDrag";

const contextKeys = ["project-a", "project-b", "project-c"];
const hitboxes = contextKeys.map((contextKey, index) => ({
    bottom: 28,
    contextKey,
    left: index * 100,
    right: index * 100 + 96,
    top: 0,
}));

describe("resolveProjectContextTabDropTarget", () => {
    it("resolves a final insertion index after the hovered tab", () => {
        expect(
            resolveProjectContextTabDropTarget({
                contextKeys,
                draggedContextKey: "project-a",
                hitboxes,
                pointer: { x: 290, y: 14 },
            }),
        ).toEqual({
            contextKey: "project-c",
            position: "after",
            targetIndex: 2,
        });
    });

    it("resolves a final insertion index before the hovered tab", () => {
        expect(
            resolveProjectContextTabDropTarget({
                contextKeys,
                draggedContextKey: "project-c",
                hitboxes,
                pointer: { x: 10, y: 14 },
            }),
        ).toEqual({
            contextKey: "project-a",
            position: "before",
            targetIndex: 0,
        });
    });

    it("does not return a target when the order would not change", () => {
        expect(
            resolveProjectContextTabDropTarget({
                contextKeys,
                draggedContextKey: "project-b",
                hitboxes,
                pointer: { x: 140, y: 14 },
            }),
        ).toBeNull();
    });
});
