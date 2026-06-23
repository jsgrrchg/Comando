import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildRuntimeSpawnEnv } from "./runtime-env";

const originalPlatform = process.platform;

afterEach(() => {
    Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
    });
});

describe("buildRuntimeSpawnEnv", () => {
    it("prepends the executable directory and keeps existing PATH entries", () => {
        const env = buildRuntimeSpawnEnv(
            {
                PATH: ["/custom/bin", "/usr/bin"].join(path.delimiter),
            },
            "/opt/homebrew/bin/opencode",
        );

        expect(env.PATH?.split(path.delimiter)).toEqual([
            "/opt/homebrew/bin",
            ...(process.platform === "darwin"
                ? [
                      "/opt/homebrew/sbin",
                      "/usr/local/bin",
                      "/usr/local/sbin",
                  ]
                : []),
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            "/custom/bin",
        ]);
    });

    it("adds common macOS paths when PATH is empty", () => {
        Object.defineProperty(process, "platform", {
            configurable: true,
            value: "darwin",
        });

        const env = buildRuntimeSpawnEnv({}, "/opt/homebrew/bin/kilo");

        expect(env.PATH?.split(path.delimiter)).toEqual([
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]);
    });

    it("adds user install paths from the provided environment", () => {
        Object.defineProperty(process, "platform", {
            configurable: true,
            value: "darwin",
        });

        const homeDir = "/Users/example";
        const env = buildRuntimeSpawnEnv(
            {
                HOME: homeDir,
            },
            "/opt/homebrew/bin/opencode",
        );

        expect(env.PATH?.split(path.delimiter).slice(0, 5)).toEqual([
            "/opt/homebrew/bin",
            path.join(homeDir, "bin"),
            path.join(homeDir, ".grok/bin"),
            path.join(homeDir, ".opencode/bin"),
            path.join(homeDir, ".local/bin"),
        ]);
    });
});
