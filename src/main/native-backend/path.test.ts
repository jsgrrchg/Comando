import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    NATIVE_BACKEND_PATH_ENV,
    getNativeBackendExecutableName,
    resolveNativeBackendPath,
} from "./path";

describe("resolveNativeBackendPath", () => {
    it("prefers an existing environment override", () => {
        const overridePath = path.join(
            os.tmpdir(),
            "comando-native-backend-override",
        );
        const resolution = resolveNativeBackendPath({
            env: {
                [NATIVE_BACKEND_PATH_ENV]: overridePath,
            },
            exists: (candidate) => candidate === overridePath,
        });

        expect(resolution).toEqual({
            attemptedPaths: [overridePath],
            binaryPath: overridePath,
            source: "override",
        });
    });

    it("reports a missing environment override as missing", () => {
        const resolution = resolveNativeBackendPath({
            env: {
                [NATIVE_BACKEND_PATH_ENV]: "/custom/missing-backend",
            },
            exists: () => false,
        });

        expect(resolution).toEqual({
            attemptedPaths: ["/custom/missing-backend"],
            binaryPath: null,
            source: "missing",
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

    it("prefers the dev debug binary when both dev profiles exist", () => {
        withTempDir((root) => {
            const debugPath = touch(
                path.join(root, "target", "debug", "comando-native-backend"),
            );
            touch(
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
                binaryPath: debugPath,
                source: "dev-debug",
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
                    isPackaged: true,
                    platform: "darwin",
                    resourcesPath,
                }),
            ).toMatchObject({
                binaryPath,
                source: "packaged",
            });
        });
    });

    it("does not let dev binaries shadow a packaged sidecar", () => {
        withTempDir((root) => {
            touch(path.join(root, "target", "debug", "comando-native-backend"));
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
                    isPackaged: true,
                    platform: "darwin",
                    resourcesPath,
                }),
            ).toMatchObject({
                binaryPath,
                source: "packaged",
            });
        });
    });

    it("does not fall back to packaged resources while running in dev", () => {
        withTempDir((root) => {
            const resourcesPath = path.join(root, "packaged-resources");
            touch(
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
                    isPackaged: false,
                    platform: "darwin",
                    resourcesPath,
                }),
            ).toMatchObject({
                binaryPath: null,
                source: "missing",
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
