import { isKnownAiRuntimeId } from "@shared/ai-runtimes";
import type {
    GitHubRepositoryRef,
    PersistedWorkspaceContext,
    WorkspaceSurfaceActionRequest,
    WorkspaceSurfaceActionContext,
    WorkspaceSurfaceActionCompletion,
    WorkspaceSurfaceActiveFileState,
    WorkspaceSurfaceAgentPresenceState,
    WorkspaceSurfaceFileRevealRequest,
} from "@shared/ipc";

const MAX_ACTION_ITEMS = 100;
const MAX_SHORT_TEXT_LENGTH = 1_000;
const MAX_PATH_OR_URL_LENGTH = 16_384;

export function isWorkspaceSurfaceActionRequest(
    input: unknown,
): input is WorkspaceSurfaceActionRequest {
    if (!isRecord(input) || !hasValidContext(input)) {
        return false;
    }

    switch (input.kind) {
        case "file":
            return (
                (input.origin === "tree" ||
                    input.origin === "git" ||
                    input.origin === "quick-create") &&
                isNonEmptyString(input.relativePath, MAX_PATH_OR_URL_LENGTH)
            );
        case "git-history":
        case "git-worktree-diff":
        case "chat-history":
        case "new-claude-terminal":
            return true;
        case "chat-session":
            return (
                isKnownAiRuntimeId(input.runtimeId) &&
                isNonEmptyString(input.sessionId, MAX_SHORT_TEXT_LENGTH) &&
                isNullableString(input.sessionProjectId, MAX_SHORT_TEXT_LENGTH) &&
                isNullableString(
                    input.sessionWorktreeId,
                    MAX_SHORT_TEXT_LENGTH,
                ) &&
                isNonEmptyString(input.title, MAX_SHORT_TEXT_LENGTH)
            );
        case "new-chat":
            return isKnownAiRuntimeId(input.runtimeId);
        case "focus-terminal":
            return isNonEmptyString(input.terminalId, MAX_SHORT_TEXT_LENGTH);
        case "github-list":
            return (
                (input.listKind === "issues" ||
                    input.listKind === "pull_requests") &&
                isGitHubRepositoryRef(input.ref)
            );
        case "github-item":
            return (
                (input.itemKind === "issue" ||
                    input.itemKind === "pull_request") &&
                isPositiveSafeInteger(input.itemNumber) &&
                isGitHubRepositoryRef(input.ref)
            );
        case "add-files-to-chat":
            return (
                typeof input.forceNewChat === "boolean" &&
                isBoundedNonEmptyArray(input.files) &&
                input.files.every(
                    (file) =>
                        isRecord(file) &&
                        isNonEmptyString(file.name, MAX_SHORT_TEXT_LENGTH) &&
                        isNonEmptyString(
                            file.relativePath,
                            MAX_PATH_OR_URL_LENGTH,
                        ),
                )
            );
        case "add-github-items-to-chat":
            return (
                typeof input.forceNewChat === "boolean" &&
                (input.itemKind === "issue" ||
                    input.itemKind === "pull_request") &&
                isGitHubRepositoryRef(input.ref) &&
                isBoundedNonEmptyArray(input.items) &&
                input.items.every(
                    (item) =>
                        isRecord(item) &&
                        isPositiveSafeInteger(item.number) &&
                        isNonEmptyString(item.title, MAX_SHORT_TEXT_LENGTH) &&
                        isNonEmptyString(item.url, MAX_PATH_OR_URL_LENGTH),
                )
            );
        default:
            return false;
    }
}

export function isWorkspaceSurfaceFileRevealRequest(
    input: unknown,
): input is WorkspaceSurfaceFileRevealRequest {
    return (
        isRecord(input) &&
        hasValidContext(input) &&
        isNonEmptyString(input.relativePath, MAX_PATH_OR_URL_LENGTH)
    );
}

export function isWorkspaceSurfaceActiveFileState(
    input: unknown,
): input is WorkspaceSurfaceActiveFileState {
    return (
        isRecord(input) &&
        hasValidContext(input) &&
        (input.relativePath === null ||
            isNonEmptyString(input.relativePath, MAX_PATH_OR_URL_LENGTH))
    );
}

