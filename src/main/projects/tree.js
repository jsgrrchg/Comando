import fs from "node:fs";
import path from "node:path";
import { resolveEditorLanguage } from "@shared/editor-language";
import { shouldIgnoreEntry } from "./ignore";
const DEFAULT_INLINE_EDITOR_MAX_BYTES = 4 * 1024 * 1024;
export function listProjectTreeChildren(options) {
    const absoluteDirectoryPath = resolveProjectPath(options.rootPath, options.parentRelativePath);
    const entries = fs
        .readdirSync(absoluteDirectoryPath, { withFileTypes: true })
        .filter((entry) => !shouldIgnoreEntry(entry.name, entry.isDirectory()))
        .sort(compareDirectoryEntries);
    return entries.map((entry) => {
        const relativePath = normalizeRelativePath(path.relative(options.rootPath, path.join(absoluteDirectoryPath, entry.name)));
        const kind = entry.isDirectory() ? "directory" : "file";
        return {
            id: `${options.projectId}:${relativePath}`,
            extension: kind === "file"
                ? path.extname(entry.name).slice(1) || null
                : null,
            gitStatus: kind === "directory"
                ? getDirectoryBadge(relativePath, options.gitSnapshot)
                : (options.gitSnapshot.exactBadges.get(relativePath) ??
                    null),
            hasChildren: kind === "directory"
                ? directoryHasVisibleChildren(path.join(absoluteDirectoryPath, entry.name))
                : false,
            kind,
            name: entry.name,
            parentRelativePath: options.parentRelativePath,
            relativePath,
        };
    });
}
export async function readProjectFile(options) {
    const absolutePath = resolveProjectPath(options.rootPath, options.relativePath);
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
    }
    else if (isTooLarge) {
        content = `This file is ${formatByteSize(stats.size)} and currently exceeds the ${formatByteSize(maxBytes)} inline editor limit.`;
    }
    else {
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
export async function writeProjectFile(options) {
    const absolutePath = resolveProjectPath(options.rootPath, options.relativePath);
    await fs.promises.writeFile(absolutePath, options.content, "utf8");
    return readProjectFile({
        projectId: options.projectId,
        relativePath: options.relativePath,
        rootPath: options.rootPath,
    });
}
export async function createProjectEntry(options) {
    const entryName = validateEntryName(options.name);
    const absoluteParentPath = resolveProjectPath(options.rootPath, options.parentRelativePath);
    const absolutePath = path.join(absoluteParentPath, entryName);
    if (options.kind === "directory") {
        await fs.promises.mkdir(absolutePath);
    }
    else {
        const handle = await fs.promises.open(absolutePath, "wx");
        await handle.close();
    }
    return {
        kind: options.kind,
        name: entryName,
        parentRelativePath: options.parentRelativePath,
        relativePath: normalizeRelativePath(path.relative(options.rootPath, absolutePath)),
    };
}
export async function renameProjectEntry(options) {
    const nextName = validateEntryName(options.nextName);
    const currentAbsolutePath = resolveProjectPath(options.rootPath, options.relativePath);
    const stats = await fs.promises.stat(currentAbsolutePath);
    const currentRelativePath = normalizeRelativePath(options.relativePath);
    const parentRelativePath = getParentRelativePath(currentRelativePath);
    const absoluteParentPath = resolveProjectPath(options.rootPath, parentRelativePath);
    const nextAbsolutePath = path.join(absoluteParentPath, nextName);
    const nextRelativePath = normalizeRelativePath(path.relative(options.rootPath, nextAbsolutePath));
    if (nextRelativePath !== currentRelativePath) {
        await fs.promises.rename(currentAbsolutePath, nextAbsolutePath);
    }
    return {
        kind: stats.isDirectory() ? "directory" : "file",
        name: nextName,
        parentRelativePath,
        relativePath: nextRelativePath,
    };
}
export async function deleteProjectEntry(options) {
    const absolutePath = resolveProjectPath(options.rootPath, options.relativePath);
    const stats = await fs.promises.stat(absolutePath);
    if (stats.isDirectory()) {
        await fs.promises.rm(absolutePath, { recursive: true });
        return;
    }
    await fs.promises.unlink(absolutePath);
}
export function normalizeRelativePath(relativePath) {
    return relativePath.split(path.sep).join("/");
}
export function resolveProjectPath(rootPath, relativePath) {
    const resolvedRoot = path.resolve(rootPath);
    if (!relativePath) {
        return resolvedRoot;
    }
    const candidatePath = path.resolve(resolvedRoot, relativePath);
    if (candidatePath !== resolvedRoot &&
        !candidatePath.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error("The requested path is outside of the project root.");
    }
    return candidatePath;
}
function directoryHasVisibleChildren(directoryPath) {
    try {
        const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
        return entries.some((entry) => !shouldIgnoreEntry(entry.name, entry.isDirectory()));
    }
    catch {
        return false;
    }
}
function compareDirectoryEntries(left, right) {
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
function getDirectoryBadge(directoryRelativePath, gitSnapshot) {
    for (const changedPath of gitSnapshot.changedPaths) {
        if (changedPath.startsWith(`${directoryRelativePath}/`)) {
            return "mixed";
        }
    }
    return gitSnapshot.exactBadges.get(directoryRelativePath) ?? null;
}
function bufferLooksBinary(buffer) {
    const maxInspectLength = Math.min(buffer.length, 4096);
    for (let index = 0; index < maxInspectLength; index += 1) {
        if (buffer[index] === 0) {
            return true;
        }
    }
    return false;
}
async function readProbeBuffer(absolutePath, byteLength) {
    const handle = await fs.promises.open(absolutePath, "r");
    try {
        const buffer = Buffer.alloc(byteLength);
        const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
        return buffer.subarray(0, bytesRead);
    }
    finally {
        await handle.close();
    }
}
function formatByteSize(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function validateEntryName(name) {
    const trimmedName = name.trim();
    if (!trimmedName) {
        throw new Error("Provide a name before continuing.");
    }
    if (trimmedName === "." ||
        trimmedName === ".." ||
        trimmedName.includes("/") ||
        trimmedName.includes("\\")) {
        throw new Error("Use a valid file or folder name.");
    }
    return trimmedName;
}
function getParentRelativePath(relativePath) {
    const parentPath = path.posix.dirname(relativePath);
    return parentPath === "." ? null : parentPath;
}
