import {
    appendSelectionMentionDraftPart,
    createEmptyComposerDraftParts,
    type AiComposerDraftPart,
} from "@renderer/app/ai/sessionReviewContracts";
import type { WorkspaceTabComposerDragItem } from "@renderer/app/drag-and-drop";
import { resolveEditorLanguage } from "@shared/editor-language";

/* ─── Part types ─── */

export type AIComposerPart = AiComposerDraftPart;

/* ─── Normalization ─── */

export function normalizeComposerParts(
    parts: readonly AIComposerPart[],
): AIComposerPart[] {
    const result: AIComposerPart[] = [];

    for (const part of parts) {
        if (part.type === "text") {
            const last = result[result.length - 1];
            if (last?.type === "text") {
                result[result.length - 1] = {
                    type: "text",
                    text: last.text + part.text,
                };
                continue;
            }
        }
        result.push(part);
    }

    return result;
}

export function createEmptyComposerParts(): AIComposerPart[] {
    return createEmptyComposerDraftParts();
}

/* ─── Plain text extraction ─── */

export function composerPartsToPlainText(
    parts: readonly AIComposerPart[],
): string {
    return parts
        .map((p) => {
            switch (p.type) {
                case "text":
                    return p.text;
                case "file_mention":
                    return `@${p.relativePath}`;
                case "folder_mention":
                    return `@${p.folderPath}`;
                case "fetch_mention":
                    return "@fetch";
                case "plan_mention":
                    return "/plan";
                case "selection_mention":
                    return `[${p.label}]`;
                case "file_attachment":
                    return `[${p.label}]`;
                case "git_commit_mention":
                    return `commit: ${p.label}`;
                case "github_issue_mention":
                    return p.label;
                case "github_pull_request_mention":
                    return p.label;
            }
        })
        .join("");
}

export function serializeComposerPartsForPrompt(
    parts: readonly AIComposerPart[],
): string {
    return parts
        .map((part) => {
            switch (part.type) {
                case "text":
                    return part.text;
                case "file_mention":
                    return `@${part.relativePath}`;
                case "folder_mention":
                    return `@${part.folderPath}`;
                case "fetch_mention":
                    return "@fetch";
                case "plan_mention":
                    return "/plan";
                case "selection_mention":
                    return part.startLine === part.endLine
                        ? `${part.path}:${part.startLine}`
                        : `${part.path}:${part.startLine}-${part.endLine}`;
                case "file_attachment":
                    return part.filePath;
                case "git_commit_mention":
                    return `commit: ${part.commitSha}`;
                case "github_issue_mention":
                    return `GitHub issue ${part.owner}/${part.repo}#${part.number}: ${part.title} (${part.url})`;
                case "github_pull_request_mention":
                    return `GitHub PR ${part.owner}/${part.repo}#${part.number}: ${part.title} (${part.url})`;
            }
        })
        .join("");
}

/* ─── Append helpers ─── */

function ensureTrailingSpace(
    parts: readonly AIComposerPart[],
): AIComposerPart[] {
    const result = [...parts];
    const last = result[result.length - 1];
    if (!last) {
        return result;
    }

    if (
        last.type === "text" &&
        (last.text.length === 0 || last.text.endsWith(" "))
    ) {
        return result;
    }

    if (last.type !== "text" || !last.text.endsWith(" ")) {
        result.push({ type: "text", text: " " });
    }
    return result;
}

