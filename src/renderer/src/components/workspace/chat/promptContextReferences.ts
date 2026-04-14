import type { AiFileContextAttachment } from "@shared/ipc";

function formatContextRange(
    fileContext: AiFileContextAttachment,
): string | null {
    const startLine = fileContext.startLine ?? null;
    const endLine = fileContext.endLine ?? null;

    if (startLine === null || endLine === null) {
        return null;
    }

    return startLine === endLine
        ? `${startLine}`
        : `${startLine}-${endLine}`;
}

export function buildFileContextReference(
    fileContext: AiFileContextAttachment,
): string {
    const range = formatContextRange(fileContext);
    if (!range) {
        return fileContext.relativePath;
    }

    return `${fileContext.relativePath}:${range}`;
}

export function buildFileContextLabel(
    fileContext: AiFileContextAttachment,
): string {
    const range = formatContextRange(fileContext);
    if (!range) {
        return fileContext.name;
    }

    return `${fileContext.name}:${range}`;
}

export function buildFileContextTitle(
    fileContext: AiFileContextAttachment,
): string {
    const reference = buildFileContextReference(fileContext);
    const selectedText = fileContext.selectedText?.trim();

    if (!selectedText) {
        return reference;
    }

    return `${reference}\n\n${selectedText}`;
}

export function serializePromptWithContexts(
    draft: string,
    fileContexts: readonly AiFileContextAttachment[],
): string {
    const trimmedDraft = draft.trim();
    const textMentions = [...trimmedDraft.matchAll(/(^|\s)@([^\s]+)/g)]
        .map((match) => match[2]?.trim())
        .filter((value): value is string => Boolean(value));
    const contextReferences = fileContexts.map(buildFileContextReference);
    const allReferences = [...new Set([...textMentions, ...contextReferences])];

    if (!trimmedDraft && allReferences.length === 0) {
        return "";
    }

    const body = trimmedDraft || "Review these references";
    if (allReferences.length === 0) {
        return body;
    }

    return `${body}\n\nContext references:\n${allReferences.map((reference) => `- ${reference}`).join("\n")}`;
}
