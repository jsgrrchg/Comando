import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OpenCodeRuntimeSettings } from "@shared/ipc";

import { writeTestExecutable } from "@main/testing/executable-fixture";

import {
    applyOpenCodeAuthEnv,
    getOpenCodeRuntimeStatus,
    isOpenCodeAuthenticationError,
    resolveOpenCodeRuntime,
} from "./setup";

const originalOpenCodeApiKey = process.env.OPENCODE_API_KEY;
const originalOpenCodeEnv = process.env.COMANDO_OPENCODE_ACP_BIN;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalHome = process.env.HOME;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalPath = process.env.PATH;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    delete process.env.COMANDO_OPENCODE_ACP_BIN;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.XDG_DATA_HOME;
});

afterEach(() => {
    process.env.PATH = originalPath;
    restoreEnv("COMANDO_OPENCODE_ACP_BIN", originalOpenCodeEnv);
    restoreEnv("OPENCODE_API_KEY", originalOpenCodeApiKey);
    restoreEnv("OPENAI_API_KEY", originalOpenAiApiKey);
    restoreEnv("HOME", originalHome);
    restoreEnv("LOCALAPPDATA", originalLocalAppData);
    restoreEnv("USERPROFILE", originalUserProfile);
    restoreEnv("XDG_DATA_HOME", originalXdgDataHome);
});

