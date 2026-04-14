import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    applyClaudeAuthEnv,
    detectClaudeAuthMethod,
    gatewayValidationError,
    getClaudeRuntimeStatus,
    resolveClaudeRuntime,
} from "./setup";
import type { SecretStoreService } from "../secret-store";

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

beforeEach(() => {
    delete process.env.COMANDO_CLAUDE_ACP_BIN;
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
});

describe("Claude setup", () => {
    it("resuelve Claude con Node embebido y vendor embebido stageado", () => {
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
                createFakeSecretStore() as unknown as SecretStoreService,
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

    it("detecta auth Claude desde ~/.claude.json respetando la config guardada", () => {
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
                createFakeSecretStore() as unknown as SecretStoreService,
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

    it("inyecta gateway y secretos Claude sin pisar valores externos", () => {
        const secretStore = createFakeSecretStore({
            "ai.claude:anthropic_auth_token": "stored-token",
            "ai.claude:anthropic_custom_headers": '{"x-test":"1"}',
        });

        const env = applyClaudeAuthEnv(
            {
                ANTHROPIC_AUTH_TOKEN: "external-token",
            },
            {
                ...createEmptyClaudeSettings(),
                authMethod: "gateway",
                gatewayBaseUrl: "https://gateway.example/v1",
                hasGatewayAuthToken: true,
                hasGatewayCustomHeaders: true,
            },
            secretStore as unknown as SecretStoreService,
        );

        expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example/v1");
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe("external-token");
        expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('{"x-test":"1"}');
    });

    it("rechaza gateways remotos sobre HTTP", () => {
        expect(
            gatewayValidationError({
                ...createEmptyClaudeSettings(),
                gatewayBaseUrl: "http://gateway.example",
            }),
        ).toBe("HTTP gateways are only allowed for localhost.");
    });
});

function createEmptyClaudeSettings() {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        gatewayBaseUrl: null,
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
