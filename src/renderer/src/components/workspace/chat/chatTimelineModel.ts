import type {
    AiGeneratedImage,
    AiImageAttachment,
    AiSessionSnapshot,
} from "@shared/ipc";
import {
    getAiSessionTranscriptMessages,
    getAiSessionTranscriptToolActivity,
    type AiSessionTranscriptModel,
} from "@renderer/app/ai/transcriptModel";
import { areTrackedFilePathReferencesEquivalent } from "@renderer/app/ai/trackedFilePath";

import {
    deriveToolActivityReviewEntries,
    type ToolActivityReviewEntry,
} from "./toolActivityReviewModel";
import { getToolActivityDescriptor } from "./toolActivityDescriptor";
import {
    getToolActivityPresentationPolicy,
    type ToolActivityPresentationContext,
    type ToolActivityPresentationPolicy,
} from "./toolActivityPresentation";
import { isTurnStartedActivity } from "./toolActivityKinds";

export interface ChatTimelineMessageRow {
    readonly id: string;
    readonly kind: "message";
    readonly message: AiSessionSnapshot["messages"][number];
}

export interface ChatTimelineToolRow {
    readonly id: string;
    readonly kind: "tool";
    readonly reviewEntry: ToolActivityReviewEntry;
}

export type ChatTimelineAtomicRow =
    | ChatTimelineMessageRow
    | ChatTimelineToolRow;

export interface ToolActivitySegmentEntry {
    readonly policy: Exclude<ToolActivityPresentationPolicy, "structural">;
    readonly reviewEntry: ToolActivityReviewEntry;
}

export interface ToolActivitySegmentSummary {
    readonly actionCount: number;
    readonly changeCount: number;
    readonly changedFileCount: number;
    readonly commandCount: number;
    readonly failureCount: number;
    readonly fileCount: number;
    readonly hiddenActivityCount: number;
    readonly isInProgress: boolean;
    readonly latestActivityId: string;
    readonly latestTitle: string;
    readonly searchCount: number;
    readonly startedAt: string;
    readonly updatedAt: string;
}

export interface ChatTimelineActivitySegmentRow {
    readonly entries: readonly ToolActivitySegmentEntry[];
    readonly id: string;
    readonly kind: "activity-segment";
    readonly summary: ToolActivitySegmentSummary;
}

export type ChatTimelinePresentationRow =
    | ChatTimelineAtomicRow
    | ChatTimelineActivitySegmentRow;

export type ChatTimelineRow = ChatTimelinePresentationRow;

export interface ChatTimelineModel {
    readonly atomicHistoryRowIds: readonly string[];
    readonly atomicHistoryRows: readonly ChatTimelineAtomicRow[];
    readonly atomicLiveTailRow: ChatTimelineAtomicRow | null;
    readonly atomicLiveTailRowId: string | null;
    readonly atomicRowById: ReadonlyMap<string, ChatTimelineAtomicRow>;
    readonly historyRows: readonly ChatTimelinePresentationRow[];
    readonly historyRowIds: readonly string[];
    readonly liveTailRow: ChatTimelinePresentationRow | null;
    readonly liveTailRowId: string | null;
    readonly orderedRowIds: readonly string[];
    readonly orderedAtomicRowIds: readonly string[];
    readonly orderedAtomicRows: readonly ChatTimelineAtomicRow[];
    readonly orderedRows: readonly ChatTimelinePresentationRow[];
    readonly presentationRowById: ReadonlyMap<
        string,
        ChatTimelinePresentationRow
    >;
}

export function areImageAttachmentsEquivalent(
    previous: readonly AiImageAttachment[],
    next: readonly AiImageAttachment[],
): boolean {
    if (previous.length !== next.length) {
        return false;
    }

    for (let index = 0; index < previous.length; index += 1) {
        const previousAttachment = previous[index];
        const nextAttachment = next[index];
        if (
            previousAttachment?.id !== nextAttachment?.id ||
            previousAttachment?.mimeType !== nextAttachment?.mimeType ||
            previousAttachment?.name !== nextAttachment?.name ||
            previousAttachment?.sizeBytes !== nextAttachment?.sizeBytes
        ) {
            return false;
        }
    }

    return true;
}

