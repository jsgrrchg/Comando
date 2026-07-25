import { createHash, randomUUID } from "node:crypto";

import {
    isCustomAcpRuntimeId,
} from "@shared/ai-runtimes";
import type {
    CustomAcpRuntimeDefinition,
    CustomAcpRuntimeDefinitionInput,
    CustomAcpRuntimeId,
    CustomAcpRuntimesSettings,
} from "@shared/ipc";

const MAX_RUNTIME_COUNT = 32;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_ARG_COUNT = 64;
const MAX_ARG_LENGTH = 4_096;
const MAX_ENV_COUNT = 32;
const MAX_ENV_VALUE_LENGTH = 8_192;
const MAX_TOTAL_LAUNCH_TEXT_LENGTH = 32_768;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_LIKE_ENV_KEY_PATTERN =
    /(?:^|_)(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|PRIVATE|SECRET|TOKEN)(?:_|$)/i;
const PROTECTED_ENV_KEYS = new Set(["PATH", "PATHEXT"]);
const CUSTOM_ACP_LAUNCH_PROFILE = "acp-current14-custom-v1";

function compareCanonicalLaunchKeys(left: string, right: string): number {
    // Environment keys are ASCII-only, so ordinal comparison matches Rust's
    // BTreeMap ordering without depending on the JavaScript host locale.
    return left < right ? -1 : left > right ? 1 : 0;
}

export interface CustomAcpRuntimeValidationOptions {
    readonly existingDefinitions?: readonly CustomAcpRuntimeDefinition[];
    readonly excludeId?: CustomAcpRuntimeId | null;
}

export function assertCustomAcpRuntimeCapacity(
    existingDefinitions: readonly CustomAcpRuntimeDefinition[],
): void {
    if (existingDefinitions.length >= MAX_RUNTIME_COUNT) {
        throw new Error(`At most ${MAX_RUNTIME_COUNT} custom runtimes are supported.`);
    }
}

export function assertDeletedCustomAcpRuntimeCapacity(
    deletedDefinitions: readonly CustomAcpRuntimeDefinition[],
): void {
    if (deletedDefinitions.length >= MAX_RUNTIME_COUNT) {
        throw new Error(
            `At most ${MAX_RUNTIME_COUNT} deleted custom runtimes can be retained. Restore one before deleting another.`,
        );
    }
}

