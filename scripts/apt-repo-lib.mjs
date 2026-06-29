import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const APT_PACKAGE_NAME = "comando";
export const APT_ORIGIN = "Comando";
export const APT_LABEL = "Comando";
export const APT_DESCRIPTION = "Comando desktop Debian package repository";
export const APT_DEFAULT_SUITE = "stable";
export const APT_EXACT_PATH_SUITE = "./";
export const APT_DEFAULT_COMPONENT = "main";
export const APT_DEFAULT_CODENAME = "comando-stable";
export const APT_SUPPORTED_ARCHITECTURES = ["amd64", "arm64"];
export const APT_PUBLIC_KEY_FILE_NAME = "comando-archive-keyring.asc";
export const APT_SOURCES_EXAMPLE_FILE_NAME = "comando.sources.example";
export const APT_LAYOUT_FLAT_RELEASE = "flat-release";
export const APT_RELEASE_DOWNLOAD_BASE_URL =
    "https://github.com/jsgrrchg/Comando/releases/latest/download";
export const APT_PAGES_BASE_URL = "https://jsgrrchg.github.io/Comando/apt";

export const APT_RELEASE_CHECKSUMS = [
    { fieldName: "MD5Sum", hashKey: "MD5Sum", algorithm: "md5" },
    { fieldName: "SHA1", hashKey: "SHA1", algorithm: "sha1" },
    { fieldName: "SHA256", hashKey: "SHA256", algorithm: "sha256" },
];
export const APT_PACKAGE_CHECKSUMS = [
    { fieldName: "MD5sum", hashKey: "MD5Sum", algorithm: "md5" },
    { fieldName: "SHA1", hashKey: "SHA1", algorithm: "sha1" },
    { fieldName: "SHA256", hashKey: "SHA256", algorithm: "sha256" },
];

const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+$/u;
const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+)$/u;
const HASH_READ_BUFFER_SIZE_BYTES = 1024 * 1024;
const ELECTRON_BUILDER_ARCHITECTURE_BY_DEBIAN_ARCHITECTURE = {
    amd64: "x64",
    arm64: "arm64",
};
const DEBIAN_ARCHITECTURE_BY_ELECTRON_BUILDER_ARCHITECTURE = {
    x64: "amd64",
    arm64: "arm64",
};
const CONTROL_FIELD_ORDER = [
    "Package",
    "Version",
    "Architecture",
    "Maintainer",
    "Installed-Size",
    "Depends",
    "Recommends",
    "Suggests",
    "Conflicts",
    "Replaces",
    "Provides",
    "Section",
    "Priority",
    "Homepage",
    "Description",
];

export function normalizeReleaseVersion(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("Release version must be a non-empty string.");
    }

    const normalized = value.startsWith("v")
        ? normalizeReleaseTag(value)
        : value;
    if (!STRICT_SEMVER_RE.test(normalized)) {
        throw new Error(
            `Invalid release version "${value}". Expected X.Y.Z or tag vX.Y.Z.`,
        );
    }

    return normalized;
}

export function normalizeReleaseTag(tag) {
    const match = RELEASE_TAG_RE.exec(String(tag ?? "").trim());
    if (!match) {
        throw new Error(
            `Invalid release tag "${tag}". Expected format vX.Y.Z, for example v0.1.0.`,
        );
    }

    return match[1];
}

export function normalizeAptSuite(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized !== APT_DEFAULT_SUITE) {
        throw new Error(
            `Unsupported APT suite "${value}". Supported suite: ${APT_DEFAULT_SUITE}.`,
        );
    }
    return normalized;
}

export function normalizeAptComponent(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized !== APT_DEFAULT_COMPONENT) {
        throw new Error(
            `Unsupported APT component "${value}". Supported component: ${APT_DEFAULT_COMPONENT}.`,
        );
    }
    return normalized;
}

export function normalizeAptLayout(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized !== APT_LAYOUT_FLAT_RELEASE) {
        throw new Error(
            `Unsupported APT layout "${value}". Supported layout: ${APT_LAYOUT_FLAT_RELEASE}.`,
        );
    }
    return normalized;
}

