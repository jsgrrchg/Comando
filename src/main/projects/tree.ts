import fs from "node:fs";
import path from "node:path";

import type {
    GitStatusBadge,
    ProjectFileDocument,
    ProjectTreeNode,
} from "@shared/ipc";
import { resolveEditorLanguage } from "@shared/editor-language";

import { shouldIgnoreEntry } from "./ignore";

const DEFAULT_INLINE_EDITOR_MAX_BYTES = 4 * 1024 * 1024;

interface GitSnapshot {
    readonly changedPaths: readonly string[];
    readonly exactBadges: ReadonlyMap<string, GitStatusBadge>;
}

export function listProjectTreeChildren(options: {
    readonly projectId: string;
    readonly rootPath: string;
    readonly parentRelativePath: string | null;
    readonly gitSnapshot: GitSnapshot;
}): ProjectTreeNode[] {
    const absoluteDirectoryPath = resolveProjectPath(
        options.rootPath,
        options.parentRelativePath,
    );
    const entries = fs
        .readdirSync(absoluteDirectoryPath, { withFileTypes: true })
        .filter((entry) => !shouldIgnoreEntry(entry.name, entry.isDirectory()))
        .sort(compareDirectoryEntries);

    return entries.map((entry) => {
        const relativePath = normalizeRelativePath(
            path.relative(
                options.rootPath,
                path.join(absoluteDirectoryPath, entry.name),
            ),
        );
        const kind = entry.isDirectory() ? "directory" : "file";

        return {
            id: `${options.projectId}:${relativePath}`,
            extension:
                kind === "file"
                    ? path.extname(entry.name).slice(1) || null
                    : null,
            gitStatus:
                kind === "directory"
                    ? getDirectoryBadge(relativePath, options.gitSnapshot)
                    : (options.gitSnapshot.exactBadges.get(relativePath) ??
                      null),
            hasChildren:
                kind === "directory"
                    ? directoryHasVisibleChildren(
                          path.join(absoluteDirectoryPath, entry.name),
                      )
                    : false,
            kind,
            name: entry.name,
            parentRelativePath: options.parentRelativePath,
            relativePath,
        };
    });
}

export async function readProjectFile(options: {
    readonly projectId: string;
    readonly rootPath: string;
    readonly relativePath: string;
    readonly maxBytes?: number;
}): Promise<ProjectFileDocument> {
    const absolutePath = resolveProjectPath(
        options.rootPath,
        options.relativePath,
    );
    const maxBytes = options.maxBytes ?? DEFAULT_INLINE_EDITOR_MAX_BYTES;
    const stats = await fs.promises.stat(absolutePath);
    const isTooLarge = stats.size > maxBytes;
    const binaryProbe = await readProbeBuffer(absolutePath, 4096);
    const isBinary = bufferLooksBinary(binaryProbe);
    const language = resolveEditorLanguage({
        filePath: absolutePath,
        probeContent: isBinary ? "" : binaryProbe.toString("utf8"),
    });

    let content = "";
    if (isBinary) {
        content =
            "Binary file preview is not available yet. Open it in the system editor if you need the raw bytes.";
    } else if (isTooLarge) {
        content = `This file is ${formatByteSize(stats.size)} and currently exceeds the ${formatByteSize(maxBytes)} inline editor limit.`;
    } else {
        content = await fs.promises.readFile(absolutePath, "utf8");
    }

    return {
        absolutePath,
        content,
        isBinary,
        isTooLarge,
        languageId: language.id,
        languageLabel: language.label,
        name: path.basename(absolutePath),
        projectId: options.projectId,
        relativePath: normalizeRelativePath(options.relativePath),
    };
}

export async function writeProjectFile(options: {
    readonly projectId: string;
    readonly rootPath: string;
    readonly relativePath: string;
    readonly content: string;
}): Promise<ProjectFileDocument> {
    const absolutePath = resolveProjectPath(
        options.rootPath,
        options.relativePath,
    );
    await fs.promises.writeFile(absolutePath, options.content, "utf8");

    return readProjectFile({
        projectId: options.projectId,
        relativePath: options.relativePath,
        rootPath: options.rootPath,
    });
}

export function normalizeRelativePath(relativePath: string): string {
    return relativePath.split(path.sep).join("/");
}

export function resolveProjectPath(
    rootPath: string,
    relativePath: string | null,
): string {
    const resolvedRoot = path.resolve(rootPath);

    if (!relativePath) {
        return resolvedRoot;
    }

    const candidatePath = path.resolve(resolvedRoot, relativePath);
    if (
        candidatePath !== resolvedRoot &&
        !candidatePath.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
        throw new Error("The requested path is outside of the project root.");
    }

    return candidatePath;
}

function directoryHasVisibleChildren(directoryPath: string): boolean {
    try {
        const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
        return entries.some(
            (entry) => !shouldIgnoreEntry(entry.name, entry.isDirectory()),
        );
    } catch {
        return false;
    }
}

function compareDirectoryEntries(left: fs.Dirent, right: fs.Dirent): number {
    if (left.isDirectory() && !right.isDirectory()) {
        return -1;
    }

    if (!left.isDirectory() && right.isDirectory()) {
        return 1;
    }

    return left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
    });
}

function getDirectoryBadge(
    directoryRelativePath: string,
    gitSnapshot: GitSnapshot,
): GitStatusBadge | null {
    for (const changedPath of gitSnapshot.changedPaths) {
        if (changedPath.startsWith(`${directoryRelativePath}/`)) {
            return "mixed";
        }
    }

    return gitSnapshot.exactBadges.get(directoryRelativePath) ?? null;
}

function bufferLooksBinary(buffer: Buffer): boolean {
    const maxInspectLength = Math.min(buffer.length, 4096);
    for (let index = 0; index < maxInspectLength; index += 1) {
        if (buffer[index] === 0) {
            return true;
        }
    }

    return false;
}

async function readProbeBuffer(
    absolutePath: string,
    byteLength: number,
): Promise<Buffer> {
    const handle = await fs.promises.open(absolutePath, "r");

    try {
        const buffer = Buffer.alloc(byteLength);
        const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

function formatByteSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
