import type {
    PersistedWorkspaceContext,
    WindowWorkspaceRestoreRecord,
    WorkspaceLayoutSnapshot,
    WorkspaceNavigationSnapshot,
    WorkspaceNode,
    WorkspacePaneNode,
    WorkspaceTab,
} from "./ipc";

export const WINDOW_WORKSPACE_RESTORE_SCHEMA_VERSION = 1 as const;

export interface WorkspaceRestoreNormalizationResult {
    readonly droppedContextCount: number;
    readonly repaired: boolean;
    readonly snapshot: WorkspaceNavigationSnapshot;
}

export function createEmptyWorkspaceLayoutSnapshot(): WorkspaceLayoutSnapshot {
    return {
        activePaneId: "pane-root",
        rootNode: { activeTabId: null, id: "pane-root", tabIds: [], type: "pane" },
        tabs: [],
    };
}

export function createWindowWorkspaceRestoreRecord(
    snapshot: WorkspaceNavigationSnapshot,
    revision = 0,
    updatedAt = new Date().toISOString(),
): WindowWorkspaceRestoreRecord {
    return { revision, schemaVersion: 1, snapshot, updatedAt };
}

export function normalizeWorkspaceNavigationSnapshot(
    value: unknown,
    fallbackScope: { readonly projectId?: string | null; readonly worktreeId?: string | null } = {},
): WorkspaceRestoreNormalizationResult {
    if (!isRecord(value) || (value.version !== 2 && value.version !== 3)) {
        const legacy = normalizeLayout(value);
        const projectId = fallbackScope.projectId ?? firstTabProjectId(legacy);
        if (!legacy || !projectId) {
            return { droppedContextCount: 0, repaired: true, snapshot: emptyNavigation() };
        }
        const worktreeId = normalizePrimaryWorktree(
            projectId,
            fallbackScope.worktreeId ?? firstTabWorktreeId(legacy),
        );
        const key = workspaceContextKey(projectId, worktreeId);
        return {
            droppedContextCount: 0,
            repaired: true,
            snapshot: {
                activeContextKey: key,
                contexts: [{ key, lastActivatedAt: new Date().toISOString(), projectId, workspace: legacy, worktreeId }],
                openContextKeys: [key],
                version: 3,
            },
        };
    }

    const rawContexts = Array.isArray(value.contexts) ? value.contexts : [];
    const contexts: PersistedWorkspaceContext[] = [];
    const seen = new Set<string>();
    let repaired = !Array.isArray(value.contexts) || !Array.isArray(value.openContextKeys);
    for (const rawContext of rawContexts) {
        const context = normalizeContext(rawContext);
        if (!context || seen.has(context.key)) {
            repaired = true;
            continue;
        }
        seen.add(context.key);
        contexts.push(context);
        repaired ||= !isRecord(rawContext) || rawContext.key !== context.key;
    }

    const requestedKeys = Array.isArray(value.openContextKeys)
        ? value.openContextKeys.filter((key): key is string => typeof key === "string")
        : [];
    const openContextKeys = requestedKeys.filter(
        (key, index) => seen.has(key) && requestedKeys.indexOf(key) === index,
    );
    if (value.version === 2) {
        for (const context of contexts) {
            if (!openContextKeys.includes(context.key)) openContextKeys.push(context.key);
        }
    }
    const requestedActive = typeof value.activeContextKey === "string" ? value.activeContextKey : null;
    const activeContextKey = requestedActive && openContextKeys.includes(requestedActive)
        ? requestedActive
        : (openContextKeys[0] ?? null);
    repaired ||= activeContextKey !== requestedActive || contexts.length !== rawContexts.length;
    return {
        droppedContextCount: rawContexts.length - contexts.length,
        repaired,
        snapshot: { activeContextKey, contexts, openContextKeys, version: 3 },
    };
}

export function normalizeWindowWorkspaceRestoreRecord(
    value: unknown,
    fallbackScope: { readonly projectId?: string | null; readonly worktreeId?: string | null } = {},
): WindowWorkspaceRestoreRecord {
    if (isRecord(value) && value.schemaVersion === 1 && typeof value.revision === "number") {
        return createWindowWorkspaceRestoreRecord(
            normalizeWorkspaceNavigationSnapshot(value.snapshot, fallbackScope).snapshot,
            Math.max(0, Math.trunc(value.revision)),
            typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
        );
    }
    return createWindowWorkspaceRestoreRecord(
        normalizeWorkspaceNavigationSnapshot(value, fallbackScope).snapshot,
    );
}

