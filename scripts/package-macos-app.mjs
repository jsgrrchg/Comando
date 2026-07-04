import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";

import {
    ensurePackagedMacUpdaterConfig,
    verifyMacReleaseArtifacts,
    verifyPackagedMacUpdaterConfig,
} from "./mac-release-metadata.mjs";
import {
    claudeVendorDir,
    copyExecutable,
    copyTree,
    ensureDir,
    isExecutableFile,
    isFile,
    relativeToRepo,
    repoRoot,
    resolveFromPath,
    resetDir,
    spawnPreparedSync,
} from "./ai/_shared.mjs";

const buildRoot = path.join(repoRoot, "build");
const packageAppRoot = path.join(buildRoot, "package-app");
const packageAppNodeModulesRoot = path.join(packageAppRoot, "node_modules");
const packageResourcesRoot = path.join(buildRoot, "package-resources");
const packageToolsRoot = path.join(buildRoot, "package-tools");
const packagedAiRoot = path.join(packageResourcesRoot, "ai");
const packagedCodexRoot = path.join(packagedAiRoot, "binaries");
const packagedClaudeRoot = path.join(
    packagedAiRoot,
    "embedded",
    "claude-agent-acp",
);
const packagedNodeRoot = path.join(packagedAiRoot, "embedded", "node");
const outDir = path.join(repoRoot, "out");
const desktopAppPath = path.join(os.homedir(), "Desktop", "Comando.app");
const macPackageRoot = path.join(buildRoot, "macos-package");
const standaloneProjectRoot = path.join(macPackageRoot, "project");
const standaloneDistDir = path.join(standaloneProjectRoot, "dist");
const standaloneResourcesRoot = path.join(standaloneProjectRoot, "resources");
const standalonePackageResourcesRoot = path.join(
    standaloneProjectRoot,
    "package-resources",
);
const standalonePackagedAppPath = path.join(
    standaloneDistDir,
    "mac-universal",
    "Comando.app",
);
const electronBuilderCli = path.join(
    repoRoot,
    "node_modules",
    "electron-builder",
    "cli.js",
);
const rootPackageJsonPath = path.join(repoRoot, "package.json");
const rootPackageJson = readJson(rootPackageJsonPath);
const productName = rootPackageJson.build?.productName ?? "Comando";
const standaloneDmgArtifactPath = path.join(
    standaloneDistDir,
    `${productName}-${rootPackageJson.version}-universal.dmg`,
);
const standaloneZipArtifactPath = path.join(
    standaloneDistDir,
    `${productName}-${rootPackageJson.version}-universal.zip`,
);
const appResourcesRoot = path.join(repoRoot, "resources", "ai");
const prebuiltRoot = path.join(appResourcesRoot, "prebuilt");
const prebuiltCodexRoot = path.join(prebuiltRoot, "codex-acp");
const prebuiltNodeRoot = path.join(prebuiltRoot, "node");
const bundledClaudeRoot = path.join(
    appResourcesRoot,
    "embedded",
    "claude-agent-acp",
);
const bundledArm64CodexBinary = path.join(
    appResourcesRoot,
    "binaries",
    "codex-acp",
);
const macEntitlementsPath = path.join(
    repoRoot,
    "resources",
    "entitlements.mac.plist",
);
const desktopAiRoot = path.join(desktopAppPath, "Contents", "Resources", "ai");
const desktopClaudeRoot = path.join(
    desktopAiRoot,
    "embedded",
    "claude-agent-acp",
);
const nodeBinDir = path.dirname(process.execPath);
const pnpmCommand = resolveRequiredCommand(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["/opt/homebrew/bin/pnpm", "/usr/local/bin/pnpm"],
);
const codesignCommand = resolveRequiredCommand("codesign", [
    "/usr/bin/codesign",
]);
const dittoCommand = resolveRequiredCommand("ditto", ["/usr/bin/ditto"]);
const spctlCommand = resolveRequiredCommand("spctl", ["/usr/sbin/spctl"]);
const xattrCommand = resolveRequiredCommand("xattr", ["/usr/bin/xattr"]);
const xcrunCommand = resolveRequiredCommand("xcrun", ["/usr/bin/xcrun"]);
const macTargets = [{ arch: "arm64" }, { arch: "x64" }];
const builtinModuleNames = new Set(
    builtinModules.flatMap((moduleName) => [
        moduleName,
        moduleName.replace(/^node:/u, ""),
    ]),
);

if (process.platform !== "darwin") {
    throw new Error("The macOS packaging workflow can only run on macOS.");
}

main();

