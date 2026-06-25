import fs from "node:fs";
import path from "node:path";

import type {
    AiDiffHunk,
    AiGeneratedImage,
    AiFileDiff,
    AiSessionSnapshot,
    AiTrackedFile,
} from "@shared/ipc";
import {
    computeDiffHunks,
    getTrackedFileCurrentText,
    getTrackedFileDiffBase,
    normalizeReviewText,
    syncTrackedFile,
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
    COMANDO_DIFF_PREVIOUS_PATH_KEY,
    COMANDO_STATUS_EVENT_ID_PREFIX,
    COMANDO_STATUS_EVENT_TYPE_KEY,
    COMANDO_STATUS_TURN_EVENT_ID_PREFIX,
    SUPPRESSED_STATUS_TITLES,
} from "./contracts";
import {
    basenameForPathIdentity,
    resolveSessionScopedPath,
    type ResolveSessionPathOptions,
    toPosixPath,
} from "./session-core";
import { debugBenignError } from "@main/observability/logging";

const TRACKED_DIFF_MAX_READ_BYTES = 5 * 1024 * 1024;

interface DiffResolutionContext {
    readonly meta: unknown;
    readonly preEditSnapshot?: string;
    readonly readOpenFileBuffer?: (absolutePath: string) => string | null;
    readonly rawOutput?: unknown;
    readonly sessionUpdate: "tool_call" | "tool_call_update";
    readonly toolCallId: string;
}

interface AiReviewPathContext {
    readonly cwd: string;
    readonly projectRoot: string | null;
}

interface AiReviewRuntimeDiff {
    readonly _meta?: unknown;
    readonly hunks?: readonly AiDiffHunk[];
    readonly newText: string;
    readonly oldText?: string | null;
    readonly path: string;
}

type AiReviewToolStatus = "completed" | "failed" | "in_progress" | "pending";

interface AiReviewToolUpdate {
    readonly _meta?: unknown;
    readonly rawInput?: unknown;
    readonly status?: AiReviewToolStatus | null;
    readonly title?: string | null;
    readonly toolCallId: string;
}

