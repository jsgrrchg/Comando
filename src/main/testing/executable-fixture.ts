import fs from "node:fs";
import path from "node:path";

export function getTestExecutableName(name: string): string {
    if (process.platform !== "win32" || path.extname(name)) {
        return name;
    }

    return `${name}.CMD`;
}

export function writeTestExecutable(
    directory: string,
    name: string,
    content = getDefaultExecutableContent(),
): string {
    const executablePath = path.join(directory, getTestExecutableName(name));

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(executablePath, content, {
        encoding: "utf8",
        mode: 0o755,
    });
    fs.chmodSync(executablePath, 0o755);

    return executablePath;
}

function getDefaultExecutableContent(): string {
    return process.platform === "win32"
        ? "@echo off\r\nexit /b 0\r\n"
        : "#!/bin/sh\nexit 0\n";
}
