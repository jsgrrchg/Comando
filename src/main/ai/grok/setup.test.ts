import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GrokRuntimeSettings } from "@shared/ipc";
import type { SecretStoreGateway } from "../secret-store";
import {
    applyGrokAuthEnv,
    buildGrokSecretPatches,
    detectGrokAuthMethod,
    getGrokAuthMethods,
    getGrokRuntimeStatus,
    isGrokAuthenticationError,
    loadGrokSecretBundle,
    markGrokAuthInvalidated,
    resolveGrokRuntime,
} from "./setup";

const originalGrokEnv = process.env.COMANDO_GROK_ACP_BIN;
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalUserProfile = process.env.USERPROFILE;
const originalXaiApiKey = process.env.XAI_API_KEY;

beforeEach(() => {
    delete process.env.COMANDO_GROK_ACP_BIN;
    delete process.env.XAI_API_KEY;
});

afterEach(() => {
    process.env.PATH = originalPath;

    if (typeof originalGrokEnv === "string") {
        process.env.COMANDO_GROK_ACP_BIN = originalGrokEnv;
    } else {
        delete process.env.COMANDO_GROK_ACP_BIN;
    }

    if (typeof originalHome === "string") {
        process.env.HOME = originalHome;
    } else {
        delete process.env.HOME;
    }

    if (typeof originalUserProfile === "string") {
        process.env.USERPROFILE = originalUserProfile;
    } else {
        delete process.env.USERPROFILE;
    }

    if (typeof originalXaiApiKey === "string") {
        process.env.XAI_API_KEY = originalXaiApiKey;
    } else {
        delete process.env.XAI_API_KEY;
    }
});

