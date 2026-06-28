import type { AiDiffHunk, AiTrackedFile } from "./ipc";
import {
    engineComputeDiffHunks,
    engineResolveTrackedFileHunks,
} from "./ai-review-engine/reviewEngine";

export function isAiTrackedFileUnresolved(file: AiTrackedFile): boolean {
    return file.reviewState === "pending" || file.reviewState === "conflict";
}

export function normalizeReviewText(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
        readonly hunks?: readonly AiDiffHunk[];
        readonly hunksAreAnchored?: boolean;
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
    const hunksAreAnchored =
        options.hunksAreAnchored ?? file.hunksAreAnchored === true;
    const hunks =
        options.hunks ??
        (hunksAreAnchored
            ? [...file.hunks]
            : canRecompute
              ? computeDiffHunks(diffBase, currentText, path)
              : [...file.hunks]);

    return {
        ...file,
        currentText,
        diffBase,
        hunks,
        hunksAreAnchored: hunksAreAnchored ? true : undefined,
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
    const anchoredHunks =
        syncedExistingTrackedFile.hunksAreAnchored === true &&
        syncedNextTrackedFile.hunksAreAnchored === true
            ? [
                  ...syncedExistingTrackedFile.hunks,
                  ...syncedNextTrackedFile.hunks,
              ]
            : undefined;
    const diffBase = getTrackedFileDiffBase(syncedExistingTrackedFile);
    const existingCurrent = getTrackedFileCurrentText(syncedExistingTrackedFile);
    const currentText = reconcileCurrentText({
        diffBase,
        existingCurrent,
        nextOldText: syncedNextTrackedFile.oldText ?? "",
        nextCurrent: getTrackedFileCurrentText(syncedNextTrackedFile),
    });
    const oldText = syncedExistingTrackedFile.oldText;
    // When we successfully spliced the next snippet onto the existing full
    // file, promote that reconciled text as the tracked newText so downstream
    // consumers (review tab, inline review) see the cumulative result instead
    // of only the last snippet.
    const newText =
        currentText !== getTrackedFileCurrentText(syncedNextTrackedFile)
            ? currentText
            : syncedNextTrackedFile.newText;
    const kind = inferTrackedFileKindFromTexts(previousPath, oldText, newText);
    const isNetNeutralMove =
        previousPath !== null && previousPath === syncedNextTrackedFile.path;

    if (
        normalizeReviewText(diffBase) === normalizeReviewText(currentText) &&
        (!previousPath || isNetNeutralMove)
    ) {
        return null;
    }

    return buildTrackedFile(syncedNextTrackedFile, {
        currentText,
        diffBase,
        hunks: anchoredHunks,
        hunksAreAnchored: anchoredHunks ? true : undefined,
        identityKey: syncedExistingTrackedFile.identityKey,
        kind,
        newText,
        oldText,
        previousPath,
        version:
            normalizeTrackedFileVersion(syncedExistingTrackedFile.version) + 1,
    });
}

/**
 * Reconcile an agent's second (or Nth) snippet edit onto the full file we
 * already have in memory. Without this, the backend would drop the existing
 * cumulative text and keep only the latest snippet, making the review show a
 * broken diff against the original file and losing the previous edit.
 *
 * Falls back to the raw next-text when the snippet is ambiguous, missing, or
 * when the next text is already a full-file replacement — no worse than the
 * old behavior.
 */
function reconcileCurrentText(params: {
    readonly diffBase: string;
    readonly existingCurrent: string;
    readonly nextOldText: string;
    readonly nextCurrent: string;
}): string {
    const { diffBase, existingCurrent, nextOldText, nextCurrent } = params;

    // Full-file replacements — trust the next text as the authoritative state.
    if (nextOldText === existingCurrent) return nextCurrent;
    if (nextOldText === diffBase) return nextCurrent;
    if (nextCurrent === existingCurrent) return nextCurrent;
    if (nextOldText.length === 0) return nextCurrent;

    const first = existingCurrent.indexOf(nextOldText);
    if (first === -1 || first !== existingCurrent.lastIndexOf(nextOldText)) {
        return nextCurrent;
    }

    return (
        existingCurrent.slice(0, first) +
        nextCurrent +
        existingCurrent.slice(first + nextOldText.length)
    );
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

    // The tracked file carries stable (anchored) hunk ids, but the engine
    // re-syncs to positional ids. The anchored hunks align 1:1 by position with
    // the engine's hunks, so translate the requested ids before resolving in
    // Rust (which owns applying the kept/rejected hunks to the text).
    const selectedIds = new Set(hunkIds);
    const engineHunks = engineComputeDiffHunks(
        getTrackedFileDiffBase(syncedTrackedFile),
        getTrackedFileCurrentText(syncedTrackedFile),
        syncedTrackedFile.path,
    );
    const engineIds = syncedTrackedFile.hunks.flatMap((hunk, index) =>
        selectedIds.has(hunk.id) && engineHunks[index]
            ? [engineHunks[index].id]
            : [],
    );
    if (engineIds.length === 0) {
        return syncedTrackedFile;
    }
    return engineResolveTrackedFileHunks(
        syncedTrackedFile,
        engineIds,
        decision,
        new Date().toISOString(),
    );
}

export function computeDiffHunks(
    oldText: string,
    newText: string,
    seed: string,
): readonly AiDiffHunk[] {
    return engineComputeDiffHunks(oldText, newText, seed);
}
