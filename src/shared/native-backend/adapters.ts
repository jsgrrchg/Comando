import type {
    AiAvailableCommand,
    AiDiffHunk,
    AiDiffHunkLine,
    AiRuntimeId,
    AiRuntimeStatus,
    AiRuntimeSource,
    AiRuntimeState,
    AiFileDiff,
    AiReviewConflict,
    AiSessionConfigOption,
    AiSessionStatus,
    AiSessionDomainEvent,
    AiSessionMessageEventKind,
    AiTrackedFile,
    AiPermissionOption,
    AiToolActivity,
    AiToolActivityDetail,
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
    NativeAiImageGenerationPayload,
    NativeAiMessageCompletedPayload,
    NativeAiMessageDeltaPayload,
    NativeAiMessageStartedPayload,
    NativeAiPermissionRequestPayload,
    NativeAiPlanUpdatedPayload,
    NativeAiReviewUpdatedPayload,
    NativeAiReviewCommandOutput,
    NativeAiReviewDeltaReadyPayload,
    NativeAiRuntimeStatus,
    NativeAiSessionCatalogUpdatedPayload,
    NativeAiSessionClosedPayload,
    NativeAiSessionCreatedPayload,
    NativeAiSessionUpdatedPayload,
    NativeAiStatusEventPayload,
    NativeAiSubagentBreadcrumbPayload,
    NativeAiSubagentCreatedPayload,
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
        authCredentialSource: status.authCredentialSource ?? undefined,
        authCredentialSourceLabel:
            status.authCredentialSourceLabel ?? undefined,
        authSessionMessage: status.authSessionMessage ?? undefined,
        authStorageMessage: status.authStorageMessage ?? undefined,
        canDisconnectAuth: status.canDisconnectAuth ?? undefined,
        canLogoutAuth: status.canLogoutAuth ?? undefined,
        checkedAt: status.checkedAt,
        command: status.command,
        availableCommands:
            status.availableCommands as AiRuntimeStatus["availableCommands"],
        configOptions: status.configOptions as AiRuntimeStatus["configOptions"],
        hasCustomBinaryPath: status.hasCustomBinaryPath,
        hasGatewayConfig: status.hasGatewayConfig,
        hasGatewayUrl: status.hasGatewayUrl,
        message: status.message,
        modeId: status.modeId ?? undefined,
        modes: status.modes as AiRuntimeStatus["modes"],
        modelId: status.modelId ?? undefined,
        models: status.models as AiRuntimeStatus["models"],
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

    if (event.eventName === "ai://session-closed") {
        return nativeAiSessionClosedToIpc(
            requireRecord(event.payload) as unknown as NativeAiSessionClosedPayload,
        );
    }

    if (event.eventName === "ai://subagent-created") {
        return nativeAiSubagentCreatedToIpc(
            requireRecord(event.payload) as unknown as NativeAiSubagentCreatedPayload,
        );
    }

    if (event.eventName === "ai://subagent-breadcrumb") {
        return nativeAiSubagentBreadcrumbToIpc(
            requireRecord(event.payload) as unknown as NativeAiSubagentBreadcrumbPayload,
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

    if (event.eventName === "ai://image-generation") {
        return nativeAiImageGenerationToIpc(
            requireRecord(event.payload) as unknown as NativeAiImageGenerationPayload,
        );
    }

    if (event.eventName === "ai://tool-activity") {
        return nativeAiToolActivityToIpc(
            requireRecord(event.payload) as unknown as NativeAiToolActivityPayload,
        );
    }

    if (event.eventName === "ai://status-event") {
        const payload = requireRecord(
            event.payload,
        ) as unknown as NativeAiStatusEventPayload;
        return shouldSuppressNativeStatusActivity(payload)
            ? null
            : nativeAiStatusEventToIpc(payload);
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

    if (event.eventName === "ai://review-updated") {
        return nativeAiReviewUpdatedToIpc(
            requireRecord(event.payload) as unknown as NativeAiReviewUpdatedPayload,
        );
    }

    if (event.eventName === "ai://review-delta-ready") {
        return nativeAiReviewDeltaReadyToIpc(
            requireRecord(event.payload) as unknown as NativeAiReviewDeltaReadyPayload,
        );
    }

    if (event.eventName === "ai://error") {
        return nativeAiErrorToIpc(
            requireRecord(event.payload) as unknown as NativeAiErrorPayload,
        );
    }

    return null;
}

function nativeAiReviewDeltaReadyToIpc(
    payload: NativeAiReviewDeltaReadyPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        delta: payload.delta,
        kind: "review-delta",
    };
}

export type NativeAiCatalogPatch = {
    readonly availableCommands?: readonly AiAvailableCommand[];
    readonly configOptions?: readonly AiSessionConfigOption[];
    readonly modeId?: string | null;
};

export function nativeAiCatalogPatchToIpc(
    payload: NativeAiSessionCatalogUpdatedPayload,
): NativeAiCatalogPatch {
    return {
        ...(payload.availableCommands
            ? {
                  availableCommands: payload.availableCommands.map((command) => ({
                      description: command.description,
                      id: command.name,
                      insertText: `/${command.name} `,
                      label: `/${command.name}`,
                  })),
              }
            : {}),
        ...(payload.configOptions
            ? {
                  configOptions: payload.configOptions.map((option) =>
                      option.type === "boolean"
                          ? {
                                category: mapNativeConfigOptionCategory(
                                    option.category,
                                ),
                                description: option.description,
                                id: option.id,
                                label: option.name,
                                type: "boolean" as const,
                                value: option.currentValue,
                            }
                          : {
                                category: mapNativeConfigOptionCategory(
                                    option.category,
                                ),
                                description: option.description,
                                id: option.id,
                                label: option.name,
                                options: option.options.map((entry) => ({
                                    description: entry.description,
                                    groupLabel: entry.groupLabel,
                                    label: entry.name,
                                    value: entry.value,
                                })),
                                type: "select" as const,
                                value: option.currentValue,
                            },
                  ),
              }
            : {}),
        // `modeId` is tri-state: `undefined` leaves the selection untouched,
        // `null` clears it, and a string sets it.
        ...(payload.modeId !== undefined ? { modeId: payload.modeId } : {}),
    };
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

function nativeProjectTreeEntryToIpc(
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

function nativeIndexedProjectEntryToIpc(
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
        title: payload.title,
        updatedAt: payload.updatedAt,
    };
}

function nativeAiSessionClosedToIpc(
    payload: NativeAiSessionClosedPayload,
): AiSessionDomainEvent {
    return {
        closedAt: payload.updatedAt,
        kind: "session-closed",
        origin: "live",
        parentSessionId: null,
        runtimeId: payload.runtimeId as AiSessionDomainEvent["runtimeId"],
        runtimeSessionId: payload.runtimeSessionId,
        sessionId: payload.sessionId,
        updatedAt: payload.updatedAt,
    };
}

function nativeAiSubagentCreatedToIpc(
    payload: NativeAiSubagentCreatedPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        childSessionId: payload.childSessionId,
        childRuntimeSessionId: payload.childRuntimeSessionId,
        kind: "subagent-created",
        modelId: payload.modelId ?? null,
        parentSessionId: payload.parentSessionId,
        reasoningEffort: payload.reasoningEffort ?? null,
        runtimeSessionId: payload.childRuntimeSessionId,
        sessionId: payload.childSessionId,
        title: payload.title,
    };
}

function nativeAiSubagentBreadcrumbToIpc(
    payload: NativeAiSubagentBreadcrumbPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        childSessionId: payload.childSessionId,
        kind: "subagent-breadcrumb",
        toolCallId: payload.toolCallId,
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

function nativeAiImageGenerationToIpc(
    payload: NativeAiImageGenerationPayload,
): AiSessionDomainEvent {
    return {
        ...nativeAiEventBase(payload),
        kind: "image-generation",
        message: payload.message,
    };
}

function nativeAiToolActivityToIpc(
    payload: NativeAiToolActivityPayload,
): AiSessionDomainEvent {
    const activity: AiToolActivity = {
        action: null,
        changeStats: nativeAiToolActivityChangeStatsToIpc(payload.changeStats),
        createdAt: payload.updatedAt,
        diffs: nativeFileDiffsToIpc(payload.diffs),
        exitCode:
            typeof payload.exitCode === "number" &&
            Number.isFinite(payload.exitCode)
                ? payload.exitCode
                : null,
        id: payload.toolCallId,
        kind: payload.kind,
        locations: nativeAiToolActivityLocationsToIpc(payload.locations),
        rawInputJson: stringifyNativeJson(payload.rawInput),
        rawOutputJson: stringifyNativeJson(payload.rawOutput),
        sessionId: payload.sessionId,
        status: payload.status as AiToolActivity["status"],
        summary: payload.summary,
        toolActivityDetailId: payload.toolActivityDetailId ?? null,
        terminalOutput: resolveNativeTerminalOutput(payload),
        title: payload.title,
        updatedAt: payload.updatedAt,
    };

    return {
        ...nativeAiEventBase(payload),
        activity,
        kind: "tool-activity",
    };
}

function nativeAiToolActivityLocationsToIpc(
    value: unknown,
): AiToolActivity["locations"] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return [];
        }

        const record = entry as Record<string, unknown>;
        if (typeof record.path !== "string" || record.path.trim().length === 0) {
            return [];
        }

        const line = record.line;
        if (
            line !== undefined &&
            line !== null &&
            (typeof line !== "number" ||
                !Number.isFinite(line) ||
                line < 0)
        ) {
            return [];
        }

        return [
            {
                endLine: null,
                line: typeof line === "number" ? line : null,
                path: record.path.trim(),
            },
        ];
    });
}

