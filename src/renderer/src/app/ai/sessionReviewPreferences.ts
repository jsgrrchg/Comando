import type {
    RuntimeWorkspaceChatTab,
    RuntimeWorkspaceReviewTab,
} from "../workspace/tree";
import { normalizeAiDiffZoom } from "./sessionReviewContracts";

const SESSION_REVIEW_PREFERENCES_VERSION = 1;
const SESSION_REVIEW_PREFERENCES_PREFIX = "comando.ai.review.preferences";

type RuntimeAiSessionTab = RuntimeWorkspaceChatTab | RuntimeWorkspaceReviewTab;

export interface SessionReviewPreferences {
    readonly diffZoom: number | null;
}

interface PersistedSessionReviewPreferences extends SessionReviewPreferences {
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

export function getSessionReviewPreferencesStorageKey(
    projectId: string | null,
    worktreeId: string | null | undefined,
    sessionId: string,
): string {
    return [
        SESSION_REVIEW_PREFERENCES_PREFIX,
        getProjectScope(projectId),
        getWorktreeScope(worktreeId),
        sessionId.trim(),
    ].join(":");
}

function normalizeOptionalDiffZoom(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }

    return normalizeAiDiffZoom(value);
}

function normalizePreferences(
    raw: unknown,
): PersistedSessionReviewPreferences | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const version = (raw as { version?: unknown }).version;
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;

    if (
        version !== SESSION_REVIEW_PREFERENCES_VERSION ||
        typeof updatedAt !== "number" ||
        !Number.isFinite(updatedAt)
    ) {
        return null;
    }

    return {
        diffZoom: normalizeOptionalDiffZoom(
            (raw as { diffZoom?: unknown }).diffZoom,
        ),
        updatedAt,
        version: SESSION_REVIEW_PREFERENCES_VERSION,
    };
}

export function readSessionReviewPreferences(
    projectId: string | null,
    worktreeId: string | null | undefined,
    sessionId: string,
): SessionReviewPreferences | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const rawValue = storage.getItem(
        getSessionReviewPreferencesStorageKey(projectId, worktreeId, sessionId),
    );
    if (!rawValue) {
        return null;
    }

    try {
        const normalized = normalizePreferences(
            JSON.parse(rawValue) as unknown,
        );
        if (!normalized) {
            return null;
        }

        return {
            diffZoom: normalized.diffZoom,
        };
    } catch {
        return null;
    }
}

export function persistSessionReviewPreferences(
    projectId: string | null,
    worktreeId: string | null | undefined,
    sessionId: string,
    preferences: SessionReviewPreferences,
): PersistedSessionReviewPreferences | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const normalized: PersistedSessionReviewPreferences = {
        diffZoom:
            preferences.diffZoom == null
                ? null
                : normalizeAiDiffZoom(preferences.diffZoom),
        updatedAt: Date.now(),
        version: SESSION_REVIEW_PREFERENCES_VERSION,
    };

    storage.setItem(
        getSessionReviewPreferencesStorageKey(projectId, worktreeId, sessionId),
        JSON.stringify(normalized),
    );

    return normalized;
}

export function readSessionReviewPreferencesForTab(
    tab: RuntimeAiSessionTab,
): SessionReviewPreferences | null {
    return readSessionReviewPreferences(
        tab.projectId,
        tab.worktreeId ?? null,
        tab.sessionId,
    );
}