export function areMessagesEquivalent(
    previous: AiSessionSnapshot["messages"][number],
    next: AiSessionSnapshot["messages"][number],
): boolean {
    return (
        previous.id === next.id &&
        previous.kind === next.kind &&
        previous.status === next.status &&
        previous.content === next.content &&
        areGeneratedImagesEquivalent(
            previous.generatedImage ?? null,
            next.generatedImage ?? null,
        ) &&
        areImageAttachmentsEquivalent(previous.attachments, next.attachments)
    );
}

function areGeneratedImagesEquivalent(
    previous: AiGeneratedImage | null,
    next: AiGeneratedImage | null,
): boolean {
    if (previous === next) {
        return true;
    }
    if (!previous || !next) {
        return false;
    }

    return (
        previous.error === next.error &&
        previous.mimeType === next.mimeType &&
        previous.path === next.path &&
        previous.result === next.result &&
        previous.revisedPrompt === next.revisedPrompt &&
        previous.status === next.status &&
        previous.title === next.title
    );
}

export function areToolActivitiesEquivalent(
    previous: ToolActivityReviewEntry["activity"],
    next: ToolActivityReviewEntry["activity"],
): boolean {
    return (
        previous.id === next.id &&
        previous.updatedAt === next.updatedAt &&
        previous.status === next.status &&
        previous.exitCode === next.exitCode &&
        previous.kind === next.kind &&
        previous.sessionId === next.sessionId &&
        previous.title === next.title &&
        previous.summary === next.summary &&
        previous.rawInputJson === next.rawInputJson &&
        previous.rawOutputJson === next.rawOutputJson &&
        previous.terminalOutput === next.terminalOutput &&
        areToolActivityActionsEquivalent(previous.action, next.action) &&
        areToolActivityLocationsEquivalent(
            previous.locations,
            next.locations,
        ) &&
        previous.diffs.length === next.diffs.length
    );
}

function areToolActivityLocationsEquivalent(
    previous: ToolActivityReviewEntry["activity"]["locations"],
    next: ToolActivityReviewEntry["activity"]["locations"],
): boolean {
    if (previous.length !== next.length) {
        return false;
    }

    for (let index = 0; index < previous.length; index += 1) {
        const previousLocation = previous[index];
        const nextLocation = next[index];
        if (
            previousLocation?.path !== nextLocation?.path ||
            previousLocation?.line !== nextLocation?.line ||
            previousLocation?.endLine !== nextLocation?.endLine
        ) {
            return false;
        }
    }

    return true;
}

function areToolActivityActionsEquivalent(
    previous: ToolActivityReviewEntry["activity"]["action"],
    next: ToolActivityReviewEntry["activity"]["action"],
): boolean {
    if (previous === next) {
        return true;
    }

    if (!previous || !next) {
        return false;
    }

    return previous.kind === next.kind && previous.sessionId === next.sessionId;
}

export function areToolActivityReviewEntriesEquivalent(
    previous: ToolActivityReviewEntry,
    next: ToolActivityReviewEntry,
): boolean {
    if (
        !areToolActivitiesEquivalent(previous.activity, next.activity) ||
        previous.hasPendingTrackedFiles !== next.hasPendingTrackedFiles
    ) {
        return false;
    }

    if (
        previous.pendingTrackedFiles.length !== next.pendingTrackedFiles.length
    ) {
        return false;
    }

    if (previous.trackedFiles.length !== next.trackedFiles.length) {
        return false;
    }

    for (
        let index = 0;
        index < previous.pendingTrackedFiles.length;
        index += 1
    ) {
        const previousFile = previous.pendingTrackedFiles[index];
        const nextFile = next.pendingTrackedFiles[index];
        if (
            previousFile?.identityKey !== nextFile?.identityKey ||
            previousFile?.updatedAt !== nextFile?.updatedAt
        ) {
            return false;
        }
    }

    for (let index = 0; index < previous.trackedFiles.length; index += 1) {
        const previousFile = previous.trackedFiles[index];
        const nextFile = next.trackedFiles[index];
        if (
            previousFile?.identityKey !== nextFile?.identityKey ||
            previousFile?.updatedAt !== nextFile?.updatedAt
        ) {
            return false;
        }
    }

    return true;
}

