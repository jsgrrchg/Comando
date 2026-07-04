import fs from "node:fs";
import path from "node:path";

export const SUPPORTED_LINUX_RELEASE_ARCHES = Object.freeze(["x64", "arm64"]);

const APPIMAGE_ARTIFACT_ARCHITECTURE_BY_RELEASE_ARCH = {
    arm64: "arm64",
    x64: "x86_64",
};
const DEBIAN_ARTIFACT_ARCHITECTURE_BY_RELEASE_ARCH = {
    arm64: "arm64",
    x64: "amd64",
};
const RPM_ARTIFACT_ARCHITECTURE_BY_RELEASE_ARCH = {
    arm64: "aarch64",
    x64: "x86_64",
};

export function resolveLinuxUpdaterChannel(targetArch) {
    assertSupportedLinuxReleaseArch(targetArch);
    return `latest-${targetArch}`;
}

export function resolveLinuxReleaseArtifacts({
    distDir,
    productName,
    targetArch,
    version,
}) {
    assertSupportedLinuxReleaseArch(targetArch);

    const updaterChannel = resolveLinuxUpdaterChannel(targetArch);
    const linuxArchSuffix = targetArch === "x64" ? "" : `-${targetArch}`;
    const appImageBaseName = buildLinuxArtifactBaseName({
        archByReleaseArch: APPIMAGE_ARTIFACT_ARCHITECTURE_BY_RELEASE_ARCH,
        productName,
        targetArch,
        version,
    });
    const debBaseName = buildLinuxArtifactBaseName({
        archByReleaseArch: DEBIAN_ARTIFACT_ARCHITECTURE_BY_RELEASE_ARCH,
        productName,
        targetArch,
        version,
    });
    const rpmBaseName = buildLinuxArtifactBaseName({
        archByReleaseArch: RPM_ARTIFACT_ARCHITECTURE_BY_RELEASE_ARCH,
        productName,
        targetArch,
        version,
    });

    return {
        appImagePath: path.join(distDir, `${appImageBaseName}.AppImage`),
        appImageBlockmapPath: path.join(
            distDir,
            `${appImageBaseName}.AppImage.blockmap`,
        ),
        debPath: path.join(distDir, `${debBaseName}.deb`),
        forbiddenSharedMetadataPath: path.join(
            distDir,
            `latest-linux${linuxArchSuffix}.yml`,
        ),
        metadataPath: path.join(
            distDir,
            `${updaterChannel}-linux${linuxArchSuffix}.yml`,
        ),
        rpmPath: path.join(distDir, `${rpmBaseName}.rpm`),
        updaterChannel,
    };
}

export function resolvePackagedLinuxUpdaterConfig({ packageJson, targetArch }) {
    assertSupportedLinuxReleaseArch(targetArch);
    const repository = resolveGitHubRepository(packageJson.repository);

    return {
        channel: resolveLinuxUpdaterChannel(targetArch),
        owner: repository.owner,
        provider: "github",
        repo: repository.repo,
        updaterCacheDirName: `${packageJson.name.toLowerCase()}-updater`,
    };
}

export function ensurePackagedLinuxUpdaterConfig({
    appUpdateConfigPath,
    packageJson,
    targetArch,
}) {
    if (fs.existsSync(appUpdateConfigPath)) {
        return false;
    }

    const config = resolvePackagedLinuxUpdaterConfig({ packageJson, targetArch });
    fs.mkdirSync(path.dirname(appUpdateConfigPath), { recursive: true });
    fs.writeFileSync(appUpdateConfigPath, serializeSimpleYaml(config), "utf8");
    return true;
}

export function verifyPackagedLinuxUpdaterConfig({
    appUpdateConfigPath,
    packageJson,
    relativePath = defaultRelativePath,
    targetArch,
}) {
    const expected = resolvePackagedLinuxUpdaterConfig({
        packageJson,
        targetArch,
    });
    const content = readRequiredTextFile(appUpdateConfigPath, relativePath);

    for (const [key, value] of Object.entries(expected)) {
        if (!yamlHasScalar(content, key, value)) {
            throw new Error(
                `Packaged Linux updater config must include ${key}: ${value}. Check ${relativePath(appUpdateConfigPath)}.`,
            );
        }
    }
}

export function verifyLinuxReleaseArtifacts({
    distDir,
    productName,
    relativePath = defaultRelativePath,
    targetArch,
    version,
}) {
    const artifacts = verifyLinuxPackageArtifacts({
        distDir,
        productName,
        relativePath,
        targetArch,
        version,
    });

    assertFile(artifacts.metadataPath, relativePath);

    if (fs.existsSync(artifacts.forbiddenSharedMetadataPath)) {
        throw new Error(
            `Linux releases must not emit shared updater metadata: ${relativePath(artifacts.forbiddenSharedMetadataPath)}.`,
        );
    }

    const metadata = fs.readFileSync(artifacts.metadataPath, "utf8");
    const expectedAppImageName = path.basename(artifacts.appImagePath);
    if (!metadata.includes(expectedAppImageName)) {
        throw new Error(
            `Linux updater metadata ${relativePath(artifacts.metadataPath)} does not reference ${expectedAppImageName}.`,
        );
    }

    for (const otherArch of SUPPORTED_LINUX_RELEASE_ARCHES) {
        if (otherArch === targetArch) {
            continue;
        }

        const otherArtifacts = resolveLinuxReleaseArtifacts({
            distDir,
            productName,
            targetArch: otherArch,
            version,
        });
        const otherAppImageName = path.basename(otherArtifacts.appImagePath);

        if (metadata.includes(otherAppImageName)) {
            throw new Error(
                `Linux updater metadata ${relativePath(artifacts.metadataPath)} references ${otherArch} artifacts during a ${targetArch} build.`,
            );
        }
    }

    return artifacts;
}

export function verifyLinuxPackageArtifacts({
    distDir,
    productName,
    relativePath = defaultRelativePath,
    targetArch,
    version,
}) {
    const artifacts = resolveLinuxReleaseArtifacts({
        distDir,
        productName,
        targetArch,
        version,
    });

    assertFile(artifacts.appImagePath, relativePath);
    assertFile(artifacts.debPath, relativePath);
    assertFile(artifacts.rpmPath, relativePath);

    return artifacts;
}

function assertSupportedLinuxReleaseArch(targetArch) {
    if (!SUPPORTED_LINUX_RELEASE_ARCHES.includes(targetArch)) {
        throw new Error(
            `Unsupported Linux release architecture: ${targetArch}. Expected one of ${SUPPORTED_LINUX_RELEASE_ARCHES.join(", ")}.`,
        );
    }
}

function buildLinuxArtifactBaseName({
    archByReleaseArch,
    productName,
    targetArch,
    version,
}) {
    return `${productName}-${version}-linux-${archByReleaseArch[targetArch]}`;
}

function resolveGitHubRepository(repository) {
    const repositoryUrl =
        typeof repository === "string" ? repository : repository?.url;

    if (!repositoryUrl) {
        throw new Error(
            "package.json must declare a GitHub repository before Linux updater config can be generated.",
        );
    }

    const match = repositoryUrl.match(
        /github\.com[:/]([^/]+)\/([^#?]+?)(?:\.git)?(?:[#?].*)?$/u,
    );
    if (!match) {
        throw new Error(
            `Unsupported Linux updater repository URL: ${repositoryUrl}. Expected a GitHub repository URL.`,
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
            `Missing expected Linux release artifact: ${relativePath(filePath)}.`,
        );
    }
}

function readRequiredTextFile(filePath, relativePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(
            `Missing expected Linux updater config: ${relativePath(filePath)}.`,
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
