export const SIDEBAR_AGENTS_FOLDER_STATE_VERSION = 1;
export const SIDEBAR_AGENT_FOLDER_NAME_MAX_LENGTH = 80;

const SIDEBAR_AGENTS_FOLDER_STATE_PREFIX =
    "comando.ai.sidebar.agents.folders";

export interface SidebarAgentFolder {
    readonly createdAt: number;
    readonly id: string;
    readonly name: string;
}

export interface SidebarAgentsFolderState {
    readonly collapsedFolderIds: readonly string[];
    readonly folderOrder: readonly string[];
    readonly folders: Readonly<Record<string, SidebarAgentFolder>>;
    readonly sessionFolderIds: Readonly<Record<string, string>>;
}

interface PersistedSidebarAgentsFolderState extends SidebarAgentsFolderState {
    readonly updatedAt: number;
    readonly version: number;
}

export interface CreateSidebarAgentsFolderResult {
    readonly folderId: string | null;
    readonly state: SidebarAgentsFolderState;
}

export interface CreateSidebarAgentsFolderOptions {
    readonly createdAt?: number;
    readonly folderId?: string;
}

export function createEmptySidebarAgentsFolderState(): SidebarAgentsFolderState {
    return {
        collapsedFolderIds: [],
        folderOrder: [],
        folders: {},
        sessionFolderIds: {},
    };
}

export function normalizeSidebarAgentFolderName(name: string): string {
    return name
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, SIDEBAR_AGENT_FOLDER_NAME_MAX_LENGTH);
}

export function getSidebarAgentsFolderStorageKey(
    projectId: string | null,
    worktreeId: string | null | undefined,
): string {
    return [
        SIDEBAR_AGENTS_FOLDER_STATE_PREFIX,
        normalizeScopeSegment(projectId, "global"),
        normalizeScopeSegment(worktreeId, "root"),
    ].join(":");
}

export function readSidebarAgentsFolderState(
    projectId: string | null,
    worktreeId: string | null | undefined,
): SidebarAgentsFolderState {
    const storage = getStorage();
    if (!storage) {
        return createEmptySidebarAgentsFolderState();
    }

    let rawValue: string | null;
    try {
        rawValue = storage.getItem(
            getSidebarAgentsFolderStorageKey(projectId, worktreeId),
        );
    } catch {
        return createEmptySidebarAgentsFolderState();
    }

    if (!rawValue) {
        return createEmptySidebarAgentsFolderState();
    }

    try {
        const parsed: unknown = JSON.parse(rawValue);
        if (!isRecord(parsed)) {
            return createEmptySidebarAgentsFolderState();
        }
        if (
            parsed.version !== SIDEBAR_AGENTS_FOLDER_STATE_VERSION ||
            typeof parsed.updatedAt !== "number" ||
            !Number.isFinite(parsed.updatedAt)
        ) {
            return createEmptySidebarAgentsFolderState();
        }

        return normalizeSidebarAgentsFolderState(parsed);
    } catch {
        return createEmptySidebarAgentsFolderState();
    }
}

export function persistSidebarAgentsFolderState(
    projectId: string | null,
    worktreeId: string | null | undefined,
    state: SidebarAgentsFolderState,
): SidebarAgentsFolderState {
    const normalized = normalizeSidebarAgentsFolderState(state);
    const storage = getStorage();
    if (!storage) {
        return normalized;
    }

    const persisted: PersistedSidebarAgentsFolderState = {
        ...normalized,
        updatedAt: Date.now(),
        version: SIDEBAR_AGENTS_FOLDER_STATE_VERSION,
    };

    try {
        storage.setItem(
            getSidebarAgentsFolderStorageKey(projectId, worktreeId),
            JSON.stringify(persisted),
        );
    } catch {
        // Folder organization is a local preference and must not block the UI.
    }

    return normalized;
}

export function createSidebarAgentsFolder(
    state: SidebarAgentsFolderState,
    rawName: string,
    options: CreateSidebarAgentsFolderOptions = {},
): CreateSidebarAgentsFolderResult {
    const name = normalizeSidebarAgentFolderName(rawName);
    if (!name) {
        return { folderId: null, state };
    }

    const folderId = normalizeIdentifier(options.folderId ?? createFolderId());
    if (!folderId || state.folders[folderId]) {
        return { folderId: null, state };
    }

    const createdAt =
        typeof options.createdAt === "number" &&
        Number.isFinite(options.createdAt)
            ? options.createdAt
            : Date.now();
    const folder: SidebarAgentFolder = {
        createdAt,
        id: folderId,
        name,
    };

    return {
        folderId,
        state: {
            ...state,
            folderOrder: [
                ...getOrderedSidebarAgentFolderIds(
                    state.folders,
                    state.folderOrder,
                ),
                folderId,
            ],
            folders: {
                ...state.folders,
                [folderId]: folder,
            },
        },
    };
}