function getMessageRowId(
    message: AiSessionSnapshot["messages"][number],
): string {
    return `message:${message.id}`;
}

function getToolRowId(entry: ToolActivityReviewEntry): string {
    return `tool:${entry.activity.sessionId}:${entry.activity.id}`;
}

const LOCAL_TURN_STARTED_ACTIVITY_ID_PREFIX = "comando:status:turn:local:";

function createLocalTurnStartedActivity(input: {
    readonly activeTurnStartedAt: string;
    readonly sessionId: string;
}): AiSessionSnapshot["toolActivity"][number] {
    return {
        action: null,
        createdAt: input.activeTurnStartedAt,
        diffs: [],
        exitCode: null,
        id: `${LOCAL_TURN_STARTED_ACTIVITY_ID_PREFIX}${input.activeTurnStartedAt}`,
        kind: "status",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: input.sessionId,
        status: "completed",
        summary: null,
        terminalOutput: null,
        title: "New turn",
        updatedAt: input.activeTurnStartedAt,
    };
}

function isCurrentTurnStartedActivity(
    activity: AiSessionSnapshot["toolActivity"][number],
    activeTurnStartedAt: string,
): boolean {
    return (
        isTurnStartedActivity(activity) &&
        activity.createdAt >= activeTurnStartedAt
    );
}

function getLocalTurnSessionId(
    messages: readonly AiSessionSnapshot["messages"][number][],
    toolActivity: readonly AiSessionSnapshot["toolActivity"][number][],
): string {
    return (
        toolActivity[toolActivity.length - 1]?.sessionId ??
        messages[messages.length - 1]?.id ??
        "local"
    );
}

function hasUserMessageBefore(
    messages: readonly AiSessionSnapshot["messages"][number][],
    createdAt: string,
): boolean {
    return messages.some(
        (message) => message.kind === "user" && message.createdAt < createdAt,
    );
}

function prepareTimelineToolActivity(
    snapshot: Pick<
        AiSessionSnapshot,
        "messages" | "status" | "toolActivity"
    > & {
        readonly activeTurnStartedAt?: string | null;
    },
): readonly AiSessionSnapshot["toolActivity"][number][] {
    const visibleToolActivity = snapshot.toolActivity.filter(
        (activity) =>
            !isTurnStartedActivity(activity) ||
            hasUserMessageBefore(snapshot.messages, activity.createdAt),
    );

    if (
        !isStreamingStatus(snapshot.status) ||
        !snapshot.activeTurnStartedAt
    ) {
        return visibleToolActivity;
    }

    const currentTurnStartedAt = snapshot.activeTurnStartedAt;
    const toolActivity = visibleToolActivity.filter(
        (activity) =>
            !isCurrentTurnStartedActivity(activity, currentTurnStartedAt),
    );

    if (!hasUserMessageBefore(snapshot.messages, currentTurnStartedAt)) {
        return toolActivity;
    }

    return [
        ...toolActivity,
        createLocalTurnStartedActivity({
            activeTurnStartedAt: currentTurnStartedAt,
            sessionId: getLocalTurnSessionId(
                snapshot.messages,
                snapshot.toolActivity,
            ),
        }),
    ];
}

function getRowCreatedAt(row: ChatTimelineAtomicRow): string {
    return row.kind === "message"
        ? row.message.createdAt
        : row.reviewEntry.activity.createdAt;
}

function getRowSortPriority(row: ChatTimelineAtomicRow): number {
    if (
        row.kind === "tool" &&
        isTurnStartedActivity(row.reviewEntry.activity)
    ) {
        return 0;
    }

    if (row.kind === "message" && row.message.kind === "user") {
        return 1;
    }

    return 2;
}

