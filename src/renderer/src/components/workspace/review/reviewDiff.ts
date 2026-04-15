import type { AiDiffHunk, AiFileDiff, AiTrackedFile } from "@shared/ipc";

export interface DiffLine {
    readonly type: "add" | "context" | "remove" | "separator";
    readonly prefix: string;
    readonly text: string;
    readonly oldLineNumber?: number | null;
    readonly newLineNumber?: number | null;
    readonly exact?: boolean;
    readonly hunkIndex?: number;
    readonly decisionHunkIndex?: number;
    readonly visualBlockIndex?: number;
}

export interface DiffStats {
    readonly additions: number;
    readonly deletions: number;
    readonly approximate?: boolean;
}

export interface ChangeHunk {
    readonly index: number;
    readonly lines: readonly DiffLine[];
    readonly oldStart: number;
    readonly oldEnd: number;
    readonly newStart: number;
    readonly newEnd: number;
}

export type DecisionHunk = ChangeHunk;

export interface VisualDiffBlock extends ChangeHunk {
    readonly decisionHunkIndexes: readonly number[];
}

export interface StructuredDiffResult {
    readonly approximate: boolean;
    readonly hunks: readonly VisualDiffBlock[];
    readonly decisionHunks: readonly DecisionHunk[];
    readonly visualBlocks: readonly VisualDiffBlock[];
    readonly lines: readonly DiffLine[];
}

export const FULL_DIFF_MAX_LINES = 700;
export const LARGE_FILE_PREVIEW_MAX_LINES = 2000;
export const DIFF_CONTEXT_LINES = 5;
export const DIFF_PANEL_MAX_HEIGHT = 520;
export const DIFF_ZOOM_MIN = 0.64;
export const DIFF_ZOOM_MAX = 0.96;
export const DIFF_ZOOM_STEP = 0.04;

const UNIFIED_DIFF_HUNK_HEADER_REGEX =
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface DiffOp {
    readonly type: "add" | "context" | "remove";
    readonly text: string;
    readonly oldIndex: number | null;
    readonly newIndex: number | null;
}

interface RawChangeHunk {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    startOpIndex: number;
    endOpIndex: number;
}

interface MergeWindow {
    readonly start: number;
    readonly end: number;
    readonly decisionHunkIndexes: readonly number[];
    readonly oldStart: number;
    readonly oldEnd: number;
    readonly newStart: number;
    readonly newEnd: number;
}

function splitDiffText(text?: string | null): string[] {
    if (!text) {
        return [];
    }

    return text.split("\n");
}

function isPureMove(diff: AiFileDiff): boolean {
    return (
        diff.kind === "move" && (diff.oldText ?? "") === (diff.newText ?? "")
    );
}

function isLargeUpdateDiff(
    oldLines: readonly string[],
    newLines: readonly string[],
) {
    return Math.max(oldLines.length, newLines.length) > FULL_DIFF_MAX_LINES;
}

export function shouldWrapDiffPreview(
    filePath: string | null | undefined,
): boolean {
    if (!filePath) {
        return false;
    }

    return filePath.toLowerCase().endsWith(".md");
}

export function buildLcsTable(
    oldLines: readonly string[],
    newLines: readonly string[],
): number[][] {
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    const table = Array.from({ length: rows }, () =>
        new Array<number>(cols).fill(0),
    );

    for (let row = 1; row < rows; row += 1) {
        for (let col = 1; col < cols; col += 1) {
            table[row][col] =
                oldLines[row - 1] === newLines[col - 1]
                    ? table[row - 1][col - 1] + 1
                    : Math.max(table[row - 1][col], table[row][col - 1]);
        }
    }

    return table;
}