export function renameSidebarAgentsFolder(
    state: SidebarAgentsFolderState,
    folderId: string,
    rawName: string,
): SidebarAgentsFolderState {
    const normalizedFolderId = normalizeIdentifier(folderId);
    const folder = normalizedFolderId
        ? state.folders[normalizedFolderId]
        : undefined;
    const name = normalizeSidebarAgentFolderName(rawName);
    if (!normalizedFolderId || !folder || !name || folder.name === name) {
        return state;
    }

    return {
        ...state,
        folders: {
            ...state.folders,
            [normalizedFolderId]: {
                ...folder,
                name,
            },
        },
    };
}

export function deleteSidebarAgentsFolder(
    state: SidebarAgentsFolderState,
    folderId: string,
): SidebarAgentsFolderState {
    const normalizedFolderId = normalizeIdentifier(folderId);
    if (!normalizedFolderId || !state.folders[normalizedFolderId]) {
        return state;
    }

    const folders = Object.fromEntries(
        Object.entries(state.folders).filter(
            ([candidateId]) => candidateId !== normalizedFolderId,
        ),
    );
    const sessionFolderIds = Object.fromEntries(
        Object.entries(state.sessionFolderIds).filter(
            ([, assignedFolderId]) =>
                assignedFolderId !== normalizedFolderId,
        ),
    );

    return {
        collapsedFolderIds: state.collapsedFolderIds.filter(
            (candidateId) => candidateId !== normalizedFolderId,
        ),
        folderOrder: getOrderedSidebarAgentFolderIds(
            folders,
            state.folderOrder.filter(
                (candidateId) => candidateId !== normalizedFolderId,
            ),
        ),
        folders,
        sessionFolderIds,
    };
}

export function reorderSidebarAgentsFolder(
    state: SidebarAgentsFolderState,
    folderId: string,
    destinationIndex: number,
): SidebarAgentsFolderState {
    const normalizedFolderId = normalizeIdentifier(folderId);
    if (
        !normalizedFolderId ||
        !state.folders[normalizedFolderId] ||
        !Number.isFinite(destinationIndex)
    ) {
        return state;
    }

    const currentOrder = getOrderedSidebarAgentFolderIds(
        state.folders,
        state.folderOrder,
    ).filter((candidateId) => candidateId !== normalizedFolderId);
    const nextIndex = Math.max(
        0,
        Math.min(Math.trunc(destinationIndex), currentOrder.length),
    );
    const folderOrder = [...currentOrder];
    folderOrder.splice(nextIndex, 0, normalizedFolderId);

    if (arraysEqual(folderOrder, state.folderOrder)) {
        return state;
    }

    return {
        ...state,
        folderOrder,
    };
}

export function moveSidebarAgentSessionToFolder(
    state: SidebarAgentsFolderState,
    sessionId: string,
    folderId: string | null,
): SidebarAgentsFolderState {
    const normalizedSessionId = normalizeIdentifier(sessionId);
    const normalizedFolderId = normalizeIdentifier(folderId);
    if (!normalizedSessionId) {
        return state;
    }
    if (normalizedFolderId && !state.folders[normalizedFolderId]) {
        return state;
    }

    const hasAssignment = Object.prototype.hasOwnProperty.call(
        state.sessionFolderIds,
        normalizedSessionId,
    );
    if (
        (normalizedFolderId &&
            state.sessionFolderIds[normalizedSessionId] ===
                normalizedFolderId) ||
        (!normalizedFolderId && !hasAssignment)
    ) {
        return state;
    }

    const sessionFolderIds = { ...state.sessionFolderIds };
    if (normalizedFolderId) {
        sessionFolderIds[normalizedSessionId] = normalizedFolderId;
    } else {
        delete sessionFolderIds[normalizedSessionId];
    }

    return {
        ...state,
        sessionFolderIds,
    };
}

export function removeSidebarAgentSessionFolderAssignment(
    state: SidebarAgentsFolderState,
    sessionId: string,
): SidebarAgentsFolderState {
    return moveSidebarAgentSessionToFolder(state, sessionId, null);
}

