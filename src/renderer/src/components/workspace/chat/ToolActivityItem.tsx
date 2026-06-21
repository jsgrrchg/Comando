import { memo } from "react";

import type {
    AiToolCardExpansionMode,
    AiToolActivity,
    AiToolActivityLocation,
    AiTrackedFile,
} from "@shared/ipc";
import { isAiTrackedFileUnresolved } from "@shared/ai-tracked-file";
import { FIXED_PENDING_REVIEW_CARD_TEXT_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import { useFileReferenceValidator } from "@renderer/app/store/projectFileIndexStore";
import { useRenderProbe } from "@renderer/app/debug/renderProbe";
import { HighlightedCodeText } from "@renderer/app/editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "@renderer/app/editor/useCodeLanguageSupport";
import type {
    RuntimeWorkspaceFileOpenLocation,
    RuntimeWorkspaceFileReviewContext,
} from "@renderer/app/workspace/tree";

import { MarkdownContent } from "../MarkdownContent";
import {
    isLikelyProjectFileReference,
    parseProjectFileReference,
    type ResolvedProjectFileReference,
} from "../projectFileReferences";
import { ChangeReviewPanel } from "./ChangeReviewPanel";
import {
    isFileToolActivity,
    isTerminalToolActivity,
    isTurnStartedActivity,
} from "./toolActivityKinds";
import { usePersistentToolExpansion } from "./toolExpansionStore";

/* ─── Tool icon SVGs ─── */

function ReadIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" x2="16.65" y1="21" y2="16.65" />
        </svg>
    );
}

function EditIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <path d="m9 15 2 2 4-4" />
        </svg>
    );
}

function DeleteIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="9" x2="15" y1="13" y2="13" />
        </svg>
    );
}

function ExecuteIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
    );
}

function DefaultIcon() {
    return (
        <svg
            fill="none"
            height="13"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="13"
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    );
}

function Chevron({ expanded }: { readonly expanded: boolean }) {
    return (
        <svg
            fill="none"
            height="10"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            style={{
                opacity: 0.6,
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.15s ease",
            }}
            viewBox="0 0 24 24"
            width="10"
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    );
}

/* ─── Helpers ─── */

const EDITED_FILE_TOOL_KINDS = new Set([
    "create",
    "delete",
    "edit",
    "move",
    "remove",
    "rename",
    "update",
    "write",
]);
const TOOL_TITLE_TARGET_MAX_LENGTH = 72;

function getToolAccent(kind: string): string {
    const lk = kind.toLowerCase();
    if (lk === "delete" || lk === "remove") return "#ef4444";
    return "#6b7280";
}

function getToolIcon(kind: string) {
    const lk = kind.toLowerCase();
    if (lk === "read" || lk === "search") return <ReadIcon />;
    if (lk === "delete" || lk === "remove") return <DeleteIcon />;
    if (lk === "execute" || lk === "bash" || lk === "shell")
        return <ExecuteIcon />;
    if (
        lk === "edit" ||
        lk === "write" ||
        lk === "create" ||
        lk === "move" ||
        lk === "update"
    )
        return <EditIcon />;
    return <DefaultIcon />;
}

export function isEditedFileToolActivity(
    activity: AiToolActivity,
    trackedFiles: readonly AiTrackedFile[],
): boolean {
    if (trackedFiles.length > 0) return true;
    if (activity.diffs.length > 0) return true;
    return EDITED_FILE_TOOL_KINDS.has(activity.kind.toLowerCase());
}

function summarizeDiff(oldText: string | null, newText: string | null): string {
    const ol = (oldText ?? "").split("\n").filter(Boolean).length;
    const nl = (newText ?? "").split("\n").filter(Boolean).length;
    if (ol === 0 && nl > 0) return `Creates ${nl} line(s).`;
    if (nl === 0 && ol > 0) return `Removes ${ol} line(s).`;
    const added = Math.max(0, nl - ol);
    const removed = Math.max(0, ol - nl);
    const parts: string[] = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`-${removed}`);
    return parts.length > 0
        ? `Updates ${nl} line(s) (${parts.join(", ")}).`
        : `Updates ${nl} line(s).`;
}

function parseToolTitleReference(
    title: string,
): {
    readonly displayTarget: string;
    readonly prefix: string;
    readonly target: string;
} | null {
    const match =
        /^(Read|Edit|Write|Create|Delete|Move|Search)\s+(.+)$/i.exec(
            title.trim(),
        );
    const target = match?.[2]?.trim() ?? "";
    if (
        !target ||
        isPlaceholderToolTarget(target) ||
        !isLikelyProjectFileReference(target)
    ) {
        return null;
    }

    return {
        displayTarget: target,
        prefix: `${match?.[1] ?? ""} `,
        target,
    };
}

