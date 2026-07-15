import type { AiHistorySessionSummary } from "@shared/ipc";
import { getGitContextKey } from "@renderer/app/git/context-key";

export interface SidebarAgentsHistoryCacheEntry {
    readonly loadedAt: number;
    readonly scopeKey: string;
    readonly sessions: readonly AiHistorySessionSummary[];
}

const sidebarAgentsHistoryCache = new Map<
    string,
    SidebarAgentsHistoryCacheEntry
>();

export function getSidebarAgentsHistoryCacheKey(
    projectId: string | null,
    worktreeId: string | null | undefined,
): string {
    return projectId
        ? getGitContextKey(projectId, worktreeId ?? null)
        : JSON.stringify(["", worktreeId ?? ""]);
}

export function readSidebarAgentsHistoryCache(
    projectId: string | null,
    worktreeId: string | null | undefined,
): SidebarAgentsHistoryCacheEntry | null {
    const scopeKey = getSidebarAgentsHistoryCacheKey(projectId, worktreeId);
    const entry = sidebarAgentsHistoryCache.get(scopeKey);
    if (!entry) {
        return null;
    }

    return copyCacheEntry(entry);
}

export function writeSidebarAgentsHistoryCache(
    projectId: string | null,
    worktreeId: string | null | undefined,
    sessions: readonly AiHistorySessionSummary[],
    loadedAt = Date.now(),
): SidebarAgentsHistoryCacheEntry {
    const scopeKey = getSidebarAgentsHistoryCacheKey(projectId, worktreeId);
    const entry: SidebarAgentsHistoryCacheEntry = {
        loadedAt,
        scopeKey,
        sessions: [...sessions],
    };
    sidebarAgentsHistoryCache.set(scopeKey, entry);
    return copyCacheEntry(entry);
}

export function updateSidebarAgentsHistoryCache(
    projectId: string | null,
    worktreeId: string | null | undefined,
    updater: (
        sessions: readonly AiHistorySessionSummary[],
    ) => readonly AiHistorySessionSummary[],
    loadedAt = Date.now(),
): SidebarAgentsHistoryCacheEntry | null {
    const current = readSidebarAgentsHistoryCache(projectId, worktreeId);
    if (!current) {
        return null;
    }

    return writeSidebarAgentsHistoryCache(
        projectId,
        worktreeId,
        updater(current.sessions),
        loadedAt,
    );
}

export function clearSidebarAgentsHistoryCache(): void {
    sidebarAgentsHistoryCache.clear();
}

function copyCacheEntry(
    entry: SidebarAgentsHistoryCacheEntry,
): SidebarAgentsHistoryCacheEntry {
    return {
        loadedAt: entry.loadedAt,
        scopeKey: entry.scopeKey,
        sessions: [...entry.sessions],
    };
}
