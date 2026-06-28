import {
    computeDiffHunks,
    getTrackedFileCurrentText,
    getTrackedFileDiffBase,
    normalizeReviewText,
    resolveTrackedFileHunks,
    syncTrackedFile,
} from "./ai-tracked-file";
import type {
    AiFileDiff,
    AiSessionEventOrigin,
    AiTrackedFile,
} from "./ipc";

// ---------------------------------------------------------------------------
// Single-source-of-truth review action log.
//
// The action log is the ONLY owner of pending review state. It stores tracked
// files keyed by identity; each file carries an evolving `diffBase` and the
// `currentText` the agent last produced. The visible diff is always
// `diffBase -> currentText`.
//
// The crucial invariant — and the reason accepted work never reappears — is
// that `diffBase` evolves on accept (keep folds the accepted hunks into the
// base) and ingestion of a fresh runtime diff for a KNOWN file reuses that
// accumulated `diffBase`, ignoring the runtime's stale `oldText`. There is no
// settle bookkeeping, no per-range projection, and no second store to
// reconcile against: the file itself is the baseline.
//
// A resolved file is retained (hidden) with `diffBase === currentText` rather
// than deleted, so a runtime that re-emits it on a later turn reconciles
// against the resolved text instead of re-proposing it. This is what makes the
// log robust across the different ACP runtimes Comando drives.
// ---------------------------------------------------------------------------

export interface AiReviewActionLogState {
    readonly schemaVersion: 2;
    readonly sessionId: string;
    readonly updatedAt: string;
    readonly trackedFilesByIdentityKey: Readonly<Record<string, AiTrackedFile>>;
    readonly fileOrder: readonly string[];
    readonly activeWorkCycleId: string | null;
}

export interface AiReviewDiffConsolidationContext {
    readonly origin?: AiSessionEventOrigin;
    readonly sessionId?: string;
    readonly toolCallId?: string | null;
    readonly updatedAt?: string;
    readonly workCycleId?: string | null;
}

export interface AiReviewActionLogTarget {
    readonly expectedVersion?: number;
    readonly path: string;
    readonly sessionId: string;
    readonly trackedFileId?: string | null;
}

type AiFileDiffWithIdentity = AiFileDiff & {
    readonly identityKey?: string | null;
};

// --- Construction ----------------------------------------------------------

export function createEmptyReviewActionLog(
    sessionId: string,
): AiReviewActionLogState {
    return {
        activeWorkCycleId: null,
        fileOrder: [],
        schemaVersion: 2,
        sessionId,
        trackedFilesByIdentityKey: {},
        updatedAt: new Date().toISOString(),
    };
}

export function createReviewActionLogFromTrackedFiles(
    sessionId: string,
    trackedFiles: readonly AiTrackedFile[],
    options: {
        readonly activeWorkCycleId?: string | null;
        readonly updatedAt?: string;
    } = {},
): AiReviewActionLogState {
    let state: AiReviewActionLogState = {
        ...createEmptyReviewActionLog(sessionId),
        activeWorkCycleId: options.activeWorkCycleId ?? null,
        updatedAt: options.updatedAt ?? new Date().toISOString(),
    };

    for (const trackedFile of trackedFiles) {
        if (trackedFile.sessionId !== sessionId || !trackedFile.isText) {
            continue;
        }
        state = putTrackedFile(state, syncTrackedFile(trackedFile), {
            updatedAt: trackedFile.updatedAt,
        });
    }

    return {
        ...state,
        updatedAt: options.updatedAt ?? state.updatedAt,
    };
}

export function beginReviewWorkCycle(
    state: AiReviewActionLogState,
    workCycleId: string,
    options: { readonly updatedAt?: string } = {},
): AiReviewActionLogState {
    if (state.activeWorkCycleId === workCycleId && !options.updatedAt) {
        return state;
    }
    return {
        ...state,
        activeWorkCycleId: workCycleId,
        updatedAt: options.updatedAt ?? new Date().toISOString(),
    };
}

// --- Ingestion -------------------------------------------------------------

