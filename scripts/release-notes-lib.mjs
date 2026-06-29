import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, "..");
export const CHANGELOG_PATH = path.join(REPO_ROOT, "CHANGELOG.md");
export const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");

const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+$/u;
const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+)$/u;

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
    const match = RELEASE_TAG_RE.exec(tag);
    if (!match) {
        throw new Error(
            `Invalid release tag "${tag}". Expected format vX.Y.Z, for example v0.1.0.`,
        );
    }

    return match[1];
}

export function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readFile(filePath) {
    return fs.readFileSync(filePath, "utf8");
}

export function parseChangelogEntries(markdown) {
    const entries = [];
    let currentEntry = null;

    for (const line of markdown.split(/\r?\n/u)) {
        const headingMatch = /^## \[([^\]]+)\](?:\s*-\s*.+)?\s*$/u.exec(
            line,
        );
        if (headingMatch) {
            if (currentEntry) {
                entries.push(finalizeChangelogEntry(currentEntry));
            }

            currentEntry = {
                lines: [],
                version: headingMatch[1],
            };
            continue;
        }

        if (currentEntry) {
            currentEntry.lines.push(line);
        }
    }

    if (currentEntry) {
        entries.push(finalizeChangelogEntry(currentEntry));
    }

    return entries;
}

export function getChangelogEntry(markdown, version) {
    const normalizedVersion = normalizeReleaseVersion(version);
    return (
        parseChangelogEntries(markdown).find(
            (entry) => entry.version === normalizedVersion,
        ) ?? null
    );
}

export function extractChangelogReleaseNotes({
    changelogPath = CHANGELOG_PATH,
    version,
}) {
    const entry = getChangelogEntry(readFile(changelogPath), version);
    if (!entry) {
        throw new Error(
            `CHANGELOG.md does not contain a release entry for ${normalizeReleaseVersion(version)}.`,
        );
    }

    return entry.notes;
}

export function buildReleaseBody({
    notes,
    packageJson = readJsonFile(PACKAGE_JSON_PATH),
    version,
}) {
    const normalizedVersion = normalizeReleaseVersion(version);
    const releaseNotes = typeof notes === "string" ? notes.trim() : "";

    return [
        "## Manual installers",
        "",
        "Choose the installer that matches your machine:",
        "",
        renderManualDownloadTable({
            packageJson,
            version: normalizedVersion,
        }),
        "",
        "Linux packages are attached as direct downloads. APT and DNF repositories are not configured for this release.",
        "For portable Linux use, download the AppImage.",
        "",
        "Updater metadata is also attached to the release for in-app updates.",
        "Files ending in `.blockmap` or `.yml` are updater metadata and are not intended for manual installation.",
        "",
        "## Release notes",
        "",
        releaseNotes || "_No release notes were published for this version._",
        "",
    ].join("\n");
}

export function renderManualDownloadTable({ packageJson, version }) {
    const rows = buildManualDownloadRows({
        packageJson,
        version,
    });
    return [
        "| Platform | Architecture | Recommended download |",
        "| --- | --- | --- |",
        ...rows.map(
            (row) =>
                `| ${row.platformLabel} | ${row.architectureLabel} | \`${row.assetName}\` |`,
        ),
    ].join("\n");
}

export function buildManualDownloadRows({ packageJson, version }) {
    const productName = getProductName(packageJson);
    const normalizedVersion = normalizeReleaseVersion(version);

    return [
        {
            architectureLabel: "Universal",
            assetName: `${productName}-${normalizedVersion}-universal.dmg`,
            platformLabel: "macOS",
        },
        {
            architectureLabel: "x64",
            assetName: `${productName}-${normalizedVersion}-win-x64.exe`,
            platformLabel: "Windows",
        },
        {
            architectureLabel: "ARM64",
            assetName: `${productName}-${normalizedVersion}-win-arm64.exe`,
            platformLabel: "Windows",
        },
        {
            architectureLabel: "amd64",
            assetName: `${productName}-${normalizedVersion}-linux-x64.deb`,
            platformLabel: "Linux Ubuntu/Debian",
        },
        {
            architectureLabel: "arm64",
            assetName: `${productName}-${normalizedVersion}-linux-arm64.deb`,
            platformLabel: "Linux Ubuntu/Debian",
        },
        {
            architectureLabel: "x86_64",
            assetName: `${productName}-${normalizedVersion}-linux-x64.rpm`,
            platformLabel: "Linux Fedora/RHEL",
        },
        {
            architectureLabel: "aarch64",
            assetName: `${productName}-${normalizedVersion}-linux-arm64.rpm`,
            platformLabel: "Linux Fedora/RHEL",
        },
        {
            architectureLabel: "x64",
            assetName: `${productName}-${normalizedVersion}-linux-x64.AppImage`,
            platformLabel: "Linux AppImage",
        },
        {
            architectureLabel: "ARM64",
            assetName: `${productName}-${normalizedVersion}-linux-arm64.AppImage`,
            platformLabel: "Linux AppImage",
        },
    ];
}

function finalizeChangelogEntry(entry) {
    return {
        notes: trimNotes(entry.lines.join("\n")),
        version: entry.version,
    };
}

function getProductName(packageJson) {
    const productName = packageJson?.build?.productName ?? packageJson?.name;
    if (typeof productName !== "string" || !productName.trim()) {
        throw new Error("package.json must declare a product name.");
    }

    return productName.trim();
}

function trimNotes(value) {
    return value.replace(/^\s+|\s+$/gu, "");
}