describe("OpenCode setup", () => {
    it("resolves OpenCode from COMANDO_OPENCODE_ACP_BIN with acp", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-env-"),
        );

        try {
            const binaryPath = writeTestExecutable(
                tempDir,
                "custom-opencode",
            );
            process.env.COMANDO_OPENCODE_ACP_BIN = binaryPath;
            process.env.PATH = "";

            const resolved = resolveOpenCodeRuntime(
                createOpenCodeSettings({ authMethod: "opencode-login" }),
            );

            expect(resolved.program).toBe(binaryPath);
            expect(resolved.args).toEqual(["acp"]);
            expect(resolved.command).toBe(`${binaryPath} acp`);
            expect(resolved.status.source).toBe("env");
            expect(resolved.status.state).toBe("ready");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("resolves OpenCode from configured path and falls back to PATH", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-path-"),
        );

        try {
            const binaryPath = writeTestExecutable(tempDir, "opencode");
            process.env.PATH = tempDir;

            const fromSettings = resolveOpenCodeRuntime(
                createOpenCodeSettings({
                    authMethod: "opencode-login",
                    binaryPath,
                }),
            );
            const fromPath = resolveOpenCodeRuntime(
                createOpenCodeSettings({ authMethod: "opencode-login" }),
            );

            expect(fromSettings.program).toBe(binaryPath);
            expect(fromSettings.status.source).toBe("settings");
            expect(fromPath.program).toBe(binaryPath);
            expect(fromPath.status.source).toBe("path");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("resolves OpenCode from its user install path when PATH is sparse", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-user-path-"),
        );

        try {
            const userBinDir = path.join(tempDir, ".opencode", "bin");
            fs.mkdirSync(userBinDir, { recursive: true });
            const binaryPath = writeTestExecutable(userBinDir, "opencode");
            process.env.HOME = tempDir;
            delete process.env.USERPROFILE;
            process.env.PATH = "";

            const resolved = resolveOpenCodeRuntime(
                createOpenCodeSettings({ authMethod: "opencode-login" }),
            );

            expect(resolved.program).toBe(binaryPath);
            expect(resolved.status.source).toBe("path");
            expect(resolved.status.state).toBe("ready");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("reports missing when OpenCode cannot be found", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-missing-"),
        );
        process.env.HOME = tempDir;
        delete process.env.USERPROFILE;
        process.env.PATH = "";

        try {
            const status = getOpenCodeRuntimeStatus(
                createOpenCodeSettings({
                    binaryPath: "missing-opencode-for-test",
                }),
            );

            expect(status.runtimeId).toBe("opencode");
            expect(status.state).toBe("missing");
            expect(status.onboardingRequired).toBe(true);
            expect(status.message).toContain(
                "Configured command was not found",
            );
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("detects external auth from auth.json", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-auth-file-"),
        );

        try {
            process.env.XDG_DATA_HOME = tempDir;
            writeOpenCodeAuthFile(tempDir);

            const status = getOpenCodeRuntimeStatus(createOpenCodeSettings());

            expect(status.authMethod).toBe("opencode-login");
            expect(status.authReady).toBe(true);
            expect(status.authCredentialSource).toBe("external-runtime");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("detects OPENCODE_API_KEY as external environment auth", () => {
        process.env.OPENCODE_API_KEY = "env-opencode-key";

        const status = getOpenCodeRuntimeStatus(createOpenCodeSettings());

        expect(status.authMethod).toBe("opencode-login");
        expect(status.authReady).toBe(true);
        expect(status.authCredentialSource).toBe("environment");
    });

    it("detects provider API keys as external OpenCode environment auth", () => {
        process.env.OPENAI_API_KEY = "env-openai-key";

        const status = getOpenCodeRuntimeStatus(createOpenCodeSettings());

        expect(status.authMethod).toBe("opencode-login");
        expect(status.authReady).toBe(true);
        expect(status.authCredentialSource).toBe("environment");
    });

    it("treats the selected OpenCode auth method as ready even without a verifiable auth file", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-selected-auth-"),
        );

        try {
            const binaryPath = writeTestExecutable(tempDir, "opencode");
            process.env.XDG_DATA_HOME = path.join(tempDir, "xdg");
            const status = getOpenCodeRuntimeStatus(
                createOpenCodeSettings({
                    authMethod: "opencode-login",
                    binaryPath,
                }),
            );

            expect(status.authReady).toBe(true);
            expect(status.authCredentialSource).toBe("external-runtime");
            expect(status.message).toContain("could not verify");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("does not treat a selected OpenCode auth method as ready after invalidation", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-invalid-selected-"),
        );

        try {
            const binaryPath = writeTestExecutable(tempDir, "opencode");
            process.env.XDG_DATA_HOME = path.join(tempDir, "xdg");
            const status = getOpenCodeRuntimeStatus(
                createOpenCodeSettings({
                    authInvalidatedAtMs: Date.now(),
                    authMethod: "opencode-login",
                    binaryPath,
                }),
            );

            expect(status.authReady).toBe(false);
            expect(status.authMethod).toBeNull();
            expect(status.onboardingRequired).toBe(true);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("ignores auth.json when it was invalidated after the file changed", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-invalidated-"),
        );

        try {
            process.env.XDG_DATA_HOME = tempDir;
            const authPath = writeOpenCodeAuthFile(tempDir);
            const modifiedAtMs = fs.statSync(authPath).mtimeMs;

            const status = getOpenCodeRuntimeStatus(
                createOpenCodeSettings({
                    authInvalidatedAtMs: modifiedAtMs + 1_000,
                }),
            );

            expect(status.authReady).toBe(false);
            expect(status.authMethod).toBeNull();
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("does not treat empty or corrupt auth.json files as active auth", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-empty-auth-"),
        );

        try {
            process.env.XDG_DATA_HOME = tempDir;
            const authPath = writeOpenCodeAuthFile(tempDir);

            fs.writeFileSync(authPath, "", "utf8");
            expect(
                getOpenCodeRuntimeStatus(createOpenCodeSettings()).authReady,
            ).toBe(false);

            fs.writeFileSync(authPath, "{not-json", "utf8");
            expect(
                getOpenCodeRuntimeStatus(createOpenCodeSettings()).authReady,
            ).toBe(false);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("does not mutate auth env in V1", () => {
        const env = {
            OPENCODE_API_KEY: "external-key",
            PATH: "/bin",
        };

        expect(
            applyOpenCodeAuthEnv(env, createOpenCodeSettings()),
        ).toEqual(env);
    });

    it("recognizes common OpenCode auth errors", () => {
        expect(isOpenCodeAuthenticationError("authentication required")).toBe(
            true,
        );
        expect(isOpenCodeAuthenticationError("missing api key")).toBe(true);
        expect(isOpenCodeAuthenticationError("please use /connect")).toBe(true);
        expect(isOpenCodeAuthenticationError("syntax error")).toBe(false);
    });
});

function createOpenCodeSettings(
    overrides: Partial<OpenCodeRuntimeSettings> = {},
): OpenCodeRuntimeSettings {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        ...overrides,
    };
}

function writeOpenCodeAuthFile(dataDir: string): string {
    const authDir = path.join(dataDir, "opencode");
    fs.mkdirSync(authDir, { recursive: true });
    const authPath = path.join(authDir, "auth.json");
    fs.writeFileSync(authPath, '{"provider":"test"}\n', "utf8");
    return authPath;
}

function restoreEnv(name: string, value: string | undefined): void {
    if (typeof value === "string") {
        process.env[name] = value;
    } else {
        delete process.env[name];
    }
}
