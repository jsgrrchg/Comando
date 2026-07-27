import nativeBranchDiff from "../../../../../fixtures/native-backend/git/branch.diff.json";
import nativeFileDiff from "../../../../../fixtures/native-backend/git/diff.file.json";

import type { GitDiffFile, GitDiffHunk, GitDiffLine } from "./types";

function convertNativeLine(
    line: (typeof nativeFileDiff.hunks)[number]["lines"][number],
): GitDiffLine {
    const kind =
        line.type === "add"
            ? "add"
            : line.type === "remove"
              ? "remove"
              : "context";

    return {
        id: line.id,
        kind,
        newLineNumber: line.newLineNumber,
        oldLineNumber: line.oldLineNumber,
        text: line.text,
    };
}

function convertNativeHunk(
    hunk: (typeof nativeFileDiff.hunks)[number],
): GitDiffHunk {
    return {
        header: hunk.header,
        id: hunk.id,
        lines: hunk.lines.map(convertNativeLine),
        newCount: hunk.newCount,
        newStart: hunk.newStart,
        oldCount: hunk.oldCount,
        oldStart: hunk.oldStart,
    };
}

function createUpdateHunk(
    id: string,
    oldText: string,
    newText: string,
): GitDiffHunk {
    return {
        header: "@@ -1,1 +1,1 @@",
        id: `${id}:hunk`,
        lines: [
            {
                id: `${id}:old`,
                kind: "remove",
                newLineNumber: null,
                oldLineNumber: 1,
                text: oldText,
            },
            {
                id: `${id}:new`,
                kind: "add",
                newLineNumber: 1,
                oldLineNumber: null,
                text: newText,
            },
        ],
        newCount: 1,
        newStart: 1,
        oldCount: 1,
        oldStart: 1,
    };
}

function createFile(
    overrides: Partial<GitDiffFile> & Pick<GitDiffFile, "id" | "path">,
): GitDiffFile {
    return {
        hunks: [],
        isText: true,
        kind: "update",
        newText: "const after = true;\n",
        oldText: "const before = true;\n",
        previousPath: null,
        reversible: true,
        statusLabel: "modified",
        ...overrides,
    };
}

const nativePartialDiff = nativeBranchDiff.files[0].diff;
const longLine = "x".repeat(2_048);

export const GIT_DIFF_FIXTURES = {
    update: createFile({
        hunks: nativeFileDiff.hunks.map(convertNativeHunk),
        id: `fixture:${nativeFileDiff.path}`,
        newText: nativeFileDiff.newText,
        oldText: nativeFileDiff.oldText,
        path: nativeFileDiff.path,
        summary: `+${nativeFileDiff.summary.insertions} -${nativeFileDiff.summary.deletions}`,
    }),
    create: createFile({
        hunks: [
            {
                header: "@@ -0,0 +1 @@",
                id: "fixture:create:hunk",
                lines: [
                    {
                        id: "fixture:create:new",
                        kind: "add",
                        newLineNumber: 1,
                        oldLineNumber: null,
                        text: "export const created = true;",
                    },
                ],
                newCount: 1,
                newStart: 1,
                oldCount: 0,
                oldStart: 0,
            },
        ],
        id: "fixture:create",
        kind: "create",
        newText: "export const created = true;\n",
        oldText: null,
        path: "src/created.ts",
        statusLabel: "created",
    }),
    delete: createFile({
        hunks: [
            {
                header: "@@ -1 +0,0 @@",
                id: "fixture:delete:hunk",
                lines: [
                    {
                        id: "fixture:delete:old",
                        kind: "remove",
                        newLineNumber: null,
                        oldLineNumber: 1,
                        text: "export const deleted = true;",
                    },
                ],
                newCount: 0,
                newStart: 0,
                oldCount: 1,
                oldStart: 1,
            },
        ],
        id: "fixture:delete",
        kind: "delete",
        newText: null,
        oldText: "export const deleted = true;\n",
        path: "src/deleted.ts",
        statusLabel: "deleted",
    }),
    rename: createFile({
        hunks: [
            createUpdateHunk(
                "fixture:rename",
                "export const previous = true;",
                "export const renamed = true;",
            ),
        ],
        id: "fixture:rename",
        kind: "move",
        newText: "export const renamed = true;\n",
        oldText: "export const previous = true;\n",
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        statusLabel: "renamed",
    }),
    binary: createFile({
        id: "fixture:binary",
        isText: false,
        newText: null,
        oldText: null,
        path: "assets/logo.png",
        statusLabel: "modified",
    }),
    noFinalNewline: createFile({
        hunks: [
            createUpdateHunk(
                "fixture:no-final-newline",
                "export const answer = 41;",
                "export const answer = 42;",
            ),
        ],
        id: "fixture:no-final-newline",
        newText: "export const answer = 42;",
        oldText: "export const answer = 41;",
        path: "src/no-final-newline.ts",
    }),
    longLine: createFile({
        hunks: [
            createUpdateHunk(
                "fixture:long-line",
                `const payload = "${longLine}0";`,
                `const payload = "${longLine}1";`,
            ),
        ],
        id: "fixture:long-line",
        newText: `const payload = "${longLine}1";\n`,
        oldText: `const payload = "${longLine}0";\n`,
        path: "src/long-line.ts",
    }),
    partialGitHub: createFile({
        emptyState: "Diff content is unavailable from GitHub.",
        hunks: nativePartialDiff.hunks.map(convertNativeHunk),
        id: "fixture:github-partial",
        newText: nativePartialDiff.newText,
        oldText: nativePartialDiff.oldText,
        path: nativePartialDiff.path,
        previousPath: nativePartialDiff.previousPath,
        summary: "+1 -1",
    }),
} as const satisfies Record<string, GitDiffFile>;
