import fs from "node:fs";
import path from "node:path";

const WINDOWS_PE_MACHINE_BY_ARCH = Object.freeze({
    arm64: 0xaa64,
    x64: 0x8664,
});

const WINDOWS_ARCH_BY_PE_MACHINE = Object.freeze(
    Object.fromEntries(
        Object.entries(WINDOWS_PE_MACHINE_BY_ARCH).map(([arch, machine]) => [
            machine,
            arch,
        ]),
    ),
);

export function resolvePackagedWindowsNativeModuleFiles({
    targetArch,
    unpackedAppDir,
}) {
    const nodePtyArch = targetArch === "arm64" ? "arm64" : "x64";
    const unpackedNodeModulesRoot = path.join(
        unpackedAppDir,
        "resources",
        "app.asar.unpacked",
        "node_modules",
    );
    const nodePtyRoot = path.join(
        unpackedNodeModulesRoot,
        "node-pty",
        "prebuilds",
        `win32-${nodePtyArch}`,
    );
    const betterSqlite3Root = path.join(
        unpackedNodeModulesRoot,
        "better-sqlite3",
        "build",
        "Release",
    );

    return {
        betterSqlite3: [
            {
                architecture: targetArch,
                kind: "native",
                path: path.join(betterSqlite3Root, "better_sqlite3.node"),
            },
        ],
        nodePty: [
            {
                architecture: targetArch,
                kind: "native",
                path: path.join(nodePtyRoot, "conpty.node"),
            },
            {
                architecture: targetArch,
                kind: "native",
                path: path.join(nodePtyRoot, "pty.node"),
            },
            {
                architecture: targetArch,
                kind: "native",
                path: path.join(nodePtyRoot, "conpty_console_list.node"),
            },
            {
                architecture: targetArch,
                kind: "support",
                path: path.join(nodePtyRoot, "conpty", "conpty.dll"),
            },
            {
                architecture: targetArch,
                kind: "support",
                path: path.join(nodePtyRoot, "conpty", "OpenConsole.exe"),
            },
            {
                architecture: targetArch,
                kind: "support",
                path: path.join(nodePtyRoot, "winpty-agent.exe"),
            },
            {
                architecture: targetArch,
                kind: "support",
                path: path.join(nodePtyRoot, "winpty.dll"),
            },
        ],
    };
}

export function verifyPackagedWindowsNativeModules({
    isFile = defaultIsFile,
    readFile = defaultReadFile,
    relativePath = defaultRelativePath,
    targetArch,
    unpackedAppDir,
}) {
    const files = resolvePackagedWindowsNativeModuleFiles({
        targetArch,
        unpackedAppDir,
    });
    const requiredFiles = [...files.nodePty, ...files.betterSqlite3];

    for (const file of requiredFiles) {
        if (!isFile(file.path)) {
            throw new Error(
                `The packaged Windows native module payload is incomplete: ${relativePath(file.path)} is missing.`,
            );
        }

        if (file.kind === "native") {
            verifyWindowsPeArchitecture({
                expectedArch: file.architecture,
                filePath: file.path,
                readFile,
                relativePath,
            });
        }
    }

    return files;
}

export function readWindowsPeArchitecture(buffer) {
    if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") {
        return null;
    }

    const peHeaderOffset = buffer.readUInt32LE(0x3c);
    if (
        peHeaderOffset + 6 > buffer.length ||
        buffer.toString("ascii", peHeaderOffset, peHeaderOffset + 4) !== "PE\u0000\u0000"
    ) {
        return null;
    }

    const machine = buffer.readUInt16LE(peHeaderOffset + 4);
    return WINDOWS_ARCH_BY_PE_MACHINE[machine] ?? null;
}

function verifyWindowsPeArchitecture({
    expectedArch,
    filePath,
    readFile,
    relativePath,
}) {
    const expectedMachine = WINDOWS_PE_MACHINE_BY_ARCH[expectedArch];
    if (!expectedMachine) {
        throw new Error(`Unsupported Windows native module architecture: ${expectedArch}.`);
    }

    const actualArch = readWindowsPeArchitecture(readFile(filePath));
    if (actualArch !== expectedArch) {
        throw new Error(
            `The packaged Windows native module has the wrong architecture: ${relativePath(filePath)} expected ${expectedArch}, got ${actualArch ?? "unknown"}.`,
        );
    }
}

function defaultIsFile(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function defaultReadFile(filePath) {
    return fs.readFileSync(filePath);
}

function defaultRelativePath(filePath) {
    return filePath;
}