function nativeAiToolActivityChangeStatsToIpc(
    value: NativeAiToolActivityPayload["changeStats"],
): AiToolActivity["changeStats"] {
    if (!value) {
        return null;
    }
    return {
        additions: Math.max(0, value.additions),
        approximate: value.approximate === true,
        deletions: Math.max(0, value.deletions),
        fileCount: Math.max(0, value.fileCount),
    };
}

const TERMINAL_TOOL_KINDS = new Set([
    "bash",
    "command",
    "execute",
    "exec_command",
    "shell",
    "terminal",
]);

function resolveNativeTerminalOutput(
    payload: NativeAiToolActivityPayload,
): string | null {
    if (typeof payload.terminalOutput === "string") {
        return payload.terminalOutput;
    }

    const isTerminalActivity =
        TERMINAL_TOOL_KINDS.has(payload.kind.toLocaleLowerCase()) ||
        payload.summary?.trim().toLocaleLowerCase() ===
            "terminal output available.";
    if (!isTerminalActivity) {
        return null;
    }

    return extractTerminalOutputText(payload.rawOutput);
}

function extractTerminalOutputText(value: unknown): string | null {
    if (typeof value === "string") {
        return value.length > 0 ? value : null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    for (const key of [
        "formatted_output",
        "aggregated_output",
        "stdout",
        "output",
    ]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.length > 0) {
            return candidate;
        }
    }

    for (const key of ["result", "data"]) {
        const nested = extractTerminalOutputText(record[key]);
        if (nested !== null) {
            return nested;
        }
    }

    return null;
}

