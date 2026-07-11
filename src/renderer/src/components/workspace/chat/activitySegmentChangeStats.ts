import type { AiFileDiff } from "@shared/ipc";
import { areTrackedFilePathReferencesEquivalent } from "@renderer/app/ai/trackedFilePath";

import { computeDiffStats } from "../review/reviewDiff";
import type { ToolActivitySegmentEntry } from "./chatTimelineModel";
import { deriveChangeReviewItems } from "./toolActivityReviewModel";

interface SegmentFileState {
    readonly identityKey: string | null;
    readonly initialPath: string;
    finalPath: string;
    initialText: string | null;
    finalText: string | null;
    isText: boolean;
    reversible: boolean;
}

export interface ActivitySegmentChangeStats {
    readonly additions: number;
    readonly approximate: boolean;
    readonly deletions: number;
}

function pathsMatch(
    state: SegmentFileState,
    diff: AiFileDiff,
): boolean {
    return [diff.path, diff.previousPath]
        .filter((path): path is string => path !== null)
        .some(
            (path) =>
                areTrackedFilePathReferencesEquivalent(path, state.finalPath) ||
                areTrackedFilePathReferencesEquivalent(path, state.initialPath),
        );
}

function inferNetDiffKind(
    state: SegmentFileState,
): AiFileDiff["kind"] {
    if (state.initialText === null) {
        return "create";
    }
    if (state.finalText === null) {
        return "delete";
    }
    if (
        !areTrackedFilePathReferencesEquivalent(
            state.initialPath,
            state.finalPath,
        )
    ) {
        return "move";
    }
    return "update";
}

function toNetDiff(state: SegmentFileState): AiFileDiff | null {
    const samePath = areTrackedFilePathReferencesEquivalent(
        state.initialPath,
        state.finalPath,
    );
    if (state.initialText === state.finalText && samePath) {
        return null;
    }

    return {
        hunks: [],
        isText: state.isText,
        kind: inferNetDiffKind(state),
        newText: state.finalText,
        oldText: state.initialText,
        path: state.finalPath,
        previousPath: samePath ? null : state.initialPath,
        reversible: state.reversible,
    };
}

export function deriveActivitySegmentChangeStats(
    entries: readonly ToolActivitySegmentEntry[],
): ActivitySegmentChangeStats {
    const states: SegmentFileState[] = [];

    for (const entry of entries) {
        const items = deriveChangeReviewItems(
            entry.reviewEntry.activity,
            entry.reviewEntry.trackedFiles,
        );

        for (const item of items) {
            const identityKey = item.file?.identityKey ?? null;
            const existing = states.find(
                (state) =>
                    (identityKey !== null &&
                        state.identityKey === identityKey) ||
                    pathsMatch(state, item.diff),
            );

            if (!existing) {
                states.push({
                    identityKey,
                    initialPath: item.diff.previousPath ?? item.diff.path,
                    finalPath: item.diff.path,
                    initialText: item.diff.oldText,
                    finalText: item.diff.newText,
                    isText: item.diff.isText,
                    reversible: item.diff.reversible,
                });
                continue;
            }

            existing.finalPath = item.diff.path;
            existing.finalText = item.diff.newText;
            existing.isText &&= item.diff.isText;
            existing.reversible &&= item.diff.reversible;
        }
    }

    const netDiffs = states
        .map(toNetDiff)
        .filter((diff): diff is AiFileDiff => diff !== null);
    const stats = computeDiffStats(netDiffs);
    return {
        additions: stats.additions,
        approximate: stats.approximate === true,
        deletions: stats.deletions,
    };
}