function normalizeContext(value: unknown): PersistedWorkspaceContext | null {
    if (!isRecord(value) || typeof value.projectId !== "string" || value.projectId.length === 0) return null;
    const rawWorktreeId = typeof value.worktreeId === "string" ? value.worktreeId : null;
    const worktreeId = normalizePrimaryWorktree(value.projectId, rawWorktreeId);
    const workspace = normalizeLayout(value.workspace);
    if (!workspace) return null;
    const scopedWorkspace: WorkspaceLayoutSnapshot = {
        ...workspace,
        tabs: workspace.tabs.map((tab) => ({
            ...tab,
            projectId: value.projectId,
            worktreeId,
        })) as readonly WorkspaceTab[],
    };
    return {
        key: workspaceContextKey(value.projectId, worktreeId),
        lastActivatedAt: typeof value.lastActivatedAt === "string" ? value.lastActivatedAt : new Date().toISOString(),
        projectId: value.projectId,
        workspace: scopedWorkspace,
        worktreeId,
    };
}

function normalizeLayout(value: unknown): WorkspaceLayoutSnapshot | null {
    if (!isRecord(value) || !Array.isArray(value.tabs)) return null;
    const tabs = value.tabs.filter(isWorkspaceTab);
    const rootNode = normalizeNode(
        value.rootNode,
        new Set(tabs.map((tab) => tab.id)),
        new Set<string>(),
        new Set<string>(),
    );
    if (!rootNode) return null;
    const paneIds = collectPaneIds(rootNode);
    return {
        activePaneId: typeof value.activePaneId === "string" && paneIds.has(value.activePaneId)
            ? value.activePaneId
            : (paneIds.values().next().value ?? "pane-root"),
        rootNode,
        tabs,
    };
}

function normalizeNode(
    value: unknown,
    tabIds: ReadonlySet<string>,
    nodeIds: Set<string>,
    ownedTabIds: Set<string>,
): WorkspaceNode | null {
    if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        nodeIds.has(value.id)
    ) return null;
    nodeIds.add(value.id);
    if (value.type === "pane") {
        const ids = Array.isArray(value.tabIds)
            ? value.tabIds.filter((id): id is string =>
                  typeof id === "string" &&
                  tabIds.has(id) &&
                  !ownedTabIds.has(id),
              )
            : [];
        const uniqueIds = [...new Set(ids)];
        for (const id of uniqueIds) ownedTabIds.add(id);
        const pinned = Array.isArray(value.pinnedTabIds)
            ? value.pinnedTabIds.filter((id): id is string => typeof id === "string" && uniqueIds.includes(id))
            : [];
        return {
            activeTabId: typeof value.activeTabId === "string" && uniqueIds.includes(value.activeTabId)
                ? value.activeTabId
                : (uniqueIds[0] ?? null),
            id: value.id,
            pinnedTabIds: [...new Set(pinned)],
            tabIds: uniqueIds,
            type: "pane",
        } satisfies WorkspacePaneNode;
    }
    if (value.type !== "split" || !Array.isArray(value.children)) return null;
    const children = value.children
        .map((child) => normalizeNode(child, tabIds, nodeIds, ownedTabIds))
        .filter((child): child is WorkspaceNode => child !== null);
    if (children.length === 0) return null;
    const sizes = Array.isArray(value.sizes) && value.sizes.length === children.length &&
        value.sizes.every((size) => typeof size === "number" && size > 0)
        ? value.sizes
        : children.map(() => 1 / children.length);
    return {
        axis: value.axis === "vertical" ? "vertical" : "horizontal",
        children,
        id: value.id,
        sizes,
        type: "split",
    };
}

function isWorkspaceTab(value: unknown): value is WorkspaceTab {
    return isRecord(value) && typeof value.id === "string" &&
        typeof value.kind === "string" && typeof value.title === "string";
}

function collectPaneIds(node: WorkspaceNode, output = new Set<string>()): Set<string> {
    if (node.type === "pane") output.add(node.id);
    else for (const child of node.children) collectPaneIds(child, output);
    return output;
}

function firstTabProjectId(layout: WorkspaceLayoutSnapshot | null): string | null {
    return layout?.tabs.find((tab) => typeof tab.projectId === "string" && tab.projectId.length > 0)?.projectId ?? null;
}

function firstTabWorktreeId(layout: WorkspaceLayoutSnapshot | null): string | null {
    return layout?.tabs.find((tab) => typeof tab.worktreeId === "string")?.worktreeId ?? null;
}

function workspaceContextKey(projectId: string, worktreeId: string | null): string {
    return `${projectId}::${worktreeId ?? "__primary__"}`;
}

function normalizePrimaryWorktree(projectId: string, worktreeId: string | null): string | null {
    return worktreeId === `${projectId}:primary` ? null : worktreeId;
}

function emptyNavigation(): WorkspaceNavigationSnapshot {
    return { activeContextKey: null, contexts: [], openContextKeys: [], version: 3 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
