import fs from "node:fs";
import path from "node:path";

export function resolvePackagedMacUpdaterConfig({ packageJson }) {
    const repository = resolveGitHubRepository(packageJson.repository);

    return {
        channel: "latest",
        owner: repository.owner,
        provider: "github",
        repo: repository.repo,
        updaterCacheDirName: `${packageJson.name.toLowerCase()}-updater`,
    };
}

export function ensurePackagedMacUpdaterConfig({
    appUpdateConfigPath,
    packageJson,
}) {
    if (fs.existsSync(appUpdateConfigPath)) {
        return false;
    }

    const config = resolvePackagedMacUpdaterConfig({ packageJson });
    fs.mkdirSync(path.dirname(appUpdateConfigPath), { recursive: true });
    fs.writeFileSync(appUpdateConfigPath, serializeSimpleYaml(config), "utf8");
    return true;
}

export function verifyPackagedMacUpdaterConfig({
    appUpdateConfigPath,
    packageJson,
    relativePath = defaultRelativePath,
}) {
    const expected = resolvePackagedMacUpdaterConfig({ packageJson });
    const content = readRequiredTextFile(appUpdateConfigPath, relativePath);

    for (const [key, value] of Object.entries(expected)) {
        if (!yamlHasScalar(content, key, value)) {
            throw new Error(
                `Packaged macOS updater config must include ${key}: ${value}. Check ${relativePath(appUpdateConfigPath)}.`,
            );
        }
    }
}

function resolveGitHubRepository(repository) {
    const repositoryUrl =
        typeof repository === "string" ? repository : repository?.url;

    if (!repositoryUrl) {
        throw new Error(
            "package.json must declare a GitHub repository before macOS updater config can be generated.",
        );
    }

    const match = repositoryUrl.match(
        /github\.com[:/]([^/]+)\/([^#?]+?)(?:\.git)?(?:[#?].*)?$/u,
    );
    if (!match) {
        throw new Error(
            `Unsupported macOS updater repository URL: ${repositoryUrl}. Expected a GitHub repository URL.`,
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
            `Missing expected macOS updater config: ${relativePath(filePath)}.`,
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
