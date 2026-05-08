import type { AiComposerMessagePart, AiFileContextAttachment } from "@shared/ipc";

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
    composerParts: readonly AiComposerMessagePart[] = [],
): string {
    const trimmedDraft = draft.trim();
    const textMentions = [...trimmedDraft.matchAll(/(^|\s)@([^\s]+)/g)]
        .map((match) => match[2]?.trim())
        .filter((value): value is string => Boolean(value));
    const contextReferences = fileContexts.map(buildFileContextReference);
    const allReferences = [...new Set([...textMentions, ...contextReferences])];
    const githubReferences = buildGitHubComposerReferences(composerParts);

    if (
        !trimmedDraft &&
        allReferences.length === 0 &&
        githubReferences.length === 0
    ) {
        return "";
    }

    const body = trimmedDraft || "Review these references";
    const sections: string[] = [];
    if (allReferences.length > 0) {
        sections.push(
            `Context references:\n${allReferences.map((reference) => `- ${reference}`).join("\n")}`,
        );
    }
    if (githubReferences.length > 0) {
        sections.push(
            `GitHub references:\n${githubReferences.map((reference) => `- ${reference}`).join("\n")}`,
        );
    }

    if (sections.length === 0) {
        return body;
    }

    return `${body}\n\n${sections.join("\n\n")}`;
}

export function buildGitHubComposerReferences(
    composerParts: readonly AiComposerMessagePart[],
): string[] {
    const references: string[] = [];
    const seenKeys = new Set<string>();

    for (const part of composerParts) {
        const reference = buildGitHubComposerReference(part);
        if (!reference) {
            continue;
        }

        const key = getGitHubComposerReferenceKey(part);
        if (seenKeys.has(key)) {
            continue;
        }

        seenKeys.add(key);
        references.push(reference);
    }

    return references;
}

export function buildGitHubComposerReference(
    part: AiComposerMessagePart,
): string | null {
    switch (part.type) {
        case "github_issue_mention":
            return `Issue ${part.owner}/${part.repo}#${part.number}: ${part.title} (${part.url})`;
        case "github_pull_request_mention":
            return `Pull request ${part.owner}/${part.repo}#${part.number}: ${part.title} (${part.url})`;
        default:
            return null;
    }
}

function getGitHubComposerReferenceKey(part: AiComposerMessagePart): string {
    switch (part.type) {
        case "github_issue_mention":
            return `${part.type}:${part.host}/${part.owner}/${part.repo}/${part.number}`;
        case "github_pull_request_mention":
            return `${part.type}:${part.host}/${part.owner}/${part.repo}/${part.number}`;
        default:
            return `${part.type}:${JSON.stringify(part)}`;
    }
}
