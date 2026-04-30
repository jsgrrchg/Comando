import fs from "node:fs";
import path from "node:path";

import type {
    Diff,
    ToolCall,
    ToolCallContent,
    ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type {
    AiGeneratedImage,
    AiFileDiff,
    AiSessionSnapshot,
    AiTrackedFile,
    AiUserInputRequest,
} from "@shared/ipc";
import {
    computeDiffHunks,
    getTrackedFileCurrentText,
    getTrackedFileDiffBase,
    syncTrackedFile,
    upsertTrackedFile,
} from "@shared/ai-tracked-file";
import { inferCodexGeneratedImageMimeType } from "@shared/file-preview";

import { readOpenFileBuffer } from "./openFileBuffers";
import {
    CODEX_ACP_DIFF_PREVIOUS_PATH_KEY,
    CODEX_ACP_IMAGE_GENERATION_EVENT_ID_PREFIX,
    CODEX_ACP_IMAGE_GENERATION_EVENT_TYPE,
    CODEX_ACP_STATUS_EVENT_ID_PREFIX,
    CODEX_ACP_STATUS_EVENT_TYPE,
    CODEX_ACP_STATUS_EVENT_TYPE_KEY,
    CODEX_ACP_STATUS_TURN_EVENT_ID_PREFIX,
    CODEX_ACP_USER_INPUT_EVENT_TYPE,
    COMANDO_DIFF_PREVIOUS_PATH_KEY,
    COMANDO_STATUS_EVENT_ID_PREFIX,
    COMANDO_STATUS_EVENT_TYPE_KEY,
    COMANDO_STATUS_TURN_EVENT_ID_PREFIX,
    SUPPRESSED_STATUS_TITLES,
    type LiveAcpSession,
} from "./contracts";
import { toPosixPath } from "./session-core";
import { debugBenignError } from "@main/observability/logging";

const TERMINAL_OUTPUT_MAX_LENGTH = 10_000;
const TRACKED_DIFF_MAX_READ_BYTES = 5 * 1024 * 1024;

interface DiffResolutionContext {
    readonly meta: unknown;
    readonly readOpenFileBuffer?: (absolutePath: string) => string | null;
    readonly sessionUpdate: "tool_call" | "tool_call_update";
    readonly toolCallId: string;
}

export function mapToolCallUpdate(
    liveSession: Pick<
        LiveAcpSession,
        "cwd" | "projectRoot" | "processedDiffPaths" | "terminalOutputBuffers"
    >,
    snapshot: AiSessionSnapshot,
    update: ToolCall | ToolCallUpdate,
    updateKind: "tool_call" | "tool_call_update",
    updatedAt: string,
    options: {
        readonly readOpenFileBuffer?: (absolutePath: string) => string | null;
    } = {},
): AiSessionSnapshot {
    const existing =
        snapshot.toolActivity.find(
            (candidate) => candidate.id === update.toolCallId,
        ) ?? null;
    const nextTitle =
        typeof update.title === "string" && update.title.trim().length > 0
            ? update.title.trim()
            : (existing?.title ?? null);

    if (shouldSuppressToolActivityUpdate(update, nextTitle)) {
        return snapshot;
    }

    const toolKind = update.kind ?? existing?.kind ?? "unknown";
    const content = update.content ?? null;
    const pendingUserInput = parseUserInputRequest(snapshot, update, updatedAt);

    let exitCode: number | null = existing?.exitCode ?? null;
    let terminalOutput: string | null = existing?.terminalOutput ?? null;

    if (isRecord(update._meta)) {
        if (isRecord(update._meta.terminal_output)) {
            const data = (update._meta.terminal_output as { data: string })
                .data;
            if (typeof data === "string") {
                const terminalId = (
                    update._meta.terminal_output as { terminal_id: string }
                ).terminal_id;
                const prev =
                    liveSession.terminalOutputBuffers.get(terminalId) ?? "";
                let next = prev + data;
                if (next.length > TERMINAL_OUTPUT_MAX_LENGTH) {
                    next = next.slice(-TERMINAL_OUTPUT_MAX_LENGTH);
                }
                liveSession.terminalOutputBuffers.set(terminalId, next);
                terminalOutput = next;
            }
        }

        if (isRecord(update._meta.terminal_exit)) {
            const termExit = update._meta.terminal_exit as {
                terminal_id: string;
                exit_code: number;
                signal: string | null;
            };
            if (typeof termExit.exit_code === "number") {
                exitCode = termExit.exit_code;
            }
            const finalOutput = liveSession.terminalOutputBuffers.get(
                termExit.terminal_id,
            );
            if (finalOutput !== undefined) {
                terminalOutput = finalOutput;
                liveSession.terminalOutputBuffers.delete(termExit.terminal_id);
            }
        }
    }

    const normalizeDiffPath = (candidatePath: string) =>
        normalizeTrackedDiffPath(liveSession, candidatePath);
    const nextActivity = {
        ...(existing?.action ? { action: existing.action } : {}),
        createdAt: existing?.createdAt ?? updatedAt,
        diffs: content
            ? collectDiffs(content, toolKind, normalizeDiffPath)
            : (existing?.diffs ?? []),
        exitCode,
        id: update.toolCallId,
        kind: toolKind,
        locations:
            update.locations?.map((location) => location.path) ??
            existing?.locations ??
            [],
        rawInputJson:
            update.rawInput !== undefined
                ? stringifyJson(update.rawInput)
                : (existing?.rawInputJson ?? null),
        rawOutputJson:
            update.rawOutput !== undefined
                ? stringifyJson(update.rawOutput)
                : (existing?.rawOutputJson ?? null),
        sessionId: snapshot.sessionId,
        status: update.status ?? existing?.status ?? "pending",
        summary:
            buildToolSummary(
                nextTitle ?? "Tool call",
                content,
                toolKind,
                update.rawInput,
                update.rawOutput,
            ) ??
            existing?.summary ??
            null,
        terminalOutput,
        title: nextTitle ?? "Tool call",
        updatedAt,
    };
    const activeTurnStartedAt = isTurnStartedStatusUpdate(update)
        ? (snapshot.activeTurnStartedAt ?? nextActivity.createdAt)
        : (snapshot.activeTurnStartedAt ?? null);

    const terminalStatus =
        update.status === "completed" || update.status === "failed";

    const nextTrackedFiles = content
        ? content.reduce((acc, entry) => {
              if (entry.type !== "diff") {
                  return acc;
              }
              const normalizedPath = normalizeDiffPath(entry.path);
              const processedPaths =
                  liveSession.processedDiffPaths.get(update.toolCallId);
              if (processedPaths?.has(normalizedPath)) {
                  return acc;
              }
              if (processedPaths) {
                  processedPaths.add(normalizedPath);
              } else {
                  liveSession.processedDiffPaths.set(
                      update.toolCallId,
                      new Set([normalizedPath]),
                  );
              }

              const existing = acc.find(
                  (candidate) =>
                      candidate.path === normalizedPath ||
                      candidate.previousPath === normalizedPath,
              );
              const resolvedDiff = resolveDiffToFullTexts(
                  entry,
                  existing,
                  liveSession,
                  normalizedPath,
                  {
                      meta: update._meta,
                      readOpenFileBuffer: options.readOpenFileBuffer,
                      sessionUpdate: updateKind,
                      toolCallId: update.toolCallId,
                  },
              );
              return upsertTrackedFile(
                  acc,
                  diffToTrackedFile(
                      snapshot,
                      resolvedDiff,
                      toolKind,
                      update.toolCallId,
                      updatedAt,
                      normalizeDiffPath,
                  ),
              );
          }, snapshot.trackedFiles)
        : snapshot.trackedFiles;

    if (terminalStatus) {
        liveSession.processedDiffPaths.delete(update.toolCallId);
    }

    return {
        ...snapshot,
        activeTurnStartedAt,
        pendingPermission: pendingUserInput ? null : snapshot.pendingPermission,
        pendingUserInput: pendingUserInput ?? snapshot.pendingUserInput,
        status: pendingUserInput ? "waiting_user_input" : snapshot.status,
        toolActivity: [
            ...snapshot.toolActivity.filter(
                (candidate) => candidate.id !== update.toolCallId,
            ),
            nextActivity,
        ],
        trackedFiles: nextTrackedFiles,
    };
}

export function isImageGenerationToolUpdate(
    update: Pick<ToolCall | ToolCallUpdate, "_meta" | "toolCallId">,
): boolean {
    if (
        update.toolCallId.startsWith(CODEX_ACP_IMAGE_GENERATION_EVENT_ID_PREFIX)
    ) {
        return true;
    }

    return (
        readDiffMetaString(
            update._meta,
            CODEX_ACP_STATUS_EVENT_TYPE_KEY,
            COMANDO_STATUS_EVENT_TYPE_KEY,
        ) === CODEX_ACP_IMAGE_GENERATION_EVENT_TYPE
    );
}

export function mapImageGenerationToolUpdate(
    snapshot: AiSessionSnapshot,
    update: ToolCall | ToolCallUpdate,
    updatedAt: string,
): AiSessionSnapshot {
    const messageId = `image:${update.toolCallId}`;
    const existing =
        snapshot.messages.find((candidate) => candidate.id === messageId) ??
        null;
    const existingImage = existing?.generatedImage ?? null;
    const rawInput = isRecord(update.rawInput) ? update.rawInput : null;
    const rawStatus =
        readRecordString(rawInput, "status") ??
        mapToolStatusToImageStatus(update.status) ??
        existingImage?.status ??
        "in_progress";
    const imageStatus = normalizeImageGenerationStatus(rawStatus);
    const imagePath =
        readRecordString(rawInput, "path") ?? existingImage?.path ?? null;
    const result =
        readRecordString(rawInput, "result") ?? existingImage?.result ?? null;
    const revisedPrompt =
        readRecordString(rawInput, "revised_prompt") ??
        readRecordString(rawInput, "revisedPrompt") ??
        existingImage?.revisedPrompt ??
        null;
    const mimeType =
        readRecordString(rawInput, "mime_type") ??
        readRecordString(rawInput, "mimeType") ??
        (imagePath ? inferCodexGeneratedImageMimeType(imagePath) : null) ??
        existingImage?.mimeType ??
        null;
    const isFailure = isTerminalImageFailureStatus(imageStatus);
    const error =
        readRecordString(rawInput, "error") ??
        (isFailure ? result : null) ??
        existingImage?.error ??
        null;
    const title =
        typeof update.title === "string" && update.title.trim().length > 0
            ? update.title.trim()
            : imageGenerationTitle(imageStatus, error);
    const generatedImage: AiGeneratedImage = {
        error,
        mimeType,
        path: imagePath,
        result,
        revisedPrompt,
        status: imageStatus,
        title,
    };
    const nextMessage = {
        attachments: existing?.attachments ?? [],
        content: imageGenerationContent(generatedImage),
        createdAt: existing?.createdAt ?? updatedAt,
        generatedImage,
        id: messageId,
        kind: "image" as const,
        status: isActiveImageGenerationStatus(imageStatus)
            ? ("streaming" as const)
            : ("completed" as const),
    };
    const nextMessages = existing
        ? snapshot.messages.map((message) =>
              message.id === messageId ? nextMessage : message,
          )
        : [...snapshot.messages, nextMessage];

    return {
        ...snapshot,
        messages: nextMessages,
    };
}

function isTurnStartedStatusUpdate(
    update: Pick<ToolCall | ToolCallUpdate, "_meta" | "toolCallId">,
): boolean {
    const isTurnActivity =
        update.toolCallId.startsWith(CODEX_ACP_STATUS_TURN_EVENT_ID_PREFIX) ||
        update.toolCallId.startsWith(COMANDO_STATUS_TURN_EVENT_ID_PREFIX);
    if (!isTurnActivity) {
        return false;
    }

    return (
        readDiffMetaString(
            update._meta,
            CODEX_ACP_STATUS_EVENT_TYPE_KEY,
            COMANDO_STATUS_EVENT_TYPE_KEY,
        ) === CODEX_ACP_STATUS_EVENT_TYPE
    );
}

function collectDiffs(
    content: readonly ToolCallContent[] | null | undefined,
    toolKind: string,
    normalizePath: (candidatePath: string) => string = (candidatePath) =>
        candidatePath,
): readonly AiFileDiff[] {
    return (content ?? []).flatMap((entry) =>
        entry.type === "diff"
            ? [diffToAiFileDiff(entry, toolKind, normalizePath)]
            : [],
    );
}

export function shouldSuppressToolActivityUpdate(
    update: Pick<ToolCall | ToolCallUpdate, "_meta" | "toolCallId">,
    title: string | null,
): boolean {
    if (!title || !SUPPRESSED_STATUS_TITLES.has(title)) {
        return false;
    }

    const isStatusActivity =
        update.toolCallId.startsWith(CODEX_ACP_STATUS_EVENT_ID_PREFIX) ||
        update.toolCallId.startsWith(COMANDO_STATUS_EVENT_ID_PREFIX);
    const isTurnActivity =
        update.toolCallId.startsWith(CODEX_ACP_STATUS_TURN_EVENT_ID_PREFIX) ||
        update.toolCallId.startsWith(COMANDO_STATUS_TURN_EVENT_ID_PREFIX);
    if (isStatusActivity && !isTurnActivity) {
        return true;
    }

    if (
        readDiffMetaString(
            update._meta,
            CODEX_ACP_STATUS_EVENT_TYPE_KEY,
            COMANDO_STATUS_EVENT_TYPE_KEY,
        ) === CODEX_ACP_STATUS_EVENT_TYPE
    ) {
        return true;
    }

    return false;
}

export function diffToAiFileDiff(
    diff: Diff,
    toolKind: string,
    normalizePath: (candidatePath: string) => string = (candidatePath) =>
        candidatePath,
): AiFileDiff {
    const previousPathValue = readDiffMetaString(
        diff._meta,
        CODEX_ACP_DIFF_PREVIOUS_PATH_KEY,
        COMANDO_DIFF_PREVIOUS_PATH_KEY,
    );
    const path = normalizePath(diff.path);
    const previousPath = previousPathValue
        ? normalizePath(previousPathValue)
        : null;
    const kind = inferDiffKind(diff, toolKind, previousPath);
    const oldText = normalizeOldText(diff.oldText ?? null);
    const newText = normalizeNewText(kind, diff.newText ?? null);

    return {
        hunks: computeTextDiffHunks(path, oldText, newText),
        isText: true,
        kind,
        newText,
        oldText,
        path,
        previousPath,
        reversible: isDiffReversible(kind, oldText),
    };
}

function diffToTrackedFile(
    snapshot: AiSessionSnapshot,
    diff: Diff,
    toolKind: string,
    toolCallId: string,
    updatedAt: string,
    normalizePath: (candidatePath: string) => string = (candidatePath) =>
        candidatePath,
): AiTrackedFile {
    const fileDiff = diffToAiFileDiff(diff, toolKind, normalizePath);

    return syncTrackedFile({
        identityKey: fileDiff.previousPath
            ? `${fileDiff.previousPath}->${fileDiff.path}`
            : fileDiff.path,
        currentText: fileDiff.newText ?? "",
        diffBase: fileDiff.oldText ?? "",
        hunks: fileDiff.hunks,
        isText: true,
        kind: fileDiff.kind,
        newText: fileDiff.newText,
        oldText: fileDiff.oldText,
        path: fileDiff.path,
        previousPath: fileDiff.previousPath,
        reviewState: "pending",
        reversible: fileDiff.reversible,
        sessionId: snapshot.sessionId,
        toolCallId,
        updatedAt,
        version: 1,
    });
}

function inferDiffKind(
    diff: Diff,
    toolKind: string,
    previousPath: string | null,
): AiTrackedFile["kind"] {
    if (previousPath || toolKind === "move") {
        return "move";
    }

    if (
        toolKind === "delete" ||
        (diff.oldText !== null &&
            diff.oldText !== undefined &&
            diff.newText == null)
    ) {
        return "delete";
    }

    if (diff.oldText == null) {
        return "create";
    }

    return "update";
}

function normalizeOldText(value: string | null): string | null {
    if (value === "[file deleted]") {
        return null;
    }

    return value;
}

function normalizeNewText(
    kind: AiTrackedFile["kind"],
    value: string | null,
): string | null {
    if (kind === "delete") {
        return null;
    }

    return value ?? "";
}

function computeTextDiffHunks(
    path: string,
    oldText: string | null,
    newText: string | null,
) {
    if (oldText === null && newText === null) {
        return [];
    }

    return computeDiffHunks(oldText ?? "", newText ?? "", path);
}

function isDiffReversible(
    kind: AiTrackedFile["kind"],
    oldText: string | null,
): boolean {
    if (kind === "create") {
        return true;
    }

    return oldText !== null;
}

function parseUserInputRequest(
    snapshot: AiSessionSnapshot,
    update: ToolCall | ToolCallUpdate,
    updatedAt: string,
): AiUserInputRequest | null {
    if (
        readDiffMetaString(
            update._meta,
            CODEX_ACP_STATUS_EVENT_TYPE_KEY,
            COMANDO_STATUS_EVENT_TYPE_KEY,
        ) !== CODEX_ACP_USER_INPUT_EVENT_TYPE ||
        !isRecord(update.rawInput)
    ) {
        return null;
    }

    const questionsValue = update.rawInput.questions;
    if (!Array.isArray(questionsValue)) {
        return null;
    }

    const questions = questionsValue
        .map((question, index) => parseUserInputQuestion(question, index))
        .filter((question): question is NonNullable<typeof question> =>
            Boolean(question),
        );
    if (questions.length === 0) {
        return null;
    }

    const headerTitle = questions
        .find((question) => question.header.trim().length > 0)
        ?.header.trim();
    const requestId =
        typeof update.rawInput.request_id === "string" &&
        update.rawInput.request_id.trim().length > 0
            ? update.rawInput.request_id
            : update.toolCallId;
    const turnId =
        typeof update.rawInput.turn_id === "string" &&
        update.rawInput.turn_id.trim().length > 0
            ? update.rawInput.turn_id
            : requestId;
    if (!turnId) {
        return null;
    }

    return {
        questions,
        requestId,
        sessionId: snapshot.sessionId,
        title:
            headerTitle ||
            (update.title ?? snapshot.title).trim() ||
            "Input requested",
        toolCallId: update.toolCallId,
        turnId,
        updatedAt,
    };
}

function parseUserInputQuestion(
    value: unknown,
    index: number,
): AiUserInputRequest["questions"][number] | null {
    if (!isRecord(value)) {
        return null;
    }

    const options = Array.isArray(value.options)
        ? value.options
              .map((option) => {
                  if (!isRecord(option) || typeof option.label !== "string") {
                      return null;
                  }

                  return {
                      description:
                          typeof option.description === "string"
                              ? option.description
                              : null,
                      label: option.label,
                  };
              })
              .filter((option): option is NonNullable<typeof option> =>
                  Boolean(option),
              )
        : [];

    return {
        header: typeof value.header === "string" ? value.header : "",
        id:
            typeof value.id === "string" && value.id.trim().length > 0
                ? value.id
                : `question-${index + 1}`,
        isOther: value.is_other === true,
        isSecret: value.is_secret === true,
        options,
        question:
            typeof value.question === "string"
                ? value.question
                : typeof value.label === "string"
                  ? value.label
                  : "Provide the requested input.",
    };
}

function readDiffMetaString(
    meta: unknown,
    ...keys: readonly string[]
): string | null {
    if (!isRecord(meta)) {
        return null;
    }

    for (const key of keys) {
        const value = meta[key];
        if (typeof value === "string" && value.trim().length > 0) {
            return value;
        }
    }

    return null;
}

function readRecordString(
    record: Record<string, unknown> | null,
    key: string,
): string | null {
    const value = record?.[key];
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null;
}

function mapToolStatusToImageStatus(
    status: ToolCall["status"] | ToolCallUpdate["status"] | null | undefined,
): string | null {
    switch (status) {
        case "completed":
            return "completed";
        case "failed":
            return "failed";
        case "in_progress":
            return "in_progress";
        case "pending":
            return "pending";
        case null:
        case undefined:
            return null;
        default:
            return null;
    }
}

function normalizeImageGenerationStatus(status: string): string {
    const normalized = status.trim().toLowerCase();
    return normalized.length > 0 ? normalized : "in_progress";
}

function isActiveImageGenerationStatus(status: string): boolean {
    return (
        status === "pending" ||
        status === "in_progress" ||
        status === "running"
    );
}

function isTerminalImageFailureStatus(status: string): boolean {
    return (
        status === "failed" ||
        status === "error" ||
        status === "cancelled" ||
        status === "canceled"
    );
}

function imageGenerationTitle(status: string, error: string | null): string {
    if (isActiveImageGenerationStatus(status)) {
        return "Generating image";
    }

    if (isTerminalImageFailureStatus(status) || error) {
        return "Image generation failed";
    }

    return "Generated image";
}

function imageGenerationContent(image: AiGeneratedImage): string {
    if (isActiveImageGenerationStatus(image.status)) {
        return "Generating image...";
    }

    if (isTerminalImageFailureStatus(image.status) || image.error) {
        return "Image generation failed";
    }

    return "Generated image";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function stringifyJson(value: unknown): string | null {
    if (value === undefined) {
        return null;
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        debugBenignError("ai.service.stringifyJson", error);
        return null;
    }
}

function buildToolSummary(
    title: string,
    content: readonly ToolCallContent[] | null | undefined,
    kind: string,
    rawInput: unknown,
    rawOutput: unknown,
): string | null {
    const diffCount = (content ?? []).filter(
        (entry) => entry.type === "diff",
    ).length;

    if (diffCount > 0) {
        return `${title} · ${diffCount} diff${diffCount === 1 ? "" : "s"}`;
    }

    const terminalCount = (content ?? []).filter(
        (entry) => entry.type === "terminal",
    ).length;
    if (terminalCount > 0) {
        return `${title} · terminal session`;
    }

    const lk = kind.toLowerCase();
    const input =
        rawInput && typeof rawInput === "object"
            ? (rawInput as Record<string, unknown>)
            : null;

    if (lk === "bash" || lk === "shell" || lk === "execute") {
        const cmd = input?.command;
        if (typeof cmd === "string") {
            const firstLine = cmd.split("\n")[0];
            const preview =
                firstLine.length > 80
                    ? firstLine.slice(0, 77) + "…"
                    : firstLine;
            return preview;
        }
    }

    if (lk === "read") {
        const filePath = input?.file_path ?? input?.path;
        if (typeof filePath === "string") {
            const segments = filePath.split("/");
            return segments.length > 2
                ? `…/${segments.slice(-2).join("/")}`
                : filePath;
        }
    }

    if (lk === "search" || lk === "grep") {
        const pattern = input?.pattern ?? input?.query ?? input?.regex;
        if (typeof pattern === "string") {
            return `"${pattern}"`;
        }
    }

    if (lk === "web_fetch" || lk === "fetch") {
        const url = input?.url;
        if (typeof url === "string") {
            try {
                const parsed = new URL(url);
                return parsed.hostname + parsed.pathname;
            } catch (error) {
                debugBenignError("ai.service.toolSummary.parseUrl", error);
                return url.length > 60 ? url.slice(0, 57) + "…" : url;
            }
        }
    }

    if (rawOutput !== undefined && rawOutput !== null) {
        const outputStr =
            typeof rawOutput === "string"
                ? rawOutput
                : JSON.stringify(rawOutput);
        if (outputStr.length > 0 && outputStr.length <= 100) {
            return outputStr;
        }
        if (outputStr.length > 100) {
            const lines = outputStr.split("\n").length;
            return `${lines} line${lines === 1 ? "" : "s"} of output`;
        }
    }

    return null;
}

export function normalizeTrackedDiffPath(
    liveSession: Pick<LiveAcpSession, "cwd" | "projectRoot">,
    candidatePath: string,
): string {
    const scopeRoot = liveSession.projectRoot ?? liveSession.cwd;
    const absolutePath = path.isAbsolute(candidatePath)
        ? path.resolve(candidatePath)
        : path.resolve(scopeRoot, candidatePath);

    if (
        absolutePath === scopeRoot ||
        absolutePath.startsWith(`${scopeRoot}${path.sep}`)
    ) {
        const relativePath = path.relative(scopeRoot, absolutePath);
        return relativePath.length > 0
            ? toPosixPath(relativePath)
            : toPosixPath(path.basename(absolutePath));
    }

    return path.isAbsolute(candidatePath)
        ? absolutePath
        : toPosixPath(candidatePath);
}

export async function readTextIfExists(
    absolutePath: string,
): Promise<string | null> {
    try {
        return await fs.promises.readFile(absolutePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }

        throw error;
    }
}

function resolveTrackedDiffAbsolutePath(
    liveSession: Pick<LiveAcpSession, "cwd" | "projectRoot">,
    trackedPath: string,
): string {
    const scopeRoot = liveSession.projectRoot ?? liveSession.cwd;
    return path.isAbsolute(trackedPath)
        ? path.resolve(trackedPath)
        : path.resolve(scopeRoot, trackedPath);
}

function tryReadFileAsText(absolutePath: string): string | null {
    try {
        const stats = fs.statSync(absolutePath);
        if (!stats.isFile() || stats.size > TRACKED_DIFF_MAX_READ_BYTES) {
            return null;
        }
        return fs.readFileSync(absolutePath, "utf8");
    } catch (error) {
        debugBenignError("ai.service.tryReadFileAsText", error);
        return null;
    }
}

function isClaudeEditReEmission(
    diff: Pick<Diff, "newText" | "oldText">,
    existing: AiTrackedFile | undefined,
    base: string,
    context: DiffResolutionContext | undefined,
): boolean {
    if (!existing || !context || context.sessionUpdate !== "tool_call_update") {
        return false;
    }

    if (!existing.toolCallId || existing.toolCallId !== context.toolCallId) {
        return false;
    }

    if (!isRecord(context.meta) || !isRecord(context.meta.claudeCode)) {
        return false;
    }

    const toolName = context.meta.claudeCode.toolName;
    if (toolName !== "Edit") {
        return false;
    }

    const oldSnippet = diff.oldText ?? "";
    const newSnippet = diff.newText ?? "";
    if (oldSnippet.length === 0 && newSnippet.length === 0) {
        return false;
    }

    if (oldSnippet.length > 0 && base.includes(oldSnippet)) {
        return false;
    }

    return newSnippet.length === 0 || base.includes(newSnippet);
}

export function resolveDiffToFullTexts(
    diff: Diff,
    existing: AiTrackedFile | undefined,
    liveSession: Pick<LiveAcpSession, "cwd" | "projectRoot">,
    normalizedPath: string,
    context?: DiffResolutionContext,
): Diff {
    if (diff.oldText == null || diff.newText == null) {
        return diff;
    }

    const oldSnippet = diff.oldText;
    const newSnippet = diff.newText;
    const absolutePath = resolveTrackedDiffAbsolutePath(
        liveSession,
        normalizedPath,
    );
    const base = existing
        ? getTrackedFileCurrentText(existing)
        : ((context?.readOpenFileBuffer?.(absolutePath) ??
              readOpenFileBuffer(absolutePath)) ??
          tryReadFileAsText(absolutePath));
    if (base === null) {
        return diff;
    }

    const canonicalOldText = existing
        ? (existing.oldText ?? base)
        : base;

    if (oldSnippet === base) {
        return { ...diff, oldText: canonicalOldText, newText: newSnippet };
    }

    if (oldSnippet.length === 0) {
        return diff;
    }

    const first = base.indexOf(oldSnippet);
    if (first === -1 || first !== base.lastIndexOf(oldSnippet)) {
        if (existing && isClaudeEditReEmission(diff, existing, base, context)) {
            return {
                ...diff,
                oldText: getTrackedFileDiffBase(existing),
                newText: getTrackedFileCurrentText(existing),
            };
        }
        return diff;
    }

    const spliced =
        base.slice(0, first) +
        newSnippet +
        base.slice(first + oldSnippet.length);

    return { ...diff, oldText: canonicalOldText, newText: spliced };
}
