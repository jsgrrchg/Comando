import {
    computeDiffHunks,
    getTrackedFileCurrentText,
    getTrackedFileDiffBase,
    isAiTrackedFileUnresolved,
    normalizeReviewText,
    resolveTrackedFileHunks,
    syncTrackedFile,
    upsertTrackedFile,
} from "./ai-tracked-file";
import type { AiFileDiff, AiSessionEventOrigin, AiTrackedFile } from "./ipc";

export interface AiReviewActionLogState {
    readonly schemaVersion: 1;
    readonly sessionId: string;
    readonly updatedAt: string;
    readonly filesByIdentityKey: Readonly<Record<string, AiReviewActionLogFile>>;
    readonly fileOrder: readonly string[];
    readonly versionClockByIdentityKey: Readonly<Record<string, number>>;
    readonly activeWorkCycleId: string | null;
}

export interface AiReviewActionLogFile {
    readonly identityKey: string;
    readonly originPath: string;
    readonly path: string;
    readonly previousPath: string | null;
    readonly kind: "create" | "delete" | "move" | "update";
    readonly diffBase: string;
    readonly currentText: string;
    readonly oldText: string | null;
    readonly newText: string | null;
    readonly pendingRanges: readonly AiReviewPendingRange[];
    readonly reviewState: "pending" | "conflict";
    readonly sessionId: string;
    readonly toolCallIds: readonly string[];
    readonly updatedAt: string;
    readonly version: number;
}

