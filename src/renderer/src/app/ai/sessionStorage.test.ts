import { describe, expect, it } from "vitest";

import {
    getProjectStorageScope,
    getWorktreeStorageScope,
} from "./sessionStorage";

describe("sessionStorage scopes", () => {
    it("uses stable fallbacks and trims persisted scope ids", () => {
        expect(getProjectStorageScope(null)).toBe("global");
        expect(getProjectStorageScope(" project-1 ")).toBe("project-1");
        expect(getWorktreeStorageScope(undefined)).toBe("root");
        expect(getWorktreeStorageScope(" worktree-1 ")).toBe("worktree-1");
    });
});
