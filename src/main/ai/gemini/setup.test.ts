import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SecretStoreService } from "../secret-store";
import {
    applyGeminiAuthEnv,
    detectGeminiAuthMethod,
    getGeminiRuntimeStatus,
    resolveGeminiRuntime,
} from "./setup";

type FakeSecretStore = {
    loadSecret: (namespace: string, secretId: string) => string | null;
    saveSecret: (
        namespace: string,
        secretId: string,
        value: string | null,
    ) => void;
};

const originalGeminiEnv = process.env.COMANDO_GEMINI_ACP_BIN;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalUserProfile = process.env.USERPROFILE;

beforeEach(() => {
    delete process.env.COMANDO_GEMINI_ACP_BIN;
});

afterEach(() => {
    process.env.PATH = originalPath;

    if (typeof originalGeminiEnv === "string") {
        process.env.COMANDO_GEMINI_ACP_BIN = originalGeminiEnv;
    } else {
        delete process.env.COMANDO_GEMINI_ACP_BIN;
    }

    if (typeof originalGeminiApiKey === "string") {
        process.env.GEMINI_API_KEY = originalGeminiApiKey;
    } else {
        delete process.env.GEMINI_API_KEY;
    }

    if (typeof originalGoogleApiKey === "string") {
        process.env.GOOGLE_API_KEY = originalGoogleApiKey;
    } else {
        delete process.env.GOOGLE_API_KEY;
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
});

describe("Gemini setup", () => {
    it("resolves Gemini from COMANDO_GEMINI_ACP_BIN with --acp", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-gemini-env-"),
        );

        try {
            const binaryPath = path.join(tempDir, "custom-gemini");
            fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(binaryPath, 0o755);
            process.env.COMANDO_GEMINI_ACP_BIN = binaryPath;
            process.env.PATH = "";

            const resolved = resolveGeminiRuntime(
                createEmptyGeminiSettings(),
                createFakeSecretStore() as unknown as SecretStoreService,
            );

            expect(resolved.program).toBe(binaryPath);
            expect(resolved.args).toEqual(["--acp"]);
            expect(resolved.command).toBe(`${binaryPath} --acp`);
            expect(resolved.status.source).toBe("env");
            expect(resolved.status.state).toBe("ready");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("resolves Gemini from configured path and falls back to PATH", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-gemini-path-"),
        );

        try {
            const binaryPath = path.join(tempDir, "gemini");
            fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(binaryPath, 0o755);
            process.env.PATH = tempDir;

            const fromSettings = resolveGeminiRuntime(
                {
                    ...createEmptyGeminiSettings(),
                    binaryPath,
                },
                createFakeSecretStore() as unknown as SecretStoreService,
            );
            const fromPath = resolveGeminiRuntime(
                createEmptyGeminiSettings(),
                createFakeSecretStore() as unknown as SecretStoreService,
            );

            expect(fromSettings.program).toBe(binaryPath);
            expect(fromSettings.status.source).toBe("settings");
            expect(fromPath.program).toBe(binaryPath);
            expect(fromPath.status.source).toBe("path");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it.runIf(process.platform === "darwin")(
        "falls back to common macOS Homebrew paths when PATH is missing",
        () => {
            process.env.PATH = "";

            const resolved = resolveGeminiRuntime(
                createEmptyGeminiSettings(),
                createFakeSecretStore() as unknown as SecretStoreService,
            );

            expect(resolved.program).toBe("/opt/homebrew/bin/gemini");
            expect(resolved.status.source).toBe("path");
        },
    );

    it("detects use_gemini auth from stored secrets", () => {
        const secretStore = createFakeSecretStore({
            "ai.gemini:gemini_api_key": "gem-key-123",
        });

        const status = getGeminiRuntimeStatus(
            createEmptyGeminiSettings(),
            secretStore as unknown as SecretStoreService,
        );

        expect(
            detectGeminiAuthMethod(
                createEmptyGeminiSettings(),
                secretStore as unknown as SecretStoreService,
            ),
        ).toBe("use_gemini");
        expect(status.authMethod).toBe("use_gemini");
        expect(status.authReady).toBe(true);
    });

    it("detects Google login from ~/.gemini/settings.json while respecting invalidation", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-gemini-google-"),
        );

        try {
            const binaryPath = path.join(tempDir, "gemini");
            const tempHome = path.join(tempDir, "home");
            const settingsDir = path.join(tempHome, ".gemini");
            const settingsPath = path.join(settingsDir, "settings.json");

            fs.mkdirSync(settingsDir, { recursive: true });
            fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.writeFileSync(
                settingsPath,
                JSON.stringify({
                    security: {
                        auth: {
                            selectedType: "oauth-personal",
                        },
                    },
                }),
                "utf8",
            );
            fs.chmodSync(binaryPath, 0o755);

            process.env.HOME = tempHome;
            delete process.env.USERPROFILE;
            process.env.COMANDO_GEMINI_ACP_BIN = binaryPath;
            process.env.PATH = "";

            const readyStatus = getGeminiRuntimeStatus(
                {
                    ...createEmptyGeminiSettings(),
                    authMethod: "login_with_google",
                },
                createFakeSecretStore() as unknown as SecretStoreService,
            );
            const fallbackStatus = getGeminiRuntimeStatus(
                createEmptyGeminiSettings(),
                createFakeSecretStore() as unknown as SecretStoreService,
            );
            const staleStatus = getGeminiRuntimeStatus(
                {
                    ...createEmptyGeminiSettings(),
                    authInvalidatedAtMs: Date.now() + 60_000,
                    authMethod: "login_with_google",
                },
                createFakeSecretStore() as unknown as SecretStoreService,
            );

            expect(readyStatus.authMethod).toBe("login_with_google");
            expect(readyStatus.authReady).toBe(true);
            expect(readyStatus.authCredentialSource).toBe("external-runtime");
            expect(readyStatus.canDisconnectAuth).toBe(true);
            expect(fallbackStatus.authMethod).toBe("login_with_google");
            expect(fallbackStatus.authCredentialSource).toBe(
                "external-runtime",
            );
            expect(fallbackStatus.canDisconnectAuth).toBe(true);
            expect(staleStatus.authMethod).toBeNull();
            expect(staleStatus.authReady).toBe(false);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("injects Gemini env without overwriting external secrets", () => {
        const secretStore = createFakeSecretStore({
            "ai.gemini:gemini_api_key": "stored-gemini-key",
            "ai.gemini:google_api_key": "stored-google-key",
        });

        const env = applyGeminiAuthEnv(
            {
                GEMINI_API_KEY: "external-gemini-key",
            },
            {
                ...createEmptyGeminiSettings(),
                authMethod: "use_gemini",
                googleCloudLocation: "us-central1",
                googleCloudProject: "demo-project",
            },
            secretStore as unknown as SecretStoreService,
        );

        expect(env.GEMINI_API_KEY).toBe("external-gemini-key");
        expect(env.GOOGLE_API_KEY).toBe("stored-google-key");
        expect(env.GOOGLE_CLOUD_PROJECT).toBe("demo-project");
        expect(env.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
        expect(env.GEMINI_DEFAULT_AUTH_TYPE).toBe("use_gemini");
    });

    it("does not inject stored Gemini API keys for Google login", () => {
        const secretStore = createFakeSecretStore({
            "ai.gemini:gemini_api_key": "stored-gemini-key",
            "ai.gemini:google_api_key": "stored-google-key",
        });

        const env = applyGeminiAuthEnv(
            {
                GEMINI_API_KEY: "external-gemini-key",
                GOOGLE_API_KEY: "external-google-key",
            },
            {
                ...createEmptyGeminiSettings(),
                authMethod: "login_with_google",
            },
            secretStore as unknown as SecretStoreService,
        );

        expect(env.GEMINI_API_KEY).toBeUndefined();
        expect(env.GOOGLE_API_KEY).toBeUndefined();
        expect(env.GEMINI_DEFAULT_AUTH_TYPE).toBe("login_with_google");
    });

    it("does not offer disconnect for pure Gemini environment credentials", () => {
        process.env.GEMINI_API_KEY = "external-gemini-key";

        const status = getGeminiRuntimeStatus(
            createEmptyGeminiSettings(),
            createFakeSecretStore() as unknown as SecretStoreService,
        );

        expect(status.authMethod).toBe("use_gemini");
        expect(status.authCredentialSource).toBe("environment");
        expect(status.canDisconnectAuth).toBe(false);
    });

    it("respects external project variables, location, and auth type", () => {
        const env = applyGeminiAuthEnv(
            {
                GEMINI_DEFAULT_AUTH_TYPE: "external-auth-type",
                GOOGLE_CLOUD_LOCATION: "europe-west1",
                GOOGLE_CLOUD_PROJECT: "external-project",
            },
            {
                ...createEmptyGeminiSettings(),
                authMethod: "login_with_google",
                googleCloudLocation: "us-central1",
                googleCloudProject: "demo-project",
            },
            createFakeSecretStore() as unknown as SecretStoreService,
        );

        expect(env.GEMINI_DEFAULT_AUTH_TYPE).toBe("external-auth-type");
        expect(env.GOOGLE_CLOUD_PROJECT).toBe("external-project");
        expect(env.GOOGLE_CLOUD_LOCATION).toBe("europe-west1");
    });
});

function createEmptyGeminiSettings() {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        googleCloudLocation: null,
        googleCloudProject: null,
        hasGeminiApiKey: false,
        hasGoogleApiKey: false,
    } as const;
}

function createFakeSecretStore(
    seed: Record<string, string> = {},
): FakeSecretStore {
    const secrets = new Map(Object.entries(seed));

    return {
        loadSecret(namespace, secretId) {
            return secrets.get(`${namespace}:${secretId}`) ?? null;
        },
        saveSecret(namespace, secretId, value) {
            const key = `${namespace}:${secretId}`;
            const normalized = value?.trim() ?? "";

            if (!normalized) {
                secrets.delete(key);
                return;
            }

            secrets.set(key, normalized);
        },
    };
}
