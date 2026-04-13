import fs from "node:fs";
import path from "node:path";

import type { AiRuntimeStatus, CodexRuntimeSettings } from "@shared/ipc";

export interface RuntimeCommandSpec {
    readonly args: readonly string[];
    readonly command: string;
    readonly executable: string;
}

export interface ResolvedRuntimeCommand {
    readonly args: readonly string[];
    readonly command: string;
    readonly executable: string;
    readonly status: AiRuntimeStatus;
}

export function resolveCodexRuntime(
    settings: CodexRuntimeSettings,
): ResolvedRuntimeCommand {
    const configuredPath = settings.binaryPath?.trim() ?? "";
    const envPath = process.env.COMANDO_CODEX_ACP_BIN?.trim() ?? "";

    if (configuredPath) {
        return resolveCandidate(configuredPath, "settings");
    }

    if (envPath) {
        return resolveCandidate(envPath, "env");
    }

    const legacyPathResolved = resolveFromPath("codex-acp");
    if (legacyPathResolved) {
        return createResolvedCommand(legacyPathResolved, "path");
    }

    const codexPathResolved = resolveFromPath("codex");
    if (codexPathResolved) {
        return createIncompatibleResolvedCommand(codexPathResolved, "path");
    }

    return {
        args: [],
        command: "codex-acp",
        executable: "codex-acp",
        status: {
            checkedAt: new Date().toISOString(),
            command: null,
            message:
                "No se encontró un runtime ACP compatible. Esta integración necesita `codex-acp` o un binario equivalente que implemente ACP.",
            runtimeId: "codex",
            source: null,
            state: "missing",
        },
    };
}

function resolveCandidate(
    candidate: string,
    source: AiRuntimeStatus["source"],
): ResolvedRuntimeCommand {
    if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
        const absolutePath = path.resolve(candidate);
        if (!isExecutableFile(absolutePath)) {
            return {
                args: [],
                command: absolutePath,
                executable: absolutePath,
                status: {
                    checkedAt: new Date().toISOString(),
                    command: absolutePath,
                    message: `No se pudo ejecutar el binario configurado: ${absolutePath}`,
                    runtimeId: "codex",
                    source,
                    state: "error",
                },
            };
        }

        return isAcpCompatibleExecutable(absolutePath)
            ? createResolvedCommand(absolutePath, source)
            : createIncompatibleResolvedCommand(absolutePath, source);
    }

    const pathResolved = resolveFromPath(candidate);
    if (!pathResolved) {
        return {
            args: [],
            command: candidate,
            executable: candidate,
            status: {
                checkedAt: new Date().toISOString(),
                command: candidate,
                message: `No se encontró el comando configurado: ${candidate}`,
                runtimeId: "codex",
                source,
                state: "missing",
            },
        };
    }

    return isAcpCompatibleExecutable(pathResolved)
        ? createResolvedCommand(pathResolved, source)
        : createIncompatibleResolvedCommand(pathResolved, source);
}

function createReadyStatus(
    command: string,
    source: AiRuntimeStatus["source"],
): AiRuntimeStatus {
    return {
        checkedAt: new Date().toISOString(),
        command,
        message: null,
        runtimeId: "codex",
        source,
        state: "ready",
    };
}

function createResolvedCommand(
    executable: string,
    source: AiRuntimeStatus["source"],
): ResolvedRuntimeCommand {
    const spec = buildRuntimeCommandSpec(executable);

    return {
        args: spec.args,
        command: spec.command,
        executable: spec.executable,
        status: createReadyStatus(spec.command, source),
    };
}

function createIncompatibleResolvedCommand(
    executable: string,
    source: AiRuntimeStatus["source"],
): ResolvedRuntimeCommand {
    return {
        args: [],
        command: executable,
        executable,
        status: {
            checkedAt: new Date().toISOString(),
            command: executable,
            message:
                "Se encontró `codex`, pero este CLI expone App Server/MCP y no un runtime ACP. La integración actual de Comando todavía usa ACP.",
            runtimeId: "codex",
            source,
            state: "error",
        },
    };
}

function buildRuntimeCommandSpec(executable: string): RuntimeCommandSpec {
    return {
        args: [],
        command: executable,
        executable,
    };
}

function isAcpCompatibleExecutable(executable: string): boolean {
    const executableName = path.basename(executable).toLowerCase();
    return executableName !== "codex" && executableName !== "codex.exe";
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

function isExecutableFile(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}
