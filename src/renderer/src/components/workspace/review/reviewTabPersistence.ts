import type { ReviewFileItem } from "./editedFilesPresentationModel";

const REVIEW_VIEW_STATE_VERSION = 1;
const REVIEW_VIEW_STATE_PREFIX = "comando.ai.review.view";

export interface PersistedReviewAnchor {
    readonly fileUpdatedAt: string;
    readonly hunkIds: readonly string[];
    readonly identityKey: string;
    readonly pathAliases?: readonly string[];
}

export interface PersistedReviewViewState {
    readonly anchor: PersistedReviewAnchor | null;
    readonly expandedIdentityKeys: readonly string[];
    readonly scrollTop: number;
    readonly updatedAt: number;
    readonly version: number;
    readonly writerId?: string;
}

function normalizePath(path: string): string {
    return path.replace(/\\/g, "/");
}

function normalizePathAliases(paths: Iterable<string>): string[] {
    const normalized = new Set<string>();

    for (const path of paths) {
        if (typeof path !== "string" || path.length === 0) {
            continue;
        }
        normalized.add(normalizePath(path));
    }

    return [...normalized];
}

function normalizeExpandedIdentityKeys(
    keys: Iterable<string>,
): readonly string[] {
    return [...new Set([...keys].filter((key) => typeof key === "string"))];
}

function getStorage(): Storage | null {
    const candidate = globalThis.localStorage;
    if (!candidate) {
        return null;
    }

    return candidate;
}

function getProjectScope(projectId: string | null): string {
    return projectId?.trim() || "global";
}

function getWorktreeScope(worktreeId: string | null | undefined): string {
    return worktreeId?.trim() || "root";
}

function anchorsEqual(
    left: PersistedReviewAnchor | null,
    right: PersistedReviewAnchor | null,
): boolean {
    if (left === right) {
        return true;
    }

    if (!left || !right) {
        return false;
    }

    return (
        left.identityKey === right.identityKey &&
        left.fileUpdatedAt === right.fileUpdatedAt &&
        arraysEqual(left.hunkIds, right.hunkIds) &&
        arraysEqual(left.pathAliases ?? [], right.pathAliases ?? [])
    );
}

function arraysEqual(
    left: readonly string[],
    right: readonly string[],
): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((value, index) => value === right[index]);
}

function statesEqual(
    left: PersistedReviewViewState,
    right: PersistedReviewViewState,
): boolean {
    return (
        left.version === right.version &&
        left.scrollTop === right.scrollTop &&
        arraysEqual(left.expandedIdentityKeys, right.expandedIdentityKeys) &&
        anchorsEqual(left.anchor, right.anchor)
    );
}

function normalizeAnchor(raw: unknown): PersistedReviewAnchor | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const identityKey = (raw as { identityKey?: unknown }).identityKey;
    const fileUpdatedAt = (raw as { fileUpdatedAt?: unknown }).fileUpdatedAt;
    const hunkIds = (raw as { hunkIds?: unknown }).hunkIds;
    const pathAliases = (raw as { pathAliases?: unknown }).pathAliases;

    if (
        typeof identityKey !== "string" ||
        typeof fileUpdatedAt !== "string" ||
        !Array.isArray(hunkIds)
    ) {
        return null;
    }

    return {
        fileUpdatedAt,
        hunkIds: hunkIds.filter(
            (entry): entry is string => typeof entry === "string",
        ),
        identityKey,
        pathAliases: Array.isArray(pathAliases)
            ? normalizePathAliases(
                  pathAliases.filter(
                      (entry): entry is string => typeof entry === "string",
                  ),
              )
            : undefined,
    };
}

function normalizePersistedState(raw: unknown): PersistedReviewViewState | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const version = (raw as { version?: unknown }).version;
    const expandedIdentityKeys = (raw as { expandedIdentityKeys?: unknown })
        .expandedIdentityKeys;
    const scrollTop = (raw as { scrollTop?: unknown }).scrollTop;
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;
    const writerId = (raw as { writerId?: unknown }).writerId;

    if (
        version !== REVIEW_VIEW_STATE_VERSION ||
        !Array.isArray(expandedIdentityKeys) ||
        typeof scrollTop !== "number" ||
        !Number.isFinite(scrollTop) ||
        typeof updatedAt !== "number" ||
        !Number.isFinite(updatedAt)
    ) {
        return null;
    }

    return {
        anchor: normalizeAnchor((raw as { anchor?: unknown }).anchor),
        expandedIdentityKeys: normalizeExpandedIdentityKeys(
            expandedIdentityKeys.filter(
                (entry): entry is string => typeof entry === "string",
            ),
        ),
        scrollTop: Math.max(0, scrollTop),
        updatedAt,
        version: REVIEW_VIEW_STATE_VERSION,
        writerId: typeof writerId === "string" ? writerId : undefined,
    };
}