function main() {
    const electronBuilderArgs = resolveElectronBuilderArgs(process.argv.slice(2));

    console.log("[package:mac] Packaging with prebuilt ACP artifacts.");
    prepareWorkspace();
    stageClaudeRuntime();
    stageCodexForMacArchitectures();
    stageEmbeddedNodeForMacArchitectures();
    stageNativeBackendPayload();

    console.log("[package:mac] Building Electron production bundles.");
    run(pnpmCommand, ["exec", "electron-vite", "build"], {
        cwd: repoRoot,
    });

    console.log("[package:mac] Materializing staging app directory.");
    const copiedPackages = stagePackagedApplication();
    stageStandaloneProject(copiedPackages);

    console.log("[package:mac] Packaging universal macOS app and release artifacts.");
    run(
        process.execPath,
        [
            electronBuilderCli,
            ...electronBuilderArgs,
        ],
        {
            env: createPackagerEnvironment(),
        },
    );

    if (!fs.existsSync(standalonePackagedAppPath)) {
        throw new Error(
            `Expected packaged app at ${relativeToRepo(standalonePackagedAppPath)}, but it was not generated.`,
        );
    }

    verifyPackagedUpdaterConfig(standalonePackagedAppPath);
    verifyPackagedApplication(standalonePackagedAppPath);
    verifyReleaseArtifacts();
    verifyMacDistributionReadiness(standalonePackagedAppPath);

    if (shouldCopyPackagedAppToDesktop()) {
        copyPackagedAppToDesktop(standalonePackagedAppPath);
    }

    console.log(
        `[package:mac] Universal staging bundle available at ${standalonePackagedAppPath}`,
    );
    console.log(
        `[package:mac] Release DMG available at ${standaloneDmgArtifactPath}`,
    );
    console.log(
        `[package:mac] Release ZIP available at ${standaloneZipArtifactPath}`,
    );
}

function copyPackagedAppToDesktop(packagedAppPath) {
    try {
        fs.rmSync(desktopAppPath, { force: true, recursive: true });
        run(dittoCommand, [packagedAppPath, desktopAppPath]);
        run(xattrCommand, ["-cr", desktopAppPath]);
        console.log(`[package:mac] App copied to ${desktopAppPath}`);
    } catch (error) {
        console.warn(
            `[package:mac] Could not copy app to ${desktopAppPath}: ${formatError(error)}`,
        );
    }
}

function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}

function resolveElectronBuilderArgs(rawArgs) {
    const normalizedArgs = rawArgs.filter(
        (arg) => !["--", "--mac", "--universal"].includes(arg),
    );

    if (!normalizedArgs.includes("--publish")) {
        normalizedArgs.push("--publish", "never");
    }

    return [
        "--projectDir",
        standaloneProjectRoot,
        "--mac",
        "--universal",
        ...normalizedArgs,
    ];
}

function shouldCopyPackagedAppToDesktop() {
    return !process.env.CI;
}

function prepareWorkspace() {
    ensureDir(buildRoot);
    resetDir(packageAppRoot);
    resetDir(packageResourcesRoot);
    resetDir(packageToolsRoot);
    fs.rmSync(path.join(buildRoot, "test-deploy"), {
        force: true,
        recursive: true,
    });
    fs.rmSync(macPackageRoot, { force: true, recursive: true });
    ensurePackagerCommandWrappers();
}

function stagePackagedApplication() {
    copyTree(outDir, path.join(packageAppRoot, "out"));

    const runtimePackages = collectRuntimePackageNames();
    const copiedPackages = new Map();

    ensureDir(packageAppNodeModulesRoot);
    for (const packageName of runtimePackages) {
        materializeRuntimePackage(
            packageName,
            rootPackageJsonPath,
            copiedPackages,
        );
    }
    materializeNestedRuntimeDependencies(copiedPackages);

    writePackagedAppPackageJson(copiedPackages);
    return copiedPackages;
}

function collectRuntimePackageNames() {
    const entryFiles = [
        ...listRuntimeEntryFiles(path.join(outDir, "main")),
        ...listRuntimeEntryFiles(path.join(outDir, "preload")),
    ];
    const packageNames = new Set();

    for (const filePath of entryFiles) {
        if (!isFile(filePath)) {
            continue;
        }

        const contents = fs.readFileSync(filePath, "utf8");
        for (const specifier of extractPackageSpecifiers(contents)) {
            packageNames.add(specifier);
        }
    }

    packageNames.delete("electron");
    packageNames.add("zod");

    const sortedPackageNames = [...packageNames].sort();
    console.log(
        `[package:mac] Runtime packages: ${sortedPackageNames.join(", ")}.`,
    );

    return sortedPackageNames;
}

