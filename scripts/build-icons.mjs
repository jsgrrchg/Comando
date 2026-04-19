import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const iconsRoot = path.join(repoRoot, "resources", "icons");
const appPngPath = path.join(iconsRoot, "app.png");
const macIconComposerPath = path.join(iconsRoot, "macos.icon");
const macIcnsPath = path.join(iconsRoot, "macos.icns");
const windowsIcoPath = path.join(iconsRoot, "windows.ico");
const appBuilderPath = path.join(
    repoRoot,
    "node_modules",
    ".pnpm",
    "node_modules",
    "app-builder-bin",
    process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux",
    resolveAppBuilderBinaryName(),
);

main();

function main() {
    assertIconSources();

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comando-icons-"));

    try {
        buildIcon("icns", appPngPath, macIcnsPath, tempRoot);
        buildIcon("ico", appPngPath, windowsIcoPath, tempRoot);
    } finally {
        fs.rmSync(tempRoot, { force: true, recursive: true });
    }

    console.log(`[icons] Built ${path.relative(repoRoot, macIcnsPath)}`);
    console.log(`[icons] Built ${path.relative(repoRoot, windowsIcoPath)}`);
}

function assertIconSources() {
    if (!fs.existsSync(appPngPath)) {
        throw new Error(`Missing icon source: ${path.relative(repoRoot, appPngPath)}`);
    }

    if (!fs.existsSync(appBuilderPath)) {
        throw new Error(`Missing app-builder binary: ${path.relative(repoRoot, appBuilderPath)}`);
    }

    if (!fs.existsSync(path.join(macIconComposerPath, "icon.json"))) {
        throw new Error(
            `Missing Icon Composer source: ${path.relative(repoRoot, macIconComposerPath)}`,
        );
    }
}

function resolveAppBuilderBinaryName() {
    if (process.platform === "darwin") {
        return `app-builder_${process.arch === "x64" ? "amd64" : process.arch}`;
    }

    if (process.platform === "win32") {
        return "app-builder.exe";
    }

    return "app-builder";
}

function buildIcon(format, inputPath, outputPath, tempRoot) {
    const outputDir = path.join(tempRoot, format);

    fs.mkdirSync(outputDir, { recursive: true });

    run(appBuilderPath, [
        "icon",
        "--input",
        inputPath,
        "--format",
        format,
        "--out",
        outputDir,
        "--root",
        repoRoot,
    ]);

    const builtIconPath = path.join(outputDir, `icon.${format}`);

    if (!fs.existsSync(builtIconPath)) {
        throw new Error(`Expected generated ${format} at ${builtIconPath}`);
    }

    fs.copyFileSync(builtIconPath, outputPath);
}

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: "inherit",
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}
