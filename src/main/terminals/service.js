import path from "node:path";
import { randomUUID } from "node:crypto";
import pty from "node-pty";
export class TerminalService {
    #onData;
    #onExit;
    #projectService;
    #sessions = new Map();
    constructor(options) {
        this.#onData = options.onData;
        this.#onExit = options.onExit;
        this.#projectService = options.projectService;
    }
    createSession(input) {
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
        const session = {
            cwd,
            projectId: input.projectId,
            sessionId,
        };
        const managedSession = {
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
    writeInput(sessionId, data) {
        this.#sessions.get(sessionId)?.ptyProcess.write(data);
    }
    resizeSession(sessionId, cols, rows) {
        const session = this.#sessions.get(sessionId);
        if (!session) {
            return;
        }
        session.ptyProcess.resize(Math.max(10, cols), Math.max(4, rows));
    }
    closeSession(sessionId) {
        const session = this.#sessions.get(sessionId);
        if (!session) {
            return;
        }
        session.ptyProcess.kill();
        this.#sessions.delete(sessionId);
    }
    close() {
        for (const sessionId of this.#sessions.keys()) {
            this.closeSession(sessionId);
        }
    }
}
function getDefaultShell() {
    if (process.platform === "win32") {
        return process.env.COMSPEC ?? "powershell.exe";
    }
    return (process.env.SHELL ?? (process.platform === "darwin" ? "zsh" : "bash"));
}
function getDefaultShellArgs(shell) {
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