function isPlaceholderToolTarget(target: string): boolean {
    return /^\.{2,}$/.test(target.trim());
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecordString(
    record: Record<string, unknown>,
    key: string,
): string | null {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null;
}

function getToolActionPrefix(kind: string): string {
    const lk = kind.toLowerCase();
    if (lk === "read" || lk === "read_file") return "Read ";
    if (lk === "search" || lk === "grep") return "Search ";
    if (lk === "edit" || lk === "update") return "Edit ";
    if (lk === "write") return "Write ";
    if (lk === "create") return "Create ";
    if (lk === "delete" || lk === "remove") return "Delete ";
    if (lk === "move" || lk === "rename") return "Move ";
    return "";
}

function buildCompactedToolPathCandidate({
    leadingSegments,
    separator,
    target,
    trailingSegments,
}: {
    readonly leadingSegments: number;
    readonly separator: string;
    readonly target: readonly string[];
    readonly trailingSegments: number;
}): string | null {
    if (target.length <= leadingSegments + trailingSegments) {
        return null;
    }

    const leading = target.slice(0, leadingSegments);
    const trailing = target.slice(-trailingSegments);
    return [...leading, "...", ...trailing].join(separator);
}

function compactToolTitleTarget(target: string): string {
    const trimmedTarget = target.trim();
    if (trimmedTarget.length <= TOOL_TITLE_TARGET_MAX_LENGTH) {
        return trimmedTarget;
    }

    const separator =
        trimmedTarget.includes("\\") && !trimmedTarget.includes("/")
            ? "\\"
            : "/";
    const rawSegments = trimmedTarget.split(/[\\/]+/).filter(Boolean);
    const segments =
        separator === "/" && trimmedTarget.startsWith("/")
            ? ["", ...rawSegments]
            : rawSegments;
    if (segments.length <= 1) {
        return trimmedTarget;
    }

    const candidates = [
        buildCompactedToolPathCandidate({
            leadingSegments: 2,
            separator,
            target: segments,
            trailingSegments: 2,
        }),
        buildCompactedToolPathCandidate({
            leadingSegments: 1,
            separator,
            target: segments,
            trailingSegments: 2,
        }),
        buildCompactedToolPathCandidate({
            leadingSegments: 0,
            separator,
            target: segments,
            trailingSegments: 2,
        }),
        buildCompactedToolPathCandidate({
            leadingSegments: 0,
            separator,
            target: segments,
            trailingSegments: 1,
        }),
        segments.at(-1) ?? trimmedTarget,
    ].filter((candidate): candidate is string => candidate !== null);

    return (
        candidates.find(
            (candidate) => candidate.length <= TOOL_TITLE_TARGET_MAX_LENGTH,
        ) ?? candidates.at(-1) ?? trimmedTarget
    );
}

function parseToolRawInputJson(
    rawInputJson: string | null,
): Record<string, unknown> | null {
    if (!rawInputJson) {
        return null;
    }

    try {
        const value = parseJsonValue(rawInputJson);
        return isRecordValue(value) ? value : null;
    } catch {
        return null;
    }
}

function getStructuredToolTarget(activity: AiToolActivity): string | null {
    const locationPath = activity.locations.find(
        (location) => location.path.trim().length > 0,
    )?.path;
    if (locationPath) {
        return locationPath.trim();
    }

    const rawInput = parseToolRawInputJson(activity.rawInputJson);
    if (!rawInput) {
        return null;
    }

    return (
        readRecordString(rawInput, "file_path") ??
        readRecordString(rawInput, "filePath") ??
        readRecordString(rawInput, "path") ??
        readRecordString(rawInput, "target")
    );
}

function getToolTitleReference(
    activity: AiToolActivity,
): {
    readonly displayTarget: string;
    readonly prefix: string;
    readonly target: string;
} | null {
    const titleReference = parseToolTitleReference(activity.title);
    if (!shouldDeriveStructuredToolTarget(activity.kind)) {
        return titleReference;
    }

    const structuredTarget = getStructuredToolTarget(activity);
    if (structuredTarget && isLikelyProjectFileReference(structuredTarget)) {
        return {
            displayTarget: titleReference?.target ?? structuredTarget,
            prefix: titleReference?.prefix ?? getToolActionPrefix(activity.kind),
            target: structuredTarget,
        };
    }

    return titleReference;
}

function shouldDeriveStructuredToolTarget(kind: string): boolean {
    const lk = kind.toLowerCase();
    return (
        lk === "read" ||
        lk === "read_file" ||
        lk === "search" ||
        lk === "grep"
    );
}

function isPrimaryOpenFileTool(activity: AiToolActivity): boolean {
    return activity.kind.toLowerCase() === "read";
}

function isReadToolActivityKind(kind: string): boolean {
    const lk = kind.toLowerCase();
    return lk === "read" || lk === "read_file";
}

function canOpenToolFileReference({
    projectId,
    resolveFileReference,
    target,
}: {
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly target: string;
}) {
    const resolvedReference = resolveFileReference?.(target) ?? null;
    if (resolvedReference) {
        return true;
    }

    const parsedReference = parseProjectFileReference(target);
    return !!parsedReference && !parsedReference.isAbsolute && !!projectId;
}

function getOpenLocationFromFileReference(reference: {
    readonly endLine: number | null;
    readonly startLine: number | null;
}): RuntimeWorkspaceFileOpenLocation | null {
    if (reference.startLine === null) {
        return null;
    }

    return {
        endLine: reference.endLine,
        startLine: reference.startLine,
    };
}

function openToolFileReference({
    onOpenFile,
    onOpenFileReference,
    projectId,
    resolveFileReference,
    target,
    worktreeId,
}: {
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly target: string;
    readonly worktreeId: string | null;
}) {
    const resolvedReference = resolveFileReference?.(target) ?? null;
    if (resolvedReference) {
        if (onOpenFileReference) {
            onOpenFileReference(resolvedReference);
            return;
        }

        if (projectId) {
            const openLocation =
                getOpenLocationFromFileReference(resolvedReference);
            if (openLocation) {
                void onOpenFile(
                    projectId,
                    resolvedReference.relativePath,
                    worktreeId,
                    undefined,
                    openLocation,
                );
            } else {
                void onOpenFile(
                    projectId,
                    resolvedReference.relativePath,
                    worktreeId,
                );
            }
        }
        return;
    }

    const parsedReference = parseProjectFileReference(target);
    if (!parsedReference || parsedReference.isAbsolute || !projectId) {
        return;
    }

    const openLocation = getOpenLocationFromFileReference(parsedReference);
    if (openLocation) {
        void onOpenFile(
            projectId,
            parsedReference.path,
            worktreeId,
            undefined,
            openLocation,
        );
        return;
    }

    void onOpenFile(projectId, parsedReference.path, worktreeId);
}

function formatToolLocationReference(
    location: AiToolActivityLocation,
): string {
    if (location.line === null) {
        return location.path;
    }

    if (
        location.endLine !== null &&
        location.endLine !== location.line
    ) {
        return `${location.path}:${location.line}-${location.endLine}`;
    }

    return `${location.path}:${location.line}`;
}

function getToolLanguageInfoFromPath(pathValue: string | null): string | null {
    if (!pathValue) {
        return null;
    }

    const pathWithoutRange = pathValue.replace(/:\d+(?:-\d+)?$/, "");
    const basename = pathWithoutRange.split(/[\\/]/).pop() ?? "";
    const dotIndex = basename.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === basename.length - 1) {
        return null;
    }

    return basename.slice(dotIndex + 1).toLowerCase();
}

