import fs from "node:fs";
import path from "node:path";

import type {
    Diff,
    ToolCall,
    ToolCallContent,
    ToolCallLocation,
    ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type {
    AiDiffHunk,
    AiGeneratedImage,
    AiFileDiff,
    AiToolActivity,
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
    CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE,
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
const PRE_EDIT_SNAPSHOT_MAX_ENTRIES = 128;
const TRACKED_DIFF_MAX_READ_BYTES = 5 * 1024 * 1024;

interface ClaudeStructuredPatchHunk {
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
    readonly lines: readonly string[];
}

interface ClaudeStructuredPatchDiffCandidate {
    readonly hunk: ClaudeStructuredPatchHunk;
    readonly newText: string;
    readonly oldText: string | null;
    readonly path: string;
}

interface DiffResolutionContext {
    readonly meta: unknown;
    readonly preEditSnapshot?: string;
    readonly readOpenFileBuffer?: (absolutePath: string) => string | null;
    readonly rawOutput?: unknown;
    readonly sessionUpdate: "tool_call" | "tool_call_update";
    readonly toolCallId: string;
}

export function mapToolCallUpdate(
    liveSession: Pick<
        LiveAcpSession,
        "cwd" | "projectRoot" | "processedDiffPaths" | "terminalOutputBuffers"
    > & {
        readonly preEditSnapshots?: Map<string, string>;
    },
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
    const shouldCollectReviewDiffs = !isSubagentBreadcrumbToolUpdate(update);
    const pathsProcessedInThisUpdate = new Set<string>();
    rememberReadSnapshotFromToolUpdate(
        liveSession,
        toolKind,
        update.rawInput,
        update.rawOutput,
        normalizeDiffPath,
    );
    const updateLocations =
        update.locations?.map(normalizeToolCallLocation) ?? null;
    const readInputLocations = deriveReadInputLocation(
        toolKind,
        update.rawInput,
    );
    const nextLocations = mergeToolActivityLocations(
        updateLocations,
        readInputLocations,
    );
    const anchoredHunksByContentIndex =
        content && shouldCollectReviewDiffs
            ? buildClaudeStructuredPatchHunksByContentIndex(
                  content,
                  update._meta,
                  normalizeDiffPath,
              )
            : new Map<number, readonly AiDiffHunk[]>();

    const nextActivity = {
        ...(existing?.action ? { action: existing.action } : {}),
        createdAt: existing?.createdAt ?? updatedAt,
        diffs: content && shouldCollectReviewDiffs
            ? collectDiffs(
                  content,
                  toolKind,
                  normalizeDiffPath,
                  anchoredHunksByContentIndex,
              )
            : (existing?.diffs ?? []),
        exitCode,
        id: update.toolCallId,
        kind: toolKind,
        locations: nextLocations ?? existing?.locations ?? [],
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

    const nextTrackedFiles = content && shouldCollectReviewDiffs
        ? content.reduce((acc, entry, contentIndex) => {
              if (entry.type !== "diff") {
                  return acc;
              }
              const normalizedPath = normalizeDiffPath(entry.path);
              const processedPaths =
                  liveSession.processedDiffPaths.get(update.toolCallId);
              if (
                  processedPaths?.has(normalizedPath) &&
                  !pathsProcessedInThisUpdate.has(normalizedPath)
              ) {
                  return acc;
              }
              pathsProcessedInThisUpdate.add(normalizedPath);

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
                      preEditSnapshot:
                          liveSession.preEditSnapshots?.get(normalizedPath),
                      rawOutput: update.rawOutput,
                      readOpenFileBuffer: options.readOpenFileBuffer,
                      sessionUpdate: updateKind,
                      toolCallId: update.toolCallId,
                  },
              );
              const anchoredHunks =
                  anchoredHunksByContentIndex.get(contentIndex) ?? null;
              if (
                  shouldDedupResolvedDiff(entry, resolvedDiff) ||
                  anchoredHunks !== null
              ) {
                  if (processedPaths) {
                      processedPaths.add(normalizedPath);
                  } else {
                      liveSession.processedDiffPaths.set(
                          update.toolCallId,
                          new Set([normalizedPath]),
                      );
                  }
              }
              return upsertTrackedFile(
                  acc,
                  diffToTrackedFile(
                      snapshot,
                      resolvedDiff,
                      toolKind,
                      update.toolCallId,
                      updatedAt,
                      anchoredHunks,
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
    anchoredHunksByContentIndex: ReadonlyMap<
        number,
        readonly AiDiffHunk[]
    > = new Map(),
): readonly AiFileDiff[] {
    return (content ?? []).flatMap((entry, contentIndex) =>
        entry.type === "diff"
            ? [
                  diffToAiFileDiff(
                      entry,
                      toolKind,
                      normalizePath,
                      anchoredHunksByContentIndex.get(contentIndex) ?? null,
                  ),
              ]
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

function isSubagentBreadcrumbToolUpdate(
    update: Pick<ToolCall | ToolCallUpdate, "_meta">,
): boolean {
    return (
        readDiffMetaString(
            update._meta,
            CODEX_ACP_STATUS_EVENT_TYPE_KEY,
            COMANDO_STATUS_EVENT_TYPE_KEY,
        ) === CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE
    );
}

export function diffToAiFileDiff(
    diff: Diff,
    toolKind: string,
    normalizePath: (candidatePath: string) => string = (candidatePath) =>
        candidatePath,
    anchoredHunks: readonly AiDiffHunk[] | null = null,
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
        hunks: anchoredHunks ?? computeTextDiffHunks(path, oldText, newText),
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
    anchoredHunks: readonly AiDiffHunk[] | null,
    normalizePath: (candidatePath: string) => string = (candidatePath) =>
        candidatePath,
): AiTrackedFile {
    const fileDiff = diffToAiFileDiff(
        diff,
        toolKind,
        normalizePath,
        anchoredHunks,
    );
    const hunksAreAnchored = anchoredHunks !== null;

    return syncTrackedFile({
        identityKey: fileDiff.previousPath
            ? `${fileDiff.previousPath}->${fileDiff.path}`
            : fileDiff.path,
        currentText: fileDiff.newText ?? "",
        diffBase: fileDiff.oldText ?? "",
        hunks: fileDiff.hunks,
        hunksAreAnchored,
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

function buildClaudeStructuredPatchHunksByContentIndex(
    content: readonly ToolCallContent[],
    meta: unknown,
    normalizePath: (candidatePath: string) => string,
): Map<number, readonly AiDiffHunk[]> {
    const candidates = readClaudeStructuredPatchDiffCandidates(
        meta,
        normalizePath,
    );
    const anchoredHunksByContentIndex = new Map<
        number,
        readonly AiDiffHunk[]
    >();
    if (candidates.length === 0) {
        return anchoredHunksByContentIndex;
    }

    const usedCandidateIndexes = new Set<number>();
    content.forEach((entry, contentIndex) => {
        if (entry.type !== "diff") {
            return;
        }

        const path = normalizePath(entry.path);
        const oldText = entry.oldText ?? null;
        const newText = entry.newText;
        const candidateIndex = candidates.findIndex(
            (candidate, index) =>
                !usedCandidateIndexes.has(index) &&
                candidate.path === path &&
                candidate.oldText === oldText &&
                candidate.newText === newText,
        );
        if (candidateIndex === -1) {
            return;
        }

        usedCandidateIndexes.add(candidateIndex);
        const candidate = candidates[candidateIndex];
        const hunks = claudeStructuredPatchToAiDiffHunks(
            [candidate.hunk],
            path,
        );
        if (hunks) {
            anchoredHunksByContentIndex.set(contentIndex, hunks);
        }
    });

    return anchoredHunksByContentIndex;
}

function readClaudeStructuredPatchDiffCandidates(
    meta: unknown,
    normalizePath: (candidatePath: string) => string,
): readonly ClaudeStructuredPatchDiffCandidate[] {
    if (!isRecord(meta) || !isRecord(meta.claudeCode)) {
        return [];
    }

    const toolName = meta.claudeCode.toolName;
    if (toolName !== "Edit" && toolName !== "Write") {
        return [];
    }

    const toolResponse = meta.claudeCode.toolResponse;
    if (!isRecord(toolResponse)) {
        return [];
    }

    const filePath =
        typeof toolResponse.filePath === "string" &&
        toolResponse.filePath.trim().length > 0
            ? toolResponse.filePath
            : null;
    if (!filePath || !Array.isArray(toolResponse.structuredPatch)) {
        return [];
    }

    const path = normalizePath(filePath);
    return toolResponse.structuredPatch.flatMap((candidate) => {
        const hunk = readClaudeStructuredPatchHunk(candidate);
        if (!hunk) {
            return [];
        }

        const diffTexts = claudeStructuredPatchHunkToDiffTexts(hunk);
        if (!diffTexts) {
            return [];
        }

        return [{ ...diffTexts, hunk, path }];
    });
}

function readClaudeStructuredPatchHunk(
    candidate: unknown,
): ClaudeStructuredPatchHunk | null {
    if (!isRecord(candidate) || !Array.isArray(candidate.lines)) {
        return null;
    }

    const oldStart = readFiniteNumber(candidate.oldStart);
    const oldLines = readFiniteNumber(candidate.oldLines);
    const newStart = readFiniteNumber(candidate.newStart);
    const newLines = readFiniteNumber(candidate.newLines);
    if (
        oldStart === null ||
        oldLines === null ||
        newStart === null ||
        newLines === null
    ) {
        return null;
    }

    return {
        lines: candidate.lines.filter(
            (line): line is string => typeof line === "string",
        ),
        newLines: Math.max(0, Math.trunc(newLines)),
        newStart: Math.max(1, Math.trunc(newStart)),
        oldLines: Math.max(0, Math.trunc(oldLines)),
        oldStart: Math.max(1, Math.trunc(oldStart)),
    };
}

function claudeStructuredPatchHunkToDiffTexts(
    hunk: ClaudeStructuredPatchHunk,
): Pick<ClaudeStructuredPatchDiffCandidate, "newText" | "oldText"> | null {
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const line of hunk.lines) {
        if (line.startsWith("-")) {
            oldText.push(line.slice(1));
        } else if (line.startsWith("+")) {
            newText.push(line.slice(1));
        } else {
            oldText.push(line.slice(1));
            newText.push(line.slice(1));
        }
    }

    if (oldText.length === 0 && newText.length === 0) {
        return null;
    }

    return {
        newText: newText.join("\n"),
        oldText: oldText.join("\n") || null,
    };
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function claudeStructuredPatchToAiDiffHunks(
    structuredPatch: readonly ClaudeStructuredPatchHunk[],
    path: string,
): readonly AiDiffHunk[] | null {
    const hunks = structuredPatch.flatMap((hunk, hunkIndex) => {
        const hunkId = `anchored-diff:${path}:${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`;
        const lines = hunk.lines.flatMap((rawLine, lineIndex) => {
            if (rawLine === "\\ No newline at end of file") {
                return [];
            }

            const marker = rawLine[0];
            const text = marker === "+" || marker === "-" || marker === " "
                ? rawLine.slice(1)
                : rawLine;
            const type: AiDiffHunk["lines"][number]["type"] = marker === "+"
                ? "add"
                : marker === "-"
                  ? "remove"
                  : "context";

            return [
                {
                    id: `${hunkId}:line:${lineIndex}`,
                    text,
                    type,
                },
            ];
        });

        if (lines.length === 0) {
            return [];
        }

        return [
            {
                id: hunkId,
                lines,
                newCount: hunk.newLines,
                newStart: hunk.newStart,
                oldCount: hunk.oldLines,
                oldStart: hunk.oldStart,
                visualEndLine: hunk.newStart + Math.max(hunk.newLines, 1) - 1,
                visualStartLine: hunk.newStart,
            },
        ];
    });

    return hunks.length > 0 ? hunks : null;
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

function normalizeToolCallLocation(location: ToolCallLocation) {
    const line = normalizeNonNegativeLineNumber(location.line);

    return {
        endLine: null,
        line,
        path: location.path,
    };
}

function deriveReadInputLocation(
    kind: string,
    rawInput: unknown,
): AiToolActivity["locations"] | null {
    if (kind.toLowerCase() !== "read" || !isRecord(rawInput)) {
        return null;
    }

    const pathValue = rawInput.file_path ?? rawInput.filePath ?? rawInput.path;
    if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
        return null;
    }
    const locationPath = pathValue.trim();

    const line = normalizeNonNegativeLineNumber(
        rawInput.line ??
            rawInput.startLine ??
            rawInput.start_line ??
            rawInput.offset,
    );
    const limit = normalizeNonNegativeLineNumber(rawInput.limit);
    const endLine =
        line !== null && limit !== null && limit > 1 ? line + limit - 1 : null;

    return [
        {
            endLine,
            line,
            path: locationPath,
        },
    ];
}

function mergeToolActivityLocations(
    primary: AiToolActivity["locations"] | null,
    fallback: AiToolActivity["locations"] | null,
): AiToolActivity["locations"] | null {
    if (primary && primary.length > 0) {
        if (!fallback || fallback.length === 0) {
            return primary;
        }

        return primary.map((location) => {
            if (location.line !== null) {
                return location;
            }

            const fallbackLocation = fallback.find(
                (candidate) => candidate.path === location.path,
            );
            if (!fallbackLocation) {
                return location;
            }

            return {
                ...location,
                endLine: fallbackLocation.endLine,
                line: fallbackLocation.line,
            };
        });
    }

    return fallback && fallback.length > 0 ? fallback : null;
}

function normalizeNonNegativeLineNumber(value: unknown): number | null {
    if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0
    ) {
        return null;
    }

    return value;
}

function rememberReadSnapshotFromToolUpdate(
    liveSession: { readonly preEditSnapshots?: Map<string, string> },
    toolKind: string,
    rawInput: unknown,
    rawOutput: unknown,
    normalizePath: (candidatePath: string) => string,
): void {
    if (toolKind.toLowerCase() !== "read" || !isRecord(rawInput)) {
        return;
    }

    const pathValue = rawInput.file_path ?? rawInput.filePath ?? rawInput.path;
    if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
        return;
    }

    const snapshot = parseCompleteNumberedFileOutput(rawOutput);
    if (snapshot === null || snapshot.length > TRACKED_DIFF_MAX_READ_BYTES) {
        return;
    }

    const snapshots = liveSession.preEditSnapshots;
    if (!snapshots) {
        return;
    }

    const normalizedPath = normalizePath(pathValue);
    if (snapshots.has(normalizedPath)) {
        return;
    }

    if (snapshots.size >= PRE_EDIT_SNAPSHOT_MAX_ENTRIES) {
        const oldestKey = snapshots.keys().next().value;
        if (oldestKey !== undefined) {
            snapshots.delete(oldestKey);
        }
    }

    snapshots.set(normalizedPath, snapshot);
}

function parseCompleteNumberedFileOutput(rawOutput: unknown): string | null {
    const output =
        typeof rawOutput === "string"
            ? rawOutput
            : isRecord(rawOutput) && typeof rawOutput.output === "string"
              ? rawOutput.output
              : null;
    if (!output) {
        return null;
    }

    const contentStart = output.indexOf("<content>");
    const contentEnd = output.lastIndexOf("</content>");
    if (contentStart === -1 || contentEnd === -1 || contentEnd <= contentStart) {
        return null;
    }

    const body = output
        .slice(contentStart + "<content>".length, contentEnd)
        .replace(/^\r?\n/, "")
        .replace(/\r\n/g, "\n");
    const lines = body.split("\n");
    const footerIndex = lines.findIndex((line) =>
        /^\(End of file - total \d+ lines?\)$/.test(line.trim()),
    );
    if (footerIndex === -1) {
        return null;
    }

    const totalMatch = lines[footerIndex]
        ?.trim()
        .match(/^\(End of file - total (\d+) lines?\)$/);
    const totalLines = totalMatch ? Number(totalMatch[1]) : NaN;
    if (!Number.isInteger(totalLines) || totalLines < 0) {
        return null;
    }

    const numberedLines = lines.slice(0, footerIndex);
    while (numberedLines.at(-1) === "") {
        numberedLines.pop();
    }

    if (numberedLines.length !== totalLines) {
        return null;
    }

    const contentLines: string[] = [];
    for (let index = 0; index < numberedLines.length; index += 1) {
        const expectedLineNumber = index + 1;
        const line = numberedLines[index] ?? "";
        const match = line.match(/^(\d+): ?(.*)$/);
        if (!match || Number(match[1]) !== expectedLineNumber) {
            return null;
        }
        contentLines.push(match[2]);
    }

    return contentLines.join("\n");
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

function isAlreadyAppliedSnippetDiff(
    diff: { readonly newText: string; readonly oldText: string },
    existing: AiTrackedFile | undefined,
    base: string,
    context: DiffResolutionContext | undefined,
): boolean {
    if (!existing || !context) {
        return false;
    }

    if (existing.toolCallId && existing.toolCallId !== context.toolCallId) {
        return false;
    }

    const oldSnippet = diff.oldText;
    const newSnippet = diff.newText;
    if (oldSnippet.length === 0 && newSnippet.length === 0) {
        return false;
    }

    if (oldSnippet.length > 0 && base.includes(oldSnippet)) {
        return false;
    }

    const diffBase = getTrackedFileDiffBase(existing);
    if (oldSnippet.length > 0 && !diffBase.includes(oldSnippet)) {
        return false;
    }

    return newSnippet.length === 0 || base.includes(newSnippet);
}

function resolveAlreadyAppliedPreEditSnapshotDiff(
    diff: { readonly newText: string; readonly oldText: string },
    base: string,
    preEditSnapshot: string | undefined,
): { readonly newText: string; readonly oldText: string } | null {
    if (!preEditSnapshot || diff.oldText.length === 0) {
        return null;
    }

    const first = preEditSnapshot.indexOf(diff.oldText);
    if (
        first === -1 ||
        first !== preEditSnapshot.lastIndexOf(diff.oldText)
    ) {
        return null;
    }

    const spliced =
        preEditSnapshot.slice(0, first) +
        diff.newText +
        preEditSnapshot.slice(first + diff.oldText.length);
    if (spliced !== base) {
        return null;
    }

    return {
        oldText: preEditSnapshot,
        newText: base,
    };
}

interface UnifiedPatchHunk {
    readonly oldStart: number;
    readonly newStart: number;
    readonly lines: readonly string[];
}

function resolveAlreadyAppliedUnifiedPatchDiff(
    diff: { readonly newText: string; readonly oldText: string },
    base: string,
    liveSession: Pick<LiveAcpSession, "cwd" | "projectRoot">,
    normalizedPath: string,
    rawOutput: unknown,
): { readonly newText: string; readonly oldText: string } | null {
    const patch = readOpenCodeFileDiffPatch(rawOutput);
    if (!patch) {
        return null;
    }

    const patchPath = readOpenCodeFileDiffPath(rawOutput);
    if (patchPath) {
        const normalizedPatchPath = normalizeTrackedDiffPath(
            liveSession,
            patchPath,
        );
        if (normalizedPatchPath !== normalizedPath) {
            return null;
        }
    }

    const hunks = parseUnifiedPatchHunks(patch);
    if (hunks.length === 0) {
        return null;
    }

    const oldText = applyUnifiedPatch(base, hunks, "reverse");
    if (oldText === null) {
        return null;
    }

    const validatedBase = applyUnifiedPatch(oldText, hunks, "forward");
    if (validatedBase !== base) {
        return null;
    }

    if (diff.oldText.length > 0 && !oldText.includes(diff.oldText)) {
        return null;
    }

    if (diff.newText.length > 0 && !base.includes(diff.newText)) {
        return null;
    }

    return { oldText, newText: base };
}

function readOpenCodeFileDiffPatch(rawOutput: unknown): string | null {
    if (!isRecord(rawOutput) || !isRecord(rawOutput.metadata)) {
        return null;
    }

    const filediff = rawOutput.metadata.filediff;
    if (!isRecord(filediff) || typeof filediff.patch !== "string") {
        return null;
    }

    return filediff.patch;
}

function readOpenCodeFileDiffPath(rawOutput: unknown): string | null {
    if (!isRecord(rawOutput) || !isRecord(rawOutput.metadata)) {
        return null;
    }

    const filediff = rawOutput.metadata.filediff;
    return isRecord(filediff) && typeof filediff.file === "string"
        ? filediff.file
        : null;
}

function parseUnifiedPatchHunks(patch: string): UnifiedPatchHunk[] {
    const hunks: UnifiedPatchHunk[] = [];
    const lines = patch.replace(/\r\n/g, "\n").split("\n");
    let current: { oldStart: number; newStart: number; lines: string[] } | null =
        null;

    for (const line of lines) {
        const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (header) {
            if (current) {
                hunks.push(current);
            }
            current = {
                lines: [],
                newStart: Number(header[2]),
                oldStart: Number(header[1]),
            };
            continue;
        }

        if (!current) {
            continue;
        }

        if (
            line.startsWith(" ") ||
            line.startsWith("-") ||
            line.startsWith("+")
        ) {
            current.lines.push(line);
        }
    }

    if (current) {
        hunks.push(current);
    }

    return hunks.filter(
        (hunk) =>
            Number.isInteger(hunk.oldStart) &&
            Number.isInteger(hunk.newStart) &&
            hunk.lines.length > 0,
    );
}

function applyUnifiedPatch(
    text: string,
    hunks: readonly UnifiedPatchHunk[],
    direction: "forward" | "reverse",
): string | null {
    let lines = splitPatchTextLines(text);
    const orderedHunks = [...hunks].reverse();

    for (const hunk of orderedHunks) {
        const matchLines =
            direction === "forward"
                ? getUnifiedPatchOldLines(hunk)
                : getUnifiedPatchNewLines(hunk);
        const replacementLines =
            direction === "forward"
                ? getUnifiedPatchNewLines(hunk)
                : getUnifiedPatchOldLines(hunk);
        const preferredIndex =
            Math.max(
                1,
                direction === "forward" ? hunk.oldStart : hunk.newStart,
            ) - 1;
        const matchIndex = findPatchLineSequence(
            lines,
            matchLines,
            preferredIndex,
        );
        if (matchIndex === null) {
            return null;
        }

        lines = [
            ...lines.slice(0, matchIndex),
            ...replacementLines,
            ...lines.slice(matchIndex + matchLines.length),
        ];
    }

    return joinPatchTextLines(lines, text.endsWith("\n"));
}

function splitPatchTextLines(text: string): string[] {
    if (text.length === 0) {
        return [];
    }

    const lines = text.split("\n");
    if (text.endsWith("\n")) {
        lines.pop();
    }
    return lines;
}

function joinPatchTextLines(
    lines: readonly string[],
    trailingNewline: boolean,
): string {
    if (lines.length === 0) {
        return trailingNewline ? "\n" : "";
    }

    return lines.join("\n") + (trailingNewline ? "\n" : "");
}

function getUnifiedPatchOldLines(hunk: UnifiedPatchHunk): string[] {
    return hunk.lines
        .filter((line) => line.startsWith(" ") || line.startsWith("-"))
        .map((line) => line.slice(1));
}

function getUnifiedPatchNewLines(hunk: UnifiedPatchHunk): string[] {
    return hunk.lines
        .filter((line) => line.startsWith(" ") || line.startsWith("+"))
        .map((line) => line.slice(1));
}

function findPatchLineSequence(
    lines: readonly string[],
    sequence: readonly string[],
    preferredIndex: number,
): number | null {
    if (sequence.length === 0) {
        return Math.min(Math.max(preferredIndex, 0), lines.length);
    }

    if (matchesPatchLineSequence(lines, sequence, preferredIndex)) {
        return preferredIndex;
    }

    let matchIndex: number | null = null;
    for (let index = 0; index <= lines.length - sequence.length; index += 1) {
        if (!matchesPatchLineSequence(lines, sequence, index)) {
            continue;
        }

        if (matchIndex !== null) {
            return null;
        }
        matchIndex = index;
    }

    return matchIndex;
}

function matchesPatchLineSequence(
    lines: readonly string[],
    sequence: readonly string[],
    index: number,
): boolean {
    if (index < 0 || index + sequence.length > lines.length) {
        return false;
    }

    return sequence.every((line, offset) => lines[index + offset] === line);
}

function shouldDedupResolvedDiff(original: Diff, resolved: Diff): boolean {
    return (
        resolved !== original &&
        (resolved.oldText !== original.oldText ||
            resolved.newText !== original.newText)
    );
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
        if (!existing && first === -1) {
            const resolvedFromUnifiedPatch =
                resolveAlreadyAppliedUnifiedPatchDiff(
                    { newText: newSnippet, oldText: oldSnippet },
                    base,
                    liveSession,
                    normalizedPath,
                    context?.rawOutput,
                );
            if (resolvedFromUnifiedPatch) {
                return {
                    ...diff,
                    oldText: resolvedFromUnifiedPatch.oldText,
                    newText: resolvedFromUnifiedPatch.newText,
                };
            }

            const resolvedFromPreEditSnapshot =
                resolveAlreadyAppliedPreEditSnapshotDiff(
                    { newText: newSnippet, oldText: oldSnippet },
                    base,
                    context?.preEditSnapshot,
                );
            if (resolvedFromPreEditSnapshot) {
                return {
                    ...diff,
                    oldText: resolvedFromPreEditSnapshot.oldText,
                    newText: resolvedFromPreEditSnapshot.newText,
                };
            }
        }
        if (
            existing &&
            (isClaudeEditReEmission(diff, existing, base, context) ||
                isAlreadyAppliedSnippetDiff(
                    { newText: newSnippet, oldText: oldSnippet },
                    existing,
                    base,
                    context,
                ))
        ) {
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