function listRuntimeEntryFiles(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    return fs
        .readdirSync(directoryPath, { withFileTypes: true })
        .flatMap((entry) => {
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                return listRuntimeEntryFiles(entryPath);
            }

            if (
                entry.isFile() &&
                (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))
            ) {
                return [entryPath];
            }

            return [];
        });
}

function extractPackageSpecifiers(contents) {
    const matches = new Set();
    const patterns = [
        /from\s+["']([^"']+)["']/g,
        /import\(["']([^"']+)["']\)/g,
        /require\(["']([^"']+)["']\)/g,
    ];

    for (const pattern of patterns) {
        for (const match of contents.matchAll(pattern)) {
            const specifier = toPackageName(match[1]);
            if (specifier) {
                matches.add(specifier);
            }
        }
    }

    return matches;
}

function toPackageName(rawSpecifier) {
    if (
        !rawSpecifier ||
        rawSpecifier.startsWith(".") ||
        rawSpecifier.startsWith("/") ||
        rawSpecifier.startsWith("node:") ||
        rawSpecifier.includes("${")
    ) {
        return null;
    }

    if (!/^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*$/.test(rawSpecifier)) {
        return null;
    }

    if (rawSpecifier.startsWith("@")) {
        const [scope, name] = rawSpecifier.split("/");
        return scope && name ? `${scope}/${name}` : null;
    }

    const [name] = rawSpecifier.split("/");
    return name || null;
}

function materializeRuntimePackage(
    packageName,
    sourceManifestPath,
    copiedPackages,
    options = {},
) {
    if (!options.allowBuiltinPackage && builtinModuleNames.has(packageName)) {
        return;
    }

    const {
        manifest: sourceManifest,
        manifestPath: resolvedManifestPath,
        packageRoot,
    } = resolvePackage(packageName, sourceManifestPath);
    const existingPackage = copiedPackages.get(packageName);
    if (existingPackage) {
        if (existingPackage.version !== sourceManifest.version) {
            throw new Error(
                `Conflicting versions detected for ${packageName}: ${existingPackage.version} and ${sourceManifest.version}.`,
            );
        }

        return;
    }

    const destinationPackageRoot = path.join(
        packageAppNodeModulesRoot,
        ...packageName.split("/"),
    );

    copiedPackages.set(packageName, {
        manifestPath: resolvedManifestPath,
        version: sourceManifest.version,
    });
    copyPackageTree(packageRoot, destinationPackageRoot);

    for (const dependencyName of getRuntimeDependencies(sourceManifest)) {
        try {
            materializeRuntimePackage(
                dependencyName,
                resolvedManifestPath,
                copiedPackages,
                { allowBuiltinPackage: true },
            );
        } catch (error) {
            const isOptionalDependency =
                sourceManifest.optionalDependencies &&
                dependencyName in sourceManifest.optionalDependencies;
            const isOptionalPeerDependency =
                sourceManifest.peerDependenciesMeta?.[dependencyName]
                    ?.optional === true;

            if (isOptionalDependency || isOptionalPeerDependency) {
                continue;
            }

            throw error;
        }
    }
}

function materializeNestedRuntimeDependencies(copiedPackages) {
    for (const [parentPackageName, parentPackage] of copiedPackages) {
        const parentManifest = readJson(parentPackage.manifestPath);
        const dependencyRanges = {
            ...parentManifest.dependencies,
            ...parentManifest.optionalDependencies,
        };

        for (const [dependencyName, dependencyRange] of Object.entries(
            dependencyRanges,
        )) {
            const rootDependency = copiedPackages.get(dependencyName);
            if (
                rootDependency &&
                versionSatisfiesRange(rootDependency.version, dependencyRange)
            ) {
                continue;
            }

            const dependencyPackage =
                resolvePnpmPackageMatchingRange(
                    dependencyName,
                    dependencyRange,
                ) ?? resolvePackage(dependencyName, parentPackage.manifestPath);
            const destinationPackageRoot = path.join(
                packageAppNodeModulesRoot,
                ...parentPackageName.split("/"),
                "node_modules",
                ...dependencyName.split("/"),
            );
            const destinationManifestPath = path.join(
                destinationPackageRoot,
                "package.json",
            );

            if (
                isFile(destinationManifestPath) &&
                readJson(destinationManifestPath).version ===
                    dependencyPackage.manifest.version
            ) {
                continue;
            }

            copyPackageTree(
                dependencyPackage.packageRoot,
                destinationPackageRoot,
            );
        }
    }
}

