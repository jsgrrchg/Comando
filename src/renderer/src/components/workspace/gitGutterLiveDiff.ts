import type { GitFileDiff, GitDiffHunk, GitDiffLine } from "@shared/ipc";

const LIVE_DIFF_CONTEXT_LINES = 3;
const LIVE_DIFF_MAX_MATRIX_CELLS = 2_000_000;

interface BuildLiveGitGutterDiffInput {
    readonly baseText: string;
    readonly currentText: string;
    readonly kind: GitFileDiff["kind"];
    readonly path: string;
    readonly previousPath: string | null;
}

type DiffOperationType = GitDiffLine["type"];

interface DiffOperation {
    readonly beforeNewLineNumber: number;
    readonly beforeOldLineNumber: number;
    readonly newLineNumber: number | null;
    readonly oldLineNumber: number | null;
    readonly text: string;
    readonly type: DiffOperationType;
}

export function buildLiveGitGutterDiff({
    baseText,
    currentText,
    kind,
    path,
    previousPath,
}: BuildLiveGitGutterDiffInput): GitFileDiff | null {
    const operations = computeLineDiffOperations(
        splitTextForLineDiff(baseText),
        splitTextForLineDiff(currentText),
    );

    if (!operations) {
        return null;
    }

    return {
        hunks: buildDiffHunks(operations, path),
        isText: true,
        kind,
        newText: currentText,
        oldText: baseText,
        path,
        previousPath,
        reversible: true,
    };
}

function computeLineDiffOperations(
    oldLines: readonly string[],
    newLines: readonly string[],
): readonly DiffOperation[] | null {
    let prefixLength = 0;
    while (
        prefixLength < oldLines.length &&
        prefixLength < newLines.length &&
        oldLines[prefixLength] === newLines[prefixLength]
    ) {
        prefixLength += 1;
    }

    let suffixLength = 0;
    while (
        suffixLength < oldLines.length - prefixLength &&
        suffixLength < newLines.length - prefixLength &&
        oldLines[oldLines.length - suffixLength - 1] ===
            newLines[newLines.length - suffixLength - 1]
    ) {
        suffixLength += 1;
    }

    const oldMiddle = oldLines.slice(
        prefixLength,
        oldLines.length - suffixLength,
    );
    const newMiddle = newLines.slice(
        prefixLength,
        newLines.length - suffixLength,
    );
    const middleOperations = computeMiddleLineDiffOperations(
        oldMiddle,
        newMiddle,
    );

    if (!middleOperations) {
        return null;
    }

    return numberDiffOperations([
        ...oldLines
            .slice(0, prefixLength)
            .map((text) => ({ text, type: "context" as const })),
        ...middleOperations,
        ...oldLines
            .slice(oldLines.length - suffixLength)
            .map((text) => ({ text, type: "context" as const })),
    ]);
}

