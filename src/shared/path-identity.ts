export type PathIdentityPlatform = "posix" | "win32";

export interface PathIdentityOptions {
    readonly platform?: PathIdentityPlatform;
    readonly basePath?: string;
}

interface NormalizedPathParts {
    readonly root: string;
    readonly segments: readonly string[];
}

export function normalizePathKey(
    filePath: string,
    options: PathIdentityOptions = {},
): string {
    const platform = options.platform ?? inferPathPlatform(filePath);
    const parts = normalizePathParts(filePath, platform, options.basePath);
    return formatPathKey(parts, platform);
}

export function isSameOrInsidePath(
    candidatePath: string,
    containerPath: string,
    options: PathIdentityOptions = {},
): boolean {
    const platform =
        options.platform ?? inferPathPlatform(candidatePath, containerPath);
    const candidateKey = normalizePathKey(candidatePath, {
        ...options,
        platform,
    });
    const containerKey = normalizePathKey(containerPath, {
        ...options,
        platform,
    });

    if (candidateKey === containerKey) {
        return true;
    }

    const containerPrefix = containerKey.endsWith("/")
        ? containerKey
        : `${containerKey}/`;
    return candidateKey.startsWith(containerPrefix);
}

export function toDisplayRelativePath(
    candidatePath: string,
    containerPath: string,
    options: PathIdentityOptions = {},
): string {
    const platform =
        options.platform ?? inferPathPlatform(candidatePath, containerPath);
    const candidateParts = normalizePathParts(
        candidatePath,
        platform,
        options.basePath,
    );
    const containerParts = normalizePathParts(
        containerPath,
        platform,
        options.basePath,
    );

    if (!hasSameRoot(candidateParts, containerParts, platform)) {
        return formatDisplayPath(candidateParts);
    }

    if (
        candidateParts.segments.length < containerParts.segments.length ||
        !containerParts.segments.every((segment, index) =>
            isSameSegment(segment, candidateParts.segments[index], platform),
        )
    ) {
        return formatDisplayPath(candidateParts);
    }

    return candidateParts.segments
        .slice(containerParts.segments.length)
        .join("/");
}

function normalizePathParts(
    filePath: string,
    platform: PathIdentityPlatform,
    basePath?: string,
): NormalizedPathParts {
    const pathText = normalizeInputPath(filePath, platform);
    const resolvedPath =
        basePath && !isAbsolutePath(pathText, platform)
            ? joinPathText(normalizeInputPath(basePath, platform), pathText)
            : pathText;
    const { root, rest } = splitRoot(resolvedPath, platform);
    const segments = normalizeSegments(rest.split("/"), Boolean(root));

    return { root, segments };
}

function normalizeInputPath(
    filePath: string,
    platform: PathIdentityPlatform,
): string {
    const normalized =
        platform === "win32" ? stripExtendedWindowsPrefix(filePath) : filePath;
    const separated =
        platform === "win32" ? normalized.replace(/\\/g, "/") : normalized;

    if (platform === "win32" && separated.startsWith("//")) {
        return `//${separated.slice(2).replace(/\/+/g, "/")}`;
    }

    return separated.replace(/\/+/g, "/");
}

function stripExtendedWindowsPrefix(filePath: string): string {
    const pathText = filePath.replace(/\\/g, "/");
    if (pathText.startsWith("//?/UNC/")) {
        return `//${pathText.slice("//?/UNC/".length)}`;
    }

    if (pathText.startsWith("//?/")) {
        return pathText.slice("//?/".length);
    }

    return filePath;
}

function splitRoot(
    pathText: string,
    platform: PathIdentityPlatform,
): { root: string; rest: string } {
    if (platform === "win32") {
        const uncMatch = pathText.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
        if (uncMatch) {
            return {
                root: `//${uncMatch[1]}/${uncMatch[2]}`,
                rest: uncMatch[3] ?? "",
            };
        }

        const driveMatch = pathText.match(/^([a-zA-Z]:)(?:\/(.*))?$/);
        if (driveMatch) {
            return { root: `${driveMatch[1]}/`, rest: driveMatch[2] ?? "" };
        }
    }

    if (pathText.startsWith("/")) {
        return { root: "/", rest: pathText.slice(1) };
    }

    return { root: "", rest: pathText };
}

function normalizeSegments(
    segments: readonly string[],
    isRooted: boolean,
): string[] {
    const normalized: string[] = [];

    for (const segment of segments) {
        if (!segment || segment === ".") {
            continue;
        }

        if (segment === "..") {
            if (normalized.length > 0) {
                normalized.pop();
            } else if (!isRooted) {
                normalized.push(segment);
            }
            continue;
        }

        normalized.push(segment);
    }

    return normalized;
}

function formatPathKey(
    parts: NormalizedPathParts,
    platform: PathIdentityPlatform,
): string {
    const displayPath = formatDisplayPath(parts);
    return platform === "win32" ? displayPath.toLowerCase() : displayPath;
}

function formatDisplayPath(parts: NormalizedPathParts): string {
    if (!parts.root) {
        return parts.segments.join("/");
    }

    if (parts.root === "/") {
        return parts.segments.length > 0 ? `/${parts.segments.join("/")}` : "/";
    }

    if (parts.root.endsWith("/")) {
        return `${parts.root}${parts.segments.join("/")}`.replace(/\/$/, "/");
    }

    return parts.segments.length > 0
        ? `${parts.root}/${parts.segments.join("/")}`
        : parts.root;
}

function hasSameRoot(
    left: NormalizedPathParts,
    right: NormalizedPathParts,
    platform: PathIdentityPlatform,
): boolean {
    return platform === "win32"
        ? left.root.toLowerCase() === right.root.toLowerCase()
        : left.root === right.root;
}

function isSameSegment(
    left: string,
    right: string | undefined,
    platform: PathIdentityPlatform,
): boolean {
    if (right === undefined) {
        return false;
    }

    return platform === "win32"
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

function isAbsolutePath(
    pathText: string,
    platform: PathIdentityPlatform,
): boolean {
    if (platform === "win32") {
        return /^([a-zA-Z]:\/|\/\/[^/]+\/[^/]+)/.test(pathText);
    }

    return pathText.startsWith("/");
}

function joinPathText(basePath: string, relativePath: string): string {
    if (!basePath) {
        return relativePath;
    }

    return `${basePath.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

function inferPathPlatform(
    ...paths: readonly string[]
): PathIdentityPlatform {
    return paths.some((pathText) =>
        /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(pathText) ||
        pathText.includes("\\"),
    )
        ? "win32"
        : "posix";
}
