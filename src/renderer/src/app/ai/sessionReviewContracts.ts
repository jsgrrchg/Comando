import type {
    AiFileContextAttachment,
    AiImageAttachment,
} from "@shared/ipc";

export const DEFAULT_AI_DIFF_ZOOM = 0.72;

// Fase 0 / Ruta B: el undo de reject queda fuera del alcance inicial.
export const AI_REVIEW_UNDO_ENABLED = false;

export type AiQueuedPromptStatus = "failed" | "queued" | "sending";

export type AiComposerDraftPart =
    | { readonly type: "text"; readonly text: string }
    | {
          readonly type: "file_mention";
          readonly label: string;
          readonly path: string;
          readonly relativePath: string;
          readonly languageId: string;
      }
    | {
          readonly type: "folder_mention";
          readonly folderPath: string;
          readonly label: string;
      }
    | { readonly type: "fetch_mention" }
    | { readonly type: "plan_mention" }
    | {
          readonly type: "file_attachment";
          readonly filePath: string;
          readonly mimeType: string;
          readonly label: string;
      };

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