export function buildDiffOps(
    oldLines: readonly string[],
    newLines: readonly string[],
): DiffOp[] {
    const lcs = buildLcsTable(oldLines, newLines);
    const ops: DiffOp[] = [];

    let oldIndex = oldLines.length;
    let newIndex = newLines.length;

    while (oldIndex > 0 || newIndex > 0) {
        if (
            oldIndex > 0 &&
            newIndex > 0 &&
            oldLines[oldIndex - 1] === newLines[newIndex - 1]
        ) {
            ops.push({
                type: "context",
                text: oldLines[oldIndex - 1] ?? "",
                oldIndex: oldIndex - 1,
                newIndex: newIndex - 1,
            });
            oldIndex -= 1;
            newIndex -= 1;
            continue;
        }

        if (
            newIndex > 0 &&
            (oldIndex === 0 ||
                lcs[oldIndex][newIndex - 1] >= lcs[oldIndex - 1][newIndex])
        ) {
            ops.push({
                type: "add",
                text: newLines[newIndex - 1] ?? "",
                oldIndex: null,
                newIndex: newIndex - 1,
            });
            newIndex -= 1;
            continue;
        }

        ops.push({
            type: "remove",
            text: oldLines[oldIndex - 1] ?? "",
            oldIndex: oldIndex - 1,
            newIndex: null,
        });
        oldIndex -= 1;
    }

    ops.reverse();
    return ops;
}

function collectRawChangeHunks(ops: readonly DiffOp[]): RawChangeHunk[] {
    const hunks: RawChangeHunk[] = [];
    let current: RawChangeHunk | null = null;
    let oldPos = 0;
    let newPos = 0;

    for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
        const op = ops[opIndex];
        if (!op) {
            continue;
        }

        if (op.type === "context") {
            if (current) {
                hunks.push({
                    ...current,
                    endOpIndex: opIndex,
                    oldEnd: oldPos,
                    newEnd: newPos,
                });
                current = null;
            }

            oldPos += 1;
            newPos += 1;
            continue;
        }

        if (!current) {
            current = {
                oldStart: oldPos,
                oldEnd: oldPos,
                newStart: newPos,
                newEnd: newPos,
                startOpIndex: opIndex,
                endOpIndex: opIndex + 1,
            };
        }

        current.endOpIndex = opIndex + 1;

        if (op.type === "remove") {
            oldPos += 1;
            current.oldEnd = oldPos;
            current.newEnd = newPos;
            continue;
        }

        newPos += 1;
        current.oldEnd = oldPos;
        current.newEnd = newPos;
    }

    if (current) {
        hunks.push({
            newEnd: newPos,
            newStart: current.newStart,
            oldEnd: oldPos,
            oldStart: current.oldStart,
            startOpIndex: current.startOpIndex,
            endOpIndex: ops.length,
        });
    }

    return hunks;
}

function buildDiffLineFromOp(
    op: DiffOp,
    visualBlockIndex: number,
    decisionHunkIndex?: number,
): DiffLine {
    return {
        type: op.type,
        prefix: op.type === "add" ? "+ " : op.type === "remove" ? "- " : "  ",
        text: op.text,
        oldLineNumber: op.oldIndex != null ? op.oldIndex + 1 : null,
        newLineNumber: op.newIndex != null ? op.newIndex + 1 : null,
        hunkIndex: visualBlockIndex,
        decisionHunkIndex,
        visualBlockIndex,
    };
}

export function collectDiffHunks(
    oldText: string | null | undefined,
    newText: string | null | undefined,
): DecisionHunk[] {
    const oldLines = splitDiffText(oldText);
    const newLines = splitDiffText(newText);
    const ops = buildDiffOps(oldLines, newLines);
    const rawHunks = collectRawChangeHunks(ops);

    return rawHunks.map((hunk, index) => ({
        index,
        oldStart: hunk.oldStart,
        oldEnd: hunk.oldEnd,
        newStart: hunk.newStart,
        newEnd: hunk.newEnd,
        lines: ops
            .slice(hunk.startOpIndex, hunk.endOpIndex)
            .map((op) => buildDiffLineFromOp(op, index, index)),
    }));
}

