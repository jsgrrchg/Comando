import {
    appendSelectionMentionDraftPart,
    createEmptyComposerDraftParts,
    type AiComposerDraftPart,
} from "@renderer/app/ai/sessionReviewContracts";

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

/* ─── Serialization ─── */

const PILL_OPEN = "\u200B\u00AB";
const PILL_CLOSE = "\u00BB\u200B";

export function serializeComposerParts(
    parts: readonly AIComposerPart[],
): string {
    return parts
        .map((p) => {
            switch (p.type) {
                case "text":
                    return p.text;
                case "file_mention":
                    return `${PILL_OPEN}@${p.label}${PILL_CLOSE}`;
                case "folder_mention":
                    return `${PILL_OPEN}@${p.label}${PILL_CLOSE}`;
                case "fetch_mention":
                    return `${PILL_OPEN}@fetch${PILL_CLOSE}`;
                case "plan_mention":
                    return `${PILL_OPEN}/plan${PILL_CLOSE}`;
                case "selection_mention":
                    return `${PILL_OPEN}${p.label}${PILL_CLOSE}`;
                case "file_attachment":
                    return `${PILL_OPEN}📎${p.label}${PILL_CLOSE}`;
                case "git_commit_mention":
                    return `${PILL_OPEN}commit: ${p.label}${PILL_CLOSE}`;
            }
        })
        .join("");
}

export function cleanPillMarkers(text: string): string {
    return text.replaceAll(PILL_OPEN, "").replaceAll(PILL_CLOSE, "");
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

export function appendFetchMentionPart(
    parts: readonly AIComposerPart[],
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push({ type: "fetch_mention" });
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

export function appendPlanMentionPart(
    parts: readonly AIComposerPart[],
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push({ type: "plan_mention" });
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

/* ─── Emptiness check ─── */

export function isComposerEmpty(parts: readonly AIComposerPart[]): boolean {
    return parts.every((p) => p.type === "text" && p.text.trim().length === 0);
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
