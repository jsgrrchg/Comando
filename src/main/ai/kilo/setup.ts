import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
    AiAuthCredentialSource,
    AiAuthMethod,
    AiRuntimeStatus,
    KiloAuthMethodId,
    KiloRuntimeSettings,
} from "@shared/ipc";

import type { SecretRecordPatch, SecretStoreGateway } from "../secret-store.ts";
import { launchTerminalLoginCommand } from "../auth/terminal-login.ts";
import { debugBenignError } from "../../observability/logging.ts";

const KILO_PROGRAM_NAME = "kilo";
const KILO_ACP_SUBCOMMAND = "acp";
const KILO_AUTH_LOGIN_SUBCOMMAND = ["auth", "login"] as const;
const KILO_ENV_BIN = "COMANDO_KILO_ACP_BIN";
const KILO_API_KEY_ENV = "KILO_API_KEY";
const KILO_LOGIN_METHOD_ID = "kilo-login" satisfies KiloAuthMethodId;
const KILO_API_KEY_METHOD_ID = "kilo-api-key" satisfies KiloAuthMethodId;
const KILO_SECRET_NAMESPACE = "ai.kilo";
const KILO_API_KEY_SECRET = "kilo_api_key";
const KILO_MACOS_FALLBACK_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
] as const;

interface ResolvedKiloBinary {
    readonly args: readonly string[];
    readonly command: string | null;
    readonly message: string | null;
    readonly program: string | null;
    readonly source: AiRuntimeStatus["source"];
    readonly state: AiRuntimeStatus["state"];
}

export interface ResolvedKiloRuntimeCommand {
    readonly args: readonly string[];
    readonly command: string;
    readonly program: string;
    readonly status: AiRuntimeStatus;
}

interface KiloAuthStoreStatus {
    readonly hasActiveAuth: boolean;
    readonly modifiedAtMs: number | null;
}

export interface KiloSecretBundle {
    readonly kiloApiKey: string | null;
}

export function getKiloRuntimeStatus(
    settings: KiloRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
): AiRuntimeStatus {
    const resolved = resolveKiloBinary(settings);
    const authMethods = getKiloAuthMethods();
    const authMethod = detectKiloAuthMethod(settings, secretStore);
    const secrets = loadKiloSecretBundle(secretStore);
    const credentialSource = getKiloCredentialSource(
        authMethod,
        secrets,
        process.env,
    );
    const storageStatus = secretStore?.getStorageStatus?.() ?? {
        encryptionAvailable: true,
        isWeakBackend: false,
        message: null,
        platform: process.platform,
        selectedBackend: null,
    };
    const binaryReady = resolved.state === "ready" && Boolean(resolved.program);
    const authReady = authMethod !== null;

    let message = resolved.message;
    if (binaryReady && !authReady) {
        message = "Sign in with Kilo or add a Kilo API key to finish setup.";
    }

    return {
        authMethod,
        authMethods,
        authReady,
        authCredentialSource: credentialSource,
        authCredentialSourceLabel:
            getCredentialSourceLabel(credentialSource),
        authSessionMessage:
            "This affects new sessions. Active sessions may keep using credentials loaded at launch.",
        authStorageMessage: storageStatus.message,
        canDisconnectAuth:
            readSelectedKiloAuthMethod(settings) !== null ||
            Boolean(secrets.kiloApiKey) ||
            (credentialSource !== "environment" && authMethod !== null) ||
            settings.authInvalidatedAtMs !== null,
        canLogoutAuth: false,
        checkedAt: new Date().toISOString(),
        command: resolved.command,
        hasCustomBinaryPath: Boolean(settings.binaryPath?.trim()),
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message,
        onboardingRequired: !binaryReady || !authReady,
        runtimeId: "kilo",
        source: resolved.source,
        state: resolved.state,
    };
}