export function normalizeDebianArchitecture(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!APT_SUPPORTED_ARCHITECTURES.includes(normalized)) {
        throw new Error(
            `Unsupported Debian architecture "${value}". Supported architectures: ${APT_SUPPORTED_ARCHITECTURES.join(", ")}.`,
        );
    }
    return normalized;
}

export function parseGitHubRepoSlug(repoSlug) {
    const normalized = String(repoSlug ?? "").trim();
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(normalized);
    if (!match) {
        throw new Error(
            `Invalid GitHub repository slug "${repoSlug}". Expected owner/repo.`,
        );
    }
    return { owner: match[1], repo: match[2] };
}

export function buildGitHubReleaseDownloadBaseUrl(repoSlug, tag = "latest") {
    const { owner, repo } = parseGitHubRepoSlug(repoSlug);
    const normalizedTag = String(tag ?? "").trim();
    if (normalizedTag === "latest") {
        return `https://github.com/${owner}/${repo}/releases/latest/download`;
    }
    const releaseTag = normalizedTag.startsWith("v")
        ? normalizedTag
        : `v${normalizeReleaseVersion(normalizedTag)}`;
    return `https://github.com/${owner}/${repo}/releases/download/${releaseTag}`;
}

export function buildDebianReleaseAssetName(version, debianArchitecture) {
    const normalizedVersion = normalizeReleaseVersion(version);
    const arch = normalizeDebianArchitecture(debianArchitecture);
    const electronBuilderArch =
        ELECTRON_BUILDER_ARCHITECTURE_BY_DEBIAN_ARCHITECTURE[arch];
    return `Comando-${normalizedVersion}-linux-${electronBuilderArch}.deb`;
}

export function parseDebianReleaseAssetName(fileName) {
    const match = /^Comando-(\d+\.\d+\.\d+)-linux-(x64|arm64)\.deb$/u.exec(
        String(fileName ?? ""),
    );
    if (!match) {
        return null;
    }

    return {
        architecture:
            DEBIAN_ARCHITECTURE_BY_ELECTRON_BUILDER_ARCHITECTURE[match[2]],
        version: match[1],
    };
}

export function normalizeAptBaseUrl(baseUrl) {
    const normalized = String(baseUrl ?? "").trim().replace(/\/+$/u, "");
    if (!normalized) {
        throw new Error("APT base URL must be a non-empty string.");
    }
    if (!/^https?:\/\//iu.test(normalized) && !normalized.startsWith("file:")) {
        throw new Error(
            `APT base URL must be an http(s) or file URL, received "${baseUrl}".`,
        );
    }
    return normalized;
}

export function buildComandoSourcesExample(
    baseUrl = APT_RELEASE_DOWNLOAD_BASE_URL,
    { suite = APT_EXACT_PATH_SUITE, component = null } = {},
) {
    const lines = [
        "Types: deb",
        `URIs: ${normalizeAptBaseUrl(baseUrl)}`,
        `Suites: ${suite}`,
    ];

    if (component) {
        lines.push(`Components: ${component}`);
    }

    lines.push(
        `Architectures: ${APT_SUPPORTED_ARCHITECTURES.join(" ")}`,
        `Signed-By: /etc/apt/keyrings/${APT_PACKAGE_NAME}.asc`,
        "",
    );

    return lines.join("\n");
}

export function parseDebianControlStanza(input) {
    const fields = [];
    let current = null;

    for (const rawLine of String(input ?? "").replace(/\r\n/gu, "\n").split("\n")) {
        if (!rawLine) {
            current = null;
            continue;
        }

        if (/^\s/u.test(rawLine)) {
            if (!current) {
                throw new Error(
                    `Invalid Debian control continuation without a field: ${rawLine}`,
                );
            }
            current.value = `${current.value}\n${rawLine}`;
            continue;
        }

        const separatorIndex = rawLine.indexOf(":");
        if (separatorIndex <= 0) {
            throw new Error(`Invalid Debian control field: ${rawLine}`);
        }

        current = {
            name: rawLine.slice(0, separatorIndex),
            value: rawLine.slice(separatorIndex + 1).replace(/^ /u, ""),
        };
        fields.push(current);
    }

    return fields;
}