function resolvePnpmPackageMatchingRange(packageName, range) {
    const pnpmStoreRoot = path.join(repoRoot, "node_modules", ".pnpm");
    if (!fs.existsSync(pnpmStoreRoot)) {
        return null;
    }

    const encodedPackageName = packageName.replace("/", "+");
    const packageDirectoryPrefix = `${encodedPackageName}@`;
    const candidates = fs
        .readdirSync(pnpmStoreRoot)
        .filter((entryName) => entryName.startsWith(packageDirectoryPrefix))
        .map((entryName) => {
            const version = entryName
                .slice(packageDirectoryPrefix.length)
                .split("_")[0];
            const manifestPath = path.join(
                pnpmStoreRoot,
                entryName,
                "node_modules",
                ...packageName.split("/"),
                "package.json",
            );
            return {
                manifestPath,
                version,
            };
        })
        .filter(
            (candidate) =>
                isFile(candidate.manifestPath) &&
                versionSatisfiesRange(candidate.version, range),
        )
        .sort((left, right) => compareSemver(right.version, left.version));

    const [candidate] = candidates;
    if (!candidate) {
        return null;
    }

    return readPackageManifest(candidate.manifestPath);
}

function versionSatisfiesRange(version, range) {
    if (range.startsWith("^")) {
        const minimumVersion = range.slice(1);
        const [major] = parseSemver(minimumVersion);
        const [candidateMajor] = parseSemver(version);
        return (
            candidateMajor === major &&
            compareSemver(version, minimumVersion) >= 0
        );
    }

    return version === range;
}

function compareSemver(leftVersion, rightVersion) {
    const left = parseSemver(leftVersion);
    const right = parseSemver(rightVersion);

    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }

    return 0;
}

function parseSemver(version) {
    return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function resolvePackage(packageName, sourceManifestPath) {
    const canonicalSourceManifestPath =
        canonicalizePackageManifestPath(sourceManifestPath);
    const preferredManifestPath = findNodeModulesPackageManifest(
        packageName,
        canonicalSourceManifestPath,
    );

    if (preferredManifestPath) {
        return readPackageManifest(preferredManifestPath);
    }

    if (builtinModuleNames.has(packageName)) {
        throw new Error(`Cannot materialize Node builtin module: ${packageName}.`);
    }

    const resolver = createRequire(canonicalSourceManifestPath);
    const resolvedEntryPath = resolver.resolve(packageName);
    const manifestPath = findPackageManifestPath(resolvedEntryPath);

    return readPackageManifest(manifestPath);
}

function findNodeModulesPackageManifest(packageName, sourceManifestPath) {
    const packagePathParts = packageName.split("/");
    let currentDirectory = path.dirname(
        canonicalizePackageManifestPath(sourceManifestPath),
    );

    while (currentDirectory !== path.dirname(currentDirectory)) {
        const manifestPath = path.join(
            currentDirectory,
            "node_modules",
            ...packagePathParts,
            "package.json",
        );

        if (isFile(manifestPath)) {
            return canonicalizePackageManifestPath(manifestPath);
        }

        currentDirectory = path.dirname(currentDirectory);
    }

    return null;
}

function canonicalizePackageManifestPath(manifestPath) {
    return fs.realpathSync(manifestPath);
}

function readPackageManifest(manifestPath) {
    const canonicalManifestPath = canonicalizePackageManifestPath(manifestPath);
    return {
        manifest: readJson(canonicalManifestPath),
        manifestPath: canonicalManifestPath,
        packageRoot: path.dirname(canonicalManifestPath),
    };
}

function findPackageManifestPath(resolvedEntryPath) {
    let currentDirectory = path.dirname(resolvedEntryPath);

    while (currentDirectory !== path.dirname(currentDirectory)) {
        const manifestPath = path.join(currentDirectory, "package.json");
        if (isFile(manifestPath)) {
            return manifestPath;
        }

        currentDirectory = path.dirname(currentDirectory);
    }

    throw new Error(
        `Could not locate a package.json for ${resolvedEntryPath}.`,
    );
}

function getRuntimeDependencies(manifest) {
    const dependencyNames = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);

    for (const peerDependencyName of Object.keys(
        manifest.peerDependencies ?? {},
    )) {
        if (
            manifest.peerDependenciesMeta?.[peerDependencyName]?.optional ===
            true
        ) {
            continue;
        }

        dependencyNames.add(peerDependencyName);
    }

    dependencyNames.delete("electron");

    return [...dependencyNames].sort();
}

