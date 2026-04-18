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
            "/opt/homebrew/bin/gemini",
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
});
