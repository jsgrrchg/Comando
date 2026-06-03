import type { AiToolCardExpansionMode } from "@shared/ipc";

import type { ChatTimelineRow } from "./chatTimelineModel";

export const CHAT_TIMELINE_VIRTUALIZATION_ENABLED = true;
export const CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD = 200;
export const CHAT_TIMELINE_VIRTUALIZATION_OVERSCAN = 10;
export const CHAT_TIMELINE_VIRTUAL_DEFAULT_VIEWPORT_HEIGHT = 720;
export const CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX = 8;
export const CHAT_TIMELINE_VIRTUAL_WIDTH_BUCKET_PX = 24;

interface ShouldVirtualizeChatTimelineOptions {
    readonly enabled?: boolean;
    readonly threshold?: number;
}

export interface ChatTimelineRowEstimateContext {
    readonly chatFontSize?: number;
    readonly gapPx?: number;
    readonly isLatestStreamingTool?: boolean;
    readonly toolCardExpansionMode: AiToolCardExpansionMode;
    readonly width?: number;
}

export interface ChatTimelineRowMeasurementContext
    extends ChatTimelineRowEstimateContext {
    readonly chatFontFamily?: string;
    readonly width: number;
}

export interface ChatTimelineVirtualScrollMarginOptions {
    readonly historyElement: HTMLElement | null;
    readonly scrollContainer: HTMLElement | null;
}

export function shouldVirtualizeChatTimeline(
    rowCount: number,
    options: ShouldVirtualizeChatTimelineOptions = {},
): boolean {
    const enabled = options.enabled ?? CHAT_TIMELINE_VIRTUALIZATION_ENABLED;
    const threshold =
        options.threshold ?? CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD;

    return enabled && rowCount >= threshold;
}

export function getChatTimelineRowKey(row: ChatTimelineRow): string {
    return row.id;
}

export function getChatTimelineRowMeasurementKey(
    row: ChatTimelineRow,
    context: ChatTimelineRowMeasurementContext,
): string {
    const measurementWidth = getChatTimelineVirtualMeasurementWidth(
        context.width,
    );
    const layoutSignature = [
        context.chatFontFamily ?? "default",
        context.chatFontSize ?? "default",
        context.gapPx ?? 0,
        context.isLatestStreamingTool ? "latest" : "history",
        context.toolCardExpansionMode,
        measurementWidth,
    ].join(":");

    return `${row.id}:${layoutSignature}:${getCachedRowContentMeasurementSignature(
        row,
    )}`;
}

// The content signature hashes the full text of every row, so recomputing it
// on each measurement key rebuild dominates resize/font changes (where only
// the layout signature actually changes). Cache it by row identity: the
// timeline model reconciles rows immutably (createRowById reuses the same
// reference when content is unchanged and allocates a fresh object when it
// changes), so "same reference" means "byte-identical content" — the cached
// signature is always valid for that reference. A WeakMap keeps it bounded:
// rows dropped from the timeline are collected automatically.
const rowContentSignatureCache = new WeakMap<ChatTimelineRow, string>();

function getCachedRowContentMeasurementSignature(row: ChatTimelineRow): string {
    const cached = rowContentSignatureCache.get(row);
    if (cached !== undefined) {
        return cached;
    }

    const signature = getRowContentMeasurementSignature(row);
    rowContentSignatureCache.set(row, signature);
    return signature;
}

export function getChatTimelineVirtualMeasurementWidth(width: number): number {
    if (!Number.isFinite(width) || width <= 0) {
        return 0;
    }

    return (
        Math.round(width / CHAT_TIMELINE_VIRTUAL_WIDTH_BUCKET_PX) *
        CHAT_TIMELINE_VIRTUAL_WIDTH_BUCKET_PX
    );
}

export function calculateChatTimelineVirtualScrollMarginTop({
    historyElement,
    scrollContainer,
}: ChatTimelineVirtualScrollMarginOptions): number {
    if (!historyElement || !scrollContainer) {
        return 0;
    }

    const historyRect = historyElement.getBoundingClientRect();
    const scrollRect = scrollContainer.getBoundingClientRect();
    const marginTop =
        historyRect.top - scrollRect.top + scrollContainer.scrollTop;

    return Math.max(0, marginTop);
}

