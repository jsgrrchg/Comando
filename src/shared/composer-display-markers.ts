import type { AiComposerMessagePart } from "./ipc";

export const COMPOSER_DISPLAY_PILL_OPEN = "\u200B\u00AB";
export const COMPOSER_DISPLAY_PILL_CLOSE = "\u00BB\u200B";

const FILE_MENTION_PREFIX = "file|";
const FOLDER_MENTION_PREFIX = "folder|";
const SELECTION_MENTION_PREFIX = "selection|";

export interface ComposerDisplayFileMention {
    readonly label: string;
    readonly relativePath: string;
}

export interface ComposerDisplayFolderMention {
    readonly folderPath: string;
    readonly label: string;
}

export function serializeComposerDisplayFolderMention(
    mention: ComposerDisplayFolderMention,
): string {
    const payload = [
        FOLDER_MENTION_PREFIX.slice(0, -1),
        encodeURIComponent(mention.folderPath),
        encodeURIComponent(mention.label),
    ].join("|");

    return `${COMPOSER_DISPLAY_PILL_OPEN}${payload}${COMPOSER_DISPLAY_PILL_CLOSE}`;
}

export function parseComposerDisplayFolderMention(
    payload: string,
): ComposerDisplayFolderMention | null {
    if (!payload.startsWith(FOLDER_MENTION_PREFIX)) {
        return null;
    }

    const parts = payload.split("|");
    if (parts.length !== 3 || !parts[1] || !parts[2]) {
        return null;
    }

    try {
        const folderPath = decodeURIComponent(parts[1]);
        const label = decodeURIComponent(parts[2]);
        return folderPath && label ? { folderPath, label } : null;
    } catch {
        return null;
    }
}

export interface ComposerDisplaySelectionMention {
    readonly endLine: number;
    readonly label: string;
    readonly path: string;
    readonly startLine: number;
}

export function serializeComposerDisplayFileMention(
    mention: ComposerDisplayFileMention,
): string {
    const payload = [
        FILE_MENTION_PREFIX.slice(0, -1),
        encodeURIComponent(mention.relativePath),
        encodeURIComponent(mention.label),
    ].join("|");

    return `${COMPOSER_DISPLAY_PILL_OPEN}${payload}${COMPOSER_DISPLAY_PILL_CLOSE}`;
}

export function parseComposerDisplayFileMention(
    payload: string,
): ComposerDisplayFileMention | null {
    if (!payload.startsWith(FILE_MENTION_PREFIX)) {
        return null;
    }

    const parts = payload.split("|");
    if (parts.length !== 3 || !parts[1] || !parts[2]) {
        return null;
    }

    try {
        const relativePath = decodeURIComponent(parts[1]);
        const label = decodeURIComponent(parts[2]);
        return relativePath && label ? { label, relativePath } : null;
    } catch {
        return null;
    }
}

export function serializeComposerDisplaySelectionMention(
    mention: ComposerDisplaySelectionMention,
): string {
    const payload = [
        SELECTION_MENTION_PREFIX.slice(0, -1),
        encodeURIComponent(mention.path),
        String(mention.startLine),
        String(mention.endLine),
        encodeURIComponent(mention.label),
    ].join("|");

    return `${COMPOSER_DISPLAY_PILL_OPEN}${payload}${COMPOSER_DISPLAY_PILL_CLOSE}`;
}

export function parseComposerDisplaySelectionMention(
    payload: string,
): ComposerDisplaySelectionMention | null {
    if (!payload.startsWith(SELECTION_MENTION_PREFIX)) {
        return null;
    }

    const parts = payload.split("|");
    if (parts.length !== 5 || !parts[1] || !parts[4]) {
        return null;
    }

    const startLine = Number(parts[2]);
    const endLine = Number(parts[3]);
    if (
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine
    ) {
        return null;
    }

    try {
        const path = decodeURIComponent(parts[1]);
        const label = decodeURIComponent(parts[4]);
        return path ? { endLine, label, path, startLine } : null;
    } catch {
        return null;
    }
}

export function formatComposerDisplaySelectionLabel(
    mention: ComposerDisplaySelectionMention,
): string {
    const fileName = mention.path.replaceAll("\\", "/").split("/").at(-1);
    const range =
        mention.startLine === mention.endLine
            ? `(line ${mention.startLine})`
            : `(lines ${mention.startLine}–${mention.endLine})`;
    return `${fileName || mention.path} ${range}`;
}

export function serializeComposerMessagePartsForDisplay(
    parts: readonly AiComposerMessagePart[] | undefined,
    fallback: string,
): string {
    if (!parts || parts.length === 0) {
        return fallback;
    }

    return parts
        .map((part) => {
            switch (part.type) {
                case "text":
                    return part.text;
                case "file_mention":
                    return serializeComposerDisplayFileMention({
                        label: part.label,
                        relativePath: part.relativePath,
                    });
                case "selection_mention":
                    return serializeComposerDisplaySelectionMention({
                        endLine: part.endLine,
                        label: part.label,
                        path: part.path,
                        startLine: part.startLine,
                    });
                case "folder_mention":
                    return serializeComposerDisplayFolderMention({
                        folderPath: part.folderPath,
                        label: part.label,
                    });
                case "fetch_mention":
                    return `${COMPOSER_DISPLAY_PILL_OPEN}@fetch${COMPOSER_DISPLAY_PILL_CLOSE}`;
                case "plan_mention":
                    return `${COMPOSER_DISPLAY_PILL_OPEN}/plan${COMPOSER_DISPLAY_PILL_CLOSE}`;
                case "file_attachment":
                    return `${COMPOSER_DISPLAY_PILL_OPEN}📎${part.label}${COMPOSER_DISPLAY_PILL_CLOSE}`;
                case "git_commit_mention":
                    return `${COMPOSER_DISPLAY_PILL_OPEN}commit: ${part.label}${COMPOSER_DISPLAY_PILL_CLOSE}`;
                case "github_issue_mention":
                case "github_pull_request_mention":
                    return `${COMPOSER_DISPLAY_PILL_OPEN}${part.label}${COMPOSER_DISPLAY_PILL_CLOSE}`;
            }
        })
        .join("")
        .trim();
}
