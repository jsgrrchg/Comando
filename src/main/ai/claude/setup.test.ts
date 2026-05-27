import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    applyClaudeAuthEnv,
    buildClaudeSecretPatches,
    detectClaudeAuthMethod,
    gatewayValidationError,
    getClaudeAuthMethods,
    getClaudeRuntimeStatus,
    normalizeGatewayCustomHeaders,
    resolveClaudeRuntime,
} from "./setup";
type FakeSecretStore = {
    loadSecret: (namespace: string, secretId: string) => string | null;
    saveSecret: (
        namespace: string,
        secretId: string,
        value: string | null,
    ) => void;
};

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalClaudeEnv = process.env.COMANDO_CLAUDE_ACP_BIN;
const originalPath = process.env.PATH;
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalAnthropicBedrockBaseUrl =
    process.env.ANTHROPIC_BEDROCK_BASE_URL;
const originalAnthropicCustomHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS;
const originalClaudeCodeUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
const originalAwsBearerTokenBedrock = process.env.AWS_BEARER_TOKEN_BEDROCK;

beforeEach(() => {
    delete process.env.COMANDO_CLAUDE_ACP_BIN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

afterEach(() => {
    process.env.PATH = originalPath;

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

    if (typeof originalClaudeEnv === "string") {
        process.env.COMANDO_CLAUDE_ACP_BIN = originalClaudeEnv;
    } else {
        delete process.env.COMANDO_CLAUDE_ACP_BIN;
    }

    if (typeof originalAnthropicBaseUrl === "string") {
        process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
    } else {
        delete process.env.ANTHROPIC_BASE_URL;
    }

    if (typeof originalAnthropicApiKey === "string") {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    } else {
        delete process.env.ANTHROPIC_API_KEY;
    }

    if (typeof originalAnthropicAuthToken === "string") {
        process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
    } else {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
    }

    if (typeof originalAnthropicBedrockBaseUrl === "string") {
        process.env.ANTHROPIC_BEDROCK_BASE_URL =
            originalAnthropicBedrockBaseUrl;
    } else {
        delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    }

    if (typeof originalAnthropicCustomHeaders === "string") {
        process.env.ANTHROPIC_CUSTOM_HEADERS = originalAnthropicCustomHeaders;
    } else {
        delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    }

    if (typeof originalClaudeCodeUseBedrock === "string") {
        process.env.CLAUDE_CODE_USE_BEDROCK = originalClaudeCodeUseBedrock;
    } else {
        delete process.env.CLAUDE_CODE_USE_BEDROCK;
    }

    if (typeof originalAwsBearerTokenBedrock === "string") {
        process.env.AWS_BEARER_TOKEN_BEDROCK = originalAwsBearerTokenBedrock;
    } else {
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    }
});

describe("Claude setup", () => {
    it("resolves Claude with embedded Node and staged embedded vendor", () => {
        const tempRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-claude-bundled-"),
        );

        try {
            const embeddedNode = path.join(
                tempRoot,
                "resources",
                "ai",
                "embedded",
                "node",
                "bin",
                "node",
            );
            const embeddedEntry = path.join(
                tempRoot,
                "resources",
                "ai",
                "embedded",
                "claude-agent-acp",
                "dist",
                "index.js",
            );

            fs.mkdirSync(path.dirname(embeddedNode), { recursive: true });
            fs.mkdirSync(path.dirname(embeddedEntry), { recursive: true });
            fs.mkdirSync(path.join(tempRoot, "resources", "ai"), {
                recursive: true,
            });
            fs.writeFileSync(embeddedNode, "#!/bin/sh\nexit 0\n", "utf8");
            fs.writeFileSync(embeddedEntry, "console.log('ok')\n", "utf8");
            fs.writeFileSync(
                path.join(tempRoot, "package.json"),
                '{"name":"comando-test"}\n',
                "utf8",
            );
            fs.chmodSync(embeddedNode, 0o755);

            const resolved = resolveClaudeRuntime(
                createEmptyClaudeSettings(),
                createFakeSecretStore(),
                {
                    allowPathFallback: false,
                    currentFilePath: path.join(
                        tempRoot,
                        "out",
                        "main",
                        "index.js",
                    ),
                    debugMode: false,
                    packagedResourcesPath: null,
                },
            );

            expect(resolved.program).toBe(embeddedNode);
            expect(resolved.args).toEqual([embeddedEntry]);
            expect(resolved.status.source).toBe("bundled");
            expect(resolved.status.state).toBe("ready");
        } finally {
            fs.rmSync(tempRoot, { force: true, recursive: true });
        }
    });

    it("detects Claude auth from ~/.claude.json while respecting saved config", () => {
        const tempRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-claude-auth-"),
        );
        const tempHome = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-claude-home-"),
        );

        try {
            const embeddedNode = path.join(
                tempRoot,
                "resources",
                "ai",
                "embedded",
                "node",
                "bin",
                "node",
            );
            const embeddedEntry = path.join(
                tempRoot,
                "resources",
                "ai",
                "embedded",
                "claude-agent-acp",
                "dist",
                "index.js",
            );
            const authFile = path.join(tempHome, ".claude.json");

            fs.mkdirSync(path.dirname(embeddedNode), { recursive: true });
            fs.mkdirSync(path.dirname(embeddedEntry), { recursive: true });
            fs.writeFileSync(embeddedNode, "#!/bin/sh\nexit 0\n", "utf8");
            fs.writeFileSync(embeddedEntry, "console.log('ok')\n", "utf8");
            fs.writeFileSync(authFile, '{"session":true}', "utf8");
            fs.chmodSync(embeddedNode, 0o755);

            process.env.HOME = tempHome;
            delete process.env.USERPROFILE;

            const settings = {
                ...createEmptyClaudeSettings(),
                authMethod: "claude-ai-login" as const,
            };
            const status = getClaudeRuntimeStatus(
                settings,
                createFakeSecretStore(),
                {
                    allowPathFallback: false,
                    appRoot: tempRoot,
                    debugMode: false,
                    packagedResourcesPath: null,
                },
            );

            expect(detectClaudeAuthMethod(settings)).toBe("claude-ai-login");
            expect(status.authMethod).toBe("claude-ai-login");
            expect(status.authReady).toBe(true);
            expect(status.onboardingRequired).toBe(false);
        } finally {
            fs.rmSync(tempRoot, { force: true, recursive: true });
            fs.rmSync(tempHome, { force: true, recursive: true });
        }
    });

    it("reports external Claude login as disconnectable when discovered by fallback", () => {
        const tempRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-claude-auth-fallback-"),
        );
        const tempHome = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-claude-home-fallback-"),
        );

        try {
            const embeddedNode = path.join(
                tempRoot,
                "resources",
                "ai",
                "embedded",
                "node",
                "bin",
                "node",
            );
            const embeddedEntry = path.join(
                tempRoot,
                "resources",
                "ai",
                "embedded",
                "claude-agent-acp",
                "dist",
                "index.js",
            );
            const authFile = path.join(tempHome, ".claude.json");

            fs.mkdirSync(path.dirname(embeddedNode), { recursive: true });
            fs.mkdirSync(path.dirname(embeddedEntry), { recursive: true });
            fs.writeFileSync(embeddedNode, "#!/bin/sh\nexit 0\n", "utf8");
            fs.writeFileSync(embeddedEntry, "console.log('ok')\n", "utf8");
            fs.writeFileSync(authFile, '{"session":true}', "utf8");
            fs.chmodSync(embeddedNode, 0o755);

            process.env.HOME = tempHome;
            delete process.env.USERPROFILE;

            const status = getClaudeRuntimeStatus(
                createEmptyClaudeSettings(),
                createFakeSecretStore(),
                {
                    allowPathFallback: false,
                    appRoot: tempRoot,
                    debugMode: false,
                    packagedResourcesPath: null,
                },
            );

            expect(status.authMethod).toBe("claude-ai-login");
            expect(status.authCredentialSource).toBe("external-runtime");
            expect(status.canDisconnectAuth).toBe(true);
        } finally {
            fs.rmSync(tempRoot, { force: true, recursive: true });
            fs.rmSync(tempHome, { force: true, recursive: true });
        }
    });

    it("lists Claude API key and Bedrock gateway auth methods", () => {
        const methodIds = getClaudeAuthMethods().map((method) => method.id);

        expect(methodIds).toEqual(
            expect.arrayContaining([
                "anthropic-api-key",
                "gateway",
                "gateway-bedrock",
            ]),
        );
        expect(
            methodIds.includes("claude-login") ||
                methodIds.includes("claude-ai-login"),
        ).toBe(true);
    });

    it("prefers a stored Anthropic API key before external Claude login fallback", () => {
        const tempHome = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-claude-api-key-home-"),
        );

        try {
            fs.writeFileSync(
                path.join(tempHome, ".claude.json"),
                '{"session":true}',
                "utf8",
            );
            process.env.HOME = tempHome;
            delete process.env.USERPROFILE;

            const settings = {
                ...createEmptyClaudeSettings(),
                hasAnthropicApiKey: true,
            };
            const status = getClaudeRuntimeStatus(
                settings,
                createFakeSecretStore({
                    "ai.claude:anthropic_api_key": "stored-api-key",
                }),
                {
                    allowPathFallback: false,
                    appRoot: os.tmpdir(),
                    debugMode: false,
                    packagedResourcesPath: null,
                },
            );

            expect(detectClaudeAuthMethod(settings)).toBe(
                "anthropic-api-key",
            );
            expect(status.authMethod).toBe("anthropic-api-key");
            expect(status.authReady).toBe(true);
            expect(status.authCredentialSource).toBe("comando-secret");
        } finally {
            fs.rmSync(tempHome, { force: true, recursive: true });
        }
    });

    it("lets Anthropic API key environment override a selected login method", () => {
        process.env.ANTHROPIC_API_KEY = "external-api-key";

        const settings = {
            ...createEmptyClaudeSettings(),
            authMethod: "claude-ai-login" as const,
        };
        const status = getClaudeRuntimeStatus(
            settings,
            createFakeSecretStore(),
            {
                allowPathFallback: false,
                appRoot: os.tmpdir(),
                debugMode: false,
                packagedResourcesPath: null,
            },
        );

        expect(detectClaudeAuthMethod(settings)).toBe("anthropic-api-key");
        expect(status.authMethod).toBe("anthropic-api-key");
        expect(status.authReady).toBe(true);
        expect(status.authCredentialSource).toBe("environment");
    });

    it("prefers packaged macOS architecture-specific Node when available", () => {
        const tempRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-claude-packaged-"),
        );
        const packagedResourcesPath = path.join(tempRoot, "packaged");

        try {
            const packagedNode = path.join(
                packagedResourcesPath,
                "ai",
                "embedded",
                "node",
                `darwin-${process.arch}`,
                "bin",
                "node",
            );
            const packagedEntry = path.join(
                packagedResourcesPath,
                "ai",
                "embedded",
                "claude-agent-acp",
                "dist",
                "index.js",
            );

            fs.mkdirSync(path.dirname(packagedNode), { recursive: true });
            fs.mkdirSync(path.dirname(packagedEntry), { recursive: true });
            fs.writeFileSync(packagedNode, "#!/bin/sh\nexit 0\n", "utf8");
            fs.writeFileSync(packagedEntry, "console.log('ok')\n", "utf8");
            fs.chmodSync(packagedNode, 0o755);

            const resolved = resolveClaudeRuntime(
                createEmptyClaudeSettings(),
                createFakeSecretStore(),
                {
                    allowPathFallback: false,
                    appRoot: tempRoot,
                    debugMode: false,
                    packagedResourcesPath,
                },
            );

            expect(resolved.program).toBe(packagedNode);
            expect(resolved.args).toEqual([packagedEntry]);
            expect(resolved.status.source).toBe("bundled");
        } finally {
            fs.rmSync(tempRoot, { force: true, recursive: true });
        }
    });

    it("injects Claude gateway and secrets without overwriting external values", () => {
        const secretStore = createFakeSecretStore({
            "ai.claude:anthropic_auth_token": "stored-token",
            "ai.claude:anthropic_custom_headers": '{"x-test":"1"}',
        });

        const env = applyClaudeAuthEnv(
            {
                ANTHROPIC_AUTH_TOKEN: "external-token",
                AWS_BEARER_TOKEN_BEDROCK: "external-bedrock-token",
            },
            {
                ...createEmptyClaudeSettings(),
                authMethod: "gateway",
                gatewayBaseUrl: "https://gateway.example/v1",
                hasGatewayAuthToken: true,
                hasGatewayCustomHeaders: true,
            },
            secretStore,
        );

        expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example/v1");
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe("external-token");
        expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('{"x-test":"1"}');
        expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    });

    it("injects a stored Anthropic API key without leaking gateway credentials", () => {
        const secretStore = createFakeSecretStore({
            "ai.claude:anthropic_api_key": "stored-api-key",
            "ai.claude:anthropic_auth_token": "stored-token",
            "ai.claude:anthropic_custom_headers": '{"x-test":"1"}',
        });

        const env = applyClaudeAuthEnv(
            {},
            {
                ...createEmptyClaudeSettings(),
                authMethod: "anthropic-api-key",
                gatewayBaseUrl: "https://gateway.example/v1",
                hasAnthropicApiKey: true,
                hasGatewayAuthToken: true,
                hasGatewayCustomHeaders: true,
            },
            secretStore,
        );

        expect(env.ANTHROPIC_API_KEY).toBe("stored-api-key");
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    });

    it("injects Bedrock gateway env with custom headers and Bedrock bearer shim", () => {
        const secretStore = createFakeSecretStore({
            "ai.claude:anthropic_auth_token": "stored-token",
            "ai.claude:anthropic_custom_headers": '{"x-test":"1"}',
        });

        const env = applyClaudeAuthEnv(
            {},
            {
                ...createEmptyClaudeSettings(),
                authMethod: "gateway-bedrock",
                bedrockGatewayBaseUrl: "https://bedrock.example/v1",
            },
            secretStore,
        );

        expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBe(
            "https://bedrock.example/v1",
        );
        expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
        expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe(" ");
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('{"x-test":"1"}');
    });

    it("adds the Bedrock bearer shim for external Bedrock gateway env", () => {
        const env = applyClaudeAuthEnv(
            {
                ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example/v1",
            },
            createEmptyClaudeSettings(),
            createFakeSecretStore(),
        );

        expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBe(
            "https://bedrock.example/v1",
        );
        expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
        expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe(" ");
    });

    it("does not inject stored Claude gateway secrets for external login methods", () => {
        const secretStore = createFakeSecretStore({
            "ai.claude:anthropic_auth_token": "stored-token",
            "ai.claude:anthropic_custom_headers": '{"x-test":"1"}',
        });

        const env = applyClaudeAuthEnv(
            {},
            {
                ...createEmptyClaudeSettings(),
                authMethod: "claude-login",
                gatewayBaseUrl: "https://gateway.example/v1",
                hasGatewayAuthToken: true,
                hasGatewayCustomHeaders: true,
            },
            secretStore,
        );

        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    });

    it("keeps existing Claude secrets when omitted from a partial patch", () => {
        const result = buildClaudeSecretPatches(
            createFakeSecretStore({
                "ai.claude:anthropic_api_key": "stored-api-key",
                "ai.claude:anthropic_auth_token": "stored-token",
            }),
            {
                gatewayCustomHeaders: '{"x-test":"1"}',
            },
        );

        expect(result.flags).toEqual({
            hasAnthropicApiKey: true,
            hasGatewayAuthToken: true,
            hasGatewayCustomHeaders: true,
        });
        expect(result.patches).toEqual([
            {
                key: "secret.ai.claude.anthropic_custom_headers",
                value: '{"x-test":"1"}',
            },
        ]);
    });

    it("treats Anthropic gateway environment variables as ready without Comando secrets", () => {
        process.env.ANTHROPIC_BASE_URL = "https://gateway.example/v1";
        process.env.ANTHROPIC_AUTH_TOKEN = "external-token";

        const status = getClaudeRuntimeStatus(
            createEmptyClaudeSettings(),
            createFakeSecretStore(),
            {
                allowPathFallback: false,
                appRoot: os.tmpdir(),
                debugMode: false,
                packagedResourcesPath: null,
            },
        );

        expect(detectClaudeAuthMethod(createEmptyClaudeSettings())).toBe(
            "gateway",
        );
        expect(status.authMethod).toBe("gateway");
        expect(status.authReady).toBe(true);
        expect(status.authCredentialSource).toBe("environment");
        expect(status.canDisconnectAuth).toBe(false);
        expect(status.hasGatewayConfig).toBe(true);
    });

    it("treats Anthropic Bedrock gateway environment variables as ready", () => {
        process.env.ANTHROPIC_BEDROCK_BASE_URL =
            "https://bedrock.example/v1";

        const status = getClaudeRuntimeStatus(
            createEmptyClaudeSettings(),
            createFakeSecretStore(),
            {
                allowPathFallback: false,
                appRoot: os.tmpdir(),
                debugMode: false,
                packagedResourcesPath: null,
            },
        );

        expect(detectClaudeAuthMethod(createEmptyClaudeSettings())).toBe(
            "gateway-bedrock",
        );
        expect(status.authMethod).toBe("gateway-bedrock");
        expect(status.authReady).toBe(true);
        expect(status.authCredentialSource).toBe("environment");
        expect(status.hasGatewayConfig).toBe(true);
        expect(status.hasGatewayUrl).toBe(true);
    });

    it("lets Anthropic environment gateway override an invalid stored gateway URL", () => {
        const env = applyClaudeAuthEnv(
            {
                ANTHROPIC_BASE_URL: "https://gateway.example/v1",
                ANTHROPIC_AUTH_TOKEN: "external-token",
            },
            {
                ...createEmptyClaudeSettings(),
                authMethod: "gateway",
                gatewayBaseUrl: "http://gateway.example",
            },
            createFakeSecretStore(),
        );

        expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example/v1");
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe("external-token");
    });

    it("rejects remote HTTP gateways", () => {
        expect(
            gatewayValidationError({
                ...createEmptyClaudeSettings(),
                gatewayBaseUrl: "http://gateway.example",
            }),
        ).toBe("HTTP gateways are only allowed for localhost.");
    });

    it("normalizes empty Claude gateway custom headers to no secret", () => {
        expect(normalizeGatewayCustomHeaders("{}")).toBeNull();
    });
});

function createEmptyClaudeSettings() {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        bedrockGatewayBaseUrl: null,
        binaryPath: null,
        gatewayBaseUrl: null,
        hasAnthropicApiKey: false,
        hasGatewayAuthToken: false,
        hasGatewayCustomHeaders: false,
    };
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
