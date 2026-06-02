import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    checkClaudeCodeInstalled,
    resetClaudeCodeInstalledCacheForTests,
} from "./claudeCodeTerminal";

const checkCommandAvailabilityMock = vi.fn();

describe("checkClaudeCodeInstalled", () => {
    beforeEach(() => {
        resetClaudeCodeInstalledCacheForTests();
        checkCommandAvailabilityMock.mockReset();
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    checkCommandAvailability: checkCommandAvailabilityMock,
                },
            },
            writable: true,
        });
    });

    it("checks Claude Code availability through IPC and caches the result", async () => {
        checkCommandAvailabilityMock
            .mockResolvedValueOnce({ found: true, path: "/usr/local/bin/claude" })
            .mockResolvedValueOnce({ found: false, path: null });

        await expect(checkClaudeCodeInstalled()).resolves.toBe(true);
        await expect(checkClaudeCodeInstalled()).resolves.toBe(true);

        expect(checkCommandAvailabilityMock).toHaveBeenCalledTimes(1);
        expect(checkCommandAvailabilityMock).toHaveBeenCalledWith({
            name: "claude",
        });
    });

    it("caches false when the bridge check fails", async () => {
        checkCommandAvailabilityMock.mockRejectedValueOnce(new Error("boom"));

        await expect(checkClaudeCodeInstalled()).resolves.toBe(false);
        await expect(checkClaudeCodeInstalled()).resolves.toBe(false);

        expect(checkCommandAvailabilityMock).toHaveBeenCalledTimes(1);
    });
});
