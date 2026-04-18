import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";

import type {
    AiAuthMethod,
    AiRuntimeStatus,
    KiloAuthMethodId,
    KiloRuntimeSettings,
} from "@shared/ipc";

const KILO_PROGRAM_NAME = "kilo";
const KILO_ACP_SUBCOMMAND = "acp";
const KILO_AUTH_LOGIN_SUBCOMMAND = ["auth", "login"] as const;
const KILO_ENV_BIN = "COMANDO_KILO_ACP_BIN";
const KILO_LOGIN_METHOD_ID: KiloAuthMethodId = "kilo-login";
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

export function getKiloRuntimeStatus(
    settings: KiloRuntimeSettings,
): AiRuntimeStatus {
    const resolved = resolveKiloBinary(settings);
    const authMethods = getKiloAuthMethods();
    const authMethod = detectKiloAuthMethod(settings);
    const binaryReady = resolved.state === "ready" && Boolean(resolved.program);
    const authReady = authMethod !== null;

    let message = resolved.message;
    if (binaryReady && !authReady) {
        message = "Sign in with Kilo to finish setup.";
    }

    return {
        authMethod,
        authMethods,
        authReady,
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
): ResolvedKiloRuntimeCommand {
    const resolved = resolveKiloBinary(settings);
    const status = getKiloRuntimeStatus(settings);

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
): KiloAuthMethodId | null {
    const status = getKiloAuthStoreStatus();
    if (!status?.hasActiveAuth) {
        return null;
    }

    if (
        settings.authInvalidatedAtMs !== null &&
        status.modifiedAtMs !== null &&
        status.modifiedAtMs <= settings.authInvalidatedAtMs
    ) {
        return null;
    }

    return KILO_LOGIN_METHOD_ID;
}

export function getKiloAuthMethods(): readonly AiAuthMethod[] {
    return [
        {
            description:
                "Open Kilo CLI in a system terminal and complete sign-in there.",
            id: KILO_LOGIN_METHOD_ID,
            name: "Kilo login",
        },
    ];
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

    if (process.platform === "win32") {
        const scriptPath = buildWindowsLoginScript(commandParts, cwd);
        return spawnDetached("cmd", [
            "/C",
            "start",
            "",
            "cmd",
            "/K",
            scriptPath,
        ]);
    }

    if (process.platform === "darwin") {
        const scriptPath = buildPosixLoginScript(commandParts, cwd);
        return spawnDetached("open", ["-a", "Terminal", scriptPath]);
    }

    const scriptPath = buildPosixLoginScript(commandParts, cwd);
    const candidates: Array<readonly [string, readonly string[]]> = [
        ["x-terminal-emulator", ["-e", scriptPath]],
        ["gnome-terminal", ["--", "bash", scriptPath]],
        ["konsole", ["-e", "bash", scriptPath]],
        ["xterm", ["-e", "bash", scriptPath]],
    ];

    for (const [program, args] of candidates) {
        const resolvedProgram = resolveFromPath(program);
        if (!resolvedProgram) {
            continue;
        }

        return spawnDetached(resolvedProgram, args);
    }

    return Promise.reject(
        new Error("No compatible terminal launcher was found for Kilo login."),
    );
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
        return false;
    }
}

function isFile(candidatePath: string): boolean {
    try {
        return fs.statSync(candidatePath).isFile();
    } catch {
        return false;
    }
}

function buildWindowsLoginScript(
    commandParts: readonly string[],
    cwd?: string | null,
): string {
    const scriptPath = path.join(
        os.tmpdir(),
        `comando-kilo-login-${Date.now()}.cmd`,
    );
    const lines = [
        "@echo off",
        ...(cwd ? [`cd /d "${cwd}"`] : []),
        commandParts.map(quoteWindowsArg).join(" "),
        "pause",
    ];
    fs.writeFileSync(scriptPath, lines.join("\r\n"), "utf8");
    return scriptPath;
}

function buildPosixLoginScript(
    commandParts: readonly string[],
    cwd?: string | null,
): string {
    const scriptPath = path.join(
        os.tmpdir(),
        `comando-kilo-login-${Date.now()}.sh`,
    );
    const lines = [
        "#!/bin/sh",
        ...(cwd ? [`cd ${quoteShellArg(cwd)}`] : []),
        commandParts.map(quoteShellArg).join(" "),
        'printf "\\nPress Enter to close... "',
        "read _ignored",
    ];
    fs.writeFileSync(scriptPath, lines.join("\n"), "utf8");
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
}

function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsArg(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
}

function spawnDetached(
    program: string,
    args: readonly string[],
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(program, [...args], {
            detached: true,
            stdio: "ignore",
        });

        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}
