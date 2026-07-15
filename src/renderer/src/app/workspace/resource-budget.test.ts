import { describe, expect, it } from "vitest";

import {
    MAX_WORKSPACE_CACHED_ARTIFACTS,
    WorkspaceArtifactBudget,
} from "./resource-budget";

describe("WorkspaceArtifactBudget", () => {
    it("evicts the least recently used artifact across scopes", () => {
        const budget = new WorkspaceArtifactBudget();
        for (let index = 0; index <= MAX_WORKSPACE_CACHED_ARTIFACTS; index += 1) {
            budget.set(index % 2 === 0 ? "chat" : "diff", `${index}`, index);
        }

        expect(budget.get("chat", "0")).toBeNull();
        expect(budget.sizeForTests()).toBe(MAX_WORKSPACE_CACHED_ARTIFACTS);
    });
});
