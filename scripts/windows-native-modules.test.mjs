import { Buffer } from "node:buffer";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    readWindowsPeArchitecture,
    resolvePackagedWindowsNativeModuleFiles,
    verifyPackagedWindowsNativeModules,
} from "./windows-native-modules.mjs";

describe("Windows native module packaging checks", () => {
    it("resolves node-pty and better-sqlite3 native module paths", () => {
        expect(
            resolvePackagedWindowsNativeModuleFiles({
                targetArch: "arm64",
                unpackedAppDir: "dist/win-arm64-unpacked",
            }),
        ).toEqual({
            betterSqlite3: [
                {
                    architecture: "arm64",
                    kind: "native",
                    path: path.join(
                        "dist/win-arm64-unpacked",
                        "resources",
                        "app.asar.unpacked",
                        "node_modules",
                        "better-sqlite3",
                        "build",
                        "Release",
                        "better_sqlite3.node",
                    ),
                },
            ],
            nodePty: [
                {
                    architecture: "arm64",
                    kind: "native",
                    path: path.join(
                        "dist/win-arm64-unpacked",
                        "resources",
                        "app.asar.unpacked",
                        "node_modules",
                        "node-pty",
                        "prebuilds",
                        "win32-arm64",
                        "conpty.node",
                    ),
                },
                {
                    architecture: "arm64",
                    kind: "native",
                    path: path.join(
                        "dist/win-arm64-unpacked",
                        "resources",
                        "app.asar.unpacked",
                        "node_modules",
                        "node-pty",
                        "prebuilds",
                        "win32-arm64",
                        "pty.node",
                    ),
                },
                {
                    architecture: "arm64",
                    kind: "native",
                    path: path.join(
                        "dist/win-arm64-unpacked",
                        "resources",
                        "app.asar.unpacked",
                        "node_modules",
                        "node-pty",
                        "prebuilds",
                        "win32-arm64",
                        "conpty_console_list.node",
                    ),
                },
                {
                    architecture: "arm64",
                    kind: "support",
                    path: path.join(
                        "dist/win-arm64-unpacked",
                        "resources",
                        "app.asar.unpacked",
                        "node_modules",
                        "node-pty",
                        "prebuilds",
                        "win32-arm64",
                        "conpty",
                        "conpty.dll",
                    ),
                },
                {
                    architecture: "arm64",
                    kind: "support",
                    path: path.join(
                        "dist/win-arm64-unpacked",
                        "resources",
                        "app.asar.unpacked",
                        "node_modules",
                        "node-pty",
                        "prebuilds",
                        "win32-arm64",
                        "conpty",
                        "OpenConsole.exe",
                    ),
                },
                {
                    architecture: "arm64",
                    kind: "support",
                    path: path.join(
                        "dist/win-arm64-unpacked",
                        "resources",
                        "app.asar.unpacked",
                        "node_modules",
                        "node-pty",
                        "prebuilds",
                        "win32-arm64",
                        "winpty-agent.exe",
                    ),
                },
                {
                    architecture: "arm64",
                    kind: "support",
                    path: path.join(
                        "dist/win-arm64-unpacked",
                        "resources",
                        "app.asar.unpacked",
                        "node_modules",
                        "node-pty",
                        "prebuilds",
                        "win32-arm64",
                        "winpty.dll",
                    ),
                },
            ],
        });
    });

    it("reads architecture from Windows PE headers", () => {
        expect(readWindowsPeArchitecture(createPeBuffer(0x8664))).toBe("x64");
        expect(readWindowsPeArchitecture(createPeBuffer(0xaa64))).toBe("arm64");
        expect(readWindowsPeArchitecture(Buffer.from("not-pe"))).toBe(null);
    });

    it("verifies native module presence and architecture", () => {
        const unpackedAppDir = "dist/win-unpacked";
        const files = resolvePackagedWindowsNativeModuleFiles({
            targetArch: "x64",
            unpackedAppDir,
        });
        const allPaths = new Set([
            ...files.nodePty.map((file) => file.path),
            ...files.betterSqlite3.map((file) => file.path),
        ]);

        expect(() =>
            verifyPackagedWindowsNativeModules({
                isFile: (filePath) => allPaths.has(filePath),
                readFile: () => createPeBuffer(0x8664),
                targetArch: "x64",
                unpackedAppDir,
            }),
        ).not.toThrow();
    });

    it("rejects missing better-sqlite3 native module", () => {
        const unpackedAppDir = "dist/win-unpacked";
        const files = resolvePackagedWindowsNativeModuleFiles({
            targetArch: "x64",
            unpackedAppDir,
        });
        const betterSqlite3Path = files.betterSqlite3[0].path;
        const allPathsExceptBetterSqlite3 = new Set(
            files.nodePty.map((file) => file.path),
        );

        expect(() =>
            verifyPackagedWindowsNativeModules({
                isFile: (filePath) => allPathsExceptBetterSqlite3.has(filePath),
                readFile: () => createPeBuffer(0x8664),
                targetArch: "x64",
                unpackedAppDir,
            }),
        ).toThrow(new RegExp(escapeRegExp(betterSqlite3Path), "u"));
    });

    it("rejects native modules with the wrong PE architecture", () => {
        const unpackedAppDir = "dist/win-arm64-unpacked";
        const files = resolvePackagedWindowsNativeModuleFiles({
            targetArch: "arm64",
            unpackedAppDir,
        });
        const allPaths = new Set([
            ...files.nodePty.map((file) => file.path),
            ...files.betterSqlite3.map((file) => file.path),
        ]);

        expect(() =>
            verifyPackagedWindowsNativeModules({
                isFile: (filePath) => allPaths.has(filePath),
                readFile: () => createPeBuffer(0x8664),
                targetArch: "arm64",
                unpackedAppDir,
            }),
        ).toThrow(/expected arm64, got x64/u);
    });
});

function createPeBuffer(machine) {
    const peHeaderOffset = 0x80;
    const buffer = Buffer.alloc(peHeaderOffset + 24);
    buffer.write("MZ", 0, "ascii");
    buffer.writeUInt32LE(peHeaderOffset, 0x3c);
    buffer.write("PE\u0000\u0000", peHeaderOffset, "ascii");
    buffer.writeUInt16LE(machine, peHeaderOffset + 4);
    return buffer;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
