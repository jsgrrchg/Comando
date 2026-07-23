import type {
    AiHistorySessionSummary,
    AiMessage,
    AiSessionPatch,
    AiSessionPatchChanges,
    AiSessionSnapshot,
    AiSessionUpdate,
} from "@shared/ipc";
import { getAiSessionDisplayTitle } from "@shared/ai-session-title";
import { areGitWorktreeIdsEquivalent } from "@renderer/app/git/context-key";

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
    readonly parentSessionId?: string | null;
    readonly pinnedAt?: string | null;
    readonly projectId: string | null;
    readonly title: string;
    readonly updatedAt?: string | null;
    readonly worktreeId?: string | null;
}

export const SIDEBAR_AGENTS_HISTORY_LIMIT = 250;

export function mergeOpenSessionFallbacks(
    historySessions: readonly AiHistorySessionSummary[],
    openSessions: readonly AiHistorySessionSummary[],
): readonly AiHistorySessionSummary[] {
    const knownSessionIds = new Set(
        historySessions.map((session) => session.sessionId),
    );
    const missingOpenSessions = openSessions.filter(
        (session) => !knownSessionIds.has(session.sessionId),
    );
    if (missingOpenSessions.length === 0) {
        return historySessions;
    }

    // Open sessions are never capped by the history limit. A live tab must
    // remain reachable even before its first history record is persisted.
    return [...historySessions, ...missingOpenSessions].sort(
        compareHistorySummariesByUpdatedAtDesc,
    );
}

export function applySessionUpdateToSidebarHistory({
    deletedSessionIds,
    limit,
    scope,
    sessions,
    unknownSessionSeed,
    update,
}: {
    readonly deletedSessionIds?: ReadonlySet<string> | null;
    readonly limit: number;
    readonly scope: SidebarAgentsHistoryScope;
    readonly sessions: readonly AiHistorySessionSummary[];
    readonly unknownSessionSeed?: SidebarAgentsHistoryUnknownSessionSeed | null;
    readonly update: AiSessionUpdate;
}): SidebarAgentsHistoryUpdateResult {
    const sessionId =
        update.kind === "snapshot"
            ? update.snapshot.sessionId
            : update.patch.sessionId;
    if (deletedSessionIds?.has(sessionId)) {
        return {
            needsReload: false,
            sessions,
        };
    }

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
        !shouldShowHistorySummary(nextSummary)
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
                !shouldShowHistorySummary(seededSummary)
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
        !shouldShowHistorySummary(nextSummary)
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
    const hasSnapshotMessages = snapshot.messages.length > 0;
    return {
        createdAt: existing?.createdAt ?? snapshot.updatedAt,
        // Block-native snapshots intentionally omit paged transcript messages.
        // An empty payload must not erase history metadata already loaded.
        messageCount: hasSnapshotMessages
            ? snapshot.messages.length
            : existing?.messageCount ?? 0,
        parentSessionId: snapshot.parentSessionId ?? null,
        pinnedAt: existing?.pinnedAt ?? null,
        preview: hasSnapshotMessages
            ? deriveSessionPreview(snapshot.messages)
            : existing?.preview ?? null,
        projectId: snapshot.projectId,
        runtimeId: snapshot.runtimeId,
        runtimeSessionId: snapshot.runtimeSessionId,
        sessionId: snapshot.sessionId,
        title: getAiSessionDisplayTitle(snapshot),
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
    const hasPatchedMessages =
        nextMessages !== null && nextMessages.length > 0;

    return {
        createdAt: existing.createdAt,
        messageCount: hasPatchedMessages
            ? nextMessages.length
            : existing.messageCount,
        parentSessionId:
            changes.parentSessionId === undefined
                ? existing.parentSessionId ?? null
                : changes.parentSessionId,
        pinnedAt: existing.pinnedAt ?? null,
        preview: hasPatchedMessages
            ? deriveSessionPreview(nextMessages)
            : existing.preview,
        projectId:
            changes.projectId === undefined
                ? existing.projectId
                : changes.projectId,
        runtimeId: patch.runtimeId,
        runtimeSessionId:
            changes.runtimeSessionId === undefined
                ? existing.runtimeSessionId ?? null
                : changes.runtimeSessionId,
        sessionId: existing.sessionId,
        title:
            typeof changes.manualTitle === "string" &&
            changes.manualTitle.trim().length > 0
                ? changes.manualTitle.trim()
                : typeof changes.title === "string"
                  ? changes.title
                  : existing.title,
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
    const nextMessages =
        resolvePatchedMessages(patch.changes) ?? seed?.messages ?? [];
    const parentSessionId =
        patch.changes.parentSessionId === undefined
            ? seed?.parentSessionId ?? null
            : patch.changes.parentSessionId;
    if (nextMessages.length === 0 && !parentSessionId) {
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
        parentSessionId,
        pinnedAt: seed?.pinnedAt ?? null,
        preview:
            nextMessages.length > 0 ? deriveSessionPreview(nextMessages) : null,
        projectId,
        runtimeId: patch.runtimeId,
        runtimeSessionId: patch.changes.runtimeSessionId ?? null,
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
        (scope.projectId
            ? areGitWorktreeIdsEquivalent(
                  scope.projectId,
                  session.worktreeId ?? null,
                  scope.worktreeId,
              )
            : (session.worktreeId ?? null) === scope.worktreeId)
    );
}

function shouldShowHistorySummary(session: AiHistorySessionSummary): boolean {
    return (
        session.messageCount > 0 ||
        normalizeParentSessionId(session.parentSessionId) !== null
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
        normalizeParentSessionId(left.parentSessionId) ===
            normalizeParentSessionId(right.parentSessionId) &&
        (left.pinnedAt ?? null) === (right.pinnedAt ?? null) &&
        left.preview === right.preview &&
        left.projectId === right.projectId &&
            left.runtimeId === right.runtimeId &&
            (left.runtimeSessionId ?? null) ===
                (right.runtimeSessionId ?? null) &&
            left.sessionId === right.sessionId &&
        left.title === right.title &&
        left.updatedAt === right.updatedAt &&
        (left.worktreeId ?? null) === (right.worktreeId ?? null)
    );
}

function normalizeParentSessionId(value: string | null | undefined): string | null {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
}
