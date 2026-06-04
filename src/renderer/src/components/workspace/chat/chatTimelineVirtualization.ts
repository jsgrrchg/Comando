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

// Height-affecting layout dimensions that are independent of the row's width.
// Shared by the measurement key and the width-invariant identity key below.
function getChatTimelineRowLayoutBase(
    context: ChatTimelineRowMeasurementContext,
): string {
    return [
        context.chatFontFamily ?? "default",
        context.chatFontSize ?? "default",
        context.gapPx ?? 0,
        context.isLatestStreamingTool ? "latest" : "history",
        context.toolCardExpansionMode,
    ].join(":");
}

// Only message rows reflow their height with the available width; tool cards
// lay out at width-invariant heights (fixed-height summaries, internally
// scrolled diffs). So only messages fold the width bucket into their
// measurement key — tool rows keep a stable key across a resize and never have
// their measurement invalidated, which is what let the scroll settle during a
// drag instead of collapsing the whole cache to rough estimates.
export function isWidthSensitiveChatTimelineRow(row: ChatTimelineRow): boolean {
    return row.kind === "message";
}

export function getChatTimelineRowMeasurementKey(
    row: ChatTimelineRow,
    context: ChatTimelineRowMeasurementContext,
): string {
    const widthSegment = isWidthSensitiveChatTimelineRow(row)
        ? getChatTimelineVirtualMeasurementWidth(context.width)
        : "static";

    return `${row.id}:${getChatTimelineRowLayoutBase(
        context,
    )}:${widthSegment}:${getRowMeasurementToken(row)}`;
}

// Stable across width changes for the same row revision. The virtual list uses
// it to carry a row's last measured height over a resize: when a width-sensitive
// row's measurement key churns (the width bucket changed), the layout falls back
// to this row's last real measurement instead of the heuristic estimate, so the
// total size never snaps to a rough value mid-resize.
export function getChatTimelineRowIdentityKey(
    row: ChatTimelineRow,
    context: ChatTimelineRowMeasurementContext,
): string {
    return `${row.id}:${getChatTimelineRowLayoutBase(
        context,
    )}:${getRowMeasurementToken(row)}`;
}

// The measurement key must change exactly when a row could render at a new
// height. The timeline model reconciles rows immutably: createRowById reuses
// the same ChatTimelineRow reference while the row is equivalent and allocates
// a fresh one as soon as any compared field changes. An unchanged reference is
// never re-rendered, so its height cannot change either — which makes row
// IDENTITY a sufficient and exact trigger.
//
// Keying off identity (rather than a content hash) avoids a hidden coupling:
// a hash would have to mirror exactly which fields the model's equivalence
// checks compare, and could go stale if the model reused a reference whose
// content the hash inspected but the equivalence ignored. It also skips
// hashing every row's text on each rebuild.
//
// Each distinct reference gets a stable token; a fresh reference (the model
// decided the row changed) gets a new one, invalidating the cached
// measurement. The WeakMap keeps it bounded — dropped rows are collected.
let nextRowMeasurementToken = 0;
const rowMeasurementTokens = new WeakMap<ChatTimelineRow, number>();

function getRowMeasurementToken(row: ChatTimelineRow): number {
    const existing = rowMeasurementTokens.get(row);
    if (existing !== undefined) {
        return existing;
    }

    const token = nextRowMeasurementToken;
    nextRowMeasurementToken += 1;
    rowMeasurementTokens.set(row, token);
    return token;
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

// Estimates a row's pixel height BEFORE it is rendered, so the virtual list can
// size its scrollbar and place off-screen rows. These are deliberately rough
// guesses: once a row scrolls into view its real height is measured and the
// layout self-corrects, so a wrong estimate only causes a brief scroll wobble,
// never incorrect output.
//
// The magic numbers below (base heights, per-detail increments, expansion
// caps) are hand-tuned to approximate the real layout of `ChatMessageRow` and
// `ToolActivityItem`/`ChangeReviewPanel`. They are NOT derived from those
// components, so they can silently drift: if you change a tool card's or
// message row's heights/padding/expanded layout, revisit the matching branch
// here. The symptom of staleness is subtle — scroll jitter while flinging
// through a long history — so it is worth updating in the same change.
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