function isContextCompactionActivity(
    row: ChatTimelineAtomicRow,
    activeTurnStartedAt: string | null | undefined,
): boolean {
    if (row.kind !== "tool") {
        return false;
    }

    if (!activeTurnStartedAt) {
        return false;
    }

    const activity = row.reviewEntry.activity;
    return (
        activity.id.startsWith("codex-acp:status:item:") &&
        activity.title === "Compacting context" &&
        activity.status === "in_progress" &&
        activity.updatedAt >= activeTurnStartedAt
    );
}

function compareRows(
    left: ChatTimelineAtomicRow,
    right: ChatTimelineAtomicRow,
): number {
    const createdAtComparison = getRowCreatedAt(left).localeCompare(
        getRowCreatedAt(right),
    );

    if (createdAtComparison !== 0) {
        return createdAtComparison;
    }

    const priorityComparison =
        getRowSortPriority(left) - getRowSortPriority(right);
    if (priorityComparison !== 0) {
        return priorityComparison;
    }

    return left.id.localeCompare(right.id);
}

function createRowById(
    previous: ChatTimelineModel | null,
    messages: readonly AiSessionSnapshot["messages"][number][],
    toolEntries: readonly ToolActivityReviewEntry[],
): Map<string, ChatTimelineAtomicRow> {
    const nextRowById = new Map<string, ChatTimelineAtomicRow>();

    for (const message of messages) {
        const rowId = getMessageRowId(message);
        const previousRow = previous?.atomicRowById.get(rowId) ?? null;

        if (
            previousRow?.kind === "message" &&
            areMessagesEquivalent(previousRow.message, message)
        ) {
            nextRowById.set(rowId, previousRow);
            continue;
        }

        nextRowById.set(rowId, {
            id: rowId,
            kind: "message",
            message,
        });
    }

    for (const reviewEntry of toolEntries) {
        const rowId = getToolRowId(reviewEntry);
        const previousRow = previous?.atomicRowById.get(rowId) ?? null;

        if (
            previousRow?.kind === "tool" &&
            areToolActivityReviewEntriesEquivalent(
                previousRow.reviewEntry,
                reviewEntry,
            )
        ) {
            nextRowById.set(rowId, previousRow);
            continue;
        }

        nextRowById.set(rowId, {
            id: rowId,
            kind: "tool",
            reviewEntry,
        });
    }

    return nextRowById;
}

function buildOrderedRows(
    rowById: ReadonlyMap<string, ChatTimelineAtomicRow>,
): ChatTimelineAtomicRow[] {
    return [...rowById.values()].sort(compareRows);
}

function addPath(paths: string[], path: string | null | undefined): void {
    const normalizedPath = path?.trim();
    if (
        normalizedPath &&
        !paths.some((existingPath) =>
            areTrackedFilePathReferencesEquivalent(
                existingPath,
                normalizedPath,
            ),
        )
    ) {
        paths.push(normalizedPath);
    }
}

