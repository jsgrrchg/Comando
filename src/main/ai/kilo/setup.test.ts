import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    detectKiloAuthMethod,
    getKiloRuntimeStatus,
    isKiloAuthenticationError,
    resolveKiloRuntime,
} from "./setup";

const originalKiloEnv = process.env.COMANDO_KILO_ACP_BIN;
const originalHome = process.env.HOME;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalPath = process.env.PATH;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    delete process.env.COMANDO_KILO_ACP_BIN;
    delete process.env.XDG_DATA_HOME;
});

afterEach(() => {
    process.env.PATH = originalPath;

    if (typeof originalKiloEnv === "string") {
        process.env.COMANDO_KILO_ACP_BIN = originalKiloEnv;
    } else {
        delete process.env.COMANDO_KILO_ACP_BIN;
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

    if (typeof originalLocalAppData === "string") {
        process.env.LOCALAPPDATA = originalLocalAppData;
    } else {
        delete process.env.LOCALAPPDATA;
    }

    if (typeof originalXdgDataHome === "string") {
        process.env.XDG_DATA_HOME = originalXdgDataHome;
    } else {
        delete process.env.XDG_DATA_HOME;
    }
});

describe("Kilo setup", () => {
    it("resolves Kilo from COMANDO_KILO_ACP_BIN with acp", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-kilo-env-"),
        );

        try {
            const binaryPath = path.join(tempDir, "custom-kilo");
            fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(binaryPath, 0o755);
            process.env.COMANDO_KILO_ACP_BIN = binaryPath;
            process.env.PATH = "";

            const resolved = resolveKiloRuntime(createEmptyKiloSettings());

            expect(resolved.program).toBe(binaryPath);
            expect(resolved.args).toEqual(["acp"]);
            expect(resolved.command).toBe(`${binaryPath} acp`);
            expect(resolved.status.source).toBe("env");
            expect(resolved.status.state).toBe("ready");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("resolves Kilo from configured path and falls back to PATH", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-kilo-path-"),
        );

        try {
            const binaryPath = path.join(tempDir, "kilo");
            fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(binaryPath, 0o755);
            process.env.PATH = tempDir;

            const fromSettings = resolveKiloRuntime({
                ...createEmptyKiloSettings(),
                binaryPath,
            });
            const fromPath = resolveKiloRuntime(createEmptyKiloSettings());

            expect(fromSettings.program).toBe(binaryPath);
            expect(fromSettings.status.source).toBe("settings");
            expect(fromPath.program).toBe(binaryPath);
            expect(fromPath.status.source).toBe("path");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("detects auth from auth.json using HOME/.local/share fallback", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-kilo-auth-json-"),
        );

        try {
            const binaryPath = path.join(tempDir, "kilo");
            const authDir = path.join(tempDir, ".local", "share", "kilo");
            const authPath = path.join(authDir, "auth.json");

            fs.mkdirSync(authDir, { recursive: true });
            fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(binaryPath, 0o755);
            fs.writeFileSync(
                authPath,
                JSON.stringify({
                    kilo: {
                        access: "access-token",
                        expires: Date.now() + 60_000,
                        refresh: "refresh-token",
                        type: "oauth",
                    },
                }),
                "utf8",
            );

            process.env.HOME = tempDir;
            delete process.env.USERPROFILE;
            delete process.env.XDG_DATA_HOME;
            process.env.COMANDO_KILO_ACP_BIN = binaryPath;
            process.env.PATH = "";

            const status = getKiloRuntimeStatus(createEmptyKiloSettings());

            expect(detectKiloAuthMethod(createEmptyKiloSettings())).toBe(
                "kilo-login",
            );
            expect(status.authMethod).toBe("kilo-login");
            expect(status.authReady).toBe(true);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("detects auth from kilo.db and respects authInvalidatedAtMs", () => {
        const status = JSON.parse(
            execFileSync(
                "node",
                [
                    "--experimental-strip-types",
                    "--input-type=module",
                    "-e",
                    `
                        import fs from "node:fs";
                        import os from "node:os";
                        import path from "node:path";
                        import { execFileSync } from "node:child_process";
                        import { readKiloSqliteAuthStoreStatus } from ${JSON.stringify(pathToFileURL(path.resolve("src/main/ai/kilo/setup.ts")).href)};

                        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-kilo-auth-db-child-"));
                        const dataDir = path.join(tempDir, "xdg");
                        const kiloDir = path.join(dataDir, "kilo");
                        const databasePath = path.join(kiloDir, "kilo.db");
                        const now = Date.now();

                        fs.mkdirSync(kiloDir, { recursive: true });
                        execFileSync("sqlite3", [databasePath], {
                            input: \`
                                CREATE TABLE account (
                                    id TEXT PRIMARY KEY,
                                    email TEXT NOT NULL,
                                    url TEXT NOT NULL,
                                    access_token TEXT NOT NULL,
                                    refresh_token TEXT NOT NULL,
                                    token_expiry INTEGER,
                                    time_created INTEGER NOT NULL,
                                    time_updated INTEGER NOT NULL
                                );
                                CREATE TABLE account_state (
                                    id INTEGER PRIMARY KEY NOT NULL,
                                    active_account_id TEXT,
                                    active_org_id TEXT
                                );
                                INSERT INTO account (
                                    id,
                                    email,
                                    url,
                                    access_token,
                                    refresh_token,
                                    token_expiry,
                                    time_created,
                                    time_updated
                                ) VALUES (
                                    'acc-1',
                                    'user@example.com',
                                    'https://kilo.example',
                                    'access-token',
                                    'refresh-token',
                                    \${now + 60_000},
                                    \${now},
                                    \${now}
                                );
                                INSERT INTO account_state (id, active_account_id, active_org_id)
                                VALUES (1, 'acc-1', NULL);
                            \`,
                        });

                        const status = readKiloSqliteAuthStoreStatus(databasePath);
                        process.stdout.write(JSON.stringify(status));
                    `,
                ],
                {
                    encoding: "utf8",
                    env: process.env,
                },
            ),
        ) as {
            hasActiveAuth: boolean;
            modifiedAtMs: number | null;
        } | null;

        expect(status?.hasActiveAuth).toBe(true);
        expect(status?.modifiedAtMs).not.toBeNull();
    });

    it("shows auth required when binary exists but no active session is present", () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-kilo-status-"),
        );

        try {
            const binaryPath = path.join(tempDir, "kilo");
            fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
            fs.chmodSync(binaryPath, 0o755);
            process.env.COMANDO_KILO_ACP_BIN = binaryPath;
            process.env.PATH = "";
            process.env.XDG_DATA_HOME = path.join(tempDir, "empty-xdg");

            const status = getKiloRuntimeStatus(createEmptyKiloSettings());

            expect(status.state).toBe("ready");
            expect(status.authReady).toBe(false);
            expect(status.message).toBe("Sign in with Kilo to finish setup.");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("recognizes Kilo authentication errors that should invalidate setup", () => {
        expect(
            isKiloAuthenticationError(
                "You were signed out. Reconnect Kilo to continue.",
            ),
        ).toBe(true);
        expect(
            isKiloAuthenticationError(
                "Run `kilo auth login` before continuing",
            ),
        ).toBe(true);
        expect(isKiloAuthenticationError("Some unrelated error")).toBe(false);
    });
});

function createEmptyKiloSettings() {
    return {
        authInvalidatedAtMs: null,
        binaryPath: null,
    } as const;
}