function shouldDecodeEscapedReadText(value: string): boolean {
    const escapedLineBreaks = value.match(/\\r\\n|\\n|\\r/g)?.length ?? 0;
    if (escapedLineBreaks === 0) {
        return false;
    }

    const actualLineBreaks = value.match(/\r\n|\n|\r/g)?.length ?? 0;
    return actualLineBreaks === 0 || escapedLineBreaks > actualLineBreaks * 2;
}

function looksLikeEncodedJsonString(value: string): boolean {
    const trimmed = value.trim();
    return (
        trimmed.startsWith('"') &&
        trimmed.endsWith('"') &&
        /\\(?:r|n|t|"|\\)/.test(trimmed)
    );
}

function decodeEscapedReadText(value: string): string {
    return value
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
}

function normalizeReadToolStringOutput(value: string): string | null {
    let normalized = value;
    for (let parseAttempt = 0; parseAttempt < 2; parseAttempt += 1) {
        if (!looksLikeEncodedJsonString(normalized)) {
            break;
        }

        try {
            const parsed = parseJsonValue(normalized.trim());
            if (typeof parsed !== "string" || parsed === normalized) {
                break;
            }
            normalized = parsed;
        } catch {
            break;
        }
    }

    if (shouldDecodeEscapedReadText(normalized)) {
        normalized = decodeEscapedReadText(normalized);
    }

    return normalized.length > 0 ? normalized : null;
}

function getReadToolOutput(activity: AiToolActivity): string | null {
    if (!isReadToolActivityKind(activity.kind) || !activity.rawOutputJson) {
        return null;
    }

    try {
        const parsed = parseJsonValue(activity.rawOutputJson);
        if (typeof parsed === "string") {
            return normalizeReadToolStringOutput(parsed);
        }

        if (parsed !== null && parsed !== undefined) {
            return JSON.stringify(parsed, null, 2);
        }
    } catch {
        return activity.rawOutputJson.trim().length > 0
            ? activity.rawOutputJson
            : null;
    }

    return null;
}

function getToolRawOutput(activity: AiToolActivity): string | null {
    if (!activity.rawOutputJson) {
        return null;
    }

    return getReadToolOutput(activity) ?? formatRawJson(activity.rawOutputJson);
}

function ToolDetailCodeBlock({
    accentBorder,
    backgroundColor,
    color,
    content,
    languageInfo,
    preserveLayout = false,
}: {
    readonly accentBorder?: string;
    readonly backgroundColor: string;
    readonly color: string;
    readonly content: string;
    readonly languageInfo?: string | null;
    readonly preserveLayout?: boolean;
}) {
    const languageSupport = useMarkdownCodeLanguageSupport(languageInfo);

    return (
        <pre
            className="max-h-48 select-text rounded px-2 py-1.5"
            style={{
                backgroundColor,
                border: accentBorder ?? "1px solid var(--color-border)",
                color,
                fontFamily: "var(--font-mono, monospace)",
                fontSize: "0.92em",
                lineHeight: 1.4,
                margin: 0,
                overflowX: preserveLayout ? "auto" : "hidden",
                overflowY: "auto",
                overflowWrap: preserveLayout ? "normal" : "anywhere",
                whiteSpace: preserveLayout ? "pre" : "pre-wrap",
                wordBreak: preserveLayout ? "normal" : "break-word",
            }}
        >
            <code
                style={{
                    color: "inherit",
                    whiteSpace: "inherit",
                }}
            >
                <HighlightedCodeText
                    language={languageSupport}
                    segmentKeyPrefix={`tool-activity:${languageInfo ?? "plain"}:${content.length}`}
                    text={content}
                />
            </code>
        </pre>
    );
}

function ToolDetailSummary({
    accentBorder,
    backgroundColor,
    canRenderFileReference,
    content,
    onOpenFileReference,
    resolveFileReference,
}: {
    readonly accentBorder?: string;
    readonly backgroundColor: string;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly content: string;
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}) {
    return (
        <div
            className="select-text rounded px-2 py-1.5"
            style={{
                backgroundColor,
                border: accentBorder ?? "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
            }}
        >
            <MarkdownContent
                canRenderFileReference={canRenderFileReference}
                content={content}
                onOpenFile={onOpenFileReference}
                resolveFileReference={resolveFileReference}
            />
        </div>
    );
}

function TurnStartedDivider({
    activity,
}: {
    readonly activity: AiToolActivity;
}) {
    return (
        <div
            className="min-w-0 max-w-full py-2"
            data-testid="turn-start-divider"
        >
            <div className="flex min-w-0 max-w-full items-center gap-3">
                <div
                    className="h-px flex-1"
                    style={{
                        backgroundColor: "var(--color-border)",
                        opacity: 0.5,
                    }}
                />
                <span
                    className="shrink-0 uppercase tracking-[0.14em]"
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "0.68em",
                        opacity: 0.7,
                    }}
                >
                    {activity.title}
                </span>
                <div
                    className="h-px flex-1"
                    style={{
                        backgroundColor: "var(--color-border)",
                        opacity: 0.5,
                    }}
                />
            </div>
        </div>
    );
}

