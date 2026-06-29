import path from "node:path";

import {
    normalizeReleaseVersion,
    parseGitHubRepoSlug,
} from "./apt-repo-lib.mjs";

export const DNF_REPOSITORY_RELATIVE_ROOT = "dnf";
export const DNF_PACKAGE_NAME = "comando";
export const DNF_SUPPORTED_ARCHITECTURES = ["x86_64", "aarch64"];
export const DNF_PUBLIC_KEY_FILE_NAME = "comando-archive-keyring.asc";
export const DNF_REPO_EXAMPLE_FILE_NAME = "comando.repo.example";
export const DNF_DEFAULT_BASE_URL = "https://jsgrrchg.github.io/Comando/dnf";

const ELECTRON_BUILDER_ARTIFACT_ARCHITECTURE_BY_RPM_ARCHITECTURE = {
    aarch64: "aarch64",
    x86_64: "x86_64",
};

export function normalizeRpmArchitecture(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!DNF_SUPPORTED_ARCHITECTURES.includes(normalized)) {
        throw new Error(
            `Unsupported RPM architecture "${value}". Supported architectures: ${DNF_SUPPORTED_ARCHITECTURES.join(", ")}.`,
        );
    }
    return normalized;
}

export function buildDnfRepoRoot(pagesDir) {
    if (typeof pagesDir !== "string" || !pagesDir.trim()) {
        throw new Error("pagesDir must be a non-empty string.");
    }
    return path.join(pagesDir, DNF_REPOSITORY_RELATIVE_ROOT);
}

export function buildRpmReleaseAssetName(version, rpmArchitecture) {
    const normalizedVersion = normalizeReleaseVersion(version);
    const arch = normalizeRpmArchitecture(rpmArchitecture);
    const electronBuilderArch =
        ELECTRON_BUILDER_ARTIFACT_ARCHITECTURE_BY_RPM_ARCHITECTURE[arch];
    return `Comando-${normalizedVersion}-linux-${electronBuilderArch}.rpm`;
}

export function buildGitHubReleaseRpmLocationPrefix(repoSlug, tag) {
    const { owner, repo } = parseGitHubRepoSlug(repoSlug);
    const releaseTag = String(tag ?? "").trim().startsWith("v")
        ? String(tag).trim()
        : `v${normalizeReleaseVersion(tag)}`;

    return `https://github.com/${owner}/${repo}/releases/download/${releaseTag}/`;
}

export function buildGitHubReleaseRpmUrl(
    repoSlug,
    tag,
    version,
    rpmArchitecture,
) {
    return `${buildGitHubReleaseRpmLocationPrefix(repoSlug, tag)}${encodeURIComponent(
        buildRpmReleaseAssetName(version, rpmArchitecture),
    )}`;
}

export function buildComandoRepoExample(baseUrl = DNF_DEFAULT_BASE_URL) {
    const normalizedUrl = normalizeDnfBaseUrl(baseUrl);
    return [
        "[comando]",
        "name=Comando",
        `baseurl=${normalizedUrl}`,
        "enabled=1",
        "gpgcheck=1",
        "repo_gpgcheck=1",
        `gpgkey=${normalizedUrl}/${DNF_PUBLIC_KEY_FILE_NAME}`,
        "",
    ].join("\n");
}

export function normalizeDnfBaseUrl(baseUrl) {
    const normalized = String(baseUrl ?? "").trim().replace(/\/+$/u, "");
    if (!normalized) {
        throw new Error("DNF base URL must be a non-empty string.");
    }
    if (!/^https?:\/\//iu.test(normalized) && !normalized.startsWith("file:")) {
        throw new Error(
            `DNF base URL must be an http(s) or file URL, received "${baseUrl}".`,
        );
    }
    return normalized;
}