function buildToolActivitySegmentSummary(
    entries: readonly ToolActivitySegmentEntry[],
): ToolActivitySegmentSummary {
    const latestEntry = entries.at(-1);
    if (!latestEntry) {
        throw new Error("Tool activity segments require at least one entry.");
    }

    const fileTargets: string[] = [];
    const changedFileTargets: string[] = [];
    let changeCount = 0;
    let commandCount = 0;
    let failureCount = 0;
    let hiddenActivityCount = 0;
    let searchCount = 0;
    let updatedAt =
        entries[0]?.reviewEntry.activity.updatedAt ??
        latestEntry.reviewEntry.activity.updatedAt;

    for (const entry of entries) {
        const { activity, trackedFiles } = entry.reviewEntry;
        const descriptor = getToolActivityDescriptor(activity);
        if (descriptor.category === "command") {
            commandCount += 1;
        } else if (descriptor.category === "search") {
            searchCount += 1;
        } else if (descriptor.category === "file" && descriptor.target) {
            addPath(fileTargets, descriptor.target);
        }

        for (const location of activity.locations) {
            addPath(fileTargets, location.path);
        }
        for (const diff of activity.diffs) {
            addPath(fileTargets, diff.path);
            addPath(fileTargets, diff.previousPath);
            if (entry.policy === "standalone-change") {
                addPath(changedFileTargets, diff.path);
            }
        }
        for (const trackedFile of trackedFiles) {
            addPath(fileTargets, trackedFile.path);
            addPath(fileTargets, trackedFile.previousPath);
            if (entry.policy === "standalone-change") {
                addPath(changedFileTargets, trackedFile.path);
            }
        }

        if (entry.policy === "standalone-change") {
            changeCount += 1;
        }
        if (entry.policy === "groupable") {
            hiddenActivityCount += 1;
        }
        if (
            activity.status === "failed" ||
            (activity.exitCode !== null && activity.exitCode !== 0)
        ) {
            failureCount += 1;
        }

        if (activity.updatedAt > updatedAt) {
            updatedAt = activity.updatedAt;
        }
    }

    return {
        actionCount: entries.length,
        changeCount,
        changedFileCount: changedFileTargets.length,
        commandCount,
        failureCount,
        fileCount: fileTargets.length,
        hiddenActivityCount,
        isInProgress: entries.some(
            (entry) =>
                entry.reviewEntry.activity.status === "pending" ||
                entry.reviewEntry.activity.status === "in_progress",
        ),
        latestActivityId: latestEntry.reviewEntry.activity.id,
        latestTitle: latestEntry.reviewEntry.activity.title,
        searchCount,
        startedAt:
            entries[0]?.reviewEntry.activity.createdAt ??
            latestEntry.reviewEntry.activity.createdAt,
        updatedAt,
    };
}

function areToolActivitySegmentSummariesEquivalent(
    previous: ToolActivitySegmentSummary,
    next: ToolActivitySegmentSummary,
): boolean {
    return (
        previous.actionCount === next.actionCount &&
        previous.changeCount === next.changeCount &&
        previous.changedFileCount === next.changedFileCount &&
        previous.commandCount === next.commandCount &&
        previous.failureCount === next.failureCount &&
        previous.fileCount === next.fileCount &&
        previous.hiddenActivityCount === next.hiddenActivityCount &&
        previous.isInProgress === next.isInProgress &&
        previous.latestActivityId === next.latestActivityId &&
        previous.latestTitle === next.latestTitle &&
        previous.searchCount === next.searchCount &&
        previous.startedAt === next.startedAt &&
        previous.updatedAt === next.updatedAt
    );
}

function reuseToolActivitySegmentRow(
    previousRowById: ReadonlyMap<string, ChatTimelinePresentationRow> | null,
    id: string,
    entries: readonly ToolActivitySegmentEntry[],
): ChatTimelineActivitySegmentRow {
    const summary = buildToolActivitySegmentSummary(entries);
    const previousRow = previousRowById?.get(id);

    if (
        previousRow?.kind === "activity-segment" &&
        previousRow.entries.length === entries.length &&
        previousRow.entries.every(
            (entry, index) =>
                entry.policy === entries[index]?.policy &&
                entry.reviewEntry === entries[index]?.reviewEntry,
        ) &&
        areToolActivitySegmentSummariesEquivalent(previousRow.summary, summary)
    ) {
        return previousRow;
    }

    return {
        entries,
        id,
        kind: "activity-segment",
        summary,
    };
}