export function computeExactDiffLines(
    hunks: readonly AiDiffHunk[],
): StructuredDiffResult {
    const decisionHunks: DecisionHunk[] = [];
    const visualBlocks: VisualDiffBlock[] = [];
    const lines: DiffLine[] = [];

    hunks.forEach((hunk, hunkIndex) => {
        if (hunkIndex > 0) {
            lines.push({
                type: "separator",
                prefix: "",
                text: "···",
                oldLineNumber: null,
                newLineNumber: null,
                exact: true,
            });
        }

        let oldLineNumber = hunk.oldStart;
        let newLineNumber = hunk.newStart;
        const hunkLines: DiffLine[] = [];

        for (const line of hunk.lines) {
            const diffLine: DiffLine =
                line.type === "context"
                    ? {
                          type: "context",
                          prefix: "  ",
                          text: line.text,
                          oldLineNumber,
                          newLineNumber,
                          exact: true,
                          hunkIndex,
                          decisionHunkIndex: hunkIndex,
                          visualBlockIndex: hunkIndex,
                      }
                    : line.type === "remove"
                      ? {
                            type: "remove",
                            prefix: "- ",
                            text: line.text,
                            oldLineNumber,
                            newLineNumber: null,
                            exact: true,
                            hunkIndex,
                            decisionHunkIndex: hunkIndex,
                            visualBlockIndex: hunkIndex,
                        }
                      : {
                            type: "add",
                            prefix: "+ ",
                            text: line.text,
                            oldLineNumber: null,
                            newLineNumber,
                            exact: true,
                            hunkIndex,
                            decisionHunkIndex: hunkIndex,
                            visualBlockIndex: hunkIndex,
                        };

            hunkLines.push(diffLine);
            lines.push(diffLine);

            if (line.type !== "add") {
                oldLineNumber += 1;
            }

            if (line.type !== "remove") {
                newLineNumber += 1;
            }
        }

        const normalizedHunk: DecisionHunk = {
            index: hunkIndex,
            lines: hunkLines,
            oldStart: Math.max(0, hunk.oldStart - 1),
            oldEnd: Math.max(0, hunk.oldStart - 1) + hunk.oldCount,
            newStart: Math.max(0, hunk.newStart - 1),
            newEnd: Math.max(0, hunk.newStart - 1) + hunk.newCount,
        };

        decisionHunks.push(normalizedHunk);
        visualBlocks.push({
            ...normalizedHunk,
            decisionHunkIndexes: [hunkIndex],
        });
    });

    return {
        approximate: false,
        hunks: visualBlocks,
        decisionHunks,
        visualBlocks,
        lines,
    };
}

function mergeDecisionWindows(
    rawHunks: readonly RawChangeHunk[],
    ops: readonly DiffOp[],
): readonly MergeWindow[] {
    const windows = rawHunks.map((hunk, index) => ({
        start: Math.max(0, hunk.startOpIndex - DIFF_CONTEXT_LINES),
        end: Math.min(ops.length, hunk.endOpIndex + DIFF_CONTEXT_LINES),
        decisionHunkIndexes: [index],
        oldStart: hunk.oldStart,
        oldEnd: hunk.oldEnd,
        newStart: hunk.newStart,
        newEnd: hunk.newEnd,
    }));

    const merged: Array<{
        start: number;
        end: number;
        decisionHunkIndexes: number[];
        oldStart: number;
        oldEnd: number;
        newStart: number;
        newEnd: number;
    }> = [];

    for (const window of windows) {
        const previous = merged[merged.length - 1];
        if (!previous || window.start > previous.end) {
            merged.push({ ...window });
            continue;
        }

        previous.end = Math.max(previous.end, window.end);
        previous.decisionHunkIndexes.push(...window.decisionHunkIndexes);
        previous.oldStart = Math.min(previous.oldStart, window.oldStart);
        previous.oldEnd = Math.max(previous.oldEnd, window.oldEnd);
        previous.newStart = Math.min(previous.newStart, window.newStart);
        previous.newEnd = Math.max(previous.newEnd, window.newEnd);
    }

    return merged;
}

