import type {
    AiGeneratedImage,
    AiImageAttachment,
    AiSessionSnapshot,
} from "@shared/ipc";
import {
    getAiTranscriptMessageEntryId,
    getAiTranscriptToolEntryId,
} from "@shared/ai-transcript";
import {
    getAiSessionTranscriptMessages,
    getAiSessionTranscriptMutation,
    getAiSessionTranscriptToolActivity,
    isAiSessionTranscriptMutationFrom,
    type AiSessionTranscriptModel,
} from "@renderer/app/ai/transcriptModel";
import {
    buildBlockNativeTranscriptBootstrap,
    type BlockNativeTranscriptProjection,
} from "@renderer/app/ai/transcriptWindowProjection";
import { TrackedFilePathReferenceSet } from "@renderer/app/ai/trackedFilePath";

import {
    createToolActivityReviewIndex,
    deriveToolActivityReviewEntry,
    deriveToolActivityReviewEntriesFromIndex,
    type ToolActivityReviewEntry,
} from "./toolActivityReviewModel";
import { getToolActivityDescriptor } from "./toolActivityDescriptor";
import {
    getToolActivityPresentationPolicy,
    type ToolActivityPresentationContext,
    type ToolActivityPresentationPolicy,
} from "./toolActivityPresentation";
import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";
import { isTurnStartedActivity } from "./toolActivityKinds";
import {
    deriveActivitySegmentChangeStats,
    type ActivitySegmentChangeStats,
} from "./activitySegmentChangeStats";

export interface ChatTimelineMessageRow {
    readonly blockId: string | null;
    readonly id: string;
    readonly kind: "message";
    readonly message: AiSessionSnapshot["messages"][number];
}

