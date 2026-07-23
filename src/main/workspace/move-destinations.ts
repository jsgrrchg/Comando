import type { WorkspaceNavigationSnapshot } from "@shared/ipc";
import {
    areWorkspaceScopesEquivalent,
    type WorkspaceScope,
} from "@shared/workspace-context";

export interface WorkspaceMoveWindowCandidate {
    readonly snapshot: WorkspaceNavigationSnapshot;
    readonly windowId: string;
    readonly windowTitle: string;
}

export interface WorkspaceMoveDestination {
    readonly enabled: boolean;
    readonly label: string;
    readonly targetWindowId: string;
}

export function buildWorkspaceMoveDestinations(input: {
    readonly candidates: readonly WorkspaceMoveWindowCandidate[];
    readonly scope: WorkspaceScope;
    readonly sourceWindowId: string;
}): readonly WorkspaceMoveDestination[] {
    const candidates = input.candidates.filter(
        (candidate) => candidate.windowId !== input.sourceWindowId,
    );
    const baseLabels = candidates.map((candidate, index) =>
        getBaseWindowLabel(candidate, index + 1),
    );
    const labelCounts = new Map<string, number>();
    for (const label of baseLabels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }

    return candidates.map((candidate, index) => ({
        enabled: !candidate.snapshot.contexts.some((context) =>
            areWorkspaceScopesEquivalent(context, input.scope),
        ),
        label:
            (labelCounts.get(baseLabels[index]) ?? 0) > 1
                ? `${baseLabels[index]} — Window ${index + 1}`
                : baseLabels[index],
        targetWindowId: candidate.windowId,
    }));
}

function getBaseWindowLabel(
    candidate: WorkspaceMoveWindowCandidate,
    ordinal: number,
): string {
    if (!candidate.snapshot.activeContextKey) {
        return `Window ${ordinal}`;
    }
    const title = candidate.windowTitle.trim();
    const separatorIndex = title.indexOf(" · ");
    const projectLabel =
        separatorIndex >= 0 ? title.slice(separatorIndex + 3).trim() : title;
    return projectLabel.length > 0 && title !== "Comando"
        ? projectLabel
        : `Window ${ordinal}`;
}