/* ─── File tool message (card style) ─── */

function getToolCardExpansionState({
    defaultExpanded,
    expansionMode,
    isLatestStreamingTool,
}: {
    readonly defaultExpanded: boolean;
    readonly expansionMode: AiToolCardExpansionMode;
    readonly isLatestStreamingTool: boolean;
}) {
    if (expansionMode === "expanded") {
        return { defaultExpanded: true, forceExpanded: true };
    }

    if (expansionMode === "latest") {
        return {
            defaultExpanded: isLatestStreamingTool,
            forceExpanded: false,
        };
    }

    return { defaultExpanded, forceExpanded: false };
}

function useSyncedToolExpansion({
    defaultExpanded,
    forceExpanded,
    resetKey,
}: {
    readonly defaultExpanded: boolean;
    readonly forceExpanded: boolean;
    readonly resetKey: string;
}) {
    const [expanded, setExpanded] = usePersistentToolExpansion(
        resetKey,
        defaultExpanded,
    );

    return {
        expanded: forceExpanded ? true : expanded,
        toggleExpanded: () => {
            if (forceExpanded) {
                return;
            }

            setExpanded((previous) => !previous);
        },
    };
}

function getToolExpansionResetKey(
    activityId: string,
    expansionMode: AiToolCardExpansionMode,
    isLatestStreamingTool: boolean,
): string {
    return `${activityId}:${expansionMode}:${
        isLatestStreamingTool ? "latest" : "history"
    }`;
}

