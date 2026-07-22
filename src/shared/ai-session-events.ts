import type {
    AiMessage,
    AiSessionDomainEvent,
    AiSessionDomainEventBase,
    AiSessionEventOrigin,
    AiSessionMessageEventKind,
    AiSessionSnapshot,
    AiToolActivity,
} from "./ipc";

export interface BuildAiSessionDomainEventsOptions {
    readonly includeInitialTranscript?: boolean;
    readonly origin: AiSessionEventOrigin;
}

export function normalizeAiSessionStatusTitle(
    title: string | null | undefined,
): string | null {
    if (typeof title !== "string") {
        return null;
    }
    const trimmed = title.trim();
    return trimmed.length > 0 ? trimmed : null;
}

type EventBase = Omit<AiSessionDomainEventBase, "kind">;

export function buildAiSessionDomainEvents(
    previousSnapshot: AiSessionSnapshot | null,
    nextSnapshot: AiSessionSnapshot,
    options: BuildAiSessionDomainEventsOptions,
): readonly AiSessionDomainEvent[] {
    const base = createEventBase(nextSnapshot, options.origin);
    const events: AiSessionDomainEvent[] = [];

    appendSessionInfoEvents(events, base, previousSnapshot, nextSnapshot);
    appendStatusEvents(events, base, previousSnapshot, nextSnapshot);
    appendTranscriptEvents(events, base, previousSnapshot, nextSnapshot, {
        includeInitialTranscript: options.includeInitialTranscript ?? false,
    });
    appendToolActivityEvents(events, base, previousSnapshot, nextSnapshot, {
        includeInitialTranscript: options.includeInitialTranscript ?? false,
    });
    appendRuntimeStateEvents(events, base, previousSnapshot, nextSnapshot);

    return events;
}

function createEventBase(
    snapshot: AiSessionSnapshot,
    origin: AiSessionEventOrigin,
): EventBase {
    return {
        origin,
        parentSessionId: snapshot.parentSessionId ?? null,
        runtimeId: snapshot.runtimeId,
        runtimeSessionId: snapshot.runtimeSessionId,
        sessionId: snapshot.sessionId,
        updatedAt: snapshot.updatedAt,
    };
}

function appendSessionInfoEvents(
    events: AiSessionDomainEvent[],
    base: EventBase,
    previousSnapshot: AiSessionSnapshot | null,
    nextSnapshot: AiSessionSnapshot,
): void {
    if (
        !previousSnapshot ||
        previousSnapshot.title !== nextSnapshot.title ||
        previousSnapshot.projectId !== nextSnapshot.projectId ||
        (previousSnapshot.worktreeId ?? null) !==
            (nextSnapshot.worktreeId ?? null) ||
        (previousSnapshot.parentSessionId ?? null) !==
            (nextSnapshot.parentSessionId ?? null) ||
        previousSnapshot.runtimeSessionId !== nextSnapshot.runtimeSessionId
    ) {
        events.push({
            ...base,
            kind: "session-info",
            projectId: nextSnapshot.projectId,
            title: nextSnapshot.title,
            worktreeId: nextSnapshot.worktreeId ?? null,
        });
    }

    if (
        nextSnapshot.parentSessionId &&
        (!previousSnapshot ||
            (previousSnapshot.parentSessionId ?? null) !==
                nextSnapshot.parentSessionId)
    ) {
        events.push({
            ...base,
            childRuntimeSessionId: nextSnapshot.runtimeSessionId ?? null,
            childSessionId: nextSnapshot.sessionId,
            kind: "subagent-created",
            modelId: nextSnapshot.modelId,
            parentSessionId: nextSnapshot.parentSessionId,
            reasoningEffort: nextSnapshot.reasoningEffort ?? null,
            title: nextSnapshot.title,
        });
    }
}

function appendStatusEvents(
    events: AiSessionDomainEvent[],
    base: EventBase,
    previousSnapshot: AiSessionSnapshot | null,
    nextSnapshot: AiSessionSnapshot,
): void {
    if (
        !previousSnapshot ||
        previousSnapshot.status !== nextSnapshot.status ||
        (previousSnapshot.activeTurnStartedAt ?? null) !==
            (nextSnapshot.activeTurnStartedAt ?? null) ||
        previousSnapshot.lastError !== nextSnapshot.lastError
    ) {
        events.push({
            ...base,
            activeTurnStartedAt: nextSnapshot.activeTurnStartedAt ?? null,
            kind: "status",
            lastError: nextSnapshot.lastError,
            status: nextSnapshot.status,
        });
    }
}

function appendTranscriptEvents(
    events: AiSessionDomainEvent[],
    base: EventBase,
    previousSnapshot: AiSessionSnapshot | null,
    nextSnapshot: AiSessionSnapshot,
    options: { readonly includeInitialTranscript: boolean },
): void {
    if (!previousSnapshot && !options.includeInitialTranscript) {
        return;
    }

    const previousMessages = new Map(
        (previousSnapshot?.messages ?? []).map((message) => [
            message.id,
            message,
        ]),
    );

    for (const nextMessage of nextSnapshot.messages) {
        const previousMessage = previousMessages.get(nextMessage.id) ?? null;
        appendMessageEvents(events, base, previousMessage, nextMessage);
    }
}

