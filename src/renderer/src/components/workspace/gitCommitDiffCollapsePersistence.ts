const GIT_COMMIT_DIFF_COLLAPSE_STATE_VERSION = 1;
const GIT_COMMIT_DIFF_COLLAPSE_STATE_PREFIX =
    "comando.workspace.gitCommitDiffCollapse";

export interface GitCommitDiffCollapseScope {
    readonly commitSha: string;
    readonly projectId?: string | null;
    readonly surface: string;
    readonly worktreeId?: string | null;
}

export interface PersistedGitCommitDiffCollapseState {
    readonly collapsedFileIds: readonly string[];
    readonly updatedAt: number;
    readonly version: number;
}

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function encodeScopePart(value: string): string {
    return encodeURIComponent(value.trim());
}

function getProjectScope(projectId: string | null | undefined): string {
    return projectId?.trim() || "global";
}

function getWorktreeScope(worktreeId: string | null | undefined): string {
    return worktreeId?.trim() || "root";
}

function normalizeCollapsedFileIds(value: unknown): readonly string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const seen = new Set<string>();
    const fileIds: string[] = [];

    for (const item of value) {
        if (typeof item !== "string" || item.length === 0 || seen.has(item)) {
            continue;
        }

        seen.add(item);
        fileIds.push(item);
    }

    return fileIds;
}

function normalizePersistedGitCommitDiffCollapseState(
    raw: unknown,
): PersistedGitCommitDiffCollapseState | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const version = (raw as { version?: unknown }).version;
    const collapsedFileIds = normalizeCollapsedFileIds(
        (raw as { collapsedFileIds?: unknown }).collapsedFileIds,
    );
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;

    if (
        version !== GIT_COMMIT_DIFF_COLLAPSE_STATE_VERSION ||
        !collapsedFileIds ||
        typeof updatedAt !== "number" ||
        !Number.isFinite(updatedAt)
    ) {
        return null;
    }

    return {
        collapsedFileIds,
        updatedAt,
        version: GIT_COMMIT_DIFF_COLLAPSE_STATE_VERSION,
    };
}

export function getGitCommitDiffCollapseStorageKey(
    scope: GitCommitDiffCollapseScope,
): string {
    const parts = [
        GIT_COMMIT_DIFF_COLLAPSE_STATE_PREFIX,
        `v${GIT_COMMIT_DIFF_COLLAPSE_STATE_VERSION}`,
        "surface",
        encodeScopePart(scope.surface),
        "project",
        encodeScopePart(getProjectScope(scope.projectId)),
        "worktree",
        encodeScopePart(getWorktreeScope(scope.worktreeId)),
        "commit",
        encodeScopePart(scope.commitSha.trim() || "unknown"),
    ];

    return parts.join(":");
}

export function readPersistedGitCommitDiffCollapseState(
    storageKey: string,
): PersistedGitCommitDiffCollapseState | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    try {
        const raw = storage.getItem(storageKey);
        if (!raw) {
            return null;
        }

        return normalizePersistedGitCommitDiffCollapseState(JSON.parse(raw));
    } catch {
        return null;
    }
}

export function persistGitCommitDiffCollapseState(
    storageKey: string,
    collapsedFileIds: readonly string[],
): PersistedGitCommitDiffCollapseState | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const nextState: PersistedGitCommitDiffCollapseState = {
        collapsedFileIds: normalizeCollapsedFileIds(collapsedFileIds) ?? [],
        updatedAt: Date.now(),
        version: GIT_COMMIT_DIFF_COLLAPSE_STATE_VERSION,
    };

    try {
        storage.setItem(storageKey, JSON.stringify(nextState));
        return nextState;
    } catch {
        return null;
    }
}
