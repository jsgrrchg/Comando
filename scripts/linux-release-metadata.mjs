import fs from "node:fs";
import path from "node:path";

export function resolvePackagedLinuxUpdaterConfig({ packageJson }) {
    const repository = resolveGitHubRepository(packageJson.repository);

    return {
        channel: "latest",
        owner: repository.owner,
        provider: "github",
        repo: repository.repo,
        updaterCacheDirName: `${packageJson.name.toLowerCase()}-updater`,
    };
}

export function ensurePackagedLinuxUpdaterConfig({
    appUpdateConfigPath,
    packageJson,
}) {
    if (fs.existsSync(appUpdateConfigPath)) {
        return false;
    }

    const config = resolvePackagedLinuxUpdaterConfig({ packageJson });
    fs.mkdirSync(path.dirname(appUpdateConfigPath), { recursive: true });
    fs.writeFileSync(appUpdateConfigPath, serializeSimpleYaml(config), "utf8");
    return true;
}

export function verifyPackagedLinuxUpdaterConfig({
    appUpdateConfigPath,
    packageJson,
    relativePath = defaultRelativePath,
}) {
    const expected = resolvePackagedLinuxUpdaterConfig({ packageJson });
    const content = readRequiredTextFile(appUpdateConfigPath, relativePath);

    for (const [key, value] of Object.entries(expected)) {
        if (!yamlHasScalar(content, key, value)) {
            throw new Error(
                `Packaged Linux updater config must include ${key}: ${value}. Check ${relativePath(appUpdateConfigPath)}.`,
            );
        }
    }
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
