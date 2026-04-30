const SIDEBAR_AGENTS_COLLAPSE_STATE_VERSION = 1;
const SIDEBAR_AGENTS_COLLAPSE_STATE_PREFIX =
    "comando.ai.sidebar.agents.collapsed";

interface PersistedSidebarAgentsCollapseState {
    readonly collapsedSessionIds: readonly string[];
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

function getProjectScope(projectId: string | null): string {
    return projectId?.trim() || "global";
}

function getWorktreeScope(worktreeId: string | null | undefined): string {
    return worktreeId?.trim() || "root";
}

function normalizeSessionIds(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const sessionIds = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== "string") {
            continue;
        }

        const sessionId = entry.trim();
        if (sessionId.length > 0) {
            sessionIds.add(sessionId);
        }
    }

    return [...sessionIds];
}

function normalizeCollapseState(
    raw: unknown,
): PersistedSidebarAgentsCollapseState | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const version = (raw as { version?: unknown }).version;
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;

    if (
        version !== SIDEBAR_AGENTS_COLLAPSE_STATE_VERSION ||
        typeof updatedAt !== "number" ||
        !Number.isFinite(updatedAt)
    ) {
        return null;
    }

    return {
        collapsedSessionIds: normalizeSessionIds(
            (raw as { collapsedSessionIds?: unknown }).collapsedSessionIds,
        ),
        updatedAt,
        version: SIDEBAR_AGENTS_COLLAPSE_STATE_VERSION,
    };
}

export function getSidebarAgentsCollapseStorageKey(
    projectId: string | null,
    worktreeId: string | null | undefined,
): string {
    return [
        SIDEBAR_AGENTS_COLLAPSE_STATE_PREFIX,
        getProjectScope(projectId),
        getWorktreeScope(worktreeId),
    ].join(":");
}

export function readSidebarAgentsCollapsedSessionIds(
    projectId: string | null,
    worktreeId: string | null | undefined,
): ReadonlySet<string> {
    const storage = getStorage();
    if (!storage) {
        return new Set();
    }

    const rawValue = storage.getItem(
        getSidebarAgentsCollapseStorageKey(projectId, worktreeId),
    );
    if (!rawValue) {
        return new Set();
    }

    try {
        const normalized = normalizeCollapseState(JSON.parse(rawValue));
        return new Set(normalized?.collapsedSessionIds ?? []);
    } catch {
        return new Set();
    }
}

export function persistSidebarAgentsCollapsedSessionIds(
    projectId: string | null,
    worktreeId: string | null | undefined,
    collapsedSessionIds: ReadonlySet<string>,
): PersistedSidebarAgentsCollapseState | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const normalized: PersistedSidebarAgentsCollapseState = {
        collapsedSessionIds: normalizeSessionIds([...collapsedSessionIds]),
        updatedAt: Date.now(),
        version: SIDEBAR_AGENTS_COLLAPSE_STATE_VERSION,
    };

    storage.setItem(
        getSidebarAgentsCollapseStorageKey(projectId, worktreeId),
        JSON.stringify(normalized),
    );

    return normalized;
}
