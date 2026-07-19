const CHAT_VIEW_STATE_VERSION = 2;
const CHAT_VIEW_STATE_PREFIX = "comando.ai.chat.view";

export interface PersistedChatViewState {
    readonly anchor: {
        readonly alignment: "center" | "end" | "start";
        readonly entryId: string;
        readonly offsetWithinEntry: number;
    } | null;
    readonly isNearBottom: boolean;
    readonly scrollTop: number;
    readonly updatedAt: number;
    readonly version: number;
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

function normalizePersistedState(raw: unknown): PersistedChatViewState | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const version = (raw as { version?: unknown }).version;
    const isNearBottom = (raw as { isNearBottom?: unknown }).isNearBottom;
    const scrollTop = (raw as { scrollTop?: unknown }).scrollTop;
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;
    const anchor = (raw as { anchor?: unknown }).anchor;

    if (
        version !== CHAT_VIEW_STATE_VERSION ||
        typeof isNearBottom !== "boolean" ||
        typeof scrollTop !== "number" ||
        !Number.isFinite(scrollTop) ||
        typeof updatedAt !== "number" ||
        !Number.isFinite(updatedAt)
    ) {
        return null;
    }

    const normalizedAnchor =
        anchor &&
        typeof anchor === "object" &&
        typeof (anchor as { entryId?: unknown }).entryId === "string" &&
        typeof (anchor as { offsetWithinEntry?: unknown }).offsetWithinEntry ===
            "number" &&
        ["start", "center", "end"].includes(
            (anchor as { alignment?: unknown }).alignment as string,
        )
            ? {
                  alignment: (anchor as {
                      alignment: "center" | "end" | "start";
                  }).alignment,
                  entryId: (anchor as { entryId: string }).entryId,
                  offsetWithinEntry: Math.max(
                      0,
                      (anchor as { offsetWithinEntry: number })
                          .offsetWithinEntry,
                  ),
              }
            : null;

    return {
        anchor: normalizedAnchor,
        isNearBottom,
        scrollTop: Math.max(0, scrollTop),
        updatedAt,
        version: CHAT_VIEW_STATE_VERSION,
    };
}

function statesEqual(
    left: PersistedChatViewState,
    right: PersistedChatViewState,
): boolean {
    return (
        left.version === right.version &&
        left.isNearBottom === right.isNearBottom &&
        left.scrollTop === right.scrollTop &&
        left.anchor?.entryId === right.anchor?.entryId &&
        left.anchor?.offsetWithinEntry === right.anchor?.offsetWithinEntry &&
        left.anchor?.alignment === right.anchor?.alignment
    );
}

export function getChatViewStorageKey(
    projectId: string | null,
    worktreeId: string | null | undefined,
    sessionId: string,
): string {
    return `${CHAT_VIEW_STATE_PREFIX}:${getProjectScope(projectId)}:${getWorktreeScope(worktreeId)}:session:${sessionId}`;
}

export function readPersistedChatViewState(
    projectId: string | null,
    worktreeId: string | null | undefined,
    sessionId: string,
): PersistedChatViewState | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const raw = storage.getItem(
        getChatViewStorageKey(projectId, worktreeId, sessionId),
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

export function persistChatViewState(
    projectId: string | null,
    worktreeId: string | null | undefined,
    sessionId: string,
    state: {
        readonly isNearBottom: boolean;
        readonly scrollTop: number;
        readonly anchor?: PersistedChatViewState["anchor"];
    },
): PersistedChatViewState | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const nextState: PersistedChatViewState = {
        anchor: state.anchor ?? null,
        isNearBottom: state.isNearBottom,
        scrollTop: Math.max(0, state.scrollTop),
        updatedAt: Date.now(),
        version: CHAT_VIEW_STATE_VERSION,
    };
    const existing = readPersistedChatViewState(projectId, worktreeId, sessionId);

    if (existing && statesEqual(existing, nextState)) {
        return existing;
    }

    storage.setItem(
        getChatViewStorageKey(projectId, worktreeId, sessionId),
        JSON.stringify(nextState),
    );
    return nextState;
}
