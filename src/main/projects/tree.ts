import fs from "node:fs";
import path from "node:path";

import type {
    GitStatusBadge,
    ProjectEntryKind,
    ProjectEntryMutationResult,
    ProjectFileDocument,
    ProjectTreeNode,
} from "@shared/ipc";
import { resolveEditorLanguage } from "@shared/editor-language";

import { debugBenignError } from "../observability/logging";
import { shouldIgnoreEntry } from "./ignore";

const DEFAULT_INLINE_EDITOR_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 12 * 1024 * 1024;

interface GitSnapshot {
    readonly changedPaths: readonly string[];
    readonly exactBadges: ReadonlyMap<string, GitStatusBadge>;
}

export class ProjectFileConflictError extends Error {
    constructor(relativePath: string) {
        super(
            `The file "${relativePath}" changed on disk. Reload it before saving.`,
        );
        this.name = "ProjectFileConflictError";
    }
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
    let entries: fs.Dirent[];

    try {
        entries = fs
            .readdirSync(absoluteDirectoryPath, { withFileTypes: true })
            .filter(
                (entry) => !shouldIgnoreEntry(entry.name, entry.isDirectory()),
            )
            .sort(compareDirectoryEntries);
    } catch (error) {
        if (isMissingProjectDirectoryError(error)) {
            debugBenignError("projects.listProjectTreeChildren", error);
            return [];
        }

        throw error;
    }

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
    const mimeType = resolveMimeType(absolutePath);
    const isImage = isImageMimeType(mimeType);
    const binaryProbe = await readProbeBuffer(absolutePath, 4096);
    const isBinary = isImage ? false : bufferLooksBinary(binaryProbe);
    const language = resolveEditorLanguage({
        filePath: absolutePath,
        probeContent: isBinary ? "" : binaryProbe.toString("utf8"),
    });

    let content: string;
    let imageDataBase64: string | null = null;
    let kind: ProjectFileDocument["kind"] = "text";

    if (isImage) {
        kind = "image";
        if (stats.size > IMAGE_PREVIEW_MAX_BYTES) {
            content = `This image is ${formatByteSize(stats.size)} and exceeds the ${formatByteSize(IMAGE_PREVIEW_MAX_BYTES)} preview limit.`;
        } else {
            imageDataBase64 = await fs.promises.readFile(
                absolutePath,
                "base64",
            );
            content = "Image preview ready.";
        }
    } else if (isBinary) {
        kind = "binary";
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
        imageDataBase64,
        isBinary,
        isTooLarge,
        kind,
        languageId: language.id,
        languageLabel: language.label,
        modifiedAtMs: stats.mtimeMs,
        mimeType,
        name: path.basename(absolutePath),
        projectId: options.projectId,
        relativePath: normalizeRelativePath(options.relativePath),
        sizeBytes: stats.size,
    };
}

export async function writeProjectFile(options: {
    readonly projectId: string;
    readonly rootPath: string;
    readonly relativePath: string;
    readonly content: string;
    readonly expectedModifiedAtMs?: number | null;
}): Promise<ProjectFileDocument> {
    const absolutePath = resolveProjectPath(
        options.rootPath,
        options.relativePath,
    );
    const stats = await fs.promises.stat(absolutePath);

    if (
        options.expectedModifiedAtMs !== undefined &&
        options.expectedModifiedAtMs !== null &&
        stats.mtimeMs !== options.expectedModifiedAtMs
    ) {
        throw new ProjectFileConflictError(options.relativePath);
    }

    await fs.promises.writeFile(absolutePath, options.content, "utf8");

    return readProjectFile({
        projectId: options.projectId,
        relativePath: options.relativePath,
        rootPath: options.rootPath,
    });
}

export async function createProjectEntry(options: {
    readonly kind: ProjectEntryKind;
    readonly name: string;
    readonly parentRelativePath: string | null;
    readonly rootPath: string;
}): Promise<ProjectEntryMutationResult> {
    const entryName = validateEntryName(options.name);
    const absoluteParentPath = resolveProjectPath(
        options.rootPath,
        options.parentRelativePath,
    );
    const absolutePath = path.join(absoluteParentPath, entryName);

    if (options.kind === "directory") {
        await fs.promises.mkdir(absolutePath);
    } else {
        const handle = await fs.promises.open(absolutePath, "wx");
        try {
            // File is created by `open(wx)`; nothing else to write.
        } finally {
            await handle.close();
        }
    }

    return {
        kind: options.kind,
        name: entryName,
        parentRelativePath: options.parentRelativePath,
        relativePath: normalizeRelativePath(
            path.relative(options.rootPath, absolutePath),
        ),
    };
}

