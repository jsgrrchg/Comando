export interface ParsedProjectFileReference {
    readonly endLine: number | null;
    readonly isAbsolute: boolean;
    readonly path: string;
    readonly startLine: number | null;
}

export interface ResolvedProjectFileReference extends ParsedProjectFileReference {
    readonly relativePath: string;
}

interface ResolveProjectFileReferenceOptions {
    readonly projectRoots: readonly (string | null | undefined)[];
}

interface CollectProjectFileRootsOptions {
    readonly canonicalProjectRoot?: string | null;
    readonly currentWorktreeRoot?: string | null;
    readonly projectRoot?: string | null;
    readonly repositoryCanonicalRoot?: string | null;
    readonly repositoryRoot?: string | null;
}

interface ParsedLineRange {
    readonly endLine: number | null;
    readonly path: string;
    readonly startLine: number | null;
}

const FILE_PROTOCOL = "file://";
const HASH_LINE_RE = /^#L?(\d+)(?:-L?(\d+))?$/;
const TRAILING_LINE_RE = /^(.*?):(\d+)(?:-(\d+))?(?::\d+)?$/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

export function isLikelyProjectFileReference(target: string): boolean {
    return parseProjectFileReference(target) !== null;
}

export function parseProjectFileReference(
    target: string,
): ParsedProjectFileReference | null {
    const trimmed = unwrapTarget(target);
    if (!trimmed) {
        return null;
    }

    const decodedTarget = decodeTarget(trimmed);
    if (!decodedTarget) {
        return null;
    }

    const parsedTarget = decodedTarget.toLowerCase().startsWith(FILE_PROTOCOL)
        ? parseFileUrlTarget(decodedTarget)
        : parsePlainTarget(decodedTarget);
    if (!parsedTarget) {
        return null;
    }

    const normalizedPath = parsedTarget.isAbsolute
        ? normalizeAbsolutePath(parsedTarget.path)
        : normalizeRelativePath(parsedTarget.path);
    if (!normalizedPath) {
        return null;
    }

    return {
        endLine: parsedTarget.endLine,
        isAbsolute: parsedTarget.isAbsolute,
        path: normalizedPath,
        startLine: parsedTarget.startLine,
    };
}

export function resolveProjectFileReference(
    target: string,
    options: ResolveProjectFileReferenceOptions,
): ResolvedProjectFileReference | null {
    const parsed = parseProjectFileReference(target);
    if (!parsed) {
        return null;
    }

    if (!parsed.isAbsolute) {
        if (
            parsed.path === ".." ||
            parsed.path.startsWith("../") ||
            parsed.path.length === 0
        ) {
            return null;
        }

        return {
            ...parsed,
            relativePath: parsed.path,
        };
    }

    const roots = uniqueNormalizedRoots(options.projectRoots);
    if (roots.length === 0) {
        return null;
    }

    for (const root of roots) {
        const candidate = stripRootPrefix(parsed.path, root);
        if (!candidate) {
            continue;
        }

        return {
            ...parsed,
            relativePath: candidate,
        };
    }

    return null;
}

export function collectProjectFileRoots(
    options: CollectProjectFileRootsOptions,
): string[] {
    const roots = new Set<string>();

    if (options.projectRoot) {
        roots.add(options.projectRoot);
    }
    if (options.canonicalProjectRoot) {
        roots.add(options.canonicalProjectRoot);
    }
    if (options.repositoryRoot) {
        roots.add(options.repositoryRoot);
    }
    if (options.repositoryCanonicalRoot) {
        roots.add(options.repositoryCanonicalRoot);
    }
    if (options.currentWorktreeRoot) {
        roots.add(options.currentWorktreeRoot);
    }

    return [...roots];
}

function decodeTarget(target: string): string | null {
    if (hasUnsupportedScheme(target)) {
        return null;
    }

    return safeDecodeURIComponent(target);
}

function hasUnsupportedScheme(target: string): boolean {
    if (WINDOWS_DRIVE_RE.test(target)) {
        return false;
    }

    const schemeMatch = target.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
    if (!schemeMatch) {
        return false;
    }

    return !target.toLowerCase().startsWith(FILE_PROTOCOL);
}

