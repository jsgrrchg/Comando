import path from "node:path";
import { randomUUID } from "node:crypto";

import pty from "node-pty";

import type {
    CreateTerminalSessionInput,
    TerminalDataEvent,
    TerminalExitEvent,
    TerminalSession,
} from "@shared/ipc";

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";

interface ManagedTerminalSession {
    readonly ownerWindowId: string;
    readonly ptyProcess: pty.IPty;
    session: TerminalSession;
    readonly terminalId: string | null;
}

interface TerminalServiceOptions {
    readonly onData: (ownerWindowId: string, event: TerminalDataEvent) => void;
    readonly onExit: (ownerWindowId: string, event: TerminalExitEvent) => void;
    readonly projectService: ProjectService;
    readonly settingsService: SettingsGateway;
}

export class TerminalService {
    readonly #onData: (ownerWindowId: string, event: TerminalDataEvent) => void;
    readonly #onExit: (ownerWindowId: string, event: TerminalExitEvent) => void;
    readonly #projectService: ProjectService;
    readonly #settingsService: SettingsGateway;
    readonly #sessions = new Map<string, ManagedTerminalSession>();
    readonly #sessionIdsByOwnerTerminalId = new Map<string, string>();

    constructor(options: TerminalServiceOptions) {
        this.#onData = options.onData;
        this.#onExit = options.onExit;
        this.#projectService = options.projectService;
        this.#settingsService = options.settingsService;
    }

    createSession(
        input: CreateTerminalSessionInput,
        ownerWindowId: string,
    ): TerminalSession {
        const terminalOwnerKey = input.terminalId
            ? createTerminalOwnerKey(ownerWindowId, input.terminalId)
            : null;
        const existingSessionId = terminalOwnerKey
            ? this.#sessionIdsByOwnerTerminalId.get(terminalOwnerKey)
            : null;
        const existingSession = existingSessionId
            ? this.#sessions.get(existingSessionId)
            : null;
        if (existingSession) {
            return existingSession.session;
        }
        if (terminalOwnerKey && existingSessionId) {
            this.#sessionIdsByOwnerTerminalId.delete(terminalOwnerKey);
        }

        let sessionId = input.preferredSessionId ?? randomUUID();
        const preferredSession = this.#sessions.get(sessionId);
        if (preferredSession?.ownerWindowId === ownerWindowId) {
            return preferredSession.session;
        }
        while (this.#sessions.has(sessionId)) {
            sessionId = randomUUID();
        }

        const cwd = input.projectId
            ? this.#projectService.getProjectRootPath(
                  input.projectId,
                  input.worktreeId ?? null,
              )
            : process.cwd();
        const shell = getDefaultShell(
            this.#settingsService.loadAppTerminalSettings().windowsShell,
        );
        const shellArgs = getDefaultShellArgs(shell);
        const cols = normalizeTerminalCols(input.cols);
        const rows = normalizeTerminalRows(input.rows);
        const ptyProcess = pty.spawn(shell, shellArgs, {
            cols,
            cwd,
            env: {
                ...process.env,
                COLUMNS: String(cols),
                COLORTERM: "truecolor",
                LINES: String(rows),
                TERM: "xterm-256color",
                ...input.extraEnv,
            },
            name: "xterm-color",
            rows,
        });
        const session: TerminalSession = {
            cols,
            cwd,
            projectId: input.projectId,
            rows,
            sessionId,
            status: "running",
            worktreeId: input.worktreeId ?? null,
        };

        const managedSession: ManagedTerminalSession = {
            ownerWindowId,
            ptyProcess,
            session,
            terminalId: input.terminalId ?? null,
        };

