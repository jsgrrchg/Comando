import path from "node:path";

import { simpleGit } from "simple-git";

import { debugBenignError } from "@main/observability/logging";

import type {
    GitChangeKind,
    GitFileDiff,
    GitFileDiffHunk,
    GitFileDiffLine,
    GitFileDiffOptions,
    GitFileDiffSummary,
} from "./types";

export async function getGitFileDiff(
    rootPath: string,
    relativePath: string,
    options: GitFileDiffOptions = {},
): Promise<GitFileDiff> {
    const staged = options.staged ?? false;
    const previousPath = options.previousPath ?? null;
    const git = simpleGit(rootPath);
    const detectedKind = options.kind ?? (await detectGitChangeKind(git, relativePath));
    const args = buildDiffArgs(relativePath, staged, previousPath, detectedKind);
    const raw = await git.raw(args);
    const parsed = parseUnifiedGitDiff(raw);

    return {
        changedPath: normalizeGitPath(relativePath),
        isBinary: parsed.isBinary,
        previousPath,
        raw,
        staged,
        summary: parsed.summary,
        hunks: parsed.hunks,
    };
}

export function parseUnifiedGitDiff(raw: string): {
    readonly hunks: readonly GitFileDiffHunk[];
    readonly isBinary: boolean;
    readonly summary: GitFileDiffSummary;
} {
    const lines = raw.split("\n");
    const hunks: GitFileDiffHunk[] = [];
    let isBinary = false;
    let currentHunk: MutableGitFileDiffHunk | null = null;
    let insertions = 0;
    let deletions = 0;
    let oldLineNumber = 0;
    let newLineNumber = 0;

    for (const line of lines) {
        if (line.startsWith("Binary files ")) {
            isBinary = true;
            continue;
        }

        const hunkHeader = parseHunkHeader(line);
        if (hunkHeader) {
            if (currentHunk) {
                hunks.push(currentHunk);
            }

            currentHunk = {
                header: line,
                lines: [],
                newCount: hunkHeader.newCount,
                newStart: hunkHeader.newStart,
                oldCount: hunkHeader.oldCount,
                oldStart: hunkHeader.oldStart,
            };
            oldLineNumber = hunkHeader.oldStart;
            newLineNumber = hunkHeader.newStart;
            continue;
        }

        if (!currentHunk) {
            continue;
        }

        if (line.startsWith("+") && !line.startsWith("+++")) {
            currentHunk.lines.push({
                newLineNumber,
                oldLineNumber: null,
                text: line.slice(1),
                type: "add",
            });
            insertions += 1;
            newLineNumber += 1;
            continue;
        }

        if (line.startsWith("-") && !line.startsWith("---")) {
            currentHunk.lines.push({
                newLineNumber: null,
                oldLineNumber,
                text: line.slice(1),
                type: "remove",
            });
            deletions += 1;
            oldLineNumber += 1;
            continue;
        }

        if (line.startsWith(" ")) {
            currentHunk.lines.push({
                newLineNumber,
                oldLineNumber,
                text: line.slice(1),
                type: "context",
            });
            oldLineNumber += 1;
            newLineNumber += 1;
        }
    }

    if (currentHunk) {
        hunks.push(currentHunk);
    }

    return {
        hunks,
        isBinary,
        summary: {
            deletions,
            insertions,
        },
    };
}

export function buildDiffArgs(
    relativePath: string,
    staged: boolean,
    previousPath: string | null,
    kind: GitChangeKind | null,
): string[] {
    const normalizedPath = normalizeGitPath(relativePath);

    if (!staged && kind === "untracked") {
        return [
            "diff",
            "--no-index",
            "--no-color",
            "--unified=3",
            "--",
            "/dev/null",
            normalizedPath,
        ];
    }

    if (staged) {
        return previousPath
            ? [
                  "diff",
                  "--cached",
                  "--find-renames",
                  "--find-copies",
                  "--no-color",
                  "--unified=3",
                  "--",
                  previousPath,
                  normalizedPath,
              ]
            : [
                  "diff",
                  "--cached",
                  "--find-renames",
                  "--find-copies",
                  "--no-color",
                  "--unified=3",
                  "--",
                  normalizedPath,
              ];
    }

    if (previousPath) {
        return [
            "diff",
            "--find-renames",
            "--find-copies",
            "--no-color",
            "--unified=3",
            "--",
            previousPath,
            normalizedPath,
        ];
    }

    return [
        "diff",
        "--no-color",
        "--unified=3",
        "--",
        normalizedPath,
    ];
}

async function detectGitChangeKind(
    git: ReturnType<typeof simpleGit>,
    relativePath: string,
): Promise<GitChangeKind | null> {
    try {
        const output = await git.raw([
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
            "--",
            normalizeGitPath(relativePath),
        ]);

        const firstLine = output.trim().split("\n")[0];
        if (!firstLine) {
            return null;
        }

        if (firstLine.startsWith("??")) {
            return "untracked";
        }

        if (firstLine.includes(" D") || firstLine.startsWith("D ")) {
            return "deleted";
        }

        return null;
    } catch (error) {
        debugBenignError("git.diff.detectChangeKind", error);
        return null;
    }
}

function parseHunkHeader(
    line: string,
): { newCount: number; newStart: number; oldCount: number; oldStart: number } | null {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
        return null;
    }

    return {
        newCount: Number(match[4] ?? "1"),
        newStart: Number(match[3]),
        oldCount: Number(match[2] ?? "1"),
        oldStart: Number(match[1]),
    };
}

function normalizeGitPath(filePath: string): string {
    return filePath.split(path.sep).join("/");
}

interface MutableGitFileDiffHunk {
    header: string;
    lines: GitFileDiffLine[];
    newCount: number;
    newStart: number;
    oldCount: number;
    oldStart: number;
}