function groupApproximateDiffLines(
    oldText: string | null | undefined,
    newText: string | null | undefined,
): StructuredDiffResult {
    const oldLines = splitDiffText(oldText);
    const newLines = splitDiffText(newText);
    const ops = buildDiffOps(oldLines, newLines);
    const rawHunks = collectRawChangeHunks(ops);

    if (rawHunks.length === 0) {
        return {
            approximate: false,
            hunks: [],
            decisionHunks: [],
            visualBlocks: [],
            lines: [],
        };
    }

    const decisionHunks: DecisionHunk[] = rawHunks.map((hunk, index) => ({
        index,
        oldStart: hunk.oldStart,
        oldEnd: hunk.oldEnd,
        newStart: hunk.newStart,
        newEnd: hunk.newEnd,
        lines: ops
            .slice(hunk.startOpIndex, hunk.endOpIndex)
            .map((op) => buildDiffLineFromOp(op, index, index)),
    }));
    const mergedWindows = mergeDecisionWindows(rawHunks, ops);
    const resultLines: DiffLine[] = [];
    const visualBlocks: VisualDiffBlock[] = [];

    const opDecisionHunkIndexes = new Map<number, number>();
    rawHunks.forEach((hunk, hunkIndex) => {
        for (
            let opIndex = hunk.startOpIndex;
            opIndex < hunk.endOpIndex;
            opIndex += 1
        ) {
            opDecisionHunkIndexes.set(opIndex, hunkIndex);
        }
    });

    mergedWindows.forEach((window, visualBlockIndex) => {
        if (visualBlockIndex > 0) {
            resultLines.push({
                type: "separator",
                prefix: "",
                text: "···",
            });
        }

        const blockLines = ops
            .slice(window.start, window.end)
            .map((op, relativeIndex) =>
                buildDiffLineFromOp(
                    op,
                    visualBlockIndex,
                    opDecisionHunkIndexes.get(window.start + relativeIndex),
                ),
            );

        resultLines.push(...blockLines);
        visualBlocks.push({
            index: visualBlockIndex,
            lines: blockLines,
            oldStart: window.oldStart,
            oldEnd: window.oldEnd,
            newStart: window.newStart,
            newEnd: window.newEnd,
            decisionHunkIndexes: [...window.decisionHunkIndexes],
        });
    });

    return {
        approximate: false,
        hunks: visualBlocks,
        decisionHunks,
        visualBlocks,
        lines: resultLines,
    };
}

function buildLargeFilePreview(
    oldLines: readonly string[],
    newLines: readonly string[],
): StructuredDiffResult {
    const limit = Math.min(
        Math.max(oldLines.length, newLines.length),
        LARGE_FILE_PREVIEW_MAX_LINES,
    );
    const lines: DiffLine[] = [];
    let oldLineNumber = 1;
    let newLineNumber = 1;

    for (let index = 0; index < limit; index += 1) {
        const oldLine = oldLines[index];
        const newLine = newLines[index];

        if (oldLine === newLine) {
            lines.push({
                type: "context",
                prefix: "  ",
                text: newLine ?? oldLine ?? "",
                oldLineNumber,
                newLineNumber,
            });
            oldLineNumber += 1;
            newLineNumber += 1;
            continue;
        }

        if (oldLine !== undefined) {
            lines.push({
                type: "remove",
                prefix: "- ",
                text: oldLine,
                oldLineNumber,
                newLineNumber: null,
            });
            oldLineNumber += 1;
        }

        if (newLine !== undefined) {
            lines.push({
                type: "add",
                prefix: "+ ",
                text: newLine,
                oldLineNumber: null,
                newLineNumber,
            });
            newLineNumber += 1;
        }
    }

    const totalLines = Math.max(oldLines.length, newLines.length);
    const previewLabel =
        totalLines > LARGE_FILE_PREVIEW_MAX_LINES
            ? `(large file preview — showing first ${LARGE_FILE_PREVIEW_MAX_LINES} of ${totalLines} lines)`
            : `(large file preview — ${totalLines} lines shown without full diff matching)`;

    lines.push({
        type: "separator",
        prefix: "",
        text: previewLabel,
    });

    return {
        approximate: true,
        hunks: [],
        decisionHunks: [],
        visualBlocks: [],
        lines,
    };
}

export function computeApproximateDiffLines(
    oldText: string | null | undefined,
    newText: string | null | undefined,
): StructuredDiffResult {
    const oldLines = splitDiffText(oldText);
    const newLines = splitDiffText(newText);

    if (isLargeUpdateDiff(oldLines, newLines)) {
        return buildLargeFilePreview(oldLines, newLines);
    }

    return groupApproximateDiffLines(oldText, newText);
}

