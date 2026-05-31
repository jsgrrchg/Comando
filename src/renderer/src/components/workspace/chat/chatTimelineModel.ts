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

import {
    deriveToolActivityReviewEntries,
    type ToolActivityReviewEntry,
} from "./toolActivityReviewModel";

export type ChatTimelineRow =
    | {
          readonly id: string;
          readonly kind: "message";
          readonly message: AiSessionSnapshot["messages"][number];
      }
    | {
          readonly id: string;
          readonly kind: "tool";
          readonly reviewEntry: ToolActivityReviewEntry;
      };

export interface ChatTimelineModel {
    readonly historyRows: readonly ChatTimelineRow[];
    readonly historyRowIds: readonly string[];
    readonly liveTailRow: ChatTimelineRow | null;
    readonly liveTailRowId: string | null;
    readonly orderedRowIds: readonly string[];
    readonly orderedRows: readonly ChatTimelineRow[];
    readonly rowById: ReadonlyMap<string, ChatTimelineRow>;
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
        previous.kind === next.kind &&
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
    return `tool:${entry.activity.id}`;
}

function getRowCreatedAt(row: ChatTimelineRow): string {
    return row.kind === "message"
        ? row.message.createdAt
        : row.reviewEntry.activity.createdAt;
}

function compareRows(left: ChatTimelineRow, right: ChatTimelineRow): number {
    const createdAtComparison = getRowCreatedAt(left).localeCompare(
        getRowCreatedAt(right),
    );

    if (createdAtComparison !== 0) {
        return createdAtComparison;
    }

    return left.id.localeCompare(right.id);
}

function createRowById(
    previous: ChatTimelineModel | null,
    messages: readonly AiSessionSnapshot["messages"][number][],
    toolEntries: readonly ToolActivityReviewEntry[],
): Map<string, ChatTimelineRow> {
    const nextRowById = new Map<string, ChatTimelineRow>();

    for (const message of messages) {
        const rowId = getMessageRowId(message);
        const previousRow = previous?.rowById.get(rowId) ?? null;

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
        const previousRow = previous?.rowById.get(rowId) ?? null;

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
    rowById: ReadonlyMap<string, ChatTimelineRow>,
): ChatTimelineRow[] {
    return [...rowById.values()].sort(compareRows);
}

function reuseRowIds(
    previousRowIds: readonly string[] | null | undefined,
    nextRows: readonly ChatTimelineRow[],
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

function reuseRows(
    previousRows: readonly ChatTimelineRow[] | null | undefined,
    nextRows: readonly ChatTimelineRow[],
): readonly ChatTimelineRow[] {
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

export function reconcileChatTimelineModel(
    previous: ChatTimelineModel | null,
    snapshot: Pick<
        AiSessionSnapshot,
        "messages" | "status" | "toolActivity" | "trackedFiles"
    >,
): ChatTimelineModel {
    const toolEntries = deriveToolActivityReviewEntries(
        snapshot.toolActivity,
        snapshot.trackedFiles,
    );
    const nextRowById = createRowById(previous, snapshot.messages, toolEntries);
    const orderedRows = reuseRows(
        previous?.orderedRows,
        buildOrderedRows(nextRowById),
    );
    const orderedRowIds = reuseRowIds(previous?.orderedRowIds, orderedRows);
    const liveTailRow =
        isStreamingStatus(snapshot.status) && orderedRows.length > 0
            ? (orderedRows[orderedRows.length - 1] ?? null)
            : null;
    const liveTailRowId = liveTailRow?.id ?? null;
    const nextHistoryRows =
        liveTailRow == null ? [...orderedRows] : orderedRows.slice(0, -1);
    const historyRows = reuseRows(previous?.historyRows, nextHistoryRows);
    const historyRowIds = reuseRowIds(previous?.historyRowIds, historyRows);

    return {
        historyRowIds,
        historyRows,
        liveTailRow,
        liveTailRowId,
        orderedRowIds,
        orderedRows,
        rowById: nextRowById,
    };
}

export function reconcileChatTimelineModelFromTranscript(
    previous: ChatTimelineModel | null,
    input: {
        readonly status: AiSessionSnapshot["status"];
        readonly trackedFiles: AiSessionSnapshot["trackedFiles"];
        readonly transcript: AiSessionTranscriptModel;
    },
): ChatTimelineModel {
    return reconcileChatTimelineModel(previous, {
        messages: getAiSessionTranscriptMessages(input.transcript),
        status: input.status,
        toolActivity: getAiSessionTranscriptToolActivity(input.transcript),
        trackedFiles: input.trackedFiles,
    });
}