export async function renameProjectEntry(options: {
    readonly nextName: string;
    readonly nextParentRelativePath?: string | null;
    readonly relativePath: string;
    readonly rootPath: string;
}): Promise<ProjectEntryMutationResult> {
    const nextName = validateEntryName(options.nextName);
    const currentAbsolutePath = resolveProjectPath(
        options.rootPath,
        options.relativePath,
    );
    const stats = await fs.promises.stat(currentAbsolutePath);
    const currentRelativePath = normalizeRelativePath(options.relativePath);
    const currentParentRelativePath =
        getParentRelativePath(currentRelativePath);
    const parentRelativePath =
        options.nextParentRelativePath === undefined
            ? currentParentRelativePath
            : normalizeOptionalRelativePath(options.nextParentRelativePath);

    if (
        stats.isDirectory() &&
        parentRelativePath &&
        (parentRelativePath === currentRelativePath ||
            parentRelativePath.startsWith(`${currentRelativePath}/`))
    ) {
        throw new Error("A folder cannot be moved inside itself.");
    }

    const absoluteParentPath = resolveProjectPath(
        options.rootPath,
        parentRelativePath,
    );
    const nextAbsolutePath = path.join(absoluteParentPath, nextName);
    const nextRelativePath = normalizeRelativePath(
        path.relative(options.rootPath, nextAbsolutePath),
    );

    if (nextRelativePath !== currentRelativePath) {
        if (
            currentRelativePath.toLowerCase() !== nextRelativePath.toLowerCase()
        ) {
            const existingStats = await statIfExists(nextAbsolutePath);
            if (existingStats) {
                throw new Error(
                    "An entry with the same name already exists in that location.",
                );
            }
        }

        await fs.promises.rename(currentAbsolutePath, nextAbsolutePath);
    }

    return {
        kind: stats.isDirectory() ? "directory" : "file",
        name: nextName,
        parentRelativePath,
        relativePath: nextRelativePath,
    };
}

export async function deleteProjectEntry(options: {
    readonly relativePath: string;
    readonly rootPath: string;
}): Promise<void> {
    const absolutePath = resolveProjectPath(
        options.rootPath,
        options.relativePath,
    );
    const stats = await fs.promises.stat(absolutePath);

    if (stats.isDirectory()) {
        await fs.promises.rm(absolutePath, { recursive: true });
        return;
    }

    await fs.promises.unlink(absolutePath);
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
    } catch (error) {
        debugBenignError("projects.directoryHasVisibleChildren", error);
        return false;
    }
}

function isMissingProjectDirectoryError(
    error: unknown,
): error is NodeJS.ErrnoException {
    return (
        error instanceof Error &&
        "code" in error &&
        ((error as NodeJS.ErrnoException).code === "ENOENT" ||
            (error as NodeJS.ErrnoException).code === "ENOTDIR")
    );
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

function resolveMimeType(filePath: string): string | null {
    const extension = path.extname(filePath).slice(1).toLowerCase();

    switch (extension) {
        case "avif":
            return "image/avif";
        case "gif":
            return "image/gif";
        case "jpeg":
        case "jpg":
            return "image/jpeg";
        case "png":
            return "image/png";
        case "svg":
            return "image/svg+xml";
        case "webp":
            return "image/webp";
        default:
            return null;
    }
}

function isImageMimeType(mimeType: string | null): boolean {
    return Boolean(mimeType?.startsWith("image/"));
}

function validateEntryName(name: string): string {
    const trimmedName = name.trim();
    if (!trimmedName) {
        throw new Error("Provide a name before continuing.");
    }

    if (
        trimmedName === "." ||
        trimmedName === ".." ||
        trimmedName.includes("/") ||
        trimmedName.includes("\\")
    ) {
        throw new Error("Use a valid file or folder name.");
    }

    return trimmedName;
}

function getParentRelativePath(relativePath: string): string | null {
    const parentPath = path.posix.dirname(relativePath);
    return parentPath === "." ? null : parentPath;
}

function normalizeOptionalRelativePath(
    relativePath: string | null,
): string | null {
    if (!relativePath) {
        return null;
    }

    return normalizeRelativePath(relativePath);
}

async function statIfExists(targetPath: string): Promise<fs.Stats | null> {
    try {
        return await fs.promises.stat(targetPath);
    } catch (error) {
        if (
            typeof error === "object" &&
            error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return null;
        }

        throw error;
    }
}