/**
 * Merge freshly emitted runtime diffs into the log. For a file already tracked,
 * the accumulated `diffBase` is preserved and only `currentText` is updated —
 * so accepted work (already folded into the base) never reappears, regardless
 * of the `oldText` the runtime emits. A brand-new file uses the diff's own
 * `oldText` as the base.
 */
export function consolidateReviewDiffs(
    state: AiReviewActionLogState,
    diffs: readonly AiFileDiff[],
    context: AiReviewDiffConsolidationContext,
): AiReviewActionLogState {
    if (context.origin && context.origin !== "live") {
        return state;
    }

    let nextState = applyWorkCycle(state, context);
    for (const diff of diffs) {
        if (!diff.isText) {
            continue;
        }
        const existing = findTrackedFileForDiff(nextState, diff);
        const updatedAt = context.updatedAt ?? new Date().toISOString();
        if (existing) {
            const updated = updateTrackedFileWithDiff(
                existing,
                diff,
                context,
                updatedAt,
            );
            // Skip stale re-emissions of already-resolved work: if neither the
            // existing nor the updated file carries a visible change, the diff
            // just reproduces resolved content — leave the log untouched so the
            // native mirror is not re-recorded and the file is not re-proposed.
            if (!isVisibleReviewFile(existing) && !isVisibleReviewFile(updated)) {
                continue;
            }
            nextState = putTrackedFile(nextState, updated, { updatedAt });
        } else {
            const created = createTrackedFileFromDiff(
                nextState.sessionId,
                diff,
                context,
                updatedAt,
            );
            if (created) {
                nextState = putTrackedFile(nextState, created, { updatedAt });
            }
        }
    }
    return nextState;
}

function createTrackedFileFromDiff(
    sessionId: string,
    diff: AiFileDiff,
    context: AiReviewDiffConsolidationContext,
    updatedAt: string,
): AiTrackedFile | null {
    const diffBase = diff.kind === "create" ? "" : (diff.oldText ?? "");
    const currentText = diff.kind === "delete" ? "" : (diff.newText ?? "");
    if (
        !diff.previousPath &&
        normalizeReviewText(diffBase) === normalizeReviewText(currentText)
    ) {
        return null;
    }
    const hunks = computeDiffHunks(diffBase, currentText, diff.path);
    if (hunks.length === 0 && !diff.previousPath) {
        return null;
    }
    return {
        currentText,
        diffBase,
        hunks,
        identityKey: identityKeyForDiff(sessionId, diff),
        isText: true,
        kind: diff.kind,
        newText: diff.newText,
        oldText: diff.oldText,
        path: diff.path,
        previousPath: diff.previousPath,
        reviewState: "pending",
        reversible: diff.kind === "create" || diff.oldText !== null,
        sessionId,
        toolCallId: context.toolCallId ?? null,
        updatedAt,
        version: 1,
    };
}

function updateTrackedFileWithDiff(
    file: AiTrackedFile,
    diff: AiFileDiff,
    context: AiReviewDiffConsolidationContext,
    updatedAt: string,
): AiTrackedFile {
    // Preserve the accumulated baseline; only the agent's latest full text
    // moves. This is what keeps accepted work (folded into diffBase) from
    // resurfacing when the runtime re-emits against its stale session baseline.
    const diffBase = getTrackedFileDiffBase(file);
    // The retained log entry is the source of truth for whether the baseline
    // exists. An accepted create has a real baseline now, so later changes must
    // reject back to that text instead of being treated as a new create to delete.
    const baselineExists = trackedFileBaseExists(file);
    const currentExists = diff.kind !== "delete" && diff.newText !== null;
    const currentText = currentExists ? (diff.newText ?? "") : "";
    const hunks = computeDiffHunks(diffBase, currentText, diff.path);
    const oldText = baselineExists ? diffBase : null;
    const newText = currentExists ? currentText : null;
    const previousPath = normalizeTrackedPreviousPath(
        diff.path,
        diff.path !== file.path
            ? (diff.previousPath ?? file.previousPath)
            : file.previousPath,
    );
    const kind = inferTrackedFileKind(previousPath, oldText, newText);
    return {
        ...file,
        conflict: undefined,
        currentText,
        diffBase,
        hunks,
        kind,
        newText,
        oldText,
        path: diff.path,
        // Only adopt the diff's previous path on a genuine move (the path
        // actually changes). A late move diff whose target already matches the
        // tracked path is stale — keep the file's own (resolved) rename state.
        previousPath,
        reviewState: "pending",
        reversible: kind === "create" || oldText !== null,
        toolCallId: context.toolCallId ?? file.toolCallId,
        updatedAt,
        version: nextVersion(file),
    };
}

