import { describe, expect, it } from "vitest";

import {
    MAX_RENDERER_CACHED_ARTIFACTS,
    RendererArtifactCache,
} from "./resource-budget";

describe("RendererArtifactCache", () => {
    it("evicts the least recently used artifact across scopes", () => {
        const budget = new RendererArtifactCache();
        for (let index = 0; index <= MAX_RENDERER_CACHED_ARTIFACTS; index += 1) {
            budget.set(index % 2 === 0 ? "chat" : "diff", `${index}`, index);
        }

        expect(budget.get("chat", "0")).toBeNull();
        expect(budget.sizeForTests()).toBe(MAX_RENDERER_CACHED_ARTIFACTS);
    });

    it("enforces bytes while protecting visible artifacts", () => {
        const budget = new RendererArtifactCache(10, 100);
        budget.set("chat", "visible", {}, {
            estimatedBytes: 80,
            protected: true,
        });
        budget.set("chat", "recoverable", {}, { estimatedBytes: 80 });

        expect(budget.get("chat", "visible")).not.toBeNull();
        expect(budget.get("chat", "recoverable")).toBeNull();
        expect(budget.getStats().estimatedBytes).toBe(80);
    });
});
