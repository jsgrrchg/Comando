import { simpleGit } from "simple-git";

import { parseUnifiedGitDiff } from "./diff";
import type {
    GitCommitDetail,
    GitCommitDiffFile,
    GitCommitReference,
    GitHistoryCommitSummary,
    GitListHistoryOptions,
} from "./types";

const FIELD_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";
const DEFAULT_HISTORY_LIMIT = 200;

export async function listGitHistory(
    rootPath: string,
    options: GitListHistoryOptions = {},
): Promise<readonly GitHistoryCommitSummary[]> {
    const git = createBackgroundSafeGit(rootPath);
    const limit = normalizeHistoryLimit(options.limit);
    const format = buildHistoryFormat();
    const raw = await git.raw([
        "log",
        "--all",
        "--date-order",
        `--max-count=${limit}`,
        `--pretty=format:${format}`,
    ]);

    return parseGitHistory(raw);
}

export async function getGitCommitDetail(
    rootPath: string,
    commitSha: string,
): Promise<GitCommitDetail> {
    const git = createBackgroundSafeGit(rootPath);
    const metadataOutput = await git.raw([
        "show",
        "--no-patch",
        `--format=${buildHistoryFormat()}`,
        commitSha,
    ]);
    const metadata = parseGitHistory(metadataOutput)[0];

    if (!metadata) {
        throw new Error(`Could not read commit "${commitSha}".`);
    }

    const diffRaw = await git.raw(buildCommitDiffArgs(metadata));
    const files = parseCommitDiffFiles(diffRaw);
    const insertions = files.reduce(
        (total, file) => total + (file.additions ?? 0),
        0,
    );
    const deletions = files.reduce(
        (total, file) => total + (file.deletions ?? 0),
        0,
    );

    return {
        ...metadata,
        changedFileCount: files.length,
        committedAt: metadata.authoredAt,
        committerEmail: metadata.authorEmail,
        committerName: metadata.authorName,
        deletions,
        files,
        insertions,
    };
}

function buildHistoryFormat(): string {
    return (
        ["%H", "%P", "%an", "%ae", "%aI", "%s", "%b", "%D"].join(
            FIELD_SEPARATOR,
        ) + RECORD_SEPARATOR
    );
}

function normalizeHistoryLimit(limit: number | undefined): number {
    if (!Number.isFinite(limit)) {
        return DEFAULT_HISTORY_LIMIT;
    }

    return Math.max(1, Math.trunc(limit ?? 0));
}

function parseGitHistory(raw: string): readonly GitHistoryCommitSummary[] {
    return raw
        .split(RECORD_SEPARATOR)
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
            const [
                sha = "",
                parentShaList = "",
                authorName = "",
                authorEmail = "",
                authoredAt = "",
                subject = "",
                body = "",
                decorations = "",
            ] = record.split(FIELD_SEPARATOR);

            return {
                authorEmail,
                authorName,
                authoredAt,
                body: body.trim(),
                parentShas: parentShaList
                    .split(" ")
                    .map((value) => value.trim())
                    .filter(Boolean),
                refs: parseCommitReferences(decorations),
                sha,
                shortSha: sha.slice(0, 7),
                subject,
            } satisfies GitHistoryCommitSummary;
        })
        .filter((commit) => commit.sha.length > 0);
}

function parseCommitReferences(raw: string): readonly GitCommitReference[] {
    return raw
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean)
        .map((label) => ({
            kind: inferReferenceKind(label),
            label,
        }));
}

function inferReferenceKind(label: string): GitCommitReference["kind"] {
    if (label.startsWith("HEAD")) {
        return "head";
    }

    if (label.startsWith("tag: ")) {
        return "tag";
    }

    if (label.includes("/")) {
        return "remote";
    }

    if (label.length > 0) {
        return "branch";
    }

    return "other";
}

function buildCommitDiffArgs(
    commit: Pick<GitHistoryCommitSummary, "parentShas" | "sha">,
): string[] {
    const firstParent = commit.parentShas[0] ?? null;

    if (!firstParent) {
        return [
            "show",
            "--root",
            "--format=",
            "--find-renames",
            "--find-copies",
            "--no-color",
            "--unified=3",
            commit.sha,
        ];
    }

    return [
        "diff",
        "--find-renames",
        "--find-copies",
        "--no-color",
        "--unified=3",
        firstParent,
        commit.sha,
    ];
}

function parseCommitDiffFiles(raw: string): readonly GitCommitDiffFile[] {
    const normalized = raw.replaceAll("\r\n", "\n");
    const lines = normalized.split("\n");
    const sections: string[][] = [];
    let currentSection: string[] = [];

    for (const line of lines) {
        if (line.startsWith("diff --git ")) {
            if (currentSection.length > 0) {
                sections.push(currentSection);
            }
            currentSection = [line];
            continue;
        }

        if (currentSection.length > 0) {
            currentSection.push(line);
        }
    }

    if (currentSection.length > 0) {
        sections.push(currentSection);
    }

    return sections.map((section, index) =>
        parseCommitDiffFile(section, index),
    );
}

function parseCommitDiffFile(
    lines: readonly string[],
    index: number,
): GitCommitDiffFile {
    const header = lines[0] ?? "";
    const [, oldPathFromHeader = "", newPathFromHeader = ""] =
        /^diff --git a\/(.+) b\/(.+)$/.exec(header) ?? [];
    let kind: GitCommitDiffFile["kind"] = "update";
    let previousPath: string | null = null;
    let path = newPathFromHeader || oldPathFromHeader;

    for (const line of lines) {
        if (line.startsWith("new file mode ")) {
            kind = "create";
            path = newPathFromHeader || path;
            continue;
        }

        if (line.startsWith("deleted file mode ")) {
            kind = "delete";
            path = oldPathFromHeader || path;
            continue;
        }

        if (line.startsWith("rename from ")) {
            previousPath = line.slice("rename from ".length);
            kind = "move";
            path = previousPath;
            continue;
        }

        if (line.startsWith("rename to ")) {
            path = line.slice("rename to ".length);
        }
    }

    const rawSection = lines.join("\n");
    const parsed = parseUnifiedGitDiff(rawSection);

    return {
        additions: parsed.summary.insertions,
        deletions: parsed.summary.deletions,
        hunks: parsed.hunks.map((hunk, hunkIndex) => ({
            header: hunk.header,
            id: `${path}:${index}:${hunkIndex}`,
            lines: hunk.lines.map((line, lineIndex) => ({
                id: `${path}:${index}:${hunkIndex}:${lineIndex}`,
                text: line.text,
                type: line.type,
            })),
            newCount: hunk.newCount,
            newStart: hunk.newStart,
            oldCount: hunk.oldCount,
            oldStart: hunk.oldStart,
        })),
        isText: !parsed.isBinary,
        kind,
        newText: null,
        oldText: null,
        path,
        previousPath,
        reversible: false,
        statusLabel:
            kind === "create"
                ? "added"
                : kind === "delete"
                  ? "deleted"
                  : kind === "move"
                    ? "renamed"
                    : "modified",
    };
}

function createBackgroundSafeGit(rootPath: string) {
    return simpleGit(rootPath).env({ GIT_OPTIONAL_LOCKS: "0" });
}
