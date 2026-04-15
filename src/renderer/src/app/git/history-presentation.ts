import type {
    GitCommitDetail,
    GitCommitFileDiff,
    GitHistoryCommitSummary,
} from "@shared/ipc";

import type { GitDiffFile } from "@renderer/components/git";

export interface GitHistoryGraphRow {
    readonly bottomLanes: readonly number[];
    readonly colorId: number;
    readonly commit: GitHistoryCommitSummary;
    readonly laneIndex: number;
    readonly parentColumns: readonly number[];
    readonly topLanes: readonly number[];
}

type ActiveLane = {
    readonly colorId: number;
    readonly sha: string;
};

export function filterGitHistory(
    commits: readonly GitHistoryCommitSummary[],
    query: string,
): readonly GitHistoryCommitSummary[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return commits;
    }

    return commits.filter((commit) =>
        [
            commit.sha,
            commit.shortSha,
            commit.subject,
            commit.body,
            commit.authorName,
            commit.authorEmail,
            ...commit.refs.map((reference) => reference.label),
        ]
            .join("\n")
            .toLowerCase()
            .includes(normalizedQuery),
    );
}

export function buildGitHistoryGraphRows(
    commits: readonly GitHistoryCommitSummary[],
): readonly GitHistoryGraphRow[] {
    const rows: GitHistoryGraphRow[] = [];
    let lanes: ActiveLane[] = [];
    let nextColorId = 0;

    for (const commit of commits) {
        let laneIndex = lanes.findIndex((lane) => lane.sha === commit.sha);
        if (laneIndex === -1) {
            laneIndex = lanes.length;
            lanes = [
                ...lanes,
                {
                    colorId: nextColorId++,
                    sha: commit.sha,
                },
            ];
        }

        const currentLane = lanes[laneIndex];
        if (!currentLane) {
            continue;
        }

        const topLanes = lanes.map((lane) => lane.colorId);
        let nextLanes = [...lanes];

        if (commit.parentShas.length === 0) {
            nextLanes.splice(laneIndex, 1);
        } else {
            nextLanes[laneIndex] = {
                colorId: currentLane.colorId,
                sha: commit.parentShas[0] ?? commit.sha,
            };

            for (const parentSha of commit.parentShas.slice(1)) {
                if (nextLanes.some((lane) => lane.sha === parentSha)) {
                    continue;
                }

                nextLanes.splice(laneIndex + 1, 0, {
                    colorId: nextColorId++,
                    sha: parentSha,
                });
            }

            const seen = new Set<string>();
            nextLanes = nextLanes.filter((lane) => {
                if (seen.has(lane.sha)) {
                    return false;
                }

                seen.add(lane.sha);
                return true;
            });
        }

        rows.push({
            bottomLanes: nextLanes.map((lane) => lane.colorId),
            colorId: currentLane.colorId,
            commit,
            laneIndex,
            parentColumns: commit.parentShas
                .map((parentSha) =>
                    nextLanes.findIndex((lane) => lane.sha === parentSha),
                )
                .filter((index) => index >= 0),
            topLanes,
        });

        lanes = nextLanes;
    }

    return rows;
}

export function convertCommitFilesToDiffFiles(
    files: readonly GitCommitFileDiff[],
): readonly GitDiffFile[] {
    return files.map((file) => convertCommitFileToDiffFile(file));
}

export function formatGitHistoryDate(value: string): string {
    return new Intl.DateTimeFormat("en", {
        day: "numeric",
        month: "short",
    }).format(new Date(value));
}

export function formatGitCommitDateTime(value: string): string {
    return new Intl.DateTimeFormat("en", {
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        month: "short",
        year: "numeric",
    }).format(new Date(value));
}

export function formatGitShortDate(value: string): string {
    return new Intl.DateTimeFormat("en", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    }).format(new Date(value));
}

export function getGitAuthorInitials(name: string): string {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("");
}

export function summarizeCommitDetail(detail: GitCommitDetail): string {
    const parts = [
        `${detail.changedFileCount} file${detail.changedFileCount === 1 ? "" : "s"}`,
    ];
    if (detail.insertions > 0) {
        parts.push(`+${detail.insertions}`);
    }
    if (detail.deletions > 0) {
        parts.push(`-${detail.deletions}`);
    }
    return parts.join("  ");
}

export interface GitRefPillTone {
    readonly className: string;
    readonly style?: Record<string, string>;
}

export function getRefPillStyle(kind: string): GitRefPillTone {
    switch (kind) {
        case "head":
            return {
                className:
                    "border-[color-mix(in_srgb,var(--color-accent)_40%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] text-text-primary",
            };
        case "tag":
            return {
                className: "border-border text-text-secondary",
                style: {
                    borderColor:
                        "color-mix(in srgb, var(--diff-warn) 35%, var(--color-border))",
                    color: "var(--diff-warn)",
                },
            };
        case "remote":
            return {
                className: "border-border text-text-secondary",
                style: {
                    borderColor:
                        "color-mix(in srgb, var(--diff-add) 30%, var(--color-border))",
                    color: "color-mix(in srgb, var(--diff-add) 80%, var(--color-text-secondary))",
                },
            };
        case "branch":
            return {
                className:
                    "border-[color-mix(in_srgb,var(--color-accent)_30%,var(--color-border))] text-text-primary",
            };
        default:
            return {
                className: "border-border text-text-secondary",
            };
    }
}

function convertCommitFileToDiffFile(file: GitCommitFileDiff): GitDiffFile {
    return {
        hunks: file.hunks.map((hunk) => {
            let oldLine = hunk.oldStart;
            let newLine = hunk.newStart;

            return {
                header: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
                id: hunk.id,
                lines: hunk.lines.map((line) => {
                    if (line.type === "add") {
                        return {
                            id: line.id,
                            kind: "add" as const,
                            newLineNumber: newLine++,
                            oldLineNumber: null,
                            text: line.text,
                        };
                    }

                    if (line.type === "remove") {
                        return {
                            id: line.id,
                            kind: "remove" as const,
                            newLineNumber: null,
                            oldLineNumber: oldLine++,
                            text: line.text,
                        };
                    }

                    return {
                        id: line.id,
                        kind: "context" as const,
                        newLineNumber: newLine++,
                        oldLineNumber: oldLine++,
                        text: line.text,
                    };
                }),
                newCount: hunk.newCount,
                newStart: hunk.newStart,
                oldCount: hunk.oldCount,
                oldStart: hunk.oldStart,
            };
        }),
        id: file.path,
        isText: file.isText,
        kind: file.kind,
        newText: file.newText,
        oldText: file.oldText,
        path: file.path,
        previousPath: file.previousPath,
        reversible: file.reversible,
        statusLabel: file.statusLabel,
        summary: formatGitCountLabel(file.additions, file.deletions),
    };
}

function formatGitCountLabel(
    additions: number | null,
    deletions: number | null,
): string | null {
    if (additions === null && deletions === null) {
        return null;
    }

    const parts: string[] = [];
    if (additions && additions > 0) {
        parts.push(`+${additions}`);
    }
    if (deletions && deletions > 0) {
        parts.push(`-${deletions}`);
    }

    return parts.length > 0 ? parts.join(" ") : "No line changes";
}