export interface ChatTimelineToolRow {
    readonly blockId: string | null;
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

export type ActivitySegmentItem =
    | {
          readonly entry: ToolActivitySegmentEntry;
          readonly kind: "tool";
      }
    | {
          readonly kind: "thinking";
          readonly message: AiSessionSnapshot["messages"][number];
      };

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
    readonly blockId: string | null;
    readonly changeStats: ActivitySegmentChangeStats;
    readonly entries: readonly ToolActivitySegmentEntry[];
    readonly id: string;
    readonly items: readonly ActivitySegmentItem[];
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
    readonly retainedTailRow: ChatTimelinePresentationRow | null;
    readonly retainedTailRowId: string | null;
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
    blockIdByEntryId: ReadonlyMap<string, string>,
): Map<string, ChatTimelineAtomicRow> {
    const nextRowById = new Map<string, ChatTimelineAtomicRow>();

    for (const message of messages) {
        const rowId = getMessageRowId(message);
        const previousRow = previous?.atomicRowById.get(rowId) ?? null;
        const blockId =
            blockIdByEntryId.get(
                getAiTranscriptMessageEntryId(message.id),
            ) ?? null;

        if (
            previousRow?.kind === "message" &&
            previousRow.blockId === blockId &&
            areMessagesEquivalent(previousRow.message, message)
        ) {
            nextRowById.set(rowId, previousRow);
            continue;
        }

        nextRowById.set(rowId, {
            blockId,
            id: rowId,
            kind: "message",
            message,
        });
    }

    for (const reviewEntry of toolEntries) {
        const rowId = getToolRowId(reviewEntry);
        const previousRow = previous?.atomicRowById.get(rowId) ?? null;
        const blockId =
            blockIdByEntryId.get(
                getAiTranscriptToolEntryId(
                    reviewEntry.activity.sessionId,
                    reviewEntry.activity.id,
                ),
            ) ?? null;

        if (
            previousRow?.kind === "tool" &&
            previousRow.blockId === blockId &&
            areToolActivityReviewEntriesEquivalent(
                previousRow.reviewEntry,
                reviewEntry,
            )
        ) {
            nextRowById.set(rowId, previousRow);
            continue;
        }

        nextRowById.set(rowId, {
            blockId,
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

function addPath(
    paths: TrackedFilePathReferenceSet,
    path: string | null | undefined,
): void {
    paths.add(path);
}

function buildToolActivitySegmentSummary(
    items: readonly ActivitySegmentItem[],
): ToolActivitySegmentSummary {
    const latestItem = items.at(-1);
    if (!latestItem) {
        throw new Error("Tool activity segments require at least one entry.");
    }

    const entries = items.flatMap((item) =>
        item.kind === "tool" ? [item.entry] : [],
    );
    const latestTitle =
        latestItem.kind === "thinking"
            ? latestItem.message.status === "streaming"
                ? "Thinking..."
                : "Thinking"
            : latestItem.entry.reviewEntry.activity.title;
    const latestActivityId =
        latestItem.kind === "thinking"
            ? latestItem.message.id
            : latestItem.entry.reviewEntry.activity.id;
    const firstItem = items[0] ?? latestItem;
    const firstCreatedAt =
        firstItem.kind === "thinking"
            ? firstItem.message.createdAt
            : firstItem.entry.reviewEntry.activity.createdAt;
    const latestUpdatedAt =
        latestItem.kind === "thinking"
            ? latestItem.message.createdAt
            : latestItem.entry.reviewEntry.activity.updatedAt;

    const fileTargets = new TrackedFilePathReferenceSet();
    const changedFileTargets = new TrackedFilePathReferenceSet();
    let changeCount = 0;
    let commandCount = 0;
    let failureCount = 0;
    let searchCount = 0;
    let updatedAt = latestUpdatedAt;

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
        changedFileCount: changedFileTargets.size,
        commandCount,
        failureCount,
        fileCount: fileTargets.size,
        hiddenActivityCount: entries.length,
        isInProgress: items.some((item) =>
            item.kind === "thinking"
                ? item.message.status === "streaming"
                : item.entry.reviewEntry.activity.status === "pending" ||
                  item.entry.reviewEntry.activity.status === "in_progress",
        ),
        latestActivityId,
        latestTitle,
        searchCount,
        startedAt: firstCreatedAt,
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
    blockId: string | null,
    id: string,
    items: readonly ActivitySegmentItem[],
): ChatTimelineActivitySegmentRow {
    const entries = items.flatMap((item) =>
        item.kind === "tool" ? [item.entry] : [],
    );
    const summary = buildToolActivitySegmentSummary(items);
    const previousRow = previousRowById?.get(id);
    const itemsAreUnchanged =
        previousRow?.kind === "activity-segment" &&
        previousRow.blockId === blockId &&
        previousRow.items.length === items.length &&
        previousRow.items.every((item, index) => {
            const nextItem = items[index];
            if (!nextItem || item.kind !== nextItem.kind) {
                return false;
            }
            return item.kind === "thinking"
                ? item.message ===
                      (nextItem as Extract<
                          ActivitySegmentItem,
                          { readonly kind: "thinking" }
                      >).message
                : item.entry.policy ===
                      (nextItem as Extract<
                          ActivitySegmentItem,
                          { readonly kind: "tool" }
                      >).entry.policy &&
                      item.entry.reviewEntry ===
                          (nextItem as Extract<
                              ActivitySegmentItem,
                              { readonly kind: "tool" }
                          >).entry.reviewEntry;
        });

    if (
        previousRow?.kind === "activity-segment" &&
        itemsAreUnchanged &&
        areToolActivitySegmentSummariesEquivalent(previousRow.summary, summary)
    ) {
        return previousRow;
    }

    incrementChatPerformanceCounter("activity_segments_rebuilt");
    return {
        // Diff aggregation is expensive; only rebuild it with a changed segment.
        blockId,
        changeStats: deriveActivitySegmentChangeStats(entries),
        entries,
        id,
        items,
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
    let segmentItems: ActivitySegmentItem[] = [];
    let segmentBlockId: string | null = null;
    let segmentSessionId: string | null = null;

    const flushSegment = () => {
        const firstItem = segmentItems[0];
        if (!firstItem) {
            segmentItems = [];
            segmentBlockId = null;
            segmentSessionId = null;
            return;
        }

        const firstItemKey =
            firstItem.kind === "thinking"
                ? `thinking:${firstItem.message.id}`
                : `${firstItem.entry.reviewEntry.activity.sessionId}:${firstItem.entry.reviewEntry.activity.id}`;
        const id = `activity-segment:${firstItemKey}`;
        presentationRows.push(
            reuseToolActivitySegmentRow(
                previousRowById,
                segmentBlockId,
                id,
                segmentItems,
            ),
        );
        segmentItems = [];
        segmentBlockId = null;
        segmentSessionId = null;
    };

    for (const row of atomicRows) {
        if (segmentItems.length > 0 && segmentBlockId !== row.blockId) {
            flushSegment();
        }
        segmentBlockId = row.blockId;
        if (row.kind === "message") {
            if (row.message.kind === "thinking") {
                segmentItems.push({ kind: "thinking", message: row.message });
                continue;
            }
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
        const entry = { policy, reviewEntry: row.reviewEntry };
        segmentItems.push({ entry, kind: "tool" });
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
            row.items.some((item) =>
                atomicRow.kind === "tool" && item.kind === "tool"
                    ? item.entry.reviewEntry.activity.sessionId ===
                          atomicRow.reviewEntry.activity.sessionId &&
                      item.entry.reviewEntry.activity.id ===
                          atomicRow.reviewEntry.activity.id
                    : atomicRow.kind === "message" && item.kind === "thinking"
                      ? item.message.id === atomicRow.message.id
                      : false,
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
const EMPTY_BLOCK_ID_BY_ENTRY_ID: ReadonlyMap<string, string> = new Map();

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

function getPreviousToolReviewEntries(
    previous: ChatTimelineModel | null,
): readonly ToolActivityReviewEntry[] {
    if (!previous) {
        return [];
    }

    return [...previous.atomicRowById.values()].flatMap((row) =>
        row.kind === "tool" ? [row.reviewEntry] : [],
    );
}

export function reconcileChatTimelineModel(
    previous: ChatTimelineModel | null,
    snapshot: Pick<
        AiSessionSnapshot,
        "messages" | "status" | "toolActivity" | "trackedFiles"
    > & {
        readonly activeTurnStartedAt?: string | null;
        readonly attentionToolCallIds?: ReadonlySet<string>;
        readonly blockIdByEntryId?: ReadonlyMap<string, string>;
    },
): ChatTimelineModel {
    incrementChatPerformanceCounter("timeline_full_rebuilds");
    incrementChatPerformanceCounter(
        "timeline_rows_reconciled",
        snapshot.messages.length + snapshot.toolActivity.length,
    );
    const reviewIndex = createToolActivityReviewIndex(snapshot.trackedFiles);
    const toolEntries = deriveToolActivityReviewEntriesFromIndex(
        prepareTimelineToolActivity(snapshot),
        reviewIndex,
        getPreviousToolReviewEntries(previous),
    );
    const atomicRowById = createRowById(
        previous,
        snapshot.messages,
        toolEntries,
        snapshot.blockIdByEntryId ?? EMPTY_BLOCK_ID_BY_ENTRY_ID,
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
    const nextAtomicHistoryRows = atomicLiveTailRow
        ? orderedAtomicRows.filter((row) => row !== atomicLiveTailRow)
        : [...orderedAtomicRows];
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
    const retainedTailRow = resolveRetainedTailRow(
        previous,
        orderedRows,
        liveTailRow,
        snapshot.status,
    );
    const retainedTailRowId = retainedTailRow?.id ?? null;
    const hotTailRow = liveTailRow ?? retainedTailRow;
    const nextHistoryRows = hotTailRow
        ? orderedRows.filter((row) => row !== hotTailRow)
        : [...orderedRows];
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
        retainedTailRow,
        retainedTailRowId,
    };
}

function resolveRetainedTailRow(
    previous: ChatTimelineModel | null,
    orderedRows: readonly ChatTimelinePresentationRow[],
    liveTailRow: ChatTimelinePresentationRow | null,
    status: AiSessionSnapshot["status"],
): ChatTimelinePresentationRow | null {
    if (liveTailRow || isStreamingStatus(status)) {
        return null;
    }

    const previousTail = previous?.liveTailRow ?? previous?.retainedTailRow;
    if (!previousTail) {
        return null;
    }

    // Retain one completed tail under the same React owner until the next turn
    // starts, avoiding a completion-time remount in the virtual list.
    return (
        orderedRows.find((row) => row.id === previousTail.id) ?? null
    );
}

export interface ChatTimelineTranscriptInput {
    readonly activeTurnStartedAt?: string | null;
    readonly attentionToolCallIds?: ReadonlySet<string>;
    readonly blockIdByEntryId?: ReadonlyMap<string, string>;
    readonly status: AiSessionSnapshot["status"];
    readonly trackedFiles: AiSessionSnapshot["trackedFiles"];
    readonly transcript: AiSessionTranscriptModel;
}

export interface ChatTimelineProjectionInput {
    readonly activeTurnStartedAt?: string | null;
    readonly attentionToolCallIds?: ReadonlySet<string>;
    readonly projection: BlockNativeTranscriptProjection;
    readonly status: AiSessionSnapshot["status"];
    readonly trackedFiles: AiSessionSnapshot["trackedFiles"];
    readonly updatedAt: string;
}

interface ChatTimelineReconciliationDiagnostics {
    readonly fallbackCount: number;
    readonly incrementalCount: number;
}

let chatTimelineFallbackCount = 0;
let chatTimelineIncrementalCount = 0;

export function getChatTimelineReconciliationDiagnostics(): ChatTimelineReconciliationDiagnostics {
    return {
        fallbackCount: chatTimelineFallbackCount,
        incrementalCount: chatTimelineIncrementalCount,
    };
}

export function resetChatTimelineReconciliationDiagnosticsForTests(): void {
    chatTimelineFallbackCount = 0;
    chatTimelineIncrementalCount = 0;
}

export function reconcileChatTimelineModelFromTranscript(
    previous: ChatTimelineModel | null,
    input: ChatTimelineTranscriptInput,
): ChatTimelineModel {
    return reconcileChatTimelineModel(previous, {
        messages: getAiSessionTranscriptMessages(input.transcript),
        activeTurnStartedAt: input.activeTurnStartedAt,
        attentionToolCallIds: input.attentionToolCallIds,
        blockIdByEntryId: input.blockIdByEntryId,
        status: input.status,
        toolActivity: getAiSessionTranscriptToolActivity(input.transcript),
        trackedFiles: input.trackedFiles,
    });
}

export function reconcileChatTimelineModelIncrementallyFromTranscript(
    previous: ChatTimelineModel | null,
    previousTranscript: AiSessionTranscriptModel | null,
    input: ChatTimelineTranscriptInput,
    buildFallbackTranscript: (() => AiSessionTranscriptModel) | null = null,
): ChatTimelineModel {
    if (!previous || !previousTranscript) {
        return reconcileChatTimelineModelFromTranscript(previous, {
            ...input,
            transcript: buildFallbackTranscript?.() ?? input.transcript,
        });
    }
    if (
        !isAiSessionTranscriptMutationFrom(
            input.transcript,
            previousTranscript,
        )
    ) {
        chatTimelineFallbackCount += 1;
        return reconcileChatTimelineModelFromTranscript(previous, {
            ...input,
            transcript: buildFallbackTranscript?.() ?? input.transcript,
        });
    }

    const mutation = getAiSessionTranscriptMutation(input.transcript);
    const incrementalModel =
        mutation.kind === "patch"
            ? reconcileLiveTailPatch(
                  previous,
                  input,
                  mutation.entryId,
              )
            : mutation.kind === "append"
              ? reconcileLiveTailAppend(
                    previous,
                    input,
                    mutation.entryId,
                )
              : null;
    if (incrementalModel) {
        chatTimelineIncrementalCount += 1;
        incrementChatPerformanceCounter("timeline_rows_reconciled");
        incrementChatPerformanceCounter("timeline_tail_patches");
        return incrementalModel;
    }

    chatTimelineFallbackCount += 1;
    return reconcileChatTimelineModelFromTranscript(previous, {
        ...input,
        transcript: buildFallbackTranscript?.() ?? input.transcript,
    });
}

export function reconcileChatTimelineModelFromProjection(
    previous: ChatTimelineModel | null,
    previousProjection: BlockNativeTranscriptProjection | null,
    input: ChatTimelineProjectionInput,
): ChatTimelineModel {
    const blockIdByEntryId = input.projection.sealed.blockIdByEntryId;
    if (
        previous &&
        previousProjection?.sealed === input.projection.sealed
    ) {
        if (
            previousProjection.hot === input.projection.hot ||
            previousProjection.hot.transcript === input.projection.hot.transcript
        ) {
            return previous;
        }
        return reconcileChatTimelineModelIncrementallyFromTranscript(
            previous,
            previousProjection.hot.transcript,
            {
                activeTurnStartedAt: input.activeTurnStartedAt,
                attentionToolCallIds: input.attentionToolCallIds,
                blockIdByEntryId,
                status: input.status,
                trackedFiles: input.trackedFiles,
                transcript: input.projection.hot.transcript,
            },
            () =>
                buildBlockNativeTranscriptBootstrap(input.projection, {
                    activeTurnStartedAt: input.activeTurnStartedAt ?? null,
                    status: input.status,
                    updatedAt: input.updatedAt,
                }),
        );
    }

    return reconcileChatTimelineModelFromTranscript(previous, {
        activeTurnStartedAt: input.activeTurnStartedAt,
        attentionToolCallIds: input.attentionToolCallIds,
        blockIdByEntryId,
        status: input.status,
        trackedFiles: input.trackedFiles,
        transcript: buildBlockNativeTranscriptBootstrap(input.projection, {
            activeTurnStartedAt: input.activeTurnStartedAt ?? null,
            status: input.status,
            updatedAt: input.updatedAt,
        }),
    });
}

function reconcileLiveTailPatch(
    previous: ChatTimelineModel,
    input: ChatTimelineTranscriptInput,
    entryId: string,
): ChatTimelineModel | null {
    const nextAtomicRow = getTranscriptAtomicRow(input, entryId);
    const previousAtomicRow = previous.atomicLiveTailRow;
    if (
        !nextAtomicRow ||
        !previousAtomicRow ||
        previousAtomicRow.id !== nextAtomicRow.id ||
        previous.orderedAtomicRows.at(-1) !== previousAtomicRow
    ) {
        return null;
    }

    const presentation = replaceLiveTailPresentationRow(
        previous,
        nextAtomicRow,
        input.attentionToolCallIds ?? EMPTY_ATTENTION_TOOL_CALL_IDS,
    );
    if (!presentation) {
        return null;
    }

    const atomicRowById = new Map(previous.atomicRowById);
    atomicRowById.set(nextAtomicRow.id, nextAtomicRow);
    const presentationRowById = new Map(previous.presentationRowById);
    presentationRowById.set(presentation.liveTailRow.id, presentation.liveTailRow);
    return {
        ...previous,
        atomicLiveTailRow: nextAtomicRow,
        atomicRowById,
        liveTailRow: presentation.liveTailRow,
        liveTailRowId: presentation.liveTailRow.id,
        orderedAtomicRows: replaceLastTimelineRow(
            previous.orderedAtomicRows,
            nextAtomicRow,
        ),
        orderedRows: presentation.orderedRows,
        presentationRowById,
        retainedTailRow: null,
        retainedTailRowId: null,
    };
}

function reconcileLiveTailAppend(
    previous: ChatTimelineModel,
    input: ChatTimelineTranscriptInput,
    entryId: string,
): ChatTimelineModel | null {
    const nextAtomicRow = getTranscriptAtomicRow(input, entryId);
    if (
        !nextAtomicRow ||
        nextAtomicRow.kind !== "message" ||
        nextAtomicRow.message.kind === "thinking" ||
        nextAtomicRow.message.kind === "user" ||
        !isStreamingStatus(input.status) ||
        (previous.liveTailRow !== null &&
            previous.orderedRows.at(-1) !== previous.liveTailRow)
    ) {
        return null;
    }

    const previousAtomicTail = previous.orderedAtomicRows.at(-1) ?? null;
    if (
        previousAtomicTail &&
        getRowCreatedAt(previousAtomicTail) > getRowCreatedAt(nextAtomicRow)
    ) {
        return null;
    }

    const atomicRowById = new Map(previous.atomicRowById);
    atomicRowById.set(nextAtomicRow.id, nextAtomicRow);
    const presentationRowById = new Map(previous.presentationRowById);
    presentationRowById.set(nextAtomicRow.id, nextAtomicRow);
    return {
        ...previous,
        atomicLiveTailRow: nextAtomicRow,
        atomicLiveTailRowId: nextAtomicRow.id,
        atomicRowById,
        liveTailRow: nextAtomicRow,
        liveTailRowId: nextAtomicRow.id,
        orderedAtomicRowIds: [...previous.orderedAtomicRowIds, nextAtomicRow.id],
        orderedAtomicRows: [...previous.orderedAtomicRows, nextAtomicRow],
        orderedRowIds: [...previous.orderedRowIds, nextAtomicRow.id],
        orderedRows: [...previous.orderedRows, nextAtomicRow],
        presentationRowById,
        retainedTailRow: null,
        retainedTailRowId: null,
    };
}

function getTranscriptAtomicRow(
    input: ChatTimelineTranscriptInput,
    entryId: string,
): ChatTimelineAtomicRow | null {
    const entry = input.transcript.entriesById[entryId];
    if (!entry) {
        return null;
    }

    if (entry.kind === "message") {
        return {
            blockId: input.blockIdByEntryId?.get(entryId) ?? null,
            id: getMessageRowId(entry.message),
            kind: "message",
            message: entry.message,
        };
    }

    if (entry.kind === "tool") {
        const reviewEntry = deriveToolActivityReviewEntry(
            entry.activity,
            createToolActivityReviewIndex(input.trackedFiles),
        );
        return {
            blockId: input.blockIdByEntryId?.get(entryId) ?? null,
            id: getToolRowId(reviewEntry),
            kind: "tool",
            reviewEntry,
        };
    }

    return null;
}

function replaceLiveTailPresentationRow(
    previous: ChatTimelineModel,
    nextAtomicRow: ChatTimelineAtomicRow,
    attentionToolCallIds: ReadonlySet<string>,
): {
    readonly liveTailRow: ChatTimelinePresentationRow;
    readonly orderedRows: readonly ChatTimelinePresentationRow[];
} | null {
    const previousLiveTailRow = previous.liveTailRow;
    if (!previousLiveTailRow || previous.orderedRows.at(-1) !== previousLiveTailRow) {
        return null;
    }

    if (
        previousLiveTailRow.kind === "message" &&
        nextAtomicRow.kind === "message" &&
        nextAtomicRow.message.kind !== "thinking" &&
        previousLiveTailRow.id === nextAtomicRow.id
    ) {
        return {
            liveTailRow: nextAtomicRow,
            orderedRows: replaceLastTimelineRow(
                previous.orderedRows,
                nextAtomicRow,
            ),
        };
    }

    if (previousLiveTailRow.kind !== "activity-segment") {
        return null;
    }

    let replaced = false;
    const items = previousLiveTailRow.items.map((item) => {
        if (
            item.kind === "thinking" &&
            nextAtomicRow.kind === "message" &&
            nextAtomicRow.message.kind === "thinking" &&
            item.message.id === nextAtomicRow.message.id
        ) {
            replaced = true;
            return { kind: "thinking" as const, message: nextAtomicRow.message };
        }

        if (
            item.kind === "tool" &&
            nextAtomicRow.kind === "tool" &&
            item.entry.reviewEntry.activity.id ===
                nextAtomicRow.reviewEntry.activity.id &&
            item.entry.reviewEntry.activity.sessionId ===
                nextAtomicRow.reviewEntry.activity.sessionId
        ) {
            const policy = getToolActivityPresentationPolicy(
                nextAtomicRow.reviewEntry,
                { attentionToolCallIds },
            );
            if (policy === "structural") {
                return item;
            }
            replaced = true;
            return {
                entry: { policy, reviewEntry: nextAtomicRow.reviewEntry },
                kind: "tool" as const,
            };
        }

        return item;
    });
    if (!replaced) {
        return null;
    }

    const nextLiveTailRow = reuseToolActivitySegmentRow(
        new Map([[previousLiveTailRow.id, previousLiveTailRow]]),
        previousLiveTailRow.blockId,
        previousLiveTailRow.id,
        items,
    );
    return {
        liveTailRow: nextLiveTailRow,
        orderedRows: replaceLastTimelineRow(
            previous.orderedRows,
            nextLiveTailRow,
        ),
    };
}

function replaceLastTimelineRow<T>(
    rows: readonly T[],
    nextRow: T,
): readonly T[] {
    return [...rows.slice(0, -1), nextRow];
}