function copyPackageTree(fromPath, toPath) {
    ensureDir(path.dirname(toPath));
    fs.cpSync(fromPath, toPath, {
        dereference: true,
        errorOnExist: false,
        filter: (sourcePath) => path.basename(sourcePath) !== "node_modules",
        force: true,
        preserveTimestamps: true,
        recursive: true,
    });
}

function writePackagedAppPackageJson(copiedPackages) {
    const stagedDependencies = Object.fromEntries(
        [...copiedPackages.entries()]
            .sort(([leftName], [rightName]) =>
                leftName.localeCompare(rightName),
            )
            .map(([packageName, metadata]) => [
                packageName,
                rootPackageJson.dependencies?.[packageName] ?? metadata.version,
            ]),
    );

    const packagedManifest = {
        name: rootPackageJson.name,
        version: rootPackageJson.version,
        private: true,
        description: rootPackageJson.description,
        type: rootPackageJson.type,
        main: rootPackageJson.main,
        dependencies: stagedDependencies,
    };

    fs.writeFileSync(
        path.join(packageAppRoot, "package.json"),
        `${JSON.stringify(packagedManifest, null, 4)}\n`,
        "utf8",
    );
}

function stageStandaloneProject(copiedPackages) {
    resetDir(standaloneProjectRoot);
    copyTree(packageAppRoot, standaloneProjectRoot, { dereference: true });
    copyTree(
        path.join(repoRoot, "resources", "icons"),
        path.join(standaloneResourcesRoot, "icons"),
    );
    fs.copyFileSync(
        macEntitlementsPath,
        path.join(standaloneResourcesRoot, "entitlements.mac.plist"),
    );
    fs.copyFileSync(
        path.join(repoRoot, "resources", "entitlements.mac.inherit.plist"),
        path.join(standaloneResourcesRoot, "entitlements.mac.inherit.plist"),
    );
    copyTree(packageResourcesRoot, standalonePackageResourcesRoot, {
        dereference: true,
    });
    writeStandaloneUpdaterConfig();
    writeStandaloneProjectPackageJson(copiedPackages);
}

function writeStandaloneUpdaterConfig() {
    const appUpdateConfigPath = path.join(standaloneProjectRoot, "app-update.yml");

    if (
        ensurePackagedMacUpdaterConfig({
            appUpdateConfigPath,
            packageJson: rootPackageJson,
        })
    ) {
        console.log(
            `[package:mac] Wrote ${relativeToRepo(appUpdateConfigPath)}.`,
        );
    }

    verifyPackagedMacUpdaterConfig({
        appUpdateConfigPath,
        packageJson: rootPackageJson,
        relativePath: relativeToRepo,
    });
}

function writeStandaloneProjectPackageJson(copiedPackages) {
    const electronVersion = rootPackageJson.devDependencies.electron.replace(
        /^[^\d]*/u,
        "",
    );
    const stagedDependencies = Object.fromEntries(
        [...copiedPackages.entries()]
            .sort(([leftName], [rightName]) =>
                leftName.localeCompare(rightName),
            )
            .map(([packageName, metadata]) => [packageName, metadata.version]),
    );

    const standaloneManifest = {
        name: rootPackageJson.name,
        version: rootPackageJson.version,
        private: true,
        description: rootPackageJson.description,
        repository: rootPackageJson.repository,
        bugs: rootPackageJson.bugs,
        homepage: rootPackageJson.homepage,
        type: rootPackageJson.type,
        packageManager: "npm@10.0.0",
        main: rootPackageJson.main,
        devDependencies: {
            electron: electronVersion,
        },
        dependencies: stagedDependencies,
        build: {
            ...rootPackageJson.build,
            electronVersion,
            directories: {
                buildResources: "resources",
                output: "dist",
            },
            mac: {
                ...(rootPackageJson.build?.mac ?? {}),
                publish: [
                    {
                        provider: "github",
                        channel: "latest",
                    },
                ],
            },
            extraResources: [
                {
                    from: "app-update.yml",
                    to: "app-update.yml",
                },
                {
                    from: "package-resources/ai",
                    to: "ai",
                    filter: ["**/*"],
                },
                {
                    from: "package-resources/native",
                    to: "native",
                    filter: ["**/*"],
                },
            ],
        },
    };

    fs.writeFileSync(
        path.join(standaloneProjectRoot, "package.json"),
        `${JSON.stringify(standaloneManifest, null, 4)}\n`,
        "utf8",
    );
}