export function validateCustomAcpRuntimeInput(
    input: CustomAcpRuntimeDefinitionInput,
    options: CustomAcpRuntimeValidationOptions = {},
): CustomAcpRuntimeDefinitionInput {
    if (!isRecord(input)) {
        throw new Error("Custom runtime definition must be an object.");
    }
    const displayName = requireTrimmedString(
        input.displayName,
        "Runtime name",
        MAX_DISPLAY_NAME_LENGTH,
    );
    const command = requireTrimmedString(
        input.command,
        "Command",
        MAX_COMMAND_LENGTH,
    );
    if (command.includes("\0")) {
        throw new Error("Command cannot contain NUL characters.");
    }
    if ((input as { readonly authMode?: unknown }).authMode !== "external") {
        throw new Error("Custom runtime authentication must be managed externally.");
    }
    if (!Array.isArray(input.args) || input.args.length > MAX_ARG_COUNT) {
        throw new Error(`Arguments must contain at most ${MAX_ARG_COUNT} items.`);
    }
    const args = input.args.map((arg, index) => {
        if (typeof arg !== "string") {
            throw new Error(`Argument ${index + 1} must be text.`);
        }
        if (arg.length > MAX_ARG_LENGTH) {
            throw new Error(
                `Argument ${index + 1} must be at most ${MAX_ARG_LENGTH} characters.`,
            );
        }
        if (arg.includes("\0")) {
            throw new Error(`Argument ${index + 1} cannot contain NUL characters.`);
        }
        return arg;
    });
    if (!isRecord(input.env)) {
        throw new Error("Environment must be a key/value object.");
    }
    const envEntries = Object.entries(input.env);
    if (envEntries.length > MAX_ENV_COUNT) {
        throw new Error(
            `Environment must contain at most ${MAX_ENV_COUNT} variables.`,
        );
    }
    const env: Record<string, string> = {};
    for (const [key, value] of envEntries.sort(([left], [right]) =>
        compareCanonicalLaunchKeys(left, right),
    )) {
        if (!ENV_KEY_PATTERN.test(key)) {
            throw new Error(`Environment variable "${key}" has an invalid name.`);
        }
        if (PROTECTED_ENV_KEYS.has(key.toUpperCase())) {
            throw new Error(
                `Environment variable "${key}" is controlled by Comando.`,
            );
        }
        if (SECRET_LIKE_ENV_KEY_PATTERN.test(key)) {
            throw new Error(
                `Environment variable "${key}" looks secret. Custom runtime secrets are not supported.`,
            );
        }
        if (typeof value !== "string") {
            throw new Error(`Environment variable "${key}" must contain text.`);
        }
        if (value.length > MAX_ENV_VALUE_LENGTH) {
            throw new Error(
                `Environment variable "${key}" must be at most ${MAX_ENV_VALUE_LENGTH} characters.`,
            );
        }
        if (value.includes("\0")) {
            throw new Error(
                `Environment variable "${key}" cannot contain NUL characters.`,
            );
        }
        env[key] = value;
    }

    const launchTextLength =
        command.length +
        args.reduce((total, arg) => total + arg.length, 0) +
        Object.entries(env).reduce(
            (total, [key, value]) => total + key.length + value.length,
            0,
        );
    if (launchTextLength > MAX_TOTAL_LAUNCH_TEXT_LENGTH) {
        throw new Error("Custom runtime launch definition is too large.");
    }

    const duplicate = options.existingDefinitions?.find(
        (definition) =>
            definition.id !== options.excludeId &&
            definition.displayName.localeCompare(displayName, undefined, {
                sensitivity: "accent",
            }) === 0,
    );
    if (duplicate) {
        throw new Error(`A custom runtime named "${displayName}" already exists.`);
    }

    return {
        args,
        authMode: "external",
        command,
        displayName,
        env,
    };
}

export function calculateCustomAcpLaunchFingerprint(
    definition: Pick<
        CustomAcpRuntimeDefinitionInput,
        "args" | "authMode" | "command" | "env"
    >,
): string {
    const normalized = {
        args: [...definition.args],
        authMode: definition.authMode,
        command: definition.command,
        env: Object.fromEntries(
            Object.entries(definition.env).sort(([left], [right]) =>
                compareCanonicalLaunchKeys(left, right),
            ),
        ),
        profile: CUSTOM_ACP_LAUNCH_PROFILE,
    };

    // The fingerprint identifies launch semantics, so display-only edits do not
    // invalidate historical sessions.
    return createHash("sha256")
        .update(JSON.stringify(normalized))
        .digest("hex");
}

export function createCustomAcpRuntimeDefinition(
    input: CustomAcpRuntimeDefinitionInput,
    existingDefinitions: readonly CustomAcpRuntimeDefinition[],
    idFactory: () => string = randomUUID,
): CustomAcpRuntimeDefinition {
    assertCustomAcpRuntimeCapacity(existingDefinitions);
    const normalized = validateCustomAcpRuntimeInput(input, {
        existingDefinitions,
    });
    const id = `custom:${idFactory()}`;
    if (!isCustomAcpRuntimeId(id)) {
        throw new Error("Main generated an invalid custom runtime ID.");
    }
    return {
        ...normalized,
        id,
        launchFingerprint: calculateCustomAcpLaunchFingerprint(normalized),
        revision: 1,
    };
}

export function updateCustomAcpRuntimeDefinition(
    current: CustomAcpRuntimeDefinition,
    input: CustomAcpRuntimeDefinitionInput,
    existingDefinitions: readonly CustomAcpRuntimeDefinition[],
): CustomAcpRuntimeDefinition {
    const normalized = validateCustomAcpRuntimeInput(input, {
        excludeId: current.id,
        existingDefinitions,
    });
    return {
        ...normalized,
        id: current.id,
        launchFingerprint: calculateCustomAcpLaunchFingerprint(normalized),
        revision: current.revision + 1,
    };
}