export function isImageGenerationToolUpdate(
    update: Pick<AiReviewToolUpdate, "_meta" | "toolCallId">,
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
    update: AiReviewToolUpdate,
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

export function shouldSuppressToolActivityUpdate(
    update: Pick<AiReviewToolUpdate, "_meta" | "toolCallId">,
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
    diff: AiReviewRuntimeDiff,
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
    const newText = normalizeNewText(kind, diff.newText);

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

function inferDiffKind(
    diff: AiReviewRuntimeDiff,
    toolKind: string,
    previousPath: string | null,
): AiTrackedFile["kind"] {
    if (previousPath || toolKind === "move") {
        return "move";
    }

    if (
        toolKind === "delete"
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
    status: AiReviewToolStatus | null | undefined,
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

// Parses the numbered file body that OpenCode's Read tool emits, for example:
//
//   <content>
//   1: alpha
//   2: beta
//   (End of file - total 2 lines)
//   </content>
//
// Returns the raw file contents (with newlines preserved) when the body is a
// complete, consistent snapshot, or null otherwise — including when the wrapper
// tags are missing, the trailing line count differs from the parsed numbered
// lines, or the numbering is not strictly 1..N. Callers treat null as "fall
// back to other diff-resolution paths" (filediff.patch, prior tracked state).
export function parseCompleteNumberedFileOutput(
    rawOutput: unknown,
): string | null {
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

export function normalizeTrackedDiffPath(
    liveSession: AiReviewPathContext,
    candidatePath: string,
    options: ResolveSessionPathOptions = {},
): string {
    const scopeRoot = liveSession.projectRoot ?? liveSession.cwd;
    const resolvedPath = resolveSessionScopedPath(
        scopeRoot,
        candidatePath,
        options,
    );

    if (resolvedPath.insideRoot) {
        return resolvedPath.relativePath && resolvedPath.relativePath.length > 0
            ? resolvedPath.relativePath
            : toPosixPath(
                  basenameForPathIdentity(
                      resolvedPath.absolutePath,
                      { platform: resolvedPath.platform },
                  ),
              );
    }

    return resolvedPath.isAbsoluteInput
        ? resolvedPath.absolutePath
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

export interface ReconcilePendingTrackedFilesInput {
    readonly onError?: (error: unknown, trackedFile: AiTrackedFile) => void;
    readonly readTrackedFileText: (trackedPath: string) => Promise<string | null>;
    readonly trackedFiles: readonly AiTrackedFile[];
}

export interface ReconcilePendingTrackedFilesResult {
    readonly changed: boolean;
    readonly trackedFiles: readonly AiTrackedFile[];
}

export async function reconcilePendingTrackedFiles(
    input: ReconcilePendingTrackedFilesInput,
): Promise<ReconcilePendingTrackedFilesResult> {
    if (input.trackedFiles.length === 0) {
        return {
            changed: false,
            trackedFiles: input.trackedFiles,
        };
    }

    const nextTrackedFiles: AiTrackedFile[] = [];
    let changed = false;

    for (const trackedFile of input.trackedFiles) {
        const reconciledTrackedFile = await reconcilePendingTrackedFile(
            trackedFile,
            input.readTrackedFileText,
            input.onError,
        );
        if (!reconciledTrackedFile) {
            changed = true;
            continue;
        }

        if (reconciledTrackedFile !== trackedFile) {
            changed = true;
        }
        nextTrackedFiles.push(reconciledTrackedFile);
    }

    return {
        changed,
        trackedFiles: changed ? nextTrackedFiles : input.trackedFiles,
    };
}

async function reconcilePendingTrackedFile(
    trackedFile: AiTrackedFile,
    readTrackedFileText: (trackedPath: string) => Promise<string | null>,
    onError: ((error: unknown, trackedFile: AiTrackedFile) => void) | undefined,
): Promise<AiTrackedFile | null> {
    const syncedTrackedFile = syncTrackedFile(trackedFile);
    if (
        syncedTrackedFile.reviewState !== "pending" ||
        !syncedTrackedFile.isText
    ) {
        return syncedTrackedFile;
    }

    if (syncedTrackedFile.hunks.length === 0) {
        return null;
    }

    try {
        return (await isTrackedFileNetClean(
            syncedTrackedFile,
            readTrackedFileText,
        ))
            ? null
            : syncedTrackedFile;
    } catch (error) {
        onError?.(error, syncedTrackedFile);
        return syncedTrackedFile;
    }
}

async function isTrackedFileNetClean(
    trackedFile: AiTrackedFile,
    readTrackedFileText: (trackedPath: string) => Promise<string | null>,
): Promise<boolean> {
    const diffBase = getTrackedFileDiffBase(trackedFile);
    const currentReviewText = getTrackedFileCurrentText(trackedFile);
    if (trackedFile.previousPath) {
        const [currentText, previousText] = await Promise.all([
            readTrackedFileText(trackedFile.path),
            readTrackedFileText(trackedFile.previousPath),
        ]);

        return (
            ((currentText === null ||
                normalizeReviewText(currentText) === normalizeReviewText(diffBase)) &&
                previousText !== null &&
                normalizeReviewText(previousText) === normalizeReviewText(diffBase)) ||
            (currentText !== null &&
                normalizeReviewText(currentText) ===
                    normalizeReviewText(currentReviewText) &&
                previousText === null)
        );
    }

    const currentText = await readTrackedFileText(trackedFile.path);
    if (trackedFile.newText === null) {
        return (
            currentText === null ||
            normalizeReviewText(currentText) === normalizeReviewText(diffBase)
        );
    }
    if (trackedFile.kind === "create") {
        return (
            currentText === null ||
            normalizeReviewText(currentText) === normalizeReviewText(diffBase) ||
            normalizeReviewText(currentText) ===
                normalizeReviewText(currentReviewText)
        );
    }

    return (
        currentText !== null &&
        (normalizeReviewText(currentText) === normalizeReviewText(diffBase) ||
            normalizeReviewText(currentText) ===
                normalizeReviewText(currentReviewText))
    );
}

function resolveTrackedDiffAbsolutePath(
    liveSession: AiReviewPathContext,
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
    diff: Pick<AiReviewRuntimeDiff, "newText" | "oldText">,
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
    const newSnippet = diff.newText;
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
    readonly newTrailingNewline?: boolean;
    readonly oldStart: number;
    readonly oldTrailingNewline?: boolean;
    readonly newStart: number;
    readonly lines: readonly string[];
}

function resolveAlreadyAppliedExternalDiff(
    diff: { readonly newText: string; readonly oldText: string },
    base: string,
    liveSession: AiReviewPathContext,
    normalizedPath: string,
    context: DiffResolutionContext | undefined,
): { readonly newText: string; readonly oldText: string } | null {
    const resolvedFromUnifiedPatch = resolveAlreadyAppliedUnifiedPatchDiff(
        diff,
        base,
        liveSession,
        normalizedPath,
        context?.rawOutput,
    );
    if (resolvedFromUnifiedPatch) {
        return resolvedFromUnifiedPatch;
    }

    return resolveAlreadyAppliedPreEditSnapshotDiff(
        diff,
        base,
        context?.preEditSnapshot,
    );
}

function resolveAlreadyAppliedUnifiedPatchDiff(
    diff: { readonly newText: string; readonly oldText: string },
    base: string,
    liveSession: AiReviewPathContext,
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
    let current: {
        lines: string[];
        newStart: number;
        newTrailingNewline?: boolean;
        oldStart: number;
        oldTrailingNewline?: boolean;
    } | null = null;
    let previousPatchLine: string | null = null;

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
            previousPatchLine = null;
            continue;
        }

        if (!current) {
            continue;
        }

        if (line === "\\ No newline at end of file") {
            if (previousPatchLine?.startsWith(" ")) {
                current.oldTrailingNewline = false;
                current.newTrailingNewline = false;
            } else if (previousPatchLine?.startsWith("-")) {
                current.oldTrailingNewline = false;
            } else if (previousPatchLine?.startsWith("+")) {
                current.newTrailingNewline = false;
            }
            continue;
        }

        if (
            line.startsWith(" ") ||
            line.startsWith("-") ||
            line.startsWith("+")
        ) {
            current.lines.push(line);
            previousPatchLine = line;
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
    let trailingNewline = text.endsWith("\n");
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
        const nextTrailingNewline = resolvePatchTrailingNewline(
            hunk,
            direction,
            trailingNewline,
        );
        if (nextTrailingNewline === null) {
            return null;
        }

        lines = [
            ...lines.slice(0, matchIndex),
            ...replacementLines,
            ...lines.slice(matchIndex + matchLines.length),
        ];
        trailingNewline = nextTrailingNewline;
    }

    return joinPatchTextLines(lines, trailingNewline);
}

function resolvePatchTrailingNewline(
    hunk: UnifiedPatchHunk,
    direction: "forward" | "reverse",
    inputTrailingNewline: boolean,
): boolean | null {
    const inputMissingTrailingNewline =
        direction === "forward"
            ? hunk.oldTrailingNewline === false
            : hunk.newTrailingNewline === false;
    const outputMissingTrailingNewline =
        direction === "forward"
            ? hunk.newTrailingNewline === false
            : hunk.oldTrailingNewline === false;

    if (inputMissingTrailingNewline && inputTrailingNewline) {
        return null;
    }

    if (outputMissingTrailingNewline) {
        return false;
    }

    if (inputMissingTrailingNewline) {
        return true;
    }

    return inputTrailingNewline;
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

export function resolveDiffToFullTexts(
    diff: AiReviewRuntimeDiff,
    existing: AiTrackedFile | undefined,
    liveSession: AiReviewPathContext,
    normalizedPath: string,
    context?: DiffResolutionContext,
): AiReviewRuntimeDiff {
    if (diff.oldText == null) {
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
    const shouldTryExternalResolution =
        !existing &&
        (first === -1 ||
            (newSnippet.length > 0 && base.includes(newSnippet)));
    if (shouldTryExternalResolution) {
        const resolvedAlreadyApplied = resolveAlreadyAppliedExternalDiff(
            { newText: newSnippet, oldText: oldSnippet },
            base,
            liveSession,
            normalizedPath,
            context,
        );
        if (resolvedAlreadyApplied) {
            return {
                ...diff,
                oldText: resolvedAlreadyApplied.oldText,
                newText: resolvedAlreadyApplied.newText,
            };
        }

        const resolvedCurrentSnippet = resolveAlreadyAppliedCurrentSnippetDiff(
            { newText: newSnippet, oldText: oldSnippet },
            base,
        );
        if (resolvedCurrentSnippet) {
            return {
                ...diff,
                oldText: resolvedCurrentSnippet.oldText,
                newText: resolvedCurrentSnippet.newText,
            };
        }

        const resolvedDeletionHunk = resolveAlreadyAppliedDeletionHunkDiff(
            {
                hunks: diff.hunks,
                oldText: oldSnippet,
            },
            base,
        );
        if (resolvedDeletionHunk) {
            return {
                ...diff,
                oldText: resolvedDeletionHunk.oldText,
                newText: resolvedDeletionHunk.newText,
            };
        }
    }

    if (first === -1 || first !== base.lastIndexOf(oldSnippet)) {
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

function resolveAlreadyAppliedCurrentSnippetDiff(
    diff: { readonly newText: string; readonly oldText: string },
    base: string,
): { readonly newText: string; readonly oldText: string } | null {
    if (diff.oldText.length === 0 || diff.newText.length === 0) {
        return null;
    }

    const first = base.indexOf(diff.newText);
    if (first === -1 || first !== base.lastIndexOf(diff.newText)) {
        return null;
    }

    return {
        oldText:
            base.slice(0, first) +
            diff.oldText +
            base.slice(first + diff.newText.length),
        newText: base,
    };
}

function resolveAlreadyAppliedDeletionHunkDiff(
    diff: {
        readonly hunks?: readonly AiDiffHunk[];
        readonly oldText: string;
    },
    base: string,
): { readonly newText: string; readonly oldText: string } | null {
    if (diff.oldText.length === 0 || !diff.hunks || diff.hunks.length !== 1) {
        return null;
    }

    const [hunk] = diff.hunks;
    if (!hunk || hunk.newCount !== 0 || hunk.oldCount === 0) {
        return null;
    }

    const insertionOffset = lineStartOffset(base, hunk.newStart);
    if (insertionOffset === null) {
        return null;
    }

    const insertedText =
        diff.oldText.endsWith("\n") || insertionOffset === base.length
            ? diff.oldText
            : `${diff.oldText}\n`;

    return {
        oldText:
            base.slice(0, insertionOffset) +
            insertedText +
            base.slice(insertionOffset),
        newText: base,
    };
}

function lineStartOffset(text: string, lineNumber: number): number | null {
    if (lineNumber < 1) {
        return null;
    }
    if (lineNumber === 1) {
        return 0;
    }

    let offset = 0;
    for (let line = 1; line < lineNumber; line += 1) {
        const next = text.indexOf("\n", offset);
        if (next === -1) {
            return line === lineNumber - 1 ? text.length : null;
        }
        offset = next + 1;
    }
    return offset;
}