function parseFileUrlTarget(target: string): ParsedProjectFileReference | null {
    try {
        const url = new URL(target);
        const parsedHash = parseHashLineRange(url.hash);
        if (!parsedHash) {
            return null;
        }
        let path = `${url.host ? `//${url.host}` : ""}${safeDecodeURIComponent(
            url.pathname,
        )}`;

        if (/^\/[A-Za-z]:\//.test(path)) {
            path = path.slice(1);
        }

        return {
            endLine: parsedHash.endLine,
            isAbsolute: true,
            path,
            startLine: parsedHash.startLine,
        };
    } catch {
        return null;
    }
}

function parsePlainTarget(target: string): ParsedProjectFileReference | null {
    const hashIndex = target.indexOf("#");
    const hashValue = hashIndex >= 0 ? target.slice(hashIndex) : "";
    const pathPart = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const parsedHash = parseHashLineRange(hashValue);
    if (hashValue && parsedHash === null) {
        return null;
    }

    const parsedLine = parseTrailingLineRange(pathPart);
    const candidatePath = parsedLine.path;
    const isAbsolute = looksAbsolutePath(candidatePath);

    if (!isAbsolute && !looksLikeRelativeFilePath(candidatePath)) {
        return null;
    }

    return {
        endLine: parsedHash?.endLine ?? parsedLine.endLine,
        isAbsolute,
        path: candidatePath,
        startLine: parsedHash?.startLine ?? parsedLine.startLine,
    };
}

function parseHashLineRange(hash: string): ParsedLineRange | null {
    if (!hash) {
        return {
            endLine: null,
            path: "",
            startLine: null,
        };
    }

    const match = hash.match(HASH_LINE_RE);
    if (!match) {
        return null;
    }

    const startLine = Number(match[1]);
    const endLine = Number(match[2] ?? match[1]);

    return {
        endLine,
        path: "",
        startLine,
    };
}

function parseTrailingLineRange(target: string): ParsedLineRange {
    const match = target.match(TRAILING_LINE_RE);
    if (!match) {
        return {
            endLine: null,
            path: target,
            startLine: null,
        };
    }

    const path = match[1] ?? target;
    if (!path || path.endsWith("/")) {
        return {
            endLine: null,
            path: target,
            startLine: null,
        };
    }

    const startLine = Number(match[2]);
    const endLine = Number(match[3] ?? match[2]);

    return {
        endLine,
        path,
        startLine,
    };
}

function looksAbsolutePath(path: string): boolean {
    return (
        path.startsWith("/") ||
        WINDOWS_DRIVE_RE.test(path) ||
        path.startsWith("\\\\")
    );
}

function looksLikeRelativeFilePath(path: string): boolean {
    if (!path || /\s/.test(path.trim())) {
        return false;
    }

    if (path === "." || path === "..") {
        return false;
    }

    return (
        path.includes("/") ||
        path.includes("\\") ||
        path.startsWith("./") ||
        path.startsWith("../") ||
        path.includes(".")
    );
}

function unwrapTarget(target: string): string {
    const trimmed = target.trim();
    if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
        return trimmed.slice(1, -1).trim();
    }

    return trimmed;
}

function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function normalizeAbsolutePath(path: string): string | null {
    const normalized = path
        .replace(/\\/g, "/")
        .replace(/\/{2,}/g, "/")
        .replace(/\/+$/, "");

    if (!normalized) {
        return null;
    }

    if (/^\/[A-Za-z]:\//.test(normalized)) {
        return normalized.slice(1);
    }

    return normalized;
}

function normalizeRelativePath(path: string): string | null {
    const normalized = path
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/{2,}/g, "/")
        .replace(/\/+$/, "");

    if (!normalized || normalized === ".") {
        return null;
    }

    return normalized;
}

function uniqueNormalizedRoots(
    roots: readonly (string | null | undefined)[],
): string[] {
    const uniqueRoots = new Set<string>();

    for (const root of roots) {
        if (!root) {
            continue;
        }

        const normalized = normalizeAbsolutePath(root);
        if (!normalized) {
            continue;
        }

        uniqueRoots.add(normalized);
    }

    return [...uniqueRoots];
}

function stripRootPrefix(path: string, root: string): string | null {
    if (path === root) {
        return null;
    }

    const comparablePath = toComparableAbsolutePath(path);
    const comparableRoot = toComparableAbsolutePath(root);
    if (
        comparablePath !== comparableRoot &&
        !comparablePath.startsWith(`${comparableRoot}/`)
    ) {
        return null;
    }

    const relativePath = path.slice(root.length).replace(/^\/+/, "");
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized || normalized === ".." || normalized.startsWith("../")) {
        return null;
    }

    return normalized;
}

function toComparableAbsolutePath(path: string): string {
    if (WINDOWS_DRIVE_RE.test(path)) {
        return path.toLowerCase();
    }

    return path;
}
