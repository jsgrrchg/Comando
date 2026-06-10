import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AiSettingsSnapshot } from "@shared/ipc";

import { writeTestExecutable } from "@main/testing/executable-fixture";

import type { SecretStoreGateway } from "./secret-store";
import { createAiEnvironmentDiagnostics } from "./environment-diagnostics";

describe("AI environment diagnostics", () => {
    it("reports runtime commands, PATH data, and env presence without leaking secrets", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-ai-diagnostics-"),
        );
        const previousPath = process.env.PATH;

        try {
            const homeDir = path.join(tempDir, "home");
            const binDir = path.join(tempDir, "bin");
            fs.mkdirSync(homeDir, { recursive: true });
            fs.mkdirSync(binDir, { recursive: true });

            const claudePath = writeTestExecutable(
                binDir,
                "claude-agent-acp",
            );
            const codexPath = writeTestExecutable(binDir, "codex-acp");
            const geminiPath = writeTestExecutable(binDir, "gemini");
            const grokPath = writeTestExecutable(binDir, "grok");
            const kiloPath = writeTestExecutable(binDir, "kilo");
            const opencodePath = writeTestExecutable(binDir, "opencode");
            const diagnostics = createAiEnvironmentDiagnostics({
                env: {
                    CODEX_API_KEY: "codex-secret-value",
                    COMANDO_CLAUDE_ACP_BIN: claudePath,
                    COMANDO_CODEX_ACP_BIN: codexPath,
                    COMANDO_GEMINI_ACP_BIN: geminiPath,
                    COMANDO_GROK_ACP_BIN: grokPath,
                    COMANDO_KILO_ACP_BIN: kiloPath,
                    COMANDO_OPENCODE_ACP_BIN: opencodePath,
                    GEMINI_API_KEY: "gemini-secret-value",
                    HOME: homeDir,
                    OPENAI_API_KEY: "openai-secret-value",
                    PATH: binDir,
                    XAI_API_KEY: "xai-secret-value",
                },
                now: () => new Date("2026-05-19T12:00:00.000Z"),
                secretStore: createSecretStore(),
                settings: createSettings({
                    codex: {
                        authMethod: "codex-api-key",
                        binaryPath: null,
                        hasCodexApiKey: false,
                        hasOpenAiApiKey: false,
                    },
                    gemini: {
                        authInvalidatedAtMs: null,
                        authMethod: "use_gemini",
                        binaryPath: null,
                        googleCloudLocation: null,
                        googleCloudProject: null,
                        hasGeminiApiKey: false,
                        hasGoogleApiKey: false,
                    },
                    grok: {
                        authInvalidatedAtMs: null,
                        authMethod: "xai-api-key",
                        binaryPath: null,
                        hasXaiApiKey: false,
                    },
                }),
            });

            expect(diagnostics.checkedAt).toBe("2026-05-19T12:00:00.000Z");
            expect(diagnostics.path.inherited).toBe(binDir);
            expect(diagnostics.path.inheritedEntries).toEqual([binDir]);
            const codexExecutable = diagnostics.executables.find(
                (entry) => entry.command === "codex-acp",
            );
            expect(codexExecutable).toMatchObject({
                source: "path",
                state: "ready",
            });
            expectPathToBe(codexExecutable?.path, codexPath);

            const geminiOverride = diagnostics.runtimePathOverrides.find(
                (entry) => entry.name === "COMANDO_GEMINI_ACP_BIN",
            );
            expect(geminiOverride).toMatchObject({
                present: true,
                runtimeId: "gemini",
            });
            expectPathToBe(geminiOverride?.pathOrCommand, geminiPath);

            const grokOverride = diagnostics.runtimePathOverrides.find(
                (entry) => entry.name === "COMANDO_GROK_ACP_BIN",
            );
            expect(grokOverride).toMatchObject({
                present: true,
                runtimeId: "grok",
            });
            expectPathToBe(grokOverride?.pathOrCommand, grokPath);

            expect(
                diagnostics.credentialEnvironment.find(
                    (entry) => entry.name === "CODEX_API_KEY",
                ),
            ).toMatchObject({
                present: true,
                runtimeId: "codex",
            });
            const codexRuntime = diagnostics.runtimes.find(
                (runtime) => runtime.runtimeId === "codex",
            );
            expect(codexRuntime).toMatchObject({
                authCredentialSource: "environment",
                authMethod: "codex-api-key",
                authReady: true,
                source: "env",
                state: "ready",
            });
            expectPathCommandToBe(codexRuntime?.command, codexPath);
            expectPathToBe(codexRuntime?.executablePath, codexPath);

            const geminiRuntime = diagnostics.runtimes.find(
                (runtime) => runtime.runtimeId === "gemini",
            );
            expect(geminiRuntime).toMatchObject({
                authCredentialSource: "environment",
                authMethod: "use_gemini",
                authReady: true,
                source: "env",
                state: "ready",
            });
            expectPathCommandToBe(geminiRuntime?.command, `${geminiPath} --acp`);
            expectPathToBe(geminiRuntime?.executablePath, geminiPath);
            expect(
                geminiRuntime?.preferredPathEntries[0],
            ).toBe(binDir);
            const grokRuntime = diagnostics.runtimes.find(
                (runtime) => runtime.runtimeId === "grok",
            );
            expect(grokRuntime).toMatchObject({
                authCredentialSource: "environment",
                authMethod: "xai-api-key",
                authReady: true,
                source: "env",
                state: "ready",
            });
            expectPathCommandToBe(
                grokRuntime?.command,
                `${grokPath} --no-auto-update agent stdio`,
            );
            expectPathToBe(grokRuntime?.executablePath, grokPath);
            expect(
                diagnostics.credentialEnvironment.find(
                    (entry) =>
                        entry.name === "XAI_API_KEY" &&
                        entry.runtimeId === "grok",
                ),
            ).toMatchObject({
                present: true,
                runtimeId: "grok",
            });
            const openCodeRuntime = diagnostics.runtimes.find(
                (runtime) => runtime.runtimeId === "opencode",
            );
            expect(openCodeRuntime).toMatchObject({
                authCredentialSource: "environment",
                authMethod: "opencode-login",
                authReady: true,
                source: "env",
                state: "ready",
            });
            expectPathCommandToBe(openCodeRuntime?.command, `${opencodePath} acp`);
            expectPathToBe(openCodeRuntime?.executablePath, opencodePath);
            expect(
                diagnostics.credentialEnvironment.find(
                    (entry) =>
                        entry.name === "OPENAI_API_KEY" &&
                        entry.runtimeId === "opencode",
                ),
            ).toMatchObject({
                present: true,
                runtimeId: "opencode",
            });
            expect(JSON.stringify(diagnostics)).not.toContain(
                "codex-secret-value",
            );
            expect(JSON.stringify(diagnostics)).not.toContain(
                "gemini-secret-value",
            );
            expect(JSON.stringify(diagnostics)).not.toContain(
                "openai-secret-value",
            );
            expect(JSON.stringify(diagnostics)).not.toContain(
                "xai-secret-value",
            );
            expect(process.env.PATH).toBe(previousPath);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("finds Grok in its user install directory when inherited PATH is sparse", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-ai-diagnostics-grok-path-"),
        );

        try {
            const homeDir = path.join(tempDir, "home");
            const grokBinDir = path.join(homeDir, ".grok", "bin");
            fs.mkdirSync(grokBinDir, { recursive: true });
            const grokPath = writeTestExecutable(grokBinDir, "grok");

            const diagnostics = createAiEnvironmentDiagnostics({
                env: {
                    HOME: homeDir,
                    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
                    XAI_API_KEY: "xai-secret-value",
                },
                secretStore: createSecretStore(),
                settings: createSettings({
                    grok: {
                        authInvalidatedAtMs: null,
                        authMethod: "xai-api-key",
                        binaryPath: null,
                        hasXaiApiKey: false,
                    },
                }),
            });

            expect(
                diagnostics.executables.find(
                    (entry) => entry.command === "grok",
                ),
            ).toMatchObject({
                message: null,
                source: "path",
                state: "ready",
            });
            const grokExecutable = diagnostics.executables.find(
                (entry) => entry.command === "grok",
            );
            expectPathToBe(grokExecutable?.path, grokPath);

            const grokRuntime = diagnostics.runtimes.find(
                (runtime) => runtime.runtimeId === "grok",
            );
            expect(grokRuntime).toMatchObject({
                source: "path",
                state: "ready",
            });
            expectPathCommandToBe(
                grokRuntime?.command,
                `${grokPath} --no-auto-update agent stdio`,
            );
            expectPathToBe(grokRuntime?.executablePath, grokPath);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("keeps stored secret values out of diagnostics payloads", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-ai-diagnostics-secrets-"),
        );

        try {
            const diagnostics = createAiEnvironmentDiagnostics({
                env: {
                    COMANDO_CODEX_ACP_BIN: path.join(tempDir, "missing-codex"),
                    HOME: tempDir,
                    PATH: "",
                },
                secretStore: createSecretStore({
                    "ai.codex:codex_api_key": "stored-codex-secret",
                    "ai.gemini:gemini_api_key": "stored-gemini-secret",
                    "ai.grok:xai_api_key": "stored-xai-secret",
                }),
                settings: createSettings({
                    codex: {
                        authMethod: "codex-api-key",
                        binaryPath: null,
                        hasCodexApiKey: true,
                        hasOpenAiApiKey: false,
                    },
                    gemini: {
                        authInvalidatedAtMs: null,
                        authMethod: "use_gemini",
                        binaryPath: path.join(tempDir, "missing-gemini"),
                        googleCloudLocation: null,
                        googleCloudProject: null,
                        hasGeminiApiKey: true,
                        hasGoogleApiKey: false,
                    },
                    grok: {
                        authInvalidatedAtMs: null,
                        authMethod: "xai-api-key",
                        binaryPath: path.join(tempDir, "missing-grok"),
                        hasXaiApiKey: true,
                    },
                }),
            });
            const payload = JSON.stringify(diagnostics);

            expect(payload).not.toContain("stored-codex-secret");
            expect(payload).not.toContain("stored-gemini-secret");
            expect(payload).not.toContain("stored-xai-secret");
            expect(
                diagnostics.credentialEnvironment.find(
                    (entry) => entry.name === "CODEX_API_KEY",
                )?.present,
            ).toBe(false);
            expect(
                diagnostics.runtimes.find(
                    (runtime) => runtime.runtimeId === "codex",
                ),
            ).toMatchObject({
                authCredentialSource: "comando-secret",
                authMethod: "codex-api-key",
                authReady: true,
                executablePath: null,
                source: "env",
                state: "error",
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });
});

function createSettings(
    overrides: Partial<AiSettingsSnapshot> = {},
): AiSettingsSnapshot {
    return {
        claude: {
            authInvalidatedAtMs: null,
            authMethod: null,
            bedrockGatewayBaseUrl: null,
            binaryPath: null,
            gatewayBaseUrl: null,
            hasAnthropicApiKey: false,
            hasGatewayAuthToken: false,
            hasGatewayCustomHeaders: false,
        },
        codex: {
            authMethod: null,
            binaryPath: null,
            hasCodexApiKey: false,
            hasOpenAiApiKey: false,
        },
        gemini: {
            authInvalidatedAtMs: null,
            authMethod: null,
            binaryPath: null,
            googleCloudLocation: null,
            googleCloudProject: null,
            hasGeminiApiKey: false,
            hasGoogleApiKey: false,
        },
        grok: {
            authInvalidatedAtMs: null,
            authMethod: null,
            binaryPath: null,
            hasXaiApiKey: false,
        },
        kilo: {
            authInvalidatedAtMs: null,
            authMethod: null,
            binaryPath: null,
            hasKiloApiKey: false,
        },
        opencode: {
            authInvalidatedAtMs: null,
            authMethod: null,
            binaryPath: null,
        },
        ...overrides,
    };
}

function createSecretStore(
    values: Record<string, string> = {},
): SecretStoreGateway {
    return {
        getStorageStatus: () => ({
            encryptionAvailable: true,
            isWeakBackend: false,
            message: null,
            platform: process.platform,
            selectedBackend: null,
        }),
        loadSecret: (namespace: string, secretId: string) =>
            values[`${namespace}:${secretId}`] ?? null,
        saveSecret: () => undefined,
    };
}

function expectPathToBe(
    actual: string | null | undefined,
    expected: string,
): void {
    expect(normalizePathForComparison(actual)).toBe(
        normalizePathForComparison(expected),
    );
}

function expectPathCommandToBe(
    actual: string | null | undefined,
    expected: string,
): void {
    expect(normalizePathForComparison(actual)).toBe(
        normalizePathForComparison(expected),
    );
}

function normalizePathForComparison(value: string | null | undefined): string {
    const normalized = path.normalize(value ?? "");

    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