export function isWorkspaceSurfaceAgentPresenceState(
    input: unknown,
): input is WorkspaceSurfaceAgentPresenceState {
    if (!isRecord(input) || !hasValidContext(input)) {
        return false;
    }
    if (
        input.activeSessionId !== null &&
        !isNonEmptyString(input.activeSessionId, MAX_SHORT_TEXT_LENGTH)
    ) {
        return false;
    }
    if (!Array.isArray(input.sessions) || input.sessions.length > MAX_ACTION_ITEMS) {
        return false;
    }

    return input.sessions.every(
        (session) =>
            isRecord(session) &&
            isNonEmptyString(session.sessionId, MAX_SHORT_TEXT_LENGTH) &&
            isKnownAiRuntimeId(session.runtimeId) &&
            isNonEmptyString(session.title, MAX_SHORT_TEXT_LENGTH) &&
            isNonEmptyString(session.createdAt, MAX_SHORT_TEXT_LENGTH) &&
            isNonEmptyString(session.updatedAt, MAX_SHORT_TEXT_LENGTH) &&
            isNullableString(session.parentSessionId, MAX_SHORT_TEXT_LENGTH) &&
            isNullableString(session.runtimeSessionId, MAX_SHORT_TEXT_LENGTH) &&
            isAiSessionStatusOrNull(session.status),
    );
}

export function isWorkspaceSurfaceActionCompletion(
    input: unknown,
): input is WorkspaceSurfaceActionCompletion {
    return (
        isRecord(input) &&
        isNonEmptyString(input.actionId, MAX_SHORT_TEXT_LENGTH) &&
        (input.status === "completed" || input.status === "failed") &&
        (input.error === undefined ||
            isNonEmptyString(input.error, MAX_SHORT_TEXT_LENGTH))
    );
}

export function doesWorkspaceSurfaceActionMatchContext(
    request: WorkspaceSurfaceActionRequest,
    context: PersistedWorkspaceContext,
): boolean {
    return doesWorkspaceSurfaceContextMatchContext(request, context);
}

export function doesWorkspaceSurfaceContextMatchContext(
    request: WorkspaceSurfaceActionContext,
    context: Pick<
        PersistedWorkspaceContext,
        "key" | "projectId" | "worktreeId"
    >,
): boolean {
    return (
        request.contextKey === context.key &&
        request.projectId === context.projectId &&
        normalizeWorktreeId(request.projectId, request.worktreeId) ===
            normalizeWorktreeId(context.projectId, context.worktreeId)
    );
}

function hasValidContext(input: Record<string, unknown>): boolean {
    return (
        isNonEmptyString(input.contextKey, MAX_SHORT_TEXT_LENGTH) &&
        isNonEmptyString(input.projectId, MAX_SHORT_TEXT_LENGTH) &&
        isNullableString(input.worktreeId, MAX_SHORT_TEXT_LENGTH)
    );
}

function isAiSessionStatusOrNull(input: unknown): boolean {
    return (
        input === null ||
        input === "idle" ||
        input === "starting" ||
        input === "streaming" ||
        input === "waiting_permission" ||
        input === "waiting_user_input" ||
        input === "error"
    );
}

function isGitHubRepositoryRef(input: unknown): input is GitHubRepositoryRef {
    return (
        isRecord(input) &&
        isNonEmptyString(input.host, MAX_SHORT_TEXT_LENGTH) &&
        isNonEmptyString(input.owner, MAX_SHORT_TEXT_LENGTH) &&
        isNonEmptyString(input.repo, MAX_SHORT_TEXT_LENGTH)
    );
}

function isBoundedNonEmptyArray(input: unknown): input is readonly unknown[] {
    return (
        Array.isArray(input) &&
        input.length > 0 &&
        input.length <= MAX_ACTION_ITEMS
    );
}

function isNonEmptyString(input: unknown, maxLength: number): input is string {
    return (
        typeof input === "string" &&
        input.length > 0 &&
        input.length <= maxLength
    );
}

function isNullableString(
    input: unknown,
    maxLength: number,
): input is string | null {
    return input === null || isNonEmptyString(input, maxLength);
}

function isPositiveSafeInteger(input: unknown): input is number {
    return (
        typeof input === "number" &&
        Number.isSafeInteger(input) &&
        input > 0
    );
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return Boolean(input) && typeof input === "object";
}

function normalizeWorktreeId(
    projectId: string,
    worktreeId: string | null,
): string {
    return worktreeId === null || worktreeId === `${projectId}:primary`
        ? "__primary__"
        : worktreeId;
}