function getCandidatePathAliases(item: ReviewFileItem): string[] {
    const aliases = [item.file.path];
    if (item.file.previousPath) {
        aliases.push(item.file.previousPath);
    }
    if (item.diff.previousPath) {
        aliases.push(item.diff.previousPath);
    }
    aliases.push(item.diff.path);
    return normalizePathAliases(aliases);
}

function findItemByAnchor(
    anchor: PersistedReviewAnchor,
    items: readonly ReviewFileItem[],
): ReviewFileItem | null {
    const identityMatch =
        items.find((item) => item.file.identityKey === anchor.identityKey) ??
        null;

    if (identityMatch) {
        return identityMatch;
    }

    const anchorAliases = new Set(anchor.pathAliases ?? []);
    if (anchorAliases.size === 0) {
        return null;
    }

    const candidates = items.filter((item) =>
        getCandidatePathAliases(item).some((path) => anchorAliases.has(path)),
    );

    if (candidates.length === 0) {
        return null;
    }

    return (
        [...candidates].sort((left, right) =>
            right.file.updatedAt.localeCompare(left.file.updatedAt),
        )[0] ?? null
    );
}

export function getReviewViewStorageKey(
    projectId: string | null,
    worktreeId: string | null | undefined,
    sessionId: string,
): string {
    return `${REVIEW_VIEW_STATE_PREFIX}:${getProjectScope(projectId)}:${getWorktreeScope(worktreeId)}:review:${sessionId}`;
}

export function readPersistedReviewViewState(
    projectId: string | null,
    worktreeId: string | null | undefined,
    sessionId: string,
): PersistedReviewViewState | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const raw = storage.getItem(
        getReviewViewStorageKey(projectId, worktreeId, sessionId),
    );
    if (!raw) {
        return null;
    }

    try {
        return normalizePersistedState(JSON.parse(raw));
    } catch {
        return null;
    }
}

export function persistReviewViewState(
    projectId: string | null,
    worktreeId: string | null | undefined,
    sessionId: string,
    state: {
        readonly anchor: PersistedReviewAnchor | null;
        readonly expandedIdentityKeys: Iterable<string>;
        readonly scrollTop: number;
    },
    options?: {
        readonly baseUpdatedAt?: number;
        readonly writerId?: string;
    },
): PersistedReviewViewState | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const existing = readPersistedReviewViewState(projectId, worktreeId, sessionId);
    const nextExpandedIdentityKeys = normalizeExpandedIdentityKeys(
        state.expandedIdentityKeys,
    );

    const nextState: PersistedReviewViewState = {
        anchor: state.anchor,
        expandedIdentityKeys: nextExpandedIdentityKeys,
        scrollTop: Math.max(0, state.scrollTop),
        updatedAt: Date.now(),
        version: REVIEW_VIEW_STATE_VERSION,
        writerId: options?.writerId,
    };

    if (existing && statesEqual(existing, nextState)) {
        return existing;
    }

    if (
        existing &&
        typeof options?.baseUpdatedAt === "number" &&
        existing.updatedAt > options.baseUpdatedAt
    ) {
        const merged: PersistedReviewViewState = {
            ...existing,
            expandedIdentityKeys: normalizeExpandedIdentityKeys([
                ...existing.expandedIdentityKeys,
                ...nextExpandedIdentityKeys,
            ]),
            updatedAt: Date.now(),
            writerId: options.writerId ?? existing.writerId,
        };
        storage.setItem(
            getReviewViewStorageKey(projectId, worktreeId, sessionId),
            JSON.stringify(merged),
        );
        return merged;
    }

    storage.setItem(
        getReviewViewStorageKey(projectId, worktreeId, sessionId),
        JSON.stringify(nextState),
    );
    return nextState;
}

export function createPersistedReviewAnchor(
    item: ReviewFileItem,
    hunkIds: readonly string[] = [],
): PersistedReviewAnchor {
    return {
        fileUpdatedAt: item.file.updatedAt,
        hunkIds: [...hunkIds],
        identityKey: item.file.identityKey,
        pathAliases: getCandidatePathAliases(item),
    };
}

export function resolvePersistedReviewAnchor(
    anchor: PersistedReviewAnchor | null,
    items: readonly ReviewFileItem[],
): PersistedReviewAnchor | null {
    if (!anchor) {
        return null;
    }

    const item = findItemByAnchor(anchor, items);
    if (!item) {
        return null;
    }

    const existingHunkIds = new Set(item.file.hunks.map((hunk) => hunk.id));
    const resolvedHunkIds = anchor.hunkIds.filter((hunkId) =>
        existingHunkIds.has(hunkId),
    );

    return createPersistedReviewAnchor(item, resolvedHunkIds);
}