export function appendFileMentionPart(
    parts: readonly AIComposerPart[],
    file: {
        label: string;
        path: string;
        relativePath: string;
        languageId: string;
    },
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push({
        type: "file_mention",
        label: file.label,
        path: file.path,
        relativePath: file.relativePath,
        languageId: file.languageId,
    });
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

export function appendFolderMentionPart(
    parts: readonly AIComposerPart[],
    folderPath: string,
    label: string,
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push({
        type: "folder_mention",
        folderPath,
        label,
    });
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

export function appendFileAttachmentPart(
    parts: readonly AIComposerPart[],
    file: {
        readonly filePath: string;
        readonly mimeType: string;
        readonly label: string;
    },
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push({
        type: "file_attachment",
        filePath: file.filePath,
        label: file.label,
        mimeType: file.mimeType,
    });
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

export function appendGitCommitMentionPart(
    parts: readonly AIComposerPart[],
    commit: {
        readonly commitSha: string;
        readonly label: string;
    },
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push({
        type: "git_commit_mention",
        commitSha: commit.commitSha,
        label: commit.label,
    });
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

export function appendGitHubIssueMentionPart(
    parts: readonly AIComposerPart[],
    issue: Extract<AIComposerPart, { type: "github_issue_mention" }>,
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push(issue);
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

export function appendGitHubPullRequestMentionPart(
    parts: readonly AIComposerPart[],
    pullRequest: Extract<
        AIComposerPart,
        { type: "github_pull_request_mention" }
    >,
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push(pullRequest);
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

export function appendSelectionMentionPart(
    parts: readonly AIComposerPart[],
    selection: {
        readonly path: string;
        readonly selectedText: string;
        readonly startLine: number;
        readonly endLine: number;
    },
): AIComposerPart[] {
    return normalizeComposerParts(
        appendSelectionMentionDraftPart(parts, selection),
    );
}

export function appendWorkspaceTabComposerItem(
    parts: readonly AIComposerPart[],
    item: WorkspaceTabComposerDragItem | null,
): AIComposerPart[] {
    if (!item) {
        return [...parts];
    }

    if (item.kind === "git_commit_mention") {
        return appendGitCommitMentionPart(parts, {
            commitSha: item.commitSha,
            label: item.label,
        });
    }

    if (item.kind === "github_issue_mention") {
        return appendGitHubIssueMentionPart(parts, {
            type: "github_issue_mention",
            host: item.host,
            label: item.label,
            number: item.number,
            owner: item.owner,
            repo: item.repo,
            title: item.title,
            url: item.url,
        });
    }

    if (item.kind === "github_pull_request_mention") {
        return appendGitHubPullRequestMentionPart(parts, {
            type: "github_pull_request_mention",
            host: item.host,
            label: item.label,
            number: item.number,
            owner: item.owner,
            repo: item.repo,
            title: item.title,
            url: item.url,
        });
    }

    return appendFileMentionPart(parts, {
        label: item.label,
        path: item.relativePath,
        relativePath: item.relativePath,
        languageId: resolveEditorLanguage({ filePath: item.relativePath }).id,
    });
}

export function appendWorkspaceTabComposerItems(
    parts: readonly AIComposerPart[],
    items: readonly WorkspaceTabComposerDragItem[],
): AIComposerPart[] {
    return items.reduce<AIComposerPart[]>(
        (nextParts, item) => appendWorkspaceTabComposerItem(nextParts, item),
        [...parts],
    );
}

export function appendComposerParts(
    parts: readonly AIComposerPart[],
    partsToAppend: readonly AIComposerPart[],
): AIComposerPart[] {
    const baseParts = normalizeComposerParts(parts);
    const incomingParts = trimLeadingEmptyTextParts(partsToAppend);

    if (incomingParts.length === 0) {
        return baseParts;
    }

    const separator = shouldInsertPartSeparator(baseParts, incomingParts)
        ? [{ type: "text" as const, text: " " }]
        : [];

    return normalizeComposerParts([
        ...baseParts,
        ...separator,
        ...incomingParts,
    ]);
}

export function collectExternalComposerRoots(
    parts: readonly AIComposerPart[],
): string[] {
    const roots = new Set<string>();

    for (const part of parts) {
        if (part.type === "file_attachment") {
            if (isAbsolutePath(part.filePath)) {
                roots.add(getParentPath(part.filePath));
            }
            continue;
        }

        if (part.type === "folder_mention" && isAbsolutePath(part.folderPath)) {
            roots.add(trimTrailingSeparators(part.folderPath));
            continue;
        }

        if (part.type === "file_mention" && isAbsolutePath(part.path)) {
            roots.add(getParentPath(part.path));
        }
    }

    return Array.from(roots);
}

function isAbsolutePath(candidatePath: string): boolean {
    return (
        candidatePath.startsWith("/") ||
        candidatePath.startsWith("\\\\") ||
        /^[A-Za-z]:[\\/]/.test(candidatePath)
    );
}

function trimLeadingEmptyTextParts(
    parts: readonly AIComposerPart[],
): readonly AIComposerPart[] {
    let firstContentIndex = 0;
    while (firstContentIndex < parts.length) {
        const part = parts[firstContentIndex];
        if (part?.type !== "text" || part.text.length > 0) {
            break;
        }

        firstContentIndex += 1;
    }

    return parts.slice(firstContentIndex);
}

function shouldInsertPartSeparator(
    baseParts: readonly AIComposerPart[],
    incomingParts: readonly AIComposerPart[],
): boolean {
    if (baseParts.length === 0 || incomingParts.length === 0) {
        return false;
    }

    return (
        !partsEndWithWhitespace(baseParts) &&
        !partsStartWithWhitespace(incomingParts)
    );
}

function partsEndWithWhitespace(parts: readonly AIComposerPart[]): boolean {
    const last = parts[parts.length - 1];
    return (
        last?.type === "text" &&
        (last.text.length === 0 || /\s$/.test(last.text))
    );
}

function partsStartWithWhitespace(parts: readonly AIComposerPart[]): boolean {
    const first = parts[0];
    return (
        first?.type === "text" &&
        (first.text.length === 0 || /^\s/.test(first.text))
    );
}

function getParentPath(candidatePath: string): string {
    const normalized = trimTrailingSeparators(candidatePath);
    const slashIndex = Math.max(
        normalized.lastIndexOf("/"),
        normalized.lastIndexOf("\\"),
    );

    if (slashIndex < 0) {
        return normalized;
    }

    if (slashIndex === 0) {
        return normalized.slice(0, 1);
    }

    const drivePrefix = normalized.slice(0, 2);
    if (/^[A-Za-z]:$/.test(drivePrefix) && slashIndex === 2) {
        return normalized.slice(0, 3);
    }

    return normalized.slice(0, slashIndex);
}

function trimTrailingSeparators(candidatePath: string): string {
    if (candidatePath === "/" || /^[A-Za-z]:[\\/]?$/.test(candidatePath)) {
        return candidatePath;
    }

    return candidatePath.replace(/[\\/]+$/, "");
}
