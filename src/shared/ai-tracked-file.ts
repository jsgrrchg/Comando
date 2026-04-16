import type { AiDiffHunk, AiTrackedFile } from "./ipc";

function splitTextLines(text: string): string[] {
    if (text.length === 0) {
        return [];
    }

    return text.split("\n");
}

function buildVisualLineRange(
    startLine: number,
    lineCount: number,
    maxLine: number,
): {
    readonly endLine: number;
    readonly startLine: number;
} {
    const normalizedMaxLine = Math.max(maxLine, 1);
    const normalizedStartLine = Math.min(
        Math.max(startLine, 1),
        normalizedMaxLine,
    );
    const normalizedLineCount = Math.max(lineCount, 1);
    const normalizedEndLine = Math.min(
        normalizedStartLine + normalizedLineCount - 1,
        normalizedMaxLine,
    );

    return {
        endLine: normalizedEndLine,
        startLine: normalizedStartLine,
    };
}

function hasKnownTrackedFileBase(file: AiTrackedFile): boolean {
    return file.kind === "create" || file.oldText !== null;
}

function normalizeTrackedFileVersion(version: number | undefined): number {
    if (!Number.isFinite(version)) {
        return 1;
    }

    return Math.max(1, Math.trunc(version ?? 1));
}

export function getTrackedFileDiffBase(file: AiTrackedFile): string {
    if (typeof file.diffBase === "string") {
        return file.diffBase;
    }

    return file.oldText ?? "";
}

export function getTrackedFileCurrentText(file: AiTrackedFile): string {
    if (typeof file.currentText === "string") {
        return file.currentText;
    }

    return file.newText ?? "";
}

function isDiffReversible(
    kind: AiTrackedFile["kind"],
    oldText: string | null,
): boolean {
    if (kind === "create") {
        return true;
    }

    return oldText !== null;
}

function inferTrackedFileKindFromTexts(
    previousPath: string | null,
    oldText: string | null,
    newText: string | null,
): AiTrackedFile["kind"] {
    if (previousPath) {
        return "move";
    }

    if (oldText === null) {
        return "create";
    }

    if (newText === null) {
        return "delete";
    }

    return "update";
}

function buildTrackedFile(
    file: AiTrackedFile,
    options: {
        readonly currentText?: string;
        readonly diffBase?: string;
        readonly identityKey?: string;
        readonly kind?: AiTrackedFile["kind"];
        readonly newText?: string | null;
        readonly oldText?: string | null;
        readonly path?: string;
        readonly previousPath?: string | null;
        readonly updatedAt?: string;
        readonly version?: number;
    } = {},
): AiTrackedFile {
    const path = options.path ?? file.path;
    const diffBase = options.diffBase ?? getTrackedFileDiffBase(file);
    const currentText = options.currentText ?? getTrackedFileCurrentText(file);
    const oldText =
        options.oldText === undefined ? file.oldText : options.oldText;
    const newText =
        options.newText === undefined ? file.newText : options.newText;
    const rawPreviousPath =
        options.previousPath === undefined
            ? file.previousPath
            : options.previousPath;
    const previousPath =
        rawPreviousPath !== null && rawPreviousPath === path
            ? null
            : rawPreviousPath;
    const kind =
        options.kind ??
        inferTrackedFileKindFromTexts(previousPath, oldText, newText);
    const canRecompute = kind === "create" || oldText !== null;

    return {
        ...file,
        currentText,
        diffBase,
        hunks: canRecompute
            ? computeDiffHunks(diffBase, currentText, path)
            : [...file.hunks],
        identityKey: options.identityKey ?? file.identityKey,
        kind,
        newText,
        oldText,
        path,
        previousPath,
        reversible: isDiffReversible(kind, oldText),
        updatedAt: options.updatedAt ?? file.updatedAt,
        version: normalizeTrackedFileVersion(options.version ?? file.version),
    };
}