function trackedFileBaseExists(file: AiTrackedFile): boolean {
    return file.oldText !== null;
}

function trackedFileCurrentExists(file: AiTrackedFile): boolean {
    return file.kind !== "delete" && file.newText !== null;
}

function inferTrackedFileKind(
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

function normalizeTrackedPreviousPath(
    path: string,
    previousPath: string | null,
): string | null {
    return previousPath !== null && previousPath !== path ? previousPath : null;
}

// --- Derivation ------------------------------------------------------------

/** The pending files the review UI shows: those that still carry a change. */
export function deriveTrackedFilesFromActionLog(
    state: AiReviewActionLogState,
): readonly AiTrackedFile[] {
    return orderedFiles(state).filter(isVisibleReviewFile);
}

function isVisibleReviewFile(file: AiTrackedFile): boolean {
    if (file.reviewState === "conflict") {
        return true;
    }
    if (file.previousPath !== null && file.previousPath !== file.path) {
        // A pending rename stays visible even with identical content.
        return true;
    }
    return (
        normalizeReviewText(getTrackedFileDiffBase(file)) !==
        normalizeReviewText(getTrackedFileCurrentText(file))
    );
}

// --- Target resolution -----------------------------------------------------

export function resolveReviewTarget(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
): AiTrackedFile | null {
    if (target.sessionId !== state.sessionId) {
        return null;
    }
    if (target.trackedFileId) {
        // An explicit id must match exactly — no path fallback — so a stale id
        // fails cleanly instead of resolving a different file underneath it.
        return (
            (state.trackedFilesByIdentityKey ?? {})[target.trackedFileId] ??
            null
        );
    }
    return (
        orderedFiles(state).find(
            (file) =>
                file.path === target.path ||
                file.previousPath === target.path,
        ) ?? null
    );
}

export function isReviewTargetVersionCurrent(
    file: AiTrackedFile,
    target: Pick<AiReviewActionLogTarget, "expectedVersion">,
): boolean {
    if (target.expectedVersion === undefined) {
        return true;
    }
    return (
        Number.isInteger(target.expectedVersion) &&
        target.expectedVersion === normalizeVersion(file.version)
    );
}

export function assertReviewTargetVersion(
    file: AiTrackedFile,
    target: Pick<AiReviewActionLogTarget, "expectedVersion">,
): void {
    if (!isReviewTargetVersionCurrent(file, target)) {
        throw new Error("Stale AI review target version.");
    }
}

// --- Keep / reject ---------------------------------------------------------

export function keepReviewFile(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
): AiReviewActionLogState {
    return resolveReviewFileHunks(state, target, null, "keep");
}

export function rejectReviewFile(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
): AiReviewActionLogState {
    return resolveReviewFileHunks(state, target, null, "reject");
}

export function keepReviewRanges(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
    rangeIds: readonly string[],
): AiReviewActionLogState {
    return resolveReviewFileHunks(state, target, rangeIds, "keep");
}

export function rejectReviewRanges(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
    rangeIds: readonly string[],
): AiReviewActionLogState {
    return resolveReviewFileHunks(state, target, rangeIds, "reject");
}

/**
 * Apply a keep/reject to a file. `rangeIds === null` resolves the whole file
 * (every hunk). The engine advances `diffBase` (keep) or reverts `currentText`
 * (reject); a fully resolved file is retained with `diffBase === currentText`
 * so later runtime diffs reconcile against the resolved text.
 */
function resolveReviewFileHunks(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
    rangeIds: readonly string[] | null,
    decision: "keep" | "reject",
): AiReviewActionLogState {
    const file = resolveReviewTarget(state, target);
    if (!file) {
        return state;
    }
    assertReviewTargetVersion(file, target);

    if (rangeIds === null) {
        // Whole-file keep/reject is unconditional: settle to the resolved text
        // and clear any pending rename, even when there is no content hunk to
        // resolve (a pure rename has empty hunks but must still settle).
        const retained = retainedResolvedFile(file, decision);
        return putTrackedFile(state, retained, {
            updatedAt: retained.updatedAt,
        });
    }

    const resolved = resolveTrackedFileHunks(file, rangeIds, decision);
    const nextFile = resolved ?? retainedResolvedFile(file, decision);
    return putTrackedFile(state, nextFile, { updatedAt: nextFile.updatedAt });
}

// A fully resolved file is kept (hidden) at the resolved text so a re-emitted
// runtime diff reconciles against it instead of re-proposing the change.
function retainedResolvedFile(
    file: AiTrackedFile,
    decision: "keep" | "reject",
): AiTrackedFile {
    const settledText =
        decision === "keep"
            ? getTrackedFileCurrentText(file)
            : getTrackedFileDiffBase(file);
    const settledExists =
        decision === "keep"
            ? trackedFileCurrentExists(file)
            : trackedFileBaseExists(file);
    // Hidden resolved entries still feed later diff consolidation. Preserve
    // existence explicitly so an accepted create becomes an existing baseline,
    // while a rejected create remains an absent baseline.
    const textSide = settledExists ? settledText : null;
    const kind = inferTrackedFileKind(null, textSide, textSide);
    return {
        ...file,
        currentText: settledText,
        diffBase: settledText,
        hunks: [],
        kind,
        newText: textSide,
        oldText: textSide,
        previousPath: null,
        reviewState: "pending",
        reversible: kind === "create" || textSide !== null,
        updatedAt: new Date().toISOString(),
        version: nextVersion(file),
    };
}

export function markReviewFileConflict(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
): AiReviewActionLogState {
    const file = resolveReviewTarget(state, target);
    if (!file) {
        return state;
    }
    assertReviewTargetVersion(file, target);
    const updatedAt = new Date().toISOString();
    return putTrackedFile(
        state,
        {
            ...file,
            reviewState: "conflict",
            updatedAt,
            version: nextVersion(file),
        },
        { updatedAt },
    );
}

// --- Settle / mirror (single-store helpers) --------------------------------

/**
 * Settle an accepted tracked file directly into the log. Used by the
 * native/fallback accept paths in the main process, which resolve a change
 * without going through keepReviewFile. The file is retained at its accepted
 * text so later runtime diffs reconcile against it.
 */
export function settleAcceptedReviewFile(
    state: AiReviewActionLogState,
    trackedFile: AiTrackedFile,
): AiReviewActionLogState {
    const synced = syncTrackedFile(trackedFile);
    const existing = findTrackedFileForTracked(state, synced);
    const base = existing ?? synced;
    return putTrackedFile(state, retainedResolvedFile(base, "keep"), {
        updatedAt: base.updatedAt,
    });
}

/**
 * Merge the native review mirror into the log additively. The log is canonical;
 * the mirror (the turn-end on-disk reconcile) may only ADD a changed file the
 * live path never captured — it must never overwrite or un-resolve a file the
 * log already tracks. This keeps the native backend strictly subordinate.
 */
export function mergeReviewFilesFromMirror(
    state: AiReviewActionLogState,
    trackedFiles: readonly AiTrackedFile[],
    context: AiReviewDiffConsolidationContext = {},
): AiReviewActionLogState {
    let nextState = state;
    for (const trackedFile of trackedFiles) {
        if (trackedFile.sessionId !== state.sessionId || !trackedFile.isText) {
            continue;
        }
        if (findTrackedFileForTracked(nextState, trackedFile)) {
            // The log already owns this file (pending or resolved). Never let
            // the mirror overwrite the canonical entry.
            continue;
        }
        nextState = putTrackedFile(nextState, syncTrackedFile(trackedFile), {
            updatedAt: context.updatedAt ?? trackedFile.updatedAt,
        });
    }
    return nextState;
}

// --- Internal state helpers ------------------------------------------------

function applyWorkCycle(
    state: AiReviewActionLogState,
    context: AiReviewDiffConsolidationContext,
): AiReviewActionLogState {
    if (
        context.workCycleId === undefined ||
        context.workCycleId === state.activeWorkCycleId
    ) {
        return state;
    }
    return { ...state, activeWorkCycleId: context.workCycleId };
}

function putTrackedFile(
    state: AiReviewActionLogState,
    file: AiTrackedFile,
    context: { readonly updatedAt?: string },
): AiReviewActionLogState {
    const fileOrder = state.fileOrder.includes(file.identityKey)
        ? state.fileOrder
        : [...state.fileOrder, file.identityKey];
    return {
        ...state,
        fileOrder,
        trackedFilesByIdentityKey: {
            ...state.trackedFilesByIdentityKey,
            [file.identityKey]: file,
        },
        updatedAt: context.updatedAt ?? file.updatedAt,
    };
}

function orderedFiles(state: AiReviewActionLogState): readonly AiTrackedFile[] {
    const files = state.trackedFilesByIdentityKey ?? {};
    return state.fileOrder.flatMap((identityKey) => {
        const file = files[identityKey];
        return file ? [file] : [];
    });
}

function findTrackedFileForDiff(
    state: AiReviewActionLogState,
    diff: AiFileDiff,
): AiTrackedFile | undefined {
    const identityKey = extractDiffIdentityKey(diff);
    if (identityKey && state.trackedFilesByIdentityKey[identityKey]) {
        return state.trackedFilesByIdentityKey[identityKey];
    }
    return orderedFiles(state).find((file) =>
        trackedFileMatchesDiff(file, diff),
    );
}

function findTrackedFileForTracked(
    state: AiReviewActionLogState,
    trackedFile: AiTrackedFile,
): AiTrackedFile | undefined {
    return (
        state.trackedFilesByIdentityKey[trackedFile.identityKey] ??
        orderedFiles(state).find((file) =>
            trackedFilesShareReviewIdentity(file, trackedFile),
        )
    );
}

function trackedFileMatchesDiff(
    file: AiTrackedFile,
    diff: AiFileDiff,
): boolean {
    if (file.path === diff.path) {
        return true;
    }
    if (diff.previousPath === null) {
        return false;
    }

    // `previousPath` identifies the source side of a move. Do not use an
    // existing file's previous path to absorb an unrelated create/update at the
    // old location; replacement files at the old path are separate review items.
    return (
        file.path === diff.previousPath ||
        file.previousPath === diff.previousPath
    );
}

function trackedFilesShareReviewIdentity(
    file: AiTrackedFile,
    trackedFile: AiTrackedFile,
): boolean {
    if (file.path === trackedFile.path) {
        return true;
    }
    if (trackedFile.previousPath === null) {
        return false;
    }

    return (
        file.path === trackedFile.previousPath ||
        file.previousPath === trackedFile.previousPath
    );
}

function identityKeyForDiff(sessionId: string, diff: AiFileDiff): string {
    const explicit = extractDiffIdentityKey(diff);
    if (explicit) {
        return explicit;
    }
    return diff.previousPath
        ? `review:${sessionId}:${diff.previousPath}->${diff.path}`
        : `review:${sessionId}:${diff.path}`;
}

function extractDiffIdentityKey(diff: AiFileDiff): string | null {
    const identityKey = (diff as AiFileDiffWithIdentity).identityKey;
    return typeof identityKey === "string" && identityKey.trim().length > 0
        ? identityKey
        : null;
}

function nextVersion(file: AiTrackedFile): number {
    return normalizeVersion(file.version) + 1;
}

function normalizeVersion(version: number | undefined): number {
    if (!Number.isFinite(version)) {
        return 1;
    }
    return Math.max(1, Math.trunc(version ?? 1));
}