export function getChatTimelineVirtualRowGapPx({
    index,
    rowCount,
}: {
    readonly index: number;
    readonly rowCount: number;
}): number {
    if (index < rowCount - 1) {
        return CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX;
    }

    return 0;
}

export function estimateChatTimelineRowHeight(
    row: ChatTimelineRow,
    context: ChatTimelineRowEstimateContext,
): number {
    const gapPx = Math.max(0, context.gapPx ?? 0);

    if (row.kind === "message") {
        return Math.ceil(
            estimateMessageRowHeight(row.message, context) + gapPx,
        );
    }

    return Math.ceil(estimateToolRowHeight(row, context) + gapPx);
}

function estimateMessageRowHeight(
    message: Extract<ChatTimelineRow, { readonly kind: "message" }>["message"],
    context: ChatTimelineRowEstimateContext,
): number {
    const chatFontSize = context.chatFontSize;
    const fontScale = getFontScale(chatFontSize);
    const content = message.content ?? "";
    const estimatedLines = estimateTextLines(
        content,
        estimateCharactersPerLine(context.width, chatFontSize),
    );
    const contentHeight = Math.min(340, estimatedLines * 18 * fontScale);
    const codeBlockCount = countCodeBlocks(content);
    const attachmentHeight = message.attachments.length * 48;
    const imageHeight = message.generatedImage ? 190 : 0;
    const baseHeight =
        message.kind === "user"
            ? 54
            : message.kind === "thinking"
              ? 64
              : 72;

    return (
        baseHeight +
        contentHeight +
        Math.min(260, codeBlockCount * 92) +
        attachmentHeight +
        imageHeight
    );
}

function estimateCharactersPerLine(
    width: number | undefined,
    chatFontSize: number | undefined,
): number {
    if (!width || !Number.isFinite(width) || width <= 0) {
        return 96;
    }

    const safeFontSize =
        chatFontSize && Number.isFinite(chatFontSize) ? chatFontSize : 13;
    const contentWidth = Math.max(160, width - 72);
    const averageCharacterWidth = Math.max(6, safeFontSize * 0.56);

    return Math.max(
        24,
        Math.min(140, Math.floor(contentWidth / averageCharacterWidth)),
    );
}

function estimateToolRowHeight(
    row: Extract<ChatTimelineRow, { readonly kind: "tool" }>,
    context: ChatTimelineRowEstimateContext,
): number {
    const activity = row.reviewEntry.activity;
    const trackedFiles = row.reviewEntry.trackedFiles;
    const hasInlineReview = trackedFiles.length > 0 || activity.diffs.length > 0;
    const hasLocations = activity.locations.length > 0;
    const hasTerminalOutput = !!activity.terminalOutput;
    const hasSummary = !!activity.summary;
    const hasRawJson = !!activity.rawInputJson || !!activity.rawOutputJson;
    const isExpandedByMode =
        context.toolCardExpansionMode === "expanded" ||
        (context.toolCardExpansionMode === "latest" &&
            context.isLatestStreamingTool === true);

    if (isTurnStartedActivityId(activity.id)) {
        return 48;
    }

    if (isTerminalToolKind(activity.kind)) {
        const startsExpanded =
            hasTerminalOutput &&
            (activity.status === "failed" ||
                (activity.exitCode !== null && activity.exitCode !== 0));
        return startsExpanded ? 210 : 58;
    }

    if (hasInlineReview) {
        const detailHeight = Math.min(
            360,
            activity.diffs.length * 82 + trackedFiles.length * 58,
        );
        return isExpandedByMode ? 132 + detailHeight : 96;
    }

    if (isFileToolLike(row)) {
        const hasDetail = hasSummary || hasLocations || activity.diffs.length > 0;
        const detailHeight =
            (hasSummary ? 76 : 0) +
            (hasLocations ? Math.min(96, activity.locations.length * 28) : 0) +
            Math.min(240, activity.diffs.length * 72);

        return hasDetail && isExpandedByMode ? 64 + detailHeight : 58;
    }

    if (activity.status === "failed") {
        return 72 + (hasSummary ? 72 : 0) + (hasRawJson ? 130 : 0);
    }

    return hasSummary || hasRawJson ? 90 : 42;
}

