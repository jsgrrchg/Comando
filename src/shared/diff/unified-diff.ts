export interface UnifiedDiffLine {
    readonly id: string;
    readonly text: string;
    readonly type: "add" | "context" | "remove";
}

export interface UnifiedDiffHunk {
    readonly id: string;
    readonly lines: readonly UnifiedDiffLine[];
    readonly newCount: number;
    readonly newStart: number;
    readonly oldCount: number;
    readonly oldStart: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiffHunks(
    text: string,
    namespace = "unified",
): readonly UnifiedDiffHunk[] {
    const hunks: Array<{
        id: string;
        lines: UnifiedDiffLine[];
        newCount: number;
        newStart: number;
        oldCount: number;
        oldStart: number;
    }> = [];

    for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
        const header = HUNK_HEADER.exec(rawLine);
        if (header) {
            hunks.push({
                id: `${namespace}:hunk:${hunks.length}`,
                lines: [],
                newCount: Number.parseInt(header[4] ?? "1", 10),
                newStart: Number.parseInt(header[3] ?? "0", 10),
                oldCount: Number.parseInt(header[2] ?? "1", 10),
                oldStart: Number.parseInt(header[1] ?? "0", 10),
            });
            continue;
        }
        if (rawLine === "\\ No newline at end of file") continue;
        const hunk = hunks[hunks.length - 1];
        const marker = rawLine[0];
        if (!hunk || (marker !== " " && marker !== "+" && marker !== "-")) {
            continue;
        }
        hunk.lines.push({
            id: `${namespace}:line:${hunks.length - 1}:${hunk.lines.length}`,
            text: rawLine.slice(1),
            type: marker === " " ? "context" : marker === "+" ? "add" : "remove",
        });
    }

    return hunks;
}
