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

interface ManagedTerminalSession {
    readonly ptyProcess: pty.IPty;
    readonly session: TerminalSession;
}

interface TerminalServiceOptions {
    readonly onData: (event: TerminalDataEvent) => void;
    readonly onExit: (event: TerminalExitEvent) => void;
    readonly projectService: ProjectService;
}

export class TerminalService {
    readonly #onData: (event: TerminalDataEvent) => void;
    readonly #onExit: (event: TerminalExitEvent) => void;
    readonly #projectService: ProjectService;
    readonly #sessions = new Map<string, ManagedTerminalSession>();

    constructor(options: TerminalServiceOptions) {
        this.#onData = options.onData;
        this.#onExit = options.onExit;
        this.#projectService = options.projectService;
    }

    createSession(input: CreateTerminalSessionInput): TerminalSession {
        const sessionId = input.preferredSessionId ?? randomUUID();
        const existingSession = this.#sessions.get(sessionId);
        if (existingSession) {
            return existingSession.session;
        }

        const cwd = input.projectId
            ? this.#projectService.getProjectRootPath(input.projectId)
            : process.cwd();
        const shell = getDefaultShell();
        const shellArgs = getDefaultShellArgs(shell);
        const ptyProcess = pty.spawn(shell, shellArgs, {
            cols: 120,
            cwd,
            env: {
                ...process.env,
                COLORTERM: "truecolor",
                TERM: process.env.TERM ?? "xterm-256color",
            },
            name: "xterm-color",
            rows: 34,
        });
        const session: TerminalSession = {
            cwd,
            projectId: input.projectId,
            sessionId,
        };

        const managedSession: ManagedTerminalSession = {
            ptyProcess,
            session,
        };

        ptyProcess.onData((data) => {
            this.#onData({
                data,
                sessionId,
            });
        });
        ptyProcess.onExit((event) => {
            this.#sessions.delete(sessionId);
            this.#onExit({
                exitCode: event.exitCode,
                sessionId,
                signalCode: event.signal ?? null,
            });
        });

        this.#sessions.set(sessionId, managedSession);
        return session;
    }

    writeInput(sessionId: string, data: string): void {
        this.#sessions.get(sessionId)?.ptyProcess.write(data);
    }

    resizeSession(sessionId: string, cols: number, rows: number): void {
        const session = this.#sessions.get(sessionId);
        if (!session) {
            return;
        }

        session.ptyProcess.resize(Math.max(10, cols), Math.max(4, rows));
    }

    closeSession(sessionId: string): void {
        const session = this.#sessions.get(sessionId);
        if (!session) {
            return;
        }

        session.ptyProcess.kill();
        this.#sessions.delete(sessionId);
    }

    close(): void {
        for (const sessionId of this.#sessions.keys()) {
            this.closeSession(sessionId);
        }
    }
}

function getDefaultShell(): string {
    if (process.platform === "win32") {
        return process.env.COMSPEC ?? "powershell.exe";
    }

    return (
        process.env.SHELL ?? (process.platform === "darwin" ? "zsh" : "bash")
    );
}

function getDefaultShellArgs(shell: string): string[] {
    if (process.platform === "win32") {
        return shell.toLowerCase().includes("powershell") ? ["-NoLogo"] : [];
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
