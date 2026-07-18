import type { AiToolActivityDefaultExpansion } from "@shared/ipc";

import { CHAT_CONTENT_MAX_WIDTH_PX } from "./chatContentLayout";
import type { ChatTimelineRow } from "./chatTimelineModel";
import {
    isFileToolActivity,
    isStatusToolActivity,
    isTerminalToolActivity,
    isTurnStartedActivity,
} from "./toolActivityKinds";

export const CHAT_TIMELINE_VIRTUALIZATION_ENABLED = true;
export const CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD = 200;
export const CHAT_TIMELINE_VIRTUALIZATION_OVERSCAN = 10;
export const CHAT_TIMELINE_VIRTUAL_DEFAULT_VIEWPORT_HEIGHT = 720;
export const CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX = 8;
export const CHAT_TIMELINE_VIRTUAL_WIDTH_BUCKET_PX = 24;
export const CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX = CHAT_CONTENT_MAX_WIDTH_PX;
export const CHAT_ACTIVITY_RAIL_HEADER_HEIGHT_PX = 40;
export const CHAT_ACTIVITY_RAIL_CONTENT_TOP_PX = 4;
export const CHAT_ACTIVITY_RAIL_ENTRY_GAP_PX = 6;
export const CHAT_ACTIVITY_RAIL_ENTRY_PADDING_Y_PX = 4;
export const CHAT_ACTIVITY_RAIL_DENSE_ROW_HEIGHT_PX = 28;

interface ShouldVirtualizeChatTimelineOptions {
    readonly enabled?: boolean;
    readonly threshold?: number;
}

export interface ChatTimelineRowEstimateContext {
    readonly chatFontSize?: number;
    readonly gapPx?: number;
    readonly toolActivityDefaultExpansion?: AiToolActivityDefaultExpansion;
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
    virtualizationCost: number,
    options: ShouldVirtualizeChatTimelineOptions = {},
): boolean {
    const enabled = options.enabled ?? CHAT_TIMELINE_VIRTUALIZATION_ENABLED;
    const threshold =
        options.threshold ?? CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD;

    return enabled && virtualizationCost >= threshold;
}

export function calculateChatTimelineVirtualizationCost(
    rows: readonly ChatTimelineRow[],
): number {
    const cached = virtualizationCostByRows.get(rows);
    if (cached !== undefined) return cached;
    const cost = rows.reduce((cost, row) => {
        if (row.kind !== "activity-segment") {
            return cost + 1;
        }

        const expandedItemWeight = row.items.reduce(
            (itemCost, item) => {
                if (item.kind === "thinking") {
                    return itemCost + 1;
                }

                const activity = item.entry.reviewEntry.activity;
                const previewWeight =
                    activity.diffs.length > 0 || activity.terminalOutput
                        ? 2
                        : 1;
                return itemCost + previewWeight;
            },
            0,
        );
        return cost + 1 + expandedItemWeight;
    }, 0);
    virtualizationCostByRows.set(rows, cost);
    return cost;
}

const virtualizationCostByRows = new WeakMap<
    readonly ChatTimelineRow[],
    number
>();

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
        context.toolActivityDefaultExpansion ?? "collapsed",
    ].join(":");
}

// Message rows and activity rails containing expandable thinking can reflow
// with the available width. Tool-only rails remain width-invariant.
export function isWidthSensitiveChatTimelineRow(row: ChatTimelineRow): boolean {
    return (
        row.kind === "message" ||
        (row.kind === "activity-segment" &&
            row.items.some((item) => item.kind === "thinking"))
    );
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

export function getChatTimelineEffectiveContentWidth(width: number): number {
    if (!Number.isFinite(width) || width <= 0) {
        return 0;
    }

    return Math.min(width, CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX);
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

    if (row.kind === "activity-segment") {
        if (context.toolActivityDefaultExpansion !== "expanded") {
            return Math.ceil(CHAT_ACTIVITY_RAIL_HEADER_HEIGHT_PX + gapPx);
        }

        const activityHeight = row.items.reduce(
            (height, item, index) =>
                height +
                (item.kind === "thinking"
                    ? Math.ceil(28 * getFontScale(context.chatFontSize))
                    : CHAT_ACTIVITY_RAIL_DENSE_ROW_HEIGHT_PX) +
                CHAT_ACTIVITY_RAIL_ENTRY_PADDING_Y_PX +
                (index > 0 ? CHAT_ACTIVITY_RAIL_ENTRY_GAP_PX : 0),
            0,
        );
        return Math.ceil(
            CHAT_ACTIVITY_RAIL_HEADER_HEIGHT_PX +
                CHAT_ACTIVITY_RAIL_CONTENT_TOP_PX +
                activityHeight +
                gapPx,
        );
    }

    return Math.ceil(
        estimateToolActivityHeight(row.reviewEntry, context) + gapPx,
    );
}

function estimateMessageRowHeight(
    message: Extract<ChatTimelineRow, { readonly kind: "message" }>["message"],
    context: ChatTimelineRowEstimateContext,
): number {
    const chatFontSize = context.chatFontSize;
    const fontScale = getFontScale(chatFontSize);

    if (message.kind === "thinking") {
        return 28 * fontScale;
    }

    const content = message.content ?? "";
    const availableCharacters = estimateCharactersPerLine(
        context.width,
        chatFontSize,
    );
    const estimatedLines = estimateTextLines(
        content,
        message.kind === "user" && (context.width ?? 0) > 420
            ? Math.max(24, Math.floor(availableCharacters * 0.7))
            : availableCharacters,
    );
    const contentHeight = Math.min(340, estimatedLines * 18 * fontScale);
    const codeBlockCount = countCodeBlocks(content);
    const attachmentHeight = message.attachments.length * 48;
    const imageHeight = message.generatedImage ? 190 : 0;
    const baseHeight = message.kind === "user" ? 74 : 72;

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

function estimateToolActivityHeight(
    reviewEntry: Extract<
        ChatTimelineRow,
        { readonly kind: "tool" }
    >["reviewEntry"],
    _context: ChatTimelineRowEstimateContext,
    compactTerminal = false,
): number {
    const activity = reviewEntry.activity;
    const trackedFiles = reviewEntry.trackedFiles;
    const hasTerminalOutput = !!activity.terminalOutput;
    const hasSummary = !!activity.summary;
    const hasRawJson = !!activity.rawInputJson || !!activity.rawOutputJson;

    if (isTurnStartedActivity(activity)) {
        return 48;
    }

    if (isStatusToolActivity(activity)) {
        return 28;
    }

    if (isTerminalToolActivity(activity)) {
        if (compactTerminal) {
            return CHAT_ACTIVITY_RAIL_DENSE_ROW_HEIGHT_PX;
        }
        const startsExpanded =
            hasTerminalOutput &&
            (activity.status === "failed" ||
                (activity.exitCode !== null && activity.exitCode !== 0));
        return startsExpanded
            ? 210
            : CHAT_ACTIVITY_RAIL_DENSE_ROW_HEIGHT_PX;
    }

    if (isFileToolActivity(activity, trackedFiles)) {
        return 42;
    }

    if (activity.status === "failed") {
        return 72 + (hasSummary ? 72 : 0) + (hasRawJson ? 130 : 0);
    }

    return hasSummary || hasRawJson ? 36 : 28;
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
