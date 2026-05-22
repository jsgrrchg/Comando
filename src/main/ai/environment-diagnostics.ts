import fs from "node:fs";
import path from "node:path";

import type {
    AiCredentialEnvironmentDiagnostic,
    AiEnvironmentDiagnostics,
    AiResolvedExecutable,
    AiRuntimeId,
    AiRuntimeDiagnostic,
    AiRuntimePathOverrideDiagnostic,
    AiRuntimeStatus,
    AiSettingsSnapshot,
} from "@shared/ipc";

import type { SecretStoreGateway } from "@main/ai/secret-store";

import { getCodexRuntimeStatus, loadCodexSecretBundle } from "./codex/setup";
import {
    getClaudeRuntimeStatus,
    resolveClaudeRuntime,
    type ResolveClaudeRuntimeOptions,
} from "./claude/setup";
import { getGeminiRuntimeStatus, resolveGeminiRuntime } from "./gemini/setup";
import { getKiloRuntimeStatus, resolveKiloRuntime } from "./kilo/setup";
import {
    getOpenCodeRuntimeStatus,
    resolveOpenCodeRuntime,
} from "./opencode/setup";
import {
    resolveCodexRuntime,
    type ResolveCodexRuntimeOptions,
} from "./resolver/runtime-resolver";
import { buildRuntimeSpawnEnv } from "./runtime-env";

type RuntimePathOverrideName = AiRuntimePathOverrideDiagnostic["name"];
type CredentialEnvironmentName = AiCredentialEnvironmentDiagnostic["name"];

export interface CreateAiEnvironmentDiagnosticsInput {
    readonly claudeResolveOptions?: ResolveClaudeRuntimeOptions;
    readonly codexResolveOptions?: ResolveCodexRuntimeOptions;
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => Date;
    readonly secretStore: SecretStoreGateway;
    readonly settings: AiSettingsSnapshot;
}

const EXECUTABLE_PROBES = [
    "claude-agent-acp",
    "codex-acp",
    "codex",
    "gemini",
    "kilo",
    "opencode",
    "node",
] as const;

const RUNTIME_PATH_OVERRIDES: readonly {
    readonly name: RuntimePathOverrideName;
    readonly runtimeId: AiRuntimeId;
}[] = [
    {
        name: "COMANDO_CLAUDE_ACP_BIN",
        runtimeId: "claude",
    },
    {
        name: "COMANDO_CODEX_ACP_BIN",
        runtimeId: "codex",
    },
    {
        name: "COMANDO_GEMINI_ACP_BIN",
        runtimeId: "gemini",
    },
    {
        name: "COMANDO_KILO_ACP_BIN",
        runtimeId: "kilo",
    },
    {
        name: "COMANDO_OPENCODE_ACP_BIN",
        runtimeId: "opencode",
    },
];

const CREDENTIAL_ENVIRONMENT: readonly {
    readonly name: CredentialEnvironmentName;
    readonly runtimeId: AiRuntimeId;
}[] = [
    {
        name: "ANTHROPIC_API_KEY",
        runtimeId: "claude",
    },
    {
        name: "ANTHROPIC_BEDROCK_BASE_URL",
        runtimeId: "claude",
    },
    {
        name: "ANTHROPIC_AUTH_TOKEN",
        runtimeId: "claude",
    },
    {
        name: "ANTHROPIC_BASE_URL",
        runtimeId: "claude",
    },
    {
        name: "ANTHROPIC_CUSTOM_HEADERS",
        runtimeId: "claude",
    },
    {
        name: "CODEX_API_KEY",
        runtimeId: "codex",
    },
    {
        name: "GEMINI_API_KEY",
        runtimeId: "gemini",
    },
    {
        name: "GOOGLE_API_KEY",
        runtimeId: "gemini",
    },
    {
        name: "KILO_API_KEY",
        runtimeId: "kilo",
    },
    {
        name: "OPENCODE_API_KEY",
        runtimeId: "opencode",
    },
    {
        name: "OPENAI_API_KEY",
        runtimeId: "codex",
    },
];

