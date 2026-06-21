import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    NATIVE_BACKEND_ENABLED_ENV,
    NATIVE_BACKEND_PATH_ENV,
    NATIVE_BACKEND_STRICT_ENV,
    getNativeBackendExecutableName,
    isNativeBackendEnabled,
    isNativeBackendStrict,
    resolveNativeBackendPath,
} from "./path";

describe("native backend flags", () => {
    it("requires explicit opt-in for the native backend", () => {
        expect(isNativeBackendEnabled({})).toBe(false);
        expect(isNativeBackendEnabled({ [NATIVE_BACKEND_ENABLED_ENV]: "1" })).toBe(
            true,
        );
        expect(isNativeBackendEnabled({ COMANDO_NATIVE_TERMINAL: "1" })).toBe(
            true,
        );
    });

    it("supports strict mode as a separate opt-in", () => {
        expect(isNativeBackendStrict({})).toBe(false);
        expect(isNativeBackendStrict({ [NATIVE_BACKEND_STRICT_ENV]: "1" })).toBe(
            true,
        );
    });
});

describe("resolveNativeBackendPath", () => {
    it("prefers the environment override", () => {
        const resolution = resolveNativeBackendPath({
            env: {
                [NATIVE_BACKEND_PATH_ENV]: "/custom/comando-native-backend",
            },
        });

        expect(resolution).toEqual({
            attemptedPaths: ["/custom/comando-native-backend"],
            binaryPath: "/custom/comando-native-backend",
            source: "override",
        });
    });

    it("resolves the dev debug binary", () => {
        withTempDir((root) => {
            const binaryPath = touch(
                path.join(root, "target", "debug", "comando-native-backend"),
            );

            expect(
                resolveNativeBackendPath({
                    cwd: root,
                    env: {},
                    exists: fs.existsSync,
                    resourcesPath: path.join(root, "resources"),
                }),
            ).toMatchObject({
                binaryPath,
                source: "dev-debug",
            });
        });
    });

    it("resolves the dev release binary after debug candidates", () => {
        withTempDir((root) => {
            const binaryPath = touch(
                path.join(root, "target", "release", "comando-native-backend"),
            );

            expect(
                resolveNativeBackendPath({
                    cwd: root,
                    env: {},
                    exists: fs.existsSync,
                    resourcesPath: path.join(root, "resources"),
                }),
            ).toMatchObject({
                binaryPath,
                source: "dev-release",
            });
        });
    });

    it("prefers the most recently built dev binary when both exist", () => {
        withTempDir((root) => {
            const debugPath = touch(
                path.join(root, "target", "debug", "comando-native-backend"),
            );
            const releasePath = touch(
                path.join(root, "target", "release", "comando-native-backend"),
            );

            // Release is fresher than debug — it must win even though debug is
            // listed first among the candidates.
            const mtimes = new Map([
                [debugPath, 1_000],
                [releasePath, 2_000],
            ]);

            expect(
                resolveNativeBackendPath({
                    cwd: root,
                    env: {},
                    exists: fs.existsSync,
                    mtimeMs: (candidate) => mtimes.get(candidate) ?? 0,
                    resourcesPath: path.join(root, "resources"),
                }),
            ).toMatchObject({
                binaryPath: releasePath,
                source: "dev-release",
            });
        });
    });

    it("resolves packaged resources by platform and arch", () => {
        withTempDir((root) => {
            const resourcesPath = path.join(root, "packaged-resources");
            const binaryPath = touch(
                path.join(
                    resourcesPath,
                    "native",
                    "darwin",
                    "arm64",
                    "comando-native-backend",
                ),
            );

            expect(
                resolveNativeBackendPath({
                    arch: "arm64",
                    cwd: root,
                    env: {},
                    exists: fs.existsSync,
                    platform: "darwin",
                    resourcesPath,
                }),
            ).toMatchObject({
                binaryPath,
                source: "packaged",
            });
        });
    });

    it("reports missing when no candidate exists", () => {
        withTempDir((root) => {
            const resolution = resolveNativeBackendPath({
                cwd: root,
                env: {},
                exists: fs.existsSync,
                resourcesPath: path.join(root, "resources"),
            });

            expect(resolution.binaryPath).toBeNull();
            expect(resolution.source).toBe("missing");
            expect(resolution.attemptedPaths.length).toBeGreaterThan(0);
        });
    });
});

describe("getNativeBackendExecutableName", () => {
    it("uses .exe on Windows", () => {
        expect(getNativeBackendExecutableName("win32")).toBe(
            "comando-native-backend.exe",
        );
    });

    it("uses the bare executable name elsewhere", () => {
        expect(getNativeBackendExecutableName("darwin")).toBe(
            "comando-native-backend",
        );
    });
});

function withTempDir(callback: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "comando-native-path-"));
    try {
        callback(root);
    } finally {
        fs.rmSync(root, { force: true, recursive: true });
    }
}

function touch(filePath: string): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
    return filePath;
}