function createPackagerEnvironment() {
    const wrappedCommand = (commandName) =>
        path.join(packageToolsRoot, commandName);

    return {
        ...process.env,
        AR: wrappedCommand("ar"),
        CC: wrappedCommand("clang"),
        CXX: wrappedCommand("clang++"),
        MAKE: wrappedCommand("make"),
        NODE: wrappedCommand("node"),
        PATH: [packageToolsRoot, nodeBinDir, process.env.PATH ?? ""]
            .filter(Boolean)
            .join(path.delimiter),
        PYTHON: wrappedCommand("python3"),
        RANLIB: wrappedCommand("ranlib"),
        npm_config_make: wrappedCommand("make"),
        npm_config_node_execpath: wrappedCommand("node"),
        npm_config_python: wrappedCommand("python3"),
        npm_config_scripts_prepend_node_path: "true",
        npm_node_execpath: wrappedCommand("node"),
    };
}

function verifyPackagedApplication(packagedAppPath) {
    const packagedAsarPath = path.join(
        packagedAppPath,
        "Contents",
        "Resources",
        "app.asar",
    );

    if (!isFile(packagedAsarPath)) {
        throw new Error(
            `Expected app.asar at ${packagedAsarPath}, but it was not found.`,
        );
    }

    const result = spawnSync(
        process.execPath,
        [
            "-e",
            `
                const path = require("node:path");
                const { createRequire } = require("node:module");
                const appPath = process.argv[1];
                const appRequire = createRequire(path.join(appPath, "package.json"));
                appRequire("debug");
                for (const packageName of ["zod"]) {
                    appRequire.resolve(packageName);
                }
            `,
            packagedAsarPath,
        ],
        {
            cwd: repoRoot,
            stdio: "inherit",
        },
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(
            "The packaged app is still missing runtime dependencies inside app.asar.",
        );
    }

    validatePackagedClaudeRuntime(
        path.join(
            packagedAppPath,
            "Contents",
            "Resources",
            "ai",
            "embedded",
            "claude-agent-acp",
        ),
    );
}

function verifyReleaseArtifacts() {
    verifyMacReleaseArtifacts({
        distDir: standaloneDistDir,
        productName,
        relativePath: relativeToRepo,
        version: rootPackageJson.version,
    });
}

function verifyPackagedUpdaterConfig(packagedAppPath) {
    const appUpdateConfigPath = path.join(
        packagedAppPath,
        "Contents",
        "Resources",
        "app-update.yml",
    );

    verifyPackagedMacUpdaterConfig({
        appUpdateConfigPath,
        packageJson: rootPackageJson,
        relativePath: relativeToRepo,
    });
}

function verifyMacDistributionReadiness(packagedAppPath) {
    if (!shouldVerifyMacDistributionReadiness()) {
        return;
    }

    console.log("[package:mac] Verifying Developer ID signature and notarization.");
    run(codesignCommand, [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        packagedAppPath,
    ]);
    run(spctlCommand, [
        "--assess",
        "--type",
        "execute",
        "--verbose=4",
        packagedAppPath,
    ]);
    run(xcrunCommand, ["stapler", "validate", packagedAppPath]);
}

function shouldVerifyMacDistributionReadiness() {
    return Boolean(
        process.env.CI &&
            process.env.APPLE_API_KEY &&
            process.env.APPLE_API_KEY_ID &&
            process.env.APPLE_API_ISSUER,
    );
}

function stageClaudeRuntime() {
    const sourceRoot = resolveClaudeProjectRoot();
    const filesToCopy = ["package.json", "LICENSE", "README.md"];

    console.log(
        `[package:mac] Staging Claude ACP from ${relativeToRepo(sourceRoot)}.`,
    );

    resetDir(packagedClaudeRoot);
    copyTree(
        path.join(sourceRoot, "dist"),
        path.join(packagedClaudeRoot, "dist"),
    );
    copyTree(
        path.join(sourceRoot, "node_modules"),
        path.join(packagedClaudeRoot, "node_modules"),
        { dereference: true },
    );

    for (const fileName of filesToCopy) {
        const sourcePath = path.join(sourceRoot, fileName);
        if (!isFile(sourcePath)) {
            continue;
        }

        fs.copyFileSync(sourcePath, path.join(packagedClaudeRoot, fileName));
    }

    pruneClaudeCliArtifacts(path.join(packagedClaudeRoot, "node_modules"));
    normalizeTreePermissions(packagedClaudeRoot);
    validatePackagedClaudeRuntime(packagedClaudeRoot);
}

function resolveClaudeProjectRoot() {
    const candidates = [bundledClaudeRoot, desktopClaudeRoot, claudeVendorDir];

    for (const candidate of candidates) {
        if (
            isFile(path.join(candidate, "dist", "index.js")) &&
            fs.existsSync(path.join(candidate, "node_modules")) &&
            isFile(path.join(candidate, "package.json"))
        ) {
            return candidate;
        }
    }

    throw new Error(
        "No prebuilt Claude ACP bundle was found. Expected resources/ai/embedded/claude-agent-acp or a previous packaged app on the Desktop.",
    );
}

