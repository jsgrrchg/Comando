import type {
    AiRuntimeId,
    AiRuntimeStatus,
    AiRuntimeSource,
    AiRuntimeState,
    AiSessionDomainEvent,
    AiSessionMessageEventKind,
    AiToolActivity,
    GitRepositoryInvalidation,
    ProjectSummary,
    TerminalDataEvent,
    TerminalExitEvent,
} from "../ipc";
import type {
    NativeAiMessageDeltaPayload,
    NativeAiRuntimeStatus,
    NativeAiToolActivityPayload,
} from "./ai";
import type { NativeBackendEvent } from "./protocol";
import type { NativeGitRepositoryInvalidation } from "./git";
import type { NativeProjectSummary } from "./projects";
import type {
    NativeTerminalDataEvent,
    NativeTerminalExitEvent,
} from "./terminal";

export function nativeAiRuntimeStatusToIpc(
    status: NativeAiRuntimeStatus,
): AiRuntimeStatus {
    return {
        authMethod: status.authMethod,
        authMethods: status.authMethods,
        authReady: status.authReady,
        checkedAt: status.checkedAt,
        command: status.command,
        hasCustomBinaryPath: status.hasCustomBinaryPath,
        hasGatewayConfig: status.hasGatewayConfig,
        hasGatewayUrl: status.hasGatewayUrl,
        message: status.message,
        onboardingRequired: status.onboardingRequired,
        runtimeId: status.runtimeId as AiRuntimeId,
        source: status.source as AiRuntimeSource | null,
        state: status.state as AiRuntimeState,
    };
}

export function nativeAiEventToIpc(
    event: NativeBackendEvent,
): AiSessionDomainEvent | null {
    if (event.eventName === "ai://message-delta") {
        return nativeAiMessageDeltaToIpc(
            requireRecord(event.payload) as unknown as NativeAiMessageDeltaPayload,
        );
    }

    if (event.eventName === "ai://tool-activity") {
        return nativeAiToolActivityToIpc(
            requireRecord(event.payload) as unknown as NativeAiToolActivityPayload,
        );
    }

    return null;
}

export function nativeProjectSummaryToIpc(
    project: NativeProjectSummary,
): ProjectSummary {
    return {
        canonicalRootPath: project.canonicalRootPath,
        createdAt: project.createdAt,
        id: project.id,
        lastOpenedAt: project.lastOpenedAt,
        name: project.name,
        rootPath: project.rootPath,
        updatedAt: project.updatedAt,
    };
}

export function nativeGitInvalidationToIpc(
    invalidation: NativeGitRepositoryInvalidation,
): GitRepositoryInvalidation {
    return {
        occurredAt: invalidation.occurredAt,
        projectId: invalidation.projectId,
        reason: invalidation.reason as GitRepositoryInvalidation["reason"],
        rootPath: invalidation.rootPath,
        worktreeId: invalidation.worktreeId,
    };
}

export function nativeTerminalDataEventToIpc(
    event: NativeTerminalDataEvent,
): TerminalDataEvent {
    return {
        data: event.data,
        sessionId: event.sessionId,
    };
}

export function nativeTerminalExitEventToIpc(
    event: NativeTerminalExitEvent,
): TerminalExitEvent {
    return {
        exitCode: event.exitCode,
        sessionId: event.sessionId,
        signalCode: parseSignalCode(event.signalCode),
    };
}

function nativeAiMessageDeltaToIpc(
    payload: NativeAiMessageDeltaPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        content: payload.content,
        delta: payload.delta,
        kind: "message-delta",
        messageId: payload.messageId,
        messageKind: payload.messageKind as AiSessionMessageEventKind,
    };
}

function nativeAiToolActivityToIpc(
    payload: NativeAiToolActivityPayload,
): AiSessionDomainEvent {
    const activity: AiToolActivity = {
        action: null,
        createdAt: payload.updatedAt,
        diffs: [],
        exitCode: null,
        id: payload.toolCallId,
        kind: payload.kind,
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: payload.sessionId,
        status: payload.status as AiToolActivity["status"],
        summary: payload.summary,
        terminalOutput: null,
        title: payload.title,
        updatedAt: payload.updatedAt,
    };

    return {
        ...nativeAiEventBase(payload),
        activity,
        kind: "tool-activity",
    };
}

function nativeAiEventBase(
    payload: Pick<
        NativeAiMessageDeltaPayload | NativeAiToolActivityPayload,
        "runtimeId" | "runtimeSessionId" | "sessionId" | "updatedAt"
    >,
) {
    return {
        origin: "live" as const,
        parentSessionId: null,
        runtimeId: payload.runtimeId as AiRuntimeId,
        runtimeSessionId: payload.runtimeSessionId,
        sessionId: payload.sessionId,
        updatedAt: payload.updatedAt,
    };
}

function parseSignalCode(signalCode: string | null): number | null {
    if (signalCode === null) {
        return null;
    }

    const numericSignal = Number.parseInt(signalCode, 10);
    return Number.isFinite(numericSignal) ? numericSignal : null;
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Native event payload must be an object.");
    }

    return value as Record<string, unknown>;
}