// Cache keyed by the AiTrackedFile reference. Tracked files are treated as
// immutable snapshots (any patch replaces the object whole), so the synced
// result is deterministic per input reference. Without this cache, every
// selector that calls collectPendingTrackedFilesFromSessions recomputes diff
// hunks for every pending file on every store update.
const syncedTrackedFileCache = new WeakMap<AiTrackedFile, AiTrackedFile>();

export function syncTrackedFile(file: AiTrackedFile): AiTrackedFile {
    const cached = syncedTrackedFileCache.get(file);
    if (cached) {
        return cached;
    }

    const synced = buildTrackedFile(file);
    syncedTrackedFileCache.set(file, synced);
    // A file that is already in its synced form should also resolve to itself
    // on subsequent calls to avoid a second cache miss when that output
    // re-enters syncTrackedFile (e.g. through mergePendingTrackedFile).
    syncedTrackedFileCache.set(synced, synced);
    return synced;
}

function findTrackedFile(
    trackedFiles: readonly AiTrackedFile[],
    nextTrackedFile: AiTrackedFile,
): AiTrackedFile | undefined {
    return (
        trackedFiles.find(
            (trackedFile) => trackedFile.path === nextTrackedFile.path,
        ) ??
        (nextTrackedFile.previousPath
            ? trackedFiles.find(
                  (trackedFile) =>
                      trackedFile.path === nextTrackedFile.previousPath,
              )
            : undefined) ??
        trackedFiles.find(
            (trackedFile) =>
                trackedFile.identityKey === nextTrackedFile.identityKey,
        ) ??
        (nextTrackedFile.previousPath
            ? trackedFiles.find(
                  (trackedFile) =>
                      trackedFile.previousPath === nextTrackedFile.previousPath,
              )
            : undefined)
    );
}

function canMergePendingTrackedFiles(
    existingTrackedFile: AiTrackedFile,
    nextTrackedFile: AiTrackedFile,
): boolean {
    if (
        existingTrackedFile.reviewState !== "pending" ||
        nextTrackedFile.reviewState !== "pending" ||
        !existingTrackedFile.isText ||
        !nextTrackedFile.isText ||
        existingTrackedFile.sessionId !== nextTrackedFile.sessionId
    ) {
        return false;
    }

    if (!hasKnownTrackedFileBase(existingTrackedFile)) {
        return false;
    }

    if (
        existingTrackedFile.previousPath &&
        nextTrackedFile.previousPath &&
        existingTrackedFile.previousPath !== nextTrackedFile.previousPath &&
        existingTrackedFile.path !== nextTrackedFile.previousPath
    ) {
        return false;
    }

    return true;
}

function mergePendingTrackedFile(
    existingTrackedFile: AiTrackedFile | undefined,
    nextTrackedFile: AiTrackedFile,
): AiTrackedFile | null {
    const syncedNextTrackedFile = syncTrackedFile(nextTrackedFile);
    if (!existingTrackedFile) {
        return syncedNextTrackedFile;
    }

    const syncedExistingTrackedFile = syncTrackedFile(existingTrackedFile);
    if (
        !canMergePendingTrackedFiles(
            syncedExistingTrackedFile,
            syncedNextTrackedFile,
        )
    ) {
        return syncedNextTrackedFile;
    }

    const previousPath =
        syncedExistingTrackedFile.previousPath ??
        syncedNextTrackedFile.previousPath;
    const diffBase = getTrackedFileDiffBase(syncedExistingTrackedFile);
    const currentText = getTrackedFileCurrentText(syncedNextTrackedFile);
    const oldText = syncedExistingTrackedFile.oldText;
    const newText = syncedNextTrackedFile.newText;
    const kind = inferTrackedFileKindFromTexts(previousPath, oldText, newText);
    const isNetNeutralMove =
        previousPath !== null && previousPath === syncedNextTrackedFile.path;

    if (diffBase === currentText && (!previousPath || isNetNeutralMove)) {
        return null;
    }

    return buildTrackedFile(syncedNextTrackedFile, {
        currentText,
        diffBase,
        identityKey: syncedExistingTrackedFile.identityKey,
        kind,
        newText,
        oldText,
        previousPath,
        version:
            normalizeTrackedFileVersion(syncedExistingTrackedFile.version) + 1,
    });
}