export function buildChatTimelinePresentationRows(
    atomicRows: readonly ChatTimelineAtomicRow[],
    context: ToolActivityPresentationContext,
    previousRowById: ReadonlyMap<string, ChatTimelinePresentationRow> | null = null,
): ChatTimelinePresentationRow[] {
    const presentationRows: ChatTimelinePresentationRow[] = [];
    let segmentEntries: ToolActivitySegmentEntry[] = [];
    let segmentSessionId: string | null = null;

    const flushSegment = () => {
        const firstEntry = segmentEntries[0];
        if (!firstEntry || segmentSessionId === null) {
            segmentEntries = [];
            segmentSessionId = null;
            return;
        }

        const id = `activity-segment:${segmentSessionId}:${firstEntry.reviewEntry.activity.id}`;
        presentationRows.push(
            reuseToolActivitySegmentRow(previousRowById, id, segmentEntries),
        );
        segmentEntries = [];
        segmentSessionId = null;
    };

    for (const row of atomicRows) {
        if (row.kind === "message") {
            flushSegment();
            presentationRows.push(row);
            continue;
        }

        const policy = getToolActivityPresentationPolicy(
            row.reviewEntry,
            context,
        );
        if (policy === "structural") {
            flushSegment();
            // Turn markers remain internal boundaries and should not appear in chat.
            if (!isTurnStartedActivity(row.reviewEntry.activity)) {
                presentationRows.push(row);
            }
            continue;
        }

        const sessionId = row.reviewEntry.activity.sessionId;
        if (segmentSessionId !== null && segmentSessionId !== sessionId) {
            flushSegment();
        }
        segmentSessionId = sessionId;
        segmentEntries.push({ policy, reviewEntry: row.reviewEntry });
    }

    flushSegment();
    return presentationRows;
}

function createPresentationRowById(
    rows: readonly ChatTimelinePresentationRow[],
): Map<string, ChatTimelinePresentationRow> {
    return new Map(rows.map((row) => [row.id, row]));
}

export function findPresentationRowContaining(
    presentationRows: readonly ChatTimelinePresentationRow[],
    atomicRow: ChatTimelineAtomicRow | null,
): ChatTimelinePresentationRow | null {
    if (!atomicRow) {
        return null;
    }

    for (const row of presentationRows) {
        if (row.id === atomicRow.id) {
            return row;
        }
        if (
            row.kind === "activity-segment" &&
            atomicRow.kind === "tool" &&
            row.entries.some(
                (entry) =>
                    entry.reviewEntry.activity.sessionId ===
                        atomicRow.reviewEntry.activity.sessionId &&
                    entry.reviewEntry.activity.id ===
                        atomicRow.reviewEntry.activity.id,
            )
        ) {
            return row;
        }
    }

    return null;
}

function reuseRowIds<Row extends { readonly id: string }>(
    previousRowIds: readonly string[] | null | undefined,
    nextRows: readonly Row[],
): readonly string[] {
    const nextRowIds = nextRows.map((row) => row.id);

    if (
        previousRowIds &&
        previousRowIds.length === nextRowIds.length &&
        previousRowIds.every((rowId, index) => rowId === nextRowIds[index])
    ) {
        return previousRowIds;
    }

    return nextRowIds;
}

function reuseRows<Row>(
    previousRows: readonly Row[] | null | undefined,
    nextRows: readonly Row[],
): readonly Row[] {
    if (
        previousRows &&
        previousRows.length === nextRows.length &&
        previousRows.every((row, index) => row === nextRows[index])
    ) {
        return previousRows;
    }

    return nextRows;
}

function isStreamingStatus(status: AiSessionSnapshot["status"]): boolean {
    return status === "starting" || status === "streaming";
}

const EMPTY_ATTENTION_TOOL_CALL_IDS: ReadonlySet<string> = new Set();

function getStreamingLiveTailRow(
    status: AiSessionSnapshot["status"],
    orderedRows: readonly ChatTimelineAtomicRow[],
    activeTurnStartedAt: string | null | undefined,
): ChatTimelineAtomicRow | null {
    if (!isStreamingStatus(status) || orderedRows.length === 0) {
        return null;
    }

    const tailCandidate = orderedRows[orderedRows.length - 1] ?? null;
    if (!tailCandidate) {
        return null;
    }

    if (
        tailCandidate.kind === "message" &&
        tailCandidate.message.kind === "user"
    ) {
        for (let index = orderedRows.length - 2; index >= 0; index -= 1) {
            const row = orderedRows[index];
            if (row && isContextCompactionActivity(row, activeTurnStartedAt)) {
                return row;
            }
        }

        // User messages must stay in history so they keep the same React owner
        // when the first assistant or tool row arrives for the turn.
        return null;
    }

    return tailCandidate;
}