export function toggleSidebarAgentsFolderCollapsed(
    state: SidebarAgentsFolderState,
    folderId: string,
): SidebarAgentsFolderState {
    const normalizedFolderId = normalizeIdentifier(folderId);
    if (!normalizedFolderId || !state.folders[normalizedFolderId]) {
        return state;
    }

    const collapsedFolderIds = new Set(state.collapsedFolderIds);
    if (collapsedFolderIds.has(normalizedFolderId)) {
        collapsedFolderIds.delete(normalizedFolderId);
    } else {
        collapsedFolderIds.add(normalizedFolderId);
    }

    return {
        ...state,
        collapsedFolderIds: [...collapsedFolderIds],
    };
}

export function getOrderedSidebarAgentFolderIds(
    folders: Readonly<Record<string, SidebarAgentFolder>>,
    requestedOrder: readonly string[],
): readonly string[] {
    const knownRequestedIds = uniqueIdentifiers(requestedOrder).filter(
        (folderId) => Boolean(folders[folderId]),
    );
    const requestedIdSet = new Set(knownRequestedIds);
    const remainingIds = Object.values(folders)
        .sort(
            (left, right) =>
                left.createdAt - right.createdAt ||
                left.id.localeCompare(right.id),
        )
        .map((folder) => folder.id)
        .filter((folderId) => !requestedIdSet.has(folderId));

    return [...knownRequestedIds, ...remainingIds];
}

function normalizeSidebarAgentsFolderState(
    raw: unknown,
): SidebarAgentsFolderState {
    if (!isRecord(raw)) {
        return createEmptySidebarAgentsFolderState();
    }

    const folderEntries: Array<[string, SidebarAgentFolder]> = [];
    if (isRecord(raw.folders)) {
        for (const [rawFolderId, candidate] of Object.entries(raw.folders)) {
            const folderId = normalizeIdentifier(rawFolderId);
            if (!folderId || !isRecord(candidate)) {
                continue;
            }
            const name =
                typeof candidate.name === "string"
                    ? normalizeSidebarAgentFolderName(candidate.name)
                    : "";
            if (!name || folderEntries.some(([id]) => id === folderId)) {
                continue;
            }

            folderEntries.push([
                folderId,
                {
                    createdAt:
                        typeof candidate.createdAt === "number" &&
                        Number.isFinite(candidate.createdAt)
                            ? candidate.createdAt
                            : 0,
                    id: folderId,
                    name,
                },
            ]);
        }
    }
    const folders = Object.fromEntries(folderEntries);

    const requestedOrder = Array.isArray(raw.folderOrder)
        ? raw.folderOrder.filter(
              (folderId): folderId is string => typeof folderId === "string",
          )
        : [];
    const folderOrder = getOrderedSidebarAgentFolderIds(
        folders,
        requestedOrder,
    );

    const assignmentEntries: Array<[string, string]> = [];
    if (isRecord(raw.sessionFolderIds)) {
        for (const [rawSessionId, rawFolderId] of Object.entries(
            raw.sessionFolderIds,
        )) {
            const sessionId = normalizeIdentifier(rawSessionId);
            const folderId = normalizeIdentifier(rawFolderId);
            if (sessionId && folderId && folders[folderId]) {
                assignmentEntries.push([sessionId, folderId]);
            }
        }
    }

    const collapsedFolderIds = Array.isArray(raw.collapsedFolderIds)
        ? uniqueIdentifiers(
              raw.collapsedFolderIds.filter(
                  (folderId): folderId is string =>
                      typeof folderId === "string",
              ),
          ).filter((folderId) => Boolean(folders[folderId]))
        : [];

    return {
        collapsedFolderIds,
        folderOrder,
        folders,
        sessionFolderIds: Object.fromEntries(assignmentEntries),
    };
}

function normalizeIdentifier(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function uniqueIdentifiers(values: readonly string[]): readonly string[] {
    const identifiers = new Set<string>();
    for (const value of values) {
        const identifier = normalizeIdentifier(value);
        if (identifier) {
            identifiers.add(identifier);
        }
    }
    return [...identifiers];
}

function normalizeScopeSegment(
    value: string | null | undefined,
    fallback: string,
): string {
    const normalized = normalizeIdentifier(value);
    return normalized ? encodeURIComponent(normalized) : fallback;
}

function createFolderId(): string {
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }
    return `folder-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2)}`;
}

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arraysEqual(
    left: readonly string[],
    right: readonly string[],
): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}
