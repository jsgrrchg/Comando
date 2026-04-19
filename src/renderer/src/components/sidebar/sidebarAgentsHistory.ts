import type {
    AiHistorySessionSummary,
    AiMessage,
    AiSessionPatch,
    AiSessionPatchChanges,
    AiSessionSnapshot,
    AiSessionUpdate,
} from "@shared/ipc";

export interface SidebarAgentsHistoryScope {
    readonly projectId: string | null;
    readonly worktreeId: string | null;
}

export interface SidebarAgentsHistoryUpdateResult {
    readonly needsReload: boolean;
    readonly sessions: readonly AiHistorySessionSummary[];
}

export interface SidebarAgentsHistoryUnknownSessionSeed {
    readonly messages?: readonly AiMessage[] | null;
    readonly projectId: string | null;
    readonly title: string;
    readonly updatedAt?: string | null;
    readonly worktreeId?: string | null;
}

export const SIDEBAR_AGENTS_HISTORY_LIMIT = 200;

export function applySessionUpdateToSidebarHistory({
    limit,
    scope,
    sessions,
    unknownSessionSeed,
    update,
}: {
    readonly limit: number;
    readonly scope: SidebarAgentsHistoryScope;
    readonly sessions: readonly AiHistorySessionSummary[];
    readonly unknownSessionSeed?: SidebarAgentsHistoryUnknownSessionSeed | null;
    readonly update: AiSessionUpdate;
}): SidebarAgentsHistoryUpdateResult {
    if (update.kind === "snapshot") {
        return applySnapshotToSidebarHistory({
            limit,
            scope,
            sessions,
            snapshot: update.snapshot,
        });
    }

    return applyPatchToSidebarHistory({
        limit,
        patch: update.patch,
        scope,
        sessions,
        unknownSessionSeed,
    });
}

function applySnapshotToSidebarHistory({
    limit,
    scope,
    sessions,
    snapshot,
}: {
    readonly limit: number;
    readonly scope: SidebarAgentsHistoryScope;
    readonly sessions: readonly AiHistorySessionSummary[];
    readonly snapshot: AiSessionSnapshot;
}): SidebarAgentsHistoryUpdateResult {
    const existingIndex = sessions.findIndex(
        (session) => session.sessionId === snapshot.sessionId,
    );
    const existing =
        existingIndex === -1 ? null : (sessions[existingIndex] ?? null);
    const nextSummary = createHistorySummaryFromSnapshot(snapshot, existing);

    if (
        !isHistorySummaryVisibleInScope(nextSummary, scope) ||
        nextSummary.messageCount === 0
    ) {
        if (existingIndex === -1) {
            return {
                needsReload: false,
                sessions,
            };
        }

        return {
            needsReload: false,
            sessions: removeHistorySummaryAtIndex(sessions, existingIndex),
        };
    }

    if (existing && areHistorySummariesEqual(existing, nextSummary)) {
        return {
            needsReload: false,
            sessions,
        };
    }

    return {
        needsReload: false,
        sessions: upsertHistorySummary(sessions, nextSummary, limit),
    };
}

function applyPatchToSidebarHistory({
    limit,
    patch,
    scope,
    sessions,
    unknownSessionSeed,
}: {
    readonly limit: number;
    readonly patch: AiSessionPatch;
    readonly scope: SidebarAgentsHistoryScope;
    readonly sessions: readonly AiHistorySessionSummary[];
    readonly unknownSessionSeed?: SidebarAgentsHistoryUnknownSessionSeed | null;
}): SidebarAgentsHistoryUpdateResult {
    const existing = sessions.find(
        (session) => session.sessionId === patch.sessionId,
    );
    if (!existing) {
        const seededSummary = createHistorySummaryFromUnknownPatch(
            patch,
            unknownSessionSeed ?? null,
        );
        if (seededSummary) {
            if (
                !isHistorySummaryVisibleInScope(seededSummary, scope) ||
                seededSummary.messageCount === 0
            ) {
                return {
                    needsReload: false,
                    sessions,
                };
            }

            return {
                needsReload: false,
                sessions: upsertHistorySummary(sessions, seededSummary, limit),
            };
        }

        return {
            needsReload: true,
            sessions,
        };
    }

    const nextSummary = applyPatchToHistorySummary(existing, patch);
    if (
        !isHistorySummaryVisibleInScope(nextSummary, scope) ||
        nextSummary.messageCount === 0
    ) {
        return {
            needsReload: false,
            sessions: sessions.filter(
                (session) => session.sessionId !== patch.sessionId,
            ),
        };
    }

    if (areHistorySummariesEqual(existing, nextSummary)) {
        return {
            needsReload: false,
            sessions,
        };
    }

    return {
        needsReload: false,
        sessions: upsertHistorySummary(sessions, nextSummary, limit),
    };
}

function createHistorySummaryFromSnapshot(
    snapshot: AiSessionSnapshot,
    existing: AiHistorySessionSummary | null,
): AiHistorySessionSummary {
    return {
        createdAt: existing?.createdAt ?? snapshot.updatedAt,
        messageCount: snapshot.messages.length,
        preview: deriveSessionPreview(snapshot.messages),
        projectId: snapshot.projectId,
        runtimeId: snapshot.runtimeId,
        sessionId: snapshot.sessionId,
        title: snapshot.title,
        updatedAt: snapshot.updatedAt,
        worktreeId: snapshot.worktreeId ?? null,
    };
}