function getFontScale(chatFontSize: number | undefined): number {
    if (!chatFontSize || !Number.isFinite(chatFontSize)) {
        return 1;
    }

    return Math.min(1.8, Math.max(0.85, chatFontSize / 13));
}

function estimateTextLines(content: string, charactersPerLine: number): number {
    if (!content.trim()) {
        return 1;
    }

    const explicitLines = content.split("\n");
    return explicitLines.reduce((total, line) => {
        return total + Math.max(1, Math.ceil(line.length / charactersPerLine));
    }, 0);
}

function countCodeBlocks(content: string): number {
    return Math.floor((content.match(/```/g)?.length ?? 0) / 2);
}

function isTurnStartedActivityId(activityId: string): boolean {
    return (
        activityId.startsWith("codex-acp:status:turn:") ||
        activityId.startsWith("comando:status:turn:")
    );
}

function isTerminalToolKind(kind: string): boolean {
    const normalizedKind = kind.toLowerCase();
    return (
        normalizedKind === "bash" ||
        normalizedKind === "shell" ||
        normalizedKind === "execute"
    );
}

function isFileToolLike(
    row: Extract<ChatTimelineRow, { readonly kind: "tool" }>,
) {
    const activity = row.reviewEntry.activity;
    const normalizedKind = activity.kind.toLowerCase();

    return (
        row.reviewEntry.trackedFiles.length > 0 ||
        activity.locations.length > 0 ||
        activity.diffs.length > 0 ||
        normalizedKind === "create" ||
        normalizedKind === "delete" ||
        normalizedKind === "edit" ||
        normalizedKind === "move" ||
        normalizedKind === "read" ||
        normalizedKind === "remove" ||
        normalizedKind === "rename" ||
        normalizedKind === "search" ||
        normalizedKind === "update" ||
        normalizedKind === "write"
    );
}

function getRowContentMeasurementSignature(row: ChatTimelineRow): string {
    if (row.kind === "message") {
        const message = row.message;

        return [
            "message",
            message.status,
            message.kind,
            hashString(message.content),
            message.attachments
                .map(
                    (attachment) =>
                        `${attachment.id}:${attachment.mimeType}:${attachment.sizeBytes ?? "unknown"}`,
                )
                .join(","),
            message.generatedImage
                ? [
                      message.generatedImage.status,
                      message.generatedImage.path ?? "",
                      hashString(message.generatedImage.result ?? ""),
                      hashString(message.generatedImage.revisedPrompt ?? ""),
                      hashString(message.generatedImage.title ?? ""),
                  ].join("/")
                : "none",
        ].join(":");
    }

    const activity = row.reviewEntry.activity;
    return [
        "tool",
        activity.status,
        activity.updatedAt,
        activity.kind,
        activity.exitCode ?? "none",
        hashString(activity.title),
        hashString(activity.summary ?? ""),
        hashString(activity.terminalOutput ?? ""),
        hashString(activity.rawInputJson ?? ""),
        hashString(activity.rawOutputJson ?? ""),
        activity.locations
            .map(
                (location) =>
                    `${location.path}:${location.line ?? ""}:${location.endLine ?? ""}`,
            )
            .join(","),
        activity.diffs
            .map(
                (diff) =>
                    `${diff.kind}:${diff.path}:${diff.previousPath ?? ""}:${hashString(
                        diff.oldText ?? "",
                    )}:${hashString(diff.newText ?? "")}:${diff.hunks.length}`,
            )
            .join(","),
        row.reviewEntry.trackedFiles
            .map(
                (trackedFile) =>
                    `${trackedFile.identityKey}:${trackedFile.updatedAt}:${trackedFile.reviewState}`,
            )
            .join(","),
    ].join(":");
}

function hashString(value: string): string {
    let hash = 0;

    for (let index = 0; index < value.length; index += 1) {
        hash = (hash * 31 + value.charCodeAt(index)) | 0;
    }

    return `${value.length}:${Math.abs(hash)}`;
}
