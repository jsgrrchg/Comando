import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AiSettingsSnapshot } from "@shared/ipc";

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

            const claudePath = writeExecutable(binDir, "claude-agent-acp");
            const codexPath = writeExecutable(binDir, "codex-acp");
            const geminiPath = writeExecutable(binDir, "gemini");
            const grokPath = writeExecutable(binDir, "grok");
            const kiloPath = writeExecutable(binDir, "kilo");
            const opencodePath = writeExecutable(binDir, "opencode");
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
            expect(
                diagnostics.executables.find(
                    (entry) => entry.command === "codex-acp",
                ),
            ).toMatchObject({
                path: codexPath,
                source: "path",
                state: "ready",
            });
            expect(
                diagnostics.runtimePathOverrides.find(
                    (entry) => entry.name === "COMANDO_GEMINI_ACP_BIN",
                ),
            ).toMatchObject({
                pathOrCommand: geminiPath,
                present: true,
                runtimeId: "gemini",
            });
            expect(
                diagnostics.runtimePathOverrides.find(
                    (entry) => entry.name === "COMANDO_GROK_ACP_BIN",
                ),
            ).toMatchObject({
                pathOrCommand: grokPath,
                present: true,
                runtimeId: "grok",
            });
            expect(
                diagnostics.credentialEnvironment.find(
                    (entry) => entry.name === "CODEX_API_KEY",
                ),
            ).toMatchObject({
                present: true,
                runtimeId: "codex",
            });
            expect(
                diagnostics.runtimes.find(
                    (runtime) => runtime.runtimeId === "codex",
                ),
            ).toMatchObject({
                authCredentialSource: "environment",
                authMethod: "codex-api-key",
                authReady: true,
                command: codexPath,
                executablePath: codexPath,
                source: "env",
                state: "ready",
            });
            expect(
                diagnostics.runtimes.find(
                    (runtime) => runtime.runtimeId === "gemini",
                ),
            ).toMatchObject({
                authCredentialSource: "environment",
                authMethod: "use_gemini",
                authReady: true,
                command: `${geminiPath} --acp`,
                executablePath: geminiPath,
                source: "env",
                state: "ready",
            });
            expect(
                diagnostics.runtimes.find(
                    (runtime) => runtime.runtimeId === "gemini",
                )?.preferredPathEntries[0],
            ).toBe(binDir);
            expect(
                diagnostics.runtimes.find(
                    (runtime) => runtime.runtimeId === "grok",
                ),
            ).toMatchObject({
                authCredentialSource: "environment",
                authMethod: "xai-api-key",
                authReady: true,
                command: `${grokPath} --no-auto-update agent stdio`,
                executablePath: grokPath,
                source: "env",
                state: "ready",
            });
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
            expect(
                diagnostics.runtimes.find(
                    (runtime) => runtime.runtimeId === "opencode",
                ),
            ).toMatchObject({
                authCredentialSource: "environment",
                authMethod: "opencode-login",
                authReady: true,
                command: `${opencodePath} acp`,
                executablePath: opencodePath,
                source: "env",
                state: "ready",
            });
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

function writeExecutable(directory: string, name: string): string {
    const executableName = process.platform === "win32" ? `${name}.cmd` : name;
    const executablePath = path.join(directory, executableName);
    const content =
        process.platform === "win32"
            ? "@echo off\r\nexit /b 0\r\n"
            : "#!/bin/sh\nexit 0\n";

    fs.writeFileSync(executablePath, content, "utf8");
    fs.chmodSync(executablePath, 0o755);

    return executablePath;
}