function computeMiddleLineDiffOperations(
    oldLines: readonly string[],
    newLines: readonly string[],
): ReadonlyArray<Pick<DiffOperation, "text" | "type">> | null {
    const cellCount = (oldLines.length + 1) * (newLines.length + 1);
    if (cellCount > LIVE_DIFF_MAX_MATRIX_CELLS) {
        return null;
    }

    const width = newLines.length + 1;
    const table = new Uint32Array(cellCount);
    const tableIndex = (oldIndex: number, newIndex: number) =>
        oldIndex * width + newIndex;

    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (
            let newIndex = newLines.length - 1;
            newIndex >= 0;
            newIndex -= 1
        ) {
            table[tableIndex(oldIndex, newIndex)] =
                oldLines[oldIndex] === newLines[newIndex]
                    ? table[tableIndex(oldIndex + 1, newIndex + 1)] + 1
                    : Math.max(
                          table[tableIndex(oldIndex + 1, newIndex)],
                          table[tableIndex(oldIndex, newIndex + 1)],
                      );
        }
    }

    const operations: Array<Pick<DiffOperation, "text" | "type">> = [];
    let oldIndex = 0;
    let newIndex = 0;

    while (oldIndex < oldLines.length && newIndex < newLines.length) {
        if (oldLines[oldIndex] === newLines[newIndex]) {
            operations.push({
                text: oldLines[oldIndex],
                type: "context",
            });
            oldIndex += 1;
            newIndex += 1;
            continue;
        }

        if (
            table[tableIndex(oldIndex + 1, newIndex)] >=
            table[tableIndex(oldIndex, newIndex + 1)]
        ) {
            operations.push({
                text: oldLines[oldIndex],
                type: "remove",
            });
            oldIndex += 1;
            continue;
        }

        operations.push({
            text: newLines[newIndex],
            type: "add",
        });
        newIndex += 1;
    }

    while (oldIndex < oldLines.length) {
        operations.push({
            text: oldLines[oldIndex],
            type: "remove",
        });
        oldIndex += 1;
    }

    while (newIndex < newLines.length) {
        operations.push({
            text: newLines[newIndex],
            type: "add",
        });
        newIndex += 1;
    }

    return operations;
}

function numberDiffOperations(
    operations: ReadonlyArray<Pick<DiffOperation, "text" | "type">>,
): readonly DiffOperation[] {
    let oldLineNumber = 1;
    let newLineNumber = 1;

    return operations.map((operation) => {
        const numberedOperation: DiffOperation = {
            beforeNewLineNumber: newLineNumber,
            beforeOldLineNumber: oldLineNumber,
            newLineNumber:
                operation.type === "remove" ? null : newLineNumber,
            oldLineNumber: operation.type === "add" ? null : oldLineNumber,
            text: operation.text,
            type: operation.type,
        };

        if (operation.type !== "add") {
            oldLineNumber += 1;
        }

        if (operation.type !== "remove") {
            newLineNumber += 1;
        }

        return numberedOperation;
    });
}

function buildDiffHunks(
    operations: readonly DiffOperation[],
    path: string,
): readonly GitDiffHunk[] {
    const changeIndexes = operations
        .map((operation, index) =>
            operation.type === "context" ? null : index,
        )
        .filter((index): index is number => index !== null);

    if (changeIndexes.length === 0) {
        return [];
    }

    const ranges: Array<{ end: number; start: number }> = [];
    for (const changeIndex of changeIndexes) {
        const start = Math.max(0, changeIndex - LIVE_DIFF_CONTEXT_LINES);
        const end = Math.min(
            operations.length - 1,
            changeIndex + LIVE_DIFF_CONTEXT_LINES,
        );
        const previous = ranges.at(-1);

        if (previous && start <= previous.end + 1) {
            previous.end = Math.max(previous.end, end);
            continue;
        }

        ranges.push({ end, start });
    }

    return ranges.map((range, hunkIndex) => {
        const hunkOperations = operations.slice(range.start, range.end + 1);
        const firstOperation = hunkOperations[0];

        return {
            id: `live:${path}:${hunkIndex}`,
            lines: hunkOperations.map((operation, lineIndex) => ({
                id: `live:${path}:${hunkIndex}:${lineIndex}`,
                text: operation.text,
                type: operation.type,
            })),
            newCount: hunkOperations.filter(
                (operation) => operation.type !== "remove",
            ).length,
            newStart: firstOperation?.beforeNewLineNumber ?? 1,
            oldCount: hunkOperations.filter(
                (operation) => operation.type !== "add",
            ).length,
            oldStart: firstOperation?.beforeOldLineNumber ?? 1,
        };
    });
}

function splitTextForLineDiff(text: string): readonly string[] {
    const normalizedText = text.replace(/\r\n?/g, "\n");
    if (normalizedText.length === 0) {
        return [];
    }

    const lines = normalizedText.split("\n");
    if (normalizedText.endsWith("\n")) {
        lines.pop();
    }

    return lines;
}