export function createAiEnvironmentDiagnostics(
    input: CreateAiEnvironmentDiagnosticsInput,
): AiEnvironmentDiagnostics {
    const env = normalizeProcessEnv(input.env ?? process.env);
    const checkedAt = input.now?.().toISOString() ?? new Date().toISOString();

    return withScopedProcessEnv(env, () => {
        const runtimes = createRuntimeDiagnostics(input, env);
        const preferredPath =
            runtimes.find((runtime) => runtime.preferredPath !== null)
                ?.preferredPath ?? null;

        return {
            checkedAt,
            credentialEnvironment: CREDENTIAL_ENVIRONMENT.map((entry) => ({
                name: entry.name,
                present: envValuePresent(env, entry.name),
                runtimeId: entry.runtimeId,
            })),
            executables: EXECUTABLE_PROBES.map((command) =>
                resolveExecutableProbe(command, env),
            ),
            path: {
                inherited: normalizeOptionalText(env.PATH),
                inheritedEntries: splitPathEntries(env.PATH),
                preferred: preferredPath,
                preferredEntries: splitPathEntries(preferredPath ?? undefined),
            },
            runtimePathOverrides: RUNTIME_PATH_OVERRIDES.map((entry) => {
                const pathOrCommand = normalizeOptionalText(env[entry.name]);

                return {
                    name: entry.name,
                    pathOrCommand,
                    present: pathOrCommand !== null,
                    runtimeId: entry.runtimeId,
                };
            }),
            runtimes,
        };
    });
}

function createRuntimeDiagnostics(
    input: CreateAiEnvironmentDiagnosticsInput,
    env: NodeJS.ProcessEnv,
): readonly AiRuntimeDiagnostic[] {
    const { secretStore, settings } = input;

    const codexStatus = readRuntimeStatus("codex", settings.codex, () =>
        getCodexRuntimeStatus(
            settings.codex,
            loadCodexSecretBundle(secretStore),
            env,
        ),
    );
    const claudeStatus = readRuntimeStatus("claude", settings.claude, () =>
        getClaudeRuntimeStatus(
            settings.claude,
            secretStore,
            input.claudeResolveOptions,
        ),
    );
    const geminiStatus = readRuntimeStatus("gemini", settings.gemini, () =>
        getGeminiRuntimeStatus(settings.gemini, secretStore),
    );
    const kiloStatus = readRuntimeStatus("kilo", settings.kilo, () =>
        getKiloRuntimeStatus(settings.kilo, secretStore),
    );
    const opencodeStatus = readRuntimeStatus(
        "opencode",
        settings.opencode,
        () => getOpenCodeRuntimeStatus(settings.opencode, secretStore),
    );

    return [
        toRuntimeDiagnostic(
            codexStatus,
            resolveRuntimeExecutable("codex", input),
            env,
        ),
        toRuntimeDiagnostic(
            claudeStatus,
            resolveRuntimeExecutable("claude", input),
            env,
        ),
        toRuntimeDiagnostic(
            geminiStatus,
            resolveRuntimeExecutable("gemini", input),
            env,
        ),
        toRuntimeDiagnostic(
            kiloStatus,
            resolveRuntimeExecutable("kilo", input),
            env,
        ),
        toRuntimeDiagnostic(
            opencodeStatus,
            resolveRuntimeExecutable("opencode", input),
            env,
        ),
    ];
}

function readRuntimeStatus(
    runtimeId: AiRuntimeId,
    settings: { readonly binaryPath: string | null },
    action: () => AiRuntimeStatus,
): AiRuntimeStatus {
    try {
        return action();
    } catch (error) {
        return {
            authMethod: null,
            authMethods: [],
            authReady: false,
            checkedAt: new Date().toISOString(),
            command: null,
            hasCustomBinaryPath: Boolean(settings.binaryPath?.trim()),
            hasGatewayConfig: false,
            hasGatewayUrl: false,
            message: `Failed to inspect ${runtimeId} runtime: ${formatErrorMessage(error)}`,
            onboardingRequired: true,
            runtimeId,
            source: null,
            state: "error",
        };
    }
}

