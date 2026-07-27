import {
    processFile,
    type CodeViewDiffItem,
    type FileDiffMetadata,
    type VirtualFileMetrics,
    DEFAULT_VIRTUAL_FILE_METRICS,
} from "@pierre/diffs";

import type { GitDiffFile } from "./types";

const DEFAULT_PIERRE_FONT_SIZE_PX = 13;
const DEFAULT_PIERRE_LINE_HEIGHT = 1.55;
export const PIERRE_GIT_DIFF_HEADER_HEIGHT_PX = 34;

function buildUnifiedPatchHeader(file: GitDiffFile): string {
    const oldPath = file.previousPath ?? file.path;

    if (file.kind === "create") {
        return `--- /dev/null\n+++ ${file.path}\n`;
    }

    if (file.kind === "delete") {
        return `--- ${oldPath}\n+++ /dev/null\n`;
    }

    return `--- ${oldPath}\n+++ ${file.path}\n`;
}

function buildPatchFromHunks(file: GitDiffFile): string | null {
    if (file.hunks.length === 0) {
        return null;
    }

    const hunks = file.hunks
        .map((hunk) => {
            const header =
                hunk.header ||
                `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
            const lines = hunk.lines
                .map((line) => {
                    const prefix =
                        line.kind === "add"
                            ? "+"
                            : line.kind === "remove"
                              ? "-"
                              : " ";
                    return `${prefix}${line.text}\n`;
                })
                .join("");

            return `${header}\n${lines}`;
        })
        .join("");

    return `${buildUnifiedPatchHeader(file)}${hunks}`;
}

function getPatchWithFileHeader(file: GitDiffFile, patch: string): string {
    const contentStart = patch.search(/\S/);
    const trimmedPatch = contentStart >= 0 ? patch.slice(contentStart) : "";

    if (
        trimmedPatch.startsWith("diff --git") ||
        trimmedPatch.startsWith("--- ")
    ) {
        return trimmedPatch;
    }

    // GitHub sends hunk bodies without the single-file boundary Pierre requires.
    return `${buildUnifiedPatchHeader(file)}${trimmedPatch}`;
}

export function getPierreGitDiffPatch(file: GitDiffFile): string | null {
    if (!file.isText) {
        return null;
    }

    if (typeof file.patch === "string" && file.patch.trim().length > 0) {
        return getPatchWithFileHeader(file, file.patch);
    }

    return buildPatchFromHunks(file);
}

export function compactPartialHunkOffsets(
    file: FileDiffMetadata,
): FileDiffMetadata {
    if (!file.isPartial) {
        return file;
    }

    let splitLineStart = 0;
    let unifiedLineStart = 0;
    const hunks = file.hunks.map((hunk) => {
        const compactHunk = {
            ...hunk,
            splitLineStart,
            unifiedLineStart,
        };
        splitLineStart += hunk.splitLineCount;
        unifiedLineStart += hunk.unifiedLineCount;
        return compactHunk;
    });

    // Pierre uses dense render indexes for virtual layout while collapsedBefore
    // remains the source-file distance displayed by its context separator.
    return {
        ...file,
        cacheKey: file.cacheKey ? `${file.cacheKey}:compact-partial` : undefined,
        hunks,
        splitLineCount: splitLineStart,
        unifiedLineCount: unifiedLineStart,
    };
}

export function createPierreGitDiffItem(
    file: GitDiffFile,
    collapsed: boolean,
): CodeViewDiffItem | null {
    const patch = getPierreGitDiffPatch(file);
    if (!patch) {
        return null;
    }

    try {
        const fileDiff = processFile(patch, {
            cacheKey: file.id,
            throwOnError: true,
        });
        if (!fileDiff || fileDiff.hunks.length === 0) {
            return null;
        }

        return {
            collapsed,
            fileDiff: compactPartialHunkOffsets(fileDiff),
            id: file.id,
            type: "diff",
        };
    } catch {
        return null;
    }
}

export function createPierreGitDiffItems(
    files: readonly GitDiffFile[],
): readonly CodeViewDiffItem[] | null {
    const items: CodeViewDiffItem[] = [];

    for (const file of files) {
        const item = createPierreGitDiffItem(file, false);
        if (!item) {
            return null;
        }
        items.push(item);
    }

    return items;
}

export function canRenderGitDiffWithPierre(file: GitDiffFile): boolean {
    return createPierreGitDiffItem(file, false) !== null;
}

export function getPierreDiffVirtualMetrics(
    codeFontSize: number | null,
    codeLineHeight: number | null,
): VirtualFileMetrics {
    const fontSize =
        typeof codeFontSize === "number" &&
        Number.isFinite(codeFontSize) &&
        codeFontSize > 0
            ? codeFontSize
            : DEFAULT_PIERRE_FONT_SIZE_PX;
    const lineHeight =
        typeof codeLineHeight === "number" &&
        Number.isFinite(codeLineHeight) &&
        codeLineHeight > 0
            ? codeLineHeight
            : DEFAULT_PIERRE_LINE_HEIGHT;

    return {
        ...DEFAULT_VIRTUAL_FILE_METRICS,
        diffHeaderHeight: PIERRE_GIT_DIFF_HEADER_HEIGHT_PX,
        lineHeight: lineHeight > 4 ? lineHeight : fontSize * lineHeight,
    };
}