function stringifyNativeJson(value: unknown): string | null {
    if (value === undefined || value === null) {
        return null;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}

function nativeAiStatusEventToIpc(
    payload: NativeAiStatusEventPayload,
): AiSessionDomainEvent {
    if (
        payload.turnId &&
        (payload.status === "cancelled" ||
            payload.status === "completed" ||
            payload.status === "failed")
    ) {
        return {
            ...nativeAiEventBase(payload),
            error: payload.status === "failed" ? payload.detail : null,
            kind: "turn-status",
            status: payload.status,
            turnId: payload.turnId,
        };
    }

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

function shouldSuppressNativeStatusActivity(
    payload: NativeAiStatusEventPayload,
): boolean {
    return (
        !payload.turnId &&
        payload.status === "completed" &&
        payload.title === "Completed"
    );
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

function nativeAiReviewUpdatedToIpc(
    payload: NativeAiReviewUpdatedPayload,
): AiSessionDomainEvent {
    const conflicts = nativeReviewConflictsToIpc(payload.conflicts);
    return {
        ...nativeAiEventBase(payload),
        conflicts,
        kind: "review",
        trackedFiles: nativeReviewTrackedFilesWithConflictsToIpc({
            conflicts,
            sessionId: payload.sessionId,
            trackedFiles: payload.trackedFiles,
            updatedAt: payload.updatedAt,
        }),
    };
}

export function nativeReviewCommandTrackedFilesToIpc(
    output: NativeAiReviewCommandOutput,
): readonly AiTrackedFile[] {
    return nativeReviewTrackedFilesWithConflictsToIpc({
        conflicts: nativeReviewConflictsToIpc(output.conflicts),
        sessionId: output.sessionId,
        trackedFiles: output.trackedFiles,
        updatedAt: output.updatedAt,
    });
}

export function nativeReviewTrackedFileToIpc(value: unknown): AiTrackedFile {
    const record = requireRecord(value);
    const reviewState = readString(record, "reviewState", "pending");
    const hunkResult = nativeAiDiffHunksToIpc(record.hunks);
    const version =
        typeof record.version === "number" && Number.isFinite(record.version)
            ? Math.max(1, Math.trunc(record.version))
            : null;
    return {
        ...(typeof record.diffBase === "string"
            ? { diffBase: record.diffBase }
            : {}),
        ...(typeof record.currentText === "string"
            ? { currentText: record.currentText }
            : {}),
        ...(typeof record.conflict === "string"
            ? { conflict: record.conflict }
            : {}),
        ...(record.hunksAreAnchored === true && !hunkResult.droppedInvalidHunks
            ? { hunksAreAnchored: true }
            : {}),
        identityKey: readString(record, "identityKey", readString(record, "path", "")),
        hunks: hunkResult.hunks,
        isText: record.isText !== false,
        kind: readTrackedFileKind(record.kind),
        newText: readNullableString(record, "newText"),
        oldText: readNullableString(record, "oldText"),
        path: readString(record, "path", ""),
        previousPath: readNullableString(record, "previousPath"),
        reviewState:
            reviewState === "conflict" ||
            reviewState === "kept" ||
            reviewState === "rejected"
                ? reviewState
                : "pending",
        reversible: record.reversible !== false,
        sessionId: readString(record, "sessionId", ""),
        toolCallId: readNullableString(record, "toolCallId"),
        updatedAt: readString(record, "updatedAt", new Date(0).toISOString()),
        ...(version !== null ? { version } : {}),
    };
}

export function nativeAiToolActivityDetailToIpc(
    value: unknown,
): AiToolActivityDetail {
    const record = requireRecord(value);
    return {
        diffs: nativeFileDiffsToIpc(record.diffs),
        rawInputJson: stringifyNativeJson(record.rawInput),
        rawOutputJson: stringifyNativeJson(record.rawOutput),
        terminalOutput:
            typeof record.terminalOutput === "string"
                ? record.terminalOutput
                : null,
    };
}

function nativeReviewTrackedFilesWithConflictsToIpc(input: {
    readonly conflicts: readonly AiReviewConflict[];
    readonly sessionId: string;
    readonly trackedFiles: readonly unknown[];
    readonly updatedAt: string;
}): readonly AiTrackedFile[] {
    const conflictsByPath = new Map(
        input.conflicts.map((conflict) => [conflict.path, conflict] as const),
    );
    const trackedFiles = input.trackedFiles.map((entry) => {
        const trackedFile = nativeReviewTrackedFileToIpc(entry);
        const conflict =
            conflictsByPath.get(trackedFile.path) ??
            (trackedFile.previousPath
                ? conflictsByPath.get(trackedFile.previousPath)
                : undefined);
        if (!conflict) {
            return trackedFile;
        }
        return nativeReviewConflictToTrackedFile(
            conflict,
            trackedFile.sessionId || input.sessionId,
            trackedFile.updatedAt || input.updatedAt,
        );
    });
    const trackedPaths = new Set(
        trackedFiles.flatMap((file) => [
            file.path,
            ...(file.previousPath ? [file.previousPath] : []),
        ]),
    );
    const conflictFiles = input.conflicts
        .filter((conflict) => conflict.path.length > 0)
        .filter((conflict) => !trackedPaths.has(conflict.path))
        .map((conflict) =>
            nativeReviewConflictToTrackedFile(
                conflict,
                input.sessionId,
                input.updatedAt,
            ),
        );
    return [...trackedFiles, ...conflictFiles];
}

function nativeReviewConflictsToIpc(value: unknown): readonly AiReviewConflict[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        try {
            return [nativeReviewConflictToIpc(entry)];
        } catch {
            return [];
        }
    });
}

function nativeReviewConflictToIpc(value: unknown): AiReviewConflict {
    const record = requireRecord(value);
    return {
        externalChangeHash: readNullableString(record, "externalChangeHash"),
        path: readString(record, "path", ""),
        reason: readString(record, "reason", "unknown"),
    };
}

function nativeReviewConflictToTrackedFile(
    conflict: AiReviewConflict,
    sessionId: string,
    updatedAt: string,
): AiTrackedFile {
    return {
        conflict: conflict.reason,
        currentText: "",
        diffBase: "",
        hunks: [],
        identityKey: `native:${sessionId}:conflict:${conflict.path}`,
        isText: false,
        kind: "update",
        newText: null,
        oldText: null,
        path: conflict.path,
        previousPath: null,
        reviewState: "conflict",
        reversible: false,
        sessionId,
        toolCallId: null,
        updatedAt,
        version: 1,
    };
}

function nativeFileDiffsToIpc(value: unknown): readonly AiFileDiff[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((entry) => {
        try {
            return [nativeFileDiffToIpc(entry)];
        } catch {
            return [];
        }
    });
}

function nativeFileDiffToIpc(value: unknown): AiFileDiff {
    const record = requireRecord(value);
    return {
        hunks: nativeAiDiffHunksToIpc(record.hunks).hunks,
        isText: record.isText !== false,
        kind: readTrackedFileKind(record.kind),
        newText: readNullableString(record, "newText"),
        oldText: readNullableString(record, "oldText"),
        path: readString(record, "path", ""),
        previousPath: readNullableString(record, "previousPath"),
        reversible: record.reversible !== false,
    };
}

function nativeAiDiffHunksToIpc(value: unknown): {
    readonly droppedInvalidHunks: boolean;
    readonly hunks: readonly AiDiffHunk[];
} {
    if (!Array.isArray(value)) {
        return { droppedInvalidHunks: false, hunks: [] };
    }

    const hunks = value.flatMap((entry) => {
        const hunk = nativeAiDiffHunkToIpc(entry);
        return hunk ? [hunk] : [];
    });
    return {
        droppedInvalidHunks: hunks.length !== value.length,
        hunks,
    };
}

function nativeAiDiffHunkToIpc(value: unknown): AiDiffHunk | null {
    const record = readRecord(value);
    if (!record) {
        return null;
    }

    const id = readNonEmptyString(record, "id");
    const oldStart = readInteger(record, "oldStart", { min: 1 });
    const oldCount = readInteger(record, "oldCount", { min: 0 });
    const newStart = readInteger(record, "newStart", { min: 1 });
    const newCount = readInteger(record, "newCount", { min: 0 });
    if (
        id === null ||
        oldStart === null ||
        oldCount === null ||
        newStart === null ||
        newCount === null ||
        !Array.isArray(record.lines)
    ) {
        return null;
    }

    const lines = record.lines.flatMap((lineValue) => {
        const line = nativeAiDiffHunkLineToIpc(lineValue);
        return line ? [line] : [];
    });
    if (lines.length !== record.lines.length) {
        return null;
    }

    const visualStartLine = readOptionalInteger(record, "visualStartLine", {
        min: 1,
    });
    const visualEndLine = readOptionalInteger(record, "visualEndLine", {
        min: 1,
    });
    return {
        id,
        lines,
        newCount,
        newStart,
        oldCount,
        oldStart,
        ...(visualStartLine !== undefined ? { visualStartLine } : {}),
        ...(visualEndLine !== undefined ? { visualEndLine } : {}),
    };
}

function nativeAiDiffHunkLineToIpc(value: unknown): AiDiffHunkLine | null {
    const record = readRecord(value);
    if (!record) {
        return null;
    }

    const id = readNonEmptyString(record, "id");
    const text = readStringValue(record, "text");
    const type = record.type;
    if (
        id === null ||
        text === null ||
        (type !== "add" && type !== "context" && type !== "remove")
    ) {
        return null;
    }

    return { id, text, type };
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

function mapNativeConfigOptionCategory(
    category: string | null | undefined,
): AiSessionConfigOption["category"] {
    if (category === "mode" || category === "model") {
        return category;
    }
    if (category === "thought_level" || category === "effort") {
        return "reasoning";
    }
    return "other";
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

function readRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }

    return value as Record<string, unknown>;
}

function readString(
    record: Record<string, unknown>,
    key: string,
    fallback: string,
): string {
    const value = record[key];
    return typeof value === "string" ? value : fallback;
}

function readStringValue(
    record: Record<string, unknown>,
    key: string,
): string | null {
    const value = record[key];
    return typeof value === "string" ? value : null;
}

function readNonEmptyString(
    record: Record<string, unknown>,
    key: string,
): string | null {
    const value = readStringValue(record, key);
    return value && value.length > 0 ? value : null;
}

function readNullableString(
    record: Record<string, unknown>,
    key: string,
): string | null {
    const value = record[key];
    return typeof value === "string" ? value : null;
}

function readInteger(
    record: Record<string, unknown>,
    key: string,
    options: { readonly min?: number } = {},
): number | null {
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value)) {
        return null;
    }
    if (options.min !== undefined && value < options.min) {
        return null;
    }
    return value;
}

function readOptionalInteger(
    record: Record<string, unknown>,
    key: string,
    options: { readonly min?: number } = {},
): number | undefined {
    return Object.prototype.hasOwnProperty.call(record, key)
        ? (readInteger(record, key, options) ?? undefined)
        : undefined;
}

function readTrackedFileKind(value: unknown): AiTrackedFile["kind"] {
    return value === "create" ||
        value === "delete" ||
        value === "move" ||
        value === "update"
        ? value
        : "update";
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