function resolveRuntimeExecutable(
    runtimeId: AiRuntimeId,
    input: CreateAiEnvironmentDiagnosticsInput,
): string | null {
    try {
        switch (runtimeId) {
            case "claude":
                return resolveClaudeRuntime(
                    input.settings.claude,
                    input.secretStore,
                    input.claudeResolveOptions,
                ).program;
            case "codex":
                return resolveCodexRuntime(
                    input.settings.codex,
                    input.codexResolveOptions,
                ).executable;
            case "gemini":
                return resolveGeminiRuntime(
                    input.settings.gemini,
                    input.secretStore,
                ).program;
            case "kilo":
                return resolveKiloRuntime(
                    input.settings.kilo,
                    input.secretStore,
                ).program;
            case "opencode":
                return resolveOpenCodeRuntime(
                    input.settings.opencode,
                    input.secretStore,
                ).program;
        }
    } catch {
        return null;
    }
}

function toRuntimeDiagnostic(
    status: AiRuntimeStatus,
    executablePath: string | null,
    env: NodeJS.ProcessEnv,
): AiRuntimeDiagnostic {
    const readyExecutablePath = status.state === "ready" ? executablePath : null;
    const preferredPath = readyExecutablePath
        ? (buildRuntimeSpawnEnv(env, readyExecutablePath).PATH ?? null)
        : null;

    return {
        authCredentialSource: status.authCredentialSource ?? null,
        authMethod: status.authMethod,
        authReady: status.authReady,
        command: status.command,
        executablePath: readyExecutablePath,
        hasCustomBinaryPath: status.hasCustomBinaryPath,
        message: status.message,
        onboardingRequired: status.onboardingRequired,
        preferredPath,
        preferredPathEntries: splitPathEntries(preferredPath ?? undefined),
        runtimeId: status.runtimeId,
        source: status.source,
        state: status.state,
    };
}

function resolveExecutableProbe(
    command: (typeof EXECUTABLE_PROBES)[number],
    env: NodeJS.ProcessEnv,
): AiResolvedExecutable {
    const resolvedPath = resolveFromPath(command, env);

    if (!resolvedPath) {
        return {
            command,
            message: `Command was not found on PATH: ${command}`,
            path: null,
            source: null,
            state: "missing",
        };
    }

    return {
        command,
        message: null,
        path: resolvedPath,
        source: "path",
        state: "ready",
    };
}

function resolveFromPath(
    command: string,
    env: NodeJS.ProcessEnv,
): string | null {
    const pathEntries = splitPathEntries(env.PATH);
    const pathExtEntries =
        process.platform === "win32"
            ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
                  .split(";")
                  .filter(Boolean)
            : [""];

    for (const entry of pathEntries) {
        for (const extension of pathExtEntries) {
            const candidate = path.join(
                entry,
                process.platform === "win32" &&
                    !command.toLowerCase().endsWith(extension.toLowerCase())
                    ? `${command}${extension}`
                    : command,
            );

            if (isExecutableFile(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function isExecutableFile(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function withScopedProcessEnv<T>(
    env: NodeJS.ProcessEnv,
    action: () => T,
): T {
    const previousEnv = process.env;
    process.env = { ...env };

    try {
        return action();
    } finally {
        process.env = previousEnv;
    }
}

function normalizeProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const normalized: NodeJS.ProcessEnv = {};

    for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") {
            normalized[key] = value;
        }
    }

    return normalized;
}

function splitPathEntries(value: string | undefined): readonly string[] {
    return value?.split(path.delimiter).filter(Boolean) ?? [];
}

function envValuePresent(
    env: NodeJS.ProcessEnv,
    name: CredentialEnvironmentName,
): boolean {
    return normalizeOptionalText(env[name]) !== null;
}

function normalizeOptionalText(
    value: string | null | undefined,
): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

function formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
