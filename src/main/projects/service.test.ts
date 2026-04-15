import { describe, expect, it } from "vitest";

import { shouldIgnoreProjectWatchPath } from "./service";

describe("project watcher filtering", () => {
    it("ignores git index updates triggered by status refreshes", () => {
        expect(shouldIgnoreProjectWatchPath(".git/index")).toBe(true);
        expect(shouldIgnoreProjectWatchPath(".git/index.lock")).toBe(true);
        expect(shouldIgnoreProjectWatchPath(".git\\index")).toBe(true);
    });

    it("keeps invalidating for regular project files and unknown events", () => {
        expect(shouldIgnoreProjectWatchPath("src/main.ts")).toBe(false);
        expect(shouldIgnoreProjectWatchPath(".git/HEAD")).toBe(false);
        expect(shouldIgnoreProjectWatchPath(null)).toBe(false);
    });
});