export function parseUnifiedDiffHunks(text: string): AiDiffHunk[] {
    const hunks: AiDiffHunk[] = [];
    let currentHunk: {
        id: string;
        lines: Array<{
            id: string;
            text: string;
            type: "add" | "context" | "remove";
        }>;
        oldCount: number;
        oldStart: number;
        newCount: number;
        newStart: number;
    } | null = null;
    let lineIndex = 0;

    for (const rawLine of text.split("\n")) {
        const headerMatch = UNIFIED_DIFF_HUNK_HEADER_REGEX.exec(rawLine);
        if (headerMatch) {
            currentHunk = {
                id: `unified-hunk:${hunks.length}`,
                oldStart: Number.parseInt(headerMatch[1] ?? "0", 10),
                oldCount: Number.parseInt(headerMatch[2] ?? "1", 10),
                newStart: Number.parseInt(headerMatch[3] ?? "0", 10),
                newCount: Number.parseInt(headerMatch[4] ?? "1", 10),
                lines: [],
            };
            hunks.push(currentHunk);
            continue;
        }

        if (!currentHunk || rawLine === "\\ No newline at end of file") {
            continue;
        }

        const marker = rawLine[0];
        const textContent = rawLine.slice(1);
        if (marker === " ") {
            currentHunk.lines.push({
                id: `unified-line:${lineIndex}`,
                text: textContent,
                type: "context",
            });
            lineIndex += 1;
            continue;
        }

        if (marker === "-") {
            currentHunk.lines.push({
                id: `unified-line:${lineIndex}`,
                text: textContent,
                type: "remove",
            });
            lineIndex += 1;
            continue;
        }

        if (marker === "+") {
            currentHunk.lines.push({
                id: `unified-line:${lineIndex}`,
                text: textContent,
                type: "add",
            });
            lineIndex += 1;
        }
    }

    return hunks.filter((hunk) => hunk.lines.length > 0);
}

export function computeUnifiedDiffLines(text: string): readonly DiffLine[] {
    const hunks = parseUnifiedDiffHunks(text);
    if (hunks.length === 0) {
        return [];
    }

    return computeExactDiffLines(hunks).lines;
}

export function computeDiffLines(diff: AiFileDiff): readonly DiffLine[] {
    if (diff.isText === false) {
        return [];
    }

    if (diff.hunks.length > 0) {
        return computeExactDiffLines(diff.hunks).lines;
    }

    const oldLines = splitDiffText(diff.oldText);
    const newLines = splitDiffText(diff.newText);

    if (diff.kind === "create") {
        return newLines.map((line, index) => ({
            type: "add" as const,
            prefix: "+ ",
            text: line,
            oldLineNumber: null,
            newLineNumber: index + 1,
        }));
    }

    if (diff.kind === "delete") {
        if (diff.reversible === false) {
            return [
                {
                    type: "separator",
                    prefix: "",
                    text: "(partial preview — delete snapshot unavailable)",
                },
            ];
        }

        return oldLines.map((line, index) => ({
            type: "remove" as const,
            prefix: "- ",
            text: line,
            oldLineNumber: index + 1,
            newLineNumber: null,
        }));
    }

    if (isPureMove(diff)) {
        return [];
    }

    if (isLargeUpdateDiff(oldLines, newLines)) {
        return buildLargeFilePreview(oldLines, newLines).lines;
    }

    return groupApproximateDiffLines(diff.oldText, diff.newText).lines;
}

export function computeVisualDiffBlocks(
    diff: AiFileDiff,
): readonly VisualDiffBlock[] {
    if (diff.isText === false) {
        return [];
    }

    if (diff.hunks.length > 0) {
        return computeExactDiffLines(diff.hunks).hunks;
    }

    const oldLines = splitDiffText(diff.oldText);
    const newLines = splitDiffText(diff.newText);

    if (
        diff.kind === "create" ||
        diff.kind === "delete" ||
        isPureMove(diff) ||
        isLargeUpdateDiff(oldLines, newLines)
    ) {
        return [];
    }

    return groupApproximateDiffLines(diff.oldText, diff.newText).hunks;
}