export function replaceTrackedFile(
    trackedFiles: readonly AiTrackedFile[],
    path: string,
    nextTrackedFile: AiTrackedFile | null,
): readonly AiTrackedFile[] {
    const nextTrackedFiles = trackedFiles.filter(
        (trackedFile) => trackedFile.path !== path,
    );
    if (!nextTrackedFile) {
        return nextTrackedFiles;
    }

    return [...nextTrackedFiles, nextTrackedFile];
}

export function upsertTrackedFile(
    trackedFiles: readonly AiTrackedFile[],
    nextTrackedFile: AiTrackedFile,
): readonly AiTrackedFile[] {
    const existingTrackedFile = findTrackedFile(trackedFiles, nextTrackedFile);
    const mergedTrackedFile = mergePendingTrackedFile(
        existingTrackedFile,
        nextTrackedFile,
    );

    return replaceTrackedFile(
        trackedFiles,
        existingTrackedFile?.path ?? nextTrackedFile.path,
        mergedTrackedFile,
    );
}

function finalizeTrackedTextSide(
    originalValue: string | null,
    nextValue: string,
): string | null {
    if (originalValue === null && nextValue.length === 0) {
        return null;
    }

    return nextValue;
}

export function resolveTrackedFileHunks(
    trackedFile: AiTrackedFile,
    hunkIds: readonly string[],
    decision: "keep" | "reject",
): AiTrackedFile | null {
    const syncedTrackedFile = syncTrackedFile(trackedFile);
    if (
        hunkIds.length === 0 ||
        !syncedTrackedFile.isText ||
        syncedTrackedFile.hunks.length === 0
    ) {
        return syncedTrackedFile;
    }

    const selectedIds = new Set(hunkIds);
    const selectedHunks = syncedTrackedFile.hunks.filter((hunk) =>
        selectedIds.has(hunk.id),
    );
    if (selectedHunks.length === 0) {
        return syncedTrackedFile;
    }

    const baseOldText = getTrackedFileDiffBase(syncedTrackedFile);
    const baseNewText = getTrackedFileCurrentText(syncedTrackedFile);
    const remainingHunks = syncedTrackedFile.hunks.filter(
        (hunk) => !selectedIds.has(hunk.id),
    );
    const nextDiffBase =
        decision === "keep"
            ? applyHunksToBase(baseOldText, selectedHunks)
            : baseOldText;
    const nextCurrentText =
        decision === "keep"
            ? baseNewText
            : applyHunksToBase(baseOldText, remainingHunks);

    if (nextDiffBase === nextCurrentText && !syncedTrackedFile.previousPath) {
        return null;
    }

    const nextOldText = finalizeTrackedTextSide(
        syncedTrackedFile.oldText,
        nextDiffBase,
    );
    const nextNewText = finalizeTrackedTextSide(
        syncedTrackedFile.newText,
        nextCurrentText,
    );

    return buildTrackedFile(syncedTrackedFile, {
        currentText: nextCurrentText,
        diffBase: nextDiffBase,
        kind: inferTrackedFileKindFromTexts(
            syncedTrackedFile.previousPath,
            nextOldText,
            nextNewText,
        ),
        newText: nextNewText,
        oldText: nextOldText,
        updatedAt: new Date().toISOString(),
        version: normalizeTrackedFileVersion(syncedTrackedFile.version) + 1,
    });
}

function applyHunksToBase(
    baseText: string,
    hunks: readonly AiDiffHunk[],
): string {
    const baseLines = splitTextLines(baseText);
    const output: string[] = [];
    let cursor = 0;

    for (const hunk of [...hunks].sort(
        (left, right) => left.oldStart - right.oldStart,
    )) {
        const startIndex = Math.max(hunk.oldStart - 1, cursor);
        output.push(...baseLines.slice(cursor, startIndex));
        let localCursor = startIndex;

        for (const line of hunk.lines) {
            if (line.type === "context") {
                if (localCursor < baseLines.length) {
                    output.push(baseLines[localCursor] ?? "");
                    localCursor += 1;
                }
                continue;
            }

            if (line.type === "remove") {
                localCursor += 1;
                continue;
            }

            output.push(line.text);
        }

        cursor = Math.max(cursor, localCursor);
    }

    output.push(...baseLines.slice(cursor));
    return output.join("\n");
}