export function normalizeCustomAcpRuntimesSettings(
    value: unknown,
    onDiagnostic?: (message: string) => void,
): CustomAcpRuntimesSettings {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.runtimes)) {
        if (value !== null && value !== undefined) {
            onDiagnostic?.("Discarded malformed custom ACP runtime settings.");
        }
        return { runtimes: [], version: 1 };
    }

    if (value.runtimes.length > MAX_RUNTIME_COUNT) {
        onDiagnostic?.(
            `Discarded custom ACP runtimes beyond the supported maximum of ${MAX_RUNTIME_COUNT}.`,
        );
    }
    const definitions: CustomAcpRuntimeDefinition[] = [];
    for (const candidate of value.runtimes.slice(0, MAX_RUNTIME_COUNT)) {
        try {
            if (
                !isRecord(candidate) ||
                !isCustomAcpRuntimeId(candidate.id) ||
                !Number.isSafeInteger(candidate.revision) ||
                (candidate.revision as number) < 1
            ) {
                throw new Error("identity or revision is invalid");
            }
            const normalized = validateCustomAcpRuntimeInput(
                candidate as unknown as CustomAcpRuntimeDefinitionInput,
                { existingDefinitions: definitions },
            );
            definitions.push({
                ...normalized,
                id: candidate.id,
                // Persisted fingerprints are never trusted as launch authority.
                launchFingerprint:
                    calculateCustomAcpLaunchFingerprint(normalized),
                revision: candidate.revision as number,
            });
        } catch (error) {
            onDiagnostic?.(
                `Discarded malformed custom ACP runtime: ${formatError(error)}`,
            );
        }
    }

    const deletedDefinitions: CustomAcpRuntimeDefinition[] = [];
    const deletedCandidates = Array.isArray(value.deletedRuntimes)
        ? value.deletedRuntimes
        : [];
    if (deletedCandidates.length > MAX_RUNTIME_COUNT) {
        onDiagnostic?.(
            `Discarded deleted custom ACP runtimes beyond the supported maximum of ${MAX_RUNTIME_COUNT}.`,
        );
    }
    for (const candidate of deletedCandidates.slice(0, MAX_RUNTIME_COUNT)) {
        try {
            if (
                !isRecord(candidate) ||
                !isCustomAcpRuntimeId(candidate.id) ||
                !Number.isSafeInteger(candidate.revision) ||
                (candidate.revision as number) < 1 ||
                definitions.some(
                    (definition) => definition.id === candidate.id,
                ) ||
                deletedDefinitions.some(
                    (definition) => definition.id === candidate.id,
                )
            ) {
                throw new Error("deleted identity or revision is invalid");
            }
            const normalized = validateCustomAcpRuntimeInput(
                candidate as unknown as CustomAcpRuntimeDefinitionInput,
                { existingDefinitions: [] },
            );
            deletedDefinitions.push({
                ...normalized,
                id: candidate.id,
                // Tombstones remain untrusted persisted input until restored.
                launchFingerprint:
                    calculateCustomAcpLaunchFingerprint(normalized),
                revision: candidate.revision as number,
            });
        } catch (error) {
            onDiagnostic?.(
                `Discarded malformed deleted custom ACP runtime: ${formatError(error)}`,
            );
        }
    }

    return {
        ...(deletedDefinitions.length > 0
            ? { deletedRuntimes: deletedDefinitions }
            : {}),
        runtimes: definitions,
        version: 1,
    };
}

function requireTrimmedString(
    value: unknown,
    label: string,
    maxLength: number,
): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} is required.`);
    }
    const normalized = value.trim();
    if (normalized.length > maxLength) {
        throw new Error(`${label} must be at most ${maxLength} characters.`);
    }
    return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