export function computeDecisionHunks(
    diff: AiFileDiff,
): readonly DecisionHunk[] {
    if (diff.isText === false) {
        return [];
    }

    if (diff.hunks.length > 0) {
        return computeExactDiffLines(diff.hunks).decisionHunks;
    }

    const oldLines = splitDiffText(diff.oldText);
    const newLines = splitDiffText(diff.newText);

    if (
        diff.kind === "create" ||
        diff.kind === "delete" ||
        isPureMove(diff) ||
        isLargeUpdateDiff(oldLines, newLines)
    ) {
        return [];
    }

    return groupApproximateDiffLines(diff.oldText, diff.newText).decisionHunks;
}

export function computeFileDiffStats(diff: AiFileDiff): DiffStats {
    if (diff.isText === false) {
        return {
            additions: 0,
            deletions: 0,
            approximate: diff.reversible === false,
        };
    }

    if (diff.hunks.length > 0) {
        let additions = 0;
        let deletions = 0;

        for (const hunk of diff.hunks) {
            for (const line of hunk.lines) {
                if (line.type === "add") {
                    additions += 1;
                }
                if (line.type === "remove") {
                    deletions += 1;
                }
            }
        }

        return { additions, deletions };
    }

    const oldLines = splitDiffText(diff.oldText);
    const newLines = splitDiffText(diff.newText);

    if (diff.kind === "create") {
        return { additions: newLines.length, deletions: 0 };
    }

    if (diff.kind === "delete") {
        if (diff.reversible === false) {
            return { additions: 0, deletions: 0, approximate: true };
        }
        return { additions: 0, deletions: oldLines.length };
    }

    if (isPureMove(diff)) {
        return { additions: 0, deletions: 0 };
    }

    if (isLargeUpdateDiff(oldLines, newLines)) {
        let additions = 0;
        let deletions = 0;
        const limit = Math.min(
            Math.max(oldLines.length, newLines.length),
            LARGE_FILE_PREVIEW_MAX_LINES,
        );

        for (let index = 0; index < limit; index += 1) {
            const oldLine = oldLines[index];
            const newLine = newLines[index];

            if (oldLine === newLine) {
                continue;
            }

            if (oldLine !== undefined) {
                deletions += 1;
            }

            if (newLine !== undefined) {
                additions += 1;
            }
        }

        return { additions, deletions, approximate: true };
    }

    const lines = groupApproximateDiffLines(diff.oldText, diff.newText).lines;
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
        if (line.type === "add") {
            additions += 1;
        }
        if (line.type === "remove") {
            deletions += 1;
        }
    }

    return { additions, deletions };
}

export function computeDiffStats(diffs: readonly AiFileDiff[]): DiffStats {
    let additions = 0;
    let deletions = 0;
    let approximate = false;

    for (const diff of diffs) {
        const stats = computeFileDiffStats(diff);
        additions += stats.additions;
        deletions += stats.deletions;
        approximate ||= stats.approximate === true;
    }

    return { additions, deletions, approximate };
}

export function formatDiffStat(value: number, approximate = false): string {
    return `${approximate ? "~" : ""}${value}`;
}

export function clampDiffZoom(value: number): number {
    return Math.min(DIFF_ZOOM_MAX, Math.max(DIFF_ZOOM_MIN, value));
}

export function stepDiffZoom(value: number, delta: number): number {
    return Math.round(clampDiffZoom(value + delta) * 100) / 100;
}

export function getFileNameFromPath(path: string): string {
    return path.split("/").pop() ?? path;
}

export function getCompactPath(path: string, tailSegments = 3): string {
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= tailSegments) {
        return path;
    }

    return `.../${parts.slice(-tailSegments).join("/")}`;
}

export function createDiffFromTrackedFile(file: AiTrackedFile): AiFileDiff {
    return {
        hunks: [...file.hunks],
        isText: file.isText,
        kind: file.kind,
        newText: file.newText,
        oldText: file.oldText,
        path: file.path,
        previousPath: file.previousPath,
        reversible: file.reversible,
    };
}