export function parseDebianControlFile(input) {
    return String(input ?? "")
        .replace(/\r\n/gu, "\n")
        .split(/\n{2,}/u)
        .map((stanza) => stanza.trimEnd())
        .filter(Boolean)
        .map((stanza) => parseDebianControlStanza(`${stanza}\n`));
}

export function getDebianControlField(fields, fieldName) {
    const wanted = fieldName.toLowerCase();
    return (
        fields.find((field) => field.name.toLowerCase() === wanted)?.value ??
        null
    );
}

export function renderDebianControlFields(fields) {
    return `${fields
        .map((field) => `${field.name}: ${field.value}`)
        .join("\n")}\n`;
}

export function renderPackagesStanza({
    controlFields,
    filename,
    hashes,
    sizeBytes,
}) {
    const fieldsByName = new Map(
        controlFields.map((field) => [field.name.toLowerCase(), field]),
    );
    const renderedFields = [];

    for (const fieldName of CONTROL_FIELD_ORDER) {
        const field = fieldsByName.get(fieldName.toLowerCase());
        if (field) {
            renderedFields.push(field);
        }
    }

    for (const field of controlFields) {
        const isAlreadyRendered = renderedFields.some(
            (renderedField) =>
                renderedField.name.toLowerCase() === field.name.toLowerCase(),
        );
        const isRepositoryField = [
            "filename",
            "size",
            "md5sum",
            "sha1",
            "sha256",
        ].includes(field.name.toLowerCase());
        if (!isAlreadyRendered && !isRepositoryField) {
            renderedFields.push(field);
        }
    }

    renderedFields.push(
        { name: "Filename", value: filename },
        { name: "Size", value: String(sizeBytes) },
        { name: "MD5sum", value: hashes.MD5Sum },
        { name: "SHA1", value: hashes.SHA1 },
        { name: "SHA256", value: hashes.SHA256 },
    );

    return renderDebianControlFields(renderedFields);
}

export function buildAptReleaseContent({
    codename = APT_DEFAULT_CODENAME,
    component = null,
    date = new Date(),
    files,
    suite = APT_DEFAULT_SUITE,
} = {}) {
    const fields = [
        { name: "Origin", value: APT_ORIGIN },
        { name: "Label", value: APT_LABEL },
        { name: "Suite", value: suite },
        { name: "Codename", value: codename },
        { name: "Date", value: date.toUTCString() },
        {
            name: "Architectures",
            value: APT_SUPPORTED_ARCHITECTURES.join(" "),
        },
    ];

    if (component) {
        fields.push({ name: "Components", value: component });
    }

    fields.push({ name: "Description", value: APT_DESCRIPTION });

    for (const { fieldName, hashKey } of APT_RELEASE_CHECKSUMS) {
        fields.push({
            name: fieldName,
            value: files
                .map(
                    (file) =>
                        ` ${file.hashes[hashKey]} ${file.sizeBytes} ${file.relativePath}`,
                )
                .join("\n"),
        });
    }

    return renderDebianControlFields(fields);
}

export function hashFile(filePath, algorithm) {
    const hash = crypto.createHash(algorithm);
    const buffer = Buffer.allocUnsafe(HASH_READ_BUFFER_SIZE_BYTES);
    const fileDescriptor = fs.openSync(filePath, "r");

    try {
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(
                fileDescriptor,
                buffer,
                0,
                buffer.length,
                null,
            );
            if (bytesRead > 0) {
                hash.update(buffer.subarray(0, bytesRead));
            }
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fileDescriptor);
    }

    return hash.digest("hex");
}

export function getFileHashes(filePath) {
    return Object.fromEntries(
        APT_PACKAGE_CHECKSUMS.map(({ hashKey, algorithm }) => [
            hashKey,
            hashFile(filePath, algorithm),
        ]),
    );
}

export function listFilesRecursively(rootDir) {
    if (!fs.existsSync(rootDir)) {
        return [];
    }

    const entries = [];
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        const entryPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            entries.push(...listFilesRecursively(entryPath));
        } else if (entry.isFile()) {
            entries.push(entryPath);
        }
    }

    return entries;
}