function applyPatchToHistorySummary(
    existing: AiHistorySessionSummary,
    patch: AiSessionPatch,
): AiHistorySessionSummary {
    const changes = patch.changes;
    const nextMessages = resolvePatchedMessages(changes);

    return {
        createdAt: existing.createdAt,
        messageCount:
            nextMessages?.length !== undefined
                ? nextMessages.length
                : existing.messageCount,
        preview:
            nextMessages !== null
                ? deriveSessionPreview(nextMessages)
                : existing.preview,
        projectId:
            changes.projectId === undefined
                ? existing.projectId
                : changes.projectId,
        runtimeId: patch.runtimeId,
        sessionId: existing.sessionId,
        title:
            typeof changes.title === "string" ? changes.title : existing.title,
        updatedAt:
            typeof changes.updatedAt === "string"
                ? changes.updatedAt
                : existing.updatedAt,
        worktreeId:
            changes.worktreeId === undefined
                ? existing.worktreeId ?? null
                : changes.worktreeId,
    };
}

function createHistorySummaryFromUnknownPatch(
    patch: AiSessionPatch,
    seed: SidebarAgentsHistoryUnknownSessionSeed | null,
): AiHistorySessionSummary | null {
    const nextMessages = resolvePatchedMessages(patch.changes) ?? seed?.messages ?? null;
    if (!nextMessages || nextMessages.length === 0) {
        return null;
    }

    const updatedAt =
        typeof patch.changes.updatedAt === "string"
            ? patch.changes.updatedAt
            : seed?.updatedAt ??
              nextMessages.at(-1)?.createdAt ??
              nextMessages[0]?.createdAt;
    const title =
        typeof patch.changes.title === "string"
            ? patch.changes.title
            : seed?.title ?? "";
    if (!updatedAt || title.trim().length === 0) {
        return null;
    }

    const projectId =
        patch.changes.projectId === undefined
            ? seed?.projectId ?? null
            : patch.changes.projectId;
    const worktreeId =
        patch.changes.worktreeId === undefined
            ? seed?.worktreeId ?? null
            : patch.changes.worktreeId;
    const createdAt =
        nextMessages[0]?.createdAt ??
        seed?.updatedAt ??
        updatedAt;

    return {
        createdAt,
        messageCount: nextMessages.length,
        preview: deriveSessionPreview(nextMessages),
        projectId,
        runtimeId: patch.runtimeId,
        sessionId: patch.sessionId,
        title,
        updatedAt,
        worktreeId,
    };
}

function resolvePatchedMessages(
    changes: AiSessionPatchChanges,
): readonly AiMessage[] | null {
    return Array.isArray(changes.messages) ? changes.messages : null;
}

function deriveSessionPreview(messages: readonly AiMessage[]): string | null {
    const message =
        [...messages]
            .reverse()
            .find((entry) => normalizePreviewText(entry.content).length > 0) ??
        messages.find(
            (entry) => normalizePreviewText(entry.content).length > 0,
        ) ??
        null;

    if (!message) {
        return null;
    }

    const preview = normalizePreviewText(message.content);
    return preview.length > 280 ? `${preview.slice(0, 277)}...` : preview;
}

function normalizePreviewText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function isHistorySummaryVisibleInScope(
    session: AiHistorySessionSummary,
    scope: SidebarAgentsHistoryScope,
): boolean {
    return (
        session.projectId === scope.projectId &&
        (session.worktreeId ?? null) === scope.worktreeId
    );
}

function upsertHistorySummary(
    sessions: readonly AiHistorySessionSummary[],
    nextSummary: AiHistorySessionSummary,
    limit: number,
): readonly AiHistorySessionSummary[] {
    const withoutCurrent = sessions.filter(
        (session) => session.sessionId !== nextSummary.sessionId,
    );
    const nextSessions = [...withoutCurrent, nextSummary].sort(
        compareHistorySummariesByUpdatedAtDesc,
    );
    const cappedSessions =
        nextSessions.length > limit ? nextSessions.slice(0, limit) : nextSessions;

    if (
        cappedSessions.length === sessions.length &&
        cappedSessions.every((session, index) => session === sessions[index])
    ) {
        return sessions;
    }

    return cappedSessions;
}

function removeHistorySummaryAtIndex(
    sessions: readonly AiHistorySessionSummary[],
    index: number,
): readonly AiHistorySessionSummary[] {
    return [...sessions.slice(0, index), ...sessions.slice(index + 1)];
}

function compareHistorySummariesByUpdatedAtDesc(
    left: AiHistorySessionSummary,
    right: AiHistorySessionSummary,
): number {
    return right.updatedAt.localeCompare(left.updatedAt);
}

function areHistorySummariesEqual(
    left: AiHistorySessionSummary,
    right: AiHistorySessionSummary,
): boolean {
    return (
        left.createdAt === right.createdAt &&
        left.messageCount === right.messageCount &&
        left.preview === right.preview &&
        left.projectId === right.projectId &&
        left.runtimeId === right.runtimeId &&
        left.sessionId === right.sessionId &&
        left.title === right.title &&
        left.updatedAt === right.updatedAt &&
        (left.worktreeId ?? null) === (right.worktreeId ?? null)
    );
}
