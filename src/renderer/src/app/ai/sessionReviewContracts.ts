import type {
    AiComposerMessagePart,
    AiFileContextAttachment,
    AiImageAttachment,
} from "@shared/ipc";

export const DEFAULT_AI_DIFF_ZOOM = 0.72;
export const DEFAULT_PENDING_REVIEW_CARD_TEXT_ZOOM = 1;
export const PENDING_REVIEW_CARD_TEXT_ZOOM_MIN = 0.85;
export const PENDING_REVIEW_CARD_TEXT_ZOOM_MAX = 1.25;
export const PENDING_REVIEW_CARD_TEXT_ZOOM_STEP = 0.05;

// Fase 0 / Ruta B: el undo de reject queda fuera del alcance inicial.
export const AI_REVIEW_UNDO_ENABLED = false;

export type AiQueuedPromptStatus = "failed" | "queued" | "sending";

export type AiComposerDraftPart = AiComposerMessagePart;

export interface QueuedPrompt {
    readonly attachments: readonly AiImageAttachment[];
    readonly composerPartsSnapshot: readonly AiComposerDraftPart[];
    readonly createdAt: string;
    readonly fileContextsSnapshot: readonly AiFileContextAttachment[];
    readonly id: string;
    readonly prompt: string;
    readonly status: AiQueuedPromptStatus;
}

export function cloneComposerDraftParts(
    parts: readonly AiComposerDraftPart[],
): AiComposerDraftPart[] {
    return parts.map((part) => ({ ...part }));
}

export function createEmptyComposerDraftParts(): AiComposerDraftPart[] {
    return [{ type: "text", text: "" }];
}

export function buildSelectionMentionLabel(
    selectedText: string,
    startLine: number,
    endLine: number,
): string {
    const preview = selectedText.replace(/\s+/g, " ").trim();
    const truncated =
        preview.length > 20 ? `${preview.slice(0, 20).trimEnd()}...` : preview;
    const range =
        startLine === endLine ? `(${startLine})` : `(${startLine}:${endLine})`;
    return truncated ? `${range} - ${truncated}` : range;
}

function ensureTrailingSpace(
    parts: readonly AiComposerDraftPart[],
): AiComposerDraftPart[] {
    const next = cloneComposerDraftParts(parts);
    const last = next[next.length - 1];

    if (!last) {
        return createEmptyComposerDraftParts();
    }

    if (
        last.type === "text" &&
        (last.text.length === 0 || last.text.endsWith(" "))
    ) {
        return next;
    }

    return [...next, { type: "text", text: " " }];
}

export function appendSelectionMentionDraftPart(
    parts: readonly AiComposerDraftPart[],
    selection: {
        readonly path: string;
        readonly selectedText: string;
        readonly startLine: number;
        readonly endLine: number;
    },
): AiComposerDraftPart[] {
    const next = ensureTrailingSpace(parts);

    next.push({
        type: "selection_mention",
        endLine: selection.endLine,
        label: buildSelectionMentionLabel(
            selection.selectedText,
            selection.startLine,
            selection.endLine,
        ),
        path: selection.path,
        selectedText: selection.selectedText,
        startLine: selection.startLine,
    });
    next.push({ type: "text", text: " " });

    return cloneComposerDraftParts(next);
}

export function cloneDraftAttachments(
    attachments: readonly AiImageAttachment[],
): AiImageAttachment[] {
    return attachments.map((attachment) => ({ ...attachment }));
}

export function cloneDraftFileContexts(
    fileContexts: readonly AiFileContextAttachment[],
): AiFileContextAttachment[] {
    return fileContexts.map((fileContext) => ({ ...fileContext }));
}

export function normalizeAiDiffZoom(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_AI_DIFF_ZOOM;
    }

    return Math.round(value * 100) / 100;
}

export function normalizePendingReviewCardTextZoom(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_PENDING_REVIEW_CARD_TEXT_ZOOM;
    }

    return (
        Math.round(
            Math.min(
                PENDING_REVIEW_CARD_TEXT_ZOOM_MAX,
                Math.max(PENDING_REVIEW_CARD_TEXT_ZOOM_MIN, value),
            ) * 100,
        ) / 100
    );
}

export function stepPendingReviewCardTextZoom(
    value: number,
    delta: number,
): number {
    return normalizePendingReviewCardTextZoom(value + delta);
}
