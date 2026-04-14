import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export interface ResolveCodexRuntimeOptions {
    readonly allowPathFallback?: boolean;
    readonly appRoot?: string;
    readonly packagedResourcesPath?: string | null;
}

export function resolveCodexRuntime(
    settings: CodexRuntimeSettings,
    options: ResolveCodexRuntimeOptions = {},
): ResolvedRuntimeCommand {
    const configuredPath = settings.binaryPath?.trim() ?? "";
    const envPath = process.env.COMANDO_CODEX_ACP_BIN?.trim() ?? "";
    const appRoot = options.appRoot ?? getAppRoot();
    const packagedResourcesPath =
        options.packagedResourcesPath ?? getPackagedResourcesPath();

    if (envPath) {
        return resolveCandidate(envPath, "env");
    }

    if (configuredPath) {
        return resolveCandidate(configuredPath, "settings");
    }

    const bundledPathResolved = findFirstExecutable(
        getBundledCandidates(appRoot, packagedResourcesPath),
    );
    if (bundledPathResolved) {
        return createResolvedCommand(bundledPathResolved, "bundled");
    }

    const vendorPathResolved = findFirstExecutable(
        getVendorCandidates(appRoot),
    );
    if (vendorPathResolved) {
        return createResolvedCommand(vendorPathResolved, "vendor");
    }

    if (options.allowPathFallback !== false) {
        const legacyPathResolved = resolveFromPath("codex-acp");
        if (legacyPathResolved) {
            return createResolvedCommand(legacyPathResolved, "path");
        }

        const codexPathResolved = resolveFromPath("codex");
        if (codexPathResolved) {
            return createIncompatibleResolvedCommand(codexPathResolved, "path");
        }
    }

    return createMissingResolvedCommand(appRoot, packagedResourcesPath);
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
                    authMethod: null,
                    authMethods: [],
                    authReady: true,
                    checkedAt: new Date().toISOString(),
                    command: absolutePath,
                    hasCustomBinaryPath: source === "settings",
                    hasGatewayConfig: false,
                    hasGatewayUrl: false,
                    message: `No se pudo ejecutar el binario configurado: ${absolutePath}`,
                    onboardingRequired: true,
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
                authMethod: null,
                authMethods: [],
                authReady: true,
                checkedAt: new Date().toISOString(),
                command: candidate,
                hasCustomBinaryPath: source === "settings",
                hasGatewayConfig: false,
                hasGatewayUrl: false,
                message: `No se encontró el comando configurado: ${candidate}`,
                onboardingRequired: true,
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
        authMethod: null,
        authMethods: [],
        authReady: true,
        checkedAt: new Date().toISOString(),
        command,
        hasCustomBinaryPath: source === "settings",
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message: null,
        onboardingRequired: false,
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
            authMethod: null,
            authMethods: [],
            authReady: true,
            checkedAt: new Date().toISOString(),
            command: executable,
            hasCustomBinaryPath: source === "settings",
            hasGatewayConfig: false,
            hasGatewayUrl: false,
            message:
                "Se encontró `codex`, pero este CLI expone App Server/MCP y no un runtime ACP. La integración actual de Comando todavía usa ACP.",
            onboardingRequired: true,
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

function createMissingResolvedCommand(
    appRoot: string,
    packagedResourcesPath: string | null,
): ResolvedRuntimeCommand {
    const bundledCandidates = getBundledCandidates(
        appRoot,
        packagedResourcesPath,
    );
    const vendorCandidates = getVendorCandidates(appRoot);
    const firstExpectedCandidate =
        bundledCandidates[0] ?? vendorCandidates[0] ?? "codex-acp";

    return {
        args: [],
        command: firstExpectedCandidate,
        executable: firstExpectedCandidate,
        status: {
            authMethod: null,
            authMethods: [],
            authReady: true,
            checkedAt: new Date().toISOString(),
            command: null,
            hasCustomBinaryPath: false,
            hasGatewayConfig: false,
            hasGatewayUrl: false,
            message:
                "No se encontró un runtime ACP compatible. Corre `pnpm run stage:ai` para compilar/stagear `codex-acp`, o configura un binario explícito.",
            onboardingRequired: true,
            runtimeId: "codex",
            source: null,
            state: "missing",
        },
    };
}

function getAppRoot(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const searchRoots = [
        path.dirname(currentFile),
        process.cwd(),
        path.resolve(path.dirname(currentFile), "../../../../"),
    ];

    for (const candidate of searchRoots) {
        const resolved = findAppRoot(candidate);
        if (resolved) {
            return resolved;
        }
    }

    return path.resolve(path.dirname(currentFile), "../../../../");
}

function getPackagedResourcesPath(): string | null {
    return typeof process.resourcesPath === "string"
        ? process.resourcesPath
        : null;
}

function getBundledCandidates(
    appRoot: string,
    packagedResourcesPath: string | null,
): readonly string[] {
    const executableName = getCodexExecutableName();
    const candidates = [
        path.join(appRoot, "resources", "ai", "binaries", executableName),
    ];

    if (packagedResourcesPath) {
        const packagedCandidate = path.join(
            packagedResourcesPath,
            "ai",
            "binaries",
            executableName,
        );

        if (!candidates.includes(packagedCandidate)) {
            candidates.push(packagedCandidate);
        }
    }

    return candidates;
}

function getVendorCandidates(appRoot: string): readonly string[] {
    const executableName = getCodexExecutableName();

    return [
        path.join(
            appRoot,
            "resources",
            "ai",
            "embedded",
            "codex-acp",
            "target",
            "release",
            executableName,
        ),
        path.join(
            appRoot,
            "resources",
            "ai",
            "embedded",
            "codex-acp",
            "target",
            "debug",
            executableName,
        ),
        path.join(
            appRoot,
            "vendor",
            "codex-acp",
            "target",
            "release",
            executableName,
        ),
        path.join(
            appRoot,
            "vendor",
            "codex-acp",
            "target",
            "debug",
            executableName,
        ),
    ];
}

function findAppRoot(startDir: string): string | null {
    let currentDir = path.resolve(startDir);

    while (true) {
        if (isAppRootDirectory(currentDir)) {
            return currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            return null;
        }

        currentDir = parentDir;
    }
}

function isAppRootDirectory(candidate: string): boolean {
    return (
        fs.existsSync(path.join(candidate, "package.json")) &&
        fs.existsSync(path.join(candidate, "resources", "ai"))
    );
}

function getCodexExecutableName(): string {
    return process.platform === "win32" ? "codex-acp.exe" : "codex-acp";
}

function findFirstExecutable(candidates: readonly string[]): string | null {
    for (const candidate of candidates) {
        if (isExecutableFile(candidate)) {
            return candidate;
        }
    }

    return null;
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
