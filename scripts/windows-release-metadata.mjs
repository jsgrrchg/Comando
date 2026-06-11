import fs from "node:fs";
import path from "node:path";

export const SUPPORTED_WINDOWS_RELEASE_ARCHES = Object.freeze([
    "x64",
    "arm64",
]);

export function resolveWindowsUpdaterChannel(targetArch) {
    assertSupportedWindowsReleaseArch(targetArch);
    return `latest-${targetArch}`;
}

export function resolveWindowsReleaseArtifacts({
    distDir,
    productName,
    targetArch,
    version,
}) {
    assertSupportedWindowsReleaseArch(targetArch);

    const installerFileName = `${productName}-${version}-win-${targetArch}.exe`;
    const updaterChannel = resolveWindowsUpdaterChannel(targetArch);

    return {
        blockmapPath: path.join(distDir, `${installerFileName}.blockmap`),
        forbiddenSharedMetadataPath: path.join(distDir, "latest.yml"),
        installerFileName,
        installerPath: path.join(distDir, installerFileName),
        metadataPath: path.join(distDir, `${updaterChannel}.yml`),
        updaterChannel,
    };
}

export function resolvePackagedWindowsUpdaterConfig({
    packageJson,
    targetArch,
}) {
    const repository = resolveGitHubRepository(packageJson.repository);

    return {
        channel: resolveWindowsUpdaterChannel(targetArch),
        owner: repository.owner,
        provider: "github",
        repo: repository.repo,
        updaterCacheDirName: `${packageJson.name.toLowerCase()}-updater`,
    };
}

export function ensurePackagedWindowsUpdaterConfig({
    appUpdateConfigPath,
    packageJson,
    targetArch,
}) {
    if (fs.existsSync(appUpdateConfigPath)) {
        return false;
    }

    const config = resolvePackagedWindowsUpdaterConfig({
        packageJson,
        targetArch,
    });
    fs.mkdirSync(path.dirname(appUpdateConfigPath), { recursive: true });
    fs.writeFileSync(appUpdateConfigPath, serializeSimpleYaml(config), "utf8");
    return true;
}

export function verifyPackagedWindowsUpdaterChannel({
    appUpdateConfigPath,
    relativePath = defaultRelativePath,
    targetArch,
}) {
    const expectedChannel = resolveWindowsUpdaterChannel(targetArch);
    const content = readRequiredTextFile(appUpdateConfigPath, relativePath);

    if (!yamlHasScalar(content, "channel", expectedChannel)) {
        throw new Error(
            `Packaged Windows updater config must use channel ${expectedChannel}. Check ${relativePath(appUpdateConfigPath)}.`,
        );
    }
}

export function verifyWindowsReleaseArtifacts({
    distDir,
    productName,
    relativePath = defaultRelativePath,
    targetArch,
    version,
}) {
    const artifacts = resolveWindowsReleaseArtifacts({
        distDir,
        productName,
        targetArch,
        version,
    });

    assertFile(artifacts.installerPath, relativePath);
    assertFile(artifacts.blockmapPath, relativePath);
    assertFile(artifacts.metadataPath, relativePath);

    if (fs.existsSync(artifacts.forbiddenSharedMetadataPath)) {
        throw new Error(
            `Windows releases must not emit shared updater metadata: ${relativePath(artifacts.forbiddenSharedMetadataPath)}.`,
        );
    }

    const metadata = fs.readFileSync(artifacts.metadataPath, "utf8");
    if (!metadata.includes(artifacts.installerFileName)) {
        throw new Error(
            `Windows updater metadata ${relativePath(artifacts.metadataPath)} does not reference ${artifacts.installerFileName}.`,
        );
    }

    for (const otherArch of SUPPORTED_WINDOWS_RELEASE_ARCHES) {
        if (otherArch === targetArch) {
            continue;
        }

        if (metadata.includes(`-win-${otherArch}.exe`)) {
            throw new Error(
                `Windows updater metadata ${relativePath(artifacts.metadataPath)} references ${otherArch} artifacts during a ${targetArch} build.`,
            );
        }
    }

    return artifacts;
}

function assertSupportedWindowsReleaseArch(targetArch) {
    if (!SUPPORTED_WINDOWS_RELEASE_ARCHES.includes(targetArch)) {
        throw new Error(
            `Unsupported Windows release architecture: ${targetArch}. Expected one of ${SUPPORTED_WINDOWS_RELEASE_ARCHES.join(", ")}.`,
        );
    }
}

function resolveGitHubRepository(repository) {
    const repositoryUrl =
        typeof repository === "string" ? repository : repository?.url;

    if (!repositoryUrl) {
        throw new Error(
            "package.json must declare a GitHub repository before Windows updater config can be generated.",
        );
    }

    const match = repositoryUrl.match(
        /github\.com[:/]([^/]+)\/([^#?]+?)(?:\.git)?(?:[#?].*)?$/u,
    );
    if (!match) {
        throw new Error(
            `Unsupported Windows updater repository URL: ${repositoryUrl}. Expected a GitHub repository URL.`,
        );
    }

    return {
        owner: match[1],
        repo: match[2].replace(/\.git$/u, ""),
    };
}

function assertFile(filePath, relativePath) {
    const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (!stats?.isFile()) {
        throw new Error(
            `Missing expected Windows release artifact: ${relativePath(filePath)}.`,
        );
    }
}

function readRequiredTextFile(filePath, relativePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(
            `Missing expected Windows updater config: ${relativePath(filePath)}.`,
        );
    }

    return fs.readFileSync(filePath, "utf8");
}

function yamlHasScalar(content, key, expectedValue) {
    const escapedKey = escapeRegExp(key);
    const escapedValue = escapeRegExp(expectedValue);
    const pattern = new RegExp(
        `(^|\\n)\\s*${escapedKey}:\\s*["']?${escapedValue}["']?\\s*(\\n|$)`,
    );

    return pattern.test(content);
}

function serializeSimpleYaml(config) {
    return `${Object.entries(config)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n")}\n`;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultRelativePath(filePath) {
    return filePath;
}