function stageCodexForMacArchitectures() {
    for (const target of macTargets) {
        const sourceBinary = resolvePrebuiltCodexBinary(target.arch);
        const stagedBinaryPath = path.join(
            packagedCodexRoot,
            `darwin-${target.arch}`,
            "codex-acp",
        );
        copyExecutable(sourceBinary, stagedBinaryPath);
        console.log(
            `[package:mac] Staged Codex ACP (${target.arch}) from ${relativeToRepo(sourceBinary)}.`,
        );
    }
}

function stageNativeBackendPayload() {
    console.log("[package:mac] Building and staging native backend sidecar.");
    for (const target of macTargets) {
        const rustTarget = resolveMacRustTarget(target.arch);
        ensureMacRustTarget(rustTarget);
        run(pnpmCommand, [
            "run",
            "native:build",
            "--",
            "--target",
            rustTarget,
        ]);
        run(pnpmCommand, [
            "run",
            "native:stage",
            "--",
            "--platform",
            "darwin",
            "--arch",
            target.arch,
            "--binary",
            path.join(
                repoRoot,
                "target",
                rustTarget,
                "release",
                "comando-native-backend",
            ),
        ]);
    }
}

function ensureMacRustTarget(rustTarget) {
    run("rustup", ["target", "add", rustTarget]);
}

function resolveMacRustTarget(arch) {
    if (arch === "arm64") {
        return "aarch64-apple-darwin";
    }

    if (arch === "x64") {
        return "x86_64-apple-darwin";
    }

    throw new Error(`Unsupported macOS native backend architecture: ${arch}`);
}

function resolvePrebuiltCodexBinary(arch) {
    const candidates = [
        path.join(prebuiltCodexRoot, `darwin-${arch}`, "codex-acp"),
        path.join(desktopAiRoot, "binaries", `darwin-${arch}`, "codex-acp"),
    ];

    if (arch === "arm64") {
        candidates.unshift(bundledArm64CodexBinary);
    }

    return resolveExecutableCandidate(
        candidates,
        `No prebuilt Codex ACP binary was found for ${arch}. Seed resources/ai/prebuilt/codex-acp/darwin-${arch}/codex-acp first.`,
    );
}

function stageEmbeddedNodeForMacArchitectures() {
    for (const target of macTargets) {
        const sourceBinary = resolvePrebuiltNodeBinary(target.arch);
        const stagedNodePath = path.join(
            packagedNodeRoot,
            `darwin-${target.arch}`,
            "bin",
            "node",
        );
        copyExecutable(sourceBinary, stagedNodePath);
        console.log(
            `[package:mac] Staged embedded Node (${target.arch}) from ${relativeToRepo(sourceBinary)}.`,
        );
    }
}

function resolvePrebuiltNodeBinary(arch) {
    const candidates = [
        path.join(prebuiltNodeRoot, `darwin-${arch}`, "bin", "node"),
        path.join(
            desktopAiRoot,
            "embedded",
            "node",
            `darwin-${arch}`,
            "bin",
            "node",
        ),
    ];

    return resolveExecutableCandidate(
        candidates,
        `No prebuilt embedded Node binary was found for ${arch}. Seed resources/ai/prebuilt/node/darwin-${arch}/bin/node first.`,
    );
}

function ensurePackagerCommandWrappers() {
    writeCommandWrapper("node", process.execPath);
    writeCommandWrapper("sh", "/bin/sh");
    writeCommandWrapper(
        "make",
        resolveRequiredCommand("make", ["/usr/bin/make"]),
    );
    writeCommandWrapper(
        "python3",
        resolveRequiredCommand("python3", ["/usr/bin/python3"]),
    );
    writeCommandWrapper("clang", resolveRequiredCommand("clang"));
    writeCommandWrapper("clang++", resolveRequiredCommand("clang++"));
    writeCommandWrapper("ar", resolveRequiredCommand("ar"));
    writeCommandWrapper("ranlib", resolveRequiredCommand("ranlib"));
}

function writeCommandWrapper(commandName, targetPath) {
    const wrapperPath = path.join(packageToolsRoot, commandName);
    const wrapperPathEnv = [
        packageToolsRoot,
        nodeBinDir,
        process.env.PATH ?? "",
    ]
        .filter(Boolean)
        .join(path.delimiter);
    const script = [
        "#!/bin/sh",
        `export PATH="${wrapperPathEnv}"`,
        `exec "${targetPath}" "$@"`,
        "",
    ].join("\n");

    fs.writeFileSync(wrapperPath, script, "utf8");
    fs.chmodSync(wrapperPath, 0o755);
}

