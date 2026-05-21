import type {
    GitDiffLineType,
    GitWorktreeDiffFile,
    GitWorktreeDiffResult,
} from "@shared/ipc";

function linePrefix(type: GitDiffLineType): string {
    if (type === "add") {
        return "+";
    }

    if (type === "remove") {
        return "-";
    }

    return " ";
}

function serializeFileDiff(file: GitWorktreeDiffFile): string | null {
    const path = file.path;
    const previousPath = file.previousPath ?? file.diff?.previousPath ?? null;
    const headerPath = previousPath ?? path;

    // Binary files (and files whose diff could not be computed) cannot be
    // represented as a textual patch, so emit a minimal informative block.
    if (file.isBinary || !file.diff) {
        return `diff --git a/${headerPath} b/${path}\nBinary files a/${headerPath} and b/${path} differ\n`;
    }

    const diff = file.diff;
    const lines: string[] = [`diff --git a/${headerPath} b/${path}`];

    if (diff.kind === "create") {
        lines.push("new file mode 100644");
    } else if (diff.kind === "delete") {
        lines.push("deleted file mode 100644");
    } else if (diff.kind === "move" && previousPath) {
        lines.push(`rename from ${previousPath}`);
        lines.push(`rename to ${path}`);
    }

    lines.push(diff.kind === "create" ? "--- /dev/null" : `--- a/${headerPath}`);
    lines.push(diff.kind === "delete" ? "+++ /dev/null" : `+++ b/${path}`);

    for (const hunk of diff.hunks) {
        lines.push(
            `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
        );
        for (const line of hunk.lines) {
            lines.push(`${linePrefix(line.type)}${line.text}`);
        }
    }

    return `${lines.join("\n")}\n`;
}

/**
 * Serializes the uncommitted worktree diff into a unified patch that can be
 * re-applied with `git apply`. Files appearing in multiple scopes (e.g. a
 * partially staged file) are emitted once, with the first occurrence winning,
 * so the output stays applyable rather than duplicating `diff --git` headers.
 */
export function serializeWorktreeDiffToPatch(
    result: GitWorktreeDiffResult | null,
): string {
    if (!result) {
        return "";
    }

    const seenPaths = new Set<string>();
    const blocks: string[] = [];

    for (const section of result.sections) {
        for (const file of section.files) {
            if (seenPaths.has(file.path)) {
                continue;
            }

            seenPaths.add(file.path);
            const block = serializeFileDiff(file);
            if (block) {
                blocks.push(block);
            }
        }
    }

    return blocks.join("");
}