export function resolveKiloRuntime(
    settings: KiloRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
): ResolvedKiloRuntimeCommand {
    const resolved = resolveKiloBinary(settings);
    const status = getKiloRuntimeStatus(settings, secretStore);

    if (resolved.program === null || resolved.command === null) {
        throw new Error(
            status.message ?? "Kilo ACP is not available on this machine.",
        );
    }

    return {
        args: resolved.args,
        command: resolved.command,
        program: resolved.program,
        status,
    };
}

export function detectKiloAuthMethod(
    settings: KiloRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
): KiloAuthMethodId | null {
    const secrets = loadKiloSecretBundle(secretStore);
    const selectedAuthMethod = readSelectedKiloAuthMethod(settings);

    if (envSecretPresent(process.env, KILO_API_KEY_ENV)) {
        return KILO_API_KEY_METHOD_ID;
    }

    if (
        selectedAuthMethod === KILO_API_KEY_METHOD_ID &&
        Boolean(secrets.kiloApiKey)
    ) {
        return KILO_API_KEY_METHOD_ID;
    }

    if (
        selectedAuthMethod === KILO_LOGIN_METHOD_ID &&
        kiloLoginAvailable(settings)
    ) {
        return KILO_LOGIN_METHOD_ID;
    }

    if (selectedAuthMethod !== null) {
        return null;
    }

    if (secrets.kiloApiKey) {
        return KILO_API_KEY_METHOD_ID;
    }

    if (kiloLoginAvailable(settings)) {
        return KILO_LOGIN_METHOD_ID;
    }

    return null;
}

export function getKiloAuthMethods(): readonly AiAuthMethod[] {
    return [
        {
            description:
                "Open Kilo CLI in a system terminal and complete sign-in there.",
            id: KILO_LOGIN_METHOD_ID,
            name: "Kilo login",
        },
        {
            description:
                "Use a Kilo API key stored only for Comando on this machine.",
            id: KILO_API_KEY_METHOD_ID,
            name: "Kilo API key",
        },
    ];
}

export function getKiloCredentialSource(
    authMethod: KiloAuthMethodId | null,
    secrets: KiloSecretBundle,
    env: NodeJS.ProcessEnv = process.env,
): AiAuthCredentialSource {
    if (authMethod === KILO_API_KEY_METHOD_ID) {
        if (envSecretPresent(env, KILO_API_KEY_ENV)) {
            return "environment";
        }

        if (secrets.kiloApiKey) {
            return "comando-secret";
        }
    }

    if (authMethod === KILO_LOGIN_METHOD_ID) {
        return "external-runtime";
    }

    return "none";
}

export function loadKiloSecretBundle(
    secretStore?: SecretStoreGateway | null,
): KiloSecretBundle {
    return {
        kiloApiKey:
            secretStore?.loadSecret(
                KILO_SECRET_NAMESPACE,
                KILO_API_KEY_SECRET,
            ) ?? null,
    };
}

export function saveKiloSecrets(
    secretStore: SecretStoreGateway,
    input: KiloSecretBundle,
): {
    readonly hasKiloApiKey: boolean;
} {
    const kiloApiKey = normalizeOptionalText(input.kiloApiKey);
    saveSecretIfChanged(
        secretStore,
        KILO_SECRET_NAMESPACE,
        KILO_API_KEY_SECRET,
        normalizeOptionalText(
            secretStore.loadSecret(KILO_SECRET_NAMESPACE, KILO_API_KEY_SECRET),
        ),
        kiloApiKey,
    );

    return {
        hasKiloApiKey: Boolean(kiloApiKey),
    };
}

export function buildKiloSecretPatches(
    secretStore: SecretStoreGateway,
    input: KiloSecretBundle,
): {
    readonly flags: {
        readonly hasKiloApiKey: boolean;
    };
    readonly patches: readonly SecretRecordPatch[];
} {
    const kiloApiKey = normalizeOptionalText(input.kiloApiKey);
    const patches: SecretRecordPatch[] = [];

    pushSecretPatchIfChanged(
        patches,
        KILO_SECRET_NAMESPACE,
        KILO_API_KEY_SECRET,
        normalizeOptionalText(
            secretStore.loadSecret(KILO_SECRET_NAMESPACE, KILO_API_KEY_SECRET),
        ),
        kiloApiKey,
    );

    return {
        flags: {
            hasKiloApiKey: Boolean(kiloApiKey),
        },
        patches,
    };
}