describe("Grok setup", () => {
    it("exposes Grok login and xAI API key auth methods", () => {
        expect(getGrokAuthMethods().map((method) => method.id)).toEqual([
            "grok-login",
            "xai-api-key",
        ]);
    });

    it("resolves Grok from COMANDO_GROK_ACP_BIN with ACP stdio args", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-env-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "custom-grok");
            process.env.COMANDO_GROK_ACP_BIN = binaryPath;
            process.env.PATH = "";

            const resolved = resolveGrokRuntime(createEmptyGrokSettings());

            expect(resolved.program).toBe(binaryPath);
            expect(resolved.args).toEqual([
                "--no-auto-update",
                "agent",
                "stdio",
            ]);
            expect(resolved.command).toBe(
                `${binaryPath} --no-auto-update agent stdio`,
            );
            expect(resolved.status.source).toBe("env");
            expect(resolved.status.state).toBe("ready");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("resolves Grok from configured path and falls back to PATH", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-path-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            process.env.PATH = tempDir;

            const fromSettings = resolveGrokRuntime({
                ...createEmptyGrokSettings(),
                binaryPath,
            });
            const fromPath = resolveGrokRuntime(createEmptyGrokSettings());

            expect(fromSettings.program).toBe(binaryPath);
            expect(fromSettings.status.source).toBe("settings");
            expect(fromPath.program).toBe(binaryPath);
            expect(fromPath.status.source).toBe("path");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("reports missing and non-executable Grok runtimes", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-missing-"),
        );

        try {
            const nonExecutablePath = path.join(tempDir, "grok");
            fs.writeFileSync(nonExecutablePath, "#!/bin/sh\nexit 0\n", "utf8");
            process.env.PATH = "";

            const missing = getGrokRuntimeStatus(createEmptyGrokSettings());
            const notExecutable = getGrokRuntimeStatus({
                ...createEmptyGrokSettings(),
                binaryPath: nonExecutablePath,
            });

            expect(missing.state).toBe("missing");
            expect(missing.message).toBe(
                "Grok CLI was not found. Install `grok` or provide a custom runtime path.",
            );
            expect(notExecutable.state).toBe("error");
            expect(notExecutable.message).toContain(
                "Could not execute the configured Grok runtime",
            );
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("loads and patches the stored xAI API key secret", () => {
        const secretStore = createSecretStore({
            "ai.grok:xai_api_key": "stored-xai-key",
        });

        expect(loadGrokSecretBundle(secretStore)).toEqual({
            xaiApiKey: "stored-xai-key",
        });

        const unchanged = buildGrokSecretPatches(secretStore, {
            xaiApiKey: "stored-xai-key",
        });
        const changed = buildGrokSecretPatches(secretStore, {
            xaiApiKey: "next-xai-key",
        });
        const cleared = buildGrokSecretPatches(secretStore, {
            xaiApiKey: null,
        });

        expect(unchanged).toEqual({
            flags: { hasXaiApiKey: true },
            patches: [],
        });
        expect(changed).toEqual({
            flags: { hasXaiApiKey: true },
            patches: [
                {
                    key: "secret.ai.grok.xai_api_key",
                    value: "next-xai-key",
                },
            ],
        });
        expect(cleared).toEqual({
            flags: { hasXaiApiKey: false },
            patches: [
                {
                    key: "secret.ai.grok.xai_api_key",
                    value: null,
                },
            ],
        });
    });

    it("respects XAI_API_KEY from the environment over stored credentials", () => {
        process.env.XAI_API_KEY = "env-xai-key";
        const secretStore = createSecretStore({
            "ai.grok:xai_api_key": "stored-xai-key",
        });
        const settings = createEmptyGrokSettings({
            authMethod: "grok-login",
        });

        expect(detectGrokAuthMethod(settings, secretStore)).toBe(
            "xai-api-key",
        );
        expect(
            applyGrokAuthEnv(
                {
                    XAI_API_KEY: "env-xai-key",
                },
                settings,
                secretStore,
            ).XAI_API_KEY,
        ).toBe("env-xai-key");
    });

    it("applies stored xAI API key unless Grok login is explicitly selected", () => {
        const secretStore = createSecretStore({
            "ai.grok:xai_api_key": "stored-xai-key",
        });

        expect(
            applyGrokAuthEnv(
                {},
                createEmptyGrokSettings({
                    authMethod: "xai-api-key",
                }),
                secretStore,
            ).XAI_API_KEY,
        ).toBe("stored-xai-key");
        expect(
            applyGrokAuthEnv(
                {},
                createEmptyGrokSettings({
                    authMethod: "grok-login",
                }),
                secretStore,
            ).XAI_API_KEY,
        ).toBeUndefined();
    });

    it("reports stored xAI API key as ready Comando credentials", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-secret-status-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            const secretStore = createSecretStore({
                "ai.grok:xai_api_key": "stored-xai-key",
            });
            process.env.COMANDO_GROK_ACP_BIN = binaryPath;
            process.env.PATH = "";

            const status = getGrokRuntimeStatus(
                createEmptyGrokSettings(),
                secretStore,
            );

            expect(status.authMethod).toBe("xai-api-key");
            expect(status.authReady).toBe(true);
            expect(status.authCredentialSource).toBe("comando-secret");
            expect(status.authCredentialSourceLabel).toBe(
                "Using Comando stored credentials",
            );
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("allows selected Grok login while noting unverifiable local credentials", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-selected-login-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "grok");
            process.env.COMANDO_GROK_ACP_BIN = binaryPath;
            process.env.HOME = tempDir;
            process.env.PATH = "";

            const status = getGrokRuntimeStatus(
                createEmptyGrokSettings({
                    authMethod: "grok-login",
                }),
            );

            expect(status.authMethod).toBe("grok-login");
            expect(status.authReady).toBe(true);
            expect(status.authCredentialSource).toBe("external-runtime");
            expect(status.message).toContain(
                "could not verify local Grok credentials",
            );
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("detects Grok login from ~/.grok/auth and respects invalidation", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-grok-auth-store-"),
        );

        try {
            writeGrokAuthStore(tempDir);
            process.env.HOME = tempDir;
            delete process.env.USERPROFILE;

            const readySettings = createEmptyGrokSettings();
            const invalidatedSettings = createEmptyGrokSettings({
                authInvalidatedAtMs: Date.now() + 60_000,
            });

            expect(detectGrokAuthMethod(readySettings)).toBe("grok-login");
            expect(detectGrokAuthMethod(invalidatedSettings)).toBeNull();
            expect(markGrokAuthInvalidated(readySettings)).toMatchObject({
                authMethod: null,
                binaryPath: null,
                hasXaiApiKey: false,
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("recognizes Grok authentication errors that should invalidate setup", () => {
        expect(isGrokAuthenticationError("Run grok login to continue")).toBe(
            true,
        );
        expect(isGrokAuthenticationError("cached_token is expired")).toBe(true);
        expect(isGrokAuthenticationError("invalid api key")).toBe(true);
        expect(isGrokAuthenticationError("Some unrelated error")).toBe(false);
    });
});

type GrokSettingsForTest = {
    readonly authInvalidatedAtMs: number | null;
    readonly authMethod: "grok-login" | "xai-api-key" | null;
    readonly binaryPath: string | null;
    readonly hasXaiApiKey: boolean;
};

function createEmptyGrokSettings(
    overrides: Partial<GrokSettingsForTest> = {},
): GrokRuntimeSettings {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        hasXaiApiKey: false,
        ...overrides,
    };
}

function createSecretStore(
    initialSecrets: Record<string, string | null> = {},
): SecretStoreGateway {
    const secrets = new Map<string, string | null>(
        Object.entries(initialSecrets),
    );

    return {
        getStorageStatus: () => ({
            encryptionAvailable: true,
            isWeakBackend: false,
            message: null,
            platform: process.platform,
            selectedBackend: null,
        }),
        loadSecret: (namespace, secretId) =>
            secrets.get(`${namespace}:${secretId}`) ?? null,
        saveSecret: (namespace, secretId, value) => {
            secrets.set(`${namespace}:${secretId}`, value);
        },
    };
}

function writeExecutable(directory: string, name: string): string {
    const binaryPath = path.join(directory, name);
    fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(binaryPath, 0o755);
    return binaryPath;
}

function writeGrokAuthStore(homeDir: string): void {
    const authDir = path.join(homeDir, ".grok", "auth");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "token"), "cached-token", "utf8");
}
