import { describe, expect, it } from "vitest";

import { isWorkspaceSurfaceLifecycleCurrent } from "./surface-presentation-lifecycle";

describe("workspace surface presentation lifecycle", () => {
    const binding = {
        generation: "generation-2",
        runtimeOwnerId: "runtime-owner",
        scopeKey: "project::__primary__",
    };

    it("accepts lifecycle only for the immutable surface binding", () => {
        expect(
            isWorkspaceSurfaceLifecycleCurrent(binding, {
                ...binding,
                state: "visible",
            }),
        ).toBe(true);
        expect(
            isWorkspaceSurfaceLifecycleCurrent(binding, {
                ...binding,
                generation: "generation-1",
                state: "visible",
            }),
        ).toBe(false);
        expect(
            isWorkspaceSurfaceLifecycleCurrent(binding, {
                ...binding,
                runtimeOwnerId: "other-owner",
                state: "visible",
            }),
        ).toBe(false);
    });
});