export function applyKiloAuthEnv(
    baseEnv: NodeJS.ProcessEnv,
    settings: KiloRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
): NodeJS.ProcessEnv {
    const env = { ...baseEnv };

    if (envSecretPresent(baseEnv, KILO_API_KEY_ENV)) {
        return env;
    }

    delete env[KILO_API_KEY_ENV];

    if (readSelectedKiloAuthMethod(settings) === KILO_LOGIN_METHOD_ID) {
        return env;
    }

    const secrets = loadKiloSecretBundle(secretStore);
    if (secrets.kiloApiKey) {
        env[KILO_API_KEY_ENV] = secrets.kiloApiKey;
    }

    return env;
}

export function markKiloAuthInvalidated(
    settings: KiloRuntimeSettings,
): KiloRuntimeSettings {
    return {
        ...settings,
        authInvalidatedAtMs: Date.now(),
    };
}

export function launchKiloLogin(
    settings: KiloRuntimeSettings,
    cwd?: string | null,
): Promise<void> {
    const resolved = resolveKiloBinary(settings);
    if (!resolved.program) {
        throw new Error(
            resolved.message ??
                "Kilo CLI was not found. Install kilo or provide a custom runtime path.",
        );
    }

    const commandParts = [resolved.program, ...KILO_AUTH_LOGIN_SUBCOMMAND];

    return launchTerminalLoginCommand({
        commandParts,
        cwd,
        missingTerminalMessage:
            "No compatible terminal launcher was found for Kilo login.",
        scriptPrefix: "comando-kilo-login",
    });
}

export function isKiloAuthenticationError(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return (
        normalized.includes("auth_required") ||
        normalized.includes("authentication required") ||
        normalized.includes("run `kilo auth login`") ||
        normalized.includes("you were signed out") ||
        normalized.includes("reconnect kilo")
    );
}

function saveSecretIfChanged(
    secretStore: SecretStoreGateway,
    namespace: string,
    secretId: string,
    currentValue: string | null,
    nextValue: string | null,
): void {
    if (currentValue === nextValue) {
        return;
    }

    void secretStore.saveSecret(namespace, secretId, nextValue);
}

function pushSecretPatchIfChanged(
    patches: SecretRecordPatch[],
    namespace: string,
    secretId: string,
    currentValue: string | null,
    nextValue: string | null,
): void {
    if (currentValue === nextValue) {
        return;
    }

    patches.push({
        key: buildKiloSecretStorageKey(namespace, secretId),
        value: nextValue,
    });
}

function buildKiloSecretStorageKey(namespace: string, secretId: string): string {
    return `secret.${namespace}.${secretId}`;
}

function normalizeOptionalText(
    value: string | null | undefined,
): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

function readSelectedKiloAuthMethod(
    settings: KiloRuntimeSettings,
): KiloAuthMethodId | null {
    const authMethod = (settings as { readonly authMethod?: unknown })
        .authMethod;
    if (
        authMethod === KILO_LOGIN_METHOD_ID ||
        authMethod === KILO_API_KEY_METHOD_ID
    ) {
        return authMethod;
    }

    return null;
}

function kiloLoginAvailable(settings: KiloRuntimeSettings): boolean {
    const status = getKiloAuthStoreStatus();
    if (!status?.hasActiveAuth) {
        return false;
    }

    if (
        settings.authInvalidatedAtMs !== null &&
        status.modifiedAtMs !== null &&
        status.modifiedAtMs <= settings.authInvalidatedAtMs
    ) {
        return false;
    }

    return true;
}

function envSecretPresent(env: NodeJS.ProcessEnv, key: typeof KILO_API_KEY_ENV) {
    return Boolean(env[key]?.trim());
}