        ptyProcess.onData((data) => {
            this.#onData(ownerWindowId, {
                data,
                sessionId,
            });
        });
        ptyProcess.onExit((event) => {
            this.#sessions.delete(sessionId);
            if (terminalOwnerKey) {
                const trackedSessionId =
                    this.#sessionIdsByOwnerTerminalId.get(terminalOwnerKey);
                if (trackedSessionId === sessionId) {
                    this.#sessionIdsByOwnerTerminalId.delete(terminalOwnerKey);
                }
            }
            this.#onExit(ownerWindowId, {
                exitCode: event.exitCode,
                sessionId,
                signalCode: event.signal ?? null,
            });
        });

        this.#sessions.set(sessionId, managedSession);
        if (terminalOwnerKey) {
            this.#sessionIdsByOwnerTerminalId.set(terminalOwnerKey, sessionId);
        }
        return session;
    }

    writeInput(ownerWindowId: string, sessionId: string, data: string): void {
        this.#getOwnedSession(ownerWindowId, sessionId)?.ptyProcess.write(data);
    }

    resizeSession(
        ownerWindowId: string,
        sessionId: string,
        cols: number,
        rows: number,
    ): void {
        const session = this.#getOwnedSession(ownerWindowId, sessionId);
        if (!session) {
            return;
        }

        const nextCols = normalizeTerminalCols(cols);
        const nextRows = normalizeTerminalRows(rows);
        if (
            session.session.cols === nextCols &&
            session.session.rows === nextRows
        ) {
            return;
        }

        session.ptyProcess.resize(nextCols, nextRows);
        session.session = {
            ...session.session,
            cols: nextCols,
            rows: nextRows,
        };
    }

    closeSession(sessionId: string): void {
        const session = this.#sessions.get(sessionId);
        if (!session) {
            return;
        }

        session.ptyProcess.kill();
        this.#sessions.delete(sessionId);
        if (session.terminalId) {
            const terminalOwnerKey = createTerminalOwnerKey(
                session.ownerWindowId,
                session.terminalId,
            );
            const trackedSessionId =
                this.#sessionIdsByOwnerTerminalId.get(terminalOwnerKey);
            if (trackedSessionId === sessionId) {
                this.#sessionIdsByOwnerTerminalId.delete(terminalOwnerKey);
            }
        }
    }

    closeSessionOrOwnedTerminal(ownerWindowId: string, id: string): void {
        const session = this.#sessions.get(id);
        if (session) {
            if (session.ownerWindowId === ownerWindowId) {
                this.closeSession(id);
            }
            return;
        }

        const terminalOwnerKey = createTerminalOwnerKey(ownerWindowId, id);
        const sessionId =
            this.#sessionIdsByOwnerTerminalId.get(terminalOwnerKey);
        if (sessionId) {
            this.closeSession(sessionId);
        }
    }

    #getOwnedSession(
        ownerWindowId: string,
        sessionId: string,
    ): ManagedTerminalSession | null {
        const session = this.#sessions.get(sessionId);
        if (!session || session.ownerWindowId !== ownerWindowId) {
            return null;
        }

        return session;
    }

    close(): void {
        for (const sessionId of this.#sessions.keys()) {
            this.closeSession(sessionId);
        }
    }

    closeOwnedByWindow(ownerWindowId: string): void {
        const ownedSessionIds = [...this.#sessions.entries()]
            .filter(([, session]) => session.ownerWindowId === ownerWindowId)
            .map(([sessionId]) => sessionId);

        for (const sessionId of ownedSessionIds) {
            this.closeSession(sessionId);
        }
    }
}

function createTerminalOwnerKey(ownerWindowId: string, terminalId: string) {
    return `${ownerWindowId}:${terminalId}`;
}

function normalizeTerminalCols(cols: number | null | undefined): number {
    const normalized = Math.floor(cols ?? 120);
    return Number.isFinite(normalized) ? Math.max(10, normalized) : 120;
}

function normalizeTerminalRows(rows: number | null | undefined): number {
    const normalized = Math.floor(rows ?? 34);
    return Number.isFinite(normalized) ? Math.max(4, normalized) : 34;
}

function getDefaultShell(windowsShell: string): string {
    if (process.platform === "win32") {
        switch (windowsShell) {
            case "cmd":
                return "cmd.exe";
            case "powershell":
                return "powershell.exe";
            case "pwsh":
                return "pwsh.exe";
            case "default":
            default:
                return process.env.COMSPEC ?? "powershell.exe";
        }
    }

    return (
        process.env.SHELL ?? (process.platform === "darwin" ? "zsh" : "bash")
    );
}

function getDefaultShellArgs(shell: string): string[] {
    if (process.platform === "win32") {
        const normalizedShell = shell.toLowerCase();
        return normalizedShell.includes("powershell") ||
            path.basename(normalizedShell) === "pwsh.exe"
            ? ["-NoLogo"]
            : [];
    }

    const shellBaseName = path.basename(shell).toLowerCase();
    if (shellBaseName === "zsh" || shellBaseName === "bash") {
        return ["-l"];
    }

    if (shellBaseName === "fish") {
        return [];
    }

    return ["-l"];
}
