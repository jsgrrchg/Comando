import type {
    AiRuntimeId,
    AiRuntimeStatus,
    AiRuntimeSource,
    AiRuntimeState,
    AiSessionStatus,
    AiSessionDomainEvent,
    AiSessionMessageEventKind,
    AiPermissionOption,
    AiToolActivity,
    AiUserInputQuestion,
    GitRepositoryInvalidation,
    ProjectEntryMutationResult,
    ProjectFileDocument,
    ProjectSummary,
    ProjectTreeInvalidation,
    ProjectTreeNode,
    TerminalDataEvent,
    TerminalExitEvent,
} from "../ipc";
import { resolveEditorLanguage } from "../editor-language";
import type {
    NativeAiErrorPayload,
    NativeAiEventBase,
    NativeAiMessageCompletedPayload,
    NativeAiMessageDeltaPayload,
    NativeAiMessageStartedPayload,
    NativeAiPermissionRequestPayload,
    NativeAiPlanUpdatedPayload,
    NativeAiRuntimeStatus,
    NativeAiSessionCreatedPayload,
    NativeAiSessionUpdatedPayload,
    NativeAiStatusEventPayload,
    NativeAiThinkingCompletedPayload,
    NativeAiThinkingDeltaPayload,
    NativeAiThinkingStartedPayload,
    NativeAiTokenUsagePayload,
    NativeAiToolActivityPayload,
    NativeAiUserInputRequestPayload,
} from "./ai";
import type {
    NativeFsEntryKind,
    NativeFsEntryMutationResult,
    NativeFsReadFileResult,
    NativeProjectTreeInvalidation,
} from "./fs";
import type { NativeBackendEvent } from "./protocol";
import type { NativeGitRepositoryInvalidation } from "./git";
import type { NativeProjectSummary, NativeProjectTreeEntry } from "./projects";
import type { NativeIndexedProjectEntry } from "./search";
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
    if (event.eventName === "ai://session-created") {
        return nativeAiSessionCreatedToIpc(
            requireRecord(event.payload) as unknown as NativeAiSessionCreatedPayload,
        );
    }

    if (event.eventName === "ai://session-updated") {
        return nativeAiSessionUpdatedToIpc(
            requireRecord(event.payload) as unknown as NativeAiSessionUpdatedPayload,
        );
    }

    if (event.eventName === "ai://message-started") {
        return nativeAiMessageStartedToIpc(
            requireRecord(event.payload) as unknown as NativeAiMessageStartedPayload,
        );
    }

    if (event.eventName === "ai://message-delta") {
        return nativeAiMessageDeltaToIpc(
            requireRecord(event.payload) as unknown as NativeAiMessageDeltaPayload,
        );
    }

    if (event.eventName === "ai://message-completed") {
        return nativeAiMessageCompletedToIpc(
            requireRecord(event.payload) as unknown as NativeAiMessageCompletedPayload,
        );
    }

    if (event.eventName === "ai://thinking-started") {
        return nativeAiThinkingStartedToIpc(
            requireRecord(event.payload) as unknown as NativeAiThinkingStartedPayload,
        );
    }

    if (event.eventName === "ai://thinking-delta") {
        return nativeAiThinkingDeltaToIpc(
            requireRecord(event.payload) as unknown as NativeAiThinkingDeltaPayload,
        );
    }

    if (event.eventName === "ai://thinking-completed") {
        return nativeAiThinkingCompletedToIpc(
            requireRecord(event.payload) as unknown as NativeAiThinkingCompletedPayload,
        );
    }

    if (event.eventName === "ai://tool-activity") {
        return nativeAiToolActivityToIpc(
            requireRecord(event.payload) as unknown as NativeAiToolActivityPayload,
        );
    }

    if (event.eventName === "ai://status-event") {
        return nativeAiStatusEventToIpc(
            requireRecord(event.payload) as unknown as NativeAiStatusEventPayload,
        );
    }

    if (event.eventName === "ai://plan-updated") {
        return nativeAiPlanUpdatedToIpc(
            requireRecord(event.payload) as unknown as NativeAiPlanUpdatedPayload,
        );
    }

    if (event.eventName === "ai://permission-request") {
        return nativeAiPermissionRequestToIpc(
            requireRecord(event.payload) as unknown as NativeAiPermissionRequestPayload,
        );
    }

    if (event.eventName === "ai://user-input-request") {
        return nativeAiUserInputRequestToIpc(
            requireRecord(event.payload) as unknown as NativeAiUserInputRequestPayload,
        );
    }

    if (event.eventName === "ai://token-usage") {
        return nativeAiTokenUsageToIpc(
            requireRecord(event.payload) as unknown as NativeAiTokenUsagePayload,
        );
    }

    if (event.eventName === "ai://error") {
        return nativeAiErrorToIpc(
            requireRecord(event.payload) as unknown as NativeAiErrorPayload,
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

export function nativeProjectTreeEntryToIpc(
    entry: NativeProjectTreeEntry,
): ProjectTreeNode {
    return {
        extension: entry.extension,
        gitStatus: entry.gitStatus as ProjectTreeNode["gitStatus"],
        hasChildren: entry.hasChildren,
        id: entry.id,
        isGitIgnored: entry.isGitIgnored,
        kind: entry.kind === "directory" ? "directory" : "file",
        name: entry.name,
        parentRelativePath: entry.parentRelativePath,
        relativePath: entry.relativePath,
    };
}

export function nativeProjectTreeEntriesToIpc(
    entries: readonly NativeProjectTreeEntry[],
): ProjectTreeNode[] {
    return entries.map(nativeProjectTreeEntryToIpc);
}

export function nativeIndexedProjectEntryToIpc(
    entry: NativeIndexedProjectEntry,
): ProjectTreeNode {
    return nativeProjectTreeEntryToIpc(entry);
}

export function nativeIndexedProjectEntriesToIpc(
    entries: readonly NativeIndexedProjectEntry[],
): ProjectTreeNode[] {
    return entries.map(nativeIndexedProjectEntryToIpc);
}

export function nativeFsReadFileToIpc(
    file: NativeFsReadFileResult,
): ProjectFileDocument {
    const content = file.content ?? "";
    const kind = parseNativeProjectFileKind(file.kind, file.isBinary);
    const language = resolveEditorLanguage({
        filePath: file.path,
        probeContent: kind === "text" ? content.slice(0, 4096) : "",
    });

    return {
        absolutePath: file.path,
        content,
        imageDataBase64: file.imageDataBase64 ?? null,
        isBinary: file.isBinary,
        isTooLarge: file.isTooLarge,
        kind,
        languageId: language.id,
        languageLabel: language.label,
        mimeType: file.mimeType ?? null,
        modifiedAtMs: file.mtimeMs,
        name: file.name ?? basename(file.path),
        projectId: file.projectId,
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
    };
}

export function nativeFsMutationToIpc(
    mutation: NativeFsEntryMutationResult,
): ProjectEntryMutationResult {
    return {
        kind: nativeEntryKindToProjectEntryKind(mutation.kind),
        name: mutation.name,
        parentRelativePath: mutation.parentRelativePath,
        relativePath: mutation.relativePath,
    };
}

export function nativeFsMutationsToIpc(
    mutations: readonly NativeFsEntryMutationResult[],
): ProjectEntryMutationResult[] {
    return mutations.map(nativeFsMutationToIpc);
}

export function nativeProjectTreeInvalidationToIpc(
    invalidation: NativeProjectTreeInvalidation,
): ProjectTreeInvalidation {
    return {
        occurredAt: invalidation.occurredAt,
        projectId: invalidation.projectId,
        relativePaths: invalidation.relativePaths,
        worktreeId: invalidation.worktreeId,
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

function nativeAiSessionCreatedToIpc(
    payload: NativeAiSessionCreatedPayload,
): AiSessionDomainEvent {
    return {
        origin: "live",
        parentSessionId: null,
        projectId: payload.projectId,
        runtimeId: payload.runtimeId as AiSessionDomainEvent["runtimeId"],
        runtimeSessionId: payload.runtimeSessionId,
        sessionId: payload.sessionId,
        kind: "session-info",
        title: payload.title,
        updatedAt: payload.updatedAt,
        worktreeId: payload.worktreeId,
    };
}

function nativeAiSessionUpdatedToIpc(
    payload: NativeAiSessionUpdatedPayload,
): AiSessionDomainEvent {
    return {
        activeTurnStartedAt: payload.status === "streaming" ? payload.updatedAt : null,
        kind: "status",
        lastError: payload.status === "error" ? "Native AI session failed." : null,
        origin: "live",
        parentSessionId: null,
        runtimeId: payload.runtimeId as AiSessionDomainEvent["runtimeId"],
        runtimeSessionId: payload.runtimeSessionId,
        sessionId: payload.sessionId,
        status: nativeAiSessionStatusToIpc(payload.status),
        updatedAt: payload.updatedAt,
    };
}

function nativeAiMessageStartedToIpc(
    payload: NativeAiMessageStartedPayload,
): AiSessionDomainEvent {
    const messageKind = payload.messageKind as AiSessionMessageEventKind;
    return {
        ...nativeAiEventBase(payload),
        kind: "message-started",
        message: {
            attachments: [],
            content: payload.content,
            createdAt: payload.updatedAt,
            id: payload.messageId,
            kind: messageKind,
            status: "streaming",
        },
        messageKind,
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

function nativeAiMessageCompletedToIpc(
    payload: NativeAiMessageCompletedPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        kind: "message-completed",
        messageId: payload.messageId,
        messageKind: payload.messageKind as AiSessionMessageEventKind,
    };
}

function nativeAiThinkingStartedToIpc(
    payload: NativeAiThinkingStartedPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        kind: "thinking-started",
        message: {
            attachments: [],
            content: payload.content,
            createdAt: payload.updatedAt,
            id: payload.messageId,
            kind: "thinking",
            status: "streaming",
        },
    };
}

function nativeAiThinkingDeltaToIpc(
    payload: NativeAiThinkingDeltaPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        content: payload.content,
        delta: payload.delta,
        kind: "thinking-delta",
        messageId: payload.messageId,
    };
}

function nativeAiThinkingCompletedToIpc(
    payload: NativeAiThinkingCompletedPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        kind: "thinking-completed",
        messageId: payload.messageId,
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

function nativeAiStatusEventToIpc(
    payload: NativeAiStatusEventPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        activity: {
            action: null,
            createdAt: payload.updatedAt,
            diffs: [],
            exitCode: null,
            id: payload.eventId,
            kind: "status",
            locations: [],
            rawInputJson: null,
            rawOutputJson: null,
            sessionId: payload.sessionId,
            status: payload.status as AiToolActivity["status"],
            summary: payload.detail,
            terminalOutput: null,
            title: payload.title,
            updatedAt: payload.updatedAt,
        },
        kind: "tool-activity",
    };
}

function nativeAiPlanUpdatedToIpc(
    payload: NativeAiPlanUpdatedPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        kind: "plan",
        plan: {
            entries: payload.entries.map((entry) => ({
                content: entry.content,
                priority: entry.priority as "high" | "low" | "medium",
                status: entry.status as "completed" | "in_progress" | "pending",
            })),
            title: payload.title,
            updatedAt: payload.updatedAt,
        },
    };
}

function nativeAiPermissionRequestToIpc(
    payload: NativeAiPermissionRequestPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        kind: "permission-request",
        request: {
            description: payload.description,
            options: payload.options.map((option) => ({
                kind: option.kind as AiPermissionOption["kind"],
                name: option.name,
                optionId: option.optionId,
            })),
            requestId: payload.requestId,
            sessionId: payload.sessionId,
            title: payload.title,
            toolCallId: payload.toolCallId,
            updatedAt: payload.updatedAt,
        },
    };
}

function nativeAiUserInputRequestToIpc(
    payload: NativeAiUserInputRequestPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        kind: "user-input-request",
        request: {
            questions: payload.questions.map((question): AiUserInputQuestion => ({
                header: question.header,
                id: question.id,
                isOther: question.isOther,
                isSecret: question.isSecret,
                options: question.options.map((option) => ({
                    description: option.description,
                    label: option.label,
                })),
                question: question.question,
            })),
            requestId: payload.requestId,
            sessionId: payload.sessionId,
            title: payload.title,
            toolCallId: payload.toolCallId,
            turnId: payload.turnId,
            updatedAt: payload.updatedAt,
        },
    };
}

