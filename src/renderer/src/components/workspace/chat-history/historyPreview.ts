import type { AiHistorySessionSummary } from "@shared/ipc";

export function getHistoryPreviewText(
    session: Pick<AiHistorySessionSummary, "preview" | "title">,
): string {
    const preview = normalizeHistoryPreview(session.preview);
    if (preview.length > 0) {
        return preview;
    }

    const fallbackTitle = session.title.trim();
    if (fallbackTitle.length > 0) {
        return `Transcript for ${fallbackTitle}`;
    }

    return "No transcript preview available.";
}

function normalizeHistoryPreview(value: string | null): string {
    return (value ?? "").replace(/\s+/g, " ").trim();
}