export function reconcileChatTimelineModel(
    previous: ChatTimelineModel | null,
    snapshot: Pick<
        AiSessionSnapshot,
        "messages" | "status" | "toolActivity" | "trackedFiles"
    > & {
        readonly activeTurnStartedAt?: string | null;
        readonly attentionToolCallIds?: ReadonlySet<string>;
    },
): ChatTimelineModel {
    const toolEntries = deriveToolActivityReviewEntries(
        prepareTimelineToolActivity(snapshot),
        snapshot.trackedFiles,
    );
    const atomicRowById = createRowById(
        previous,
        snapshot.messages,
        toolEntries,
    );
    const orderedAtomicRows = reuseRows(
        previous?.orderedAtomicRows,
        buildOrderedRows(atomicRowById),
    );
    const orderedAtomicRowIds = reuseRowIds(
        previous?.orderedAtomicRowIds,
        orderedAtomicRows,
    );
    const atomicLiveTailRow = getStreamingLiveTailRow(
        snapshot.status,
        orderedAtomicRows,
        snapshot.activeTurnStartedAt,
    );
    const atomicLiveTailRowId = atomicLiveTailRow?.id ?? null;
    const nextAtomicHistoryRows =
        atomicLiveTailRow == null
            ? [...orderedAtomicRows]
            : orderedAtomicRows.filter((row) => row !== atomicLiveTailRow);
    const atomicHistoryRows = reuseRows(
        previous?.atomicHistoryRows,
        nextAtomicHistoryRows,
    );
    const atomicHistoryRowIds = reuseRowIds(
        previous?.atomicHistoryRowIds,
        atomicHistoryRows,
    );

    const nextOrderedRows = buildChatTimelinePresentationRows(
        orderedAtomicRows,
        {
            attentionToolCallIds:
                snapshot.attentionToolCallIds ??
                EMPTY_ATTENTION_TOOL_CALL_IDS,
        },
        previous?.presentationRowById ?? null,
    );
    const orderedRows = reuseRows(previous?.orderedRows, nextOrderedRows);
    const orderedRowIds = reuseRowIds(previous?.orderedRowIds, orderedRows);
    const liveTailRow = findPresentationRowContaining(
        orderedRows,
        atomicLiveTailRow,
    );
    const liveTailRowId = liveTailRow?.id ?? null;
    const nextHistoryRows =
        liveTailRow == null
            ? [...orderedRows]
            : orderedRows.filter((row) => row !== liveTailRow);
    const historyRows = reuseRows(previous?.historyRows, nextHistoryRows);
    const historyRowIds = reuseRowIds(previous?.historyRowIds, historyRows);

    return {
        atomicHistoryRowIds,
        atomicHistoryRows,
        atomicLiveTailRow,
        atomicLiveTailRowId,
        atomicRowById,
        historyRowIds,
        historyRows,
        liveTailRow,
        liveTailRowId,
        orderedAtomicRowIds,
        orderedAtomicRows,
        orderedRowIds,
        orderedRows,
        presentationRowById: createPresentationRowById(orderedRows),
    };
}

export function reconcileChatTimelineModelFromTranscript(
    previous: ChatTimelineModel | null,
    input: {
        readonly activeTurnStartedAt?: string | null;
        readonly attentionToolCallIds?: ReadonlySet<string>;
        readonly status: AiSessionSnapshot["status"];
        readonly trackedFiles: AiSessionSnapshot["trackedFiles"];
        readonly transcript: AiSessionTranscriptModel;
    },
): ChatTimelineModel {
    return reconcileChatTimelineModel(previous, {
        messages: getAiSessionTranscriptMessages(input.transcript),
        activeTurnStartedAt: input.activeTurnStartedAt,
        attentionToolCallIds: input.attentionToolCallIds,
        status: input.status,
        toolActivity: getAiSessionTranscriptToolActivity(input.transcript),
        trackedFiles: input.trackedFiles,
    });
}