function FileToolMessage({
    activity,
    canRenderFileReference,
    expansionMode,
    isLatestStreamingTool,
    onOpenFile,
    onOpenFileReference,
    pendingTrackedFiles,
    projectId,
    resolveFileReference,
    worktreeId,
}: {
    readonly activity: AiToolActivity;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly expansionMode: AiToolCardExpansionMode;
    readonly isLatestStreamingTool: boolean;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly pendingTrackedFiles: readonly AiTrackedFile[];
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly worktreeId: string | null;
}) {
    const isInProgress = activity.status === "in_progress";
    const isCompleted = activity.status === "completed";
    const accent = getToolAccent(activity.kind);
    const titleReference = getToolTitleReference(activity);
    const compactTitleTarget = titleReference
        ? compactToolTitleTarget(titleReference.displayTarget)
        : null;
    const titleIsLink =
        titleReference !== null &&
        canOpenToolFileReference({
            projectId,
            resolveFileReference,
            target: titleReference.target,
        });
    const shouldOpenOnHeaderClick =
        titleReference !== null &&
        titleIsLink &&
        isPrimaryOpenFileTool(activity);
    const readOutput = getReadToolOutput(activity);
    const toolOutput = getToolRawOutput(activity);
    const toolOutputLanguageInfo = readOutput
        ? getToolLanguageInfoFromPath(
              titleReference?.target ??
                  activity.locations.find((location) => location.path)?.path ??
                  null,
          )
        : null;

    const hasDetail =
        (!!activity.summary && !toolOutput) ||
        !!toolOutput ||
        activity.locations.length > 0 ||
        activity.diffs.length > 0 ||
        pendingTrackedFiles.length > 0;
    const expansionState = getToolCardExpansionState({
        defaultExpanded: false,
        expansionMode,
        isLatestStreamingTool,
    });
    const { expanded, toggleExpanded: toggleSyncedExpanded } =
        useSyncedToolExpansion({
            defaultExpanded: expansionState.defaultExpanded,
            forceExpanded: expansionState.forceExpanded,
            resetKey: getToolExpansionResetKey(
                activity.id,
                expansionMode,
                isLatestStreamingTool,
            ),
        });
    const toggleExpanded = () => {
        if (!hasDetail) {
            return;
        }

        toggleSyncedExpanded();
    };
    const openTitleReference = () => {
        if (!titleReference || !titleIsLink) {
            return;
        }

        openToolFileReference({
            onOpenFile,
            onOpenFileReference,
            projectId,
            resolveFileReference,
            target: titleReference.target,
            worktreeId,
        });
    };
    const handleHeaderClick = () => {
        if (shouldOpenOnHeaderClick) {
            openTitleReference();
            return;
        }

        toggleExpanded();
    };

    return (
        <div
            className="min-w-0 max-w-full select-none overflow-hidden rounded-lg"
            style={{
                backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--color-bg-secondary))`,
                border: `1px solid color-mix(in srgb, ${accent} 25%, var(--color-border))`,
                opacity: isCompleted ? 0.65 : 1,
                transition: "opacity 0.2s ease",
            }}
        >
            <div
                aria-expanded={
                    hasDetail && !shouldOpenOnHeaderClick
                        ? expanded
                        : undefined
                }
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
                onClick={handleHeaderClick}
                onKeyDown={(event) => {
                    if (
                        event.target !== event.currentTarget ||
                        (!hasDetail && !shouldOpenOnHeaderClick) ||
                        (event.key !== "Enter" && event.key !== " ")
                    ) {
                        return;
                    }

                    event.preventDefault();
                    handleHeaderClick();
                }}
                role={
                    hasDetail || shouldOpenOnHeaderClick ? "button" : undefined
                }
                style={{
                    background: "none",
                    borderBottom: expanded
                        ? `1px solid color-mix(in srgb, ${accent} 15%, var(--color-border))`
                        : "1px solid transparent",
                    color: accent,
                    cursor:
                        shouldOpenOnHeaderClick ||
                        (hasDetail && !expansionState.forceExpanded)
                            ? "pointer"
                            : "default",
                    fontSize: "0.83em",
                }}
                tabIndex={
                    hasDetail || shouldOpenOnHeaderClick ? 0 : undefined
                }
            >
                <span className="shrink-0">{getToolIcon(activity.kind)}</span>
                <span
                    className="flex min-w-0 flex-1 items-baseline"
                    style={{
                        color: "var(--color-text-primary)",
                        fontWeight: 400,
                    }}
                >
                    {titleReference && titleIsLink ? (
                        <>
                            <span className="shrink-0 whitespace-pre">
                                {titleReference.prefix}
                            </span>
                            <button
                                className="app-no-drag min-w-0 truncate text-left"
                                onBlur={(event) => {
                                    event.currentTarget.style.textDecoration =
                                        "none";
                                }}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    openTitleReference();
                                }}
                                onFocus={(event) => {
                                    event.currentTarget.style.textDecoration =
                                        "underline";
                                }}
                                onMouseEnter={(event) => {
                                    event.currentTarget.style.textDecoration =
                                        "underline";
                                }}
                                onMouseLeave={(event) => {
                                    event.currentTarget.style.textDecoration =
                                        "none";
                                }}
                                style={{
                                    background: "none",
                                    border: "none",
                                    color: "inherit",
                                    cursor: "pointer",
                                    display: "block",
                                    font: "inherit",
                                    lineHeight: "inherit",
                                    margin: 0,
                                    minWidth: 0,
                                    overflow: "hidden",
                                    padding: 0,
                                    textDecoration: "none",
                                    textOverflow: "ellipsis",
                                    textUnderlineOffset: "2px",
                                    verticalAlign: "baseline",
                                    whiteSpace: "nowrap",
                                }}
                                title={`Open ${titleReference.target}`}
                                type="button"
                            >
                                {compactTitleTarget}
                            </button>
                        </>
                    ) : titleReference ? (
                        <>
                            <span className="shrink-0 whitespace-pre">
                                {titleReference.prefix}
                            </span>
                            <span
                                className="min-w-0 truncate"
                                title={titleReference.target}
                            >
                                {compactTitleTarget}
                            </span>
                        </>
                    ) : (
                        <span
                            className="min-w-0 truncate"
                            title={activity.title}
                        >
                            {activity.title}
                        </span>
                    )}
                </span>
                {isInProgress ? (
                    <span
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                        style={{ backgroundColor: "var(--color-accent)" }}
                    />
                ) : null}
                {pendingTrackedFiles.length > 0 ? (
                    <span
                        className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                        style={{
                            backgroundColor:
                                "color-mix(in srgb, var(--color-accent) 10%, transparent)",
                            color: "var(--color-accent)",
                        }}
                    >
                        {pendingTrackedFiles.length} review
                    </span>
                ) : null}
                {hasDetail ? (
                    <button
                        aria-label={
                            expanded ? "Collapse details" : "Expand details"
                        }
                        className="app-no-drag shrink-0"
                        onClick={(event) => {
                            event.stopPropagation();
                            toggleExpanded();
                        }}
                        style={{
                            alignItems: "center",
                            background: "none",
                            border: "none",
                            color: "inherit",
                            cursor:
                                expansionState.forceExpanded
                                    ? "default"
                                    : "pointer",
                            display: "inline-flex",
                            margin: 0,
                            padding: 0,
                        }}
                        type="button"
                    >
                        <Chevron expanded={expanded} />
                    </button>
                ) : null}
            </div>

            {expanded ? (
                <div className="px-3 py-1.5" style={{ fontSize: "0.78em" }}>
                    {toolOutput ? (
                        <div className="mb-1">
                            <ToolDetailCodeBlock
                                accentBorder={`1px solid color-mix(in srgb, ${accent} 10%, var(--color-border))`}
                                backgroundColor={`color-mix(in srgb, ${accent} 4%, var(--color-bg-tertiary))`}
                                color="var(--color-text-secondary)"
                                content={toolOutput}
                                languageInfo={toolOutputLanguageInfo}
                                preserveLayout
                            />
                        </div>
                    ) : null}
                    {activity.summary && !toolOutput ? (
                        <div className="mb-1">
                            <ToolDetailSummary
                                accentBorder={`1px solid color-mix(in srgb, ${accent} 10%, var(--color-border))`}
                                backgroundColor={`color-mix(in srgb, ${accent} 4%, var(--color-bg-tertiary))`}
                                canRenderFileReference={
                                    canRenderFileReference
                                }
                                content={activity.summary}
                                onOpenFileReference={onOpenFileReference}
                                resolveFileReference={resolveFileReference}
                            />
                        </div>
                    ) : null}
                    {activity.locations.length > 0 ? (
                        <div className="mb-1 flex flex-wrap gap-1">
                            {activity.locations.map((loc) => {
                                const target = formatToolLocationReference(loc);

                                return (
                                    <button
                                        className="app-no-drag rounded-md px-2 py-0.5"
                                        key={target}
                                        onClick={() => {
                                            openToolFileReference({
                                                onOpenFile,
                                                onOpenFileReference,
                                                projectId,
                                                resolveFileReference,
                                                target,
                                                worktreeId,
                                            });
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.backgroundColor =
                                                "var(--color-bg-secondary)";
                                            e.currentTarget.style.filter =
                                                "brightness(1.05)";
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.backgroundColor =
                                                "var(--color-bg-tertiary)";
                                            e.currentTarget.style.filter =
                                                "none";
                                        }}
                                        style={{
                                            backgroundColor:
                                                "var(--color-bg-tertiary)",
                                            border: "1px solid var(--color-border)",
                                            color: "var(--color-text-secondary)",
                                            cursor: canOpenToolFileReference({
                                                projectId,
                                                resolveFileReference,
                                                target,
                                            })
                                                ? "pointer"
                                                : "default",
                                            fontSize: "0.9em",
                                            transition:
                                                "background-color 100ms ease, filter 100ms ease",
                                        }}
                                        type="button"
                                    >
                                        {target}
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}
                    {activity.diffs.map((diff) => (
                        <div
                            className="mb-1 rounded-md px-2 py-1.5"
                            key={`${activity.id}:${diff.path}`}
                            style={{
                                backgroundColor: "var(--color-bg-tertiary)",
                                border: "1px solid var(--color-border)",
                            }}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <span
                                    className="min-w-0 truncate"
                                    style={{
                                        color: "var(--color-text-primary)",
                                        fontSize: "0.9em",
                                    }}
                                >
                                    {diff.path}
                                </span>
                                <span
                                    style={{
                                        color: "var(--color-text-secondary)",
                                        fontSize: "0.8em",
                                        letterSpacing: "0.06em",
                                        textTransform: "uppercase",
                                    }}
                                >
                                    {diff.kind}
                                </span>
                            </div>
                            <div
                                className="mt-0.5"
                                style={{
                                    color: "var(--color-text-secondary)",
                                    fontSize: "0.85em",
                                }}
                            >
                                {summarizeDiff(diff.oldText, diff.newText)}
                            </div>
                        </div>
                    ))}
                    {activity.diffs.length === 0
                        ? pendingTrackedFiles.map((trackedFile) => (
                              <div
                                  className="mb-1 rounded-md px-2 py-1.5"
                                  key={`${activity.id}:${trackedFile.identityKey}`}
                                  style={{
                                      backgroundColor:
                                          "var(--color-bg-tertiary)",
                                      border: "1px solid var(--color-border)",
                                      fontSize: `${FIXED_PENDING_REVIEW_CARD_TEXT_ZOOM}em`,
                                  }}
                              >
                                  <div className="flex items-center justify-between gap-2">
                                      <span
                                          className="min-w-0 truncate"
                                          style={{
                                              color: "var(--color-text-primary)",
                                              fontSize: "0.9em",
                                          }}
                                      >
                                          {trackedFile.path}
                                      </span>
                                      <span
                                          style={{
                                              color: "var(--color-text-secondary)",
                                              fontSize: "0.8em",
                                              letterSpacing: "0.06em",
                                              textTransform: "uppercase",
                                          }}
                                      >
                                          pending review
                                      </span>
                                  </div>
                              </div>
                          ))
                        : null}
                </div>
            ) : null}
        </div>
    );
}

/* ─── Terminal tool message (card style for bash/shell/execute) ─── */

function parseJsonValue(raw: string): unknown {
    return JSON.parse(raw) as unknown;
}

function extractCommand(rawInputJson: string | null): string | null {
    if (!rawInputJson) return null;
    try {
        const parsed = parseJsonValue(rawInputJson);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "command" in parsed &&
            typeof parsed.command === "string"
        ) {
            return parsed.command;
        }
    } catch {
        /* ignore */
    }
    return null;
}

function isCommandDuplicatedByTitle(title: string, command: string): boolean {
    const normalizedTitle = title.trim();
    const normalizedCommand = command.trim();

    return (
        normalizedTitle === normalizedCommand ||
        normalizedTitle === `Run ${normalizedCommand}`
    );
}

function TerminalToolMessage({
    activity,
}: {
    readonly activity: AiToolActivity;
}) {
    const isFailed = activity.status === "failed";
    const hasNonZeroExit =
        activity.exitCode !== null && activity.exitCode !== 0;
    const isInProgress = activity.status === "in_progress";
    const isCompleted = activity.status === "completed";

    const accent = isFailed || hasNonZeroExit ? "#ef4444" : "#6b7280";
    const command = extractCommand(activity.rawInputJson);
    const shouldShowCommand =
        !!command && !isCommandDuplicatedByTitle(activity.title, command);
    const hasTerminalOutput = !!activity.terminalOutput;
    const hasDetail = shouldShowCommand || hasTerminalOutput;
    const [expanded, setExpanded] = usePersistentToolExpansion(
        `${activity.id}:terminal`,
        (isFailed || hasNonZeroExit) && hasTerminalOutput,
    );

    return (
        <div
            className="min-w-0 max-w-full select-none overflow-hidden rounded-lg"
            style={{
                backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--color-bg-secondary))`,
                border: `1px solid color-mix(in srgb, ${accent} 25%, var(--color-border))`,
                opacity: isCompleted ? 0.65 : 1,
                transition: "opacity 0.2s ease",
            }}
        >
            <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
                onClick={() => hasDetail && setExpanded(!expanded)}
                style={{
                    background: "none",
                    border: "none",
                    borderBottom: expanded
                        ? `1px solid color-mix(in srgb, ${accent} 15%, var(--color-border))`
                        : "1px solid transparent",
                    color: accent,
                    cursor: hasDetail ? "pointer" : "default",
                    fontSize: "0.83em",
                }}
                type="button"
            >
                <span className="shrink-0">
                    <ExecuteIcon />
                </span>
                <span
                    className="min-w-0 flex-1 truncate"
                    style={{
                        color: "var(--color-text-primary)",
                        fontWeight: 400,
                    }}
                >
                    {activity.title}
                </span>
                {isInProgress ? (
                    <span
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                        style={{ backgroundColor: "var(--color-accent)" }}
                    />
                ) : null}
                {activity.exitCode !== null ? (
                    <span
                        className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                        style={{
                            backgroundColor:
                                activity.exitCode === 0
                                    ? "color-mix(in srgb, var(--diff-add) 10%, transparent)"
                                    : "color-mix(in srgb, var(--diff-remove) 10%, transparent)",
                            color:
                                activity.exitCode === 0
                                    ? "var(--diff-add)"
                                    : "var(--diff-remove)",
                        }}
                    >
                        exit {activity.exitCode}
                    </span>
                ) : null}
                {hasDetail ? (
                    <span className="shrink-0">
                        <Chevron expanded={expanded} />
                    </span>
                ) : null}
            </button>

            {expanded && hasDetail ? (
                <div
                    className="space-y-1 px-3 py-1.5"
                    style={{ fontSize: "0.78em" }}
                >
                    {activity.terminalOutput ? (
                        <ToolDetailCodeBlock
                            accentBorder={
                                isFailed
                                    ? "1px solid color-mix(in srgb, #ef4444 20%, var(--color-border))"
                                    : "1px solid var(--color-border)"
                            }
                            backgroundColor={
                                isFailed
                                    ? "color-mix(in srgb, #ef4444 6%, var(--color-bg-tertiary))"
                                    : "var(--color-bg-tertiary)"
                            }
                            color={
                                isFailed
                                    ? "#ef4444"
                                    : "var(--color-text-secondary)"
                            }
                            content={activity.terminalOutput}
                            languageInfo={command ? "shell" : null}
                        />
                    ) : null}
                    {shouldShowCommand ? (
                        <ToolDetailCodeBlock
                            accentBorder={`1px solid color-mix(in srgb, ${accent} 10%, var(--color-border))`}
                            backgroundColor={`color-mix(in srgb, ${accent} 4%, var(--color-bg-tertiary))`}
                            color="var(--color-text-primary)"
                            content={command}
                            languageInfo="shell"
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

/* ─── Generic tool message (compact single-liner) ─── */

function formatRawJson(raw: string): string {
    try {
        const parsed = parseJsonValue(raw);
        if (typeof parsed === "string") return parsed;
        return JSON.stringify(parsed, null, 2);
    } catch {
        return raw;
    }
}

function getOpenSessionActionLabel(activity: AiToolActivity): string {
    const name = activity.title
        .replace(/^(spawned|started|opened)\s+/i, "")
        .trim();
    return name.length > 0 && name.length <= 28 ? `Open ${name}` : "Open";
}

function getOpenSessionActionTitle(activity: AiToolActivity): string {
    const label = getOpenSessionActionLabel(activity);
    return label === "Open" ? "Open session" : label;
}

function GenericToolMessage({
    activity,
    canRenderFileReference,
    onOpenFileReference,
    onOpenSession,
    resolveFileReference,
}: {
    readonly activity: AiToolActivity;
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}) {
    const isFailed = activity.status === "failed";
    const [expanded, setExpanded] = usePersistentToolExpansion(
        `${activity.id}:generic`,
        isFailed,
    );
    const isInProgress = activity.status === "in_progress";
    const isCompleted = activity.status === "completed";
    const rawInputJson = activity.rawInputJson;
    const rawOutputJson = activity.rawOutputJson;
    const openSessionAction =
        activity.action?.kind === "open_session" ? activity.action : null;
    const hasRawInput = rawInputJson !== null;
    const hasRawOutput = rawOutputJson !== null;
    const hasDetail = !!activity.summary || hasRawInput || hasRawOutput;

    return (
        <div
            className="min-w-0 max-w-full select-none"
            style={{
                color: isFailed ? "#ef4444" : "var(--color-text-secondary)",
                fontSize: "0.85em",
                opacity: isCompleted ? 0.45 : 0.7,
                transition: "opacity 0.2s ease",
            }}
        >
            <div className="flex w-full items-center gap-2">
                <button
                    className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                    onClick={() => hasDetail && setExpanded(!expanded)}
                    style={{
                        background: "none",
                        border: "none",
                        color: "inherit",
                        cursor: hasDetail ? "pointer" : "default",
                    }}
                    type="button"
                >
                    <span className="shrink-0">
                        {getToolIcon(activity.kind)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                        {activity.title}
                    </span>
                    {isInProgress ? (
                        <span
                            className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                            style={{ backgroundColor: "var(--color-accent)" }}
                        />
                    ) : null}
                    {hasDetail ? (
                        <span className="shrink-0">
                            <Chevron expanded={expanded} />
                        </span>
                    ) : null}
                </button>
                {openSessionAction && onOpenSession ? (
                    <button
                        className="app-no-drag shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                        onClick={() =>
                            void onOpenSession(openSessionAction.sessionId)
                        }
                        title={getOpenSessionActionTitle(activity)}
                        type="button"
                    >
                        {getOpenSessionActionLabel(activity)}
                    </button>
                ) : null}
            </div>

            {expanded ? (
                <div className="mt-1 space-y-1" style={{ fontSize: "0.82em" }}>
                    {activity.summary ? (
                        <ToolDetailSummary
                            backgroundColor="var(--color-bg-tertiary)"
                            canRenderFileReference={
                                canRenderFileReference
                            }
                            content={activity.summary}
                            onOpenFileReference={onOpenFileReference}
                            resolveFileReference={resolveFileReference}
                        />
                    ) : null}
                    {hasRawInput ? (
                        <ToolDetailCodeBlock
                            backgroundColor="var(--color-bg-tertiary)"
                            color="var(--color-text-secondary)"
                            content={formatRawJson(rawInputJson)}
                            languageInfo="json"
                        />
                    ) : null}
                    {hasRawOutput ? (
                        <ToolDetailCodeBlock
                            accentBorder={
                                isFailed
                                    ? "1px solid color-mix(in srgb, #ef4444 20%, var(--color-border))"
                                    : "1px solid var(--color-border)"
                            }
                            backgroundColor={
                                isFailed
                                    ? "color-mix(in srgb, #ef4444 6%, var(--color-bg-tertiary))"
                                    : "var(--color-bg-tertiary)"
                            }
                            color={
                                isFailed
                                    ? "#ef4444"
                                    : "var(--color-text-secondary)"
                            }
                            content={formatRawJson(rawOutputJson)}
                            languageInfo="json"
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

/* ─── Public component ─── */

export const ToolActivityItem = memo(function ToolActivityItem({
    activity,
    expansionMode = "collapsed",
    isLatestStreamingTool = false,
    onOpenFile,
    onOpenFileReference,
    onOpenSession,
    trackedFiles = [],
    projectId,
    resolveFileReference,
    worktreeId = null,
}: {
    readonly activity: AiToolActivity;
    readonly expansionMode?: AiToolCardExpansionMode;
    readonly isLatestStreamingTool?: boolean;
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
        openLocation?: RuntimeWorkspaceFileOpenLocation | null,
    ) => Promise<void>;
    readonly onOpenFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
    readonly trackedFiles?: readonly AiTrackedFile[];
    readonly projectId: string | null;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
    readonly worktreeId?: string | null;
}) {
    const pendingTrackedFiles = trackedFiles.filter(
        isAiTrackedFileUnresolved,
    );
    const hasInlineReview = trackedFiles.length > 0 || activity.diffs.length > 0;

    // Validate file references in tool summaries against the real project file
    // index so only existing files become clickable pills (mirrors chat
    // messages). Derived here since this is where project context lives.
    const canRenderFileReference = useFileReferenceValidator(
        projectId,
        worktreeId ?? null,
    );

    useRenderProbe("ToolActivityItem", {
        activityId: activity.id,
        diffs: activity.diffs.length,
        hasInlineReview,
        pendingTrackedFiles: pendingTrackedFiles.length,
        trackedFiles: trackedFiles.length,
    });

    if (isTurnStartedActivity(activity)) {
        return <TurnStartedDivider activity={activity} />;
    }

    if (isTerminalToolActivity(activity)) {
        return <TerminalToolMessage activity={activity} />;
    }

    if (isFileToolActivity(activity, trackedFiles)) {
        const fileToolExpansionMode = isEditedFileToolActivity(
            activity,
            trackedFiles,
        )
            ? expansionMode
            : "collapsed";

        if (hasInlineReview) {
            const reviewExpansionState = getToolCardExpansionState({
                defaultExpanded: false,
                expansionMode: fileToolExpansionMode,
                isLatestStreamingTool,
            });

            return (
                <ChangeReviewPanel
                    activity={activity}
                    defaultExpanded={reviewExpansionState.defaultExpanded}
                    forceExpanded={reviewExpansionState.forceExpanded}
                    onOpenFile={onOpenFile}
                    projectId={projectId}
                    resolveFileReference={resolveFileReference}
                    trackedFiles={trackedFiles}
                    worktreeId={worktreeId}
                />
            );
        }

        return (
            <FileToolMessage
                activity={activity}
                canRenderFileReference={canRenderFileReference}
                expansionMode={fileToolExpansionMode}
                isLatestStreamingTool={isLatestStreamingTool}
                onOpenFile={onOpenFile}
                onOpenFileReference={onOpenFileReference}
                pendingTrackedFiles={pendingTrackedFiles}
                projectId={projectId}
                resolveFileReference={resolveFileReference}
                worktreeId={worktreeId}
            />
        );
    }

    return (
        <GenericToolMessage
            activity={activity}
            canRenderFileReference={canRenderFileReference}
            onOpenFileReference={onOpenFileReference}
            onOpenSession={onOpenSession}
            resolveFileReference={resolveFileReference}
        />
    );
}, areToolActivityItemPropsEqual);

ToolActivityItem.displayName = "ToolActivityItem";

function areToolActivityItemPropsEqual(
    previous: Readonly<{
        readonly activity: AiToolActivity;
        readonly expansionMode?: AiToolCardExpansionMode;
        readonly isLatestStreamingTool?: boolean;
        readonly onOpenFile: (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
            openLocation?: RuntimeWorkspaceFileOpenLocation | null,
        ) => Promise<void>;
        readonly onOpenFileReference?: (
            reference: ResolvedProjectFileReference,
        ) => void;
        readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
        readonly trackedFiles?: readonly AiTrackedFile[];
        readonly projectId: string | null;
        readonly resolveFileReference?: (
            reference: string,
        ) => ResolvedProjectFileReference | null;
        readonly worktreeId?: string | null;
    }>,
    next: Readonly<{
        readonly activity: AiToolActivity;
        readonly expansionMode?: AiToolCardExpansionMode;
        readonly isLatestStreamingTool?: boolean;
        readonly onOpenFile: (
            projectId: string,
            relativePath: string,
            worktreeId?: string | null,
            reviewContext?: RuntimeWorkspaceFileReviewContext | null,
            openLocation?: RuntimeWorkspaceFileOpenLocation | null,
        ) => Promise<void>;
        readonly onOpenFileReference?: (
            reference: ResolvedProjectFileReference,
        ) => void;
        readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
        readonly trackedFiles?: readonly AiTrackedFile[];
        readonly projectId: string | null;
        readonly resolveFileReference?: (
            reference: string,
        ) => ResolvedProjectFileReference | null;
        readonly worktreeId?: string | null;
    }>,
) {
    return (
        previous.activity === next.activity &&
        previous.expansionMode === next.expansionMode &&
        previous.isLatestStreamingTool === next.isLatestStreamingTool &&
        previous.onOpenSession === next.onOpenSession &&
        previous.projectId === next.projectId &&
        previous.trackedFiles === next.trackedFiles &&
        previous.worktreeId === next.worktreeId
    );
}
