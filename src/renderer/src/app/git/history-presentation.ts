import type {
    GitCommitDetail,
    GitRevisionFileDiff,
    GitHistoryCommitSummary,
} from "@shared/ipc";

import type { GitDiffFile } from "@renderer/components/git";

export interface GitHistoryGraphRow {
    readonly bottomLanes: readonly number[];
    readonly colorId: number;
    readonly commit: GitHistoryCommitSummary;
    readonly graphLines: readonly GitHistoryGraphLine[];
    readonly laneIndex: number;
    readonly parentColumns: readonly number[];
    readonly topLanes: readonly number[];
}

export type GitHistoryGraphLineSegment =
    | {
          readonly kind: "straight";
          readonly toRow: number;
      }
    | {
          readonly kind: "curve";
          readonly curveKind: "checkout" | "merge";
          readonly onRow: number;
          readonly toColumn: number;
      };

export interface GitHistoryGraphLine {
    readonly childSha: string;
    readonly colorId: number;
    readonly parentSha: string;
    readonly segments: readonly GitHistoryGraphLineSegment[];
    readonly startColumn: number;
    readonly startRow: number;
}

type ActiveLineState = {
    readonly childSha: string;
    readonly colorId: number | null;
    readonly parentSha: string;
    readonly segments: GitHistoryGraphLineSegment[];
    readonly startColumn: number;
    readonly startRow: number;
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
    options: { readonly connectHistory?: boolean } = {},
): readonly GitHistoryGraphRow[] {
    if (options.connectHistory === false) {
        return buildGitHistoryGraphRows(commits).map((row) => ({
            bottomLanes: [],
            colorId: row.colorId,
            commit: row.commit,
            graphLines: [],
            laneIndex: 0,
            parentColumns: [],
            topLanes: [0],
        }));
    }

    const rows: GitHistoryGraphRow[] = [];
    const graphLines: GitHistoryGraphLine[] = [];
    const laneStates: (ActiveLineState | null)[] = [];
    const laneColors = new Map<number, number>();
    const parentToLanes = new Map<string, number[]>();
    let nextColorId = 0;

    const firstEmptyLaneIndex = (): number => {
        const emptyIndex = laneStates.findIndex((state) => state === null);
        if (emptyIndex >= 0) {
            return emptyIndex;
        }

        laneStates.push(null);
        return laneStates.length - 1;
    };

    const getLaneColor = (laneIndex: number): number => {
        const existingColor = laneColors.get(laneIndex);
        if (existingColor !== undefined) {
            return existingColor;
        }

        const colorId = nextColorId++;
        laneColors.set(laneIndex, colorId);
        return colorId;
    };

    const activeLaneColors = (): readonly number[] =>
        laneStates.map((state, laneIndex) => {
            if (!state) {
                return getLaneColor(laneIndex);
            }

            return state.colorId ?? getLaneColor(laneIndex);
        });

    const finalizeLine = (
        laneIndex: number,
        parentColumn: number,
        parentColorId: number,
        endingRow: number,
    ) => {
        const state = laneStates[laneIndex];
        laneStates[laneIndex] = null;
        if (!state) {
            return;
        }

        const finalColorId = state.colorId ?? parentColorId;
        const segments = [...state.segments];
        const lastSegment = segments[segments.length - 1];

        if (lastSegment?.kind === "straight") {
            if (parentColumn !== laneIndex) {
                const straightEndRow = endingRow - 1;
                if (straightEndRow > state.startRow) {
                    segments[segments.length - 1] = {
                        kind: "straight",
                        toRow: straightEndRow,
                    };
                    segments.push({
                        curveKind: "checkout",
                        kind: "curve",
                        onRow: endingRow,
                        toColumn: parentColumn,
                    });
                } else {
                    segments[segments.length - 1] = {
                        curveKind: "checkout",
                        kind: "curve",
                        onRow: endingRow,
                        toColumn: parentColumn,
                    };
                }
            } else {
                segments[segments.length - 1] = {
                    kind: "straight",
                    toRow: endingRow,
                };
            }
        } else if (lastSegment?.kind === "curve") {
            if (
                lastSegment.curveKind === "merge" &&
                lastSegment.onRow === state.startRow + 1 &&
                lastSegment.onRow < endingRow
            ) {
                if (lastSegment.toColumn !== parentColumn) {
                    segments.push({ kind: "straight", toRow: endingRow - 1 });
                    segments.push({
                        curveKind: "checkout",
                        kind: "curve",
                        onRow: endingRow,
                        toColumn: parentColumn,
                    });
                } else {
                    segments.push({ kind: "straight", toRow: endingRow });
                }
            } else if (lastSegment.toColumn !== parentColumn) {
                segments.push({
                    curveKind: "checkout",
                    kind: "curve",
                    onRow: endingRow,
                    toColumn: parentColumn,
                });
            }
        }

        graphLines.push({
            childSha: state.childSha,
            colorId: finalColorId,
            parentSha: state.parentSha,
            segments,
            startColumn: state.startColumn,
            startRow: state.startRow,
        });
    };

    const appendOpenLine = (laneIndex: number) => {
        const state = laneStates[laneIndex];
        if (!state) {
            return;
        }

        laneStates[laneIndex] = null;
        graphLines.push({
            childSha: state.childSha,
            colorId: state.colorId ?? getLaneColor(laneIndex),
            parentSha: state.parentSha,
            segments: [...state.segments],
            startColumn: state.startColumn,
            startRow: state.startRow,
        });
    };

    for (const commit of commits) {
        const rowIndex = rows.length;
        const pendingLanes = parentToLanes.get(commit.sha) ?? [];
        parentToLanes.delete(commit.sha);
        const laneIndex =
            pendingLanes.length > 0
                ? Math.min(...pendingLanes)
                : firstEmptyLaneIndex();
        const colorId = getLaneColor(laneIndex);
        const topLanes = activeLaneColors();

        for (const pendingLane of pendingLanes) {
            finalizeLine(pendingLane, laneIndex, colorId, rowIndex);
        }

        const parentColumns: number[] = [];
        const claimedParents = new Set<string>();
        commit.parentShas.forEach((parentSha, parentIndex) => {
            if (claimedParents.has(parentSha)) {
                return;
            }

            claimedParents.add(parentSha);
            const parentLaneIndex =
                parentIndex === 0 ? laneIndex : firstEmptyLaneIndex();
            const parentColorId =
                parentIndex === 0 ? colorId : getLaneColor(parentLaneIndex);
            parentColumns.push(parentLaneIndex);

            laneStates[parentLaneIndex] = {
                childSha: commit.sha,
                colorId: parentIndex === 0 ? parentColorId : null,
                parentSha,
                segments:
                    parentIndex === 0
                        ? [{ kind: "straight", toRow: Number.MAX_SAFE_INTEGER }]
                        : [
                              {
                                  curveKind: "merge",
                                  kind: "curve",
                                  onRow: rowIndex + 1,
                                  toColumn: parentLaneIndex,
                              },
                          ],
                startColumn: laneIndex,
                startRow: rowIndex,
            };

            const lanesForParent = parentToLanes.get(parentSha) ?? [];
            lanesForParent.push(parentLaneIndex);
            parentToLanes.set(parentSha, lanesForParent);
        });

        const bottomLanes = activeLaneColors();
        rows.push({
            bottomLanes,
            colorId,
            commit,
            graphLines,
            laneIndex,
            parentColumns,
            topLanes,
        });
    }

    laneStates.forEach((_state, laneIndex) => {
        appendOpenLine(laneIndex);
    });

    return rows;
}

export function convertCommitFilesToDiffFiles(
    files: readonly GitRevisionFileDiff[],
): readonly GitDiffFile[] {
    return files.map((file) => convertRevisionFileToDiffFile(file));
}

export const convertRevisionFilesToDiffFiles = convertCommitFilesToDiffFiles;

export function getTemporalGroupLabel(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const startOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
    );
    const commitDay = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
    );
    const diffDays = Math.floor(
        (startOfToday.getTime() - commitDay.getTime()) / 86_400_000,
    );

    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return "This Week";
    if (diffDays < 14) return "Last Week";
    return new Intl.DateTimeFormat("en", {
        month: "long",
        year: "numeric",
    }).format(date);
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

function convertRevisionFileToDiffFile(file: GitRevisionFileDiff): GitDiffFile {
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
        patch: file.patch ?? null,
        path: file.path,
        previousPath: file.previousPath,
        reversible: file.reversible,
        statusLabel: file.statusLabel,
        emptyState:
            file.contentState === "unavailable"
                ? "Diff content is unavailable from GitHub."
                : undefined,
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