export function computeDiffHunks(
    oldText: string,
    newText: string,
    seed: string,
): readonly AiDiffHunk[] {
    const oldLines = splitTextLines(oldText);
    const newLines = splitTextLines(newText);
    const maxVisualLine = Math.max(newLines.length, 1);

    const matrix = Array.from(
        { length: oldLines.length + 1 },
        () => new Uint32Array(newLines.length + 1),
    );

    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
            matrix[oldIndex][newIndex] =
                oldLines[oldIndex] === newLines[newIndex]
                    ? matrix[oldIndex + 1][newIndex + 1] + 1
                    : Math.max(
                          matrix[oldIndex + 1][newIndex],
                          matrix[oldIndex][newIndex + 1],
                      );
        }
    }

    const operations: Array<{
        readonly text: string;
        readonly type: "add" | "context" | "remove";
    }> = [];
    let oldIndex = 0;
    let newIndex = 0;

    while (oldIndex < oldLines.length && newIndex < newLines.length) {
        if (oldLines[oldIndex] === newLines[newIndex]) {
            operations.push({ text: oldLines[oldIndex], type: "context" });
            oldIndex += 1;
            newIndex += 1;
            continue;
        }

        if (matrix[oldIndex + 1][newIndex] >= matrix[oldIndex][newIndex + 1]) {
            operations.push({ text: oldLines[oldIndex], type: "remove" });
            oldIndex += 1;
            continue;
        }

        operations.push({ text: newLines[newIndex], type: "add" });
        newIndex += 1;
    }

    while (oldIndex < oldLines.length) {
        operations.push({ text: oldLines[oldIndex], type: "remove" });
        oldIndex += 1;
    }
    while (newIndex < newLines.length) {
        operations.push({ text: newLines[newIndex], type: "add" });
        newIndex += 1;
    }

    const hunks: AiDiffHunk[] = [];
    let pendingLines: Array<{
        readonly id: string;
        readonly text: string;
        readonly type: "add" | "context" | "remove";
    }> = [];
    let pendingOldStart = 1;
    let pendingNewStart = 1;
    let pendingOldCount = 0;
    let pendingNewCount = 0;
    let currentOldLine = 1;
    let currentNewLine = 1;

    const flushPending = () => {
        if (pendingLines.length === 0) {
            return;
        }

        const visualRange = buildVisualLineRange(
            pendingNewStart,
            pendingNewCount,
            maxVisualLine,
        );

        hunks.push({
            id: `${seed}:${pendingOldStart}:${pendingNewStart}:${hunks.length}`,
            lines: pendingLines,
            newCount: pendingNewCount,
            newStart: pendingNewStart,
            oldCount: pendingOldCount,
            oldStart: pendingOldStart,
            visualEndLine: visualRange.endLine,
            visualStartLine: visualRange.startLine,
        });
        pendingLines = [];
        pendingOldCount = 0;
        pendingNewCount = 0;
    };

    for (const operation of operations) {
        if (operation.type === "context") {
            flushPending();
            currentOldLine += 1;
            currentNewLine += 1;
            continue;
        }

        if (pendingLines.length === 0) {
            pendingOldStart = currentOldLine;
            pendingNewStart = currentNewLine;
        }

        pendingLines.push({
            id: `line:${seed}:${pendingOldStart}:${pendingNewStart}:${pendingLines.length}`,
            text: operation.text,
            type: operation.type,
        });

        if (operation.type !== "add") {
            pendingOldCount += 1;
            currentOldLine += 1;
        }
        if (operation.type !== "remove") {
            pendingNewCount += 1;
            currentNewLine += 1;
        }
    }

    flushPending();
    return hunks;
}