function appendMessageEvents(
    events: AiSessionDomainEvent[],
    base: EventBase,
    previousMessage: AiMessage | null,
    nextMessage: AiMessage,
): void {
    if (nextMessage.kind === "image") {
        if (!previousMessage || previousMessage !== nextMessage) {
            events.push({
                ...base,
                kind: "image-generation",
                message: nextMessage,
            });
        }
        return;
    }

    if (nextMessage.kind === "thinking") {
        appendThinkingEvents(events, base, previousMessage, nextMessage);
        return;
    }

    if (!isMessageEventKind(nextMessage.kind)) {
        return;
    }

    if (!previousMessage) {
        events.push({
            ...base,
            kind: "message-started",
            message: {
                ...nextMessage,
                content: "",
            },
            messageKind: nextMessage.kind,
        });
        if (nextMessage.content.length > 0) {
            events.push({
                ...base,
                content: nextMessage.content,
                delta: nextMessage.content,
                kind: "message-delta",
                messageId: nextMessage.id,
                messageKind: nextMessage.kind,
            });
        }
        if (nextMessage.status === "completed") {
            events.push({
                ...base,
                kind: "message-completed",
                messageId: nextMessage.id,
                messageKind: nextMessage.kind,
            });
        }
        return;
    }

    if (previousMessage.kind !== nextMessage.kind) {
        return;
    }

    const delta = getMessageDelta(previousMessage.content, nextMessage.content);
    if (delta.length > 0) {
        events.push({
            ...base,
            content: nextMessage.content,
            delta,
            kind: "message-delta",
            messageId: nextMessage.id,
            messageKind: nextMessage.kind,
        });
    }

    if (
        previousMessage.status !== "completed" &&
        nextMessage.status === "completed"
    ) {
        events.push({
            ...base,
            kind: "message-completed",
            messageId: nextMessage.id,
            messageKind: nextMessage.kind,
        });
    }
}

function appendThinkingEvents(
    events: AiSessionDomainEvent[],
    base: EventBase,
    previousMessage: AiMessage | null,
    nextMessage: AiMessage,
): void {
    if (!previousMessage) {
        events.push({
            ...base,
            kind: "thinking-started",
            message: {
                ...nextMessage,
                content: "",
            },
        });
        if (nextMessage.content.length > 0) {
            events.push({
                ...base,
                content: nextMessage.content,
                delta: nextMessage.content,
                kind: "thinking-delta",
                messageId: nextMessage.id,
            });
        }
        if (nextMessage.status === "completed") {
            events.push({
                ...base,
                kind: "thinking-completed",
                messageId: nextMessage.id,
            });
        }
        return;
    }

    if (previousMessage.kind !== "thinking") {
        return;
    }

    const delta = getMessageDelta(previousMessage.content, nextMessage.content);
    if (delta.length > 0) {
        events.push({
            ...base,
            content: nextMessage.content,
            delta,
            kind: "thinking-delta",
            messageId: nextMessage.id,
        });
    }

    if (
        previousMessage.status !== "completed" &&
        nextMessage.status === "completed"
    ) {
        events.push({
            ...base,
            kind: "thinking-completed",
            messageId: nextMessage.id,
        });
    }
}

function appendToolActivityEvents(
    events: AiSessionDomainEvent[],
    base: EventBase,
    previousSnapshot: AiSessionSnapshot | null,
    nextSnapshot: AiSessionSnapshot,
    options: { readonly includeInitialTranscript: boolean },
): void {
    if (!previousSnapshot && !options.includeInitialTranscript) {
        return;
    }

    const previousActivities = new Map(
        (previousSnapshot?.toolActivity ?? []).map((activity) => [
            activity.id,
            activity,
        ]),
    );

    for (const activity of nextSnapshot.toolActivity) {
        const previousActivity = previousActivities.get(activity.id) ?? null;
        if (!previousActivity || previousActivity !== activity) {
            events.push({
                ...base,
                activity,
                kind: "tool-activity",
            });
        }

        appendSubagentBreadcrumbEvent(
            events,
            base,
            previousActivity,
            activity,
        );
    }
}

function appendSubagentBreadcrumbEvent(
    events: AiSessionDomainEvent[],
    base: EventBase,
    previousActivity: AiToolActivity | null,
    nextActivity: AiToolActivity,
): void {
    const action = nextActivity.action;
    if (action?.kind !== "open_session") {
        return;
    }

    if (
        previousActivity?.action?.kind === "open_session" &&
        previousActivity.action.sessionId === action.sessionId
    ) {
        return;
    }

    events.push({
        ...base,
        childSessionId: action.sessionId,
        kind: "subagent-breadcrumb",
        toolCallId: nextActivity.id,
    });
}

function appendRuntimeStateEvents(
    events: AiSessionDomainEvent[],
    base: EventBase,
    previousSnapshot: AiSessionSnapshot | null,
    nextSnapshot: AiSessionSnapshot,
): void {
    if (!previousSnapshot) {
        return;
    }

    if (previousSnapshot.plan !== nextSnapshot.plan) {
        events.push({
            ...base,
            kind: "plan",
            plan: nextSnapshot.plan,
        });
    }

    if (previousSnapshot.pendingPermission !== nextSnapshot.pendingPermission) {
        events.push({
            ...base,
            kind: "permission-request",
            request: nextSnapshot.pendingPermission,
        });
    }

    if (previousSnapshot.pendingUserInput !== nextSnapshot.pendingUserInput) {
        events.push({
            ...base,
            kind: "user-input-request",
            request: nextSnapshot.pendingUserInput,
        });
    }

    if (previousSnapshot.tokenUsage !== nextSnapshot.tokenUsage) {
        events.push({
            ...base,
            kind: "token-usage",
            tokenUsage: nextSnapshot.tokenUsage,
        });
    }
}

function getMessageDelta(previousContent: string, nextContent: string): string {
    if (previousContent === nextContent) {
        return "";
    }

    if (nextContent.startsWith(previousContent)) {
        return nextContent.slice(previousContent.length);
    }

    return nextContent;
}

function isMessageEventKind(
    kind: AiMessage["kind"],
): kind is AiSessionMessageEventKind {
    return kind === "assistant" || kind === "user";
}