export interface AiReviewPendingRange {
    readonly id: string;
    readonly baseFrom: number;
    readonly baseTo: number;
    readonly currentFrom: number;
    readonly currentTo: number;
    readonly toolCallId: string | null;
    readonly workCycleId: string | null;
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

interface ReviewTrackedFileCandidate {
    readonly mergeMode: "identity" | "none" | "path";
    readonly trackedFile: AiTrackedFile;
}

export function createEmptyReviewActionLog(
    sessionId: string,
): AiReviewActionLogState {
    return {
        activeWorkCycleId: null,
        fileOrder: [],
        filesByIdentityKey: {},
        schemaVersion: 1,
        sessionId,
        updatedAt: new Date().toISOString(),
        versionClockByIdentityKey: {},
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
        if (
            !trackedFile.isText ||
            trackedFile.sessionId !== sessionId ||
            !isAiTrackedFileUnresolved(trackedFile)
        ) {
            continue;
        }

        const syncedTrackedFile = syncTrackedFile(trackedFile);
        state = replaceReviewFile(
            state,
            actionLogFileFromTrackedFile(
                syncedTrackedFile,
                state.filesByIdentityKey[syncedTrackedFile.identityKey],
                {
                    updatedAt: syncedTrackedFile.updatedAt,
                },
            ),
            {
                updatedAt: syncedTrackedFile.updatedAt,
            },
        );
    }

    return {
        ...state,
        updatedAt: options.updatedAt ?? state.updatedAt,
    };
}

export function replaceReviewFilesFromMirror(
    state: AiReviewActionLogState,
    trackedFiles: readonly AiTrackedFile[],
    context: AiReviewDiffConsolidationContext = {},
): AiReviewActionLogState {
    let nextState: AiReviewActionLogState = {
        ...state,
        fileOrder: [],
        filesByIdentityKey: {},
        updatedAt: context.updatedAt ?? new Date().toISOString(),
    };
    for (const identityKey of state.fileOrder) {
        const file = state.filesByIdentityKey[identityKey];
        if (
            file &&
            (file.reviewState === "conflict" ||
                (isLocalReviewFile(file) &&
                    !trackedFiles.some((trackedFile) =>
                        trackedFileRepresentsActionLogFile(trackedFile, file),
                    )))
        ) {
            nextState = replaceReviewFile(nextState, file, context);
        }
    }

    for (const trackedFile of trackedFiles) {
        if (
            !trackedFile.isText ||
            trackedFile.sessionId !== state.sessionId ||
            !isAiTrackedFileUnresolved(trackedFile)
        ) {
            continue;
        }

        const syncedTrackedFile = syncTrackedFile(trackedFile);
        const previousFile = findActionLogFileForTrackedFile(
            state,
            syncedTrackedFile,
        );
        if (
            previousFile &&
            normalizeVersion(syncedTrackedFile.version) < previousFile.version
        ) {
            continue;
        }

        if (
            !previousFile &&
            normalizeVersion(syncedTrackedFile.version) <=
                (state.versionClockByIdentityKey[
                    syncedTrackedFile.identityKey
                ] ?? 0)
        ) {
            continue;
        }

        nextState = replaceReviewFile(
            nextState,
            actionLogFileFromTrackedFile(
                syncedTrackedFile,
                previousFile,
                context,
            ),
            context,
        );
    }

    return nextState;
}

function isLocalReviewFile(file: AiReviewActionLogFile): boolean {
    return (
        file.identityKey.startsWith("review:") ||
        file.identityKey.startsWith("tool:")
    );
}

function trackedFileRepresentsActionLogFile(
    trackedFile: AiTrackedFile,
    file: AiReviewActionLogFile,
): boolean {
    return (
        trackedFile.identityKey === file.identityKey ||
        trackedFile.path === file.path ||
        trackedFile.path === file.originPath ||
        trackedFile.previousPath === file.path ||
        trackedFile.previousPath === file.originPath ||
        file.previousPath === trackedFile.path ||
        (file.previousPath !== null &&
            file.previousPath === trackedFile.previousPath)
    );
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

export function consolidateReviewDiffs(
    state: AiReviewActionLogState,
    diffs: readonly AiFileDiff[],
    context: AiReviewDiffConsolidationContext,
): AiReviewActionLogState {
    if (context.origin && context.origin !== "live") {
        return state;
    }

    let nextState = state;
    for (const diff of diffs) {
        if (!diff.isText) {
            continue;
        }

        const candidate = trackedFileFromDiff(nextState, diff, context);
        if (!candidate) {
            continue;
        }

        nextState = applyTrackedFile(nextState, candidate, context);
    }

    return nextState;
}

export function deriveTrackedFilesFromActionLog(
    state: AiReviewActionLogState,
): readonly AiTrackedFile[] {
    return state.fileOrder.flatMap((identityKey) => {
        const file = state.filesByIdentityKey[identityKey];
        return file ? [trackedFileFromActionLogFile(file)] : [];
    });
}

export function keepReviewFile(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
): AiReviewActionLogState {
    const file = resolveReviewTarget(state, target);
    if (!file) {
        return state;
    }
    assertReviewTargetVersion(file, target);
    return removeReviewFile(state, file.identityKey);
}

export function keepReviewRanges(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
    rangeIds: readonly string[],
): AiReviewActionLogState {
    return resolveReviewRanges(state, target, rangeIds, "keep");
}

export function rejectReviewFile(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
): AiReviewActionLogState {
    const file = resolveReviewTarget(state, target);
    if (!file) {
        return state;
    }
    assertReviewTargetVersion(file, target);
    return removeReviewFile(state, file.identityKey);
}

export function rejectReviewRanges(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
    rangeIds: readonly string[],
): AiReviewActionLogState {
    return resolveReviewRanges(state, target, rangeIds, "reject");
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
    return replaceReviewFile(
        state,
        {
            ...file,
            reviewState: "conflict",
            updatedAt,
            version: file.version + 1,
        },
        {
            updatedAt,
        },
    );
}

function resolveReviewRanges(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
    rangeIds: readonly string[],
    decision: "keep" | "reject",
): AiReviewActionLogState {
    const file = resolveReviewTarget(state, target);
    if (!file) {
        return state;
    }
    assertReviewTargetVersion(file, target);

    const trackedFile = trackedFileFromActionLogFile(file);
    const nextTrackedFile = resolveTrackedFileHunks(
        trackedFile,
        rangeIds,
        decision,
    );
    if (!nextTrackedFile) {
        return removeReviewFile(state, file.identityKey);
    }

    return replaceReviewFile(
        state,
        actionLogFileFromTrackedFile(nextTrackedFile, file, {
            updatedAt: nextTrackedFile.updatedAt,
        }),
    );
}

export function resolveReviewTarget(
    state: AiReviewActionLogState,
    target: AiReviewActionLogTarget,
): AiReviewActionLogFile | null {
    if (target.sessionId !== state.sessionId) {
        return null;
    }

    if (target.trackedFileId) {
        const exactFile = state.filesByIdentityKey[target.trackedFileId];
        return exactFile ?? null;
    }

    return (
        state.fileOrder
            .map((identityKey) => state.filesByIdentityKey[identityKey])
            .find(
                (file) =>
                    file &&
                    (file.path === target.path ||
                        file.previousPath === target.path ||
                        file.identityKey === target.path),
            ) ?? null
    );
}

export function assertReviewTargetVersion(
    file: AiReviewActionLogFile,
    target: Pick<AiReviewActionLogTarget, "expectedVersion">,
): void {
    if (!isReviewTargetVersionCurrent(file, target)) {
        throw new Error("Stale AI review target version.");
    }
}

export function isReviewTargetVersionCurrent(
    file: AiReviewActionLogFile,
    target: Pick<AiReviewActionLogTarget, "expectedVersion">,
): boolean {
    if (target.expectedVersion === undefined) {
        return true;
    }

    return (
        Number.isFinite(target.expectedVersion) &&
        Number.isInteger(target.expectedVersion) &&
        target.expectedVersion === file.version
    );
}

function applyTrackedFile(
    state: AiReviewActionLogState,
    candidate: ReviewTrackedFileCandidate,
    context: AiReviewDiffConsolidationContext,
): AiReviewActionLogState {
    const { trackedFile } = candidate;
    const trackedFiles = deriveTrackedFilesFromActionLog(state);
    const previousFile =
        candidate.mergeMode === "path"
            ? findActionLogFileForTrackedFile(state, trackedFile)
            : state.filesByIdentityKey[trackedFile.identityKey];
    const nextTrackedFile =
        candidate.mergeMode === "path"
            ? resolveMergedTrackedFile(trackedFiles, trackedFile, previousFile)
            : candidate.mergeMode === "identity" && previousFile
              ? resolveMergedTrackedFile(
                    [trackedFileFromActionLogFile(previousFile)],
                    trackedFile,
                    previousFile,
                )
              : syncTrackedFile(trackedFile);

    if (!nextTrackedFile) {
        return previousFile
            ? removeReviewFile(state, previousFile.identityKey, context)
            : state;
    }

    const nextFile = actionLogFileFromTrackedFile(
        nextTrackedFile,
        previousFile ?? undefined,
        context,
    );
    return replaceReviewFile(state, nextFile, context);
}

function replaceReviewFile(
    state: AiReviewActionLogState,
    file: AiReviewActionLogFile,
    context?: Pick<
        AiReviewDiffConsolidationContext,
        "updatedAt" | "workCycleId"
    >,
): AiReviewActionLogState {
    const fileOrder = state.fileOrder.includes(file.identityKey)
        ? state.fileOrder
        : [...state.fileOrder, file.identityKey];

    return {
        ...state,
        activeWorkCycleId:
            context?.workCycleId === undefined
                ? state.activeWorkCycleId
                : context.workCycleId,
        fileOrder,
        filesByIdentityKey: {
            ...state.filesByIdentityKey,
            [file.identityKey]: file,
        },
        updatedAt: context?.updatedAt ?? file.updatedAt,
        versionClockByIdentityKey: updateVersionClock(
            state.versionClockByIdentityKey,
            file.identityKey,
            file.version,
        ),
    };
}

function removeReviewFile(
    state: AiReviewActionLogState,
    identityKey: string,
    context?: Pick<
        AiReviewDiffConsolidationContext,
        "updatedAt" | "workCycleId"
    >,
): AiReviewActionLogState {
    if (!state.filesByIdentityKey[identityKey]) {
        return state;
    }

    const { [identityKey]: _removed, ...filesByIdentityKey } =
        state.filesByIdentityKey;
    void _removed;
    const removedVersion = state.filesByIdentityKey[identityKey]?.version ?? 0;

    return {
        ...state,
        activeWorkCycleId:
            context?.workCycleId === undefined
                ? state.activeWorkCycleId
                : context.workCycleId,
        fileOrder: state.fileOrder.filter((candidate) => candidate !== identityKey),
        filesByIdentityKey,
        updatedAt: context?.updatedAt ?? new Date().toISOString(),
        versionClockByIdentityKey: updateVersionClock(
            state.versionClockByIdentityKey,
            identityKey,
            removedVersion,
        ),
    };
}

function resolveMergedTrackedFile(
    trackedFiles: readonly AiTrackedFile[],
    trackedFile: AiTrackedFile,
    previousFile: AiReviewActionLogFile | undefined,
): AiTrackedFile | null {
    const nextTrackedFiles = upsertTrackedFile(trackedFiles, trackedFile);
    return (
        nextTrackedFiles.find(
            (file) => file.identityKey === previousFile?.identityKey,
        ) ??
        nextTrackedFiles.find((file) => file.identityKey === trackedFile.identityKey) ??
        nextTrackedFiles.find(
            (file) =>
                file.path === trackedFile.path ||
                file.previousPath === trackedFile.path ||
                (trackedFile.previousPath &&
                    (file.path === trackedFile.previousPath ||
                        file.previousPath === trackedFile.previousPath)),
        ) ??
        null
    );
}

function trackedFileFromDiff(
    state: AiReviewActionLogState,
    diff: AiFileDiff,
    context: AiReviewDiffConsolidationContext,
): ReviewTrackedFileCandidate | null {
    const diffBase = diff.oldText ?? "";
    const currentText = diff.newText ?? "";
    if (
        !diff.previousPath &&
        normalizeReviewText(diffBase) === normalizeReviewText(currentText)
    ) {
        return null;
    }

    const explicitIdentityKey = extractDiffIdentityKey(diff);
    const previousFile = findActionLogFileForDiff(state, diff);
    const identityKey =
        previousFile?.identityKey ??
        explicitIdentityKey ??
        createReviewIdentityKey(state.sessionId, diff);
    const hunks = computeDiffHunks(diffBase, currentText, diff.path);
    const previousVersion =
        previousFile?.version ?? state.versionClockByIdentityKey[identityKey] ?? 0;

    return {
        mergeMode: explicitIdentityKey
            ? previousFile
                ? "identity"
                : "none"
            : "path",
        trackedFile: {
            currentText,
            diffBase,
            hunks,
            identityKey,
            isText: true,
            kind: diff.kind,
            newText: diff.newText,
            oldText: diff.oldText,
            path: diff.path,
            previousPath: diff.previousPath,
            reviewState: "pending",
            reversible: diff.kind === "create" || diff.oldText !== null,
            sessionId: context.sessionId ?? state.sessionId,
            toolCallId: context.toolCallId ?? null,
            updatedAt: context.updatedAt ?? new Date().toISOString(),
            version: previousVersion + 1,
        },
    };
}

function trackedFileFromActionLogFile(file: AiReviewActionLogFile): AiTrackedFile {
    const hunks = computeDiffHunks(file.diffBase, file.currentText, file.path);

    return {
        currentText: file.currentText,
        diffBase: file.diffBase,
        hunks,
        identityKey: file.identityKey,
        isText: true,
        kind: file.kind,
        newText: file.newText,
        oldText: file.oldText,
        path: file.path,
        previousPath: file.previousPath,
        reviewState: file.reviewState,
        reversible: file.kind === "create" || file.oldText !== null,
        sessionId: file.sessionId,
        toolCallId: file.toolCallIds.at(-1) ?? null,
        updatedAt: file.updatedAt,
        version: file.version,
    };
}

function actionLogFileFromTrackedFile(
    trackedFile: AiTrackedFile,
    previousFile?: AiReviewActionLogFile,
    context: Pick<
        AiReviewDiffConsolidationContext,
        "toolCallId" | "updatedAt" | "workCycleId"
    > = {},
): AiReviewActionLogFile {
    const syncedTrackedFile = syncTrackedFile(trackedFile);
    const diffBase = getTrackedFileDiffBase(syncedTrackedFile);
    const currentText = getTrackedFileCurrentText(syncedTrackedFile);
    const updatedAt = context.updatedAt ?? syncedTrackedFile.updatedAt;
    const toolCallIds = mergeToolCallIds(
        previousFile?.toolCallIds ?? [],
        context.toolCallId ?? syncedTrackedFile.toolCallId ?? null,
    );

    return {
        currentText,
        diffBase,
        identityKey: syncedTrackedFile.identityKey,
        kind: syncedTrackedFile.kind,
        newText: syncedTrackedFile.newText,
        oldText: syncedTrackedFile.oldText,
        originPath:
            previousFile?.originPath ??
            syncedTrackedFile.previousPath ??
            syncedTrackedFile.path,
        path: syncedTrackedFile.path,
        pendingRanges: pendingRangesFromTrackedFile(
            syncedTrackedFile,
            previousFile,
            context,
        ),
        previousPath: syncedTrackedFile.previousPath,
        reviewState:
            syncedTrackedFile.reviewState === "conflict" ? "conflict" : "pending",
        sessionId: syncedTrackedFile.sessionId,
        toolCallIds,
        updatedAt,
        version: normalizeVersion(syncedTrackedFile.version),
    };
}

function pendingRangesFromTrackedFile(
    trackedFile: AiTrackedFile,
    previousFile: AiReviewActionLogFile | undefined,
    context: Pick<AiReviewDiffConsolidationContext, "toolCallId" | "workCycleId">,
): readonly AiReviewPendingRange[] {
    const previousRangesById = new Map(
        previousFile?.pendingRanges.map((range) => [range.id, range]) ?? [],
    );

    return trackedFile.hunks.map((hunk) => {
        const previousRange = previousRangesById.get(hunk.id);
        return {
            baseFrom: Math.max(0, hunk.oldStart - 1),
            baseTo: Math.max(0, hunk.oldStart - 1 + hunk.oldCount),
            currentFrom: Math.max(0, hunk.newStart - 1),
            currentTo: Math.max(0, hunk.newStart - 1 + hunk.newCount),
            id: hunk.id,
            toolCallId:
                previousRange?.toolCallId ?? context.toolCallId ?? null,
            workCycleId:
                previousRange?.workCycleId ?? context.workCycleId ?? null,
        };
    });
}

function findActionLogFileForDiff(
    state: AiReviewActionLogState,
    diff: AiFileDiff,
): AiReviewActionLogFile | undefined {
    const identityKey = extractDiffIdentityKey(diff);
    if (identityKey) {
        return state.filesByIdentityKey[identityKey];
    }

    return state.fileOrder
        .map((candidate) => state.filesByIdentityKey[candidate])
        .find(
            (file) =>
                file &&
                (file.path === diff.path ||
                    file.previousPath === diff.path ||
                    file.originPath === diff.path ||
                    (diff.previousPath &&
                        (file.path === diff.previousPath ||
                            file.previousPath === diff.previousPath ||
                            file.originPath === diff.previousPath))),
        );
}

function findActionLogFileForTrackedFile(
    state: AiReviewActionLogState,
    trackedFile: AiTrackedFile,
): AiReviewActionLogFile | undefined {
    return (
        state.filesByIdentityKey[trackedFile.identityKey] ??
        state.fileOrder
            .map((candidate) => state.filesByIdentityKey[candidate])
            .find(
                (file) =>
                    file &&
                    (file.path === trackedFile.path ||
                        file.previousPath === trackedFile.path ||
                        file.originPath === trackedFile.path ||
                        (trackedFile.previousPath &&
                            (file.path === trackedFile.previousPath ||
                                file.previousPath === trackedFile.previousPath ||
                                file.originPath === trackedFile.previousPath))),
            )
    );
}

function extractDiffIdentityKey(diff: AiFileDiff): string | null {
    const identityKey = (diff as AiFileDiffWithIdentity).identityKey;
    return typeof identityKey === "string" && identityKey.trim().length > 0
        ? identityKey
        : null;
}

function createReviewIdentityKey(sessionId: string, diff: AiFileDiff): string {
    if (diff.previousPath) {
        return `review:${sessionId}:${diff.previousPath}->${diff.path}`;
    }

    return `review:${sessionId}:${diff.path}`;
}

function mergeToolCallIds(
    existingToolCallIds: readonly string[],
    nextToolCallId: string | null,
): readonly string[] {
    if (!nextToolCallId || existingToolCallIds.includes(nextToolCallId)) {
        return existingToolCallIds;
    }

    return [...existingToolCallIds, nextToolCallId];
}

function normalizeVersion(version: number | undefined): number {
    if (!Number.isFinite(version)) {
        return 1;
    }

    return Math.max(1, Math.trunc(version ?? 1));
}

function updateVersionClock(
    versionClockByIdentityKey: Readonly<Record<string, number>>,
    identityKey: string,
    version: number,
): Readonly<Record<string, number>> {
    const nextVersion = Math.max(
        normalizeVersion(versionClockByIdentityKey[identityKey]),
        normalizeVersion(version),
    );
    if (versionClockByIdentityKey[identityKey] === nextVersion) {
        return versionClockByIdentityKey;
    }

    return {
        ...versionClockByIdentityKey,
        [identityKey]: nextVersion,
    };
}