function getCredentialSourceLabel(source: AiAuthCredentialSource): string {
    switch (source) {
        case "comando-secret":
            return "Using Comando stored credentials";
        case "environment":
            return "Using environment variable";
        case "external-runtime":
            return "Using external Kilo login";
        case "none":
        default:
            return "Needs authentication";
    }
}

function resolveKiloBinary(settings: KiloRuntimeSettings): ResolvedKiloBinary {
    const envPath = process.env[KILO_ENV_BIN]?.trim() ?? "";
    const configuredPath = settings.binaryPath?.trim() ?? "";

    if (envPath) {
        return resolveCommandCandidate(envPath, "env");
    }

    if (configuredPath) {
        return resolveCommandCandidate(configuredPath, "settings");
    }

    const pathResolved = resolveFromPath(KILO_PROGRAM_NAME);
    if (pathResolved) {
        return commandFromExistingPath(pathResolved, "path");
    }

    const macOsResolved = resolveFromMacOsFallbackDirs(KILO_PROGRAM_NAME);
    if (macOsResolved) {
        return commandFromExistingPath(macOsResolved, "path");
    }

    return {
        args: [],
        command: null,
        message:
            "Kilo CLI was not found. Install `kilo` or provide a custom runtime path.",
        program: null,
        source: null,
        state: "missing",
    };
}

function resolveCommandCandidate(
    raw: string,
    source: AiRuntimeStatus["source"],
): ResolvedKiloBinary {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {
            args: [],
            command: null,
            message: "Kilo runtime path is empty.",
            program: null,
            source,
            state: "missing",
        };
    }

    const looksLikePath =
        path.isAbsolute(trimmed) ||
        trimmed.includes(path.sep) ||
        trimmed.includes("/") ||
        trimmed.includes("\\");

    if (looksLikePath) {
        const candidate = path.resolve(trimmed);
        if (!isExecutableFile(candidate)) {
            return {
                args: [],
                command: candidate,
                message: `Could not execute the configured Kilo runtime: ${candidate}`,
                program: null,
                source,
                state: "error",
            };
        }

        return commandFromExistingPath(candidate, source);
    }

    const found = resolveFromPath(trimmed);
    if (!found) {
        return {
            args: [],
            command: trimmed,
            message: `Configured command was not found: ${trimmed}`,
            program: null,
            source,
            state: "missing",
        };
    }

    return commandFromExistingPath(found, source);
}

function commandFromExistingPath(
    candidatePath: string,
    source: AiRuntimeStatus["source"],
): ResolvedKiloBinary {
    if (!isExecutableFile(candidatePath)) {
        return {
            args: [],
            command: candidatePath,
            message: `Kilo runtime is not executable: ${candidatePath}`,
            program: null,
            source,
            state: "error",
        };
    }

    return {
        args: [KILO_ACP_SUBCOMMAND],
        command: `${candidatePath} ${KILO_ACP_SUBCOMMAND}`,
        message: null,
        program: candidatePath,
        source,
        state: "ready",
    };
}

function getKiloAuthStoreStatus(): KiloAuthStoreStatus | null {
    return mergeAuthStoreStatus(
        getKiloSqliteAuthStoreStatus(),
        getKiloLegacyAuthStoreStatus(),
    );
}

