import type {
    AiRuntimeId,
    AiRuntimeStatus,
    AiRuntimeSource,
    AiRuntimeState,
    AiSessionDomainEvent,
    AiSessionMessageEventKind,
    AiToolActivity,
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
    NativeAiMessageDeltaPayload,
    NativeAiRuntimeStatus,
    NativeAiToolActivityPayload,
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