function nativeAiTokenUsageToIpc(
    payload: NativeAiTokenUsagePayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        kind: "token-usage",
        tokenUsage: {
            cost: payload.cost,
            size: payload.size,
            updatedAt: payload.updatedAt,
            used: payload.used,
        },
    };
}

function nativeAiErrorToIpc(payload: NativeAiErrorPayload): AiSessionDomainEvent | null {
    if (!payload.sessionId || !payload.runtimeId) {
        return null;
    }

    return {
        activeTurnStartedAt: null,
        kind: "status",
        lastError: payload.message,
        origin: "live",
        parentSessionId: null,
        runtimeId: payload.runtimeId as AiSessionDomainEvent["runtimeId"],
        runtimeSessionId: null,
        sessionId: payload.sessionId,
        status: "error",
        updatedAt: payload.updatedAt,
    };
}

function nativeAiEventBase(
    payload: NativeAiEventBase,
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

function nativeAiSessionStatusToIpc(status: string): AiSessionStatus {
    if (status === "streaming") {
        return "streaming";
    }
    if (status === "waiting_permission") {
        return "waiting_permission";
    }
    if (status === "waiting_user_input") {
        return "waiting_user_input";
    }
    if (status === "error") {
        return "error";
    }
    return "idle";
}

function parseSignalCode(signalCode: string | null): number | null {
    if (signalCode === null) {
        return null;
    }

    const signalMatch = signalCode.trim().match(/(\d+)\D*$/u);
    const numericSignal = Number.parseInt(signalMatch?.[1] ?? signalCode, 10);
    return Number.isFinite(numericSignal) ? numericSignal : null;
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Native event payload must be an object.");
    }

    return value as Record<string, unknown>;
}

function parseNativeProjectFileKind(
    kind: string | null | undefined,
    isBinary: boolean,
): ProjectFileDocument["kind"] {
    if (kind === "image" || kind === "binary" || kind === "text") {
        return kind;
    }

    return isBinary ? "binary" : "text";
}

function nativeEntryKindToProjectEntryKind(
    kind: NativeFsEntryKind,
): ProjectEntryMutationResult["kind"] {
    return kind === "directory" ? "directory" : "file";
}

function basename(filePath: string): string {
    const normalized = filePath.replaceAll("\\", "/");
    return normalized.split("/").at(-1) ?? normalized;
}