function getKiloLegacyAuthStoreStatus(): KiloAuthStoreStatus | null {
    const authPath = getKiloAuthStorePath();
    if (!authPath || !isFile(authPath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(authPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const nowMs = Date.now();
        const hasActiveAuth = Object.values(parsed).some((entry) =>
            hasActiveLegacyAuthEntry(entry, nowMs),
        );

        return {
            hasActiveAuth,
            modifiedAtMs: getFileModifiedAtMs(authPath),
        };
    } catch (error) {
        debugBenignError("ai.kilo.readLegacyAuthStore", error);
        return null;
    }
}

function getKiloSqliteAuthStoreStatus(): KiloAuthStoreStatus | null {
    const databasePath = getKiloSqliteStorePath();
    return databasePath ? readKiloSqliteAuthStoreStatus(databasePath) : null;
}

export function readKiloSqliteAuthStoreStatus(
    databasePath: string,
): KiloAuthStoreStatus | null {
    if (!isFile(databasePath)) {
        return null;
    }

    let database: DatabaseSync | null = null;

    try {
        database = new DatabaseSync(databasePath, {
            readOnly: true,
        });
        const nowMs = Date.now();
        const hasActiveAuth =
            hasActiveAccountRow(database, nowMs) ||
            hasActiveControlAccountRow(database, nowMs) ||
            hasAnyAuthenticatedAccountRow(database, nowMs);

        return {
            hasActiveAuth,
            modifiedAtMs: getFileModifiedAtMs(databasePath),
        };
    } catch (error) {
        debugBenignError("ai.kilo.readSqliteAuthStore", error);
        return null;
    } finally {
        database?.close();
    }
}

function mergeAuthStoreStatus(
    primary: KiloAuthStoreStatus | null,
    secondary: KiloAuthStoreStatus | null,
): KiloAuthStoreStatus | null {
    if (!primary) {
        return secondary;
    }

    if (!secondary) {
        return primary;
    }

    return {
        hasActiveAuth: primary.hasActiveAuth || secondary.hasActiveAuth,
        modifiedAtMs:
            primary.modifiedAtMs === null
                ? secondary.modifiedAtMs
                : secondary.modifiedAtMs === null
                  ? primary.modifiedAtMs
                  : Math.max(primary.modifiedAtMs, secondary.modifiedAtMs),
    };
}

function hasActiveLegacyAuthEntry(entry: unknown, nowMs: number): boolean {
    if (!entry || typeof entry !== "object") {
        return false;
    }

    const record = entry as Record<string, unknown>;
    const type =
        typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    const key = readTrimmedString(record.key);
    const token = readTrimmedString(record.token);

    if (type === "api") {
        return Boolean(key);
    }

    if (type === "wellknown") {
        return Boolean(key && token);
    }

    if (type === "oauth") {
        const expiresAtMs = readTimestampAsMillis(record.expires);
        return expiresAtMs !== null && expiresAtMs > nowMs;
    }

    return Boolean(key && token);
}

function hasActiveAccountRow(database: DatabaseSync, nowMs: number): boolean {
    if (
        !hasTable(database, "account_state") ||
        !hasTable(database, "account")
    ) {
        return false;
    }

    try {
        const row = database
            .prepare(
                `
                SELECT a.access_token, a.refresh_token, a.token_expiry
                FROM account_state AS state
                JOIN account AS a ON a.id = state.active_account_id
                WHERE state.active_account_id IS NOT NULL
                LIMIT 1
                `,
            )
            .get() as
            | {
                  access_token: string;
                  refresh_token: string;
                  token_expiry: number | null;
              }
            | undefined;

        return hasValidSqliteAuthTokens(
            row?.access_token ?? null,
            row?.refresh_token ?? null,
            row?.token_expiry ?? null,
            nowMs,
        );
    } catch (error) {
        debugBenignError("ai.kilo.hasActiveAccountRow", error);
        return false;
    }
}

function hasActiveControlAccountRow(
    database: DatabaseSync,
    nowMs: number,
): boolean {
    if (!hasTable(database, "control_account")) {
        return false;
    }

    try {
        const row = database
            .prepare(
                `
                SELECT access_token, refresh_token, token_expiry
                FROM control_account
                WHERE active = 1
                LIMIT 1
                `,
            )
            .get() as
            | {
                  access_token: string;
                  refresh_token: string;
                  token_expiry: number | null;
              }
            | undefined;

        return hasValidSqliteAuthTokens(
            row?.access_token ?? null,
            row?.refresh_token ?? null,
            row?.token_expiry ?? null,
            nowMs,
        );
    } catch (error) {
        debugBenignError("ai.kilo.hasActiveControlAccountRow", error);
        return false;
    }
}

function hasAnyAuthenticatedAccountRow(
    database: DatabaseSync,
    nowMs: number,
): boolean {
    if (!hasTable(database, "account")) {
        return false;
    }

    try {
        const row = database
            .prepare(
                `
                SELECT access_token, refresh_token, token_expiry
                FROM account
                ORDER BY time_updated DESC
                LIMIT 1
                `,
            )
            .get() as
            | {
                  access_token: string;
                  refresh_token: string;
                  token_expiry: number | null;
              }
            | undefined;

        return hasValidSqliteAuthTokens(
            row?.access_token ?? null,
            row?.refresh_token ?? null,
            row?.token_expiry ?? null,
            nowMs,
        );
    } catch (error) {
        debugBenignError("ai.kilo.hasAnyAuthenticatedAccountRow", error);
        return false;
    }
}

function hasValidSqliteAuthTokens(
    accessToken: string | null,
    refreshToken: string | null,
    tokenExpiry: number | null,
    nowMs: number,
): boolean {
    if (!readTrimmedString(accessToken) || !readTrimmedString(refreshToken)) {
        return false;
    }

    const expiresAtMs = normalizeTimestampToMillis(tokenExpiry);
    return expiresAtMs === null || expiresAtMs > nowMs;
}

function hasTable(database: DatabaseSync, tableName: string): boolean {
    try {
        const row = database
            .prepare(
                `
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = ?
                LIMIT 1
                `,
            )
            .get(tableName) as { name: string } | undefined;

        return Boolean(row?.name);
    } catch (error) {
        debugBenignError("ai.kilo.hasTable", error);
        return false;
    }
}

function readTrimmedString(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function readTimestampAsMillis(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }

    return normalizeTimestampToMillis(value);
}

function normalizeTimestampToMillis(value: number | null): number | null {
    if (!value || !Number.isFinite(value) || value <= 0) {
        return null;
    }

    return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function getKiloAuthStorePath(): string | null {
    const baseDir = getKiloDataDir();
    return baseDir ? path.join(baseDir, "kilo", "auth.json") : null;
}

function getKiloSqliteStorePath(): string | null {
    const baseDir = getKiloDataDir();
    return baseDir ? path.join(baseDir, "kilo", "kilo.db") : null;
}

function getKiloDataDir(): string | null {
    const xdgDataHome = process.env.XDG_DATA_HOME?.trim() ?? "";
    if (xdgDataHome) {
        return xdgDataHome;
    }

    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA?.trim() ?? "";
        if (localAppData) {
            return localAppData;
        }
    }

    const homeDir =
        process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || "";
    if (!homeDir) {
        return null;
    }

    return path.join(homeDir, ".local", "share");
}

function getFileModifiedAtMs(filePath: string): number | null {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch (error) {
        debugBenignError("ai.kilo.getFileModifiedAtMs", error);
        return null;
    }
}

function resolveFromPath(command: string): string | null {
    const pathEntries = (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean);
    const pathextEntries =
        process.platform === "win32"
            ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
                  .split(";")
                  .filter(Boolean)
            : [""];

    for (const entry of pathEntries) {
        for (const ext of pathextEntries) {
            const candidate = path.join(
                entry,
                process.platform === "win32" &&
                    !command.toLowerCase().endsWith(ext.toLowerCase())
                    ? `${command}${ext}`
                    : command,
            );
            if (isExecutableFile(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function resolveFromMacOsFallbackDirs(command: string): string | null {
    if (process.platform !== "darwin") {
        return null;
    }

    for (const entry of KILO_MACOS_FALLBACK_DIRS) {
        const candidate = path.join(entry, command);
        if (isExecutableFile(candidate)) {
            return candidate;
        }
    }

    return null;
}

function isExecutableFile(candidatePath: string): boolean {
    try {
        fs.accessSync(candidatePath, fs.constants.X_OK);
        return fs.statSync(candidatePath).isFile();
    } catch (error) {
        debugBenignError("ai.kilo.isExecutableFile", error);
        return false;
    }
}

function isFile(candidatePath: string): boolean {
    try {
        return fs.statSync(candidatePath).isFile();
    } catch (error) {
        debugBenignError("ai.kilo.isFile", error);
        return false;
    }
}