function resolveExecutableCandidate(candidates, missingMessage) {
    for (const candidate of candidates) {
        if (isExecutableFile(candidate)) {
            return candidate;
        }
    }

    throw new Error(missingMessage);
}

function normalizeTreePermissions(rootPath) {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            fs.chmodSync(entryPath, 0o755);
            normalizeTreePermissions(entryPath);
            continue;
        }

        if (entry.isFile()) {
            fs.chmodSync(
                entryPath,
                shouldKeepExecutablePermission(entryPath) ? 0o755 : 0o644,
            );
        }
    }
}

function shouldKeepExecutablePermission(filePath) {
    const mode = fs.statSync(filePath).mode;
    if ((mode & 0o111) !== 0) {
        return true;
    }

    if (isClaudeSdkExecutable(filePath)) {
        return true;
    }

    return fileStartsWithShebang(filePath);
}

function isClaudeSdkExecutable(filePath) {
    if (path.basename(filePath) !== "claude") {
        return false;
    }

    const segments = filePath.split(path.sep);
    return segments.some((segment, index) => {
        return (
            segment.startsWith("claude-agent-sdk-") &&
            segments[index - 1] === "@anthropic-ai"
        );
    });
}

function fileStartsWithShebang(filePath) {
    const fd = fs.openSync(filePath, "r");
    try {
        const buffer = Buffer.alloc(2);
        return (
            fs.readSync(fd, buffer, 0, 2, 0) === 2 &&
            buffer.toString() === "#!"
        );
    } finally {
        fs.closeSync(fd);
    }
}

function validatePackagedClaudeRuntime(rootPath) {
    const claudeExecutables = findClaudeSdkExecutables(rootPath);

    if (claudeExecutables.length === 0) {
        throw new Error(
            `Expected a packaged Claude Code binary under ${rootPath}, but none was found.`,
        );
    }

    for (const executablePath of claudeExecutables) {
        if (!isExecutableFile(executablePath)) {
            throw new Error(
                `Packaged Claude Code binary is not executable: ${executablePath}`,
            );
        }
    }
}

function findClaudeSdkExecutables(rootPath) {
    if (!fs.existsSync(rootPath)) {
        return [];
    }

    const matches = [];
    collectClaudeSdkExecutables(rootPath, matches);
    return matches;
}

function collectClaudeSdkExecutables(rootPath, matches) {
    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            collectClaudeSdkExecutables(entryPath, matches);
            continue;
        }

        if (entry.isFile() && isClaudeSdkExecutable(entryPath)) {
            matches.push(entryPath);
        }
    }
}

function pruneClaudeCliArtifacts(nodeModulesRoot) {
    if (!fs.existsSync(nodeModulesRoot)) {
        return;
    }

    for (const entry of fs.readdirSync(nodeModulesRoot, {
        withFileTypes: true,
    })) {
        const entryPath = path.join(nodeModulesRoot, entry.name);

        if (!entry.isDirectory()) {
            continue;
        }

        if (entry.name === ".bin" || entry.name === "bin") {
            fs.rmSync(entryPath, { force: true, recursive: true });
            continue;
        }

        pruneClaudeCliArtifacts(entryPath);
    }
}

function resolveRequiredCommand(command, fallbacks = []) {
    const resolved = resolveFromPath(command);
    if (resolved) {
        return resolved;
    }

    for (const candidate of fallbacks) {
        if (isExecutableFile(candidate)) {
            return candidate;
        }
    }

    throw new Error(`Required command was not found: ${command}`);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function run(command, args, options = {}) {
    const { usePackagerNodeWrapper = false, ...spawnOptions } = options;
    const envPath = [
        ...(usePackagerNodeWrapper ? [packageToolsRoot] : []),
        nodeBinDir,
        process.env.PATH ?? "",
    ]
        .filter(Boolean)
        .join(path.delimiter);
    const result = spawnPreparedSync(command, args, {
        cwd: repoRoot,
        env: {
            ...process.env,
            PATH: envPath,
            ...spawnOptions.env,
        },
        stdio: "inherit",
        ...spawnOptions,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function runInShell(command, env = {}) {
    const result = spawnSync("/bin/zsh", ["-lc", command], {
        cwd: repoRoot,
        env: {
            ...process.env,
            ...env,
        },
        stdio: "inherit",
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function shellQuote(value) {
    return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}
